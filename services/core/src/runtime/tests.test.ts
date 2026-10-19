import { describe, expect, test } from "bun:test";
import { newSalt, Spec } from "@proviso/dsl";
import { marketSnapshots, testRuns } from "@proviso/db";
import { sealSpec } from "@proviso/seal";
import { config } from "../evaluator/conditions.ts";
import { MIN, priceAbove, spec, T0 } from "../evaluator/testkit.ts";
import { framesFromRows } from "../tester/load.ts";
import { testId } from "../tester/testId.ts";
import { OWNER, recorder, setup } from "./fixture.ts";
import { TestJob } from "./tests.ts";

const REQ = "6f1c2a9e-0b3d-4c8e-9a7f-1d2e3f4a5b6c";
const NOW = T0 + 120 * MIN;

async function world() {
  const w = await setup();
  const rows = Array.from({ length: 120 }, (_, i) => ({
    coin: "BTC",
    ts: new Date(T0 + i * MIN),
    mark: i < 60 ? "95" : "105",
    oracle: i < 60 ? "95" : "105",
    funding: "0.0000125",
    oi: "10",
    volume24h: "5000",
  }));
  await w.db.insert(marketSnapshots).values(rows);
  const rec = recorder();
  const logs: string[] = [];
  const job = new TestJob({ db: w.db, specKey: w.priv, config: config({ minHlVolumeUsd: 1000 }), queueFor: () => rec.queue, now: () => NOW, log: (m, e) => logs.push(m + String(e ?? "")) });
  return { ...w, rows, rec, logs, job };
}

describe("TestJob", () => {
  test("a sealed request replays recorded history and upserts a done run keyed by testId", async () => {
    const w = await world();
    const s = spec(priceAbove("BTC", 100));
    const saltE = newSalt();
    const saltX = newSalt();
    const box = sealSpec(w.pub, { v: 1, spec: s, saltE, saltX });
    w.rec.inbox.set("test", [{ msgId: 7n, readCt: 1, message: { requestId: REQ, owner: OWNER.toUpperCase().replace("0X", "0x"), encSpec: Buffer.from(box).toString("base64"), days: 1, slippageBps: 10 } }]);
    await w.job.poll();

    const [run] = await w.db.select().from(testRuns);
    const { snapshotIds } = framesFromRows({ snapshots: (await w.db.select().from(marketSnapshots)), candles: [], fearGreed: [] });
    expect(run.testId).toBe(testId(Spec.parse(s), snapshotIds));
    expect(run).toMatchObject({ requestId: REQ, owner: OWNER, status: "done", snapshotIds, testerVersion: "1" });
    const result = run.result as any;
    expect(result.fires).toEqual([{ at: T0 + 60 * MIN, coin: "BTC", mark: 105 }]);
    expect(result.trades).toHaveLength(1);
    expect(result).toMatchObject({ days: 1, slippageBps: 10, coins: ["BTC"] });
    expect(result.coverage[0]).toMatchObject({ input: "price", supported: true });
    expect(Array.isArray(result.assumptions) && Array.isArray(result.unsimulated)).toBe(true);
    const text = JSON.stringify(run) + w.logs.join();
    expect(text).not.toContain(saltE.slice(2));
    expect(text).not.toContain(saltX.slice(2));
    expect(result.entry ?? result.spec).toBeUndefined();
    expect(w.rec.deleted).toEqual([{ queue: "test", msgId: 7n }]);

    // The same request again (redelivery) reuses the same testId row.
    w.rec.inbox.set("test", [{ msgId: 8n, readCt: 1, message: { requestId: REQ, owner: OWNER, encSpec: Buffer.from(box).toString("base64"), days: 1, slippageBps: 10 } }]);
    await w.job.poll();
    expect(await w.db.select().from(testRuns)).toHaveLength(1);
  });

  test("a bad box writes a failed run keyed failed:<requestId> and deletes the message", async () => {
    const w = await world();
    w.rec.inbox.set("test", [{ msgId: 9n, readCt: 1, message: { requestId: REQ, owner: OWNER, encSpec: Buffer.from("not a box").toString("base64"), days: 1, slippageBps: 10 } }]);
    await w.job.poll();
    expect(await w.db.select().from(testRuns)).toMatchObject([
      { testId: `failed:${REQ}`, requestId: REQ, owner: OWNER, status: "failed", result: { error: "spec could not be opened" } },
    ]);
    expect(w.rec.deleted).toHaveLength(1);
  });

  test("an unknown owner still gets a failed row; out-of-range days fail without replay", async () => {
    const w = await world();
    w.rec.inbox.set("test", [{ msgId: 1n, readCt: 1, message: { requestId: REQ, owner: "0xnobody", encSpec: "", days: 365, slippageBps: 10 } }]);
    await w.job.poll();
    expect(await w.db.select().from(testRuns)).toMatchObject([{ testId: `failed:${REQ}`, owner: null, result: { error: "days must be an integer 1-90" } }]);
  });
});
