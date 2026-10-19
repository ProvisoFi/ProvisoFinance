import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { Condition } from "@proviso/dsl";
import { hl, MIN, priceAbove, spec, T0 } from "../evaluator/testkit.ts";
import { framesFromRows, type SnapshotRow } from "./load.ts";
import { replay, type Frame } from "./replay.ts";
import { testId } from "./testId.ts";

/** One BTC frame per minute from T0 with the given marks (oracle = mark, deep volume). */
const series = (marks: number[], extra = {}): Frame[] =>
  marks.map((m, i) => ({ t: T0 + i * MIN, updates: [hl("BTC", T0 + i * MIN, m, extra)] }));
const seg = (n: number, v: number) => Array<number>(n).fill(v);

describe("end-to-end: synthetic 3-day series", () => {
  // Day 1 flat at 100; day 2 opens at 106 (fire) and hits 112 at noon (take);
  // day 3 dips to 100, jumps to 107 (second fire, cooldown passed) and falls to 101 (stop).
  const marks = [...seg(1440, 100), ...seg(720, 106), ...seg(720, 112), ...seg(120, 100), ...seg(300, 107), ...seg(1020, 101)];
  const frames = series(marks);
  const s = spec(priceAbove("BTC", 104), { fire: "repeat", cooldown: "1h", expires: "30d" });
  const r = replay({ spec: s, frames, slippageBps: 10 });

  const e1 = 106 * 1.001;
  const x1 = 112 * 0.999;
  const e2 = 107 * 1.001;
  const x2 = 101 * 0.999;
  const pnl1 = (1000 / e1) * (x1 - e1); // ≈ +54.4927
  const pnl2 = (1000 / e2) * (x2 - e2); // ≈ -57.9607

  test("fires, fills, exits", () => {
    expect(marks).toHaveLength(3 * 1440);
    expect(r.stampFlags).toEqual([]);
    expect(r.fires).toEqual([
      { at: T0 + 1440 * MIN, coin: "BTC", mark: 106 },
      { at: T0 + 3000 * MIN, coin: "BTC", mark: 107 },
    ]);
    expect(r.trades.map((t) => [t.exitReason, t.exitAt])).toEqual([
      ["take", T0 + 2160 * MIN],
      ["stop", T0 + 3300 * MIN],
    ]);
    expect(r.fills.map((f) => [f.side, f.px])).toEqual([
      ["buy", e1],
      ["sell", x1],
      ["buy", e2],
      ["sell", x2],
    ]);
    expect(r.trades[0].stopPx).toBeCloseTo(100.7, 9);
    expect(r.trades[0].takePx).toBeCloseTo(111.3, 9);
  });
  test("known P&L and drawdown", () => {
    expect(r.trades[0].pnlUsd).toBeCloseTo(pnl1, 9);
    expect(r.trades[1].pnlUsd).toBeCloseTo(pnl2, 9);
    expect(r.trades[0].pnlUsd).toBeCloseTo(54.4927, 3);
    expect(r.trades[1].pnlUsd).toBeCloseTo(-57.9607, 3);
    expect(r.totalPnlUsd).toBeCloseTo(pnl1 + pnl2, 9);
    expect(r.maxDrawdownUsd).toBeCloseTo(-pnl2, 9);
  });
  test("coverage of a price-only rule is full", () => {
    expect(r.coverage).toEqual([{ path: "$", input: "price", sources: ["hl:BTC"], supported: true, knownFrames: 4320, unknownFrames: 0 }]);
    expect(r.unsimulated).toEqual([]);
  });
});

