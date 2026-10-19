// ops CVM (Phala TDX): stamper, stamps, shares, routes, tester, notify, Telegram, X poller.
// B0 runs the market-data recorder so the tester has 90 days of history by B8.
import { createDb, fearGreed, marketSnapshots } from "@proviso/db";
import { lt, sql } from "drizzle-orm";
import { fetchMetaAndCtxs, fngRows, FNG_URL, snapshotRows, type FngResponse } from "./recorder";

const db = createDb();
const SNAPSHOT_MS = Number(process.env.SNAPSHOT_INTERVAL_MS ?? 60_000);
const RETAIN_DAYS = 100; // tester needs 90

async function recordSnapshot() {
  const now = new Date();
  now.setMilliseconds(0);
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
function every(ms: number, name: string, job: () => Promise<unknown>) {
  const run = () => job().catch((e) => console.error(`ops: ${name} failed`, e));
  run();
  setInterval(run, ms);
}

every(SNAPSHOT_MS, "hl snapshot", recordSnapshot);
every(15 * 60_000, "fear & greed", recordFearGreed);
every(24 * 3_600_000, "prune", prune);
console.log(`ops: recorder running, HL snapshot every ${SNAPSHOT_MS / 1000}s`);
