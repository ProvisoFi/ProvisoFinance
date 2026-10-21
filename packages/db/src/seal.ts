import { and, eq, ne } from "drizzle-orm";
import type { Db } from "./index";
import { activity, reveals, stampRequests, theses } from "./schema";

type StoredStamp = { entryHash: string; exitHash: string; expiresAt: string; mode: "live" | "alert" };

/**
 * Records a mined ThesisSeal seal of a stamp request, relayed (ops) or sent by the owner (API):
 * the thesis row, its entry reveal due at expiry, the request sealed, and a "sealed" activity.
 * `stampedAt` is the seal block's timestamp. Returns false, changing nothing, when the request was
 * already sealed; a thesis already recorded through a duplicate request only links the request.
 */
export async function recordSeal(db: Db, req: typeof stampRequests.$inferSelect, seal: { id: bigint; tx: string; stampedAt: Date }) {
  const s = req.stamp as StoredStamp;
  const expiresAt = new Date(Number(s.expiresAt) * 1000);
  return db.transaction(async (tx) => {
    const [done] = await tx
      .update(stampRequests)
      .set({ status: "sealed", thesisId: seal.id, error: null })
      .where(and(eq(stampRequests.id, req.id), ne(stampRequests.status, "sealed")))
      .returning({ id: stampRequests.id });
    if (!done) return false;
    const [fresh] = await tx
      .insert(theses)
      .values({
        id: seal.id,
        owner: req.owner,
        encSpec: req.encSpec,
        entryHash: s.entryHash,
        exitHash: s.exitHash,
        mode: s.mode,
        signedAt: req.signedAt,
        stampedAt: seal.stampedAt,
        sealTx: seal.tx,
        expiresAt,
        state: s.mode,
      })
      .onConflictDoNothing()
      .returning({ id: theses.id });
    if (!fresh) return true;
    // The entry must be revealed by expiry at the latest (or within a minute of a fire).
    await tx.insert(reveals).values({ thesisId: seal.id, part: "entry", dueAt: expiresAt }).onConflictDoNothing();
    await tx.insert(activity).values({ address: req.owner, kind: "sealed", payload: { thesisId: String(seal.id), tx: seal.tx } });
    return true;
  });
}
