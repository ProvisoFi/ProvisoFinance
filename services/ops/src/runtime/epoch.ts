// Caller-share epoch job (Backend §8): follower holds from the db → computeEpoch → epochs +
// caller_shares rows → CallerShare.postEpoch. Callable; not scheduled yet.
import { callerShares, epochs, linkFlags, orders, theses, type Db } from "@proviso/db";
import { eq } from "drizzle-orm";
import type { Hex } from "viem";
import { computeEpoch, type FollowerPosition } from "../shares/epoch";

/**
 * Follower positions on copied ideas, one per (follower account, thesis):
 *  - opened at the first filled non-reduce-only follower order, notional = Σ filled_size × avg_px
 *    of those orders (USD on both venues);
 *  - closed at the last filled reduce-only follower order, or still open if there is none;
 *  - caller = the thesis owner.
 * ponytail: one position per follower per idea and a full scan of follower orders; split by fire
 * and add a time-window filter when ideas re-fire or volume grows.
 */
export async function followerPositions(db: Db): Promise<FollowerPosition[]> {
  const rows = await db
    .select({
      follower: orders.account,
      caller: theses.owner,
      thesisId: orders.thesisId,
      reduceOnly: orders.reduceOnly,
      filled: orders.filledSize,
      px: orders.avgPx,
      createdAt: orders.createdAt,
      updatedAt: orders.updatedAt,
    })
    .from(orders)
    .innerJoin(theses, eq(orders.thesisId, theses.id))
    .where(eq(orders.role, "follower"));
  const byKey = new Map<string, FollowerPosition>();
  for (const r of rows) {
    if (!(Number(r.filled) > 0)) continue;
    const key = `${r.follower.toLowerCase()}:${r.thesisId}`;
    const p = byKey.get(key) ?? { caller: r.caller, follower: r.follower, notionalUsd: 0, openedAt: new Date(8.64e15), closedAt: null };
    if (r.reduceOnly) {
      if (!p.closedAt || r.updatedAt > p.closedAt) p.closedAt = r.updatedAt;
    } else {
      p.notionalUsd += Number(r.filled) * Number(r.px ?? 0);
      if (r.createdAt < p.openedAt) p.openedAt = r.createdAt;
    }
    byKey.set(key, p);
  }
  return [...byKey.values()].filter((p) => p.notionalUsd > 0); // close-only groups: no opening fill seen
}

export type EpochPost = (epoch: bigint, root: Hex, total: bigint) => Promise<Hex>;
export type EpochJob = {
  epoch: bigint;
  start: Date;
  end: Date;
  pool: bigint; // USDG base units
  cap: bigint;
  post: EpochPost; // CallerShare.postEpoch (see callerSharePost)
  excluded?: Iterable<string>; // geofenced addresses
};

/**
 * Computes and stores the epoch, then posts it. Idempotent: a posted epoch is returned as is; a
 * stored-but-unposted one is posted with its stored root and total (not recomputed).
 */
export async function runEpoch(db: Db, job: EpochJob) {
  let [row] = await db.select().from(epochs).where(eq(epochs.epoch, job.epoch));
  if (row?.tx) return { status: "already-posted" as const, root: row.root as Hex, total: BigInt(row.totalUsdg), tx: row.tx as Hex };
  if (!row) {
    const result = computeEpoch({
      positions: await followerPositions(db),
      linkFlags: await db.select({ a: linkFlags.a, b: linkFlags.b }).from(linkFlags),
      excluded: job.excluded ?? [],
      pool: job.pool,
      cap: job.cap,
      start: job.start,
      end: job.end,
    });
    if (!result.root) return { status: "empty" as const };
    const root = result.root;
    [row] = await db.transaction(async (tx) => {
      const inserted = await tx.insert(epochs).values({ epoch: job.epoch, root, totalUsdg: result.total.toString() }).returning();
      await tx.insert(callerShares).values(
        result.allocations.map((a) => ({ epoch: job.epoch, caller: a.caller, amountUsdg: a.amount.toString(), proof: a.proof })),
      );
      return inserted;
    });
  }
  const root = row!.root as Hex;
  const total = BigInt(row!.totalUsdg);
  const tx = await job.post(job.epoch, root, total);
  await db.update(epochs).set({ tx, postedAt: new Date() }).where(eq(epochs.epoch, job.epoch));
  return { status: "posted" as const, root, total, tx };
}
