// Server side of evidence stamps: append leaves, post hourly roots, serve proofs.
import { stampRoots, stamps, type Db } from "@proviso/db";
import { canonicalize } from "@proviso/dsl";
import { and, asc, eq, max } from "drizzle-orm";
import { keccak256, type Hex } from "viem";
import { buildHourRoot, HOUR_MS, hourOf, KIND, leafHash, type LeafValues, type StampKind } from "./leaf";

export const dataHash = (data: unknown): Hex => keccak256(canonicalize(data));

export type StampRow = { leaf: Hex; thesisId: bigint; seq: number; kind: StampKind; data: unknown; hourStart: Date };
export type RootRow = { hourStart: Date; root: Hex; leafCount: number; tx: Hex | null; postedAt: Date | null };

export const leafValues = (r: Pick<StampRow, "thesisId" | "seq" | "kind" | "data">): LeafValues => [
  r.thesisId,
  r.seq,
  KIND[r.kind],
  dataHash(r.data),
];

/** Storage behind the stamp logic; drizzleStampStore is the real one, tests use a fake. */
export interface StampStore {
  maxSeq(thesisId: bigint): Promise<number | null>;
  /** Must reject with a Postgres unique violation (code 23505) when (thesisId, seq) exists. */
  insert(row: StampRow): Promise<void>;
  /** Ordered by (thesisId, seq). */
  leavesForHour(hourStart: Date): Promise<StampRow[]>;
  leaf(thesisId: bigint, seq: number): Promise<StampRow | null>;
  root(hourStart: Date): Promise<RootRow | null>;
  saveRoot(row: RootRow): Promise<void>;
  transaction<T>(fn: (s: StampStore) => Promise<T>): Promise<T>;
}

const isUniqueViolation = (e: unknown): boolean => {
  for (let c: any = e; c; c = c.cause) if (c.code === "23505") return true;
  return false;
};

export type AppendInput = { thesisId: bigint; kind: StampKind; data: unknown; at: Date; now?: Date };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Allocates the next per-thesis seq (starting at 1) and stores the leaf; retries on a seq race.
 * The leaf is filed under the hour it is inserted, not its event hour: a late leaf must never join
 * an hour whose root is already posted (roots go out at HH:05). The event time stays in the data.
 */
export async function appendLeafWith(store: StampStore, input: AppendInput, maxAttempts = 5): Promise<StampRow> {
  if (!(input.kind in KIND)) throw new Error(`Unknown stamp kind ${input.kind}`);
  const data = isPlainObject(input.data) && !("at" in input.data) ? { ...input.data, at: input.at.toISOString() } : input.data;
  for (let attempt = 1; ; attempt++) {
    try {
      return await store.transaction(async (s) => {
        const seq = ((await s.maxSeq(input.thesisId)) ?? 0) + 1;
        const base = { thesisId: input.thesisId, seq, kind: input.kind, data, hourStart: hourOf(input.now ?? new Date()) };
        const row = { ...base, leaf: leafHash(leafValues(base)) };
        await s.insert(row);
        return row;
      });
    } catch (e) {
      if (!isUniqueViolation(e) || attempt >= maxAttempts) throw e;
    }
  }
}

export type PostFn = (hourStartSec: bigint, root: Hex, leafCount: number) => Promise<Hex>;
export type PostResult =
  | { status: "posted" | "already-posted"; hourStart: Date; root: Hex; leafCount: number; tx: Hex }
  | { status: "empty"; hourStart: Date };

/**
 * Builds the hour's root and posts it once. A pending row (tx null) is saved before `post`, so a
 * crash after posting leaves a trace; `post` should treat StampRoots' AlreadyPosted as success.
 */
