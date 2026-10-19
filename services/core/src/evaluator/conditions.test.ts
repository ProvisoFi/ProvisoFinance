import { describe, expect, test } from "bun:test";
import type { Condition } from "@proviso/dsl";
import { agrees, and3, config, evalCondition, not3, or3, UNKNOWN, type Truth } from "./conditions.ts";
import { MemoryMarketView } from "./state.ts";
import { HOUR, hl, MIN, priceAbove, rhc, T0 } from "./testkit.ts";

const ev = (c: Condition, v: MemoryMarketView, now = T0, cfg = config()) => evalCondition(c, v, now, new Map(), cfg);
const view = (...us: Parameters<MemoryMarketView["apply"]>[0][]) => {
  const v = new MemoryMarketView();
  for (const u of us) v.apply(u);
  return v;
};
const TV: Truth[] = [true, false, UNKNOWN];

describe("three-valued logic", () => {
  test("all / any / not truth tables", () => {
    for (const a of TV)
      for (const b of TV) {
        const all = and3([a, b]);
        const any = or3([a, b]);
        expect(all).toBe(a === false || b === false ? false : a === UNKNOWN || b === UNKNOWN ? UNKNOWN : true);
        expect(any).toBe(a === true || b === true ? true : a === UNKNOWN || b === UNKNOWN ? UNKNOWN : false);
      }
    expect(not3(true)).toBe(false);
    expect(not3(false)).toBe(true);
    expect(not3(UNKNOWN)).toBe(UNKNOWN);
  });
  test("combinators over real leaves", () => {
    const v = view(hl("BTC", T0, 110)); // ETH missing -> unknown
    expect(ev({ all: [priceAbove("BTC", 100), priceAbove("ETH", 1)] }, v)).toBe(UNKNOWN);
    expect(ev({ all: [priceAbove("BTC", 200), priceAbove("ETH", 1)] }, v)).toBe(false);
    expect(ev({ any: [priceAbove("BTC", 100), priceAbove("ETH", 1)] }, v)).toBe(true);
    expect(ev({ any: [priceAbove("BTC", 200), priceAbove("ETH", 1)] }, v)).toBe(UNKNOWN);
    expect(ev({ not: priceAbove("ETH", 1) }, v)).toBe(UNKNOWN);
  });
});

describe("HL price leg", () => {
  test("operators", () => {
    const v = view(hl("BTC", T0, 100));
    expect(ev({ price: { coin: "BTC", op: ">", value: 100 } }, v)).toBe(false);
    expect(ev({ price: { coin: "BTC", op: ">=", value: 100 } }, v)).toBe(true);
    expect(ev({ price: { coin: "BTC", op: "<", value: 100 } }, v)).toBe(false);
    expect(ev({ price: { coin: "BTC", op: "<=", value: 100 } }, v)).toBe(true);
  });
  test("mark vs oracle agreement within 1%", () => {
    expect(ev(priceAbove("BTC", 50), view(hl("BTC", T0, 101, { oracle: 100 })))).toBe(true);
    expect(ev(priceAbove("BTC", 50), view(hl("BTC", T0, 99, { oracle: 100 })))).toBe(true);
    expect(ev(priceAbove("BTC", 50), view(hl("BTC", T0, 101.01, { oracle: 100 })))).toBe(UNKNOWN);
    expect(ev(priceAbove("BTC", 50), view(hl("BTC", T0, 98.9, { oracle: 100 })))).toBe(UNKNOWN);
    expect(ev(priceAbove("BTC", 50), view(hl("BTC", T0, 100, { oracle: undefined })))).toBe(UNKNOWN);
    expect(agrees(NaN, 100, 1)).toBe(false);
    expect(agrees(100, 0, 1)).toBe(false);
  });
  test("staleness per source, configurable", () => {
    const v = view(hl("BTC", T0, 110));
    expect(ev(priceAbove("BTC", 100), v, T0 + 30_000)).toBe(true);
    expect(ev(priceAbove("BTC", 100), v, T0 + 30_001)).toBe(UNKNOWN);
    expect(ev(priceAbove("BTC", 100), v, T0 + 5 * MIN, config({ maxAgeMs: { hl: 10 * MIN } }))).toBe(true);
  });
  test("a stale oracle alone makes the leg unknown", () => {
    const v = view(hl("BTC", T0, 110));
    v.apply({ src: "hl", coin: "BTC", at: T0 + 40_000, mark: 110, volume24h: 1e9 });
    expect(ev(priceAbove("BTC", 100), v, T0 + 40_000)).toBe(UNKNOWN);
  });
  test("halted market is unknown", () => {
    expect(ev(priceAbove("BTC", 100), view(hl("BTC", T0, 110, { halted: true })))).toBe(UNKNOWN);
    expect(ev({ funding: { coin: "BTC", op: ">", value: 0 } }, view(hl("BTC", T0, 110, { halted: true })))).toBe(UNKNOWN);
    expect(ev(priceAbove("BTC", 100), view(hl("BTC", T0, 110, { halted: false })))).toBe(true);
  });
  test("24h volume floor $250k", () => {
    expect(ev(priceAbove("BTC", 100), view(hl("BTC", T0, 110, { volume24h: 250_000 })))).toBe(true);
    expect(ev(priceAbove("BTC", 100), view(hl("BTC", T0, 110, { volume24h: 249_999 })))).toBe(UNKNOWN);
    expect(ev(priceAbove("BTC", 100), view(hl("BTC", T0, 110, { volume24h: undefined })))).toBe(UNKNOWN);
    expect(ev({ oi: { coin: "BTC", op: ">", value: 1 } }, view(hl("BTC", T0, 110, { volume24h: 1 })))).toBe(UNKNOWN);
  });
  test("non-finite values fail closed", () => {
    expect(ev(priceAbove("BTC", 100), view(hl("BTC", T0, NaN)))).toBe(UNKNOWN);
  });
});

