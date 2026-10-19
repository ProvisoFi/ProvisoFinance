// Consumers that only need Postgres: sweep, notify, the epoch job, consumer startup (PGlite).
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { activity, callerShares, epochs, orders, pushSubscriptions, reveals, telegramLinks, theses, users, type Db } from "@proviso/db";
import { createTestDb } from "@proviso/db/testing";
import { eq } from "drizzle-orm";
import type { Address, Hex } from "viem";
import { verifyShare } from "../shares/epoch";
import type { ChainConfig } from "./chain";
import { sweep, UNREVEALED_FLAG } from "./consumers";
import { followerPositions, runEpoch } from "./epoch";
import { notifyHandler, sendersFromEnv } from "./notify";
import { startConsumers } from "./start";

const OWNER = "0x00000000000000000000000000000000000000aa";
const CALLER2 = "0x00000000000000000000000000000000000000bb";
const FOLLOWER = "0x00000000000000000000000000000000000000f1";
const H = 3_600_000;
const NOW = new Date("2026-10-19T12:00:00Z");
const ago = (h: number) => new Date(NOW.getTime() - h * H);

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
  await db.insert(users).values([{ address: OWNER }, { address: CALLER2 }, { address: FOLLOWER }]);
});

async function thesis(id: bigint, o: { expiresAt: Date; retiredAt?: Date; owner?: string }) {
  await db.insert(theses).values({
    id,
    owner: o.owner ?? OWNER,
    encSpec: new Uint8Array(4),
    entryHash: "0x01",
    exitHash: "0x02",
    mode: "alert",
    signedAt: ago(100),
    stampedAt: ago(100),
    sealTx: "0x03",
    expiresAt: o.expiresAt,
    retiredAt: o.retiredAt ?? null,
    state: o.retiredAt ? "retired" : "alert",
  });
}
const entryReveal = (thesisId: bigint) => db.select().from(reveals).where(eq(reveals.thesisId, thesisId)).then((r) => r[0]!);
const flagsOf = (id: bigint) => db.select().from(theses).where(eq(theses.id, id)).then((r) => r[0]!.flags);

describe("sweep", () => {
  test("flags overdue entry reveals once, moves retired deadlines, ignores revealed ones", async () => {
    await thesis(1n, { expiresAt: ago(1) }); // expired, never revealed → flag
    await thesis(2n, { expiresAt: ago(-48), retiredAt: ago(1) }); // retired 1 h ago → due in 23 h
    await thesis(3n, { expiresAt: ago(-48), retiredAt: ago(30) }); // retired 30 h ago → overdue now
    await thesis(4n, { expiresAt: ago(1) }); // expired but revealed
    await db.insert(reveals).values([
      { thesisId: 1n, part: "entry", dueAt: ago(1) },
      { thesisId: 2n, part: "entry", dueAt: ago(-48) },
      { thesisId: 3n, part: "entry", dueAt: ago(-48) },
      { thesisId: 4n, part: "entry", dueAt: ago(1), revealedAt: ago(2), kind: "FIRED" },
    ]);

    expect((await sweep(db, NOW)).sort()).toEqual([1n, 3n]);
    expect((await entryReveal(2n)).dueAt).toEqual(ago(-23));
    expect((await entryReveal(3n)).dueAt).toEqual(ago(6));
    expect(await flagsOf(1n)).toEqual([UNREVEALED_FLAG]);
    expect(await flagsOf(2n)).toEqual([]);
    expect(await flagsOf(4n)).toEqual([]);
    const acts = await db.select().from(activity);
    expect(acts.map((a) => [a.kind, (a.payload as { thesisId: string }).thesisId]).sort()).toEqual([
      [UNREVEALED_FLAG, "1"],
      [UNREVEALED_FLAG, "3"],
    ]);

    expect(await sweep(db, NOW)).toEqual([]); // once only
    expect(await db.select().from(activity)).toHaveLength(2);
    expect(await flagsOf(1n)).toEqual([UNREVEALED_FLAG]);
  });
});

