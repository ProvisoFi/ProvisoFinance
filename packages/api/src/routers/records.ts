import { fires, orders, reveals, stamps, theses, users } from "@proviso/db";
import { sequenceGaps } from "@proviso/ops/stamps/leaf";
import { getProof } from "@proviso/ops/stamps/store";
import { TRPCError } from "@trpc/server";
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { publicProcedure, router } from "../trpc";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((a) => a.toLowerCase());

/**
 * Public record of a caller: built from stamps and reveals only. Sealed-but-unfired,
 * expired and retired ideas are listed too; missing reveals and sequence gaps stay visible.
 */
export const recordsRouter = router({
  /** Public: a caller's latest 500 ideas with fires, reveal status (overdue flagged), stamp count, sequence gaps, P&L stamp total and follower/caller size ratio. */
  get: publicProcedure.input(z.object({ caller: address })).query(async ({ ctx, input }) => {
    const rows = await ctx.db
      .select({
        id: theses.id,
        mode: theses.mode,
        state: theses.state,
        flags: theses.flags,
        entryHash: theses.entryHash,
        exitHash: theses.exitHash,
        signedAt: theses.signedAt,
        stampedAt: theses.stampedAt,
        expiresAt: theses.expiresAt,
        retiredAt: theses.retiredAt,
        sealTx: theses.sealTx,
      })
      .from(theses)
      .where(eq(theses.owner, input.caller))
      .orderBy(desc(theses.stampedAt))
      .limit(500);
    const [who] = await ctx.db.select({ name: users.displayName }).from(users).where(eq(users.address, input.caller));
    const displayName = who?.name ?? null;
    const ids = rows.map((r) => r.id);
    if (!ids.length) return { caller: input.caller, displayName, ideas: [] };

    const [rev, fireRows, seqRows, sizes, pnlRows] = await Promise.all([
      ctx.db.select().from(reveals).where(inArray(reveals.thesisId, ids)),
      ctx.db.select().from(fires).where(inArray(fires.thesisId, ids)).orderBy(asc(fires.firedAt)),
      ctx.db.select({ thesisId: stamps.thesisId, seq: stamps.seq }).from(stamps).where(inArray(stamps.thesisId, ids)),
      ctx.db
        .select({
          thesisId: orders.thesisId,
          role: orders.role,
          notional: sql<string>`coalesce(sum(${orders.filledSize} * ${orders.avgPx}), 0)`,
        })
        .from(orders)
        .where(inArray(orders.thesisId, ids))
        .groupBy(orders.thesisId, orders.role),
      ctx.db.select({ thesisId: stamps.thesisId, data: stamps.data }).from(stamps).where(sql`${stamps.kind} = 'PNL' and ${inArray(stamps.thesisId, ids)}`),
    ]);

    const now = Date.now();
    /** Sum of the idea's PNL stamps (USD); null before it has one. */
    const pnlOf = (id: bigint) => {
      const mine = pnlRows.filter((p) => p.thesisId === id);
      if (!mine.length) return null;
      return mine.reduce((sum, p) => {
        const v = Number((p.data as { pnlUsd?: unknown }).pnlUsd);
        return Number.isFinite(v) ? sum + v : sum;
      }, 0);
    };
    return {
      caller: input.caller,
      displayName,
      ideas: rows.map((r) => {
        const entry = rev.find((x) => x.thesisId === r.id && x.part === "entry");
        const exit = rev.find((x) => x.thesisId === r.id && x.part === "exit");
        const seqs = seqRows.filter((s) => s.thesisId === r.id).map((s) => s.seq);
        const size = (role: string) => Number(sizes.find((s) => s.thesisId === r.id && s.role === role)?.notional ?? 0);
        const caller = size("caller");
        return {
          ...r,
          id: String(r.id),
          fires: fireRows.filter((f) => f.thesisId === r.id).map((f) => ({ at: f.firedAt, refMark: f.refMark, flags: f.flags })),
          entryReveal: entry
            ? { kind: entry.kind, dueAt: entry.dueAt, revealedAt: entry.revealedAt, tx: entry.tx, overdue: !entry.revealedAt && entry.dueAt.getTime() < now }
            : null,
          exitReveal: exit ? { revealedAt: exit.revealedAt, tx: exit.tx } : null,
          stampCount: seqs.length,
          pnlUsd: pnlOf(r.id),
          sequenceGaps: sequenceGaps(seqs),
          callerToFollowerRatio: caller > 0 ? size("follower") / caller : null,
        };
      }),
    };
  }),

  /**
   * Public: one call's share-card facts (TU-13). Public fields only: owner, mode, state, seal and
   * expiry times, the seal tx, fires (time and reference mark), the reveal kind, and the P&L stamp.
   * Never the sealed levels. NOT_FOUND for an unknown id.
   */
  byId: publicProcedure.input(z.object({ id: z.string().regex(/^\d{1,30}$/) })).query(async ({ ctx, input }) => {
    const id = BigInt(input.id);
    const [t] = await ctx.db
      .select({
        id: theses.id,
        owner: theses.owner,
        mode: theses.mode,
        state: theses.state,
        stampedAt: theses.stampedAt,
        expiresAt: theses.expiresAt,
        sealTx: theses.sealTx,
      })
      .from(theses)
      .where(eq(theses.id, id));
    if (!t) throw new TRPCError({ code: "NOT_FOUND" });
    const [who] = await ctx.db.select({ name: users.displayName }).from(users).where(eq(users.address, t.owner));
    const [rev, fireRows, pnlRows] = await Promise.all([
      ctx.db.select().from(reveals).where(eq(reveals.thesisId, id)),
      ctx.db.select().from(fires).where(eq(fires.thesisId, id)).orderBy(asc(fires.firedAt)),
      ctx.db.select({ data: stamps.data }).from(stamps).where(sql`${stamps.thesisId} = ${id} and ${stamps.kind} = 'PNL'`),
    ]);
    const entry = rev.find((r) => r.part === "entry");
    const pnl = pnlRows.reduce((sum, r) => {
      const v = Number((r.data as { pnlUsd?: unknown }).pnlUsd);
      return Number.isFinite(v) ? sum + v : sum;
    }, 0);
    return {
      ...t,
      id: String(t.id),
      ownerName: who?.name ?? null,
      fires: fireRows.map((f) => ({ at: f.firedAt, refMark: f.refMark })),
      revealKind: entry?.revealedAt ? entry.kind : null,
      revealTx: entry?.revealedAt ? entry.tx : null,
      pnlUsd: pnlRows.length ? pnl : null,
    };
  }),

  /** Public: the Merkle proof for stamp `seq` of an idea within its hour's tree (`tx` null until the root is posted); NOT_FOUND if no such stamp. */
  proof: publicProcedure
    .input(z.object({ thesisId: z.string().regex(/^\d+$/), seq: z.int().min(1) }))
    .query(async ({ ctx, input }) => {
      const p = await getProof(ctx.db, BigInt(input.thesisId), input.seq);
      if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "No stamp with that sequence number yet." });
      return p;
    }),
});
