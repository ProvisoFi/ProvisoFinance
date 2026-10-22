import { describe, expect, test } from "bun:test";
import { activity, fires, reveals, theses, xHandles } from "@proviso/db";
import { canonicalize, entryPart, Spec } from "@proviso/dsl";
import { bytesToHex } from "@noble/hashes/utils.js";
import { eq } from "drizzle-orm";
import { config } from "../evaluator/conditions.ts";
import { Evaluator } from "../evaluator/engine.ts";
import type { MachineEvent } from "../evaluator/machine.ts";
import { hl, priceAbove, spec } from "../evaluator/testkit.ts";
import { insertThesis, OWNER, recorder, setup } from "./fixture.ts";
import { IdeaRegistry } from "./ideas.ts";
import { PostsFeed } from "./posts.ts";

const retire = (db: Awaited<ReturnType<typeof setup>>["db"], id: bigint) =>
  db.update(theses).set({ state: "retired", retiredAt: new Date() }).where(eq(theses.id, id));

describe("retire", () => {
  test("queues the RETIRED entry reveal once, records activity and drops the plaintext", async () => {
    const { db, priv, pub } = await setup();
    const sealed = await insertThesis(db, pub, 1n);
    const rec = recorder();
    const ev = new Evaluator(() => {});
    const reg = new IdeaRegistry({ db, evaluator: ev, specKey: priv, queueFor: () => rec.queue });
    await reg.sync();
    await retire(db, 1n);
    expect((await reg.sync()).removed).toEqual(["1"]);
    expect(rec.sent).toEqual([
      {
        queue: "reveal",
        msg: { thesisId: "1", part: "entry", kind: "RETIRED", canonical: `0x${bytesToHex(canonicalize(entryPart(Spec.parse(sealed.spec))))}`, salt: sealed.saltE },
      },
    ]);
    expect(await db.select().from(activity)).toMatchObject([{ kind: "retired", payload: { thesisId: "1" } }]);
    expect(reg.get(1n)).toBeUndefined();
    expect(ev.size).toBe(0);
    await reg.sync();
    expect(rec.sent).toHaveLength(1); // once
  });

  test("a retire the API already recorded gets no second activity row (one notification)", async () => {
    const { db, priv, pub } = await setup();
    await insertThesis(db, pub, 12n);
    const reg = new IdeaRegistry({ db, evaluator: new Evaluator(() => {}), specKey: priv, queueFor: () => recorder().queue });
    await reg.sync();
    await db.insert(activity).values({ address: OWNER, kind: "retired", payload: { thesisId: "12", tx: "0xabc" } });
    await retire(db, 12n);
    await reg.sync();
    expect((await db.select().from(activity)).filter((a) => a.kind === "retired")).toHaveLength(1);
  });

  test("no reveal when the entry was already revealed; a fired idea stays in memory until its exit", async () => {
    const { db, priv, pub } = await setup();
    await insertThesis(db, pub, 2n, { state: "fired" });
    await db.insert(fires).values({ thesisId: 2n, firedAt: new Date(), refMark: "100" });
    await db.insert(reveals).values({ thesisId: 2n, part: "entry", kind: "FIRED", dueAt: new Date(), revealedAt: new Date() });
    const rec = recorder();
    const reg = new IdeaRegistry({ db, evaluator: new Evaluator(() => {}), specKey: priv, queueFor: () => rec.queue });
    await reg.sync();
    await retire(db, 2n);
    expect((await reg.sync()).removed).toEqual([]);
    expect(rec.sent).toEqual([]);
    expect(await db.select().from(activity)).toMatchObject([{ kind: "retired" }]);
    expect(reg.get(2n)?.saltX).toBeDefined();
    await reg.sync();
    expect(reg.get(2n)).toBeDefined();
    reg.exited(2n);
    expect(reg.get(2n)).toBeUndefined();
  });

  test("after a restart a retired idea with an unrevealed exit is reloaded, then dropped if flat", async () => {
    const { db, priv, pub } = await setup();
    await insertThesis(db, pub, 7n, { state: "retired" });
    await db.insert(fires).values({ thesisId: 7n, firedAt: new Date(), refMark: "100" });
    await insertThesis(db, pub, 8n, { state: "retired" }); // never fired: stays out
    const ev = new Evaluator(() => {});
    const reg = new IdeaRegistry({ db, evaluator: ev, specKey: priv, queueFor: () => recorder().queue });
    await reg.sync();
    expect(reg.get(7n)?.saltX).toBeDefined();
    expect(reg.get(8n)).toBeUndefined();
    expect(ev.size).toBe(0); // never evaluated again
    await reg.sync();
    expect(reg.get(7n)).toBeDefined(); // not dropped as "gone"
    reg.keepRetired([7n]);
    expect(reg.get(7n)).toBeDefined();
    reg.keepRetired([]);
    expect(reg.get(7n)).toBeUndefined();
  });
});

