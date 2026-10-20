import { describe, expect, test } from "bun:test";
import { TESTNET_SWAP } from "@proviso/chain";
import { targetSqrtPriceX96 } from "./pool-align";

describe("pool aligner", () => {
  test("the target sqrt price prices the token at the feed (tUSDG is currency0, 6 vs 18 decimals)", () => {
    const m = TESTNET_SWAP.markets[0]!;
    for (const usd of [1, 373.37, 4000]) {
      const sqrt = Number(targetSqrtPriceX96(m, usd)) / 2 ** 96;
      const oneIn0 = sqrt * sqrt * 10 ** (m.decimals[0] - m.decimals[1]); // TSLA per USDG
      expect(1 / oneIn0).toBeCloseTo(usd, 6);
    }
  });
});
