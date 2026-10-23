// Consumers that only need Postgres: sweep, notify, the epoch job, consumer startup (PGlite).
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { activity, callerShares, epochs, linkFlags, orders, pushSubscriptions, reveals, telegramLinks, theses, users, type Db } from "@proviso/db";
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
      { endpoint: "https://fcm.googleapis.com/fcm/send/ok", address: OWNER, keys },
      { endpoint: "https://fcm.googleapis.com/fcm/send/gone", address: OWNER, keys },
      { endpoint: "https://fcm.googleapis.com/fcm/send/flaky", address: OWNER, keys },
      // Not a push service: dropped without ever being called.
      { endpoint: "https://169.254.169.254/latest/meta-data", address: OWNER, keys },
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
    expect(left).toEqual(["https://fcm.googleapis.com/fcm/send/flaky", "https://fcm.googleapis.com/fcm/send/ok"]);
    expect(push.mock.calls.some(([sub]) => sub.endpoint.includes("169.254"))).toBe(false);
    expect(telegram.mock.calls[0] as unknown).toEqual([77n, "Fired\nHYPE > 40\nhttps://x/t/1"]);
    expect(log).toHaveBeenCalledTimes(1); // the 500, not the 410
  });
});

/** Fake Hyperliquid info: fills and ledger updates per (lowercase) account. */
const venue = (o: { fills?: Record<string, unknown[]>; ledger?: Record<string, unknown[]> } = {}) => ({
  post: async <T>(b: Record<string, unknown>) => ((b.type === "userFillsByTime" ? o.fills : o.ledger)?.[b.user as string] ?? []) as T,
});
const info = venue();

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
    const r = await runEpoch(db, { epoch: 1n, start: START, end: NOW, pool: 1_000_000n, cap: 1_000_000n, post, info });
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

    expect(await runEpoch(db, { epoch: 1n, start: START, end: NOW, pool: 1n, cap: 1n, post, info })).toMatchObject({ status: "already-posted" });
    expect(post).toHaveBeenCalledTimes(1);
  });

  test("a failed post is retried with the stored root; nothing qualifying stores nothing", async () => {
    expect(await runEpoch(db, { epoch: 2n, start: START, end: NOW, pool: 100n, cap: 100n, post: async () => "0x1", info })).toEqual({ status: "empty" });
    expect(await db.select().from(epochs)).toHaveLength(0);

    await thesis(1n, { expiresAt: ago(-24) });
    await order({ thesisId: 1n, reduceOnly: false, filled: "1", px: "1", at: ago(5) });
    const job = { epoch: 3n, start: START, end: NOW, pool: 100n, cap: 100n, info };
    await expect(runEpoch(db, { ...job, post: async () => Promise.reject(new Error("rpc down")) })).rejects.toThrow("rpc down");
    const post = mock(async () => "0x2" as Hex);
    expect(await runEpoch(db, { ...job, pool: 5n, post })).toMatchObject({ status: "posted", total: 100n });
  });

  const fill = (o: { at: Date; start: string; side: "A" | "B"; sz: string; cloid?: string }) => ({
    coin: "HYPE", px: "40", sz: o.sz, side: o.side, time: o.at.getTime(), startPosition: o.start, cloid: o.cloid,
  });

  test("a copy closed straight on Hyperliquid stops counting at that close", async () => {
    await thesis(1n, { expiresAt: ago(-24) });
    await order({ thesisId: 1n, reduceOnly: false, filled: "10", px: "40", at: ago(48) }); // no Proviso close
    const closedAt = ago(47.75); // 15 min hold: under the 30 min minimum
    const fills = { [FOLLOWER]: [fill({ at: ago(48), start: "0", side: "B", sz: "10" }), fill({ at: closedAt, start: "10", side: "A", sz: "10" })] };
    const job = { epoch: 4n, start: START, end: NOW, pool: 100n, cap: 100n, post: async () => "0x4" as Hex };
    expect(await runEpoch(db, { ...job, info: venue({ fills }) })).toEqual({ status: "empty" });
    // a partial reduce leaves it open: counted to the end
    const partial = { [FOLLOWER]: [fill({ at: closedAt, start: "10", side: "A", sz: "4" })] };
    expect(await runEpoch(db, { ...job, info: venue({ fills: partial }) })).toMatchObject({ status: "posted", total: 100n });
  });

  test("link detection runs before every epoch: a transfer between caller and follower excludes the pair", async () => {
    await thesis(1n, { expiresAt: ago(-24) });
    await order({ thesisId: 1n, reduceOnly: false, filled: "10", px: "40", at: ago(48) });
    const ledger = { [FOLLOWER]: [{ time: ago(100).getTime(), delta: { type: "internalTransfer", user: OWNER, destination: FOLLOWER, usdc: "500" } }] };
    const job = { epoch: 5n, start: START, end: NOW, pool: 100n, cap: 100n, post: async () => "0x5" as Hex };
    expect(await runEpoch(db, { ...job, info: venue({ ledger }) })).toEqual({ status: "empty" });
    expect(await db.select({ a: linkFlags.a, b: linkFlags.b, reason: linkFlags.reason, score: linkFlags.score }).from(linkFlags)).toEqual([
      { a: OWNER, b: FOLLOWER, reason: "direct_transfer", score: "1" },
    ]);
    // a weaker flag later never lowers the stored one; low scores are recorded but don't exclude
    const timing = {
      [OWNER]: [fill({ at: ago(20), start: "0", side: "B", sz: "1" })],
      [FOLLOWER]: [fill({ at: new Date(ago(20).getTime() - 10_000), start: "10", side: "B", sz: "1" })],
    };
    await runEpoch(db, { ...job, epoch: 6n, info: venue({ fills: timing }) });
    expect((await db.select().from(linkFlags))[0]).toMatchObject({ reason: "direct_transfer", score: "1" });
  });

  test("a weak timing flag is stored but doesn't exclude; a failed venue read posts nothing", async () => {
    await thesis(1n, { expiresAt: ago(-24) });
    await order({ thesisId: 1n, reduceOnly: false, filled: "10", px: "40", at: ago(48) });
    const timing = {
      [OWNER]: [fill({ at: ago(20), start: "0", side: "B", sz: "1" })],
      [FOLLOWER]: [fill({ at: new Date(ago(20).getTime() - 10_000), start: "10", side: "B", sz: "1" })],
    };
    const post = mock(async () => "0x7" as Hex);
    const down = { post: async () => Promise.reject(new Error("hl down")) };
    await expect(runEpoch(db, { epoch: 7n, start: START, end: NOW, pool: 100n, cap: 100n, post, info: down })).rejects.toThrow("hl down");
    expect(post).not.toHaveBeenCalled();
    expect(await runEpoch(db, { epoch: 7n, start: START, end: NOW, pool: 100n, cap: 100n, post, info: venue({ fills: timing }) })).toMatchObject({ status: "posted" });
    expect(await db.select({ reason: linkFlags.reason, score: linkFlags.score }).from(linkFlags)).toEqual([{ reason: "timing", score: "0.25" }]);
  });
});