describe("notify", () => {
  const msg = { address: OWNER.toUpperCase().replace("0X", "0x"), title: "Fired", body: "HYPE > 40", url: "https://x/t/1" };

  test("no config: no channels, nothing sent, no error", async () => {
    expect(sendersFromEnv({})).toEqual({});
    await db.insert(telegramLinks).values({ address: OWNER, chatId: 5n });
    await notifyHandler(db, {})(msg);
  });

  test("sends to every subscription and Telegram; drops gone subscriptions", async () => {
    const keys = { p256dh: "p", auth: "a" };
    await db.insert(pushSubscriptions).values([
      { endpoint: "https://push/ok", address: OWNER, keys },
      { endpoint: "https://push/gone", address: OWNER, keys },
      { endpoint: "https://push/flaky", address: OWNER, keys },
    ]);
    await db.insert(telegramLinks).values({ address: OWNER, chatId: 77n });
    const push = mock(async (sub: { endpoint: string }, _payload: string) => {
      if (sub.endpoint.endsWith("gone")) throw Object.assign(new Error("Gone"), { statusCode: 410 });
      if (sub.endpoint.endsWith("flaky")) throw Object.assign(new Error("Server"), { statusCode: 500 });
    });
    const telegram = mock(async () => {});
    const log = mock(() => {});
    await notifyHandler(db, { push, telegram }, log)(msg);

    expect(push).toHaveBeenCalledTimes(3);
    expect(JSON.parse(push.mock.calls[0]![1])).toEqual({ title: "Fired", body: "HYPE > 40", url: "https://x/t/1" });
    const left = (await db.select().from(pushSubscriptions)).map((s) => s.endpoint).sort();
    expect(left).toEqual(["https://push/flaky", "https://push/ok"]);
    expect(telegram.mock.calls[0] as unknown).toEqual([77n, "Fired\nHYPE > 40\nhttps://x/t/1"]);
    expect(log).toHaveBeenCalledTimes(1); // the 500, not the 410
  });
});

describe("runEpoch", () => {
  const START = ago(7 * 24);
  async function order(o: { thesisId: bigint; reduceOnly: boolean; filled: string; px: string; at: Date }) {
    await db.insert(orders).values({
      thesisId: o.thesisId,
      account: FOLLOWER,
      role: "follower",
      wave: 1,
      venue: "hl",
      coin: "HYPE",
      side: o.reduceOnly ? "sell" : "buy",
      size: o.filled,
      px: o.px,
      reduceOnly: o.reduceOnly,
      status: "filled",
      filledSize: o.filled,
      avgPx: o.px,
      createdAt: o.at,
      updatedAt: o.at,
    });
  }

  test("builds positions from follower orders, stores shares, posts once", async () => {
    await thesis(1n, { expiresAt: ago(-24), owner: OWNER });
    await thesis(2n, { expiresAt: ago(-24), owner: CALLER2 });
    await order({ thesisId: 1n, reduceOnly: false, filled: "10", px: "40", at: ago(48) }); // $400 for 24 h
    await order({ thesisId: 1n, reduceOnly: true, filled: "10", px: "44", at: ago(24) });
    await order({ thesisId: 2n, reduceOnly: false, filled: "2", px: "50", at: ago(10) }); // $100, still open
    await order({ thesisId: 2n, reduceOnly: false, filled: "0", px: "50", at: ago(200) }); // unfilled: ignored

    const positions = await followerPositions(db);
    expect(positions.map((p) => [p.caller, p.notionalUsd, p.openedAt, p.closedAt])).toEqual([
      [OWNER, 400, ago(48), ago(24)],
      [CALLER2, 100, ago(10), null],
    ]);

    const post = mock(async () => "0xabc" as Hex);
    const r = await runEpoch(db, { epoch: 1n, start: START, end: NOW, pool: 1_000_000n, cap: 1_000_000n, post });
    // weights 400×24 vs 100×10 → 9600 : 1000
    expect(r).toMatchObject({ status: "posted", total: 905_660n + 94_339n, tx: "0xabc" });
    expect(post.mock.calls[0] as unknown).toEqual([1n, (r as { root: Hex }).root, 999_999n]);
    const [e] = await db.select().from(epochs);
    expect(e).toMatchObject({ epoch: 1n, totalUsdg: "999999", tx: "0xabc" });
    const shares = await db.select().from(callerShares);
    expect(shares.map((s) => [s.caller, s.amountUsdg]).sort()).toEqual([
      [OWNER, "905660"],
      [CALLER2, "94339"],
    ]);
    for (const s of shares) expect(verifyShare(e!.root as Hex, s.caller as Address, BigInt(s.amountUsdg), s.proof as Hex[])).toBe(true);

    expect(await runEpoch(db, { epoch: 1n, start: START, end: NOW, pool: 1n, cap: 1n, post })).toMatchObject({ status: "already-posted" });
    expect(post).toHaveBeenCalledTimes(1);
  });

  test("a failed post is retried with the stored root; nothing qualifying stores nothing", async () => {
    expect(await runEpoch(db, { epoch: 2n, start: START, end: NOW, pool: 100n, cap: 100n, post: async () => "0x1" })).toEqual({ status: "empty" });
    expect(await db.select().from(epochs)).toHaveLength(0);

    await thesis(1n, { expiresAt: ago(-24) });
    await order({ thesisId: 1n, reduceOnly: false, filled: "1", px: "1", at: ago(5) });
    const job = { epoch: 3n, start: START, end: NOW, pool: 100n, cap: 100n };
    await expect(runEpoch(db, { ...job, post: async () => Promise.reject(new Error("rpc down")) })).rejects.toThrow("rpc down");
    const post = mock(async () => "0x2" as Hex);
    expect(await runEpoch(db, { ...job, pool: 5n, post })).toMatchObject({ status: "posted", total: 100n });
  });
});

