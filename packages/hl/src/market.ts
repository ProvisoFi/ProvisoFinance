import type { Meta, SpotMeta } from "./info.ts";

export const SPOT_ASSET_OFFSET = 10000;

export interface AssetInfo {
  /** Asset id used in order/cancel actions. */
  asset: number;
  szDecimals: number;
  isSpot: boolean;
}

/** Perp asset index = position in meta.universe. */
export function perpAssetIndex(meta: Meta, coin: string): number {
  const i = meta.universe.findIndex((u) => u.name === coin);
  if (i < 0) throw new Error(`Unknown perp ${coin}`);
  return i;
}

function findSpot(spotMeta: SpotMeta, coin: string) {
  let pair = spotMeta.universe.find((u) => u.name === coin);
  if (!pair && coin.includes("/")) {
    // Non-canonical pairs are named "@N"; also accept "BASE/QUOTE" by token names.
    const [base, quote] = coin.split("/");
    pair = spotMeta.universe.find((u) => {
      const b = spotMeta.tokens.find((t) => t.index === u.tokens[0]);
      const q = spotMeta.tokens.find((t) => t.index === u.tokens[1]);
      return b?.name === base && q?.name === quote;
    });
  }
  if (!pair) throw new Error(`Unknown spot pair ${coin}`);
  return pair;
}

/** Spot asset id = 10000 + the pair's `index` field (not its array position, which can differ). */
export function spotAssetIndex(spotMeta: SpotMeta, coin: string): number {
  return SPOT_ASSET_OFFSET + findSpot(spotMeta, coin).index;
}

/** Asset id and size decimals for a perp coin; throws if the coin is not in `meta.universe`. */
export function perpAssetInfo(meta: Meta, coin: string): AssetInfo {
  const asset = perpAssetIndex(meta, coin);
  return { asset, szDecimals: meta.universe[asset]!.szDecimals, isSpot: false };
}

/** Spot size decimals come from the base token. */
export function spotAssetInfo(spotMeta: SpotMeta, coin: string): AssetInfo {
  const pair = findSpot(spotMeta, coin);
  const base = spotMeta.tokens.find((t) => t.index === pair.tokens[0]);
  if (!base) throw new Error(`Spot pair ${coin} has no base token ${pair.tokens[0]}`);
  return { asset: SPOT_ASSET_OFFSET + pair.index, szDecimals: base.szDecimals, isSpot: true };
}

/**
 * Round a price to Hyperliquid tick rules: at most 5 significant figures and at most
 * (6 − szDecimals) decimals for perps, (8 − szDecimals) for spot. Integer prices are
 * always valid, so values ≥ 100000 round to an integer instead of losing digits.
 */
export function roundPrice(px: number, szDecimals: number, isSpot = false): number {
  if (!Number.isFinite(px)) throw new Error(`Invalid price ${px}`);
  const maxDecimals = Math.max(0, (isSpot ? 8 : 6) - szDecimals);
  const sig = Math.abs(px) >= 1e5 ? Math.round(px) : Number(px.toPrecision(5));
  return Number(sig.toFixed(maxDecimals));
}

/** Round a size to szDecimals (nearest). */
export function roundSize(sz: number, szDecimals: number): number {
  if (!Number.isFinite(sz)) throw new Error(`Invalid size ${sz}`);
  return Number(sz.toFixed(szDecimals));
}
