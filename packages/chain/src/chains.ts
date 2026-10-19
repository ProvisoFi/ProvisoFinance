import { defineChain, type Address } from "viem";

// Robinhood Chain (Arbitrum Orbit L2, ETH gas). Testnet is the default until mainnet launch.
// Verified 2026-10-19: rpc.testnet.chain.robinhood.com answers eth_chainId 0xb626 (46630).
export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Explorer", url: "https://explorer.testnet.chain.robinhood.com" } },
  testnet: true,
});

export const anvil = defineChain({
  id: 31337,
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  testnet: true,
});

export type Network = "testnet" | "local";
export const chains = { testnet: robinhoodTestnet, local: anvil } as const;

// Server-side: CHAIN_NETWORK; browser: NEXT_PUBLIC_CHAIN_NETWORK. Mainnet is added after testnet sign-off.
export function network(): Network {
  const n = process.env.CHAIN_NETWORK ?? process.env.NEXT_PUBLIC_CHAIN_NETWORK ?? "testnet";
  if (n !== "testnet" && n !== "local") throw new Error(`Unsupported chain network: ${n}`);
  return n;
}

export type Deployment = { thesisSeal?: Address; stampRoots?: Address; callerShare?: Address; swapAdapter?: Address };

// Addresses come from env until the testnet deploy is recorded here.
export function deployment(): Deployment {
  const env = (k: string) => (process.env[k] || process.env[`NEXT_PUBLIC_${k}`]) as Address | undefined;
  return {
    thesisSeal: env("THESIS_SEAL_ADDRESS"),
    stampRoots: env("STAMP_ROOTS_ADDRESS"),
    callerShare: env("CALLER_SHARE_ADDRESS"),
    swapAdapter: env("SWAP_ADAPTER_ADDRESS"),
  };
}
