// Turns evaluator events into records (fires, state, activity), queue messages (reveal,
// stamp_leaf) and executor calls; handles exit reports and stop requests.
import { activity, fires, theses, type Db } from "@proviso/db";
import { bytesToHex } from "@noble/hashes/utils.js";
import { and, eq, inArray } from "drizzle-orm";
import type { FireEvent, ExpireEvent, MachineEvent } from "../evaluator/machine.ts";
import type { Idea } from "./ideas.ts";
import { pgmq, type Executes, type ExecutorPort, type ExitReport, type Log, type Queue } from "./ports.ts";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type EventDeps = {
  db: Db;
  executor: ExecutorPort;
  ideas: { get(id: bigint | string): Idea | undefined; remove(id: bigint | string): void; exited?(id: bigint | string): void };
  /** Queue bound to a db or transaction; default pgmq. Tests pass a recorder. */
  queueFor?: (db: Executes) => Queue;
  log?: Log;
};

export type StopRequest = { thesisId: string | number; owner: string };
const hex = (b: Uint8Array) => `0x${bytesToHex(b)}`;
const iso = (t: number | Date) => new Date(t).toISOString();

export class EventSink {
  private readonly queueFor: (db: Executes) => Queue;
  private readonly log: Log;
  /** Events whose database transaction failed; retried by retryPending (the tx rolled back, so no duplicates). */
  private pending: MachineEvent[] = [];
  private stopping = false;

  constructor(private readonly d: EventDeps) {
    this.queueFor = d.queueFor ?? pgmq;
    this.log = d.log ?? console.error;
  }

  /** Evaluator callback. Never throws; failed records are kept for retry. */
  handle = (e: MachineEvent): Promise<void> =>
    this.process(e).catch((err) => {
      this.log(`events: ${e.kind} for thesis ${e.id} failed, will retry`, err);
      this.pending.push(e);
    });

  async retryPending() {
    const batch = this.pending;
    this.pending = [];
    for (const e of batch) await this.handle(e);
  }
  get pendingCount() {
    return this.pending.length;
  }

  private async process(e: MachineEvent) {
    const idea = this.d.ideas.get(e.id);
    if (!idea) return this.log(`events: ${e.kind} for unknown thesis ${e.id}, dropped`);
    if (e.kind === "fire") return this.fire(e, idea);
    return this.expire(e, idea);
  }

  private async fire(e: FireEvent, idea: Idea) {
    const id = idea.thesisId;
    const fireId = await this.d.db.transaction(async (tx: Tx) => {
      const q = this.queueFor(tx);
      const [row] = await tx
        .insert(fires)
        .values({ thesisId: id, firedAt: new Date(e.at), refMark: String(e.mark), flags: e.flags })
        .returning({ id: fires.id });
      if (idea.spec.fire === "once")
        await tx.update(theses).set({ state: "fired" }).where(and(eq(theses.id, id), inArray(theses.state, ["live", "alert"])));
      // The entry becomes public at the fire; the exit stays sealed until the position closes.
      await q.send("reveal", { thesisId: id.toString(), part: "entry", kind: "FIRED", canonical: hex(idea.canonicalEntry), salt: idea.saltE });
      await q.send("stamp_leaf", { thesisId: id.toString(), kind: "FIRE", data: { fireId: row.id, at: iso(e.at), mark: e.mark, n: e.n }, at: iso(e.at) });
      await tx.insert(activity).values({ address: idea.owner, kind: "fired", payload: { thesisId: id.toString(), fireId: row.id, mark: e.mark, n: e.n } });
      return row.id;
    });
    // After the commit: live and alert both go to the executor (it ignores alert ideas).
    await this.d.executor
      .onFire({ fireId, thesisId: id, owner: idea.owner, spec: idea.spec, mark: e.mark, at: new Date(e.at), n: e.n })
      .catch((err) => this.log(`events: executor.onFire failed for thesis ${id} fire ${fireId}`, err));
  }

  private async expire(e: ExpireEvent, idea: Idea) {
    const id = idea.thesisId;
    await this.d.db.transaction(async (tx: Tx) => {
      const q = this.queueFor(tx);
      await tx.update(theses).set({ state: "expired" }).where(and(eq(theses.id, id), inArray(theses.state, ["live", "alert"])));
      await q.send("reveal", { thesisId: id.toString(), part: "entry", kind: "EXPIRED", canonical: hex(idea.canonicalEntry), salt: idea.saltE });
      await q.send("stamp_leaf", { thesisId: id.toString(), kind: "EXPIRE", data: { at: iso(e.at) }, at: iso(e.at) });
      await tx.insert(activity).values({ address: idea.owner, kind: "expired", payload: { thesisId: id.toString() } });
    });
    this.d.ideas.remove(id);
  }

  /** Executor callback when a position closes: reveal the exit part and record EXIT (and PNL). */
  onExit = async (r: ExitReport): Promise<void> => {
    const idea = this.d.ideas.get(r.thesisId);
    if (!idea) throw new Error(`exit for thesis ${r.thesisId} that is not in memory`);
    const id = idea.thesisId;
    await this.d.db.transaction(async (tx: Tx) => {
      const q = this.queueFor(tx);
      await q.send("reveal", { thesisId: id.toString(), part: "exit", canonical: hex(idea.canonicalExit), salt: idea.saltX });
      await q.send("stamp_leaf", { thesisId: id.toString(), kind: "EXIT", data: r.data, at: iso(r.at) });
      if (r.pnl) await q.send("stamp_leaf", { thesisId: id.toString(), kind: "PNL", data: r.pnl, at: iso(r.at) });
      await tx.update(theses).set({ state: "closed" }).where(and(eq(theses.id, id), eq(theses.state, "fired")));
      await tx.insert(activity).values({ address: idea.owner, kind: "closed", payload: { thesisId: id.toString() } });
    });
    this.d.ideas.exited?.(id);
  };

  /** Handles one stop request: the owner must match the thesis row. */
  async stop(req: StopRequest) {
    const id = BigInt(req.thesisId);
    const owner = String(req.owner).toLowerCase();
    const [row] = await this.d.db.select({ owner: theses.owner }).from(theses).where(eq(theses.id, id));
    if (!row || row.owner.toLowerCase() !== owner) return this.log(`events: stop for thesis ${id} by a non-owner, dropped`);
    this.d.ideas.remove(id); // no new fires from here on
    await this.d.executor.stop(id, row.owner);
    await this.d.db.transaction(async (tx: Tx) => {
      await tx.update(theses).set({ state: "stopped" }).where(and(eq(theses.id, id), inArray(theses.state, ["live", "alert", "fired"])));
      await tx.insert(activity).values({ address: row.owner, kind: "stopped", payload: { thesisId: id.toString() } });
    });
  }

  /** One read of the `stop` queue. A failed message reappears after the visibility timeout. */
  async pollStops(batch = 10) {
    if (this.stopping) return;
    this.stopping = true;
    try {
      const q = this.queueFor(this.d.db);
      for (const m of await q.read<StopRequest>("stop", 30, batch)) {
        try {
          await this.stop(m.message);
          await q.delete("stop", m.msgId);
        } catch (err) {
          this.log(`events: stop message ${m.msgId} failed, will retry`, err);
        }
      }
    } finally {
      this.stopping = false;
    }
  }
}
