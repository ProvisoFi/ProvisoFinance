import { network } from "@proviso/hl";
// Records market history the tester needs but no venue serves later:
// Hyperliquid has no historical open-interest API, so OI (plus mark, oracle, funding,
// volume) is snapshotted from metaAndAssetCtxs. Fear & Greed history is backfilled.
// Same network as the evaluator (testnet until mainnet sign-off).
export const HL_INFO = `${network().apiUrl}/info`;
export const FNG_URL = "https://api.alternative.me/fng/?limit=0";
// Backend spec §5 liquidity floor; thinner markets can't be used anyway. Testnet volumes are tiny,
// so the testnet floor matches the evaluator's (and the Supabase cron recorder's $1k).
export const MIN_VOLUME_USD =
  network().name === "testnet" ? Number(process.env.TESTNET_MIN_HL_VOLUME_USD ?? 1000) : 250_000;

type AssetMeta = { name: string; isDelisted?: boolean };
type AssetCtx = { markPx: string; oraclePx?: string; funding?: string; openInterest?: string; dayNtlVlm?: string };
export type MetaAndCtxs = [{ universe: AssetMeta[] }, AssetCtx[]];

export type SnapshotRow = {
  coin: string;
  ts: Date;
  mark: string;
  oracle: string | null;
  funding: string | null;
  oi: string | null;
  volume24h: string | null;
};

export function snapshotRows([meta, ctxs]: MetaAndCtxs, ts: Date, minVolume = MIN_VOLUME_USD): SnapshotRow[] {
  return meta.universe.flatMap((asset, i) => {
    const c = ctxs[i];
    if (!c || asset.isDelisted || Number(c.dayNtlVlm ?? 0) < minVolume) return [];
    return [
      {
        coin: asset.name,
        ts,
        mark: c.markPx,
        oracle: c.oraclePx ?? null,
        funding: c.funding ?? null,
        oi: c.openInterest ?? null,
        volume24h: c.dayNtlVlm ?? null,
      },
    ];
  });
}

export type FngResponse = { data: { value: string; timestamp: string }[] };

export const fngRows = (r: FngResponse) =>
  r.data.map((d) => ({ ts: new Date(Number(d.timestamp) * 1000), value: Number(d.value) }));

export async function fetchMetaAndCtxs(fetcher = fetch): Promise<MetaAndCtxs> {
  const res = await fetcher(HL_INFO, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
  });
  if (!res.ok) throw new Error(`Hyperliquid info ${res.status}`);
  return res.json() as Promise<MetaAndCtxs>;
}
