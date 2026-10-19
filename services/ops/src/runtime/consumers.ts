// Queue handlers (Backend §8). Each takes the parsed pgmq message; throwing means "retry".
import { REVEAL_KIND, thesisSealAbi, type RevealKind } from "@proviso/chain";
import { activity, reveals, theses, type Db } from "@proviso/db";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { isHex, toHex, type Address, type Hex } from "viem";
import { FinalRelayError, relayStamp } from "../stamper";
import type { StampKind } from "../stamps/leaf";
import { appendLeaf, postHourRoot, type PostFn } from "../stamps/store";
import { findEventTx, revertName, send, type Clients } from "./chain";

export const UNREVEALED_FLAG = "unrevealed_after_expiry";
export const RETIRE_REVEAL_MS = 24 * 3_600_000;

export type StampMsg = { id: string };
export const stampHandler =
  (db: Db, c: Clients, thesisSeal: Address, log = console.error) =>
  async ({ id }: StampMsg) => {
    try {
      await relayStamp(db, { public: c.public, wallet: c.wallet, address: thesisSeal }, id);
    } catch (e) {
      if (!(e instanceof FinalRelayError)) throw e;
      log(`ops: stamp ${id} rejected for good (${e.message})`); // status=failed is already recorded
    }
  };

export type RevealMsg = { thesisId: string | number; part: "entry" | "exit"; kind?: RevealKind; canonical: string; salt: Hex };

/** Publishes a part on ThesisSeal and records it. Re-delivery and AlreadyRevealed are both success. */
export const revealHandler = (db: Db, c: Clients, thesisSeal: Address) => async (m: RevealMsg) => {
  if (m.part === "entry" && !(m.kind && m.kind in REVEAL_KIND)) throw new Error(`Entry reveal needs a kind, got ${m.kind}`);
  const id = BigInt(m.thesisId);
  const [row] = await db.select().from(reveals).where(and(eq(reveals.thesisId, id), eq(reveals.part, m.part)));
  if (row?.revealedAt) return;
  const [thesis] = await db.select({ owner: theses.owner }).from(theses).where(eq(theses.id, id));
  if (!thesis) throw new Error(`Unknown thesis ${id}`);
  const canonical = isHex(m.canonical) ? m.canonical : toHex(m.canonical); // hex bytes or the JSON text itself

  let done: { hash: Hex | null; at: Date };
  try {
    done =
      m.part === "entry"
        ? await send(c, { address: thesisSeal, abi: thesisSealAbi, functionName: "revealEntry", args: [id, canonical, m.salt, REVEAL_KIND[m.kind!]] })
        : await send(c, { address: thesisSeal, abi: thesisSealAbi, functionName: "revealExit", args: [id, canonical, m.salt] });
  } catch (e) {
    if (revertName(e) !== "AlreadyRevealed") throw e;
    const eventName = m.part === "entry" ? "EntryRevealed" : "ExitRevealed";
    const prev = await findEventTx(c, { address: thesisSeal, abi: thesisSealAbi, eventName, args: { id } });
    done = prev ?? { hash: null, at: new Date() }; // revealed on-chain, log not found: tx stays unknown
  }

  const kind = m.part === "entry" ? m.kind! : null;
  await db.transaction(async (tx) => {
    await tx
      .insert(reveals)
      .values({ thesisId: id, part: m.part, kind, dueAt: done.at, revealedAt: done.at, tx: done.hash })
      .onConflictDoUpdate({ target: [reveals.thesisId, reveals.part], set: { kind, revealedAt: done.at, tx: done.hash } });
    await tx.insert(activity).values({
      address: thesis.owner,
      kind: "revealed",
      payload: { thesisId: String(id), part: m.part, kind, tx: done.hash },
    });
  });
};

export type StampLeafMsg = { thesisId: string | number; kind: StampKind; data: unknown; at: string };
export const stampLeafHandler = (db: Db) => async (m: StampLeafMsg) => {
  await appendLeaf(db, { thesisId: BigInt(m.thesisId), kind: m.kind, data: m.data, at: new Date(m.at) });
};

export type StampRootMsg = { hour_start: string | number }; // ISO time or unix seconds
export const stampRootHandler = (db: Db, post: PostFn) => async (m: StampRootMsg) => {
  const hourStart = new Date(typeof m.hour_start === "number" ? m.hour_start * 1000 : m.hour_start);
  await postHourRoot({ db, hourStart, post });
};

/**
 * Reveal deadlines. Retired ideas still due at expiry get retired_at + 24 h; any entry still
 * unrevealed past its due time flags the thesis once and tells the owner.
 */
export async function sweep(db: Db, now = new Date()) {
  await db
    .update(reveals)
    .set({ dueAt: sql`${theses.retiredAt} + interval '24 hours'` })
    .from(theses)
    .where(
      and(
        eq(reveals.thesisId, theses.id),
        eq(reveals.part, "entry"),
        isNull(reveals.revealedAt),
        sql`${theses.retiredAt} is not null`,
        eq(reveals.dueAt, theses.expiresAt),
      ),
    );
  const overdue = await db
    .select({ id: theses.id })
    .from(reveals)
    .innerJoin(theses, eq(reveals.thesisId, theses.id))
    .where(
      and(
        eq(reveals.part, "entry"),
        isNull(reveals.revealedAt),
        lt(reveals.dueAt, now),
        sql`not (${UNREVEALED_FLAG} = any(${theses.flags}))`,
      ),
    );
  const flagged: bigint[] = [];
  for (const { id } of overdue) {
    await db.transaction(async (tx) => {
      // The flag check in the WHERE makes this once-only even if two sweeps overlap.
      const [t] = await tx
        .update(theses)
        .set({ flags: sql`array_append(${theses.flags}, ${UNREVEALED_FLAG})` })
        .where(and(eq(theses.id, id), sql`not (${UNREVEALED_FLAG} = any(${theses.flags}))`))
        .returning({ owner: theses.owner });
      if (!t) return;
      await tx.insert(activity).values({ address: t.owner, kind: UNREVEALED_FLAG, payload: { thesisId: String(id) } });
      flagged.push(id);
    });
  }
  return flagged;
}
export const sweepHandler = (db: Db) => async () => {
  await sweep(db);
};
