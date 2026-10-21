// Deploys ProvisoSwapAdapter (on the Uniswap v4 PoolManager) and SwapKeyPolicy (bound to that
// adapter) on Robinhood Chain TESTNET with the relayer key. REUSE_ADAPTER=1 keeps the recorded
// adapter (TESTNET_DEPLOYMENT.swapAdapter) and deploys only a new SwapKeyPolicy bound to it.
//   bun --env-file=.env.testnet packages/chain/scripts/deploy-swaps.ts
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { provisoSwapAdapterAbi, swapKeyPolicyAbi } from "../src/abi.ts";
import { provisoSwapAdapterBytecode, swapKeyPolicyBytecode } from "../src/bytecode.ts";
import { robinhoodTestnet, TESTNET_DEPLOYMENT, TESTNET_POOL_MANAGER } from "../src/chains.ts";

if (process.env.CHAIN_NETWORK !== "testnet") throw new Error("testnet only");
const account = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY as Hex);
const pub = createPublicClient({ chain: robinhoodTestnet, transport: http() });
const wallet = createWalletClient({ chain: robinhoodTestnet, transport: http(), account });

async function deploy(name: string, abi: Abi, bytecode: Hex, args: unknown[]) {
  const hash = await wallet.deployContract({ abi, bytecode, args } as unknown as Parameters<typeof wallet.deployContract>[0]);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`${name} deploy failed ${hash}`);
  console.log(`${name} ${r.contractAddress} (tx ${hash})`);
  return r.contractAddress as Address;
}

const reuse = Boolean(process.env.REUSE_ADAPTER);
const adapter = reuse
  ? TESTNET_DEPLOYMENT.swapAdapter!
  : await deploy("ProvisoSwapAdapter", provisoSwapAdapterAbi, provisoSwapAdapterBytecode, [TESTNET_POOL_MANAGER, 60n]); // maxOracleAge: test feeds are pushed every few s
const policy = await deploy("SwapKeyPolicy", swapKeyPolicyAbi, swapKeyPolicyBytecode, [adapter]);
appendFileSync(
  join(import.meta.dir, "../../../.env.testnet"),
  (reuse ? "" : `SWAP_ADAPTER_ADDRESS=${adapter}\n`) + `SWAP_KEY_POLICY_ADDRESS=${policy}\n`,
);
