// The runtime's wiring: the pgmq queue helper against SQL (PGlite has no pgmq, so a minimal
// emulation of its send/read/delete is installed), and startRuntime end to end with every outside
// service stubbed: fetch answers Fear & Greed and Hyperliquid /info, and refuses anything else, so
// no real network is ever touched.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { agentKeys, swapKeys, users, type Db } from "@proviso/db";
import { createTestDb } from "@proviso/db/testing";
import { NETWORKS } from "@proviso/hl";
import { sql } from "drizzle-orm";
import { startRuntime } from "./index.ts";
import { FNG_URL } from "./market.ts";
import { NoopExecutor, pgmq, type Executes } from "./ports.ts";

const PGMQ = [
  `create schema if not exists pgmq`,
  `create table pgmq.messages (msg_id bigserial primary key, queue_name text not null, read_ct int not null default 0, vt timestamptz not null default now(), message jsonb)`,
  `create function pgmq.send(queue_name text, msg jsonb) returns setof bigint language sql as $$
     insert into pgmq.messages (queue_name, message) values ($1, $2) returning msg_id $$`,
  `create function pgmq.read(queue_name text, vt integer, qty integer) returns table (msg_id bigint, read_ct int, message jsonb) language sql as $$
     update pgmq.messages m set read_ct = m.read_ct + 1, vt = now() + make_interval(secs => $2)
     where m.msg_id in (select x.msg_id from pgmq.messages x where x.queue_name = $1 and x.vt <= now() order by x.msg_id limit $3)
     returning m.msg_id, m.read_ct, m.message $$`,
  `create function pgmq.delete(queue_name text, msg_id bigint) returns boolean language sql as $$
     with d as (delete from pgmq.messages m where m.queue_name = $1 and m.msg_id = $2 returning 1) select exists (select 1 from d) $$`,
];
async function dbWithQueues(): Promise<Db> {
  const db = await createTestDb();
  for (const s of PGMQ) await db.execute(sql.raw(s));
  return db;
}
const rows = <T>(r: unknown) => ((r as { rows?: T[] }).rows ?? (r as T[]));
const queued = async (db: Db, q: string) =>
  Number(rows<{ n: number }>(await db.execute(sql`select count(*)::int as n from pgmq.messages where queue_name = ${q}`))[0]!.n);

async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 8_000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

describe("pgmq", () => {
  test("send, read with a visibility timeout, delete", async () => {
    const db = await dbWithQueues();
    const q = pgmq(db);
    await q.send("agent", { owner: "0xabc" });
    await q.send("agent", { owner: "0xdef" });
    await q.send("other", { x: 1 });
    const first = await q.read<{ owner: string }>("agent", 60, 1);
    expect(first).toEqual([{ msgId: expect.any(BigInt), readCt: 1, message: { owner: "0xabc" } }]);
    // Invisible while its timeout runs: the next read gets the second message only.
    const next = await q.read<{ owner: string }>("agent", 60, 5);
    expect(next.map((m) => m.message.owner)).toEqual(["0xdef"]);
    await q.delete("agent", first[0]!.msgId);
    await q.delete("agent", next[0]!.msgId);
    expect(await queued(db, "agent")).toBe(0);
    expect(await queued(db, "other")).toBe(1);
  });

  test("a vt of 0 redelivers with a rising read count; postgres-js style row arrays parse too", async () => {
    const db = await dbWithQueues();
    const q = pgmq(db);
    await q.send("test", { n: 1 });
    await q.read("test", 0, 1);
    expect((await q.read("test", 0, 1))[0]!.readCt).toBe(2);
    // postgres-js returns the rows array itself, with msg_id as a string.
    const arr: Executes = { execute: async () => [{ msg_id: "7", read_ct: "3", message: { a: 1 } }] };
    expect(await pgmq(arr).read("q", 1, 1)).toEqual([{ msgId: 7n, readCt: 3, message: { a: 1 } }]);
    expect(await pgmq({ execute: async () => ({}) }).read("q", 1, 1)).toEqual([]);
  });

  test("NoopExecutor accepts everything and trades nothing", async () => {
    const e = new NoopExecutor();
    await e.onFire();
    e.onMark();
    await e.stop();
  });
});

