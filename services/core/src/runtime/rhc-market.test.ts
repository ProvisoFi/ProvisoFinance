// pollRhc: one evaluator update per known Robinhood Chain token, the oracle reference only while
// its answer is positive and fresh (the leg-agreement check must never compare against a stale feed).
import { describe, expect, test } from "bun:test";
import { TESTNET_SWAP } from "@proviso/chain";
import type { Address, Hex, PublicClient } from "viem";
import type { Update } from "../evaluator/state.ts";
import { pollRhc } from "./rhc-market.ts";

const PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951" as Address;
const NOW = Date.parse("2026-10-20T15:00:00Z");
const hex = (x: bigint) => `0x${x.toString(16).padStart(64, "0")}` as Hex;

/** Every extsload answers sqrtPriceX96 for $400 TSLA (and the same word as liquidity). */
function client(feed: { answer: bigint; updatedAt: bigint }) {
  const reads: string[] = [];
  const c = {
    readContract: async (a: { address: Address; functionName: string }) => {
      reads.push(`${a.functionName}@${a.address.toLowerCase()}`);
      if (a.functionName === "extsload") return hex(50_000n << 96n);
      if (a.functionName === "latestRoundData") return [1n, feed.answer, 0n, feed.updatedAt, 1n] as const;
      throw new Error(a.functionName);
    },
  };
  return { reads, client: c as unknown as PublicClient };
}

async function poll(feed: { answer: bigint; updatedAt: bigint }, coins: string[], maxFeedAgeS?: number) {
  const { reads, client: c } = client(feed);
  const wanted: Address[] = [];
  const updates: Update[] = [];
  await pollRhc({
    client: c, poolManager: PM, markets: TESTNET_SWAP.markets, coins, now: NOW, maxFeedAgeS,
    wantFeed: async (o) => void wanted.push(o),
    apply: (u) => void updates.push(u),
  });
  return { reads, wanted, updates };
}
const at = (ageS: number) => BigInt(NOW / 1000 - ageS);

describe("pollRhc", () => {
  test("a fresh feed: pool price, depth and the oracle reference (8 decimals)", async () => {
    const r = await poll({ answer: 401_50000000n, updatedAt: at(10) }, ["TSLA"]);
    expect(r.wanted).toEqual([TESTNET_SWAP.markets[0]!.oracle as Address]);
    expect(r.updates.length).toBe(1);
    const u = r.updates[0] as Extract<Update, { src: "rhc" }>;
    expect(u).toMatchObject({ src: "rhc", coin: "TSLA", at: NOW, ref: 401.5 });
    expect(u.pool).toBeCloseTo(400, 6);
    expect(u.depth).toBeGreaterThan(0);
    expect(r.reads).toContain(`latestRoundData@${TESTNET_SWAP.markets[0]!.oracle.toLowerCase()}`);
    expect(r.reads.every((x) => x.startsWith("latestRoundData") || x === `extsload@${PM}`)).toBe(true);
  });

  test("a stale or non-positive answer leaves the reference unknown, the pool still updates", async () => {
    for (const feed of [{ answer: 400_00000000n, updatedAt: at(121) }, { answer: 0n, updatedAt: at(1) }, { answer: -1n, updatedAt: at(1) }]) {
      const [u] = (await poll(feed, ["TSLA"])).updates;
      expect(u).toBeDefined();
      expect("ref" in u!).toBe(false);
      expect((u as { pool?: number }).pool).toBeCloseTo(400, 6);
    }
  });

  test("maxFeedAgeS widens the freshness window but never below 120 s", async () => {
    expect((await poll({ answer: 400_00000000n, updatedAt: at(120) }, ["TSLA"])).updates[0]).toHaveProperty("ref", 400);
    expect((await poll({ answer: 400_00000000n, updatedAt: at(3_600) }, ["TSLA"], 90_000)).updates[0]).toHaveProperty("ref", 400);
    expect((await poll({ answer: 400_00000000n, updatedAt: at(121) }, ["TSLA"], 60)).updates[0]).not.toHaveProperty("ref");
  });

  test("unknown tokens are skipped: no feed kept alive, no update, no read", async () => {
    const r = await poll({ answer: 1n, updatedAt: at(1) }, ["NVDA", "AMZN"]);
    expect(r.wanted).toEqual([TESTNET_SWAP.markets[1]!.oracle as Address]);
    expect(r.updates.map((u) => (u as { coin: string }).coin)).toEqual(["AMZN"]);
  });
});
