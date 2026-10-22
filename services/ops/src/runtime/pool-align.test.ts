import { describe, expect, test } from "bun:test";
import { robinhoodMainnet, robinhoodTestnet, TESTNET_SWAP } from "@proviso/chain";
import { maxUint256, toHex, type Address } from "viem";
import { ALIGN_PCT, poolAligner, targetSqrtPriceX96 } from "./pool-align";
import type { Clients } from "./chain";

describe("pool aligner", () => {
  test("the target sqrt price prices the token at the feed (tUSDG is currency0, 6 vs 18 decimals)", () => {
    const m = TESTNET_SWAP.markets[0]!;
    for (const usd of [1, 373.37, 4000]) {
      const sqrt = Number(targetSqrtPriceX96(m, usd)) / 2 ** 96;
      const oneIn0 = sqrt * sqrt * 10 ** (m.decimals[0] - m.decimals[1]); // TSLA per USDG
      expect(1 / oneIn0).toBeCloseTo(usd, 6);
    }
  });

  test("stays off on mainnet (real pools, Chainlink feeds)", async () => {
    const logs: string[] = [];
    const c = { public: { chain: robinhoodMainnet, readContract: () => Promise.reject(new Error("no reads")) }, account: { address: "0x0000000000000000000000000000000000000001" } } as unknown as Clients;
    await poolAligner(c, { log: (m) => logs.push(m) }).run(new AbortController().signal);
    expect(logs).toEqual(["ops: pool aligner is testnet only, off"]);
  });
});

// A testnet chain with one pool (USDG/TSLA, tUSDG is currency0); records every tx the relayer sends.
const ME = "0x00000000000000000000000000000000000000f1" as Address;
const NOW = 1_800_000_000n;
const M = TESTNET_SWAP.markets[0]!;
const USDG = M.key.currency0;
const TSLA = M.key.currency1;

function fakeChain(o: { usd?: number; offBy?: number; updatedAt?: bigint; answer?: bigint; sqrt?: bigint; usdg?: bigint; tsla?: bigint; allowance?: bigint; fail?: string }) {
  const target = targetSqrtPriceX96(M, o.usd ?? 250);
  const sqrt = o.sqrt ?? BigInt(Math.floor(Number(target) * Math.sqrt(o.offBy ?? 1)));
  const held: Record<string, bigint> = { [USDG.toLowerCase()]: o.usdg ?? 0n, [TSLA.toLowerCase()]: o.tsla ?? 0n };
  const sent: { functionName: string; address: Address; args: readonly unknown[] }[] = [];
  const reads: string[] = [];
  const c = {
    account: { address: ME },
    public: {
      chain: robinhoodTestnet,
      getBlock: async () => ({ timestamp: NOW }),
      readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
        reads.push(functionName);
        if (functionName === o.fail) throw new Error(`${functionName} reverted`);
        if (functionName === "latestRoundData") return [1n, o.answer ?? BigInt(Math.round((o.usd ?? 250) * 1e8)), 0n, o.updatedAt ?? NOW - 30n, 1n];
        // Pool.State slot0 packs other fields above the 160-bit sqrt price; they must be masked off.
        if (functionName === "extsload") return toHex((1n << 200n) | sqrt, { size: 32 });
        if (functionName === "balanceOf") return held[address.toLowerCase()] ?? 0n;
        if (functionName === "allowance") return o.allowance ?? 0n;
        throw new Error(`unexpected read ${functionName}`);
      },
      simulateContract: async (call: { functionName: string; address: Address; args: readonly unknown[] }) => ({ request: call }),
      waitForTransactionReceipt: async () => ({ status: "success", blockHash: "0xb1" }),
    },
    wallet: {
      writeContract: async (r: { functionName: string; address: Address; args: readonly unknown[] }) => {
        sent.push(r);
        if (r.functionName === "mint") held[USDG.toLowerCase()] = 10_000n * 10n ** 6n;
        return toHex(sent.length, { size: 32 });
      },
    },
  } as unknown as Clients;
  return { c, sent, reads, target };
}
const aligner = (c: Clients, logs: string[] = []) => poolAligner(c, { markets: [M], log: (m) => logs.push(m) });

