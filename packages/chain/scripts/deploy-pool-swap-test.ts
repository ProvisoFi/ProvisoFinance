// Deploys Uniswap v4's PoolSwapTest router on Robinhood Chain TESTNET (relayer key). The ops pool
// aligner trades through it to keep the testnet TSLA/tUSDG pool at the test-feed price.
//   bun --env-file=.env.testnet packages/chain/scripts/deploy-pool-swap-test.ts   (run `forge build` first)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhoodTestnet } from "../src/chains.ts";

if (process.env.CHAIN_NETWORK !== "testnet") throw new Error("testnet only");
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const art = JSON.parse(readFileSync(join(import.meta.dir, "../../../contracts/out/PoolSwapTest.sol/PoolSwapTest.json"), "utf8"));
const account = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY as Hex);
const pub = createPublicClient({ chain: robinhoodTestnet, transport: http(process.env.RHC_RPC_URL) });
const wallet = createWalletClient({ chain: robinhoodTestnet, transport: http(process.env.RHC_RPC_URL), account });
const hash = await wallet.deployContract({ abi: art.abi as Abi, bytecode: art.bytecode.object as Hex, args: [POOL_MANAGER] });
const r = await pub.waitForTransactionReceipt({ hash });
if (r.status !== "success" || !r.contractAddress) throw new Error(`deploy failed ${hash}`);
console.log(`PoolSwapTest ${r.contractAddress} (tx ${hash})`);
