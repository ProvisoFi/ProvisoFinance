import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { Exit } from "@proviso/dsl";
import { decodeCloid } from "@proviso/hl";
import { checkOrder, cloidThesisId, type Hex, type PolicyContext } from "../signer/policy";
import { followerWeights, holdWeight, linkFlags, MIN_HOLD_MS } from "./links";
import {
  backstopMult, backstopStops, BACKSTOP_MULT_RANGE, detectOutsideClose, exitHit, exitLevels, planEntryWaves, planExitWaves,
  type Book, type EntryInput, type Fire, type Follow, type Rounder,
} from "./planner";

const round: Rounder = { px: (p) => Math.round(p * 100) / 100, sz: (s) => Math.floor(s * 1e4) / 1e4 };
const acct = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Hex;
const CALLER = { id: "caller", account: acct(1) };
const fire = (over: Partial<Fire> = {}): Fire => ({
  thesisId: 9n, fireSeq: 1, leg: 0, nonce: 0, coin: "BTC", asset: 0, side: "long",
  notionalUsd: 1000, lev: 5, sealed: false, ...over,
});
const follow = (i: number, over: Partial<Follow> = {}): Follow => ({
  followerId: `f${i}`, account: acct(100 + i), callerId: "caller", active: true,
  size: { kind: "fixed", usd: 200 }, ...over,
});
const deepBook = (levelUsd = 100_000): Book => ({
  asks: Array.from({ length: 10 }, (_, i) => ({ px: 100 + i, sz: levelUsd / (100 + i) })),
  bids: Array.from({ length: 10 }, (_, i) => ({ px: 99 - i, sz: levelUsd / (99 - i) })),
});
const input = (over: Partial<EntryInput> = {}): EntryInput => ({
  fire: fire(), caller: CALLER, follows: [follow(1)], book: deepBook(), marks: { BTC: 100 },
  limits: { f1: { maxUsd: 5000, maxLev: 10 }, f2: { maxUsd: 5000, maxLev: 10 }, f3: { maxUsd: 5000, maxLev: 10 } },
  round, ...over,
});
const ids = (orders: { userId: string }[]) => orders.map((o) => o.userId);
const EXIT: Exit = { stop: { pct: -5 }, take: { pct: 10 }, ref: "trigger_mark" };

