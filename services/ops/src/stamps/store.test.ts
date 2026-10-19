import { describe, expect, mock, test } from "bun:test";
import { keccak256, type Hex } from "viem";
import { buildHourRoot, sequenceGaps, verifyProof } from "./leaf";
import {
  appendLeafWith,
  dataHash,
  getProofWith,
  leafValues,
  postHourRootWith,
  type RootRow,
  type StampRow,
  type StampStore,
} from "./store";

const tick = () => new Promise((r) => setTimeout(r, 0));

/** In-memory StampStore that enforces unique (thesis_id, seq) like Postgres. */
function fakeStore() {
  const rows: StampRow[] = [];
  const roots = new Map<number, RootRow>();
  const store: StampStore = {
    async maxSeq(thesisId) {
      await tick(); // let concurrent appends interleave, like separate connections would
      const seqs = rows.filter((r) => r.thesisId === thesisId).map((r) => r.seq);
      return seqs.length ? Math.max(...seqs) : null;
    },
    async insert(row) {
      await tick();
      if (rows.some((r) => r.thesisId === row.thesisId && r.seq === row.seq))
        throw new Error("query failed", { cause: Object.assign(new Error("duplicate key"), { code: "23505" }) });
      rows.push(structuredClone(row));
    },
    async leavesForHour(hourStart) {
      return rows
        .filter((r) => r.hourStart.getTime() === hourStart.getTime())
        .sort((a, b) => (a.thesisId === b.thesisId ? a.seq - b.seq : a.thesisId < b.thesisId ? -1 : 1));
    },
    async leaf(thesisId, seq) {
      return rows.find((r) => r.thesisId === thesisId && r.seq === seq) ?? null;
    },
    async root(hourStart) {
      return roots.get(hourStart.getTime()) ?? null;
    },
    async saveRoot(row) {
      roots.set(row.hourStart.getTime(), { ...row });
    },
    transaction: (fn) => fn(store),
  };
  return { store, rows, roots };
}

const HOUR = new Date("2026-10-19T10:00:00Z");
const at = (min: number) => new Date(HOUR.getTime() + min * 60_000);
const LATER = new Date("2026-10-19T12:00:00Z");
const fakeTx = (n: number) => keccak256(`0x${n.toString(16).padStart(2, "0")}`);

describe("dataHash", () => {
  test("is keccak256 of the JCS canonical form, so key order doesn't matter", () => {
    expect(dataHash({ b: 2, a: [1, "x"] })).toBe(dataHash({ a: [1, "x"], b: 2 }));
    expect(dataHash({ a: 1 })).toBe(keccak256(new TextEncoder().encode('{"a":1}')));
    expect(dataHash({ a: 1 })).not.toBe(dataHash({ a: 2 }));
  });
});

describe("appendLeaf", () => {
  test("allocates seqs from 1 per thesis and floors hour_start", async () => {
    const { store } = fakeStore();
    const a = await appendLeafWith(store, { thesisId: 1n, kind: "FIRE", data: { px: "1" }, at: at(5) });
    const b = await appendLeafWith(store, { thesisId: 1n, kind: "FILL", data: { sz: "2" }, at: at(59) });
    const c = await appendLeafWith(store, { thesisId: 2n, kind: "FIRE", data: {}, at: at(61) });
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 1]);
    expect(a.hourStart).toEqual(HOUR);
    expect(b.hourStart).toEqual(HOUR);
    expect(c.hourStart).toEqual(at(60));
    expect(a.leaf).toBe(buildHourRoot([leafValues(a)]).root);
  });

  test("concurrent appends race on seq, retry, and leave no gaps", async () => {
    const { store, rows } = fakeStore();
    const insert = mock(store.insert);
    store.insert = insert;
    await Promise.all(
      Array.from({ length: 4 }, (_, i) => appendLeafWith(store, { thesisId: 9n, kind: "PNL", data: { i }, at: at(i) }, 10)),
    );
    const seqs = rows.map((r) => r.seq).sort();
    expect(seqs).toEqual([1, 2, 3, 4]);
    expect(sequenceGaps(seqs)).toEqual([]);
    expect(insert.mock.calls.length).toBeGreaterThan(4); // conflicts happened and were retried
  });

  test("gives up after maxAttempts and rethrows other errors", async () => {
    const { store } = fakeStore();
    store.insert = async () => {
      throw Object.assign(new Error("dup"), { code: "23505" });
    };
    await expect(appendLeafWith(store, { thesisId: 1n, kind: "FIRE", data: {}, at: at(0) }, 3)).rejects.toThrow("dup");
    store.insert = async () => {
      throw new Error("connection reset");
    };
    await expect(appendLeafWith(store, { thesisId: 1n, kind: "FIRE", data: {}, at: at(0) })).rejects.toThrow("connection reset");
    await expect(appendLeafWith(store, { thesisId: 1n, kind: "NOPE" as "FIRE", data: {}, at: at(0) })).rejects.toThrow();
  });
});

async function seed(store: StampStore, order: number[]) {
  for (const i of order) await appendLeafWith(store, { thesisId: BigInt(i % 3), kind: "FILL", data: { i }, at: at(i) });
}

