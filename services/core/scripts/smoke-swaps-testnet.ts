// Live R4 swap on Robinhood Chain TESTNET, end to end with throwaway test keys:
// a mock USDG (testnet USDG isn't obtainable) / TSLA Stock Token pool on the real Uniswap v4
// PoolManager, a test main key 7702-delegated to ZeroDev Kernel v3.3 with SwapKeyPolicy installed
// as an executor, a sealed session key, both policies signed, the test feed made fresh through
// feed_wanted, then one swap planned, simulated and sent by the session key.
//   bun --env-file=.env.testnet --env-file=apps/web/.env.local services/core/scripts/smoke-swaps-testnet.ts
// Re-runs reuse what's recorded in .env.testnet (SWAP_TEST_*). Run `forge build` first.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  concat,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  erc20Abi,
  formatUnits,
  http,
  parseAbi,
  parseEther,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createDb, feedWanted } from "@proviso/db";
import { robinhoodTestnet, TESTNET_DEPLOYMENT, TESTNET_TEST_FEEDS } from "@proviso/chain";
import { ACCOUNT_ABSTRACTION, TOKENS, UNISWAP_V4 } from "../src/rhc/NETWORK.ts";
import { MAX_ORACLE_AGE_S, nextPolicyNonce, readSlot0, sendSwap, swapAdapterAbi, swapKeyPolicyAbi, type RhcMarket } from "../src/rhc/executor.ts";
import { adapterPolicyFor, adapterPolicyTypedData, buildSwapKeyPolicy, SessionKeyManager, swapKeyPolicyTypedData, type PoolKey } from "../src/rhc/policy.ts";

if (process.env.CHAIN_NETWORK !== "testnet") throw new Error("testnet only");
const ENV_FILE = join(import.meta.dir, "../../../.env.testnet");
const OUT = join(import.meta.dir, "../../../contracts/out");
const art = (file: string, name = file) => {
  const j = JSON.parse(readFileSync(join(OUT, `${file}.sol`, `${name}.json`), "utf8"));
  return { abi: j.abi as Abi, bytecode: j.bytecode.object as Hex };
};
const record = (k: string, v: string) => appendFileSync(ENV_FILE, `${k}=${v}\n`);

const chain = robinhoodTestnet;
const pub = createPublicClient({ chain, transport: http(process.env.RHC_RPC_URL) }) as PublicClient;
const walletOf = (account: PrivateKeyAccount) => createWalletClient({ chain, transport: http(process.env.RHC_RPC_URL), account });
const relayer = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY as Hex);
const dep = walletOf(relayer);
const D = TESTNET_DEPLOYMENT;
const FEED = TESTNET_TEST_FEEDS["TSLA/USDG"].feed as Address;
const TSLA = TOKENS.tslaCandidate;
const feedAbi = parseAbi(["function latestRoundData() view returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80)"]);
const kernelAbi = parseAbi(["function installModule(uint256 moduleType, address module, bytes initData) payable", "function isModuleInstalled(uint256 moduleType, address module, bytes additionalContext) view returns (bool)"]);

async function send(w: WalletClient, address: Address, abi: Abi, functionName: string, args: unknown[], extra = {}) {
  const hash = await w.writeContract({ address, abi, functionName, args, chain, account: w.account!, ...extra } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
  return hash;
}
async function deploy(file: string, args: unknown[], name = file): Promise<Address> {
  const { abi, bytecode } = art(file, name);
  const hash = await dep.deployContract({ abi, bytecode, args, chain, account: relayer });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`${name} deploy failed ${hash}`);
  console.log(`deployed ${name} ${r.contractAddress}`);
  return r.contractAddress;
}
async function fund(to: Address, eth: string) {
  if ((await pub.getBalance({ address: to })) >= parseEther(eth) / 2n) return;
  await pub.waitForTransactionReceipt({ hash: await dep.sendTransaction({ to, value: parseEther(eth), chain, account: relayer }) });
}
const bal = (t: Address, who: Address) => pub.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [who] });

// 1. Feed fresh (ops pushes on demand while feed_wanted is recent).
const db = createDb();
async function freshFeed() {
  await db.insert(feedWanted).values({ feed: FEED.toLowerCase() }).onConflictDoUpdate({ target: feedWanted.feed, set: { wantedAt: new Date() } });
  for (let i = 0; i < 40; i++) {
    const [[, answer, , updatedAt], block] = await Promise.all([pub.readContract({ address: FEED, abi: feedAbi, functionName: "latestRoundData" }), pub.getBlock()]);
    if (answer > 0n && block.timestamp <= updatedAt + MAX_ORACLE_AGE_S - 15n) return answer;
    await Bun.sleep(3000);
  }
  throw new Error("test feed never became fresh: is ops pushing TSLA/USDG?");
}
const answer = await freshFeed();
console.log(`feed TSLA/USDG ${formatUnits(answer, 8)}`);

