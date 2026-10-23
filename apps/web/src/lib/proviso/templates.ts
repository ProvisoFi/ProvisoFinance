// Ready-made rule structures for the composer (TU-14). Each one is a starting point, not advice:
// every number is a placeholder the user is expected to change, and every template opens as an
// alert (nothing trades until the user switches it to live). All fit the default risk limits.
import type { SpecInput } from "@proviso/dsl";
import type { Thesis } from "./domain";

/**
 * A starting point: what the rule watches (`watches`), what it does (`does`), and the draft it opens.
 * RWA templates (stocks, metals, oil on Hyperliquid's xyz markets) also say which market mechanic they
 * rely on and how they fail, since those markets gap, close and reprice in their own ways.
 */
export type Template = {
  id: string;
  name: string;
  watches: string;
  does: string;
  group?: "rwa";
  relies?: string;
  fails?: string;
  thesis: () => Thesis;
};

const base = (patch: Partial<Thesis>): Thesis => ({
  id: "",
  title: "",
  market: "BTC",
  side: "long",
  leverage: 2,
  allocation: 100,
  conditions: [],
  match: "all",
  stop: 5,
  take: 10,
  expiryDays: 14,
  cooldownMinutes: 0,
  fire: "once",
  intent: "alert",
  created: "",
  updated: "",
  ...patch,
});

/** A full rule for structures the builder can't express (two legs, time windows, basis); opens as an alert. */
const rule = (title: string, spec: Omit<SpecInput, "v" | "mode" | "fire" | "cooldown">): Thesis =>
  base({ title, spec: { v: 1, mode: "alert", fire: "once", cooldown: "0m", ...spec } as SpecInput });
const open = (coin: string, side: "long" | "short", usd: number, lev = 2) =>
  ({ venue: "hl", action: "open", coin, side, lev, size: { usd } }) as const;
const change = (coin: string, op: ">" | "<", value: number) => ({ change: { coin, op, value, window: "24h" } });
const exit = (stop: number, take: number) => ({ stop: { pct: -stop }, take: { pct: take }, ref: "trigger_mark" as const });

