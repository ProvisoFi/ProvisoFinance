// Local copy of the executor contract (src/executor/port.ts owns the real one; swap the import
// when it lands) plus the queue helper the runtime writes through.
import type { Spec } from "@proviso/dsl";
import { sql, type SQL } from "drizzle-orm";

export type FireInput = { fireId: string; thesisId: bigint; owner: string; spec: Spec; mark: number; at: Date; n: number };

export interface ExecutorPort {
  onFire(e: FireInput): Promise<void>;
  onMark(coin: string, mark: number, at: Date): void;
  stop(thesisId: bigint, owner: string): Promise<void>;
}

/** Placeholder until the executor lands: accepts everything, trades nothing. */
export class NoopExecutor implements ExecutorPort {
  /** Ignores the fire. */
  async onFire() {}
  /** Ignores the mark. */
  onMark() {}
  /** Ignores the stop. */
  async stop() {}
}

/** What the executor reports when a position closes; the runtime then reveals the exit part. */
export type ExitReport = {
  thesisId: bigint;
  at: Date;
  /** Evidence for the EXIT leaf (fills, reason, ...). */
  data: Record<string, unknown>;
  /** Evidence for a PNL leaf, when known. */
  pnl?: Record<string, unknown>;
};

export type QueueMessage<T> = { msgId: bigint; readCt: number; message: T };
export interface Queue {
  send(queue: string, msg: unknown): Promise<void>;
  read<T>(queue: string, vtSec: number, qty: number): Promise<QueueMessage<T>[]>;
  delete(queue: string, msgId: bigint): Promise<void>;
}

/** Anything with drizzle's `execute` (a db or a transaction). postgres-js returns rows, PGlite { rows }. */
export type Executes = { execute(q: SQL): Promise<unknown> };
const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] }).rows ?? [])) as T[];

/** Supabase Queues (pgmq) over raw SQL. */
export function pgmq(db: Executes): Queue {
  return {
    async send(queue, msg) {
      await db.execute(sql`select pgmq.send(${queue}, ${JSON.stringify(msg)}::jsonb)`);
    },
    async read<T>(queue: string, vtSec: number, qty: number) {
      const rows = rowsOf<{ msg_id: string | number; read_ct: number; message: T }>(
        await db.execute(sql`select msg_id, read_ct, message from pgmq.read(${queue}, ${vtSec}::int, ${qty}::int)`),
      );
      return rows.map((r) => ({ msgId: BigInt(r.msg_id), readCt: Number(r.read_ct), message: r.message }));
    },
    async delete(queue, msgId) {
      await db.execute(sql`select pgmq.delete(${queue}, ${msgId.toString()}::bigint)`);
    },
  };
}

export type Log = (msg: string, err?: unknown) => void;
