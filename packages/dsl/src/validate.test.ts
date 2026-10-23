import { describe, expect, test } from "bun:test";
import { ALL_CAPABILITIES, complexityError, CORE_CAPABILITIES, validate, type Action, type Condition, type SpecInput, type ValidateContext } from "./index.ts";

const open = (coin = "HYPE", lev = 3, usd = 250): Action => ({ venue: "hl", action: "open", coin, side: "long", lev, size: { usd } });
const spec = (then: Action[] = [open()], when: Condition = { price: { coin: "HYPE", op: ">", value: 40 } }): SpecInput => ({
  v: 1,
  entry: { when, then, legs: { atomic: false, onPartial: "unwind" } },
  exit: { stop: { pct: -6 }, take: { pct: 15 }, ref: "trigger_mark" },
  limits: { maxUsd: 500, maxLev: 3 },
  mode: "live",
  expires: "1d",
});
const ctx = (over: Partial<ValidateContext> = {}): ValidateContext => ({
  hl: { HYPE: { maxLeverage: 5, volume24hUsd: 1e8 }, THIN: { maxLeverage: 5, volume24hUsd: 1e3 }, LOWLEV: { maxLeverage: 2, volume24hUsd: 1e8 } },
  hlSpot: { PURR: { volume24hUsd: 1e6 }, DUST: { volume24hUsd: 10 } },
  rhc: {
    NVDA: { isCanonical: true, poolDepthUsd: 5e5 },
    USDG: { isCanonical: true, poolDepthUsd: 1e9 },
    FAKE: { isCanonical: false, poolDepthUsd: 1e9 },
    SHALLOW: { isCanonical: true, poolDepthUsd: 5e4 },
  },
  user: { maxUsd: 1000, maxLev: 5 },
  // These tests cover the market checks of the whole language; what core runs today is tested below.
  capabilities: ALL_CAPABILITIES,
  ...over,
});
const swap = (tokenIn: string, tokenOut: string): Action => ({ venue: "rhc", action: "swap", tokenIn, tokenOut, size: { usd: 100 }, maxSlipPct: 1 });
const spot = (coin: string): Action => ({ venue: "hl", action: "spot", coin, side: "buy", size: { usd: 100 } });
const errs = (input: unknown, c = ctx()) => {
  const r = validate(input, c);
  return r.errors.map(({ code, path, message }) => ({ code, path, message }));
};
const fg: Condition = { fear_greed: { op: ">", value: 50 } };

describe("validate accepts", () => {
  test("a valid spec, returning the parsed form with defaults", () => {
    const r = validate(spec([open(), spot("PURR"), swap("USDG", "NVDA")]), ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec).toMatchObject({ fire: "once", cooldown: "0m" });
    expect(r.errors).toEqual([]);
  });

  test("equity conditions on a coin known to either venue", () => {
    expect(errs(spec([open()], { all: [{ earnings_window: { coin: "HYPE", within: "1d", relative: "either" } }, { corporate_action: { coin: "NVDA", kind: "split", within: "2d" } }] }))).toEqual([]);
  });

  test("lowered floors let thin testnet markets through", () => {
    const c = ctx({ floors: { hlVolumeUsd: 500, poolDepthUsd: 1000 } });
    expect(errs(spec([open("THIN"), swap("USDG", "SHALLOW")]), c)).toEqual([]);
  });
});

