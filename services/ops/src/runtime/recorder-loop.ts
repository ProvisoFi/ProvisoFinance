// B0 market-data recorder loop (moved from index.ts): HL snapshots, Fear & Greed, pruning.
import { fearGreed, marketSnapshots, type Db } from "@proviso/db";
import { lt, sql } from "drizzle-orm";
import { fetchMetaAndCtxs, fngRows, FNG_URL, snapshotRows, type FngResponse } from "../recorder";

const RETAIN_DAYS = 100; // tester needs 90

/** Starts the recorder jobs; returns a stop function. */
export function startRecorder(db: Db, snapshotMs = Number(process.env.SNAPSHOT_INTERVAL_MS ?? 60_000)) {
  async function recordSnapshot() {
    const now = new Date();
    now.setSeconds(0, 0); // minute buckets, matching the Supabase cron recorder
    const rows = snapshotRows(await fetchMetaAndCtxs(), now);
    if (rows.length) await db.insert(marketSnapshots).values(rows).onConflictDoNothing();
  }

  async function recordFearGreed() {
    const res = await fetch(FNG_URL);
    if (!res.ok) throw new Error(`Fear & Greed ${res.status}`);
    await db.insert(fearGreed).values(fngRows((await res.json()) as FngResponse)).onConflictDoNothing();
  }

  const prune = () =>
    db.delete(marketSnapshots).where(lt(marketSnapshots.ts, sql`now() - make_interval(days => ${RETAIN_DAYS})`));

  // One failing source must not stop the others; each logs and retries on its next tick.
  const timers: ReturnType<typeof setInterval>[] = [];
  function every(ms: number, name: string, job: () => Promise<unknown>) {
    const run = () => job().catch((e) => console.error(`ops: ${name} failed`, e));
    run();
    timers.push(setInterval(run, ms));
  }

  every(snapshotMs, "hl snapshot", recordSnapshot);
  every(15 * 60_000, "fear & greed", recordFearGreed);
  every(24 * 3_600_000, "prune", prune);
  console.log(`ops: recorder running, HL snapshot every ${snapshotMs / 1000}s`);
  return () => timers.forEach(clearInterval);
}