describe("stamp flags", () => {
  test("trivially_true is stored once the first known evaluation right after the stamp holds", async () => {
    const { db, priv, pub } = await setup();
    const now = Date.now();
    await insertThesis(db, pub, 9n, { stampedAt: new Date(now) }); // BTC > 100
    await insertThesis(db, pub, 10n, { stampedAt: new Date(now), spec: spec(priceAbove("BTC", 1000)) });
    await insertThesis(db, pub, 11n); // stamped and recorded long ago (a restart): never judged
    await db.update(theses).set({ createdAt: new Date("2026-10-19T00:00:00Z") }).where(eq(theses.id, 11n));
    const ev = new Evaluator(() => {});
    const reg = new IdeaRegistry({ db, evaluator: ev, specKey: priv, queueFor: () => recorder().queue });
    await reg.sync();
    const flags = async (id: bigint) => (await db.select().from(theses).where(eq(theses.id, id)))[0]!.flags;
    await reg.checkStampFlags(now + 1000); // no market data yet: unknown, keep waiting
    expect(await flags(9n)).toEqual([]);
    ev.view.apply(hl("BTC", now + 4000, 150));
    ev.view.apply(hl("ETH", now + 4000, 1)); // unrelated
    await reg.checkStampFlags(now + 5000);
    await reg.checkStampFlags(now + 6000); // once
    expect(await flags(9n)).toEqual(["trivially_true"]);
    expect(await flags(10n)).toEqual([]);
    expect(await flags(11n)).toEqual([]);
  });

  test("a seal confirmed 5 min after its stamp is judged from the first state after it is recorded", async () => {
    const { db, priv, pub } = await setup();
    const now = Date.now();
    const late = new Date(now - 5 * 60_000);
    await insertThesis(db, pub, 13n, { stampedAt: late }); // BTC > 100, recorded just now
    await insertThesis(db, pub, 14n, { stampedAt: late, spec: spec(priceAbove("BTC", 1000)) });
    const ev = new Evaluator(() => {});
    const reg = new IdeaRegistry({ db, evaluator: ev, specKey: priv, queueFor: () => recorder().queue });
    await reg.sync();
    const flags = async (id: bigint) => (await db.select().from(theses).where(eq(theses.id, id)))[0]!.flags;
    ev.view.apply(hl("BTC", now + 4000, 150));
    await reg.checkStampFlags(now + 5000);
    expect(await flags(13n)).toEqual(["trivially_true"]);
    expect(await flags(14n)).toEqual([]);
  });
});

describe("x handles and posts", () => {
  const postSpec = (account: string) =>
    spec({ post: { account, contains: ["launch", "BTC"] } }, { fire: "repeat" });

  test("registering upserts handles (lowercase, no @); unused handles are deleted", async () => {
    const { db, priv, pub } = await setup();
    await db.insert(xHandles).values({ handle: "stale_one" });
    await insertThesis(db, pub, 3n, { spec: postSpec("SomeCaller") });
    await insertThesis(db, pub, 4n, { spec: postSpec("somecaller") });
    await insertThesis(db, pub, 5n, { spec: spec({ any: [priceAbove("BTC", 1), { post: { account: "Other_X", contains: ["x"] } }] }) });
    const reg = new IdeaRegistry({ db, evaluator: new Evaluator(() => {}), specKey: priv, queueFor: () => recorder().queue });
    await reg.sync();
    const handles = async () => (await db.select().from(xHandles)).map((r) => r.handle).sort();
    expect(await handles()).toEqual(["other_x", "somecaller"]);
    expect(reg.postHandles()).toEqual(["other_x", "somecaller"]);
    await db.update(theses).set({ state: "stopped" }).where(eq(theses.id, 5n));
    await reg.sync();
    expect(await handles()).toEqual(["somecaller"]);
    await db.update(theses).set({ state: "stopped" }).where(eq(theses.id, 3n));
    await reg.sync();
    expect(await handles()).toEqual(["somecaller"]); // still used by 4
    await db.update(theses).set({ state: "stopped" }).where(eq(theses.id, 4n));
    await reg.sync();
    expect(await handles()).toEqual([]);
  });

  test("a posts message makes a post condition fire through the evaluator", async () => {
    const { db, priv, pub } = await setup();
    await insertThesis(db, pub, 6n, { spec: postSpec("SomeCaller") });
    const events: MachineEvent[] = [];
    const ev = new Evaluator((e) => events.push(e));
    const reg = new IdeaRegistry({ db, evaluator: ev, specKey: priv, config: config({ minHlVolumeUsd: 1000 }), queueFor: () => recorder().queue });
    await reg.sync();
    const rec = recorder();
    let now = Date.parse("2026-10-20T12:00:00Z");
    const logs: string[] = [];
    const feed = new PostsFeed({ db, evaluator: ev, handles: () => reg.postHandles(), queueFor: () => rec.queue, now: () => now, log: (m) => logs.push(m) });
    ev.apply(hl("BTC", now, 100), now); // trigger mark for the action coin
    await feed.poll(); // heartbeat: known false
    expect(events).toEqual([]);
    now += 5000;
    ev.apply(hl("BTC", now, 101), now);
    rec.inbox.set("posts", [
      { msgId: 1n, readCt: 1, message: { handle: "SomeCaller", id: "p1", text: "We LAUNCH on btc today", createdAt: new Date(now - 1000).toISOString() } },
      { msgId: 2n, readCt: 1, message: { handle: "bad handle!", id: "p2", text: "x", createdAt: "nope" } },
    ]);
    await feed.poll();
    expect(events).toMatchObject([{ kind: "fire", id: "6", coin: "BTC", mark: 101 }]);
    expect(rec.deleted.map((d) => d.msgId)).toEqual([1n, 2n]);
    expect(logs).toEqual(["posts: malformed message 2 dropped"]);
    expect(logs.join()).not.toContain("LAUNCH");
  });
});