describe("validate refuses", () => {
  test("schema violations, with the zod message and path", () => {
    expect(errs({ ...spec(), v: 2 })).toEqual([{ code: "schema", path: ["v"], message: "Invalid input: expected 1" }]);
    const bad = spec([{ ...open(), coin: "no spaces" } as Action]);
    expect(errs(bad)).toEqual([{ code: "schema", path: ["entry", "then", 0, "coin"], message: "Unknown coin format" }]);
    expect(errs({ ...spec(), expires: "0m" })).toEqual([{ code: "schema", path: ["expires"], message: "Expiry must be between 1m and 30d" }]);
  });

  test("unknown and illiquid perps, in actions and conditions", () => {
    expect(errs(spec([open("DOGE", 1, 10)], { all: [{ funding: { coin: "THIN", op: "<", value: 0 } }, { oi: { coin: "NOPE", op: ">", value: 1 } }] }))).toEqual([
      { code: "unknown_market", path: ["entry", "then", 0, "coin"], message: "DOGE is not a Hyperliquid perp" },
      { code: "illiquid", path: ["entry", "when", "all", 0, "funding", "coin"], message: "THIN trades under $250,000 a day on Hyperliquid" },
      { code: "unknown_market", path: ["entry", "when", "all", 1, "oi", "coin"], message: "NOPE is not a Hyperliquid perp" },
    ]);
    expect(errs(spec([open()], { change: { coin: "THIN", op: ">", value: 1, window: "1h" } }), ctx({ floors: { hlVolumeUsd: 1e9 } }))).toEqual([
      { code: "illiquid", path: ["entry", "then", 0, "coin"], message: "HYPE trades under $1,000,000,000 a day on Hyperliquid" },
      { code: "illiquid", path: ["entry", "when", "change", "coin"], message: "THIN trades under $1,000,000,000 a day on Hyperliquid" },
    ]);
  });

  test("inherited object keys are not markets", () => {
    expect(errs(spec([open("constructor", 1, 10)], { price: { coin: "toString", op: ">", value: 1 } }))).toEqual([
      { code: "unknown_market", path: ["entry", "then", 0, "coin"], message: "constructor is not a Hyperliquid perp" },
      { code: "unknown_market", path: ["entry", "when", "price", "coin"], message: "toString is not a Hyperliquid perp" },
    ]);
  });

  test("unknown and illiquid spot markets", () => {
    expect(errs(spec([spot("HYPE"), spot("DUST")]))).toEqual([
      { code: "unknown_market", path: ["entry", "then", 0, "coin"], message: "HYPE is not a Hyperliquid spot market" },
      { code: "illiquid", path: ["entry", "then", 1, "coin"], message: "DUST trades under $250,000 a day on Hyperliquid spot" },
    ]);
    expect(errs(spec([spot("PURR")]), ctx({ hlSpot: undefined }))).toEqual([
      { code: "unknown_market", path: ["entry", "then", 0, "coin"], message: "PURR is not a Hyperliquid spot market" },
    ]);
  });

  test("Robinhood Chain tokens that are unknown, non-canonical or shallow", () => {
    expect(errs(spec([swap("FAKE", "ZZZ"), swap("USDG", "SHALLOW")]))).toEqual([
      { code: "not_canonical", path: ["entry", "then", 0, "tokenIn"], message: "FAKE is not a canonical Stock Token" },
      { code: "unknown_market", path: ["entry", "then", 0, "tokenOut"], message: "ZZZ is not on Robinhood Chain" },
      { code: "illiquid", path: ["entry", "then", 1, "tokenOut"], message: "SHALLOW pool depth is under $100,000" },
    ]);
    expect(errs(spec([swap("USDG", "NVDA")]), ctx({ rhc: undefined }))).toEqual([
      { code: "unknown_market", path: ["entry", "then", 0, "tokenIn"], message: "USDG is not on Robinhood Chain" },
      { code: "unknown_market", path: ["entry", "then", 0, "tokenOut"], message: "NVDA is not on Robinhood Chain" },
    ]);
  });

  test("a gap needs both the perp and the Stock Token", () => {
    expect(errs(spec([open()], { gap: { coin: "NVDA", op: ">", value: 1 } }))).toEqual([
      { code: "unknown_market", path: ["entry", "when", "gap", "coin"], message: "NVDA is not a Hyperliquid perp" },
    ]);
    expect(errs(spec([open()], { gap: { coin: "HYPE", op: ">", value: 1 } }))).toEqual([
      { code: "unknown_market", path: ["entry", "when", "gap", "coin"], message: "HYPE is not on Robinhood Chain" },
    ]);
  });

  test("equity conditions on an unknown coin", () => {
    expect(
      errs(spec([open()], { any: [{ earnings_window: { coin: "ZZZ", within: "1d", relative: "before" } }, { corporate_action: { coin: "QQQ", kind: "merger", within: "1d" } }] })),
    ).toEqual([
      { code: "unknown_market", path: ["entry", "when", "any", 0, "earnings_window", "coin"], message: "ZZZ is not a known equity market" },
      { code: "unknown_market", path: ["entry", "when", "any", 1, "corporate_action", "coin"], message: "QQQ is not a known equity market" },
    ]);
  });

  test("idea limits above the user's limits, NaN failing closed", () => {
    expect(errs(spec([open("HYPE", 1, 10)]), ctx({ user: { maxUsd: 100, maxLev: 2 } }))).toEqual([
      { code: "limits_over_user", path: ["limits", "maxUsd"], message: "Idea limit exceeds your $100 limit" },
      { code: "limits_over_user", path: ["limits", "maxLev"], message: "Idea leverage exceeds your 2× limit" },
    ]);
    expect(errs(spec([open("HYPE", 1, 10)]), ctx({ user: { maxUsd: NaN, maxLev: NaN } })).map((e) => e.code)).toEqual([
      "limits_over_user",
      "limits_over_user",
      "lev_over_limit",
      "size_over_limit",
    ]);
  });

  test("leverage over the market, idea or user cap", () => {
    expect(errs(spec([open("LOWLEV", 3, 10)]))).toEqual([
      { code: "lev_over_limit", path: ["entry", "then", 0, "lev"], message: "Leverage is capped at 2× here" },
    ]);
  });

  test("total size over the smaller of the idea and user limits", () => {
    const close: Action = { venue: "hl", action: "close", coin: "HYPE" };
    expect(errs(spec([open("HYPE", 1, 300), spot("PURR"), swap("USDG", "NVDA"), close]))).toEqual([]);
    expect(errs(spec([open("HYPE", 1, 401), spot("PURR")]))).toEqual([
      { code: "size_over_limit", path: ["entry", "then"], message: "Total size $501 exceeds the $500 limit" },
    ]);
  });

  test("conditions nested too deep", () => {
    const deep: Condition = { not: { all: [{ any: [{ after: { n: "1m", cond: fg } }] }] } };
    expect(errs(spec([open()], deep))).toEqual([
      { code: "too_complex", path: ["entry", "when", "not", "all", 0, "any", 0, "after", "cond"], message: "Nest conditions at most 4 deep" },
    ]);
    expect(complexityError(deep)).toBe("nested 5 deep (max 4)");
  });

  test("too many leaf conditions", () => {
    const many: Condition = { all: Array.from({ length: 9 }, () => fg) };
    expect(errs(spec([open()], many))).toEqual([{ code: "too_complex", path: ["entry", "when"], message: "Use at most 8 conditions" }]);
    expect(complexityError(many)).toBe("9 conditions (max 8)");
    expect(complexityError({ all: Array.from({ length: 8 }, () => fg) })).toBeNull();
  });
});

