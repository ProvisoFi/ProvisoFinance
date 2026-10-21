import { describe, expect, test } from "bun:test";
import { robinhoodMainnet, TESTNET_SWAP } from "@proviso/chain";
import { poolAligner, targetSqrtPriceX96 } from "./pool-align";
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