describe("startConsumers", () => {
  const signal = AbortSignal.abort(); // loops exit at once; this only checks wiring
  test("without chain or notify config only the db consumers run", () => {
    const logs: string[] = [];
    const r = startConsumers(db, { chain: null, senders: {}, signal, log: (m) => logs.push(m) });
    expect(r.names).toEqual(["stamp_leaf", "sweep"]);
    expect(logs.some((l) => l.includes("notify consumer off"))).toBe(true);
  });

  test("chain without deployed addresses keeps the chain consumers off, with a log line", () => {
    const logs: string[] = [];
    const chain = { clients: {}, deployment: {} } as unknown as ChainConfig;
    const r = startConsumers(db, { chain, senders: { telegram: async () => {} }, signal, log: (m) => logs.push(m) });
    expect(r.names).toEqual(["stamp_leaf", "sweep", "notify"]);
    expect(logs.filter((l) => l.includes("not deployed yet"))).toHaveLength(2);

    const deployed = { clients: {}, deployment: { thesisSeal: OWNER, stampRoots: OWNER } } as unknown as ChainConfig;
    expect(startConsumers(db, { chain: deployed, senders: {}, signal, log: () => {} }).names).toEqual([
      "stamp_leaf",
      "sweep",
      "stamp",
      "reveal",
      "stamp_root",
    ]);
  });
});

describe("chainFromEnv", () => {
  test("refuses non-testnet networks; no relayer key means chain consumers off", async () => {
    const { chainFromEnv } = await import("./chain");
    const prev = process.env.CHAIN_NETWORK;
    try {
      process.env.CHAIN_NETWORK = "mainnet";
      expect(() => chainFromEnv({}, () => {})).toThrow("Unsupported chain network");
      process.env.CHAIN_NETWORK = "testnet";
      const logs: string[] = [];
      expect(chainFromEnv({}, (m) => logs.push(m))).toBeNull();
      expect(logs[0]).toContain("RELAYER_PRIVATE_KEY unset");
      const cfg = chainFromEnv({ RELAYER_PRIVATE_KEY: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" });
      expect(cfg!.clients.account.address).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
      expect(cfg!.clients.public.chain!.id).toBe(46630);
    } finally {
      if (prev === undefined) delete process.env.CHAIN_NETWORK;
      else process.env.CHAIN_NETWORK = prev;
    }
  });
});
