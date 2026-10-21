import { users } from "@proviso/db";
import { chains, poolDepthUsd, TESTNET_SWAP } from "@proviso/chain";
import { MAX_LEVERAGE, type HlPerpMeta, type RhcTokenMeta, type ValidateContext } from "@proviso/dsl";
import { createPublicClient, http } from "viem";
import { InfoClient, network } from "@proviso/hl";
import { eq } from "drizzle-orm";
import { limitsSchema } from "./account";
import { authedProcedure, publicProcedure, router } from "../trpc";

type Perp = { coin: string; maxLeverage: number; volume24hUsd: number; mark: number };
let cache: { at: number; perps: Perp[] } | undefined;

// Hyperliquid perps from the configured network (testnet by default), cached for a minute.
export async function perps(info = new InfoClient()): Promise<Perp[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.perps;
  const [meta, ctxs] = await info.metaAndAssetCtxs();
  const list = meta.universe.flatMap((a, i) =>
    a.isDelisted || !ctxs[i]
      ? []
      : [{ coin: a.name, maxLeverage: a.maxLeverage, volume24hUsd: Number(ctxs[i].dayNtlVlm), mark: Number(ctxs[i].markPx) }],
  );
  cache = { at: Date.now(), perps: list };
  return list;
}

let rhcCache: { at: number; tokens: Record<string, RhcTokenMeta> } | undefined;
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951"; // Uniswap v4 on Robinhood Chain (same on testnet)

/** Testnet swap tokens with their pool depth (USDG is the quote side), cached for a minute. */
export async function rhcTokens(): Promise<Record<string, RhcTokenMeta>> {
  if (rhcCache && Date.now() - rhcCache.at < 60_000) return rhcCache.tokens;
  const client = createPublicClient({ chain: chains.testnet, transport: http(process.env.RHC_RPC_URL) });
  const tokens: Record<string, RhcTokenMeta> = { USDG: { isCanonical: true, poolDepthUsd: Infinity } };
  for (const m of TESTNET_SWAP.markets) {
    const depth = await poolDepthUsd(client as never, POOL_MANAGER, m).catch(() => 0);
    for (const s of m.symbols) if (s !== "USDG") tokens[s] = { isCanonical: true, poolDepthUsd: depth };
  }
  rhcCache = { at: Date.now(), tokens };
  return tokens;
}

export const marketRouter = router({
  perps: publicProcedure.query(async () => ({ network: network().name, perps: await perps() })),

  // What the browser validates a draft against before sealing: live markets, liquidity floors
  // and the user's limits. The spec itself never comes here (it may describe a sealed idea).
  validationContext: authedProcedure.query(async ({ ctx }): Promise<ValidateContext> => {
    const hl: Record<string, HlPerpMeta> = {};
    for (const p of await perps()) hl[p.coin] = { maxLeverage: p.maxLeverage, volume24hUsd: p.volume24hUsd };
    const [row] = await ctx.db.select({ limits: users.limits }).from(users).where(eq(users.address, ctx.auth.address));
    const limits = limitsSchema.safeParse(row?.limits).data;
    const user = limits ? { maxUsd: limits.maxAllocation, maxLev: limits.maxLeverage } : { maxUsd: 1_000_000, maxLev: MAX_LEVERAGE };
    // Testnet volumes are tiny; the spec's $250k floor applies from mainnet on.
    const testnet = network().name === "testnet";
    const floors = testnet
      ? { hlVolumeUsd: Number(process.env.TESTNET_MIN_HL_VOLUME_USD ?? 1000), poolDepthUsd: Number(process.env.TESTNET_MIN_POOL_DEPTH_USD ?? 25) }
      : undefined;
    // Robinhood Chain swaps exist on testnet only for now (embedded wallets, R4).
    const rhc = testnet ? await rhcTokens() : undefined;
    return { hl, user, floors, rhc };
  }),
});