describe("TU-02: only what core can run is accepted by default", () => {
  const core = ctx({ capabilities: undefined });
  test("Hyperliquid close, reduce and spot actions are refused with a clear reason", () => {
    const close: Action = { venue: "hl", action: "close", coin: "HYPE" };
    const reduce: Action = { venue: "hl", action: "reduce", coin: "HYPE", pct: 50 } as Action;
    expect(errs(spec([open(), spot("PURR"), close]), core).filter((e) => e.code === "unsupported")).toEqual([
      { code: "unsupported", path: ["entry", "then", 1, "action"], message: "Hyperliquid spot trades aren't supported yet: use a perp or a Robinhood Chain swap" },
      { code: "unsupported", path: ["entry", "then", 2, "action"], message: "Closing a position as an entry action isn't supported yet: ideas exit on their stop and target" },
    ]);
    expect(errs(spec([reduce]), core)).toEqual([
      { code: "unsupported", path: ["entry", "then", 0, "action"], message: "Reducing a position as an entry action isn't supported yet: ideas exit on their stop and target" },
    ]);
  });
  test("market-session, earnings and corporate-action conditions are refused: nothing feeds them yet", () => {
    const when: Condition = {
      any: [
        { market_session: { is: "regular" } },
        { earnings_window: { coin: "HYPE", within: "1d", relative: "either" } },
        { corporate_action: { coin: "NVDA", kind: "split", within: "2d" } },
      ],
    };
    expect(errs(spec([open()], when), core)).toEqual([
      { code: "unsupported", path: ["entry", "when", "any", 0, "market_session"], message: "No live data feeds market-session conditions yet, so this idea would never fire" },
      { code: "unsupported", path: ["entry", "when", "any", 1, "earnings_window"], message: "No live data feeds earnings conditions yet, so this idea would never fire" },
      { code: "unsupported", path: ["entry", "when", "any", 2, "corporate_action"], message: "No live data feeds corporate-action conditions yet, so this idea would never fire" },
    ]);
  });
  test("everything core runs still passes: perp opens, swaps, and every fed condition", () => {
    const when: Condition = {
      all: [
        { price: { coin: "HYPE", op: ">", value: 1 } },
        { funding: { coin: "HYPE", op: "<", value: 0 } },
        { oi: { coin: "HYPE", op: ">", value: 1 } },
        { change: { coin: "HYPE", op: ">", value: 1, window: "1d" } },
        fg,
        { time_window: { from: "09:30", to: "16:00", tz: "America/New_York" } },
      ],
    };
    expect(errs(spec([open("HYPE", 2, 200), swap("USDG", "NVDA")], when), core)).toEqual([]);
    expect(CORE_CAPABILITIES.actions).toEqual(["hl:open", "rhc:swap"]);
  });
});