describe("startConsumers", () => {
  const signal = AbortSignal.abort(); // loops exit at once; this only checks wiring
  test("without chain or notify config only the db consumers run", () => {
    const logs: string[] = [];
    const r = startConsumers(db, { chain: null, senders: {}, signal, env: {}, log: (m) => logs.push(m) });
    expect(r.names).toEqual(["stamp_leaf", "sweep"]);
    for (const off of ["notify consumer off", "X poller off", "Telegram bot off"]) expect(logs.some((l) => l.includes(off))).toBe(true);
    const env = { X_BEARER_TOKEN: "x", TELEGRAM_BOT_TOKEN: "1:t" };
    expect(startConsumers(db, { chain: null, senders: {}, signal, env, log: () => {} }).names).toEqual(["stamp_leaf", "sweep", "xposts", "telegram"]);
  });

  test("chain without deployed addresses keeps the chain consumers off, with a log line", () => {
    const logs: string[] = [];
    const chain = { clients: {}, deployment: {} } as unknown as ChainConfig;
    const r = startConsumers(db, { chain, senders: { telegram: async () => {} }, signal, env: {}, log: (m) => logs.push(m) });
    expect(r.names).toEqual(["stamp_leaf", "sweep", "notify"]);
    expect(logs.filter((l) => l.includes("not deployed yet"))).toHaveLength(2);

    const deployed = { clients: {}, deployment: { thesisSeal: OWNER, stampRoots: OWNER, callerShare: OWNER } } as unknown as ChainConfig;
    const env = { USDG_ADDRESS: OWNER, EPOCH_POOL_USDG: "1000000" };
    expect(startConsumers(db, { chain: deployed, senders: {}, signal, env, log: () => {} }).names).toEqual([
      "stamp_leaf",
      "sweep",
      "stamp",
      "reveal",
      "stamp_root",
      "epoch",
    ]);
  });
});

