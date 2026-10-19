import { fires, orders, reveals, stamps, theses } from "@proviso/db";
import { sequenceGaps } from "@proviso/ops/stamps/leaf";
import { getProof } from "@proviso/ops/stamps/store";
import { TRPCError } from "@trpc/server";
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { publicProcedure, router } from "../trpc";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((a) => a.toLowerCase());

// Public record of a caller: built from stamps and reveals only. Sealed-but-unfired,
// expired and retired ideas are listed too; missing reveals and sequence gaps stay visible.
export const recordsRouter = router({
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
    const ids = rows.map((r) => r.id);
    if (!ids.length) return { caller: input.caller, ideas: [] };

    const [rev, fireRows, seqRows, sizes] = await Promise.all([
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
    ]);

    const now = Date.now();
    return {
      caller: input.caller,
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
          sequenceGaps: sequenceGaps(seqs),
          callerToFollowerRatio: caller > 0 ? size("follower") / caller : null,
        };
      }),
    };
  }),

  proof: publicProcedure
    .input(z.object({ thesisId: z.string().regex(/^\d+$/), seq: z.int().min(1) }))
    .query(async ({ ctx, input }) => {
      const p = await getProof(ctx.db, BigInt(input.thesisId), input.seq);
      if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "No stamp with that sequence number yet." });
      return p;
    }),
});