// 2. Mock USDG (same decimals as testnet USDG) and the liquidity router.
const usdgDecimals = await pub.readContract({ address: TOKENS.usdg, abi: erc20Abi, functionName: "decimals" });
const erc20 = art("MockERC20").abi;
let usdg = process.env.SWAP_TEST_USDG as Address | undefined;
if (!usdg) record("SWAP_TEST_USDG", (usdg = await deploy("MockERC20", ["Proviso Test USDG", "tUSDG", usdgDecimals])));
let lp = process.env.SWAP_TEST_LP as Address | undefined;
if (!lp) record("SWAP_TEST_LP", (lp = await deploy("PoolModifyLiquidityTest", [UNISWAP_V4.poolManager])));

// 3. Pool TSLA/tUSDG at the feed price, liquidity +-20% around it.
const [c0, c1] = BigInt(TSLA) < BigInt(usdg) ? [TSLA, usdg] : [usdg, TSLA];
const tslaIs0 = c0 === TSLA;
const key: PoolKey = { currency0: c0, currency1: c1, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
const px = Number(answer) / 1e8; // USDG per TSLA
const raw = tslaIs0 ? (px * 10 ** usdgDecimals) / 1e18 : 1e18 / (px * 10 ** usdgDecimals); // currency1 per currency0, raw units
const tickOf = (p: number) => Math.floor(Math.log(p) / Math.log(1.0001) / 60) * 60;
const pm = art("PoolManager").abi;
if ((await readSlot0(pub, UNISWAP_V4.poolManager, key)).sqrtPriceX96 === 0n) {
  const sqrtPriceX96 = BigInt(Math.floor(Math.sqrt(raw) * 2 ** 96));
  await send(dep, UNISWAP_V4.poolManager, pm, "initialize", [key, sqrtPriceX96]);
  console.log("pool initialized");
}
const slot = await readSlot0(pub, UNISWAP_V4.poolManager, key);
const spot = (Number(slot.sqrtPriceX96) / 2 ** 96) ** 2;
const [lo, hi] = [tickOf(raw / 1.2), tickOf(raw * 1.2) + 60];
const tslaHeld = await bal(TSLA, relayer.address);
if (!process.env.SWAP_TEST_LIQUIDITY) {
  // L from 1 TSLA on the TSLA side of the range (the other side is minted).
  const s = Math.sqrt(spot), sa = Math.sqrt(1.0001 ** lo), sb = Math.sqrt(1.0001 ** hi);
  const tslaRaw = 1e18;
  const L = BigInt(Math.floor(tslaIs0 ? (tslaRaw * s * sb) / (sb - s) : tslaRaw / (s - sa)));
  if (tslaHeld < 10n ** 18n) throw new Error(`relayer holds ${formatUnits(tslaHeld, 18)} TSLA, needs 1`);
  await send(dep, usdg, erc20, "mint", [relayer.address, 10n ** BigInt(usdgDecimals + 7)]);
  for (const t of [TSLA, usdg]) await send(dep, t, erc20Abi as Abi, "approve", [lp, 2n ** 255n]);
  await send(dep, lp, art("PoolModifyLiquidityTest").abi, "modifyLiquidity", [key, { tickLower: lo, tickUpper: hi, liquidityDelta: L, salt: `0x${"0".repeat(64)}` }, "0x"]);
  record("SWAP_TEST_LIQUIDITY", L.toString());
  console.log(`liquidity added L=${L} ticks ${lo}..${hi}`);
}

// 4. Test main key: 7702 -> Kernel v3.3, SwapKeyPolicy installed as executor (module type 2).
let mainKey = process.env.SWAP_TEST_MAIN_KEY as Hex | undefined;
if (!mainKey) record("SWAP_TEST_MAIN_KEY", (mainKey = generatePrivateKey()));
const main = privateKeyToAccount(mainKey);
const mainWallet = walletOf(main);
await fund(main.address, "0.0006");
if ((await bal(usdg, main.address)) < 10n ** BigInt(usdgDecimals + 1)) await send(dep, usdg, erc20, "mint", [main.address, 100n * 10n ** BigInt(usdgDecimals)]);
const code = await pub.getCode({ address: main.address });
const delegated = code === `0xef0100${ACCOUNT_ABSTRACTION.kernelV33Implementation.slice(2).toLowerCase()}`;
const installed = delegated && (await pub.readContract({ address: main.address, abi: kernelAbi, functionName: "isModuleInstalled", args: [2n, D.swapKeyPolicy!, "0x"] }));
if (!installed) {
  // Kernel executor initData: hook (20 bytes, 0 = none) ++ abi.encode(executorData, hookData)
  const initData = concat([zeroAddress, encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], ["0x", "0x"])]);
  const authorizationList = delegated ? undefined : [await mainWallet.signAuthorization({ account: main, contractAddress: ACCOUNT_ABSTRACTION.kernelV33Implementation, executor: "self" })];
  const tx = await send(mainWallet, main.address, kernelAbi as Abi, "installModule", [2n, D.swapKeyPolicy!, initData], authorizationList ? { authorizationList } : {});
  console.log(`main ${main.address}: delegated to Kernel v3.3, SwapKeyPolicy installed (tx ${tx})`);
}

