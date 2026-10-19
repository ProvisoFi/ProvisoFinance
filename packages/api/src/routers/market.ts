import { users } from "@proviso/db";
import { MAX_LEVERAGE, validate, type HlPerpMeta } from "@proviso/dsl";
import { InfoClient, network } from "@proviso/hl";
import { eq } from "drizzle-orm";
import { z } from "zod";
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

export const marketRouter = router({
  perps: publicProcedure.query(async () => ({ network: network().name, perps: await perps() })),

  // Markets exist, liquidity floors, size and leverage against the user's limits.
  validate: authedProcedure.input(z.object({ spec: z.unknown() })).mutation(async ({ ctx, input }) => {
    const hl: Record<string, HlPerpMeta> = {};
    for (const p of await perps()) hl[p.coin] = { maxLeverage: p.maxLeverage, volume24hUsd: p.volume24hUsd };
    const [row] = await ctx.db.select({ limits: users.limits }).from(users).where(eq(users.address, ctx.auth.address));
    const limits = limitsSchema.safeParse(row?.limits).data;
    const user = limits ? { maxUsd: limits.maxAllocation, maxLev: limits.maxLeverage } : { maxUsd: 1_000_000, maxLev: MAX_LEVERAGE };
    // Testnet volumes are tiny; the spec's $250k floor applies from mainnet on.
    const floors = network().name === "testnet" ? { hlVolumeUsd: Number(process.env.TESTNET_MIN_HL_VOLUME_USD ?? 1000) } : undefined;
    return { ...validate(input.spec, { hl, user, floors }), limitsSet: !!limits };
  }),
});
