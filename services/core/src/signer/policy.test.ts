import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { checkOrder, cloidThesisId, encodeCloid, type OrderIntent, type PolicyContext, type PolicyIdea } from "./policy";

const T = 42n;
const cloid = encodeCloid(T, 1, 0);

const idea = (over: Partial<PolicyIdea> = {}): PolicyIdea => ({
  thesisId: T,
  confirmed: true,
  state: "live",
  spec: {
    entry: {
      when: { price: { coin: "BTC", op: ">", value: 1 } },
      then: [{ venue: "hl", action: "open", coin: "BTC", side: "long", lev: 5, size: { usd: 1000 } }],
      legs: { atomic: true, onPartial: "unwind" },
    },
    limits: { maxUsd: 2000, maxLev: 8 },
  },
  ...over,
});
const ctx = (over: PolicyContext = {}): PolicyContext => ({
  idea: idea(),
  user: { maxUsd: 5000, maxLev: 10 },
  market: { coin: "BTC", asset: 0, mark: 100, maxLeverage: 40 },
  leverage: 3,
  positionSzi: 0,
  ...over,
});
const open = (over: Partial<OrderIntent> = {}): OrderIntent => ({
  coin: "BTC", asset: 0, isBuy: true, px: 101, sz: 5, reduceOnly: false, tif: "Ioc", cloid, ...over,
});
const exit = (over: Partial<OrderIntent> = {}): OrderIntent => open({ isBuy: false, px: 99, reduceOnly: true, ...over });
const reason = (o: OrderIntent, c: PolicyContext) => {
  const r = checkOrder(o, c);
  return r.ok ? "ok" : r.reason;
};

describe("cloid", () => {
  test("round trips the thesisId, including u64 max", () => {
    const max = (1n << 64n) - 1n;
    expect(cloidThesisId(encodeCloid(max, 0xffffffff, 7))).toBe(max);
    expect(encodeCloid(1n, 2, 3)).toBe("0x00000000000000010000000200000003");
    expect(cloidThesisId("0x1234")).toBeNull();
    expect(cloidThesisId(undefined)).toBeNull();
    expect(() => encodeCloid(1n << 64n, 0, 0)).toThrow();
    expect(() => encodeCloid(1n, -1, 0)).toThrow();
  });
});

describe("opens", () => {
  test("a matching open within every limit passes", () => {
    expect(checkOrder(open(), ctx())).toEqual({ ok: true });
  });

  test("rule 1: the idea must be known, confirmed and live", () => {
    expect(reason(open(), ctx({ idea: null }))).toBe("unknown_idea");
    expect(reason(open(), ctx({ idea: idea({ thesisId: 43n }) }))).toBe("unknown_idea");
    expect(reason(open(), ctx({ idea: idea({ confirmed: false }) }))).toBe("idea_unconfirmed");
    for (const state of ["draft", "closing", "closed", "expired"])
      expect(reason(open(), ctx({ idea: idea({ state }) }))).toBe("idea_not_live");
    expect(reason(open({ cloid: "0xdead" }), ctx())).toBe("bad_cloid");
  });

  test("rule 2: coin and side must match a then action", () => {
    expect(reason(open({ coin: "ETH" }), ctx({ market: { coin: "ETH", asset: 0, mark: 100, maxLeverage: 40 } }))).toBe("no_matching_action");
    expect(reason(open({ isBuy: false, px: 99 }), ctx())).toBe("no_matching_action");
  });

  test("rule 2: notional is capped by action size, idea limit and user limit", () => {
    expect(reason(open({ sz: 9.91 }), ctx())).toBe("over_action_size"); // 1000.91 > 1000
    const big = idea();
    big.spec.limits.maxUsd = 500;
    expect(reason(open(), ctx({ idea: big }))).toBe("over_idea_limit"); // 505 > 500
    expect(reason(open(), ctx({ user: { maxUsd: 400, maxLev: 10 } }))).toBe("over_user_limit");
  });

  test("rule 2: leverage ≤ min(action, idea, user, market, 10)", () => {
    expect(reason(open(), ctx({ leverage: 5 }))).toBe("ok");
    expect(reason(open(), ctx({ leverage: 6 }))).toBe("over_leverage"); // action lev 5
    const loose = idea();
    const a = loose.spec.entry.then[0]!;
    if (a.venue === "hl" && a.action === "open") a.lev = 50;
    loose.spec.limits.maxLev = 50;
    const wide = { user: { maxUsd: 5000, maxLev: 50 }, market: { coin: "BTC", asset: 0, mark: 100, maxLeverage: 50 } };
    expect(reason(open(), ctx({ idea: loose, ...wide, leverage: 10 }))).toBe("ok");
    expect(reason(open(), ctx({ idea: loose, ...wide, leverage: 11 }))).toBe("over_leverage"); // hard cap 10
    loose.spec.limits.maxLev = 4;
    expect(reason(open(), ctx({ idea: loose, ...wide, leverage: 5 }))).toBe("over_leverage"); // idea
    loose.spec.limits.maxLev = 50;
    expect(reason(open(), ctx({ idea: loose, ...wide, user: { maxUsd: 5000, maxLev: 2 }, leverage: 3 }))).toBe("over_leverage");
    expect(reason(open(), ctx({ idea: loose, ...wide, market: { coin: "BTC", asset: 0, mark: 100, maxLeverage: 3 }, leverage: 4 }))).toBe("over_leverage");
  });

  test("rule 4: limit px within 2% of mark", () => {
    expect(reason(open({ px: 102, sz: 1 }), ctx())).toBe("ok");
    expect(reason(open({ px: 102.1, sz: 1 }), ctx())).toBe("px_off_mark");
    expect(reason(open({ px: 97.9, sz: 1 }), ctx())).toBe("px_off_mark");
  });

  test("rule 5: triggers on opens and anything malformed are refused", () => {
    expect(reason(open({ trigger: { tpsl: "sl", triggerPx: 90, isMarket: true } }), ctx())).toBe("trigger_open_refused");
    expect(reason(open({ px: NaN }), ctx())).toBe("malformed_order");
    expect(reason(open({ sz: 0 }), ctx())).toBe("malformed_order");
    expect(reason(open({ asset: 1.5 }), ctx())).toBe("malformed_order");
    expect(reason(open({ tif: "Fok" as never }), ctx())).toBe("malformed_order");
    expect(reason(null as never, ctx())).toBe("malformed_order");
  });

  test("fails closed on missing or inconsistent context", () => {
    expect(reason(open(), ctx({ market: null }))).toBe("missing_market");
    expect(reason(open(), ctx({ market: { coin: "BTC", asset: 3, mark: 100, maxLeverage: 40 } }))).toBe("missing_market");
    expect(reason(open(), ctx({ market: { coin: "ETH", asset: 0, mark: 100, maxLeverage: 40 } }))).toBe("missing_market");
    expect(reason(open(), ctx({ user: null }))).toBe("missing_context");
    expect(reason(open(), ctx({ leverage: null }))).toBe("missing_context");
    expect(reason(open(), {} as PolicyContext)).toBe("unknown_idea");
    expect(reason(open(), undefined as never)).toBe("unknown_idea");
  });
});

