// Dry Run: try a rule before trusting it. No wallet, key or deposit. The rule replays over the last
// 90 days of Hyperliquid's own hourly history (candles + funding, fetched live, so every market
// works, stocks and oil included), then "now" checks it against live prices. The same evaluator and
// replay as core; fill model paper-v1 on hourly candles.
import { CORE_CAPABILITIES, Spec, validate, type SpecInput, type ValidationError } from "@proviso/dsl";
import { InfoClient } from "@proviso/hl";
import { config, evalCondition, UNKNOWN } from "../../../services/core/src/evaluator/conditions.ts";
import { MemoryMarketView, type Update } from "../../../services/core/src/evaluator/state.ts";
import { paperFeeRate } from "../../../services/core/src/paper/engine.ts";
import { replay, type Frame } from "../../../services/core/src/tester/replay.ts";
import { floorsFor, perps } from "./routers/market";

export const DRY_RUN_DAYS = 90;
const HOUR = 3_600_000;
export const DRY_RUN_MAX_LEV = 5;
/** Dry Run re-arms a rule a day after each fire, so 90 days show how often it would have traded. */
const REARM = "24h";
/** Fees per fill in bps, the same as Proviso Paper: venue taker (HIP-3 growth mode) plus Proviso's 0.05%. */
export const takerFeeBps = (coin: string) => paperFeeRate(coin) * 10_000;

type Candle = { t: number; c: string; v: string; h: string; l: string };
type FundingRow = { time: number; fundingRate: string };
export type Hourly = { t: number; close: number; high: number; low: number; volumeUsd: number; funding?: number };

const cache = new Map<string, { at: number; rows: Hourly[] }>();

/** The last `days` of hourly closes, volumes and funding for `coin`, from Hyperliquid (cached 10 minutes). */
export async function hourly(coin: string, info: Pick<InfoClient, "post"> = new InfoClient(), days = DRY_RUN_DAYS, now = Date.now()): Promise<Hourly[]> {
  const hit = cache.get(coin);
  if (hit && now - hit.at < 600_000) return hit.rows;
  const start = now - days * 24 * HOUR;
  const candles = await info.post<Candle[]>({ type: "candleSnapshot", req: { coin, interval: "1h", startTime: start, endTime: now } });
  const funding: FundingRow[] = [];
  for (let from = start, i = 0; i < 8; i++) {
    const page = await info.post<FundingRow[]>({ type: "fundingHistory", coin, startTime: from });
    funding.push(...page);
    if (page.length < 500) break;
    from = page.at(-1)!.time + 1;
  }
  let f = 0;
  const rows = candles.map((c) => {
    const t = c.t + HOUR; // a candle is known once it closes
    while (f < funding.length && funding[f]!.time <= t) f++;
    const rate = f > 0 ? Number(funding[f - 1]!.fundingRate) : undefined;
    return { t, close: Number(c.c), high: Number(c.h), low: Number(c.l), volumeUsd: Number(c.v) * Number(c.c), funding: rate };
  });
  cache.set(coin, { at: now, rows });
  return rows;
}

/** Hourly history as evaluator updates: close as mark and oracle, rolling 24h notional volume, funding in %/h. */
export function hourlyUpdates(coin: string, rows: readonly Hourly[]): Update[] {
  let vol = 0;
  return rows.map((r, i) => {
    vol += r.volumeUsd - (i >= 24 ? rows[i - 24]!.volumeUsd : 0);
    return { src: "hl", coin, at: r.t, mark: r.close, oracle: r.close, volume24h: vol, ...(r.funding !== undefined && { funding: r.funding * 100 }) };
  });
}

/** Frames for every coin the rule reads or trades, merged on the hourly grid. */
export function framesOf(series: Map<string, Hourly[]>): Frame[] {
  const at = new Map<number, Update[]>();
  for (const [coin, rows] of series) for (const u of hourlyUpdates(coin, rows)) at.set(u.at, [...(at.get(u.at) ?? []), u]);
  return [...at.entries()].sort((a, b) => a[0] - b[0]).map(([t, updates]) => ({ t, updates }));
}

/** Coins a rule needs data for: its Hyperliquid actions and every coin its conditions read. */
export function coinsOf(spec: Spec): string[] {
  const out = new Set<string>();
  for (const a of spec.entry.then) if (a.venue === "hl") out.add(a.coin);
  const walk = (c: unknown) => {
    if (!c || typeof c !== "object") return;
    for (const v of Object.values(c as Record<string, unknown>)) {
      if (v && typeof v === "object" && "coin" in v && typeof (v as { coin: unknown }).coin === "string") out.add((v as { coin: string }).coin);
      else if (Array.isArray(v)) v.forEach(walk);
      else walk(v);
    }
  };
  walk(spec.entry.when);
  return [...out];
}

/** The rule as Dry Run runs it: paper, re-armed daily, leverage capped at 5x (pre-IPO 2x). */
export function dryRunSpec(input: SpecInput): Spec {
  const s = Spec.parse(input);
  return Spec.parse({ ...s, mode: "paper", fire: "repeat", cooldown: REARM, expires: "30d" });
}

