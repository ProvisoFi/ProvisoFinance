// Test feed pusher against the compiled ProvisoTestFeed on a local anvil started as chain 46630.
// Needs `forge build` in contracts/ (reads contracts/out) and anvil in ~/.foundry/bin.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { robinhoodTestnet } from "@proviso/chain";
import { feedWanted, type Db } from "@proviso/db";
import { createTestDb } from "@proviso/db/testing";
import { createPublicClient, createTestClient, createWalletClient, http, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Clients } from "./chain";
import { feedPusher, needsPush, parseTestFeeds, poolAnswer, testFeedAbi } from "./feeds";

const bin = join(homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
const artifact = join(import.meta.dir, "../../../../contracts/out/ProvisoTestFeed.sol/ProvisoTestFeed.json");
const has = existsSync(bin) && existsSync(artifact);
const port = 11545 + Math.floor(Math.random() * 1000);
const rpc = `http://127.0.0.1:${port}`;
const relayer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"); // anvil #0
const chain = { ...robinhoodTestnet, rpcUrls: { default: { http: [rpc] } } };
const TESTNET = { CHAIN_NETWORK: "testnet" };

let proc: ReturnType<typeof Bun.spawn> | undefined;
let c: Clients;
let db: Db;
const anvilCtl = createTestClient({ chain, mode: "anvil", transport: http(rpc) });

let mark = "250";
const info = { post: async <T>() => [{ universe: [{ name: "TSLA" }] }, [{ markPx: mark }]] as T };

async function newFeed(): Promise<Address> {
  const { abi, bytecode } = JSON.parse(readFileSync(artifact, "utf8"));
  const hash = await c.wallet.deployContract({ abi, bytecode: bytecode.object as Hex, args: [relayer.address, "TSLA/USDG"], account: relayer, chain });
  return (await c.public.waitForTransactionReceipt({ hash })).contractAddress as Address;
}
const onchain = (feed: Address) => c.public.readContract({ address: feed, abi: testFeedAbi, functionName: "latestRoundData" });
const pusher = (feed: Address, env: Record<string, string> = {}, logs: string[] = []) =>
  feedPusher(db, c, {
    env: { ...TESTNET, TEST_FEEDS: JSON.stringify([{ feed, source: { type: "hl", coin: "TSLA" } }]), ...env },
    log: (m) => logs.push(m),
    info,
  })!;
const mineAt = async (ts: bigint) => (await anvilCtl.setNextBlockTimestamp({ timestamp: ts }), await anvilCtl.mine({ blocks: 1 }));

beforeAll(async () => {
  if (!has) return;
  proc = Bun.spawn([bin, "--port", String(port), "--chain-id", "46630", "--silent"], { stdout: "ignore", stderr: "ignore" });
  const pub = createPublicClient({ chain, transport: http(rpc), pollingInterval: 50 }) as PublicClient;
  for (let i = 0; i < 100; i++) {
    try {
      await pub.getChainId();
      break;
    } catch {
      await Bun.sleep(100);
    }
  }
  c = { public: pub, wallet: createWalletClient({ chain, transport: http(rpc), account: relayer, pollingInterval: 50 }), account: relayer };
  db = await createTestDb();
}, 30_000);
afterAll(() => proc?.kill());

describe.skipIf(!has)("feed pusher on anvil (chain 46630)", () => {
  test("pushes on staleness and deviation, not otherwise", async () => {
    mark = "250";
    const feed = await newFeed();
    const p = pusher(feed);
    expect(await p.tick()).toEqual([feed]); // never pushed
    expect((await onchain(feed))[1]).toBe(250_00000000n);

    expect(await p.tick()).toEqual([]); // fresh, same price
    mark = "251.2"; // +0.48%
    expect(await p.tick()).toEqual([]);
    mark = "251.3"; // +0.52%
    expect(await p.tick()).toEqual([feed]);
    expect((await onchain(feed))[1]).toBe(251_30000000n);

    const pushedAt = (await onchain(feed))[3];
    await mineAt(pushedAt + 45n);
    expect(await p.tick()).toEqual([]); // 45 s old is not yet "older than 45 s"
    await mineAt(pushedAt + 46n);
    expect(await p.tick()).toEqual([feed]);
    const [, answer, , updatedAt] = await onchain(feed);
    expect(answer).toBe(251_30000000n);
    expect(updatedAt).toBe((await c.public.getBlock()).timestamp);
  }, 30_000);

  test("budget guard pauses below FEED_MIN_ETH, logging once", async () => {
    const feed = await newFeed();
    const logs: string[] = [];
    const p = pusher(feed, { FEED_MIN_ETH: "1000000" }, logs); // anvil #0 holds 10000 ETH
    expect(await p.tick()).toEqual([]);
    expect(await p.tick()).toEqual([]);
    expect(logs.filter((l) => l.includes("pushes paused"))).toHaveLength(1);
    expect((await onchain(feed))[3]).toBe(0n);

    expect(await pusher(feed, { FEED_MIN_ETH: "1" }).tick()).toEqual([feed]);
  }, 30_000);

  test("on-demand pushes only while feed_wanted is fresh (5 minutes)", async () => {
    const feed = await newFeed();
    mark = "250";
    const p = pusher(feed, { TEST_FEEDS_MODE: "on-demand" });
    expect(await p.tick()).toEqual([]); // no row
    await db.insert(feedWanted).values({ feed, wantedAt: new Date(Date.now() - 6 * 60_000) }); // casing doesn't matter
    expect(await p.tick()).toEqual([]); // stale row
    await db.update(feedWanted).set({ wantedAt: new Date(Date.now() - 4 * 60_000) });
    expect(await p.tick()).toEqual([feed]);
    expect((await onchain(feed))[1]).toBe(250_00000000n);
  }, 30_000);
});

describe("refusals", () => {
  const fake = (chainId: number) => ({ public: { getChainId: async () => chainId }, account: relayer }) as unknown as Clients;
  const env = (net?: string) => ({ CHAIN_NETWORK: net, TEST_FEEDS: JSON.stringify([{ feed: relayer.address, source: { type: "hl", coin: "TSLA" } }]) });

  test("off unless CHAIN_NETWORK is testnet and TEST_FEEDS is set", () => {
    const logs: string[] = [];
    for (const net of ["mainnet", "local", undefined]) expect(feedPusher({} as Db, fake(46630), { env: env(net), log: (m) => logs.push(m) })).toBeNull();
    expect(feedPusher({} as Db, fake(46630), { env: { CHAIN_NETWORK: "testnet" }, log: (m) => logs.push(m) })).toBeNull();
    expect(logs.filter((l) => l.includes("testnet only"))).toHaveLength(3);
    expect(logs.at(-1)).toContain("TEST_FEEDS unset");
  });

  test("refuses an RPC that isn't chain 46630, even with CHAIN_NETWORK=testnet", async () => {
    const logs: string[] = [];
    const p = feedPusher({} as Db, fake(4663), { env: env("testnet"), log: (m) => logs.push(m) })!;
    await expect(p.tick()).rejects.toThrow("refuses chain 4663");
    await p.run(new AbortController().signal); // returns at once instead of looping
    expect(logs.at(-1)).toContain("refuses chain 4663");
  });

  test("malformed config throws at startup", () => {
    expect(() => parseTestFeeds('[{"feed":"0x1","source":{"type":"hl","coin":"TSLA"}}]')).toThrow("malformed");
    expect(() => parseTestFeeds('[{"feed":"0x7E955252E15c84f5768B83c41a71F9eba181802F","source":{"type":"pool","poolId":"0x12"}}]')).toThrow();
    expect(() => feedPusher({} as Db, fake(46630), { env: { ...env("testnet"), TEST_FEEDS_MODE: "sometimes" }, log: () => {} })).toThrow();
  });
});

describe("price math", () => {
  test("poolAnswer: 1 token (18 dec) = 1 USDG (6 dec) on either side of the pool", () => {
    expect(poolAnswer(79228162514264337593543950336000000n, false, 18, 6, 8)).toBe(100000000n); // token is currency1
    const asC0 = poolAnswer(79228162514264337593543n, true, 18, 6, 8); // token is currency0, sqrtP truncated
    expect(asC0 >= 99999999n && asC0 <= 100000000n).toBe(true);
    expect(poolAnswer(2n ** 96n * 2n, true, 18, 18, 8)).toBe(400000000n); // price 4
    expect(poolAnswer(2n ** 96n * 2n, false, 18, 18, 8)).toBe(25000000n); // 1/4
  });

  test("needsPush thresholds", () => {
    const at = { answer: 10_000n, updatedAt: 100n };
    expect(needsPush(at, 10_050n, 145n)).toBe(false); // exactly 0.5%, exactly 45 s
    expect(needsPush(at, 10_051n, 100n)).toBe(true);
    expect(needsPush(at, 9_949n, 100n)).toBe(true);
    expect(needsPush(at, 10_000n, 146n)).toBe(true);
  });
});

describe("feed pusher on a fake chain", () => {
  const USDG = "0x9c38b572260c79c4a01d71f85b1f222865804c2a" as Address;
  const POOL_FEED = "0x00000000000000000000000000000000000000a1" as Address;
  const DEAD_FEED = "0x00000000000000000000000000000000000000a2" as Address;
  const HL_FEED = "0x00000000000000000000000000000000000000a3" as Address;
  const pool = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
  // ETH (native, currency0, 18 dec) at $2500 in tUSDG (6 dec): currency1 raw per currency0 raw = 2.5e-9.
  const SQRT_2500 = BigInt(Math.round(Math.sqrt(2500 * 1e-12) * 2 ** 96));
  function fake(o: { chainId?: () => Promise<number> } = {}) {
    const pushed: { feed: Address; answer: bigint }[] = [];
    const c = {
      account: relayer,
      public: {
        getChainId: o.chainId ?? (async () => 46630),
        getBalance: async () => 10n ** 18n,
        getBlock: async () => ({ timestamp: 10_000n }),
        readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args?: unknown[] }) => {
          if (functionName === "decimals") return address === USDG ? 6 : 8;
          if (functionName === "getSlot0") return [args![0] === pool(1) ? SQRT_2500 : 0n, 0, 0, 0];
          if (functionName === "latestRoundData") return [1n, 1n, 0n, 0n, 1n]; // stale: always due
          throw new Error(`unexpected read ${functionName}`);
        },
        simulateContract: async (call: { address: Address; args: unknown[] }) => ({ request: call }),
        waitForTransactionReceipt: async () => ({ status: "success", blockHash: "0xb1" }),
      },
      wallet: { writeContract: async (r: { address: Address; args: [bigint] }) => (pushed.push({ feed: r.address, answer: r.args[0] }), "0x01") },
    } as unknown as Clients;
    return { c, pushed };
  }
  const TEST_FEEDS = JSON.stringify([
    { feed: POOL_FEED, source: { type: "pool", poolId: pool(1), base: "0x0000000000000000000000000000000000000000", quote: USDG } },
    { feed: DEAD_FEED, source: { type: "pool", poolId: pool(2), base: "0x0000000000000000000000000000000000000000", quote: USDG } },
    { feed: HL_FEED, source: { type: "hl", coin: "TSLA" } },
  ]);

  test("pool feeds push the pool's spot price; an uninitialized pool or a missing HL mark fails only that feed", async () => {
    const { c, pushed } = fake();
    const logs: string[] = [];
    const down = { post: async () => Promise.reject(new Error("HL down")) };
    const p = feedPusher({} as Db, c, { env: { CHAIN_NETWORK: "testnet", TEST_FEEDS }, log: (m, e) => logs.push(`${m}${e ? `: ${(e as Error).message}` : ""}`), info: down })!;
    expect(await p.tick()).toEqual([POOL_FEED]);
    expect(pushed).toHaveLength(1);
    expect(Number(pushed[0]!.answer) / 1e8).toBeCloseTo(2500, 4);
    expect(logs).toEqual([
      "ops: Hyperliquid testnet marks unavailable: HL down", // pool feeds still push
      `ops: test feed ${DEAD_FEED} push failed: pool ${pool(2)} is not initialized`,
      `ops: test feed ${HL_FEED} push failed: no Hyperliquid testnet mark for TSLA`,
    ]);
  });

  test("an RPC that can't answer its chain id is retried next tick, not treated as a refusal", async () => {
    let calls = 0;
    const { c } = fake({ chainId: async () => (calls++ ? 46630 : Promise.reject(new Error("rpc down"))) });
    const logs: string[] = [];
    const p = feedPusher({} as Db, c, { env: { CHAIN_NETWORK: "testnet", TEST_FEEDS }, log: (m) => logs.push(m), info: { post: async <T>() => [{ universe: [] }, []] as T } })!;
    const ac = new AbortController();
    const done = p.run(ac.signal);
    while (!logs.includes("ops: test feed tick failed")) await Bun.sleep(1);
    ac.abort();
    await done;
    expect(await p.tick()).toEqual([POOL_FEED]); // asks the chain id again and goes on
    expect(calls).toBe(2);
  });
});