describe("funding, oi, fear & greed", () => {
  test("funding is hourly percent; oi is USD", () => {
    const v = view(hl("BTC", T0, 100, { funding: -0.002, oi: 5e8 }));
    expect(ev({ funding: { coin: "BTC", op: "<", value: 0 } }, v)).toBe(true);
    expect(ev({ oi: { coin: "BTC", op: ">", value: 1e8 } }, v)).toBe(true);
    expect(ev({ oi: { coin: "BTC", op: ">", value: 1e9 } }, v)).toBe(false);
  });
  test("fear & greed and its staleness", () => {
    const v = view({ src: "fg", at: T0, value: 15 });
    expect(ev({ fear_greed: { op: "<=", value: 20 } }, v)).toBe(true);
    expect(ev({ fear_greed: { op: "<=", value: 20 } }, v, T0 + 25 * HOUR)).toBe(true);
    expect(ev({ fear_greed: { op: "<=", value: 20 } }, v, T0 + 27 * HOUR)).toBe(UNKNOWN);
    expect(ev({ fear_greed: { op: "<=", value: 20 } }, new MemoryMarketView())).toBe(UNKNOWN);
  });
});

describe("change over a window", () => {
  const c = (op: ">" | "<", value: number): Condition => ({ change: { coin: "BTC", op, value, window: "1h" } });
  test("percent change from the mark at now - window", () => {
    const v = view(hl("BTC", T0, 100), hl("BTC", T0 + 30 * MIN, 120), hl("BTC", T0 + HOUR, 110));
    expect(ev(c(">", 9.99), v, T0 + HOUR)).toBe(true);
    expect(ev(c(">", 10.01), v, T0 + HOUR)).toBe(false);
  });
  test("history that does not reach back is unknown", () => {
    const v = view(hl("BTC", T0 + 30 * MIN, 100), hl("BTC", T0 + HOUR, 110));
    expect(ev(c(">", 1), v, T0 + HOUR)).toBe(UNKNOWN);
  });
  test("a past sample too far before the target is unknown", () => {
    const v = view(hl("BTC", T0 - 10 * MIN, 100), hl("BTC", T0 + HOUR, 110));
    expect(ev(c(">", 1), v, T0 + HOUR)).toBe(UNKNOWN);
    expect(ev(c(">", 1), v, T0 + HOUR, config({ historyToleranceMs: 15 * MIN }))).toBe(true);
  });
});

