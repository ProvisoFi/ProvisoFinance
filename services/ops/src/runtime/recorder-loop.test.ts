// The B0 recorder loop on PGlite with a stubbed fetch: snapshots and Fear & Greed land, history past
// 100 days is pruned, and one failing source doesn't stop the others.
import { afterEach, expect, spyOn, test } from "bun:test";
import { fearGreed, marketSnapshots } from "@proviso/db";
import { createTestDb } from "@proviso/db/testing";
import { FNG_URL, HL_INFO, type MetaAndCtxs } from "../recorder";
import { startRecorder } from "./recorder-loop";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const meta: MetaAndCtxs = [{ universe: [{ name: "BTC" }] }, [{ markPx: "100000", oraclePx: "99990", dayNtlVlm: "900000000" }]];
function stubFetch(o: { hlStatus?: number; fngStatus?: number } = {}) {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push(String(url));
    if (url === HL_INFO) {
      expect(JSON.parse(String(init?.body))).toEqual({ type: "metaAndAssetCtxs" });
      return Response.json(meta, { status: o.hlStatus ?? 200 });
    }
    if (url === FNG_URL) return Response.json({ data: [{ value: "42", timestamp: "1760875200" }] }, { status: o.fngStatus ?? 200 });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return calls;
}
const until = async (ok: () => Promise<boolean>) => {
  for (let i = 0; i < 500 && !(await ok()); i++) await Bun.sleep(5);
};

test("records a minute-bucketed snapshot and Fear & Greed, and prunes snapshots older than 100 days", async () => {
  const db = await createTestDb();
  const old = new Date(Date.now() - 101 * 86_400_000);
  await db.insert(marketSnapshots).values({ coin: "OLD", ts: old, mark: "1" });
  stubFetch();
  const log = spyOn(console, "log").mockImplementation(() => {});
  const stop = startRecorder(db, 60_000);
  try {
    await until(async () => (await db.select().from(marketSnapshots)).some((r) => r.coin === "BTC") && (await db.select().from(fearGreed)).length > 0 && !(await db.select().from(marketSnapshots)).some((r) => r.coin === "OLD"));
  } finally {
    stop();
    log.mockRestore();
  }
  const snaps = await db.select().from(marketSnapshots);
  expect(snaps.map((r) => r.coin)).toEqual(["BTC"]);
  expect(snaps[0]!.ts.getSeconds()).toBe(0);
  expect(snaps[0]!.ts.getMilliseconds()).toBe(0);
  expect(Number(snaps[0]!.mark)).toBe(100000);
  expect(await db.select().from(fearGreed)).toEqual([{ ts: new Date(1760875200 * 1000), value: 42 }]);
});

test("a failing Hyperliquid read is logged; Fear & Greed still records", async () => {
  const db = await createTestDb();
  stubFetch({ hlStatus: 502 });
  const errors: string[] = [];
  const err = spyOn(console, "error").mockImplementation((m: string, e?: unknown) => void errors.push(`${m}: ${e instanceof Error ? e.message : e}`));
  const log = spyOn(console, "log").mockImplementation(() => {});
  const stop = startRecorder(db, 60_000);
  try {
    await until(async () => errors.length > 0 && (await db.select().from(fearGreed)).length > 0);
  } finally {
    stop();
    err.mockRestore();
    log.mockRestore();
  }
  expect(errors).toEqual(["ops: hl snapshot failed: Hyperliquid info 502"]);
  expect(await db.select().from(marketSnapshots)).toEqual([]);
  expect(await db.select().from(fearGreed)).toHaveLength(1);
});

test("a failing Fear & Greed read is logged and throws nothing into the loop", async () => {
  const db = await createTestDb();
  stubFetch({ fngStatus: 503 });
  const errors: string[] = [];
  const err = spyOn(console, "error").mockImplementation((m: string, e?: unknown) => void errors.push(`${m}: ${e instanceof Error ? e.message : e}`));
  const log = spyOn(console, "log").mockImplementation(() => {});
  const stop = startRecorder(db, 60_000);
  try {
    await until(async () => errors.length > 0 && (await db.select().from(marketSnapshots)).length > 0);
  } finally {
    stop();
    err.mockRestore();
    log.mockRestore();
  }
  expect(errors).toEqual(["ops: fear & greed failed: Fear & Greed 503"]);
  expect(await db.select().from(fearGreed)).toEqual([]);
});
