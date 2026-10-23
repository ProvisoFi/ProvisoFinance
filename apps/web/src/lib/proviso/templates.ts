// Ready-made rule structures for the composer (TU-14). Each one is a starting point, not advice:
// every number is a placeholder the user is expected to change, and every template opens as an
// alert (nothing trades until the user switches it to live). All fit the default risk limits.
import type { Thesis } from "./domain";

/** A starting point: what the rule watches (`watches`), what it does (`does`), and the draft it opens. */
export type Template = {
  id: string;
  name: string;
  watches: string;
  does: string;
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
];
