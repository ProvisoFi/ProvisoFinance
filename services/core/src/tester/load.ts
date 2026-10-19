// Builds replay frames from the recorded tables. Snapshot ids are content hashes of the rows
// actually loaded, so a test id pins the exact data it ran on.
import { canonicalize, durationMs } from "@proviso/dsl";
import { candles, fearGreed, marketSnapshots } from "@proviso/db/schema";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { Update } from "../evaluator/state.ts";
import type { Frame } from "./replay.ts";

export type SnapshotRow = typeof marketSnapshots.$inferSelect;
export type CandleRow = typeof candles.$inferSelect;
export type FearGreedRow = typeof fearGreed.$inferSelect;
export type LoadedRows = { snapshots: SnapshotRow[]; candles: CandleRow[]; fearGreed: FearGreedRow[] };
export type Loaded = { frames: Frame[]; snapshotIds: string[] };

const n = (s: string | null): number | undefined => {
  if (s === null) return undefined;
  const v = Number(s);
  return Number.isFinite(v) ? v : undefined;
};

/** sha256 hex of RFC 8785 JSON of { table, key, rows }, rows as stored (numerics stay strings). */
function contentId(table: string, key: string, rows: object[]): string {
  const norm = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.getTime() : v])));
  return bytesToHex(sha256(canonicalize({ table, key, rows: norm })));
}

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

/**
 * Pure conversion. Units follow the recorder (Hyperliquid metaAndAssetCtxs):
 * - funding is HL's hourly fraction -> percent/h (×100)
 * - oi is in coin units -> USD notional (× mark of the same row)
 * - a candle becomes a mark-only update at its close time (ts + interval), and only for minutes
 *   with no snapshot of that coin; with no oracle it never passes agreement on its own, so it
 *   extends the mark path (exits, change history) but cannot satisfy a price condition.
 */
export function framesFromRows(rows: LoadedRows): Loaded {
  const at = new Map<number, Update[]>();
  const push = (t: number, u: Update) => {
    const list = at.get(t);
    if (list) list.push(u);
    else at.set(t, [u]);
  };
  const snapMinutes = new Set<string>();
  for (const r of rows.snapshots) {
    const t = r.ts.getTime();
    const mark = n(r.mark);
    const oi = n(r.oi);
    const funding = n(r.funding);
    snapMinutes.add(`${r.coin}:${Math.floor(t / 60_000)}`);
    push(t, {
      src: "hl",
      coin: r.coin,
      at: t,
      mark,
      oracle: n(r.oracle),
      funding: funding === undefined ? undefined : funding * 100,
      oi: oi === undefined || mark === undefined ? undefined : oi * mark,
      volume24h: n(r.volume24h),
    });
  }
  for (const r of rows.candles) {
    const t = r.ts.getTime() + durationMs(r.interval);
    const mark = n(r.c);
    if (mark === undefined || snapMinutes.has(`${r.coin}:${Math.floor(t / 60_000)}`)) continue;
    push(t, { src: "hl", coin: r.coin, at: t, mark });
  }
  for (const r of rows.fearGreed) push(r.ts.getTime(), { src: "fg", at: r.ts.getTime(), value: r.value });

  const frames = [...at.entries()].sort((a, b) => a[0] - b[0]).map(([t, updates]) => ({ t, updates }));
  const ids = [
    ...[...groupBy(rows.snapshots, (r) => r.coin)].map(([coin, rs]) => contentId("market_snapshots", coin, rs)),
    ...[...groupBy(rows.candles, (r) => `${r.coin}/${r.interval}`)].map(([k, rs]) => contentId("candles", k, rs)),
    ...(rows.fearGreed.length ? [contentId("fear_greed", "", rows.fearGreed)] : []),
  ];
  return { frames, snapshotIds: ids.sort() };
}

// Any drizzle pg-core database (postgres-js, node-postgres, pglite).
type AnyPgDb = PgDatabase<PgQueryResultHKT, any, any>;

export type LoadOptions = {
  coins: string[];
  from: Date;
  to: Date;
  /** Candle interval to load as a mark-path fallback; null skips candles. Default "1m". */
  candleInterval?: string | null;
};

/**
 * Loads [from, to) for the coins. Fear & Greed starts one day early so the first frame already
 * has the current daily value. Rows are ordered so the content hashes are stable.
 */
export async function loadFrames(db: AnyPgDb, o: LoadOptions): Promise<Loaded> {
  const snapshots = await db
    .select()
    .from(marketSnapshots)
    .where(and(inArray(marketSnapshots.coin, o.coins), gte(marketSnapshots.ts, o.from), lt(marketSnapshots.ts, o.to)))
    .orderBy(asc(marketSnapshots.coin), asc(marketSnapshots.ts));
  const interval = o.candleInterval === undefined ? "1m" : o.candleInterval;
  const candleRows =
    interval === null
      ? []
      : await db
          .select()
          .from(candles)
          .where(and(inArray(candles.coin, o.coins), eq(candles.interval, interval), gte(candles.ts, o.from), lt(candles.ts, o.to)))
          .orderBy(asc(candles.coin), asc(candles.ts));
  const fg = await db
    .select()
    .from(fearGreed)
    .where(and(gte(fearGreed.ts, new Date(o.from.getTime() - 86_400_000)), lt(fearGreed.ts, o.to)))
    .orderBy(asc(fearGreed.ts));
  return framesFromRows({ snapshots, candles: candleRows, fearGreed: fg });
}