describe("gap: each leg checked against its own source", () => {
  const gap = (op: ">" | "<", value: number): Condition => ({ gap: { coin: "NVDA", op, value } });
  test("legs need not agree with each other", () => {
    // Token 5% above perp: each leg passes its own check; the 5% difference is the signal.
    const v = view(hl("NVDA", T0, 100), rhc("NVDA", T0, 105));
    expect(ev(gap(">", 4.99), v)).toBe(true);
    expect(ev(gap(">", 5.01), v)).toBe(false);
    expect(ev(gap("<", 0), view(hl("NVDA", T0, 100), rhc("NVDA", T0, 90)))).toBe(true);
  });
  test("HL leg disagreeing with its oracle -> unknown", () => {
    expect(ev(gap(">", 1), view(hl("NVDA", T0, 100, { oracle: 103 }), rhc("NVDA", T0, 105)))).toBe(UNKNOWN);
  });
  test("RHC leg disagreeing with Chainlink -> unknown", () => {
    expect(ev(gap(">", 1), view(hl("NVDA", T0, 100), rhc("NVDA", T0, 105, { ref: 102 })))).toBe(UNKNOWN);
    expect(ev(gap(">", 1), view(hl("NVDA", T0, 100), rhc("NVDA", T0, 105, { ref: 104 })))).toBe(true);
  });
  test("RHC leg stale (per-source age) -> unknown", () => {
    const v2 = view(rhc("NVDA", T0, 105), hl("NVDA", T0 + 4 * MIN, 100));
    expect(ev(gap(">", 1), v2, T0 + 4 * MIN)).toBe(UNKNOWN);
    expect(ev(gap(">", 1), v2, T0 + 4 * MIN, config({ maxAgeMs: { rhc: 5 * MIN } }))).toBe(true);
  });
  test("pool depth floor $100k", () => {
    expect(ev(gap(">", 1), view(hl("NVDA", T0, 100), rhc("NVDA", T0, 105, { depth: 100_000 })))).toBe(true);
    expect(ev(gap(">", 1), view(hl("NVDA", T0, 100), rhc("NVDA", T0, 105, { depth: 99_999 })))).toBe(UNKNOWN);
  });
  test("closed session requires the closed-session depth", () => {
    const cfg = config({ minPoolDepthUsd: 50_000, closedGapDepthUsd: 100_000 });
    const open = view(hl("NVDA", T0, 100), rhc("NVDA", T0, 105, { depth: 60_000, closed: false }));
    const closed = view(hl("NVDA", T0, 100), rhc("NVDA", T0, 105, { depth: 60_000, closed: true }));
    const closedDeep = view(hl("NVDA", T0, 100), rhc("NVDA", T0, 105, { depth: 150_000, closed: true }));
    const unflagged = view(hl("NVDA", T0, 100), rhc("NVDA", T0, 105, { depth: 60_000, closed: undefined }));
    expect(ev(gap(">", 1), open, T0, cfg)).toBe(true);
    expect(ev(gap(">", 1), closed, T0, cfg)).toBe(UNKNOWN);
    expect(ev(gap(">", 1), closedDeep, T0, cfg)).toBe(true);
    expect(ev(gap(">", 1), unflagged, T0, cfg)).toBe(UNKNOWN); // missing flag = closed
  });
});

