import { describe, expect, test } from "bun:test";
import { canonicalize, entryPart, exitPart, Spec } from "@proviso/dsl";
import { activity, fires, theses } from "@proviso/db";
import { bytesToHex } from "@noble/hashes/utils.js";
import { eq } from "drizzle-orm";
import { Evaluator } from "../evaluator/engine.ts";
import { hl, priceAbove, spec } from "../evaluator/testkit.ts";
import { EventSink } from "./events.ts";
import { insertThesis, OWNER, recorder, setup } from "./fixture.ts";
import { IdeaRegistry } from "./ideas.ts";
import type { ExecutorPort, FireInput } from "./ports.ts";

async function world(o: { fire?: "once" | "repeat"; failFire?: boolean } = {}) {
  const { db, priv, pub } = await setup();
  const sealed = await insertThesis(db, pub, 9n, { spec: spec(priceAbove("BTC", 100), { fire: o.fire ?? "once" }) });
  const calls = { fire: [] as FireInput[], stop: [] as [bigint, string][], marks: 0 };
  const executor: ExecutorPort = {
    async onFire(e) {
      calls.fire.push(e);
      if (o.failFire) throw new Error("executor down");
    },
    onMark: () => void calls.marks++,
    async stop(id, owner) {
      calls.stop.push([id, owner]);
    },
  };
  const rec = recorder();
  const logs: string[] = [];
  let sink!: EventSink;
  const ev = new Evaluator((e) => void sink.handle(e));
  const ideas = new IdeaRegistry({ db, evaluator: ev, specKey: priv });
  sink = new EventSink({ db, executor, ideas, queueFor: () => rec.queue, log: (m) => logs.push(m) });
  await ideas.sync();
  return { db, sealed, calls, rec, sink, ev, ideas, logs };
}
const hexOf = (b: Uint8Array) => `0x${bytesToHex(b)}`;
const T = Date.parse("2026-10-20T12:00:00Z");

describe("fire", () => {
  test("writes the fires row, sets fired, queues reveal + FIRE leaf, records activity, calls the executor", async () => {
    const w = await world();
    const sink = w.sink;
    await sink.handle({ kind: "fire", id: "9", at: T, coin: "BTC", mark: 105.5, n: 1, flags: ["self_triggered"] });
    const [f] = await w.db.select().from(fires);
    expect(f).toMatchObject({ thesisId: 9n, refMark: "105.5", flags: ["self_triggered"] });
    expect(f.firedAt.getTime()).toBe(T);
    expect((await w.db.select().from(theses).where(eq(theses.id, 9n)))[0].state).toBe("fired");
    const parsed = Spec.parse(w.sealed.spec);
    expect(w.rec.sent).toEqual([
      { queue: "reveal", msg: { thesisId: "9", part: "entry", kind: "FIRED", canonical: hexOf(canonicalize(entryPart(parsed))), salt: w.sealed.saltE } },
      { queue: "stamp_leaf", msg: { thesisId: "9", kind: "FIRE", data: { fireId: f.id, at: new Date(T).toISOString(), mark: 105.5, n: 1 }, at: new Date(T).toISOString() } },
    ]);
    expect(await w.db.select().from(activity)).toMatchObject([{ address: OWNER, kind: "fired", payload: { thesisId: "9", fireId: f.id } }]);
    expect(w.calls.fire).toEqual([{ fireId: f.id, thesisId: 9n, owner: OWNER, spec: parsed, mark: 105.5, at: new Date(T), n: 1 }]);
  });

  test("a live evaluator fire flows through the sink", async () => {
    const w = await world();
    w.ev.apply(hl("BTC", T, 90), T);
    w.ev.apply(hl("BTC", T + 5000, 101), T + 5000);
    await Bun.sleep(50);
    expect(w.calls.fire).toHaveLength(1);
    expect(w.calls.fire[0].mark).toBe(101);
  });

  test("repeat ideas stay live", async () => {
    const w = await world({ fire: "repeat" });
    await w.sink.handle({ kind: "fire", id: "9", at: T, coin: "BTC", mark: 1, n: 1, flags: [] });
    expect((await w.db.select().from(theses))[0].state).toBe("live");
  });

  test("an executor failure is logged but the records stand; a db failure is retried", async () => {
    const w = await world({ failFire: true });
    await w.sink.handle({ kind: "fire", id: "9", at: T, coin: "BTC", mark: 1, n: 1, flags: [] });
    expect(await w.db.select().from(fires)).toHaveLength(1);
    expect(w.logs.some((l) => l.includes("executor.onFire failed"))).toBe(true);

    const w2 = await world();
    const realTx = w2.db.transaction.bind(w2.db);
    let fail = true;
    (w2.db as any).transaction = (fn: any) => (fail ? Promise.reject(new Error("db down")) : realTx(fn));
    await w2.sink.handle({ kind: "fire", id: "9", at: T, coin: "BTC", mark: 1, n: 1, flags: [] });
    expect(w2.sink.pendingCount).toBe(1);
    fail = false;
    await w2.sink.retryPending();
    expect(w2.sink.pendingCount).toBe(0);
    expect(await w2.db.select().from(fires)).toHaveLength(1);
  });
});

