import { describe, expect, test } from "bun:test";
import { render, renderAction, renderCondition, type Action, type Condition, type SpecInput } from "./index.ts";

const open: Action = { venue: "hl", action: "open", coin: "HYPE", side: "long", lev: 3, size: { usd: 250 } };
const spec = (over: Partial<SpecInput> = {}, entry: Partial<SpecInput["entry"]> = {}): SpecInput => ({
  v: 1,
  entry: { when: { price: { coin: "HYPE", op: ">", value: 40 } }, then: [open], legs: { atomic: false, onPartial: "unwind" }, ...entry },
  exit: { stop: { pct: -6 }, take: { pct: 15 }, ref: "trigger_mark" },
  limits: { maxUsd: 500, maxLev: 3 },
  mode: "live",
  expires: "1d",
  ...over,
});

describe("renderCondition", () => {
  const cases: [Condition, string][] = [
    [{ price: { coin: "BTC", op: ">=", value: 1234.567 } }, "BTC mark price is at or above $1,234.57"],
    [{ change: { coin: "ETH", op: "<=", value: -5, window: "1h" } }, "ETH has moved at or below -5% over 1 hour"],
    [{ change: { coin: "ETH", op: ">", value: 3, window: "15m" } }, "ETH has moved above +3% over 15 minutes"],
    [{ funding: { coin: "HYPE", op: ">", value: 0.01 } }, "HYPE hourly funding is above 0.01%"],
    [{ oi: { coin: "SOL", op: "<", value: 2_000_000 } }, "SOL open interest is below $2,000,000"],
    [{ fear_greed: { op: "<", value: 20 } }, "the Fear & Greed index is below 20"],
    [
      { time_window: { from: "09:30", to: "16:00", tz: "America/New_York", days: [1, 3, 5] } },
      "the time is between 09:30 and 16:00 (America/New_York) on Mon, Wed, Fri",
    ],
    [{ time_window: { from: "22:00", to: "02:00", tz: "UTC" } }, "the time is between 22:00 and 02:00 (UTC)"],
    [{ time_window: { from: "00:00", to: "01:00", tz: "UTC", days: [0, 6] } }, "the time is between 00:00 and 01:00 (UTC) on Sun, Sat"],
    [{ market_session: { is: "pre" } }, "the US market is in its pre session"],
    [{ earnings_window: { coin: "NVDA", within: "2d", relative: "before" } }, "NVDA earnings are within 2 days before"],
    [{ earnings_window: { coin: "NVDA", within: "1d", relative: "after" } }, "NVDA earnings are within 1 day after"],
    [{ earnings_window: { coin: "TSLA", within: "6h", relative: "either" } }, "TSLA earnings are within 6 hours before or after"],
    [{ corporate_action: { coin: "AAPL", kind: "reverse_split", within: "3d" } }, "AAPL has a reverse split within 3 days"],
    [{ corporate_action: { coin: "AAPL", kind: "dividend", within: "1m" } }, "AAPL has a dividend within 1 minute"],
    [{ gap: { coin: "NVDA", op: ">", value: 1.5 } }, "the NVDA Stock Token trades above +1.5% versus its Hyperliquid perp"],
    [{ gap: { coin: "NVDA", op: "<", value: -2 } }, "the NVDA Stock Token trades below -2% versus its Hyperliquid perp"],
    [{ post: { account: "elon", contains: ["doge", 'say "hi"'] } }, '@elon posts "doge" and "say \\"hi\\""'],
    [{ not: { market_session: { is: "closed" } } }, "it is not true that the US market is in its closed session"],
    [
      { after: { n: "30m", cond: { price: { coin: "BTC", op: "<", value: 0.5 } } } },
      "BTC mark price is below $0.5 for at least 30 minutes",
    ],
    [{ all: [{ fear_greed: { op: ">", value: 80 } }] }, "the Fear & Greed index is above 80"],
    [{ any: [{ fear_greed: { op: ">", value: 80 } }] }, "the Fear & Greed index is above 80"],
    [
      { any: [{ fear_greed: { op: ">", value: 80 } }, { all: [{ market_session: { is: "post" } }, { market_session: { is: "regular" } }] }] },
      "(the Fear & Greed index is above 80 or (the US market is in its post session and the US market is in its regular session))",
    ],
  ];
  for (const [c, want] of cases) test(want, () => expect(renderCondition(c)).toBe(want));
});

