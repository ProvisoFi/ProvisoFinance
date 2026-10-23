import { z } from "zod";

/**
 * DSL v1. Where the backend spec (section 2) leaves semantics open (CONTRACT_DECISIONS C17),
 * the choices below are implementation decisions, not the supplied API:
 * - Comparators are >, <, >=, <=. Conditions are edge-triggered: a rule fires when `when`
 *   goes false -> true, never while it merely stays true.
 * - Units: price = USD mark; change/gap = percent; funding = hourly rate in percent
 *   (0.01 = 0.01%/h, Hyperliquid's native period); oi = USD notional; fear_greed = 0..100.
 * - gap = (Robinhood Chain Stock Token price - Hyperliquid perp mark) / perp mark * 100.
 * - after: { n, cond } is true once `cond` has held continuously for duration `n`
 *   (a persistence filter; durations, not evaluation ticks, so it is cadence-independent).
 * - time_window: [from, to) wall-clock in IANA `tz`; from > to wraps past midnight;
 *   `days` (0 = Sunday) defaults to every day.
 * - post: case-insensitive substring match of every string in `contains` against posts by
 *   `account`; text is never sent to a model.
 * - Durations are "<int><m|h|d>". `expires` counts from the stamp, capped at 30 days;
 *   `cooldown` counts from a fire and only matters with fire: "repeat".
 * - The exit is relative to the trigger mark (the only `ref` in v1).
 */
export const DSL_VERSION = 1;
export const MAX_EXPIRY_DAYS = 30;
export const MAX_LEVERAGE = 10;

export const DURATION_RE = /^(0|[1-9]\d{0,5})[mhd]$/;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
/** "15m" | "4h" | "30d" -> milliseconds. */
export function durationMs(d: string): number {
  if (!DURATION_RE.test(d)) throw new Error(`Invalid duration: ${d}`);
  return Number(d.slice(0, -1)) * UNIT_MS[d.at(-1) as keyof typeof UNIT_MS];
}

const Duration = z.string().regex(DURATION_RE, "Use a duration like 15m, 4h or 30d");
const Coin = z.string().regex(/^[A-Za-z0-9:_.-]{1,32}$/, "Unknown coin format");
const Op = z.enum([">", "<", ">=", "<="]);
const Num = z.number(); // zod 4 rejects NaN and ±Infinity
const Usd = z.strictObject({ usd: Num.positive() });
const Hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24h)");

const cmp = <T extends z.ZodNumber>(value: T) =>
  z.strictObject({ coin: Coin, op: Op, value });

export const PriceCond = z.strictObject({ price: cmp(Num.positive()) });
export const ChangeCond = z.strictObject({
  change: z.strictObject({ coin: Coin, op: Op, value: Num, window: Duration }),
});
export const FundingCond = z.strictObject({ funding: cmp(Num) });
export const OiCond = z.strictObject({ oi: cmp(Num.positive()) });
export const FearGreedCond = z.strictObject({
  fear_greed: z.strictObject({ op: Op, value: Num.min(0).max(100) }),
});
export const TimeWindowCond = z.strictObject({
  time_window: z.strictObject({
    from: Hhmm,
    to: Hhmm,
    tz: z.string().refine(isTimeZone, "Unknown IANA time zone"),
    days: z.array(z.int().min(0).max(6)).min(1).max(7).optional(),
  }),
});
export const MarketSessionCond = z.strictObject({
  market_session: z.strictObject({ is: z.enum(["pre", "regular", "post", "closed"]) }),
});
export const EarningsWindowCond = z.strictObject({
  earnings_window: z.strictObject({
    coin: Coin,
    within: Duration,
    relative: z.enum(["before", "after", "either"]),
  }),
});
export const CorporateActionCond = z.strictObject({
  corporate_action: z.strictObject({
    coin: Coin,
    kind: z.enum(["split", "reverse_split", "dividend", "merger", "spinoff"]),
    within: Duration,
  }),
});
export const GapCond = z.strictObject({ gap: cmp(Num) });
export const PostCond = z.strictObject({
  post: z.strictObject({
    account: z.string().regex(/^[A-Za-z0-9_]{1,15}$/, "Use an X handle without @"),
    contains: z.array(z.string().min(1).max(280)).min(1).max(10),
  }),
});