describe("startRuntime", () => {
  const realFetch = globalThis.fetch;
  const realWs = globalThis.WebSocket;
  const ENV = ["CHAIN_NETWORK", "RHC_RPC_KEY", "RHC_RPC_URL"] as const;
  const savedEnv = ENV.map((k) => process.env[k]);
  const urls: string[] = [];
  const infoTypes: string[] = [];
  const sockets: string[] = [];
  const META = { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }, { name: "OLD", szDecimals: 0, maxLeverage: 3, isDelisted: true }] };
  const CTX = { funding: "0.00001", openInterest: "1", prevDayPx: "1", dayNtlVlm: "1", premium: null, oraclePx: "1", markPx: "1", midPx: null, impactPxs: null, dayBaseVlm: "1" };

  beforeAll(() => {
    process.env.CHAIN_NETWORK = "testnet";
    delete process.env.RHC_RPC_KEY;
    delete process.env.RHC_RPC_URL;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      urls.push(url);
      const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
      if (url === FNG_URL) return json({ data: [{ value: "42", timestamp: String(Math.floor(Date.now() / 1000)) }] });
      if (url === `${NETWORKS.testnet.apiUrl}/info`) {
        const type = (JSON.parse(String(init?.body)) as { type: string }).type;
        infoTypes.push(type);
        if (type === "meta") return json(META);
        if (type === "metaAndAssetCtxs") return json([META, [CTX, CTX]]);
        return json([]);
      }
      return new Response("blocked in tests", { status: 503 });
    }) as typeof fetch;
    globalThis.WebSocket = class {
      readyState = 0;
      onopen = null;
      onmessage = null;
      onclose = null;
      onerror = null;
      constructor(url: string) {
        sockets.push(url);
      }
      send() {}
      close() {}
    } as unknown as typeof WebSocket;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
    globalThis.WebSocket = realWs;
    ENV.forEach((k, i) => (savedEnv[i] === undefined ? delete process.env[k] : (process.env[k] = savedEnv[i])));
  });

  const key = () => crypto.getRandomValues(new Uint8Array(32));

  test("without seal keys: nothing trades, fires aren't held, market inputs flow into the evaluator", async () => {
    const db = await dbWithQueues();
    const logs: string[] = [];
    const rt = startRuntime({ db, specKey: key(), net: NETWORKS.testnet, log: (m) => void logs.push(m) });
    try {
      expect(logs).toContain("runtime: started on Hyperliquid testnet and Robinhood Chain testnet, HL volume floor $1000");
      await until(() => rt.evaluator.view.fearGreed() !== undefined, "fear & greed");
      expect(rt.evaluator.view.fearGreed()?.value).toBe(42);
      await until(() => infoTypes.includes("metaAndAssetCtxs"), "hl meta");
      expect(rt.market.coins).toEqual([]); // no live ideas, no subscriptions
      expect(rt.onExit).toBe(rt.sink.onExit);
      // No restore without positions to rebuild.
      await Bun.sleep(100);
      expect(logs.some((l) => l.includes("restored"))).toBe(false);
    } finally {
      rt.stop();
    }
  });

  test("with seal keys: restores before fires, then turns agent and swap key requests into sealed keys", async () => {
    const db = await dbWithQueues();
    const A = "0x00000000000000000000000000000000000000aa";
    const B = "0x00000000000000000000000000000000000000bb";
    const WALLET = "0x00000000000000000000000000000000000000Cc";
    await db.insert(users).values([{ address: A, limits: {} }, { address: B, limits: {} }]);
    const q = pgmq(db);
    await q.send("agent", { owner: A.toUpperCase().replace("0X", "0x") }); // owners are lowercased
    await q.send("agent", { owner: B, kind: "swap", account: "0xnot-an-address" }); // falls back to the owner
    await q.send("agent", { owner: A, kind: "swap", account: WALLET });

    const logs: string[] = [];
    const rt = startRuntime({ db, specKey: key(), agentSealKey: key(), swapSealKey: key(), net: NETWORKS.testnet, log: (m) => void logs.push(m) });
    try {
      await until(() => logs.includes("runtime: restored 0 open idea(s) + 0 swap position(s), skipped 0"), "restore");
      await until(async () => (await queued(db, "agent")) === 0, "agent queue drained");
      const agents = await db.select().from(agentKeys);
      expect(agents.map((r) => [r.address, r.version, r.approvedAt])).toEqual([[A, 1, null]]);
      expect(agents[0]!.agentAddr).toMatch(/^0x[0-9a-fA-F]{40}$/);
      const swaps = Object.fromEntries((await db.select().from(swapKeys)).map((r) => [r.address, r]));
      expect(swaps[A]!.account).toBe(WALLET.toLowerCase());
      expect(swaps[B]!.account).toBe(B);
      expect(swaps[A]!.registeredAt).toBeNull(); // nothing is live until the user signs the setup
      expect(JSON.stringify(swaps[A]!.sealed)).not.toContain("privateKey");
      // The executor read HL meta for the restore; nothing else outside was called.
      expect(infoTypes).toContain("meta");
      for (const u of urls) expect([FNG_URL, `${NETWORKS.testnet.apiUrl}/info`]).toContain(u);
      expect(sockets).toEqual([]);
      expect(logs.filter((l) => l.includes("failed"))).toEqual([]);
    } finally {
      rt.stop();
    }
    // Stopped: a later request stays queued.
    await q.send("agent", { owner: B });
    await Bun.sleep(2_500);
    expect(await queued(db, "agent")).toBe(1);
    expect((await db.select().from(agentKeys)).length).toBe(1);
  });

  test("a key request that keeps failing (unknown user) doesn't hold the valid requests behind it", async () => {
    const db = await dbWithQueues();
    const A = "0x00000000000000000000000000000000000000aa";
    await db.insert(users).values({ address: A, limits: {} });
    const q = pgmq(db);
    await q.send("agent", { owner: "0x00000000000000000000000000000000000000ff" }); // no users row: always throws
    await q.send("agent", { owner: A });
    const logs: string[] = [];
    const rt = startRuntime({ db, specKey: key(), agentSealKey: key(), swapSealKey: key(), net: NETWORKS.testnet, log: (m) => void logs.push(m) });
    try {
      await until(async () => (await db.select().from(agentKeys)).length === 1, "valid request served");
      expect((await db.select().from(agentKeys))[0]!.address).toBe(A);
      expect(logs.some((l) => l.includes("will retry"))).toBe(true);
    } finally {
      rt.stop();
    }
  });
});