describe("expire, exit, stop", () => {
  test("expire: state expired, EXPIRED reveal and EXPIRE leaf, idea dropped", async () => {
    const w = await world();
    await w.sink.handle({ kind: "expire", id: "9", at: T });
    expect((await w.db.select().from(theses))[0].state).toBe("expired");
    expect(w.rec.sent.map((s) => [s.queue, s.msg.kind, s.msg.part])).toEqual([
      ["reveal", "EXPIRED", "entry"],
      ["stamp_leaf", "EXPIRE", undefined],
    ]);
    expect(w.ideas.get(9n)).toBeUndefined();
  });

  test("exit report reveals the exit part with saltX, adds EXIT and PNL leaves, closes a fired idea", async () => {
    const w = await world();
    await w.sink.handle({ kind: "fire", id: "9", at: T, coin: "BTC", mark: 105, n: 1, flags: [] });
    w.rec.sent.length = 0;
    await w.sink.onExit({ thesisId: 9n, at: new Date(T + 1000), data: { reason: "take" }, pnl: { usd: 12.5 } });
    const parsed = Spec.parse(w.sealed.spec);
    expect(w.rec.sent).toEqual([
      { queue: "reveal", msg: { thesisId: "9", part: "exit", canonical: hexOf(canonicalize(exitPart(parsed))), salt: w.sealed.saltX } },
      { queue: "stamp_leaf", msg: { thesisId: "9", kind: "EXIT", data: { reason: "take" }, at: new Date(T + 1000).toISOString() } },
      { queue: "stamp_leaf", msg: { thesisId: "9", kind: "PNL", data: { usd: 12.5 }, at: new Date(T + 1000).toISOString() } },
    ]);
    expect((await w.db.select().from(theses))[0].state).toBe("closed");
  });

  test("stop queue: owner checked, executor.stop, state stopped, message deleted", async () => {
    const w = await world();
    w.rec.inbox.set("stop", [
      { msgId: 1n, readCt: 1, message: { thesisId: "9", owner: "0xnotowner" } },
      { msgId: 2n, readCt: 1, message: { thesisId: "9", owner: OWNER.toUpperCase().replace("0X", "0x") } },
    ]);
    await w.sink.pollStops();
    expect(w.calls.stop).toEqual([[9n, OWNER]]);
    expect(w.rec.deleted.map((d) => d.msgId)).toEqual([1n, 2n]);
    expect((await w.db.select().from(theses))[0].state).toBe("stopped");
    expect(w.ev.size).toBe(0);
    expect(w.logs.some((l) => l.includes("non-owner"))).toBe(true);
  });
});
