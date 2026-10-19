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