describe("exits", () => {
  const long = ctx({ positionSzi: 4 });
  const short = ctx({ positionSzi: -4 });

  test("rule 3: reduce-only closes of the live or closing idea pass", () => {
    expect(reason(exit({ sz: 4 }), long)).toBe("ok");
    expect(reason(exit({ sz: 2 }), ctx({ positionSzi: 4, idea: idea({ state: "closing" }) }))).toBe("ok");
    expect(reason(exit({ isBuy: true, px: 101, sz: 4 }), short)).toBe("ok");
    expect(reason(exit(), ctx({ positionSzi: 4, idea: idea({ state: "closed" }) }))).toBe("idea_not_live");
  });

  test("rule 3: exits cannot exceed or flip the position", () => {
    expect(reason(exit({ sz: 4.01 }), long)).toBe("exceeds_position");
    expect(reason(exit({ isBuy: true, px: 101, sz: 1 }), long)).toBe("wrong_side");
    expect(reason(exit({ sz: 1 }), short)).toBe("wrong_side");
    expect(reason(exit({ sz: 1 }), ctx({ positionSzi: 0 }))).toBe("no_position");
    expect(reason(exit({ sz: 1 }), ctx({ positionSzi: null }))).toBe("missing_context");
  });

  test("exits must be on a coin the idea trades", () => {
    const eth = ctx({ positionSzi: 4, market: { coin: "ETH", asset: 1, mark: 100, maxLeverage: 25 } });
    expect(reason(exit({ coin: "ETH", asset: 1, sz: 1 }), eth)).toBe("coin_not_in_idea");
  });

  test("rule 4: trigger price must be on the protective side", () => {
    const sl = (triggerPx: number) => ({ tpsl: "sl" as const, triggerPx, isMarket: true });
    const tp = (triggerPx: number) => ({ tpsl: "tp" as const, triggerPx, isMarket: true });
    expect(reason(exit({ sz: 4, px: 80, trigger: sl(90) }), long)).toBe("ok");
    expect(reason(exit({ sz: 4, px: 80, trigger: sl(110) }), long)).toBe("trigger_not_protective");
    expect(reason(exit({ sz: 4, trigger: tp(120) }), long)).toBe("ok");
    expect(reason(exit({ sz: 4, trigger: tp(95) }), long)).toBe("trigger_not_protective");
    expect(reason(exit({ isBuy: true, sz: 4, px: 120, trigger: sl(110) }), short)).toBe("ok");
    expect(reason(exit({ isBuy: true, sz: 4, px: 120, trigger: sl(90) }), short)).toBe("trigger_not_protective");
    expect(reason(exit({ isBuy: true, sz: 4, trigger: tp(80) }), short)).toBe("ok");
    expect(reason(exit({ isBuy: true, sz: 4, trigger: tp(105) }), short)).toBe("trigger_not_protective");
    expect(reason(exit({ sz: 4, trigger: sl(100) }), long)).toBe("trigger_not_protective"); // at mark
  });

  test("rule 4: non-trigger exits stay within 2% of mark", () => {
    expect(reason(exit({ sz: 1, px: 97.5 }), long)).toBe("px_off_mark");
  });
});