describe("planEntryWaves", () => {
  test("eligibility: active follows of this caller and thesis only", () => {
    const plan = planEntryWaves(input({
      follows: [
        follow(1),
        follow(2, { active: false }),
        follow(3, { callerId: "someone" }),
        follow(4, { thesisId: 8n }),
        follow(5, { thesisId: 9n }),
        follow(6, { thesisId: null }),
      ],
      limits: Object.fromEntries([1, 4, 5, 6].map((i) => [`f${i}`, { maxUsd: 5000, maxLev: 10 }])),
    }));
    expect(ids(plan.waves[0].orders)).toEqual(["f1", "f5", "f6"]);
  });

  test("followers without limits are skipped (fail closed)", () => {
    const plan = planEntryWaves(input({ follows: [follow(9)] }));
    expect(plan.waves[0].orders).toEqual([]);
    expect(plan.skipped).toEqual([{ followerId: "f9", reason: "no_limits" }]);
  });

  test("sealed idea: allow-list covering coin, side, size and leverage auto-copies; others confirm", () => {
    const allow = (over = {}) => [{ coin: "BTC", side: "long" as const, maxUsd: 500, maxLev: 5, ...over }];
    const plan = planEntryWaves(input({
      fire: fire({ sealed: true }),
      follows: [
        follow(1, { allow: allow() }),
        follow(2, { allow: allow({ side: "both" }) }),
        follow(3),
        follow(4, { allow: allow({ side: "short" }) }),
        follow(5, { allow: allow({ coin: "ETH" }) }),
        follow(6, { allow: allow({ maxUsd: 100 }) }),
        follow(7, { allow: allow({ maxLev: 3 }) }),
      ],
      limits: Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((i) => [`f${i}`, { maxUsd: 5000, maxLev: 10 }])),
    }));
    expect(ids(plan.waves[0].orders)).toEqual(["f1", "f2"]);
    expect(plan.confirmRequired.map((c) => c.followerId)).toEqual(["f3", "f4", "f5", "f6", "f7"]);
    expect(plan.confirmRequired[0]).toEqual({ followerId: "f3", account: acct(103), notionalUsd: 200, lev: 5 });
  });

  test("follower leverage capped by their limit counts for allow-list coverage", () => {
    const plan = planEntryWaves(input({
      fire: fire({ sealed: true }),
      follows: [follow(1, { allow: [{ coin: "BTC", side: "long", maxUsd: 500, maxLev: 3 }] })],
      limits: { f1: { maxUsd: 5000, maxLev: 3 } },
    }));
    expect(plan.waves[0].orders[0]!.lev).toBe(3);
  });

  test("unsealed idea auto-copies without an allow-list", () => {
    expect(ids(planEntryWaves(input()).waves[0].orders)).toEqual(["f1"]);
  });

  test("size rules: fixed USD, ratio of caller notional, capped by limits", () => {
    const plan = planEntryWaves(input({
      follows: [
        follow(1, { size: { kind: "fixed", usd: 300 } }),
        follow(2, { size: { kind: "ratio", ratio: 0.5 } }),
        follow(3, { size: { kind: "ratio", ratio: 3 } }),
      ],
      limits: { f1: { maxUsd: 5000, maxLev: 10 }, f2: { maxUsd: 5000, maxLev: 2 }, f3: { maxUsd: 700, maxLev: 10 } },
    }));
    const [a, b, c] = plan.waves[0].orders;
    expect(a!.notionalUsd).toBeCloseTo(300, 0);
    expect(b!.notionalUsd).toBeCloseTo(500, 0);
    expect(b!.lev).toBe(2);
    expect(c!.notionalUsd).toBeCloseTo(700, 0);
    for (const o of plan.waves[0].orders) expect(o.notionalUsd).toBeLessThanOrEqual(o.userId === "f3" ? 700 : 500);
  });

  test("total follower notional is pro-rata scaled to 20% of top-10 depth on the taking side", () => {
    // asks: 10 levels × $1,000 = $10,000 (an 11th level is ignored) → cap $2,000
    const book = deepBook(1000);
    book.asks.push({ px: 111, sz: 1e6 });
    const plan = planEntryWaves(input({
      book,
      follows: [follow(1, { size: { kind: "fixed", usd: 3000 } }), follow(2, { size: { kind: "fixed", usd: 1000 } })],
    }));
    expect(plan.depthCapUsd).toBeCloseTo(2000, 6);
    expect(plan.scale).toBeCloseTo(0.5, 9);
    const [a, b] = plan.waves[0].orders;
    expect(a!.notionalUsd).toBeCloseTo(1500, 0);
    expect(b!.notionalUsd).toBeCloseTo(500, 0);
    expect(plan.followerNotionalUsd).toBeLessThanOrEqual(2000);
    // caller is not depth-scaled
    expect(plan.waves[1].orders[0]!.notionalUsd).toBeCloseTo(1000, 0);
  });

  test("sells take the bid side", () => {
    const book = deepBook(100_000);
    book.bids = book.bids.map((l) => ({ px: l.px, sz: 100 / l.px })); // $1,000 of bids → cap $200
    const plan = planEntryWaves(input({ fire: fire({ side: "short" }), book, follows: [follow(1, { size: { kind: "fixed", usd: 400 } })] }));
    expect(plan.scale).toBeCloseTo(0.5, 9);
    expect(plan.waves[0].orders[0]!.intent.isBuy).toBe(false);
  });

  test("confirm-required followers count toward the depth budget", () => {
    const plan = planEntryWaves(input({
      fire: fire({ sealed: true }), book: deepBook(1000),
      follows: [follow(1, { size: { kind: "fixed", usd: 4000 } })],
    }));
    expect(plan.confirmRequired[0]!.notionalUsd).toBeCloseTo(2000, 6);
  });

  test("orders scaled below the $10 minimum are skipped", () => {
    const plan = planEntryWaves(input({ follows: [follow(1, { size: { kind: "fixed", usd: 5 } })] }));
    expect(plan.waves[0].orders).toEqual([]);
    expect(plan.skipped).toEqual([{ followerId: "f1", reason: "below_min" }]);
  });

  test("IOC price is mark +1% for buys and −1% for sells, through the rounder", () => {
    const buy = planEntryWaves(input({ marks: { BTC: 123.456 } })).waves[0].orders[0]!.intent;
    expect(buy).toMatchObject({ px: 124.69, tif: "Ioc", reduceOnly: false, isBuy: true, asset: 0, coin: "BTC" });
    expect(buy.sz).toBe(Math.floor((200 / 124.69) * 1e4) / 1e4);
    const sell = planEntryWaves(input({ marks: { BTC: 123.456 }, fire: fire({ side: "short" }) })).waves[0].orders[0]!.intent;
    expect(sell.px).toBe(122.22);
    expect(() => planEntryWaves(input({ marks: {} }))).toThrow();
  });

  test("wave 1 is every follower; wave 2 is the caller after wave-1 acks; ratio reported", () => {
    const plan = planEntryWaves(input({ follows: [follow(1), follow(2, { size: { kind: "fixed", usd: 300 } })] }));
    const [w1, w2] = plan.waves;
    expect(w1).toMatchObject({ wave: 1, after: "none", sentAt: null, ackedAt: null });
    expect(w2).toMatchObject({ wave: 2, after: "wave1_acks", sentAt: null, ackedAt: null });
    expect(ids(w1.orders)).toEqual(["f1", "f2"]);
    expect(new Set(w1.orders.map((o) => o.account)).size).toBe(2); // each on its own account
    expect(w2.orders.map((o) => o.account)).toEqual([CALLER.account]);
    expect(w2.orders[0]!.lev).toBe(5);
    expect(cloidThesisId(w1.orders[0]!.intent.cloid)).toBe(9n);
    const all = [...w1.orders, ...w2.orders].map((o) => decodeCloid(o.intent.cloid));
    expect(all.map((c) => c.nonce)).toEqual([1, 2, 0]); // followers nonce+1+i, caller nonce
    expect(all.every((c) => c.fireSeq === 1 && c.leg === 0)).toBe(true);
    expect(plan.callerToFollowerRatio).toBeCloseTo(plan.callerNotionalUsd / plan.followerNotionalUsd, 9);
    expect(plan.callerToFollowerRatio).toBeCloseTo(2, 1);
    expect(planEntryWaves(input({ follows: [] })).callerToFollowerRatio).toBeNull();
  });

  test("planned orders pass the signer policy", () => {
    const plan = planEntryWaves(input());
    const ctx: PolicyContext = {
      idea: {
        thesisId: 9n, confirmed: true, state: "live",
        spec: {
          entry: {
            when: { price: { coin: "BTC", op: ">", value: 1 } },
            then: [{ venue: "hl", action: "open", coin: "BTC", side: "long", lev: 5, size: { usd: 1000 } }],
            legs: { atomic: true, onPartial: "unwind" },
          },
          limits: { maxUsd: 1000, maxLev: 5 },
        },
      },
      user: { maxUsd: 1000, maxLev: 10 },
      market: { coin: "BTC", asset: 0, mark: 100, maxLeverage: 40 },
      leverage: 5,
    };
    for (const w of plan.waves) for (const o of w.orders) expect(checkOrder(o.intent, ctx)).toEqual({ ok: true });
  });

  test("fuzz: follower total never exceeds 20% of top-10 taking-side depth", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ px: fc.double({ min: 1, max: 200, noNaN: true }), sz: fc.double({ min: 0, max: 100, noNaN: true }) }), { maxLength: 15 }),
        fc.array(fc.double({ min: 1, max: 50_000, noNaN: true }), { maxLength: 8 }),
        fc.boolean(),
        (levels, sizes, sealed) => {
          const follows = sizes.map((usd, i) => follow(i, { size: { kind: "fixed", usd } }));
          const limits = Object.fromEntries(sizes.map((_, i) => [`f${i}`, { maxUsd: 1e9, maxLev: 10 }]));
          const plan = planEntryWaves(input({ fire: fire({ sealed }), follows, limits, book: { asks: levels, bids: [] } }));
          const depth = levels.slice(0, 10).reduce((s, l) => s + l.px * l.sz, 0);
          const total = plan.followerNotionalUsd + plan.confirmRequired.reduce((s, c) => s + c.notionalUsd, 0);
          expect(total).toBeLessThanOrEqual(0.2 * depth + 1e-6);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("exits", () => {
  test("stop and target from the reference price, long and short", () => {
    const l = exitLevels(EXIT, 200, "long");
    expect(l.stopPx).toBeCloseTo(190, 9);
    expect(l.takePx).toBeCloseTo(220, 9);
    const s = exitLevels(EXIT, 200, "short");
    expect(s.stopPx).toBeCloseTo(210, 9);
    expect(s.takePx).toBeCloseTo(180, 9);
    expect(exitLevels({ ...EXIT, take: { pct: 150 } }, 200, "short").takePx).toBeNull();
    expect(exitHit(l, "long", 189)).toBe("stop");
    expect(exitHit(l, "long", 221)).toBe("take");
    expect(exitHit(l, "long", 200)).toBeNull();
    expect(exitHit(s, "short", 211)).toBe("stop");
    expect(exitHit(s, "short", 179)).toBe("take");
  });

  test("followers' reduce-only closes go first, then the caller, at shared levels", () => {
    const plan = planExitWaves({
      coin: "BTC", asset: 0, side: "long", exit: EXIT, referencePx: 200, mark: 190,
      caller: { userId: "caller", account: acct(1), szi: 5 },
      followers: [
        { userId: "f1", account: acct(101), szi: 1.5 },
        { userId: "f2", account: acct(102), szi: 0 },
        { userId: "f3", account: acct(103), szi: -1 },
      ],
      round, cloid: { thesisId: 9n, fireSeq: 2, leg: 0, nonce: 1 },
    });
    expect(plan.stopPx).toBeCloseTo(190, 9);
    expect(plan.waves[0]).toMatchObject({ wave: 1, after: "none" });
    expect(plan.waves[1]).toMatchObject({ wave: 2, after: "wave1_acks" });
    expect(plan.waves[0].orders.map((o) => o.intent)).toEqual([
      expect.objectContaining({ isBuy: false, sz: 1.5, reduceOnly: true, tif: "Ioc", px: 188.1 }),
    ]);
    expect(plan.waves[1].orders.map((o) => [o.userId, o.intent.sz])).toEqual([["caller", 5]]);
  });

  test("short exits buy back at mark +1%", () => {
    const plan = planExitWaves({
      coin: "BTC", asset: 0, side: "short", exit: EXIT, referencePx: 200, mark: 210,
      caller: { userId: "caller", account: acct(1), szi: -2 }, followers: [{ userId: "f1", account: acct(101), szi: -1 }],
      round, cloid: { thesisId: 9n, fireSeq: 2, leg: 0, nonce: 1 },
    });
    expect(plan.waves[0].orders[0]!.intent).toMatchObject({ isBuy: true, px: 212.1, sz: 1, reduceOnly: true });
  });

  test("backstop multiple: crypto-random within the range, never a fixed multiple", () => {
    const draws = Array.from({ length: 2000 }, backstopMult);
    const [lo, hi] = BACKSTOP_MULT_RANGE;
    expect(lo).toBeGreaterThan(1); // always beyond the sealed stop
    for (const m of draws) expect(m >= lo && m <= hi).toBe(true);
    expect(new Set(draws).size).toBeGreaterThan(1990);
    expect(Math.min(...draws)).toBeLessThan(lo + 0.05);
    expect(Math.max(...draws)).toBeGreaterThan(hi - 0.05);
    const x = { coin: "BTC", asset: 0, side: "long" as const, exit: EXIT, referencePx: 100, positions: [], round, cloid: { thesisId: 1n, fireSeq: 1, leg: 0, nonce: 0 } };
    expect(() => backstopStops({ ...x, mult: 2.7 })).toThrow("outside");
    expect(() => backstopStops({ ...x, mult: 1 })).toThrow("outside");
    expect(() => backstopStops({ ...x, mult: NaN })).toThrow("outside");
  });

  test("backstop is a native reduce-only stop at reference ± mult × the stop distance on every account", () => {
    const positions = [{ userId: "caller", account: acct(1), szi: 5 }, { userId: "f1", account: acct(101), szi: 2 }];
    const cloid = { thesisId: 9n, fireSeq: 1, leg: 0, nonce: 9 };
    const mult = 2;
    const long = backstopStops({ coin: "BTC", asset: 0, side: "long", exit: EXIT, referencePx: 100, positions, round, cloid, mult });
    expect(long.triggerPx).toBe(90);
    expect(long.orders).toHaveLength(2);
    for (const o of long.orders) {
      expect(o.intent).toMatchObject({ isBuy: false, reduceOnly: true, trigger: { tpsl: "sl", triggerPx: 90, isMarket: true } });
      const ctx: PolicyContext = {
        idea: { thesisId: 9n, confirmed: true, state: "live", spec: {
          entry: { when: { price: { coin: "BTC", op: ">", value: 1 } }, then: [{ venue: "hl", action: "open", coin: "BTC", side: "long", lev: 5, size: { usd: 1000 } }], legs: { atomic: true, onPartial: "unwind" } },
          limits: { maxUsd: 1000, maxLev: 5 } } },
        market: { coin: "BTC", asset: 0, mark: 100, maxLeverage: 40 },
        positionSzi: positions.find((p) => p.account === o.account)!.szi,
      };
      expect(checkOrder(o.intent, ctx)).toEqual({ ok: true });
    }
    const short = backstopStops({ coin: "BTC", asset: 0, side: "short", exit: EXIT, referencePx: 100,
      positions: [{ userId: "f1", account: acct(101), szi: -3 }], round, cloid, mult });
    expect(short.triggerPx).toBe(110);
    expect(short.orders[0]!.intent).toMatchObject({ isBuy: true, sz: 3, reduceOnly: true });
    expect(backstopStops({ coin: "BTC", asset: 0, side: "long", exit: { ...EXIT, stop: { pct: -60 } }, referencePx: 100, positions, round, cloid, mult }))
      .toEqual({ triggerPx: null, orders: [] });
  });
});

describe("detectOutsideClose", () => {
  const copies = [
    { userId: "f1", account: acct(101), callerId: "caller", thesisId: 9n, coin: "BTC", szi: 2 },
    { userId: "f2", account: acct(102), callerId: "caller", thesisId: 9n, coin: "BTC", szi: 0.5 },
    { userId: "f3", account: acct(103), callerId: "other", thesisId: 5n, coin: "BTC", szi: 1 },
    { userId: "f4", account: acct(104), callerId: "caller", thesisId: 9n, coin: "ETH", szi: 1 },
  ];
  const pricing = { mark: 100, round, fireSeq: 3, leg: 0, nonce: 0 };
  const upd = (over = {}) => ({ callerId: "caller", coin: "BTC", asset: 0, prevSzi: 4, szi: 0, signedByProviso: false, copyPromise: false, ...over });

  test("a full close outside Proviso closes every copied position on that coin", () => {
    const r = detectOutsideClose(upd(), copies, pricing);
    expect(r.closedOutside).toBe(true);
    expect(r.fraction).toBe(1);
    expect(r.breaches).toEqual([]);
    expect(r.closes.map((o) => [o.userId, o.intent.sz, o.intent.isBuy, o.intent.reduceOnly, o.intent.px])).toEqual([
      ["f1", 2, false, true, 99],
      ["f2", 0.5, false, true, 99],
    ]);
  });

  test("a partial outside reduce closes the same share", () => {
    const r = detectOutsideClose(upd({ szi: 1 }), copies, pricing);
    expect(r.fraction).toBeCloseTo(0.75, 9);
    expect(r.closes.map((o) => o.intent.sz)).toEqual([1.5, 0.375]);
  });

  test("Proviso-signed changes and same-direction adds do nothing", () => {
    expect(detectOutsideClose(upd({ signedByProviso: true }), copies, pricing).closes).toEqual([]);
    const add = detectOutsideClose(upd({ szi: 6, copyPromise: true }), copies, pricing);
    expect(add).toEqual({ closedOutside: false, fraction: 0, breaches: [], closes: [] });
  });

  test("Copy Promise breaches: outside close and opposite trade", () => {
    expect(detectOutsideClose(upd({ copyPromise: true }), copies, pricing).breaches).toEqual(["outside_close"]);
    const flip = detectOutsideClose(upd({ szi: -3, copyPromise: true }), copies, pricing);
    expect(flip.breaches).toEqual(["outside_close", "opposite_trade"]);
    expect(flip.fraction).toBe(1);
    const fresh = detectOutsideClose(upd({ prevSzi: 0, szi: -1, copyPromise: true }), copies, pricing);
    expect(fresh.breaches).toEqual(["opposite_trade"]);
    expect(fresh.closedOutside).toBe(false);
    expect(fresh.closes).toHaveLength(2);
    expect(detectOutsideClose(upd({ prevSzi: 0, szi: -1 }), copies, pricing).breaches).toEqual([]);
  });
});

describe("link heuristics and records", () => {
  const C = "0xCaller", F = "0xfollower", G = "0xclean";
  const pairs = [{ caller: C, follower: F }, { caller: C, follower: G }];

  test("direct transfers and shared funders are flagged; ignored funders are not", () => {
    const flags = linkFlags(
      [
        { from: F, to: C, usd: 50, time: 1 },
        { from: "0xfunder", to: "0xcaller", usd: 1, time: 1 },
        { from: "0xFUNDER", to: F, usd: 1, time: 1 },
        { from: "0xbridge", to: C, usd: 1, time: 1 },
        { from: "0xbridge", to: G, usd: 1, time: 1 },
      ],
      [],
      pairs,
      { ignoreFunders: ["0xBridge"] },
    );
    expect(flags).toEqual([
      { a: "0xcaller", b: "0xfollower", reason: "direct_transfer", score: 1 },
      { a: "0xcaller", b: "0xfollower", reason: "shared_funder", score: 0.6 },
    ]);
  });

  test("timing: follower's own orders within N seconds before the caller's", () => {
    const fills = [
      { account: C, coin: "BTC", isBuy: true, time: 100_000 },
      { account: C, coin: "BTC", isBuy: true, time: 500_000 },
      { account: F, coin: "BTC", isBuy: true, time: 95_000 },
      { account: F, coin: "BTC", isBuy: true, time: 490_000 },
      { account: G, coin: "BTC", isBuy: true, time: 99_000, viaProviso: true }, // a wave-1 copy
      { account: G, coin: "BTC", isBuy: true, time: 101_000 }, // after the caller
      { account: G, coin: "BTC", isBuy: false, time: 499_000 }, // other side
      { account: G, coin: "BTC", isBuy: true, time: 300_000 }, // outside the window
    ];
    const flags = linkFlags([], fills, pairs, { windowSec: 30 });
    expect(flags).toEqual([{ a: "0xcaller", b: "0xfollower", reason: "timing", score: 0.5 }]);
  });

  test("hold weight is money × days; holds under 30 minutes count zero", () => {
    expect(holdWeight(1000, 0, 2 * 86_400_000)).toBeCloseTo(2000, 9);
    expect(holdWeight(1000, 0, MIN_HOLD_MS - 1)).toBe(0);
    expect(holdWeight(1000, 0, MIN_HOLD_MS)).toBeCloseTo(1000 / 48, 9);
  });

  test("flagged followers are excluded from caller shares", () => {
    const day = 86_400_000;
    const holds = [
      { follower: F, notionalUsd: 1000, openedAt: 0, closedAt: day },
      { follower: G, notionalUsd: 500, openedAt: 0, closedAt: day },
      { follower: G, notionalUsd: 500, openedAt: 0, closedAt: 2 * day },
      { follower: "0xquick", notionalUsd: 1e6, openedAt: 0, closedAt: 60_000 },
    ];
    const flags = linkFlags([{ from: C, to: F, usd: 1, time: 0 }], [], pairs);
    const w = followerWeights(C, holds, flags);
    expect(w.has("0xfollower")).toBe(false);
    expect(w.get("0xclean")).toBeCloseTo(1500, 9);
    expect(w.get("0xquick")).toBe(0);
    // weak flags below the exclusion score keep the follower in
    expect(followerWeights(C, holds, [{ a: "0xcaller", b: "0xfollower", reason: "timing", score: 0.25 }]).get("0xfollower")).toBeCloseTo(1000, 9);
  });
});
