import { defineChain, type Address, type Chain } from "viem";
import mainnetJson from "../deployments/mainnet.json";

// Robinhood Chain (Arbitrum Orbit L2, ETH gas). Testnet is the default; CHAIN_NETWORK=mainnet
// (browser: NEXT_PUBLIC_CHAIN_NETWORK) switches everything below to chain 4663.
export const robinhoodMainnet = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  // Public RPC, rate-limited: servers use rhcRpcUrl() (an Alchemy key via RHC_RPC_KEY).
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
});

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

export type Network = "mainnet" | "testnet" | "local";
export const chains = { mainnet: robinhoodMainnet, testnet: robinhoodTestnet, local: anvil } as const;

/** Server-side: CHAIN_NETWORK; browser: NEXT_PUBLIC_CHAIN_NETWORK. Defaults to testnet; throws on any other value. */
export function network(): Network {
  const n = process.env.CHAIN_NETWORK || process.env.NEXT_PUBLIC_CHAIN_NETWORK || "testnet"; // "" (unset compose var) = default
  if (n !== "mainnet" && n !== "testnet" && n !== "local") throw new Error(`Unsupported chain network: ${n}`);
  return n;
}

// The RPC feeds the evaluator its prices and sees every signed swap first, so its host is fixed in
// code (measured with the image), never taken from env. Only a provider key comes from env.
export const RHC_RPC_HOSTS: Record<Network, readonly string[]> = {
  mainnet: ["rpc.mainnet.chain.robinhood.com", "robinhood-mainnet.g.alchemy.com"],
  testnet: ["rpc.testnet.chain.robinhood.com"],
  local: ["127.0.0.1", "localhost"],
};
const ALCHEMY_MAINNET = "https://robinhood-mainnet.g.alchemy.com/v2/";

/**
 * The Robinhood Chain RPC URL: Alchemy with RHC_RPC_KEY (mainnet), else RHC_RPC_URL (dev), else
 * the public RPC. Throws when the host isn't in RHC_RPC_HOSTS for the network.
 */
export function rhcRpcUrl(env: Record<string, string | undefined> = process.env, net: Network = network()): string {
  const key = env.RHC_RPC_KEY;
  if (key && (net !== "mainnet" || !/^[\w-]+$/.test(key))) throw new Error("RHC_RPC_KEY is a mainnet Alchemy key ([A-Za-z0-9_-])");
  const url = key ? ALCHEMY_MAINNET + key : env.RHC_RPC_URL || chains[net].rpcUrls.default.http[0]!;
  const u = new URL(url);
  if (!RHC_RPC_HOSTS[net].includes(u.hostname) || (net !== "local" && u.protocol !== "https:"))
    throw new Error(`RHC RPC host ${u.host} is not allowed on ${net} (allowed: ${RHC_RPC_HOSTS[net].join(", ")})`);
  return url;
}

/**
 * Startup guard: Hyperliquid and Robinhood Chain are both mainnet or both not, and the RPC answers
 * the configured chain id. Throws otherwise, so the service refuses to start.
 */
export async function checkRhcNetwork(client: { getChainId(): Promise<number> }, hlNetwork: string, net: Network = network()) {
  if ((net === "mainnet") !== (hlNetwork === "mainnet")) throw new Error(`HL_NETWORK ${hlNetwork} doesn't match CHAIN_NETWORK ${net}`);
  const id = await client.getChainId();
  const want = chains[net].id;
  if (id !== want) throw new Error(`RHC RPC answers chain ${id}, expected ${want} (${net})`);
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
/** Uniswap v4 PoolManager: the same CREATE2 address on mainnet and testnet (Blockscout-verified). */
export const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951" as const;
export const TESTNET_POOL_MANAGER = POOL_MANAGER;
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

// Robinhood Chain mainnet: written by scripts/deploy-mainnet.ts (null until deployed).
type DeployedJson = { startBlock?: number | string | null } & Partial<Record<keyof Deployment, { address?: Address } | null>>;
const MAINNET_JSON = mainnetJson as DeployedJson;
const CONTRACTS = ["thesisSeal", "stampRoots", "callerShare", "swapAdapter", "swapKeyPolicy"] as const;
export const MAINNET_DEPLOYMENT: Deployment = Object.fromEntries(CONTRACTS.map((k) => [k, MAINNET_JSON[k]?.address ?? undefined]));
export const MAINNET_DEPLOY_BLOCK = BigInt(MAINNET_JSON.startBlock ?? 0);
/**
 * Retired SwapKeyPolicy deployments (mainnet.json previous[]). Accounts set up on one still have it
 * installed with a live policy until they uninstall it, so revoke removes them too (L-4).
 */
export function legacySwapKeyPolicies(): Address[] {
  if (network() !== "mainnet") return [];
  const prev = (mainnetJson as { previous?: { contract: string; address: Address }[] }).previous ?? [];
  return prev.filter((p) => p.contract === "swapKeyPolicy").map((p) => p.address);
}
/** The mainnet ops relayer EOA (poster, revealer, swap-setup sender). */
export const MAINNET_RELAYER = "0xb257791e8c789Bc792EF4794A02Aa9B17BA080f1" as const;
/** USDG ("Global Dollar", 6 decimals), docs.robinhood.com. */
export const MAINNET_USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;

export type ChainConfig = {
  chain: Chain;
  /** How user-facing copy names the network. */
  label: string;
  deployBlock: bigint;
  relayer?: Address;
  poolManager?: Address;
  usdg?: Address;
};
export const CHAIN_CONFIG: Record<Network, ChainConfig> = {
  mainnet: { chain: robinhoodMainnet, label: "Robinhood Chain", deployBlock: MAINNET_DEPLOY_BLOCK, relayer: MAINNET_RELAYER, poolManager: POOL_MANAGER, usdg: MAINNET_USDG },
  testnet: { chain: robinhoodTestnet, label: "Robinhood Chain testnet", deployBlock: TESTNET_DEPLOY_BLOCK, relayer: TESTNET_RELAYER, poolManager: POOL_MANAGER, usdg: TESTNET_USDG },
  local: { chain: anvil, label: "local Anvil", deployBlock: 0n },
};
/** The active network's chain, explorer (chain.blockExplorers), deploy block, relayer, PoolManager and USDG. */
export const chainConfig = () => CHAIN_CONFIG[network()];

/**
 * Env overrides the recorded deployment (local anvil runs set their own addresses). On mainnet a
 * missing address throws: nothing silently runs half-deployed.
 */
export function deployment(): Deployment {
  const net = network();
  const env = (k: string) => (process.env[k] || process.env[`NEXT_PUBLIC_${k}`]) as Address | undefined;
  const base = net === "testnet" ? TESTNET_DEPLOYMENT : net === "mainnet" ? MAINNET_DEPLOYMENT : {};
  const d: Deployment = {
    thesisSeal: env("THESIS_SEAL_ADDRESS") ?? base.thesisSeal,
    stampRoots: env("STAMP_ROOTS_ADDRESS") ?? base.stampRoots,
    callerShare: env("CALLER_SHARE_ADDRESS") ?? base.callerShare,
    swapAdapter: env("SWAP_ADAPTER_ADDRESS") ?? base.swapAdapter,
    swapKeyPolicy: env("SWAP_KEY_POLICY_ADDRESS") ?? base.swapKeyPolicy,
  };
  const missing = CONTRACTS.filter((k) => !d[k]);
  if (net === "mainnet" && missing.length) throw new Error(`Mainnet contracts missing (packages/chain/deployments/mainnet.json): ${missing.join(", ")}`);
  return d;
}