describe("chainFromEnv", () => {
  test("refuses unknown networks and a half-deployed mainnet; no relayer key means chain consumers off", async () => {
    const { chainFromEnv } = await import("./chain");
    const { MAINNET_DEPLOYMENT } = await import("@proviso/chain");
    const prev = process.env.CHAIN_NETWORK;
    try {
      process.env.CHAIN_NETWORK = "devnet";
      expect(() => chainFromEnv({}, () => {})).toThrow("Unsupported chain network");
      process.env.CHAIN_NETWORK = "mainnet";
      const key = { RELAYER_PRIVATE_KEY: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" };
      if (Object.values(MAINNET_DEPLOYMENT).filter(Boolean).length < 5) expect(() => chainFromEnv(key, () => {})).toThrow("Mainnet contracts missing");
      else expect(chainFromEnv(key, () => {})!.clients.public.chain!.id).toBe(4663);
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

describe("startConsumers on a configured chain", () => {
  const signal = AbortSignal.abort(); // loops exit at once; this checks wiring and that every loop ends
  const RELAYER = "0x00000000000000000000000000000000000000f1";
  const deployment = { thesisSeal: OWNER, stampRoots: OWNER, callerShare: OWNER, swapAdapter: CALLER2, swapKeyPolicy: FOLLOWER };
  const env = { RELAYER_ALERT_ADDRESS: OWNER, USDG_ADDRESS: OWNER, EPOCH_POOL_USDG: "1000000", EPOCH_CAP_USDG: "5000000", CONTRACTS_DEPLOY_BLOCK: "10" };
  const chainOn = async (id: number) => {
    const { robinhoodMainnet, robinhoodTestnet } = await import("@proviso/chain");
    const chain = id === robinhoodMainnet.id ? robinhoodMainnet : robinhoodTestnet;
    return { clients: { public: { chain }, wallet: {}, account: { address: RELAYER } }, deployment } as unknown as ChainConfig;
  };

  test("mainnet: sponsor funding, every relay consumer, the balance watch and the CallerShare / feed alerts; nothing testnet-only", async () => {
    const logs: string[] = [];
    const r = startConsumers(db, { chain: await chainOn(4663), senders: {}, signal, env, log: (m) => logs.push(m) });
    expect(r.names).toEqual(["stamp_leaf", "sweep", "sponsor_funding", "stamp", "reveal", "stamp_root", "epoch", "swap_setup", "balance_watch", "caller_share_watch", "feed_watch"]);
    expect(logs.filter((l) => l.includes("unset") && !l.includes("X_BEARER_TOKEN") && !l.includes("TELEGRAM_BOT_TOKEN") && !l.includes("TEST_FEEDS"))).toEqual([]);
    await r.done; // an aborted signal stops every loop
  });

  test("mainnet without RELAYER_ALERT_ADDRESS: no balance watch and no alerts, with a log line", async () => {
    const logs: string[] = [];
    const { RELAYER_ALERT_ADDRESS: _, ...quiet } = env;
    const r = startConsumers(db, { chain: await chainOn(4663), senders: {}, signal, env: quiet, log: (m) => logs.push(m) });
    expect(r.names).not.toContain("balance_watch");
    expect(r.names).not.toContain("feed_watch");
    expect(logs.some((l) => l.includes("RELAYER_ALERT_ADDRESS unset"))).toBe(true);
    await r.done;
  });

  test("testnet: no funded-age rule or mainnet alerts; the pool aligner and the test feed pusher run", async () => {
    const feeds = JSON.stringify([{ feed: OWNER, source: { type: "hl", coin: "TSLA" } }]);
    const logs: string[] = [];
    const r = startConsumers(db, { chain: await chainOn(46630), senders: {}, signal, env: { ...env, CHAIN_NETWORK: "testnet", TEST_FEEDS: feeds }, log: (m) => logs.push(m) });
    expect(r.names).toEqual(["stamp_leaf", "sweep", "stamp", "reveal", "stamp_root", "epoch", "swap_setup", "balance_watch", "pool_align", "test_feeds"]);
    await r.done;
  });

  test("a malformed epoch pool amount refuses to start", async () => {
    expect(() => startConsumers(db, { chain: { clients: {}, deployment } as unknown as ChainConfig, senders: {}, signal, env: { ...env, EPOCH_POOL_USDG: "1.5" }, log: () => {} })).toThrow();
  });
});

describe("stamp_leaf consumer and proofs (Postgres store)", () => {
  test("queued evidence becomes leaves 1, 2 of the thesis; each proof verifies; a missing leaf is null; a tampered row refuses", async () => {
    const { stamps } = await import("@proviso/db");
    const { stampLeafHandler } = await import("./consumers");
    const { getProof } = await import("../stamps/store");
    const { verifyProof } = await import("../stamps/leaf");
    await thesis(7n, { expiresAt: ago(-24) });
    const handle = stampLeafHandler(db);
    await handle({ thesisId: "7", kind: "FIRE", data: { px: "100" }, at: NOW.toISOString() });
    await handle({ thesisId: 7, kind: "FILL", data: { sz: "2" }, at: NOW.toISOString() });

    for (const seq of [1, 2]) {
      const p = (await getProof(db, 7n, seq))!;
      expect(p).toMatchObject({ thesisId: "7", seq, kindName: seq === 1 ? "FIRE" : "FILL", leafCount: 2, tx: null });
      expect(verifyProof(p, p.root)).toBe(true);
    }
    expect(await getProof(db, 7n, 3)).toBeNull();
    expect(await getProof(db, 8n, 1)).toBeNull();

    await db.update(stamps).set({ data: { px: "999" } }).where(eq(stamps.seq, 1));
    await expect(getProof(db, 7n, 1)).rejects.toThrow("does not match its data");
  });
});

describe("stamp leaf schema v2", () => {
  test("every leaf gets mode, fillModel, market and session inside its data; proofs still verify; a leaf with v is left alone", async () => {
    const { stamps } = await import("@proviso/db");
    const { stampLeafHandler } = await import("./consumers");
    const { getProof } = await import("../stamps/store");
    const { verifyProof } = await import("../stamps/leaf");
    await thesis(9n, { expiresAt: ago(-24) }); // an alert call
    const handle = stampLeafHandler(db);
    const wed11NY = "2026-10-21T15:00:00.000Z"; // Wednesday 11:00 in New York (EDT)
    await handle({ thesisId: "9", kind: "FIRE", data: { mark: 1, market: "rhc:TSLA" }, at: wed11NY });
    await handle({ thesisId: "9", kind: "FILL", data: { venue: "hl", coin: "BTC", sz: "2" }, at: wed11NY });
    await handle({ thesisId: "9", kind: "EXIT", data: { reason: "take" }, at: wed11NY });
    await handle({ thesisId: "9", kind: "PNL", data: { v: 9, pnlUsd: 1 }, at: wed11NY });
    const rows = await db.select().from(stamps).where(eq(stamps.thesisId, 9n));
    const by = (seq: number) => rows.find((r) => r.seq === seq)!.data as Record<string, unknown>;
    expect(by(1)).toMatchObject({ v: 2, mode: "alert", fillModel: "none", market: "rhc:TSLA", session: "regular", mark: 1 });
    expect(by(2)).toMatchObject({ v: 2, mode: "alert", fillModel: "none", market: "hl:BTC", session: "24/7", sz: "2" });
    expect(by(3)).toMatchObject({ v: 2, mode: "alert", market: null, session: null, reason: "take" });
    expect(by(4)).toEqual({ v: 9, pnlUsd: 1, at: wed11NY }); // already versioned: untouched
    for (const seq of [1, 2, 3, 4]) {
      const p = (await getProof(db, 9n, seq))!;
      expect(verifyProof(p, p.root)).toBe(true);
    }
  });
});

describe("sendersFromEnv", () => {
  test("Web Push needs all three VAPID values; Telegram needs the bot token; neither sends anything when built", () => {
    const vapid = { VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv", VAPID_SUBJECT: "mailto:ops@example.com" };
    expect(Object.keys(sendersFromEnv(vapid))).toEqual(["push"]);
    for (const k of Object.keys(vapid)) expect(sendersFromEnv({ ...vapid, [k]: "" }).push).toBeUndefined();
    expect(Object.keys(sendersFromEnv({ TELEGRAM_BOT_TOKEN: "1:t" }))).toEqual(["telegram"]);
    expect(Object.keys(sendersFromEnv({ ...vapid, TELEGRAM_BOT_TOKEN: "1:t" })).sort()).toEqual(["push", "telegram"]);
  });
});
