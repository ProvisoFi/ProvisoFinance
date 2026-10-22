// Deploys ThesisSeal and StampRoots to Robinhood Chain TESTNET with the relayer key from
// .env.testnet, and appends their addresses there. CallerShare needs the testnet USDG address
// and the swap adapter the Uniswap v4 PoolManager; pass USDG / POOL_MANAGER to include them (the
// adapter pins TESTNET_SWAP's test feeds and tUSDG at deploy).
// The relayer is ThesisSeal's revealer. ONLY_THESIS_SEAL=1 redeploys just ThesisSeal.
//   bun --env-file=.env.testnet packages/chain/scripts/deploy-testnet.ts
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, formatEther, http, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { callerShareAbi, provisoSwapAdapterAbi, stampRootsAbi, thesisSealAbi } from "../src/abi.ts";
import { callerShareBytecode, provisoSwapAdapterBytecode, stampRootsBytecode, thesisSealBytecode } from "../src/bytecode.ts";
import { robinhoodTestnet } from "../src/chains.ts";
import { adapterPins, TESTNET_SWAP } from "../src/swaps.ts";

if (process.env.CHAIN_NETWORK !== "testnet") throw new Error("This script only deploys to testnet.");
const key = process.env.RELAYER_PRIVATE_KEY as Hex;
const account = privateKeyToAccount(key);
const rpc = process.env.RHC_RPC_URL ?? robinhoodTestnet.rpcUrls.default.http[0];
const pub = createPublicClient({ chain: robinhoodTestnet, transport: http(rpc) });
const wallet = createWalletClient({ chain: robinhoodTestnet, transport: http(rpc), account });

const balance = await pub.getBalance({ address: account.address });
console.log(`deployer ${account.address} · ${formatEther(balance)} ETH on chain ${robinhoodTestnet.id}`);
if (balance === 0n) throw new Error("Fund the deployer with Robinhood Chain testnet ETH first.");

async function deploy(name: string, abi: Abi, bytecode: Hex, args: unknown[] = []) {
  // Untyped args: each contract is deployed with its own constructor tuple.
  const hash = await wallet.deployContract({ abi, bytecode, args } as unknown as Parameters<typeof wallet.deployContract>[0]);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`${name} deploy failed: ${hash}`);
  console.log(`${name} ${r.contractAddress} (tx ${hash})`);
  return r.contractAddress as Address;
}

const startBlock = await pub.getBlockNumber();
const out: Record<string, string> = {
  THESIS_SEAL_ADDRESS: await deploy("ThesisSeal", thesisSealAbi, thesisSealBytecode, [account.address]),
};
if (!process.env.ONLY_THESIS_SEAL)
  out.STAMP_ROOTS_ADDRESS = await deploy("StampRoots", stampRootsAbi, stampRootsBytecode, [account.address]);
if (process.env.USDG)
  out.CALLER_SHARE_ADDRESS = await deploy("CallerShare", callerShareAbi, callerShareBytecode, [process.env.USDG, account.address]);
if (process.env.POOL_MANAGER)
  out.SWAP_ADAPTER_ADDRESS = await deploy("ProvisoSwapAdapter", provisoSwapAdapterAbi, provisoSwapAdapterBytecode, [process.env.POOL_MANAGER, 60n, ...adapterPins(TESTNET_SWAP)]); // feeds pinned: the test feeds

if (!process.env.ONLY_THESIS_SEAL) out.CONTRACTS_DEPLOY_BLOCK = String(startBlock); // log scans start at the oldest contract
appendFileSync(
  join(import.meta.dir, "../../../.env.testnet"),
  `\n# Deployed ${new Date().toISOString()}\n` + Object.entries(out).map(([k, v]) => `${k}=${v}`).join("\n") + "\n",
);
console.log("addresses appended to .env.testnet");