describe("replay details", () => {
  test("trivially_true at stamp and no fire while it stays true", () => {
    const r = replay({ spec: spec(priceAbove("BTC", 100)), frames: series([105, 106, 107]), slippageBps: 0 });
    expect(r.stampFlags).toEqual(["trivially_true"]);
    expect(r.fires).toEqual([]);
  });

  test("frames before stampedAt only warm up history", () => {
    const when: Condition = { change: { coin: "BTC", op: ">", value: 5, window: "5m" } };
    const frames = series([100, 100, 100, 100, 100, 100, 100, 108]);
    const r = replay({ spec: spec(when), frames, stampedAt: T0 + 6 * MIN, slippageBps: 0 });
    expect(r.fires.map((f) => f.at)).toEqual([T0 + 7 * MIN]);
  });

  test("inputs the data can't support are unsupported and never guessed", () => {
    const when: Condition = {
      all: [priceAbove("BTC", 104), { post: { account: "elonmusk", contains: ["btc"] } }, { earnings_window: { coin: "NVDA", within: "2d", relative: "either" } }],
    };
    const r = replay({ spec: spec(when), frames: series([100, 106, 100, 106]), slippageBps: 0 });
    expect(r.fires).toEqual([]);
    expect(r.coverage.map((c) => [c.input, c.supported, c.knownFrames, c.unknownFrames])).toEqual([
      ["price", true, 4, 0],
      ["post", false, 0, 4],
      ["earnings_window", false, 0, 4],
    ]);
  });

  test("unsimulated actions are listed", () => {
    const s = spec(priceAbove("BTC", 104), {
      entry: {
        when: priceAbove("BTC", 104),
        then: [
          { venue: "hl", action: "open", coin: "BTC", side: "long", lev: 1, size: { usd: 100 } },
          { venue: "hl", action: "close", coin: "ETH" },
        ],
        legs: { atomic: false, onPartial: "unwind" },
      },
    });
    expect(replay({ spec: s, frames: series([100]), slippageBps: 0 }).unsimulated).toEqual([
      { path: "entry.then[1]", reason: "hl close is not simulated" },
    ]);
  });

  test("short side, loss capped at margin on liquidation", () => {
    const s = spec(priceAbove("BTC", 100), {
      exit: { stop: { pct: -50 }, take: { pct: 50 }, ref: "trigger_mark" },
      entry: {
        when: priceAbove("BTC", 100),
        then: [{ venue: "hl", action: "open", coin: "BTC", side: "short", lev: 10, size: { usd: 1000 } }],
        legs: { atomic: false, onPartial: "unwind" },
      },
    });
    const r = replay({ spec: s, frames: series([99, 101, 105, 113]), slippageBps: 0 });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]).toMatchObject({ side: "short", exitReason: "liquidation", exitAt: T0 + 3 * MIN });
    expect(r.trades[0].pnlUsd).toBeCloseTo(-100, 9);
  });

  test("short take profit", () => {
    const s = spec(priceAbove("BTC", 100), {
      entry: {
        when: priceAbove("BTC", 100),
        then: [{ venue: "hl", action: "open", coin: "BTC", side: "short", lev: 2, size: { usd: 1000 } }],
        legs: { atomic: false, onPartial: "unwind" },
      },
    });
    const r = replay({ spec: s, frames: series([99, 100.5, 96, 95.4]), slippageBps: 0 });
    expect(r.trades[0]).toMatchObject({ exitReason: "take", exitAt: T0 + 3 * MIN, exitPx: 95.4 });
    expect(r.trades[0].pnlUsd).toBeCloseTo((1000 / 100.5) * (100.5 - 95.4), 9);
  });

  test("funding accrual and fees (optional)", () => {
    const frames = series([98, ...seg(601, 100)]); // fire at minute 1, held 600 minutes, closed at end
    const s = spec(priceAbove("BTC", 99));
    const off = replay({ spec: s, frames, slippageBps: 0 });
    expect(off.trades[0]).toMatchObject({ exitReason: "end", fundingUsd: 0, pnlUsd: 0 });
    const on = replay({ spec: s, frames, slippageBps: 0, funding: true, feeBps: 5 });
    expect(on.trades[0].fundingUsd).toBeCloseTo(-1, 9); // 0.01%/h × 10 h × $1000, long pays
    expect(on.trades[0].feesUsd).toBeCloseTo(1, 9);
    expect(on.trades[0].pnlUsd).toBeCloseTo(-2, 9);
  });

  test("expiry is reported and stops new fires", () => {
    const r = replay({ spec: spec(priceAbove("BTC", 100), { expires: "2m" }), frames: series([90, 90, 105, 90, 105]), slippageBps: 0 });
    expect(r.expiredAt).toBe(T0 + 2 * MIN);
    expect(r.fires).toEqual([]);
  });

  test("rejects unordered frames", () => {
    expect(() => replay({ spec: spec(priceAbove("BTC", 1)), frames: [...series([1, 2])].reverse(), slippageBps: 0 })).toThrow();
    expect(() => replay({ spec: spec(priceAbove("BTC", 1)), frames: [], slippageBps: 0 })).toThrow();
  });
});

describe("property: replay is deterministic", () => {
  const row = (i: number, mark: number, oracleBp: number): SnapshotRow => ({
    coin: "BTC",
    ts: new Date(T0 + i * MIN),
    mark: String(mark),
    oracle: String(mark * (1 + oracleBp / 10_000)),
    funding: "0.0000125",
    oi: "1000",
    volume24h: "900000000",
  });
  test("same frames give the same result and the same testId", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 90, max: 120 }), fc.integer({ min: -150, max: 150 })), { minLength: 1, maxLength: 120 }),
        fc.integer({ min: 0, max: 50 }),
        fc.boolean(),
        (path, bps, funding) => {
          const rows = path.map(([m, o], i) => row(i, m, o));
          const a = framesFromRows({ snapshots: rows, candles: [], fearGreed: [] });
          const b = framesFromRows({ snapshots: rows.map((r) => ({ ...r })), candles: [], fearGreed: [] });
          const s = spec({ any: [priceAbove("BTC", 105), { after: { n: "3m", cond: { price: { coin: "BTC", op: "<", value: 95 } } } }] }, { fire: "repeat" });
          const r1 = replay({ spec: s, frames: a.frames, slippageBps: bps, funding });
          const r2 = replay({ spec: s, frames: b.frames, slippageBps: bps, funding });
          expect(r2).toEqual(r1);
          expect(testId(s, b.snapshotIds)).toBe(testId(s, a.snapshotIds));
        },
      ),
      { numRuns: 100 },
    );
  });
});
