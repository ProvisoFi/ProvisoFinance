// Tester job: consumes `test` requests, replays the sealed spec over recorded history and
// upserts test_runs. The spec and salts stay in memory only; the result never contains them.
import { Spec } from "@proviso/dsl";
import { testRuns, type Db } from "@proviso/db";
import { openSpec } from "@proviso/seal";
import { and, eq, ne } from "drizzle-orm";
import { DEFAULT_CONFIG, type EvalConfig } from "../evaluator/conditions.ts";
import { readKeys } from "../evaluator/machine.ts";
import { loadFrames } from "../tester/load.ts";
import { replay } from "../tester/replay.ts";
import { TESTER_VERSION, testId } from "../tester/testId.ts";
import { pgmq, type Executes, type Log, type Queue, type QueueMessage } from "./ports.ts";

export type TestRequest = { requestId: string; owner: string; encSpec: string; days: number; slippageBps: number };
export type TestJobDeps = {
  db: Db;
  specKey: Uint8Array;
  config?: EvalConfig;
  queueFor?: (db: Executes) => Queue;
  now?: () => number;
  log?: Log;
};

const DAY = 86_400_000;
/** Replays run in parallel at most this many at a time, so the evaluator is never starved. */
export const MAX_CONCURRENT_TESTS = 2;
/** A job that keeps failing for reasons other than its input is written as failed after this many reads. */
const MAX_ATTEMPTS = 3;

/** Errors raised by the request itself: written as failed at once, never retried. */
class BadRequest extends Error {}
const jsonSafe = (v: unknown) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));

/** Tester job: consumes `test` requests, replays the sealed spec over recorded history and upserts test_runs. The spec and salts stay in memory; the result never contains them. */
export class TestJob {
  private readonly queue: Queue;
  private readonly now: () => number;
  private readonly log: Log;
  private busy = false;

  constructor(private readonly d: TestJobDeps) {
    this.queue = (d.queueFor ?? pgmq)(d.db);
    this.now = d.now ?? Date.now;
    this.log = d.log ?? console.error;
  }

  /** One read of the `test` queue, up to MAX_CONCURRENT_TESTS jobs at once. */
  async poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      const msgs = await this.queue.read<TestRequest>("test", 300, MAX_CONCURRENT_TESTS);
      await Promise.all(msgs.map((m) => this.handle(m)));
    } finally {
      this.busy = false;
    }
  }

  private async handle(m: QueueMessage<TestRequest>) {
    const req = m.message;
    try {
      await this.run(req);
    } catch (err) {
      const bad = err instanceof BadRequest;
      this.log(`tests: request ${String(req?.requestId)} failed${bad || m.readCt >= MAX_ATTEMPTS ? "" : ", will retry"}`, bad ? err.message : err);
      if (!bad && m.readCt < MAX_ATTEMPTS) return; // reappears after the visibility timeout
      await this.fail(req, bad ? err.message : "internal error");
    }
    await this.queue.delete("test", m.msgId);
  }

  private async run(req: TestRequest) {
    if (typeof req?.requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(req.requestId)) throw new BadRequest("bad requestId");
    if (!Number.isInteger(req.days) || req.days < 1 || req.days > 90) throw new BadRequest("days must be an integer 1-90");
    if (!(Number.isFinite(req.slippageBps) && req.slippageBps >= 0 && req.slippageBps <= 1000)) throw new BadRequest("slippageBps must be 0-1000");
    let spec: Spec;
    try {
      // Only a box sealed as a test by this requester: a thesis box would replay its sealed levels.
      const box = new Uint8Array(Buffer.from(String(req.encSpec), "base64"));
      spec = Spec.parse(openSpec(this.d.specKey, box, { purpose: "test", owner: String(req.owner) }).spec);
    } catch {
      throw new BadRequest("spec could not be opened"); // never surface the cause: it could quote plaintext
    }

    const to = this.now();
    const from = to - req.days * DAY;
    const coins = readKeys(spec).filter((k) => k.startsWith("hl:")).map((k) => k.slice(3));
    const { frames, snapshotIds } = await loadFrames(this.d.db, { coins, from: new Date(from), to: new Date(to) });
    const id = testId(spec, snapshotIds);
    const base = { testId: id, requestId: req.requestId, owner: req.owner.toLowerCase(), snapshotIds, testerVersion: TESTER_VERSION };
    const meta = { days: req.days, from, to, slippageBps: req.slippageBps, coins };
    if (!frames.length) return this.upsert({ ...base, status: "failed", result: { error: "no recorded market data for the window", ...meta } });
    const r = replay({ spec, frames, slippageBps: req.slippageBps, config: this.d.config ?? DEFAULT_CONFIG });
    await this.upsert({ ...base, status: "done", result: jsonSafe({ ...meta, ...r }) });
  }

  private async fail(req: TestRequest | undefined, error: string) {
    const requestId = String(req?.requestId ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) return; // can't key a row; the message is dropped
    const row = { testId: `failed:${requestId}`, requestId, snapshotIds: [], testerVersion: TESTER_VERSION, status: "failed", result: { error } };
    const owner = typeof req?.owner === "string" ? req.owner.toLowerCase() : null;
    // A bad request's owner may not exist in users; keep the row without it rather than lose it.
    await this.upsert({ ...row, owner }).catch(() => this.upsert({ ...row, owner: null }));
  }

  /** request_id is unique: a redelivered request that now hashes to a new testId moves the id over. */
  private async upsert(row: typeof testRuns.$inferInsert) {
    await this.d.db.transaction(async (tx) => {
      if (row.requestId)
        await tx.update(testRuns).set({ requestId: null }).where(and(eq(testRuns.requestId, row.requestId), ne(testRuns.testId, row.testId)));
      await tx
        .insert(testRuns)
        .values(row)
        .onConflictDoUpdate({
          target: testRuns.testId,
          set: { requestId: row.requestId, owner: row.owner, snapshotIds: row.snapshotIds, status: row.status, result: row.result },
        });
    });
  }
}
