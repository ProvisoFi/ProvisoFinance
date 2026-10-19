// Lets CallerShare pull testnet USDG from the poster (the relayer) when an epoch is posted.
//   bun --env-file=.env.testnet packages/chain/scripts/approve-caller-share.ts
import { createPublicClient, createWalletClient, erc20Abi, http, maxUint256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhoodTestnet, TESTNET_DEPLOYMENT, TESTNET_USDG } from "../src/chains.ts";

if (process.env.CHAIN_NETWORK !== "testnet") throw new Error("testnet only");
const account = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY as Hex);
const pub = createPublicClient({ chain: robinhoodTestnet, transport: http() });
const wallet = createWalletClient({ chain: robinhoodTestnet, transport: http(), account });
const spender = TESTNET_DEPLOYMENT.callerShare!;

const hash = await wallet.writeContract({ address: TESTNET_USDG, abi: erc20Abi, functionName: "approve", args: [spender, maxUint256] });
await pub.waitForTransactionReceipt({ hash });
const [allowance, balance] = await Promise.all([
  pub.readContract({ address: TESTNET_USDG, abi: erc20Abi, functionName: "allowance", args: [account.address, spender] }),
  pub.readContract({ address: TESTNET_USDG, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
]);
console.log(`approve tx ${hash} · allowance ${allowance === maxUint256 ? "max" : allowance} · relayer USDG ${balance}`);
