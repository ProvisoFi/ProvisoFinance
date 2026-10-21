// Caller-share epoch job (Backend §8): follower holds from the db → computeEpoch → epochs +
// caller_shares rows → CallerShare.postEpoch. Before computing, copies are closed from Hyperliquid
// fills and the link heuristics (core/faircopy/links.ts) write link_flags.
import { callerShares, epochs, linkFlags, orders, theses, type Db } from "@proviso/db";
import type { Fill as HlFill, InfoClient } from "@proviso/hl";
import { eq, gte, isNotNull, sql } from "drizzle-orm";
import type { Hex } from "viem";
// Pure, dependency-free heuristics shared with core (the image ships the whole repo).
import { EXCLUDE_SCORE, linkFlags as detectLinks, type LinkFlag, type Transfer } from "../../../core/src/faircopy/links.ts";
import { computeEpoch, type FollowerPosition } from "../shares/epoch";

export type VenuePosition = FollowerPosition & { coin: string; venue: string; long: boolean };

/**
 * Follower positions on copied ideas, one per (follower account, thesis):
 *  - opened at the first filled non-reduce-only follower order, notional = Σ filled_size × avg_px
 *    of those orders (USD on both venues);
 *  - closed at the last filled reduce-only follower order, or still open if there is none
 *    (scanVenue then closes hl copies from the follower's fills);
 *  - caller = the thesis owner.
 * ponytail: one position per follower per idea and a full scan of follower orders; split by fire
 * and add a time-window filter when ideas re-fire or volume grows.
 */
export async function followerPositions(db: Db): Promise<VenuePosition[]> {
  const rows = await db
    .select({
      follower: orders.account,
      caller: theses.owner,
      thesisId: orders.thesisId,
      coin: orders.coin,
      venue: orders.venue,
      side: orders.side,
      reduceOnly: orders.reduceOnly,
      filled: orders.filledSize,
      px: orders.avgPx,
      createdAt: orders.createdAt,
      updatedAt: orders.updatedAt,
    })
    .from(orders)
    .innerJoin(theses, eq(orders.thesisId, theses.id))
    .where(eq(orders.role, "follower"));
  const byKey = new Map<string, VenuePosition>();
  for (const r of rows) {
    if (!(Number(r.filled) > 0)) continue;
    const key = `${r.follower.toLowerCase()}:${r.thesisId}`;
    const p = byKey.get(key) ?? {
      caller: r.caller,
      follower: r.follower,
      notionalUsd: 0,
      openedAt: new Date(8.64e15),
      closedAt: null,
      coin: r.coin,
      venue: r.venue,
      long: false,
    };
    if (r.reduceOnly) {
      if (!p.closedAt || r.updatedAt > p.closedAt) p.closedAt = r.updatedAt;
    } else {
      p.notionalUsd += Number(r.filled) * Number(r.px ?? 0);
      p.long = r.side === "long" || r.side === "buy";
      if (r.createdAt < p.openedAt) p.openedAt = r.createdAt;
    }
    byKey.set(key, p);
  }
  return [...byKey.values()].filter((p) => p.notionalUsd > 0); // close-only groups: no opening fill seen
}

type InfoPort = Pick<InfoClient, "post">;
type LedgerUpdate = { time: number; delta: Record<string, unknown> };
const lc = (a: string) => a.toLowerCase();

/** Account-to-account moves in a Hyperliquid ledger (deposits and withdrawals have no counterparty). */
const transfersOf = (ledger: LedgerUpdate[]): Transfer[] =>
  ledger.flatMap(({ time, delta: d }) =>
    typeof d.user === "string" && typeof d.destination === "string"
      ? [{ from: d.user, to: d.destination, usd: Number(d.usdcValue ?? d.usdc ?? d.amount ?? 0), time }]
      : [],
  );

/**
 * An hl copy is closed at the first fill (from any source: Proviso, the backstop, a liquidation,
 * or the follower closing straight on Hyperliquid) that leaves the follower flat or flipped on
 * that coin. Without this a copy closed off-platform would count as held forever.
 */
function closeFromFills(p: VenuePosition, fills: HlFill[]) {
  if (p.venue !== "hl") return;
  const dir = p.long ? 1 : -1;
  for (const f of fills) {
    if (f.coin !== p.coin || f.time < p.openedAt.getTime()) continue;
    const after = Number(f.startPosition) + (f.side === "B" ? 1 : -1) * Number(f.sz);
    if (dir * after > 0) continue;
    if (!p.closedAt || f.time < p.closedAt.getTime()) p.closedAt = new Date(f.time);
    return;
  }
}

