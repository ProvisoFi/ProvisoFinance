import { describe, expect, mock, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { consume, queues, type QueueMessage } from "./queue";

const dialect = new PgDialect();

/** Fake drizzle db: records the SQL it gets and returns canned rows. */
function fakeDb(rows: Record<string, unknown>[]) {
  const seen: { sql: string; params: unknown[] }[] = [];
  const db = {
    execute: async (q: SQL) => {
      seen.push(dialect.sqlToQuery(q));
      return rows;
    },
  };
  return { db: db as unknown as Parameters<typeof queues>[0], seen };
}

describe("queues SQL", () => {
  test("send", async () => {
    const { db, seen } = fakeDb([{ msg_id: "42" }]);
    expect(await queues(db).send("stamps", { thesisId: "1" })).toBe(42n);
    expect(seen[0]).toMatchObject({
      sql: "select pgmq.send($1, $2::jsonb, $3::int) as msg_id",
      params: ["stamps", '{"thesisId":"1"}', 0],
    });
  });

  test("read maps rows", async () => {
    const { db, seen } = fakeDb([
      { msg_id: "7", read_ct: 2, enqueued_at: "2026-10-19T10:00:00Z", vt: "2026-10-19T10:01:00Z", message: { a: 1 } },
    ]);
    const [m] = await queues(db).read<{ a: number }>("stamps", 30, 5);
    expect(m).toEqual({
      msgId: 7n,
      readCt: 2,
      enqueuedAt: new Date("2026-10-19T10:00:00Z"),
      vt: new Date("2026-10-19T10:01:00Z"),
      message: { a: 1 },
    });
    expect(seen[0]).toMatchObject({ sql: "select * from pgmq.read($1, $2::int, $3::int)", params: ["stamps", 30, 5] });
  });

  test("delete and archive", async () => {
    const { db, seen } = fakeDb([{ ok: true }]);
    expect(await queues(db).delete("stamps", 7n)).toBe(true);
    expect(await queues(db).archive("stamps", 8n)).toBe(true);
    expect(seen.map((s) => s.sql)).toEqual([
      "select pgmq.delete($1, $2::bigint) as ok",
      "select pgmq.archive($1, $2::bigint) as ok",
    ]);
    expect(seen.map((s) => s.params)).toEqual([
      ["stamps", "7"],
      ["stamps", "8"],
    ]);
  });
});

const msg = (id: number, readCt: number, message: string): QueueMessage<string> => ({
  msgId: BigInt(id),
  readCt,
  enqueuedAt: new Date(0),
  vt: new Date(0),
  message,
});

/** Serves the given batches, then empty reads; aborts once all batches are consumed. */
function fakeOps(batches: (QueueMessage<string>[] | Error)[]) {
  const ac = new AbortController();
  const ops = {
    read: mock(async (): Promise<QueueMessage<string>[]> => {
      const b = batches.shift();
      if (!batches.length) setTimeout(() => ac.abort(), 5);
      if (b instanceof Error) throw b;
      return b ?? [];
    }),
    delete: mock(async () => true),
    archive: mock(async () => true),
  };
  return { ops, asOps: ops as unknown as Parameters<typeof consume>[0], signal: ac.signal };
}

describe("consume", () => {
  const log = () => {};

  test("deletes on success, leaves failures for retry, archives at max attempts", async () => {
    const { ops, asOps, signal } = fakeOps([[msg(1, 1, "ok"), msg(2, 1, "fail"), msg(3, 3, "fail"), msg(4, 4, "never")]]);
    const handler = mock(async (m: string) => {
      if (m === "fail") throw new Error("boom");
    });
    await consume(asOps, "q", handler, { maxAttempts: 3, idleMs: 1, signal, log });
    expect(handler.mock.calls.map((c) => c[0])).toEqual(["ok", "fail", "fail"]); // msg 4 is past max: not handled
    expect(ops.delete.mock.calls).toEqual([["q", 1n]] as never);
    expect(ops.archive.mock.calls).toEqual([["q", 3n], ["q", 4n]] as never);
  });

  test("passes vt and batch to read, survives read errors and stops on abort", async () => {
    const { ops, asOps, signal } = fakeOps([new Error("db down"), [msg(1, 1, "a")], []]);
    const logs: string[] = [];
    await consume(asOps, "q", async () => {}, { vt: 60, batch: 3, idleMs: 1, signal, log: (m) => logs.push(m) });
    expect(ops.read.mock.calls[0]).toEqual(["q", 60, 3] as never);
    expect(logs).toEqual(["queue q: read failed"]);
    expect(ops.delete).toHaveBeenCalledTimes(1);
  });

  test("a failing delete or archive is logged, not thrown", async () => {
    const { ops, asOps, signal } = fakeOps([[msg(1, 1, "ok"), msg(2, 9, "x")]]);
    ops.delete.mockImplementation(async () => {
      throw new Error("gone");
    });
    ops.archive.mockImplementation(async () => {
      throw new Error("gone");
    });
    const logs: string[] = [];
    await consume(asOps, "q", async () => {}, { idleMs: 1, signal, log: (m) => logs.push(m) });
    expect(logs.some((l) => l.includes("delete 1 failed"))).toBe(true);
    expect(logs.some((l) => l.includes("archive 2 failed"))).toBe(true);
  });
});