describe("postHourRoot", () => {
  test("posts once; a re-run is a no-op", async () => {
    const { store, roots } = fakeStore();
    await seed(store, [1, 2, 3, 4, 5]);
    const post = mock(async () => fakeTx(1));
    const first = await postHourRootWith(store, { hourStart: HOUR, post, now: LATER });
    expect(first.status).toBe("posted");
    expect(post).toHaveBeenCalledTimes(1);
    const [hourSec, root, count] = post.mock.calls[0] as unknown as [bigint, Hex, number];
    expect(hourSec).toBe(BigInt(HOUR.getTime() / 1000));
    expect(root).toBe(buildHourRoot((await store.leavesForHour(HOUR)).map(leafValues)).root);
    expect(count).toBe(5);
    expect(roots.get(HOUR.getTime())).toMatchObject({ root, leafCount: 5, tx: fakeTx(1) });
    expect(roots.get(HOUR.getTime())!.postedAt).toBeInstanceOf(Date);

    const again = await postHourRootWith(store, { hourStart: HOUR, post, now: LATER });
    expect(again).toMatchObject({ status: "already-posted", root, leafCount: 5, tx: fakeTx(1) });
    expect(post).toHaveBeenCalledTimes(1);
  });

  test("a failed post leaves a pending row and the next run posts", async () => {
    const { store, roots } = fakeStore();
    await seed(store, [1, 2]);
    const failing = async (): Promise<Hex> => {
      throw new Error("rpc down");
    };
    await expect(postHourRootWith(store, { hourStart: HOUR, post: failing, now: LATER })).rejects.toThrow("rpc down");
    await tick();
    expect(roots.get(HOUR.getTime())).toMatchObject({ leafCount: 2, tx: null });
    const post = mock(async () => fakeTx(2));
    expect((await postHourRootWith(store, { hourStart: HOUR, post, now: LATER })).status).toBe("posted");
    expect(post).toHaveBeenCalledTimes(1);
  });

  test("root is the same regardless of insert order", async () => {
    const a = fakeStore();
    await seed(a.store, [1, 2, 3, 4, 5, 6]);
    const b = fakeStore();
    for (const r of [...a.rows].reverse()) await b.store.insert(r); // same leaves, reversed insert order
    const post = async () => fakeTx(3);
    const ra = await postHourRootWith(a.store, { hourStart: HOUR, post, now: LATER });
    const rb = await postHourRootWith(b.store, { hourStart: HOUR, post, now: LATER });
    expect(ra.status).toBe("posted");
    expect(rb).toEqual(ra);
  });

  test("empty hours, unfinished hours and unaligned hours", async () => {
    const { store } = fakeStore();
    const post = mock(async () => fakeTx(4));
    expect(await postHourRootWith(store, { hourStart: HOUR, post, now: LATER })).toEqual({ status: "empty", hourStart: HOUR });
    await expect(postHourRootWith(store, { hourStart: HOUR, post, now: at(59) })).rejects.toThrow("not over");
    await expect(postHourRootWith(store, { hourStart: at(1), post, now: LATER })).rejects.toThrow("aligned");
    expect(post).not.toHaveBeenCalled();
  });
});

describe("getProof", () => {
  test("round trip: every leaf verifies against the posted root, also after JSON", async () => {
    const { store, rows } = fakeStore();
    await seed(store, [1, 2, 3, 4, 5, 6, 7]);
    const before = await getProofWith(store, 1n, 1);
    expect(before!.tx).toBeNull();
    const posted = await postHourRootWith(store, { hourStart: HOUR, post: async () => fakeTx(5), now: LATER });
    if (posted.status !== "posted") throw new Error("expected a post");
    for (const r of rows) {
      const p = (await getProofWith(store, r.thesisId, r.seq))!;
      expect(p).toMatchObject({ root: posted.root, tx: fakeTx(5), leafHash: r.leaf, leafCount: 7, kindName: "FILL", kind: 1 });
      expect(p.hourStart).toBe(HOUR.getTime() / 1000);
      expect(p.dataHash).toBe(dataHash(r.data));
      expect(verifyProof(p, posted.root)).toBe(true);
      expect(verifyProof(JSON.parse(JSON.stringify(p)), posted.root)).toBe(true);
    }
  });

  test("missing leaf is null; tampered data throws", async () => {
    const { store, rows } = fakeStore();
    await seed(store, [1, 2]);
    expect(await getProofWith(store, 99n, 1)).toBeNull();
    rows[0]!.data = { i: 1000 };
    await expect(getProofWith(store, rows[0]!.thesisId, rows[0]!.seq)).rejects.toThrow("does not match");
  });

  test("a leaf added after its hour was posted is reported, not silently proven", async () => {
    const { store } = fakeStore();
    await seed(store, [1, 2]);
    await postHourRootWith(store, { hourStart: HOUR, post: async () => fakeTx(6), now: LATER });
    await appendLeafWith(store, { thesisId: 1n, kind: "EXIT", data: {}, at: at(30) });
    await expect(getProofWith(store, 1n, 1)).rejects.toThrow("posted root");
  });
});