describe("calendar and session inputs", () => {
  test("time_window in tz, wrap past midnight, days", () => {
    const v = new MemoryMarketView();
    // T0 = Mon 14:00 UTC = Mon 10:00 New York (EDT).
    const tw = (from: string, to: string, days?: number[]): Condition => ({ time_window: { from, to, tz: "America/New_York", days } });
    expect(ev(tw("09:30", "16:00"), v)).toBe(true);
    expect(ev(tw("10:00", "10:01"), v)).toBe(true);
    expect(ev(tw("09:00", "10:00"), v)).toBe(false); // [from, to)
    expect(ev(tw("09:30", "16:00", [2]), v)).toBe(false);
    expect(ev(tw("22:00", "11:00"), v)).toBe(true);
    // Mon 01:00 NY belongs to the Sunday-night window.
    const mon1am = Date.UTC(2026, 9, 5, 5, 0);
    expect(ev(tw("22:00", "02:00", [0]), v, mon1am)).toBe(true);
    expect(ev(tw("22:00", "02:00", [1]), v, mon1am)).toBe(false);
    expect(ev(tw("10:00", "10:00"), v)).toBe(false);
  });
  test("market_session", () => {
    const v = view({ src: "session", at: T0, value: "regular" });
    expect(ev({ market_session: { is: "regular" } }, v)).toBe(true);
    expect(ev({ market_session: { is: "closed" } }, v)).toBe(false);
    expect(ev({ market_session: { is: "closed" } }, v, T0 + HOUR)).toBe(UNKNOWN);
  });
  test("earnings_window before / after / either", () => {
    const v = view({ src: "earnings", coin: "NVDA", at: T0, dates: [T0 + 36 * HOUR] });
    const ew = (relative: "before" | "after" | "either", within = "2d"): Condition => ({ earnings_window: { coin: "NVDA", within, relative } });
    expect(ev(ew("before"), v)).toBe(true);
    expect(ev(ew("before", "1d"), v)).toBe(false);
    expect(ev(ew("after"), v)).toBe(false);
    expect(ev(ew("after"), v, T0 + 40 * HOUR)).toBe(true);
    expect(ev(ew("either"), v, T0 + 40 * HOUR)).toBe(true);
    expect(ev(ew("either"), new MemoryMarketView())).toBe(UNKNOWN);
  });
  test("corporate_action within, either side of now", () => {
    const v = view({ src: "corp", coin: "NVDA", at: T0, actions: [{ kind: "split", at: T0 + 3 * 24 * HOUR }] });
    expect(ev({ corporate_action: { coin: "NVDA", kind: "split", within: "7d" } }, v)).toBe(true);
    expect(ev({ corporate_action: { coin: "NVDA", kind: "split", within: "2d" } }, v)).toBe(false);
    expect(ev({ corporate_action: { coin: "NVDA", kind: "dividend", within: "7d" } }, v)).toBe(false);
    expect(ev({ corporate_action: { coin: "AAPL", kind: "split", within: "7d" } }, v)).toBe(UNKNOWN);
  });
});

describe("post", () => {
  const p = (contains: string[]): Condition => ({ post: { account: "Alice", contains } });
  test("case-insensitive, every string, within the post window, stale poll unknown", () => {
    const v = view({ src: "posts", account: "alice", at: T0, posts: [{ id: "1", at: T0 - 10 * MIN, text: "Buying DOGE and BTC" }] });
    expect(ev(p(["doge", "btc"]), v)).toBe(true);
    expect(ev(p(["doge", "eth"]), v)).toBe(false);
    expect(ev(p(["doge"]), v, T0 + 4 * MIN)).toBe(UNKNOWN); // last poll too old
    v.apply({ src: "posts", account: "ALICE", at: T0 + 2 * HOUR, posts: [] });
    expect(ev(p(["doge"]), v, T0 + 2 * HOUR)).toBe(false); // out of the 1h window
  });
});

describe("after(n, cond)", () => {
  const c: Condition = { after: { n: "10m", cond: priceAbove("BTC", 100) } };
  test("holds only once the condition persisted for n; resets on false or unknown", () => {
    const memo = new Map<string, number>();
    const v = new MemoryMarketView();
    const at = (t: number, mark: number, extra = {}) => {
      v.apply(hl("BTC", t, mark, extra));
      return evalCondition(c, v, t, memo);
    };
    expect(at(T0, 110)).toBe(false);
    expect(at(T0 + 5 * MIN, 110)).toBe(false);
    expect(at(T0 + 10 * MIN, 110)).toBe(true);
    expect(at(T0 + 11 * MIN, 90)).toBe(false);
    expect(at(T0 + 12 * MIN, 110)).toBe(false);
    expect(at(T0 + 15 * MIN, 110, { oracle: 50 })).toBe(UNKNOWN);
    expect(at(T0 + 16 * MIN, 110)).toBe(false); // continuity unproven, restarted at 16m
    expect(at(T0 + 26 * MIN, 110)).toBe(true);
  });
  test("state is per node path", () => {
    const memo = new Map<string, number>();
    const both: Condition = { any: [c, { after: { n: "20m", cond: priceAbove("BTC", 100) } }] };
    const v = new MemoryMarketView();
    v.apply(hl("BTC", T0, 110));
    evalCondition(both, v, T0, memo);
    expect([...memo.keys()]).toEqual(["$.any[0].after", "$.any[1].after"]);
  });
  test("after 0m is immediate", () => {
    const v = view(hl("BTC", T0, 110));
    expect(ev({ after: { n: "0m", cond: priceAbove("BTC", 100) } }, v)).toBe(true);
  });
});
