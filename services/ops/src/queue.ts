// Typed helpers over Supabase Queues (pgmq), via raw SQL on the service-role connection.
import type { Db } from "@proviso/db";
import { sql } from "drizzle-orm";

export type QueueMessage<T> = { msgId: bigint; readCt: number; enqueuedAt: Date; vt: Date; message: T };

type Raw = { msg_id: string | number; read_ct: number; enqueued_at: string | Date; vt: string | Date; message: unknown };

export function queues(db: Pick<Db, "execute">) {
  const q = {
    async send<T>(queue: string, msg: T, delaySec = 0): Promise<bigint> {
      const rows = await db.execute<{ msg_id: string }>(
        sql`select pgmq.send(${queue}, ${JSON.stringify(msg)}::jsonb, ${delaySec}::int) as msg_id`,
      );
      return BigInt(rows[0]!.msg_id);
    },
    async read<T>(queue: string, vtSec: number, qty: number): Promise<QueueMessage<T>[]> {
      const rows = await db.execute<Raw>(sql`select * from pgmq.read(${queue}, ${vtSec}::int, ${qty}::int)`);
      return [...rows].map((r) => ({
        msgId: BigInt(r.msg_id),
        readCt: Number(r.read_ct),
        enqueuedAt: new Date(r.enqueued_at),
        vt: new Date(r.vt),
        message: r.message as T,
      }));
    },
    async delete(queue: string, msgId: bigint): Promise<boolean> {
      const rows = await db.execute<{ ok: boolean }>(sql`select pgmq.delete(${queue}, ${msgId.toString()}::bigint) as ok`);
      return !!rows[0]?.ok;
    },
    async archive(queue: string, msgId: bigint): Promise<boolean> {
      const rows = await db.execute<{ ok: boolean }>(sql`select pgmq.archive(${queue}, ${msgId.toString()}::bigint) as ok`);
      return !!rows[0]?.ok;
    },
    consume<T>(queue: string, handler: Handler<T>, opts: ConsumeOptions = {}) {
      return consume(q, queue, handler, opts);
    },
  };
  return q;
}

export type Handler<T> = (message: T, meta: QueueMessage<T>) => Promise<void>;
export type ConsumeOptions = {
  vt?: number; // seconds a read message stays invisible; a failed one reappears after this
  batch?: number;
  idleMs?: number; // sleep when the queue is empty or the read failed
  maxAttempts?: number; // after this many reads the message is archived instead of retried
  signal?: AbortSignal; // stops the loop
  log?: (msg: string, err?: unknown) => void;
};
type QueueOps = Pick<ReturnType<typeof queues>, "read" | "delete" | "archive">;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/**
 * Reads batches until `signal` aborts. Success deletes the message; failure leaves it to reappear
 * after `vt`, and once read_ct reaches maxAttempts it is archived (pgmq.a_<queue>) instead.
 */
export async function consume<T>(ops: QueueOps, queue: string, handler: Handler<T>, opts: ConsumeOptions = {}) {
  const { vt = 30, batch = 10, idleMs = 1000, maxAttempts = 5, signal, log = console.error } = opts;
  while (!signal?.aborted) {
    let msgs: QueueMessage<T>[];
    try {
      msgs = await ops.read<T>(queue, vt, batch);
    } catch (e) {
      log(`queue ${queue}: read failed`, e);
      await sleep(idleMs, signal);
      continue;
    }
    if (!msgs.length) {
      await sleep(idleMs, signal);
      continue;
    }
    for (const m of msgs) {
      // A message read more than maxAttempts times crashed its worker before it could be archived.
      if (m.readCt > maxAttempts) {
        log(`queue ${queue}: msg ${m.msgId} exceeded ${maxAttempts} attempts, archiving`);
        await ops.archive(queue, m.msgId).catch((e) => log(`queue ${queue}: archive ${m.msgId} failed`, e));
        continue;
      }
      try {
        await handler(m.message, m);
      } catch (e) {
        const final = m.readCt >= maxAttempts;
        log(`queue ${queue}: msg ${m.msgId} attempt ${m.readCt} failed${final ? ", archiving" : ", will retry"}`, e);
        if (final) await ops.archive(queue, m.msgId).catch((e2) => log(`queue ${queue}: archive ${m.msgId} failed`, e2));
        continue;
      }
      // A failed delete only means a redelivery; handlers must be idempotent anyway.
      await ops.delete(queue, m.msgId).catch((e) => log(`queue ${queue}: delete ${m.msgId} failed`, e));
    }
  }
}