export async function postHourRootWith(
  store: StampStore,
  { hourStart, post, now = new Date() }: { hourStart: Date; post: PostFn; now?: Date },
): Promise<PostResult> {
  if (hourStart.getTime() % HOUR_MS) throw new Error("hourStart must be hour-aligned");
  if (hourStart.getTime() + HOUR_MS > now.getTime()) throw new Error("Hour is not over yet");
  const existing = await store.root(hourStart);
  if (existing?.tx) return { status: "already-posted", ...existing, tx: existing.tx };
  const leaves = await store.leavesForHour(hourStart);
  if (!leaves.length) return { status: "empty", hourStart };
  const { root, leafCount } = buildHourRoot(leaves.map(leafValues));
  await store.saveRoot({ hourStart, root, leafCount, tx: null, postedAt: null });
  const tx = await post(BigInt(hourStart.getTime() / 1000), root, leafCount);
  await store.saveRoot({ hourStart, root, leafCount, tx, postedAt: new Date() });
  return { status: "posted", hourStart, root, leafCount, tx };
}

export type ProofResponse = {
  thesisId: string;
  seq: number;
  kind: number;
  kindName: StampKind;
  data: unknown;
  dataHash: Hex;
  leafHash: Hex;
  proof: Hex[];
  root: Hex;
  hourStart: number; // unix seconds, the StampRoots key
  leafCount: number;
  tx: Hex | null; // null until the hour's root is posted
};

/** Proof for one leaf, by rebuilding its hour's tree. Null if the leaf doesn't exist. */
export async function getProofWith(store: StampStore, thesisId: bigint, seq: number): Promise<ProofResponse | null> {
  const row = await store.leaf(thesisId, seq);
  if (!row) return null;
  const values = leafValues(row);
  const hash = leafHash(values);
  if (hash !== row.leaf) throw new Error(`Stored leaf ${row.leaf} does not match its data (${hash})`);
  const { root, leafCount, tree } = buildHourRoot((await store.leavesForHour(row.hourStart)).map(leafValues));
  const posted = await store.root(row.hourStart);
  if (posted && posted.root !== root) throw new Error(`Hour ${row.hourStart.toISOString()} no longer matches its posted root`);
  return {
    thesisId: thesisId.toString(),
    seq,
    kind: values[2],
    kindName: row.kind,
    data: row.data,
    dataHash: values[3],
    leafHash: hash,
    proof: tree.getProof(values) as Hex[],
    root,
    hourStart: row.hourStart.getTime() / 1000,
    leafCount,
    tx: posted?.tx ?? null,
  };
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function drizzleStampStore(db: Db | Tx): StampStore {
  const toRow = (r: typeof stamps.$inferSelect): StampRow => ({
    leaf: r.leaf as Hex,
    thesisId: r.thesisId,
    seq: r.seq,
    kind: r.kind as StampKind,
    data: r.data,
    hourStart: r.hourStart,
  });
  return {
    async maxSeq(thesisId) {
      const [r] = await db.select({ m: max(stamps.seq) }).from(stamps).where(eq(stamps.thesisId, thesisId));
      return r?.m ?? null;
    },
    async insert(row) {
      await db.insert(stamps).values(row);
    },
    async leavesForHour(hourStart) {
      const rows = await db
        .select()
        .from(stamps)
        .where(eq(stamps.hourStart, hourStart))
        .orderBy(asc(stamps.thesisId), asc(stamps.seq));
      return rows.map(toRow);
    },
    async leaf(thesisId, seq) {
      const [r] = await db.select().from(stamps).where(and(eq(stamps.thesisId, thesisId), eq(stamps.seq, seq)));
      return r ? toRow(r) : null;
    },
    async root(hourStart) {
      const [r] = await db.select().from(stampRoots).where(eq(stampRoots.hourStart, hourStart));
      return r ? { ...r, root: r.root as Hex, tx: r.tx as Hex | null } : null;
    },
    async saveRoot(row) {
      const { hourStart: _, ...set } = row;
      await db.insert(stampRoots).values(row).onConflictDoUpdate({ target: stampRoots.hourStart, set });
    },
    transaction: (fn) => db.transaction((tx) => fn(drizzleStampStore(tx))),
  };
}

export const appendLeaf = (db: Db, input: AppendInput) => appendLeafWith(drizzleStampStore(db), input);
export const postHourRoot = ({ db, ...opts }: { db: Db; hourStart: Date; post: PostFn; now?: Date }) =>
  postHourRootWith(drizzleStampStore(db), opts);
export const getProof = (db: Db, thesisId: bigint, seq: number) => getProofWith(drizzleStampStore(db), thesisId, seq);
