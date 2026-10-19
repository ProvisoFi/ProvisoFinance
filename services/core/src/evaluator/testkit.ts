// Shared test fixtures (not used at runtime).
import type { SpecInput, Condition } from "@proviso/dsl";
import type { Update } from "./state.ts";

export const T0 = Date.UTC(2026, 9, 5, 14, 0); // Monday 2026-10-05 14:00 UTC
export const MIN = 60_000;
export const HOUR = 3_600_000;

/** A healthy HL update: oracle = mark, deep volume. */
export const hl = (coin: string, at: number, mark: number, extra: Partial<Extract<Update, { src: "hl" }>> = {}): Update => ({
  src: "hl",
  coin,
  at,
  mark,
  oracle: mark,
  volume24h: 1e9,
  funding: 0.01,
  oi: 1e8,
  ...extra,
});

/** A healthy RHC update: reference = pool price, deep pool, open session. */
export const rhc = (coin: string, at: number, pool: number, extra: Partial<Extract<Update, { src: "rhc" }>> = {}): Update => ({
  src: "rhc",
  coin,
  at,
  pool,
  ref: pool,
  depth: 1e6,
  closed: false,
  ...extra,
});

export const spec = (when: Condition, over: Partial<SpecInput> = {}): SpecInput => ({
  v: 1,
  entry: {
    when,
    then: [{ venue: "hl", action: "open", coin: "BTC", side: "long", lev: 2, size: { usd: 1000 } }],
    legs: { atomic: false, onPartial: "unwind" },
  },
  exit: { stop: { pct: -5 }, take: { pct: 5 }, ref: "trigger_mark" },
  limits: { maxUsd: 5000, maxLev: 5 },
  mode: "live",
  expires: "30d",
  ...over,
});

export const priceAbove = (coin: string, value: number): Condition => ({ price: { coin, op: ">", value } });