describe("fuzz", () => {
  const num = fc.oneof(fc.double({ min: -1e6, max: 1e6 }), fc.constantFrom(NaN, Infinity, 0, 100, 1));
  const intent = fc.record({
    coin: fc.constantFrom("BTC", "ETH", "SOL"),
    asset: fc.constantFrom(0, 1, 2, -1, 0.5),
    isBuy: fc.boolean(),
    px: num,
    sz: num,
    reduceOnly: fc.boolean(),
    tif: fc.constantFrom("Ioc", "Gtc", "Alo"),
    trigger: fc.option(fc.record({ tpsl: fc.constantFrom("sl", "tp"), triggerPx: num, isMarket: fc.boolean() }), { nil: undefined }),
    cloid: fc.oneof(
      fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }).map((t) => encodeCloid(t, 0, 0)),
      fc.constant(cloid),
      fc.string(),
    ),
  }) as fc.Arbitrary<OrderIntent>;
  const market = fc.record({
    coin: fc.constantFrom("BTC", "ETH", "SOL"),
    asset: fc.constantFrom(0, 1, 2),
    mark: fc.double({ min: 0.01, max: 1e5, noNaN: true }),
    maxLeverage: fc.integer({ min: 1, max: 50 }),
  });
  const restCtx = {
    user: fc.option(fc.record({ maxUsd: num, maxLev: num }), { nil: null }),
    market: fc.option(market, { nil: null }),
    leverage: fc.option(num, { nil: null }),
    positionSzi: fc.option(num, { nil: null }),
  };

  test("no random order passes without a confirmed live (or closing) idea for its cloid", () => {
    const deadIdea = fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.constantFrom("draft", "closed", "expired", "cancelled", "LIVE", "").map((state) => idea({ state })),
      fc.constantFrom("live", "closing").map((state) => idea({ state, confirmed: false })),
      fc.bigInt({ min: 0n, max: 1n << 63n }).filter((t) => t !== T).map((thesisId) => idea({ thesisId })),
    );
    fc.assert(
      fc.property(intent, deadIdea, fc.record(restCtx), (o, i, rest) => {
        expect(checkOrder(o, { ...rest, idea: i }).ok).toBe(false);
      }),
      { numRuns: 3000 },
    );
  });

  test("a closing idea never authorizes an open", () => {
    fc.assert(
      fc.property(intent, fc.record(restCtx), (o, rest) => {
        const r = checkOrder({ ...o, reduceOnly: false }, { ...rest, idea: idea({ state: "closing" }) });
        expect(r.ok).toBe(false);
      }),
      { numRuns: 2000 },
    );
  });

  test("reduce-only exits that pass never increase exposure or flip the position", () => {
    const btc = fc.record({
      coin: fc.constant("BTC"), asset: fc.constant(0),
      mark: fc.double({ min: 1, max: 1e5, noNaN: true }), maxLeverage: fc.constant(40),
    });
    let passed = 0;
    fc.assert(
      fc.property(
        intent.map((o) => ({ ...o, coin: "BTC", asset: 0, cloid, reduceOnly: true })),
        btc,
        fc.double({ min: -100, max: 100, noNaN: true }),
        fc.double({ min: 0.5, max: 1.5, noNaN: true }),
        (o, m, szi, pxMul) => {
          const order = { ...o, px: m.mark * pxMul, sz: Math.abs(o.sz) % 200 };
          const r = checkOrder(order, ctx({ market: m, positionSzi: szi, idea: idea({ state: "closing" }) }));
          if (!r.ok) return;
          passed++;
          const after = szi + (order.isBuy ? order.sz : -order.sz);
          expect(Math.abs(after)).toBeLessThanOrEqual(Math.abs(szi));
          expect(Math.sign(after) === 0 || Math.sign(after) === Math.sign(szi)).toBe(true);
        },
      ),
      { numRuns: 5000 },
    );
    expect(passed).toBeGreaterThan(0); // the property is not vacuous
  });
});