/**
 * Reads every caller's and follower's Hyperliquid fills and ledger, closes copies from those fills,
 * runs the link heuristics over the (caller, follower) pairs and upserts link_flags (highest score
 * per pair). A failed read throws, so an epoch is never posted without this scan.
 * ponytail: one userFillsByTime page (2000 fills) per account; page it when accounts trade more.
 */
export async function scanVenue(db: Db, info: InfoPort, positions: VenuePosition[], end: Date, ignoreFunders: string[] = []) {
  const from = new Map<string, number>();
  for (const p of positions)
    for (const a of [lc(p.caller), lc(p.follower)]) from.set(a, Math.min(from.get(a) ?? Infinity, p.openedAt.getTime()));
  const fills = new Map<string, HlFill[]>();
  const transfers: Transfer[] = [];
  for (const [user, startTime] of from) {
    const f = await info.post<HlFill[]>({ type: "userFillsByTime", user, startTime, endTime: end.getTime() });
    fills.set(user, [...f].sort((x, y) => x.time - y.time));
    const ledger = await info.post<LedgerUpdate[]>({ type: "userNonFundingLedgerUpdates", user, startTime: 0, endTime: end.getTime() });
    transfers.push(...transfersOf(ledger));
  }
  for (const p of positions) closeFromFills(p, fills.get(lc(p.follower)) ?? []);

  // Proviso's own copies precede the caller by design; the timing heuristic skips them.
  const ours = new Set((await db.select({ c: orders.cloid }).from(orders).where(isNotNull(orders.cloid))).map((r) => lc(r.c!)));
  const linkFills = [...fills].flatMap(([account, fs]) =>
    fs.map((f) => ({ account, coin: f.coin, isBuy: f.side === "B", time: f.time, viaProviso: !!f.cloid && ours.has(lc(f.cloid)) })),
  );
  const pairs = [...new Map(positions.map((p) => [`${lc(p.caller)}:${lc(p.follower)}`, { caller: p.caller, follower: p.follower }])).values()];
  const best = new Map<string, LinkFlag>();
  for (const f of detectLinks(transfers, linkFills, pairs, { ignoreFunders })) {
    const prev = best.get(`${f.a}:${f.b}`);
    if (!prev || f.score > prev.score) best.set(`${f.a}:${f.b}`, f);
  }
  for (const f of best.values())
    await db
      .insert(linkFlags)
      .values({ a: f.a, b: f.b, reason: f.reason, score: String(f.score) })
      .onConflictDoUpdate({
        target: [linkFlags.a, linkFlags.b],
        set: { reason: f.reason, score: String(f.score) },
        setWhere: sql`${linkFlags.score} < ${String(f.score)}::numeric`,
      });
}

export type EpochPost = (epoch: bigint, root: Hex, total: bigint) => Promise<Hex>;
export type EpochJob = {
  epoch: bigint;
  start: Date;
  end: Date;
  pool: bigint; // USDG base units
  cap: bigint;
  post: EpochPost; // CallerShare.postEpoch (see callerSharePost)
  info: InfoPort; // Hyperliquid reads for venue closes and link detection
  excluded?: Iterable<string>; // geofenced addresses
  ignoreFunders?: string[]; // bridges and exchange hot wallets, for the shared-funder heuristic
};

/**
 * Computes and stores the epoch, then posts it. Idempotent: a posted epoch is returned as is; a
 * stored-but-unposted one is posted with its stored root and total (not recomputed).
 */
export async function runEpoch(db: Db, job: EpochJob) {
  let [row] = await db.select().from(epochs).where(eq(epochs.epoch, job.epoch));
  if (row?.tx) return { status: "already-posted" as const, root: row.root as Hex, total: BigInt(row.totalUsdg), tx: row.tx as Hex };
  if (!row) {
    const positions = await followerPositions(db);
    await scanVenue(db, job.info, positions, job.end, job.ignoreFunders);
    const result = computeEpoch({
      positions,
      linkFlags: await db.select({ a: linkFlags.a, b: linkFlags.b }).from(linkFlags).where(gte(linkFlags.score, String(EXCLUDE_SCORE))),
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
