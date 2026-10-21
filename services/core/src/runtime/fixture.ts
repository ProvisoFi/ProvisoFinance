// Test fixtures for the runtime (not used at runtime): a PGlite db with a sealed thesis.
import { x25519 } from "@noble/curves/ed25519.js";
import { newSalt, splitCommitments, type SpecInput } from "@proviso/dsl";
import { theses, users, type Db } from "@proviso/db";
import { createTestDb } from "@proviso/db/testing";
import { sealSpec } from "@proviso/seal";
import { priceAbove, spec } from "../evaluator/testkit.ts";
import type { Queue } from "./ports.ts";

export const OWNER = "0x00000000000000000000000000000000000000aa";

export async function setup() {
  const db = await createTestDb();
  const priv = x25519.utils.randomSecretKey();
  const pub = x25519.getPublicKey(priv);
  await db.insert(users).values({ address: OWNER });
  return { db, priv, pub };
}

export type Sealed = { id: bigint; saltE: `0x${string}`; saltX: `0x${string}`; spec: SpecInput };

/** Inserts a thesis sealed to `pub`; `tamper` corrupts the stored exit hash; `payload` overrides sealed fields. */
export async function insertThesis(
  db: Db,
  pub: Uint8Array,
  id: bigint,
  o: { spec?: SpecInput; state?: string; tamper?: boolean; garbage?: boolean; stampedAt?: Date; payload?: object } = {},
): Promise<Sealed> {
  const s = o.spec ?? spec(priceAbove("BTC", 100));
  const saltE = newSalt();
  const saltX = newSalt();
  const c = splitCommitments(s, { owner: OWNER, saltE, saltX });
  const stampedAt = o.stampedAt ?? new Date("2026-10-19T00:00:00Z");
  await db.insert(theses).values({
    id,
    owner: OWNER,
    encSpec: o.garbage ? new Uint8Array(120).fill(7) : sealSpec(pub, { v: 1, purpose: "thesis", owner: OWNER, spec: s, saltE, saltX, ...o.payload }),
    entryHash: c.entryHash,
    exitHash: o.tamper ? `0x${"0".repeat(64)}` : c.exitHash,
    mode: "live",
    signedAt: stampedAt,
    stampedAt,
    sealTx: "0x01",
    expiresAt: new Date(stampedAt.getTime() + 7 * 86_400_000),
    state: o.state ?? "live",
  });
  return { id, saltE, saltX, spec: s };
}

/** Records queue sends instead of calling pgmq (PGlite has no pgmq). */
export function recorder() {
  const sent: { queue: string; msg: any }[] = [];
  const inbox = new Map<string, { msgId: bigint; readCt: number; message: unknown }[]>();
  const deleted: { queue: string; msgId: bigint }[] = [];
  const queue: Queue = {
    async send(queue, msg) {
      sent.push({ queue, msg: JSON.parse(JSON.stringify(msg)) });
    },
    async read<T>(q: string) {
      return (inbox.get(q) ?? []) as { msgId: bigint; readCt: number; message: T }[];
    },
    async delete(q, msgId) {
      deleted.push({ queue: q, msgId });
      inbox.set(q, (inbox.get(q) ?? []).filter((m) => m.msgId !== msgId));
    },
  };
  return { queue, sent, inbox, deleted };
}
