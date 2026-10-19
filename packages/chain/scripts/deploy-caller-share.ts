// Deploys CallerShare on Robinhood Chain TESTNET against the testnet USDG, poster = relayer.
//   bun --env-file=.env.testnet packages/chain/scripts/deploy-caller-share.ts
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { callerShareAbi } from "../src/abi.ts";
import { callerShareBytecode } from "../src/bytecode.ts";
import { robinhoodTestnet, TESTNET_USDG } from "../src/chains.ts";

if (process.env.CHAIN_NETWORK !== "testnet") throw new Error("testnet only");
const account = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY as Hex);
const pub = createPublicClient({ chain: robinhoodTestnet, transport: http() });
const wallet = createWalletClient({ chain: robinhoodTestnet, transport: http(), account });

const hash = await wallet.deployContract({ abi: callerShareAbi, bytecode: callerShareBytecode, args: [TESTNET_USDG, account.address] });
const r = await pub.waitForTransactionReceipt({ hash });
if (r.status !== "success" || !r.contractAddress) throw new Error(`deploy failed ${hash}`);
console.log(`CallerShare ${r.contractAddress} (tx ${hash}) · USDG ${TESTNET_USDG} · poster ${account.address}`);
appendFileSync(join(import.meta.dir, "../../../.env.testnet"), `CALLER_SHARE_ADDRESS=${r.contractAddress}\n`);