export type Leaf =
  | z.infer<typeof PriceCond>
  | z.infer<typeof ChangeCond>
  | z.infer<typeof FundingCond>
  | z.infer<typeof OiCond>
  | z.infer<typeof FearGreedCond>
  | z.infer<typeof TimeWindowCond>
  | z.infer<typeof MarketSessionCond>
  | z.infer<typeof EarningsWindowCond>
  | z.infer<typeof CorporateActionCond>
  | z.infer<typeof GapCond>
  | z.infer<typeof PostCond>;
export type Condition =
  | Leaf
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { after: { n: string; cond: Condition } };

export const Condition: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    PriceCond,
    ChangeCond,
    FundingCond,
    OiCond,
    FearGreedCond,
    TimeWindowCond,
    MarketSessionCond,
    EarningsWindowCond,
    CorporateActionCond,
    GapCond,
    PostCond,
    z.strictObject({ all: z.array(Condition).min(1) }),
    z.strictObject({ any: z.array(Condition).min(1) }),
    z.strictObject({ not: Condition }),
    z.strictObject({ after: z.strictObject({ n: Duration, cond: Condition }) }),
  ]),
);

const Lev = z.int().min(1).max(MAX_LEVERAGE);
const HlAction = z.discriminatedUnion("action", [
  z.strictObject({
    venue: z.literal("hl"),
    action: z.literal("open"),
    coin: Coin,
    side: z.enum(["long", "short"]),
    lev: Lev,
    size: Usd,
  }),
  z.strictObject({ venue: z.literal("hl"), action: z.literal("close"), coin: Coin }),
  z.strictObject({
    venue: z.literal("hl"),
    action: z.literal("reduce"),
    coin: Coin,
    pct: Num.gt(0).lt(100),
  }),
  z.strictObject({
    venue: z.literal("hl"),
    action: z.literal("spot"),
    coin: Coin,
    side: z.enum(["buy", "sell"]),
    size: Usd,
  }),
]);
const RhcAction = z.strictObject({
  venue: z.literal("rhc"),
  action: z.literal("swap"),
  tokenIn: Coin,
  tokenOut: Coin,
  size: Usd,
  maxSlipPct: Num.gt(0).max(2),
});
export const Action = z.discriminatedUnion("venue", [HlAction, RhcAction]);
export type Action = z.infer<typeof Action>;

export const Entry = z.strictObject({
  when: Condition,
  then: z.array(Action).min(1).max(4),
  legs: z.strictObject({ atomic: z.boolean(), onPartial: z.enum(["unwind", "keep"]) }),
});
export const Exit = z.strictObject({
  stop: z.strictObject({ pct: Num.lt(0).gt(-100) }),
  take: z.strictObject({ pct: Num.gt(0).max(1000) }),
  ref: z.literal("trigger_mark"),
});
export const Limits = z.strictObject({ maxUsd: Num.positive(), maxLev: Lev });

export const Spec = z.strictObject({
  v: z.literal(DSL_VERSION),
  entry: Entry,
  exit: Exit,
  limits: Limits,
  /** live trades; alert places nothing; paper simulates the trade on real order books (no money moves). */
  mode: z.enum(["live", "alert", "paper"]),
  fire: z.enum(["once", "repeat"]).default("once"),
  cooldown: Duration.default("0m"),
  expires: Duration.refine(
    (d) => durationMs(d) > 0 && durationMs(d) <= MAX_EXPIRY_DAYS * UNIT_MS.d,
    `Expiry must be between 1m and ${MAX_EXPIRY_DAYS}d`,
  ),
});
/** A parsed spec (defaults filled). Hash only this form. */
export type Spec = z.output<typeof Spec>;
/** What a writer or UI may hand in (fire/cooldown optional). */
export type SpecInput = z.input<typeof Spec>;
export type Entry = Spec["entry"];
export type Exit = Spec["exit"];

/** A phrase the writer could not map to one rule; the user picks an option before sealing. */
export const Ambiguity = z.strictObject({
  /** JSON path into the spec where the chosen option's value goes, e.g. ["exit","stop","pct"]. */
  path: z.array(z.union([z.string(), z.int().min(0)])),
  /** The user's words that were ambiguous, e.g. "a tight stop". */
  phrase: z.string().min(1),
  options: z.array(z.strictObject({ label: z.string().min(1), value: z.unknown() })).min(2),
});
export type Ambiguity = z.infer<typeof Ambiguity>;

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
