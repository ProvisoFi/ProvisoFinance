import type { Hex } from "viem";

export type NetworkName = "testnet" | "mainnet";

export interface Network {
  name: NetworkName;
  apiUrl: string;
  wsUrl: string;
  /** Phantom-agent source for L1 actions. */
  source: "a" | "b";
  /** `hyperliquidChain` field of user-signed actions. */
  hyperliquidChain: "Mainnet" | "Testnet";
  /** EIP-712 chainId used by the wallet for user-signed actions. */
  signatureChainId: Hex;
}

/** USDC as `name:tokenId`, the collateral token of the main dex and of xyz (agentSendAsset's `token`). */
export const USDC_TOKEN: Readonly<Record<NetworkName, string>> = {
  mainnet: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
  testnet: "USDC:0xeb62eee3685fc4c43992febcd9e75443",
};

export const NETWORKS: Readonly<Record<NetworkName, Network>> = {
  testnet: {
    name: "testnet",
    apiUrl: "https://api.hyperliquid-testnet.xyz",
    wsUrl: "wss://api.hyperliquid-testnet.xyz/ws",
    source: "b",
    hyperliquidChain: "Testnet",
    signatureChainId: "0x66eee",
  },
  mainnet: {
    name: "mainnet",
    apiUrl: "https://api.hyperliquid.xyz",
    wsUrl: "wss://api.hyperliquid.xyz/ws",
    source: "a",
    hyperliquidChain: "Mainnet",
    signatureChainId: "0xa4b1",
  },
};

/**
 * Resolve the active network. Testnet unless HL_NETWORK=mainnet.
 * An unrecognised HL_NETWORK value throws instead of silently picking one.
 */
export function network(name?: string): Network {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const value = (name ?? env?.HL_NETWORK ?? "").trim().toLowerCase();
  if (value === "" || value === "testnet") return NETWORKS.testnet;
  if (value === "mainnet") return NETWORKS.mainnet;
  throw new Error(`Unknown HL_NETWORK "${value}" (expected "testnet" or "mainnet")`);
}

/**
 * HIP-3 dexes Proviso lists (HL_DEXES, comma-separated). Default: xyz (trade.xyz: stocks, metals,
 * oil, indices; about 97% of HIP-3 volume). Others stay off until reviewed.
 */
export function listedDexes(env: Record<string, string | undefined> = typeof process === "undefined" ? {} : process.env): string[] {
  const raw = env.HL_DEXES ?? "xyz";
  return raw.split(",").map((s) => s.trim()).filter((s) => /^[a-z0-9]{1,16}$/.test(s));
}