describe("HIP-3 markets (xyz:)", () => {
  const xyz = ctx({ capabilities: undefined, hl: { HYPE: { maxLeverage: 5, volume24hUsd: 1e8 }, "xyz:NVDA": { maxLeverage: 20, volume24hUsd: 3e8 } } });
  const nvda = (mode: "live" | "alert"): SpecInput => ({
    ...spec([open("xyz:NVDA", 3, 250)], { price: { coin: "xyz:NVDA", op: ">", value: 200 } }),
    mode,
  });
  test("alerts on xyz markets pass: conditions and actions resolve like any perp", () => {
    expect(errs(nvda("alert"), xyz)).toEqual([]);
  });
  test("live trading on xyz is open in core; a deployment without hip3Live refuses it with a plain reason", () => {
    expect(errs(nvda("live"), xyz)).toEqual([]);
    expect(errs(nvda("live"), { ...xyz, capabilities: { ...CORE_CAPABILITIES, hip3Live: false } })).toEqual([
      { code: "unsupported", path: ["entry", "then", 0, "coin"], message: "Live trading on xyz:NVDA (stocks, metals, oil and indices) isn't open here; seal it as an alert for now" },
    ]);
  });
  test("pre-IPO markets stay alert-only", () => {
    const io = { ...xyz, hl: { ...xyz.hl, "xyz:OURA": { maxLeverage: 3, volume24hUsd: 1e8 } } };
    const oura = (mode: "live" | "alert") => ({ ...spec([open("xyz:OURA", 2, 100)], { price: { coin: "xyz:OURA", op: ">", value: 1 } }), mode }) as SpecInput;
    expect(errs(oura("alert"), io)).toEqual([]);
    expect(errs(oura("live"), io).map((e) => e.message)).toEqual(["xyz:OURA is a pre-IPO market: its price comes only from its own order book, so it stays alert-only for now"]);
  });
  test("main-dex live trading is unaffected; unknown xyz coins are unknown markets", () => {
    expect(errs(spec([open("HYPE", 3, 250)]), xyz)).toEqual([]);
    expect(errs({ ...nvda("alert"), entry: { ...nvda("alert").entry, when: { price: { coin: "xyz:NOPE", op: ">", value: 1 } } } } as SpecInput, xyz).map((e) => e.code)).toEqual(["unknown_market"]);
  });
  test("xyz markets without a published session calendar are refused, so off-hours noise can't fire them", () => {
    const corn = ctx({ hl: { "xyz:CORN": { maxLeverage: 10, volume24hUsd: 1e8 } } });
    const s = { ...nvda("alert"), entry: { ...nvda("alert").entry, when: { price: { coin: "xyz:CORN", op: ">", value: 1 } } } } as SpecInput;
    expect(errs(s, { ...xyz, hl: { ...xyz.hl, ...corn.hl } })).toEqual([
      { code: "unsupported", path: ["entry", "when", "price", "coin"], message: "xyz:CORN has no published session calendar yet, so Proviso can't tell its real prices from off-hours ones" },
    ]);
  });
});
