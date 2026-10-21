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

export type Deployment = {
  thesisSeal?: Address;
  stampRoots?: Address;
  callerShare?: Address;
  swapAdapter?: Address;
  swapKeyPolicy?: Address;
};

// Robinhood Chain testnet deploy of 2026-10-19 (block 138954163), deployer/poster
// 0x2e1054b380Fb87AE2B2Df3c269d077Ee93567d3B.
export const TESTNET_DEPLOYMENT: Deployment = {
  thesisSeal: "0x7dc7977552dcec00875e38b2cca2744919145ee3",
  stampRoots: "0xa81c8ff3cb92e15c939cb9ad644970725fd78206",
  callerShare: "0x5551002325612905dfdaf575bd22fa66747b5cff", // USDG = TESTNET_USDG, poster = deployer
  swapAdapter: "0x1f10c38908ea388a7fc0397631b041ea5ff5f9ec", // Uniswap v4 PoolManager 0x8366a39c…0951
  swapKeyPolicy: "0xc6e7a72bd814057eb09d081e8af4aa93e4ccdea6", // ERC-7579 executor bound to swapAdapter
};
export const TESTNET_DEPLOY_BLOCK = 138954163n;
/** The ops relayer EOA: deployer, StampRoots/CallerShare poster, test-feed updater, ThesisSeal revealer. */
export const TESTNET_RELAYER = "0x2e1054b380Fb87AE2B2Df3c269d077Ee93567d3B" as const;
/** Uniswap v4 PoolManager: same CREATE2 address as mainnet, Blockscout-verified. */
export const TESTNET_POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951" as const;
// Testnet USDG ("Global Dollar", 6 decimals): ERC-1967 proxy with verified "USDG" implementation,
// the same proxy bytecode as mainnet USDG 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168.
// Identified on-chain 2026-10-19; Robinhood's docs list only the mainnet address.
export const TESTNET_USDG = "0x7E955252E15c84f5768B83c41a71F9eba181802F" as const;

// Testnet-only push feeds (ProvisoTestFeed, 8 decimals, multiplier included; updater = relayer).
// Robinhood Chain testnet has no Chainlink feeds. Never use these on mainnet.
export const TESTNET_TEST_FEEDS = {
  "TSLA/USDG": { feed: "0xe08149a5ee7803fc106090c7dae2ce066cb1b904", source: "hl:xyz:TSLA" },
  "AMZN/USDG": { feed: "0xc5898bda5ca3e4eef7c8c47220711c54e97164e9", source: "hl:xyz:AMZN" },
} as const;

// Env overrides the recorded deployment (local anvil runs set their own addresses).
export function deployment(): Deployment {
  const env = (k: string) => (process.env[k] || process.env[`NEXT_PUBLIC_${k}`]) as Address | undefined;
  const base = network() === "testnet" ? TESTNET_DEPLOYMENT : {};
  return {
    thesisSeal: env("THESIS_SEAL_ADDRESS") ?? base.thesisSeal,
    stampRoots: env("STAMP_ROOTS_ADDRESS") ?? base.stampRoots,
    callerShare: env("CALLER_SHARE_ADDRESS") ?? base.callerShare,
    swapAdapter: env("SWAP_ADAPTER_ADDRESS") ?? base.swapAdapter,
    swapKeyPolicy: env("SWAP_KEY_POLICY_ADDRESS") ?? base.swapKeyPolicy,
  };
}
