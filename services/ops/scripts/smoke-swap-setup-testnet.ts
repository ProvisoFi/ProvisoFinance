// Live check of the relayed R4 setup on Robinhood Chain TESTNET: a fresh test wallet with no ETH
// (standing in for a Privy embedded wallet) signs the 7702 authorization, the install UserOp and
// both policies built by buildSwapSetup (what swapKey.prepare returns); the real swap_setup handler
// relays them; then the session key swaps $1 tUSDG for TSLA. DB rows it creates are removed.
//   bun --env-file=.env.testnet --env-file=apps/web/.env.local services/ops/scripts/smoke-swap-setup-testnet.ts
import {
  buildSwapSetup,
  kernelAbi,
  kernelDelegationCode,
  MODULE_TYPE_EXECUTOR,
  robinhoodTestnet,
  swapKeyPolicyAbi,
  swapKeyPolicyHash,
  swapSetupTypedData,
  TESTNET_DEPLOYMENT,
  TESTNET_SWAP,
  toJsonSafe,
} from "@proviso/chain";
import { activity, createDb, feedWanted, swapKeys, users } from "@proviso/db";
import { eq } from "drizzle-orm";
import { createWalletClient, erc20Abi, formatUnits, http, type Abi } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { SessionKeyManager } from "../../core/src/rhc/policy.ts";
import { sendSwap } from "../../core/src/rhc/executor.ts";
import { handleSwapKeyRequest } from "../../core/src/rhc/runner.ts";
import { UNISWAP_V4 } from "../../core/src/rhc/NETWORK.ts";
import { chainFromEnv } from "../src/runtime/chain.ts";
import { swapSetupHandler } from "../src/runtime/swaps.ts";

if (process.env.CHAIN_NETWORK !== "testnet") throw new Error("testnet only");
const chain = chainFromEnv()!;
const pub = chain.clients.public;
const D = { swapAdapter: TESTNET_DEPLOYMENT.swapAdapter!, swapKeyPolicy: TESTNET_DEPLOYMENT.swapKeyPolicy! };
const db = createDb();
const user = privateKeyToAccount(generatePrivateKey());
const owner = user.address.toLowerCase();
const check = (ok: unknown, what: string) => {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok  ${what}`);
};

try {
  await db.insert(users).values({ address: owner });
  // core's side (enclave): sealed session key row
  const sealKey = crypto.getRandomValues(new Uint8Array(32));
  const manager = new SessionKeyManager(sealKey);
  const sessionKey = await handleSwapKeyRequest(db, manager, owner, { chainId: robinhoodTestnet.id, days: TESTNET_SWAP.policyDays });
  const [row] = await db.select().from(swapKeys).where(eq(swapKeys.address, owner));

  // API prepare + the browser's signatures
  const setup = await buildSwapSetup(pub as never, {
    chainId: robinhoodTestnet.id, account: user.address, sessionKey: sessionKey as `0x${string}`,
    expiresAt: BigInt(Math.floor(row!.expiresAt.getTime() / 1000)), ...D, markets: TESTNET_SWAP.markets, caps: TESTNET_SWAP.caps,
  });
  check(setup.install?.authorization, "fresh account: needs 7702 authorization + install UserOp");
  const a = setup.install!.authorization!;
  const auth = await user.signAuthorization({ contractAddress: a.address, chainId: a.chainId, nonce: a.nonce });
  const td = swapSetupTypedData(setup, D);
  const signatures = {
    authorization: { address: auth.address, chainId: auth.chainId, nonce: auth.nonce, r: auth.r, s: auth.s, yParity: auth.yParity! },
    userOp: await user.signMessage({ message: { raw: setup.install!.userOpHash } }),
    adapter: await Promise.all(td.adapter.map((t) => user.signTypedData(t as never))),
    policy: await user.signTypedData(td.policy as never),
  };
  await db.update(swapKeys).set({ setup: { ...(toJsonSafe(setup) as object), signatures } }).where(eq(swapKeys.address, owner));
  check((await pub.getBalance({ address: user.address })) === 0n, "the user holds no ETH");

  // ops relays
  const errors: unknown[] = [];
  await swapSetupHandler(db, chain.clients, { ...D, testnetUsdg: TESTNET_SWAP.usdg }, (m, e) => errors.push([m, e]))({ address: owner }, { readCt: 1 } as never);
  const [done] = await db.select().from(swapKeys).where(eq(swapKeys.address, owner));
  check(done?.registeredAt, "swap key registered");
  check((await pub.getCode({ address: user.address }))?.toLowerCase() === kernelDelegationCode, "account delegated to Kernel v3.3");
  check(await pub.readContract({ address: user.address, abi: kernelAbi, functionName: "isModuleInstalled", args: [MODULE_TYPE_EXECUTOR, D.swapKeyPolicy, "0x"] }), "SwapKeyPolicy installed as executor");
  check((await pub.readContract({ address: D.swapKeyPolicy, abi: swapKeyPolicyAbi as Abi, functionName: "activePolicy", args: [user.address] })) === swapKeyPolicyHash(setup.policy), "swap-key policy active");
  check((await pub.getBalance({ address: sessionKey as `0x${string}` })) > 0n, "session key funded with gas");
  const usdg0 = await pub.readContract({ address: TESTNET_SWAP.usdg, abi: erc20Abi, functionName: "balanceOf", args: [user.address] });
  check(usdg0 === 100_000_000n, "100 tUSDG dripped");
  check((await db.select().from(activity).where(eq(activity.address, owner))).some((r) => r.kind === "swaps_ready"), "swaps_ready activity");

  // core's fire path: the session key swaps (what SwapRunner does after unsealing)
  await db.insert(feedWanted).values({ feed: TESTNET_SWAP.markets[0]!.oracle.toLowerCase() }).onConflictDoUpdate({ target: feedWanted.feed, set: { wantedAt: new Date() } });
  await Bun.sleep(10_000);
  const session = createWalletClient({ chain: robinhoodTestnet, transport: http(process.env.RHC_RPC_URL), account: privateKeyToAccount(manager.unseal(done!.sealed as never)) });
  const tsla0 = await pub.readContract({ address: TESTNET_SWAP.tsla, abi: erc20Abi, functionName: "balanceOf", args: [user.address] });
  const sent = await sendSwap(
    { publicClient: pub, swapKeyPolicy: D.swapKeyPolicy, poolManager: UNISWAP_V4.poolManager, markets: TESTNET_SWAP.markets },
    { action: { venue: "rhc", action: "swap", tokenIn: "USDG", tokenOut: "TSLA", size: { usd: 1 }, maxSlipPct: 2 }, policy: setup.policy, wallet: session },
  );
  check(sent.plan.ok, `swap planned (${sent.plan.ok ? "" : sent.plan.reason})`);
  const r = await pub.waitForTransactionReceipt({ hash: sent.hash! });
  const tsla1 = await pub.readContract({ address: TESTNET_SWAP.tsla, abi: erc20Abi, functionName: "balanceOf", args: [user.address] });
  check(r.status === "success" && tsla1 > tsla0, `swap included: +${formatUnits(tsla1 - tsla0, 18)} TSLA (tx ${sent.hash})`);
  console.log({ user: user.address, sessionKey, relayerEth: formatUnits(await pub.getBalance({ address: chain.clients.account.address }), 18) });
  if (errors.length) console.log("handler errors:", errors);
} finally {
  await db.delete(activity).where(eq(activity.address, owner));
  await db.delete(swapKeys).where(eq(swapKeys.address, owner));
  await db.delete(users).where(eq(users.address, owner));
  process.exit(0);
}