describe("renderAction", () => {
  const cases: [Action, string][] = [
    [open, "open a 3× long on HYPE for $250 on Hyperliquid"],
    [{ venue: "hl", action: "open", coin: "BTC", side: "short", lev: 10, size: { usd: 0.25 } }, "open a 10× short on BTC for $0.25 on Hyperliquid"],
    [{ venue: "hl", action: "close", coin: "ETH" }, "close the ETH position on Hyperliquid"],
    [{ venue: "hl", action: "reduce", coin: "ETH", pct: 25 }, "reduce the ETH position by 25% on Hyperliquid"],
    [{ venue: "hl", action: "spot", coin: "PURR", side: "buy", size: { usd: 1500 } }, "buy $1,500 of PURR spot on Hyperliquid"],
    [{ venue: "hl", action: "spot", coin: "PURR", side: "sell", size: { usd: 10 } }, "sell $10 of PURR spot on Hyperliquid"],
    [
      { venue: "rhc", action: "swap", tokenIn: "USDG", tokenOut: "NVDA", size: { usd: 100 }, maxSlipPct: 0.5 },
      "swap $100 of USDG for NVDA on Robinhood Chain (max 0.5% slippage)",
    ],
  ];
  for (const [a, want] of cases) test(want, () => expect(renderAction(a)).toBe(want));
});

describe("render", () => {
  const close: Action = { venue: "hl", action: "close", coin: "ETH" };

  test("multi-leg atomic, alert mode, repeat with cooldown", () => {
    expect(render(spec({ mode: "alert", fire: "repeat", cooldown: "4h", expires: "7d" }, { then: [open, close], legs: { atomic: true, onPartial: "unwind" } }))).toBe(
      [
        "When HYPE mark price is above $40: Proviso will alert you to open a 3× long on HYPE for $250 on Hyperliquid, then close the ETH position on Hyperliquid (alert only: no order is placed). All legs fill together or not at all.",
        "Exit at -6% (stop) or +15% (target) from the trigger mark.",
        "Limits: $500 and 3×. Can fire again after a 4 hours cooldown; expires 7 days after sealing.",
      ].join("\n"),
    );
  });

  test("multi-leg non-atomic names what happens on a partial fill", () => {
    const unwind = render(spec({}, { then: [open, close], legs: { atomic: false, onPartial: "unwind" } })).split("\n")[0];
    const keep = render(spec({}, { then: [open, close], legs: { atomic: false, onPartial: "keep" } })).split("\n")[0];
    expect(unwind).toEndWith(
      "Proviso will open a 3× long on HYPE for $250 on Hyperliquid, then close the ETH position on Hyperliquid. Legs are not atomic; if one only partly fills, the rest is unwound.",
    );
    expect(keep).toEndWith("Legs are not atomic; if one only partly fills, the rest is kept.");
  });

  test("a single leg ignores the legs setting; repeat with no cooldown", () => {
    expect(render(spec({ fire: "repeat", expires: "1m" }, { legs: { atomic: true, onPartial: "keep" } })).split("\n")).toEqual([
      "When HYPE mark price is above $40: Proviso will open a 3× long on HYPE for $250 on Hyperliquid.",
      "Exit at -6% (stop) or +15% (target) from the trigger mark.",
      "Limits: $500 and 3×. Can fire again; expires 1 minute after sealing.",
    ]);
  });

  test("an invalid spec throws instead of rendering", () => {
    expect(() => render(spec({ expires: "31d" }))).toThrow("Expiry must be between 1m and 30d");
    expect(() => render({ ...spec(), v: 2 } as unknown as SpecInput)).toThrow();
  });
});