// 5. Session key (sealed as core seals them), adapter policy and swap-key policy.
const { timestamp } = await pub.getBlock();
const sealer = new SessionKeyManager(crypto.getRandomValues(new Uint8Array(32)));
const sealed = sealer.create(main.address, { chainId: chain.id, expiresAt: Number(timestamp) + 86_400 });
const session = privateKeyToAccount(sealer.unseal(sealed));
await fund(session.address, "0.0004");
const maxIn = (dec: number) => 1000n * 10n ** BigInt(dec);
const ap = adapterPolicyFor(key, {
  account: main.address,
  oracle: FEED,
  baseIsCurrency0: tslaIs0,
  multiplier: 10n ** 18n,
  maxSlipBps: 300,
  maxIn0: maxIn(tslaIs0 ? 18 : usdgDecimals),
  maxIn1: maxIn(tslaIs0 ? usdgDecimals : 18),
  expiresAt: timestamp + 86_400n,
  nonce: (await pub.readContract({ address: D.swapAdapter!, abi: swapAdapterAbi, functionName: "lastPolicyNonce", args: [main.address] })) + 1n,
});
await send(dep, D.swapAdapter!, swapAdapterAbi as Abi, "setPolicy", [ap, await main.signTypedData(adapterPolicyTypedData(ap, { chainId: chain.id, verifyingContract: D.swapAdapter! }))]);
const policy = buildSwapKeyPolicy({
  account: main.address,
  sessionKey: session.address,
  adapter: D.swapAdapter!,
  caps: [
    { token: usdg, maxPerTx: 10n * 10n ** BigInt(usdgDecimals), maxPerDay: 20n * 10n ** BigInt(usdgDecimals) },
    { token: TSLA, maxPerTx: 10n ** 17n, maxPerDay: 10n ** 17n },
  ],
  pools: [key],
  expiresAt: BigInt(sealed.expiresAt),
  nonce: await nextPolicyNonce(pub, D.swapKeyPolicy!, main.address),
  now: timestamp,
});
await send(dep, D.swapKeyPolicy!, swapKeyPolicyAbi as Abi, "setPolicy", [policy, await main.signTypedData(swapKeyPolicyTypedData(policy, { chainId: chain.id, verifyingContract: D.swapKeyPolicy! }))]);
console.log("adapter + swap-key policies set");

// 6. One $2 buy of TSLA through the session key.
await freshFeed();
const market: RhcMarket = {
  symbols: tslaIs0 ? ["TSLA", "USDG"] : ["USDG", "TSLA"],
  key,
  decimals: tslaIs0 ? [18, usdgDecimals] : [usdgDecimals, 18],
  oracle: FEED,
  baseIsCurrency0: tslaIs0,
  multiplier: 10n ** 18n,
  adapterMaxSlipBps: 300,
};
const [u0, t0] = [await bal(usdg, main.address), await bal(TSLA, main.address)];
const sent = await sendSwap(
  { publicClient: pub, swapKeyPolicy: D.swapKeyPolicy!, poolManager: UNISWAP_V4.poolManager, markets: [market] },
  { action: { venue: "rhc", action: "swap", tokenIn: "USDG", tokenOut: "TSLA", size: { usd: 2 }, maxSlipPct: 2 }, policy, wallet: walletOf(session) },
);
if (!sent.plan.ok) throw new Error(`swap refused: ${sent.plan.reason} ${sent.plan.detail ?? ""}`);
const r = await pub.waitForTransactionReceipt({ hash: sent.hash! });
const [u1, t1] = [await bal(usdg, main.address), await bal(TSLA, main.address)];
const allowance = await pub.readContract({ address: usdg, abi: erc20Abi, functionName: "allowance", args: [main.address, D.swapAdapter!] });
console.log({
  tx: sent.hash,
  status: r.status,
  usdgSpent: formatUnits(u0 - u1, usdgDecimals),
  tslaReceived: formatUnits(t1 - t0, 18),
  minOut: formatUnits(sent.plan.minOut, 18),
  leftoverAllowance: allowance,
});
process.exit(r.status === "success" && t1 > t0 && allowance === 0n ? 0 : 1);