describe("pool aligner tick", () => {
  test("pool priced above the feed: mints tUSDG when short, approves once, sells USDG down to exactly the target", async () => {
    const logs: string[] = [];
    const { c, sent, target } = fakeChain({ offBy: 1.1 });
    await aligner(c, logs).tick();
    expect(sent.map((s) => s.functionName)).toEqual(["mint", "approve", "swap"]);
    expect(sent[0]!.args).toEqual([ME, 10_000n * 10n ** 6n]);
    expect(sent[1]!.args).toEqual([TESTNET_SWAP.swapRouter, maxUint256]);
    const [key, params] = sent[2]!.args as [unknown, { zeroForOne: boolean; amountSpecified: bigint; sqrtPriceLimitX96: bigint }];
    expect(sent[2]!.address).toBe(TESTNET_SWAP.swapRouter);
    expect(key).toEqual(M.key);
    // Exact input of everything held, capped by the price limit: it moves the price to the feed and no further.
    expect(params).toEqual({ zeroForOne: true, amountSpecified: -(10_000n * 10n ** 6n), sqrtPriceLimitX96: target });
    expect(logs.at(-1)).toContain("traded back");
  });

  test("pool priced below the feed sells the Stock Token; an approval already in place isn't repeated", async () => {
    const { c, sent } = fakeChain({ offBy: 0.9, tsla: 5n * 10n ** 18n, allowance: maxUint256 });
    await aligner(c).tick();
    expect(sent.map((s) => s.functionName)).toEqual(["swap"]);
    expect((sent[0]!.args[1] as { zeroForOne: boolean; amountSpecified: bigint }).zeroForOne).toBe(false);
    expect((sent[0]!.args[1] as { amountSpecified: bigint }).amountSpecified).toBe(-(5n * 10n ** 18n));
  });

  test("holding none of the token to sell sends nothing and says why (only tUSDG is mintable)", async () => {
    const logs: string[] = [];
    const { c, sent } = fakeChain({ offBy: 0.9 });
    await aligner(c, logs).tick();
    expect(sent).toEqual([]);
    expect(logs).toEqual(["ops: pool align USDG/TSLA: relayer holds no TSLA, can't move the price"]);
  });

  test("leaves the pool alone inside the band, on a stale or non-positive feed, and on an uninitialized pool", async () => {
    const inBand = fakeChain({ offBy: 1 + (ALIGN_PCT / 100) * 0.8, usdg: 10n ** 12n });
    await aligner(inBand.c).tick();
    expect(inBand.sent).toEqual([]);

    for (const o of [{ updatedAt: NOW - 601n }, { answer: 0n }, { answer: -1n }]) {
      const f = fakeChain({ offBy: 2, usdg: 10n ** 12n, ...o });
      await aligner(f.c).tick();
      expect(f.sent).toEqual([]);
      expect(f.reads).toEqual(["latestRoundData"]); // no fresh reference: never even reads the pool
    }

    const empty = fakeChain({ sqrt: 0n, usdg: 10n ** 12n });
    await aligner(empty.c).tick();
    expect(empty.sent).toEqual([]);
    expect(empty.reads).toEqual(["latestRoundData", "extsload"]);
  });

  test("a failing pool is logged and doesn't stop the next one", async () => {
    const logs: string[] = [];
    const { c, reads } = fakeChain({ fail: "latestRoundData" });
    await poolAligner(c, { markets: [M, M], log: (m) => logs.push(m) }).tick();
    expect(reads).toEqual(["latestRoundData", "latestRoundData"]);
    expect(logs).toEqual(["ops: pool align USDG/TSLA failed", "ops: pool align USDG/TSLA failed"]);
  });

  test("run on testnet ticks until aborted", async () => {
    const logs: string[] = [];
    const { c, reads } = fakeChain({ offBy: 1 });
    const ac = new AbortController();
    const done = aligner(c, logs).run(ac.signal);
    while (!reads.includes("extsload")) await Bun.sleep(1);
    ac.abort();
    await done;
    expect(logs[0]).toBe(`ops: pool aligner on (1 pools, ${ALIGN_PCT}% band)`);
  });
});
