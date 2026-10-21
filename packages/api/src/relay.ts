// Funding routes through Relay (public intents relayer): Robinhood Chain USDG ⇄ Hyperliquid perps
// USDC, with refunds to the source. Relay's testnet API only serves Base Sepolia and Sepolia
// (checked 2026-10-20), so routes are mainnet-only; on testnet `routeConfig()` returns null.
import { MAINNET_USDG, robinhoodMainnet } from "@proviso/chain";
import { z } from "zod";

export const ROUTES_MAINNET = {
  api: "https://api.relay.link",
  rhc: { chainId: robinhoodMainnet.id, usdg: MAINNET_USDG, decimals: 6 },
  hl: { chainId: 1337, usdc: "0x00000000000000000000000000000000", decimals: 8 },
} as const;
export type RouteConfig = typeof ROUTES_MAINNET;

export const TESTNET_UNAVAILABLE =
  "Funding routes aren't available on testnet: no public relayer serves Robinhood Chain testnet or Hyperliquid testnet. They open with mainnet.";

export function routeConfig(env: Record<string, string | undefined> = process.env): RouteConfig | null {
  return env.CHAIN_NETWORK === "mainnet" ? ROUTES_MAINNET : null;
}

export type Direction = "fund" | "exit"; // fund: RHC USDG → HL USDC · exit: HL USDC → RHC USDG

const Step = z.object({
  id: z.string(),
  kind: z.enum(["transaction", "signature"]),
  action: z.string().optional(),
  description: z.string().optional(),
  items: z.array(z.object({ status: z.string(), data: z.unknown() }).loose()),
}).loose();
const Quote = z.object({
  requestId: z.string().optional(),
  steps: z.array(Step),
  fees: z.unknown().optional(),
  details: z
    .object({
      currencyIn: z.object({ amount: z.string() }).loose().optional(),
      currencyOut: z.object({ amount: z.string(), minimumAmount: z.string().optional() }).loose().optional(),
      timeEstimate: z.number().optional(),
    })
    .loose()
    .optional(),
}).loose();
export type RelayQuote = z.infer<typeof Quote>;

export const toUnits = (usd: number, decimals: number) => BigInt(Math.round(usd * 10 ** Math.min(decimals, 6))) * 10n ** BigInt(Math.max(decimals - 6, 0));

export async function relayQuote(
  cfg: RouteConfig,
  p: { user: string; direction: Direction; amountUsd: number },
  fetcher: typeof fetch = fetch,
  apiKey = process.env.RELAY_API_KEY,
): Promise<RelayQuote> {
  const fund = p.direction === "fund";
  const body = {
    user: p.user,
    recipient: p.user,
    refundTo: p.user, // refunds go back to the source account
    originChainId: fund ? cfg.rhc.chainId : cfg.hl.chainId,
    destinationChainId: fund ? cfg.hl.chainId : cfg.rhc.chainId,
    originCurrency: fund ? cfg.rhc.usdg : cfg.hl.usdc,
    destinationCurrency: fund ? cfg.hl.usdc : cfg.rhc.usdg,
    amount: toUnits(p.amountUsd, fund ? cfg.rhc.decimals : cfg.hl.decimals).toString(),
    tradeType: "EXACT_INPUT",
    ...(fund ? {} : { protocolVersion: "v2" }), // required for withdrawals from Hyperliquid
  };
  const res = await fetcher(`${cfg.api}/quote/v2`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(apiKey ? { "x-api-key": apiKey } : {}) },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { message?: string }).message ?? `Relay quote failed (${res.status})`);
  return Quote.parse(json);
}

const Status = z.object({ status: z.string(), inTxHashes: z.array(z.string()).optional(), txHashes: z.array(z.string()).optional() }).loose();

// Relay intent states → routes.status
export function mapStatus(s: string): "submitted" | "bridging" | "done" | "refunded" | "failed" {
  if (s === "success") return "done";
  if (s === "refund" || s === "refunded") return "refunded";
  if (s === "failure" || s === "failed") return "failed";
  if (s === "pending" || s === "submitted" || s === "delayed") return "bridging";
  return "submitted";
}

export async function relayStatus(cfg: RouteConfig, requestId: string, fetcher: typeof fetch = fetch) {
  const res = await fetcher(`${cfg.api}/intents/status/v3?requestId=${encodeURIComponent(requestId)}`);
  if (!res.ok) throw new Error(`Relay status failed (${res.status})`);
  const s = Status.parse(await res.json());
  return { status: mapStatus(s.status), raw: s.status, inTx: s.inTxHashes?.[0], outTx: s.txHashes?.[0] };
}
