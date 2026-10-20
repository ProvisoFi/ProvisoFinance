// Robinhood Chain inputs for the evaluator: each token's pool price, its oracle reference (the
// leg-agreement check) and pool depth, polled for the tokens live ideas read.
import { feedRoundAbi, poolDepthUsd, poolPriceUsd, type SwapMarket } from "@proviso/chain";
import type { Address, PublicClient } from "viem";
import type { Update } from "../evaluator/state.ts";

const FEED_DECIMALS = 8;
const FEED_MAX_AGE_S = 120;

export async function pollRhc(o: {
  client: PublicClient;
  poolManager: Address;
  markets: readonly SwapMarket[];
  coins: string[];
  wantFeed: (oracle: Address) => Promise<unknown>;
  apply: (u: Update) => void;
  now?: number;
}) {
  for (const coin of o.coins) {
    const m = o.markets.find((x) => x.symbols.includes(coin));
    if (!m) continue; // not a pool we know: its conditions stay unknown
    await o.wantFeed(m.oracle); // keeps the on-demand test feed pushing while an idea reads it
    const [pool, depth, [, answer, , updatedAt]] = await Promise.all([
      poolPriceUsd(o.client, o.poolManager, m),
      poolDepthUsd(o.client, o.poolManager, m),
      o.client.readContract({ address: m.oracle, abi: feedRoundAbi, functionName: "latestRoundData" }),
    ]);
    const now = o.now ?? Date.now();
    const fresh = answer > 0n && now / 1000 - Number(updatedAt) <= FEED_MAX_AGE_S;
    o.apply({ src: "rhc", coin, at: now, pool, depth, ...(fresh && { ref: Number(answer) / 10 ** FEED_DECIMALS }) });
  }
}