export type DryRunResult = {
  days: number;
  fires: number;
  trades: number;
  sizeUsd: number;
  returnPct: number;
  maxDrawdownPct: number;
  /** returnPct / max(maxDrawdownPct, 5): the leaderboard's score. */
  score: number;
  feesUsd: number;
  /** Funding received (+) or paid (−) over all trades. */
  fundingUsd: number;
  winRate: number | null;
  /** Cumulative realized return (%) after each closed trade, for the result card's line. */
  curve: { t: number; returnPct: number }[];
  lastFires: { at: number; coin: string; mark: number }[];
  /** Inputs Dry Run has no history for (they never fire in the replay). */
  noData: string[];
  fillModel: string;
};

/** Validates for Dry Run: real, liquid perps; up to 5x (the validator holds pre-IPO to 2x); swaps aren't simulated. */
export async function checkDryRun(spec: Spec, market = perps()): Promise<ValidationError[]> {
  const hl = Object.fromEntries((await market).map((p) => [p.coin, { maxLeverage: p.maxLeverage, volume24hUsd: p.volume24hUsd }]));
  const r = validate(spec, { hl, user: { maxUsd: 100_000, maxLev: DRY_RUN_MAX_LEV }, floors: floorsFor(process.env.HL_NETWORK ?? "mainnet"), capabilities: CORE_CAPABILITIES });
  return r.ok ? [] : r.errors;
}

/** Replays `spec` over the last 90 days of `series` (see dryRunSpec). Deterministic for the same data. */
export function dryRun(spec: Spec, series: Map<string, Hourly[]>): DryRunResult {
  const frames = framesOf(series);
  if (frames.length < 25) throw new Error("Not enough history for this market yet");
  const first = spec.entry.then.find((a) => a.venue === "hl");
  const sizeUsd = spec.entry.then.reduce((s, a) => s + ("size" in a ? a.size.usd : 0), 0) || 1;
  const start = frames[0]!.t + 24 * HOUR; // the first day only warms up 24h changes and volume
  const r = replay({
    spec,
    frames,
    stampedAt: start,
    horizonMs: frames.at(-1)!.t - start + 1,
    slippageBps: 0, // fills at the hourly close; fees below carry the cost
    feeBps: first && first.venue === "hl" ? takerFeeBps(first.coin) : 9.5,
    funding: true,
    config: config({ historyToleranceMs: HOUR }),
    view: { historyResolutionMs: HOUR, historyCapacity: 24 * (DRY_RUN_DAYS + 5) },
  });
  let cum = 0;
  const curve = [...r.trades].sort((a, b) => a.exitAt - b.exitAt).map((t) => ({ t: t.exitAt, returnPct: (cum += t.pnlUsd) / sizeUsd * 100 }));
  const wins = r.trades.filter((t) => t.pnlUsd > 0).length;
  const returnPct = (r.totalPnlUsd / sizeUsd) * 100;
  const maxDrawdownPct = (r.maxDrawdownUsd / sizeUsd) * 100;
  return {
    days: Math.round((frames.at(-1)!.t - start) / (24 * HOUR)),
    fires: r.fires.length,
    trades: r.trades.length,
    sizeUsd,
    returnPct,
    maxDrawdownPct,
    score: returnPct / Math.max(maxDrawdownPct, 5),
    feesUsd: r.trades.reduce((s, t) => s + t.feesUsd, 0),
    fundingUsd: r.trades.reduce((s, t) => s + t.fundingUsd, 0),
    winRate: r.trades.length ? wins / r.trades.length : null,
    curve,
    lastFires: r.fires.slice(-5),
    noData: r.coverage.filter((c) => !c.supported).map((c) => c.input),
    fillModel: "paper-v1 replay: hourly Hyperliquid closes, taker + Proviso fees, hourly funding",
  };
}

/** Would the rule fire right now? The last day of history plus the live mark, funding and volume. */
export function dryRunNow(spec: Spec, series: Map<string, Hourly[]>, live: { coin: string; mark: number; funding?: number; volume24hUsd?: number }[], now = Date.now()) {
  const view = new MemoryMarketView({ historyResolutionMs: HOUR, historyCapacity: 24 * 31 });
  for (const [coin, rows] of series) for (const u of hourlyUpdates(coin, rows.slice(-24 * 31))) view.apply(u);
  for (const l of live)
    view.apply({ src: "hl", coin: l.coin, at: now, mark: l.mark, oracle: l.mark, ...(l.volume24hUsd !== undefined && { volume24h: l.volume24hUsd }), ...(l.funding !== undefined && { funding: l.funding * 100 }) });
  const truth = evalCondition(spec.entry.when, view, now, new Map(), config({ historyToleranceMs: HOUR }));
  return { state: truth === UNKNOWN ? ("unknown" as const) : truth ? ("would_fire" as const) : ("waiting" as const), marks: Object.fromEntries(live.map((l) => [l.coin, l.mark])) };
}

/** 7-day high and low, last close and 24h move for a market (starter ideas fill their numbers from these). */
export function stats(rows: readonly Hourly[]) {
  const week = rows.slice(-24 * 7);
  const last = rows.at(-1);
  const prev = rows.at(-25);
  return {
    mark: last?.close ?? null,
    weekHigh: week.length ? Math.max(...week.map((r) => r.high)) : null,
    weekLow: week.length ? Math.min(...week.map((r) => r.low)) : null,
    change24hPct: last && prev ? ((last.close - prev.close) / prev.close) * 100 : null,
    days: Math.floor(rows.length / 24),
  };
}
