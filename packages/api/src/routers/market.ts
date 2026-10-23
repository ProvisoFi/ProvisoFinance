import { users } from "@proviso/db";
import { chainConfig, POOL_MANAGER, poolDepthUsd, swapConfig } from "@proviso/chain";
import { MAX_LEVERAGE, MIN_HL_VOLUME_USD, MIN_POOL_DEPTH_USD, type HlPerpMeta, type RhcTokenMeta, type ValidateContext } from "@proviso/dsl";
import { createPublicClient, http } from "viem";
import { InfoClient, listedDexes, network, perpUniverse } from "@proviso/hl";
import { eq } from "drizzle-orm";
import { limitsSchema } from "./account";
import { authedProcedure, publicProcedure, router } from "../trpc";

/** `dex` is set for HIP-3 markets ("xyz:NVDA"); `onlyIsolated` where the market refuses cross margin. */
type Perp = { coin: string; maxLeverage: number; volume24hUsd: number; mark: number; dex?: string; onlyIsolated?: boolean };
let cache: { at: number; perps: Perp[] } | undefined;

/**
 * Listed (not delisted) Hyperliquid perps from the configured network (testnet by default), main dex
 * plus the listed HIP-3 dexes (HL_DEXES, default xyz: stocks, metals, oil, indices), cached for a minute.
 */
export async function perps(info = new InfoClient()): Promise<Perp[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.perps;
  const [meta, ctxs] = await perpUniverse(info, listedDexes());
  const list = meta.universe.flatMap((a, i) =>
    a.isDelisted || !ctxs[i]
      ? []
      : [{
          coin: a.name,
          maxLeverage: a.maxLeverage,
          volume24hUsd: Number(ctxs[i].dayNtlVlm),
          mark: Number(ctxs[i].markPx),
          ...(a.dex && { dex: a.dex }),
          ...(a.onlyIsolated && { onlyIsolated: true }),
        }],
  );
  cache = { at: Date.now(), perps: list };
  return list;
}

let rhcCache: { at: number; tokens: Record<string, RhcTokenMeta> } | undefined;

/** Swap tokens of CHAIN_NETWORK with their pool depth (USDG is the quote side), cached for a minute. */
export async function rhcTokens(): Promise<Record<string, RhcTokenMeta>> {
  if (rhcCache && Date.now() - rhcCache.at < 60_000) return rhcCache.tokens;
  const client = createPublicClient({ chain: chainConfig().chain, transport: http(process.env.RHC_RPC_URL) });
  const tokens: Record<string, RhcTokenMeta> = { USDG: { isCanonical: true, poolDepthUsd: Infinity } };
  for (const m of swapConfig().markets) {
    const depth = await poolDepthUsd(client as never, POOL_MANAGER, m).catch(() => 0);
    for (const s of m.symbols) if (s !== "USDG") tokens[s] = { isCanonical: true, poolDepthUsd: depth };
  }
  rhcCache = { at: Date.now(), tokens };
  return tokens;
}

/**
 * Liquidity floors the validator applies. Testnet volumes and pools are tiny, so they drop to
 * TESTNET_MIN_HL_VOLUME_USD / TESTNET_MIN_POOL_DEPTH_USD there; mainnet keeps the spec's ($250k HL
 * 24h volume, $100k pool depth within ±2%).
 */
export function floorsFor(net: string, env: Record<string, string | undefined> = process.env): NonNullable<ValidateContext["floors"]> {
  if (net !== "testnet") return { hlVolumeUsd: MIN_HL_VOLUME_USD, poolDepthUsd: MIN_POOL_DEPTH_USD };
  return { hlVolumeUsd: Number(env.TESTNET_MIN_HL_VOLUME_USD ?? 1000), poolDepthUsd: Number(env.TESTNET_MIN_POOL_DEPTH_USD ?? 25) };
}

/** Market data the workspace builds and validates rules against. */
export const marketRouter = router({
  /** Public: the Hyperliquid network name and its listed perps (max leverage, 24h USD volume, mark). */
  perps: publicProcedure.query(async () => ({ network: network().name, perps: await perps() })),

  /**
   * What the browser validates a draft against before sealing: live markets, liquidity floors
   * and the user's limits. The spec itself never comes here (it may describe a sealed idea).
   */
  validationContext: authedProcedure.query(async ({ ctx }): Promise<ValidateContext> => {
    const hl: Record<string, HlPerpMeta> = {};
    for (const p of await perps()) hl[p.coin] = { maxLeverage: p.maxLeverage, volume24hUsd: p.volume24hUsd };
    const [row] = await ctx.db.select({ limits: users.limits }).from(users).where(eq(users.address, ctx.auth.address));
    const limits = limitsSchema.safeParse(row?.limits).data;
    const user = limits ? { maxUsd: limits.maxAllocation, maxLev: limits.maxLeverage } : { maxUsd: 1_000_000, maxLev: MAX_LEVERAGE };
    // Keyed on HL_NETWORK, like core's evaluator floors (evalConfigFor).
    const floors = floorsFor(network().name);
    const rhc = await rhcTokens(); // Robinhood Chain swaps (embedded wallets, R4)
    return { hl, user, floors, rhc };
  }),
});