/** The gallery, in display order. */
export const templates: readonly Template[] = [
  {
    id: "funding-reversal",
    name: "Funding reversal",
    watches: "Funding turns negative while price holds above a level",
    does: "Hyperliquid perp",
    thesis: () =>
      base({
        title: "Funding reversal",
        market: "HYPE",
        leverage: 3,
        allocation: 250,
        conditions: [
          { id: "c1", signal: "funding", op: "<", value: 0 },
          { id: "c2", signal: "price", op: ">", value: 40 },
        ],
        stop: 6,
        take: 15,
        expiryDays: 30,
      }),
  },
  {
    id: "fear-extreme",
    name: "Sentiment extreme",
    watches: "Fear & Greed drops below a level",
    does: "Hyperliquid perp",
    thesis: () =>
      base({
        title: "Sentiment extreme",
        market: "BTC",
        allocation: 200,
        conditions: [{ id: "c1", signal: "fear_greed", op: "<", value: 20 }],
        stop: 8,
        take: 20,
      }),
  },
  {
    id: "pullback",
    name: "Pullback with steady sentiment",
    watches: "24h move below a threshold while Fear & Greed stays above a level",
    does: "Hyperliquid perp",
    thesis: () =>
      base({
        title: "Pullback with steady sentiment",
        market: "ETH",
        allocation: 150,
        conditions: [
          { id: "c1", signal: "change", op: "<", value: -5 },
          { id: "c2", signal: "fear_greed", op: ">", value: 50 },
        ],
        expiryDays: 7,
        take: 12,
      }),
  },
  {
    id: "momentum-fade",
    name: "Momentum fade",
    watches: "24h move above a threshold",
    does: "Hyperliquid perp, short",
    thesis: () =>
      base({
        title: "Momentum fade",
        market: "ETH",
        side: "short",
        allocation: 150,
        conditions: [{ id: "c1", signal: "change", op: ">", value: 8 }],
        stop: 4,
        take: 8,
        expiryDays: 7,
      }),
  },
  {
    id: "stock-swap",
    name: "Stock Token on a sentiment level",
    watches: "Fear & Greed rises above a level",
    does: "Robinhood Chain swap, USDG into a Stock Token",
    thesis: () =>
      base({
        title: "Stock Token on a sentiment level",
        allocation: 25,
        conditions: [{ id: "c1", signal: "fear_greed", op: ">", value: 55 }],
        swap: { tokenOut: "TSLA", slipPct: 1 },
        expiryDays: 30,
      }),
  },
  {
    id: "repeat-swap",
    name: "Repeating Stock Token entry",
    watches: "Fear & Greed below a level, at most once a week",
    does: "Robinhood Chain swap, repeats",
    thesis: () =>
      base({
        title: "Repeating Stock Token entry",
        allocation: 20,
        conditions: [{ id: "c1", signal: "fear_greed", op: "<", value: 25 }],
        swap: { tokenOut: "AMZN", slipPct: 1 },
        fire: "repeat",
        cooldownMinutes: 10_080,
        stop: 10,
        take: 20,
        expiryDays: 30,
      }),
  },
  // RWA library (expansion #7): stocks, metals and oil on Hyperliquid's xyz markets.
  {
    id: "rwa-reopen-fade",
    name: "Reopen gap fade",
    watches: "NVDA reopens more than 4% below its level a day earlier",
    does: "xyz perp, long",
    group: "rwa",
    relies: "Session guards hide weekend and overnight prints; the rule sees the gap only after the 5-minute reopen pause.",
    fails: "Gaps on real news (earnings, guidance) often keep going. Check the calendar; the stop is your protection.",
    thesis: () =>
      base({
        title: "Reopen gap fade",
        market: "xyz:NVDA",
        allocation: 200,
        conditions: [{ id: "c1", signal: "change", op: "<", value: -4 }],
        stop: 4,
        take: 6,
        expiryDays: 7,
      }),
  },
  {
    id: "rwa-funding-carry",
    name: "Gold funding carry",
    watches: "Gold funding turns negative, so shorts pay longs",
    does: "xyz perp, long",
    group: "rwa",
    relies: "Hourly funding paid to longs; the carry budget closes the trade if funding flips and costs over 1% of its value.",
    fails: "Funding is small next to price: a 1% drop in gold erases weeks of carry, and funding can flip within hours.",
    thesis: () =>
      base({
        title: "Gold funding carry",
        market: "xyz:GOLD",
        allocation: 200,
        conditions: [{ id: "c1", signal: "funding", op: "<", value: -0.005 }],
        stop: 3,
        take: 6,
        expiryDays: 30,
      }),
  },
  {
    id: "rwa-gold-silver",
    name: "Silver catches up to gold",
    watches: "Gold up over 2% in a day while silver lags under 0.5%",
    does: "Two xyz perps: long silver, short gold",
    group: "rwa",
    relies: "Silver usually follows a strong gold move; the pair bets on the gap closing, not on where metals go.",
    fails: "The ratio can trend for months. Exits follow silver's price, so a loss spread across both legs may not stop it.",
    thesis: () =>
      rule("Silver catches up to gold", {
        entry: {
          when: { all: [change("xyz:GOLD", ">", 2), change("xyz:SILVER", "<", 0.5)] },
          then: [open("xyz:SILVER", "long", 150), open("xyz:GOLD", "short", 150)],
          legs: { atomic: true, onPartial: "unwind" },
        },
        exit: exit(3, 5),
        limits: { maxUsd: 300, maxLev: 2 },
        expires: "14d",
      }),
  },
  {
    id: "rwa-wti-brent",
    name: "WTI and Brent reconverge",
    watches: "Brent up over 3% in a day while WTI lags under 1%",
    does: "Two xyz perps: long WTI, short Brent",
    group: "rwa",
    relies: "Both are crude oil priced off futures; a sudden gap between them often narrows.",
    fails: "Regional shocks (a pipeline outage, an export rule) can widen the spread for weeks.",
    thesis: () =>
      rule("WTI and Brent reconverge", {
        entry: {
          when: { all: [change("xyz:BRENTOIL", ">", 3), change("xyz:CL", "<", 1)] },
          then: [open("xyz:CL", "long", 150), open("xyz:BRENTOIL", "short", 150)],
          legs: { atomic: true, onPartial: "unwind" },
        },
        exit: exit(3, 5),
        limits: { maxUsd: 300, maxLev: 2 },
        expires: "14d",
      }),
  },
  {
    id: "rwa-regular-hours",
    name: "Regular-hours breakout",
    watches: "TSLA up over 3% in a day, acted on only 10:00–15:30 New York, Mon–Fri",
    does: "xyz perp, long",
    group: "rwa",
    relies: "Acts only in the main US session after the opening auction, when the book is deepest; pre-market moves can't trigger it.",
    fails: "Breakouts often fade, and the move may already be priced in by the time the window opens.",
    thesis: () =>
      rule("Regular-hours breakout", {
        entry: {
          when: { all: [{ time_window: { from: "10:00", to: "15:30", tz: "America/New_York", days: [1, 2, 3, 4, 5] } }, change("xyz:TSLA", ">", 3)] },
          then: [open("xyz:TSLA", "long", 150)],
          legs: { atomic: false, onPartial: "unwind" },
        },
        exit: exit(3, 6),
        limits: { maxUsd: 150, maxLev: 2 },
        expires: "7d",
      }),
  },
  {
    id: "rwa-basis",
    name: "Stock Token vs perp basis",
    watches: "The TSLA Stock Token trades over 1% above the TSLA perp",
    does: "Alert (names the short-perp side)",
    group: "rwa",
    relies: "Robinhood Chain's TSLA token and Hyperliquid's xyz:TSLA track the same share; when they drift apart, one is usually off.",
    fails: "Outside US hours the token's pool is thin and the perp prices internally; Proviso ignores the perp while it's closed.",
    thesis: () =>
      rule("Stock Token vs perp basis", {
        entry: {
          when: { gap: { coin: "xyz:TSLA", op: ">", value: 1 } },
          then: [open("xyz:TSLA", "short", 100, 1)],
          legs: { atomic: false, onPartial: "unwind" },
        },
        exit: exit(2, 2),
        limits: { maxUsd: 100, maxLev: 1 },
        expires: "14d",
      }),
  },
];
