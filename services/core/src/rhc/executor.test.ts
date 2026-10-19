// End to end on a local anvil with the compiled contracts (contracts/out): Uniswap v4 PoolManager,
// ProvisoSwapAdapter, SwapKeyPolicy, and a 7702-delegated test account. Run `forge build` first.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  parseEther,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  executeWaves,
  nextPolicyNonce,
  planSwap,
  readSlot0,
  swapAdapterAbi,
  swapKeyPolicyAbi,
  type ExecutorDeps,
  type RhcMarket,
  type RhcSwapAction,
  type SwapJob,
} from "./executor";
import {
  adapterPolicyFor,
  adapterPolicyTypedData,
  buildSwapKeyPolicy,
  poolId,
  SessionKeyManager,
  swapKeyPolicyHash,
  swapKeyPolicyTypedData,
  type PoolKey,
  type SwapKeyPolicy,
} from "./policy";

const OUT = join(import.meta.dir, "..", "..", "..", "..", "contracts", "out");
const art = (file: string, name = file) => {
  const j = JSON.parse(readFileSync(join(OUT, `${file}.sol`, `${name}.json`), "utf8"));
  return { abi: j.abi as Abi, bytecode: j.bytecode.object as Hex };
};
const bin = join(homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
const haveAll = existsSync(bin) && existsSync(join(OUT, "SwapKeyPolicy.sol", "SwapKeyPolicy.json"));

const port = 9545 + Math.floor(Math.random() * 1000);
const rpc = `http://127.0.0.1:${port}`;
const chain = {
  id: 31337,
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
} as const;
const deployer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const pub = createPublicClient({ chain, transport: http(rpc), pollingInterval: 50 }) as PublicClient;
const testClient = createTestClient({ chain, mode: "anvil", transport: http(rpc) });
const walletOf = (account: PrivateKeyAccount) => createWalletClient({ chain, transport: http(rpc), account, pollingInterval: 50 });
const dep = walletOf(deployer);

const SQRT_1_1 = 79228162514264337593543950336n;
const SQRT_1_2 = 56022770974786139918731938227n;
const E18 = 10n ** 18n;
// FeeTakingHook needs these permission bits in its address
const HOOK_ADDR = `0x${(64 + 4 + 1024 + 2 + 256 + 1).toString(16).padStart(40, "0")}` as Address;

let proc: ReturnType<typeof Bun.spawn> | undefined;
const A: Record<string, Address> = {};
let t0: Address, t1: Address;
const markets: Record<"main" | "skewed" | "hooked" | "unlisted", RhcMarket> = {} as never;
let deps: ExecutorDeps;
const sealer = new SessionKeyManager(crypto.getRandomValues(new Uint8Array(32)));

type User = { main: PrivateKeyAccount; session: WalletClient; policy: SwapKeyPolicy };
let caller: User;
let followers: User[];

async function deploy(file: string, args: unknown[] = [], name = file): Promise<Address> {
  const { abi, bytecode } = art(file, name);
  const hash = await dep.deployContract({ abi, bytecode, args, chain });
  return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
}
async function send(w: WalletClient, address: Address, abi: Abi, functionName: string, args: unknown[], extra = {}) {
  const hash = await w.writeContract({ address, abi, functionName, args, chain, account: w.account!, ...extra } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
  return r;
}
const erc20 = art("MockERC20").abi;
const feedAbi = art("ProvisoSwapAdapter.t", "MockFeed").abi;
const accountAbi = art("MiniAccount7579").abi;
const balance = (token: Address, who: Address) =>
  pub.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [who] }) as Promise<bigint>;

async function refreshFeed(answer = 100_000_000n) {
  const { timestamp } = await pub.getBlock();
  await send(dep, A.feed!, feedAbi, "set", [answer, timestamp]);
}

async function addPool(key: PoolKey, sqrtPrice: bigint, lower: number, upper: number) {
  await send(dep, A.pm!, art("PoolManager").abi, "initialize", [key, sqrtPrice]);
  await send(dep, A.lp!, art("PoolModifyLiquidityTest").abi, "modifyLiquidity", [
    key,
    { tickLower: lower, tickUpper: upper, liquidityDelta: 10n ** 21n, salt: `0x${"0".repeat(64)}` },
    "0x",
  ]);
}

const market = (key: PoolKey): RhcMarket => ({
  symbols: ["T0", "T1"],
  key,
  decimals: [18, 18],
  oracle: A.feed!,
  baseIsCurrency0: true,
  multiplier: E18,
  adapterMaxSlipBps: 100,
});

/** One user: 7702-delegate the main key, install the module, sign both policies, relay them. */
async function onboard(pools: PoolKey[], caps = { maxPerTx: E18, maxPerDay: 2n * E18 }, tokens = [t0, t1]): Promise<User> {
  const main = privateKeyToAccount(generatePrivateKey());
  const mainWallet = walletOf(main);
  await dep.sendTransaction({ to: main.address, value: parseEther("1"), chain, account: deployer });
  for (const t of [t0, t1]) await send(dep, t, erc20, "mint", [main.address, 100n * E18]);

  const auth = await mainWallet.signAuthorization({ account: main, contractAddress: A.impl!, executor: "self" });
  await send(mainWallet, main.address, accountAbi, "installModule", [2n, A.policy!, "0x"], { authorizationList: [auth] });

  const { timestamp } = await pub.getBlock();
  const sealed = sealer.create(main.address, { chainId: chain.id, expiresAt: Number(timestamp) + 7 * 86_400 });
  const sessionAccount = privateKeyToAccount(sealer.unseal(sealed));
  await dep.sendTransaction({ to: sessionAccount.address, value: parseEther("1"), chain, account: deployer });

  for (const key of pools) {
    const nonce = ((await pub.readContract({ address: A.adapter!, abi: swapAdapterAbi, functionName: "lastPolicyNonce", args: [main.address] })) as bigint) + 1n;
    const ap = adapterPolicyFor(key, {
      account: main.address,
      oracle: A.feed!,
      baseIsCurrency0: true,
      multiplier: E18,
      maxSlipBps: 100,
      maxIn0: 10n * E18,
      maxIn1: 10n * E18,
      expiresAt: timestamp + 30n * 86_400n,
      nonce,
    });
    const sig = await main.signTypedData(adapterPolicyTypedData(ap, { chainId: chain.id, verifyingContract: A.adapter! }));
    await send(dep, A.adapter!, swapAdapterAbi, "setPolicy", [ap, sig]);
  }

  const policy = buildSwapKeyPolicy({
    account: main.address,
    sessionKey: sessionAccount.address,
    adapter: A.adapter!,
    caps: tokens.map((token) => ({ token, ...caps })),
    pools,
    expiresAt: BigInt(sealed.expiresAt),
    nonce: await nextPolicyNonce(pub, A.policy!, main.address),
    now: timestamp,
  });
  await applyPolicy(main, policy);
  return { main, session: walletOf(sessionAccount), policy };
}

async function applyPolicy(main: PrivateKeyAccount, policy: SwapKeyPolicy) {
  const sig = await main.signTypedData(swapKeyPolicyTypedData(policy, { chainId: chain.id, verifyingContract: A.policy! }));
  await send(dep, A.policy!, swapKeyPolicyAbi, "setPolicy", [policy, sig]);
}

const swap = (usd: number, tokenIn = "T0", tokenOut = "T1"): RhcSwapAction => ({
  venue: "rhc",
  action: "swap",
  tokenIn,
  tokenOut,
  size: { usd },
  maxSlipPct: 1,
});
const job = (u: User, action = swap(0.5), policy = u.policy): SwapJob => ({ action, policy, wallet: u.session });
const depsWith = (...ms: RhcMarket[]): ExecutorDeps => ({ ...deps, markets: ms });

beforeAll(async () => {
  if (!haveAll) return;
  proc = Bun.spawn([bin, "--port", String(port), "--silent", "--hardfork", "prague"], { stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 100; i++) {
    try {
      await pub.getChainId();
      break;
    } catch {
      await Bun.sleep(100);
    }
  }

  A.pm = await deploy("PoolManager", [deployer.address]);
  A.lp = await deploy("PoolModifyLiquidityTest", [A.pm]);
  const ta = await deploy("MockERC20", ["Token A", "TA", 18]);
  const tb = await deploy("MockERC20", ["Token B", "TB", 18]);
  [t0, t1] = BigInt(ta) < BigInt(tb) ? [ta, tb] : [tb, ta];
  for (const t of [t0, t1]) {
    await send(dep, t, erc20, "mint", [deployer.address, 10n ** 30n]);
    await send(dep, t, erc20, "approve", [A.lp, 2n ** 255n]);
  }
  A.feed = await deploy("ProvisoSwapAdapter.t", [], "MockFeed");
  A.adapter = await deploy("ProvisoSwapAdapter", [A.pm]);
  A.policy = await deploy("SwapKeyPolicy", [A.adapter]);
  A.impl = await deploy("MiniAccount7579");

  // malicious hook (skims swap output) at an address carrying its permission bits
  const hookImpl = await deploy("FeeTakingHook", [A.pm]);
  await testClient.setCode({ address: HOOK_ADDR, bytecode: (await pub.getCode({ address: hookImpl }))! });

  const k = (fee: number, tickSpacing: number, hooks: Address = zeroAddress): PoolKey => ({ currency0: t0, currency1: t1, fee, tickSpacing, hooks });
  markets.main = market(k(3000, 60));
  markets.skewed = market(k(3000, 10));
  markets.hooked = market(k(3000, 60, HOOK_ADDR));
  markets.unlisted = market(k(500, 60));
  await addPool(markets.main.key, SQRT_1_1, -600, 600);
  await addPool(markets.skewed.key, SQRT_1_2, -12000, 12000);
  await addPool(markets.hooked.key, SQRT_1_1, -600, 600);
  await addPool(markets.unlisted.key, SQRT_1_1, -600, 600);

  deps = { publicClient: pub, swapKeyPolicy: A.policy, poolManager: A.pm, markets: [markets.main] };
  const listed = [markets.main.key, markets.skewed.key, markets.hooked.key];
  caller = await onboard(listed);
  followers = [await onboard(listed), await onboard(listed), await onboard(listed)];
}, 120_000);

afterAll(() => proc?.kill());

let snap: Hex | undefined;
beforeEach(async () => {
  if (!haveAll) return;
  if (snap) await testClient.revert({ id: snap });
  snap = await testClient.snapshot();
  await refreshFeed();
});

describe.skipIf(!haveAll)("rhc executor on anvil", () => {
  test("encodings match the contracts: policy hash, pool id, slot0", async () => {
    const onchain = await pub.readContract({ address: A.policy!, abi: swapKeyPolicyAbi, functionName: "hashPolicy", args: [caller.policy] });
    expect(onchain).toBe(swapKeyPolicyHash(caller.policy));
    expect(await pub.readContract({ address: A.policy!, abi: swapKeyPolicyAbi, functionName: "activePolicy", args: [caller.main.address] })).toBe(onchain);
    expect(caller.policy.poolIds[0]).toBe(poolId(markets.main.key));
    const s = await readSlot0(pub, A.pm!, markets.main.key);
    expect(s.sqrtPriceX96).toBe(SQRT_1_1);
    expect(s.lpFee).toBe(3000);
    // the main key is a 7702-delegated EOA
    expect(await pub.getCode({ address: caller.main.address })).toBe(`0xef0100${A.impl!.slice(2).toLowerCase()}` as Hex);
  });

  test("happy path: plan, simulate, send; output lands in the account, approval consumed", async () => {
    const acct = caller.main.address;
    const [b0, b1] = [await balance(t0, acct), await balance(t1, acct)];
    const plan = await planSwap(deps, job(caller));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.amountIn).toBe(E18 / 2n);
    expect(plan.minOut).toBe((E18 / 2n) * 99n / 100n);
    expect(plan.expectedOut).toBeGreaterThan(plan.minOut);

    const { caller: r } = await executeWaves(deps, { followers: [], caller: job(caller) });
    expect(r?.status).toBe("included");
    expect(b0 - (await balance(t0, acct))).toBe(E18 / 2n);
    expect((await balance(t1, acct)) - b1).toBeGreaterThanOrEqual(plan.minOut);
    expect(await pub.readContract({ address: t0, abi: erc20, functionName: "allowance", args: [acct, A.adapter] })).toBe(0n);
    expect(await balance(t1, caller.session.account!.address)).toBe(0n);
  });

  test("other direction (T1 -> T0)", async () => {
    const r = await executeWaves(deps, { followers: [], caller: job(caller, swap(0.5, "T1", "T0")) });
    expect(r.caller?.status).toBe("included");
  });

  test("followers are included before the caller's swap is sent; a refused follower doesn't block", async () => {
    const refused = job(followers[2]!, swap(5)); // over the per-tx cap
    const { followers: fs, caller: c } = await executeWaves(deps, {
      followers: [job(followers[0]!), refused, job(followers[1]!)],
      caller: job(caller),
    });
    expect(fs.map((f) => f.status)).toEqual(["included", "refused", "included"]);
    expect(c?.status).toBe("included");
    const last = fs.reduce((m, f) => (f.status === "included" && f.blockNumber > m ? f.blockNumber : m), 0n);
    expect(c?.status === "included" && c.blockNumber > last).toBe(true);
  });

  test("refuses two follower jobs on one session key in a wave (nonce race)", async () => {
    await expect(executeWaves(deps, { followers: [job(followers[0]!), job(followers[0]!)] })).rejects.toThrow(/one follower job/);
  });

  // --- refusals (each checked off-chain first; the contract enforces the same) ---

  const refusal = async (j: SwapJob, d = deps) => {
    const p = await planSwap(d, j);
    return p.ok ? "ok" : p.reason;
  };

  test("refuses non-swap and unknown markets", async () => {
    const hl = { venue: "hl", action: "open" } as unknown as RhcSwapAction;
    expect(await refusal(job(caller, hl))).toBe("unsupported_action");
    expect(await refusal(job(caller, swap(0.5, "T0", "TSLA")))).toBe("unknown_market");
  });

  test("refuses a session key that isn't the policy's", async () => {
    expect(await refusal({ ...job(caller), wallet: followers[0]!.session })).toBe("wrong_session_key");
  });

  test("refuses a forged policy (raised caps) and after revocation", async () => {
    const forged = { ...caller.policy, maxPerTx: [10n ** 30n, 10n ** 30n] };
    expect(await refusal(job(caller, swap(0.5), forged))).toBe("policy_not_active");
    // and on-chain, if the executor were bypassed
    await expect(
      pub.simulateContract({ account: caller.session.account!, address: A.policy!, abi: swapKeyPolicyAbi, functionName: "executeSwap", args: [forged, markets.main.key, true, E18, 0n] }),
    ).rejects.toThrow(/PolicyNotActive/);

    await send(walletOf(caller.main), A.policy!, swapKeyPolicyAbi, "revoke", []);
    expect(await refusal(job(caller))).toBe("policy_not_active");
  });

  test("refuses after expiry", async () => {
    await testClient.increaseTime({ seconds: 8 * 86_400 });
    await testClient.mine({ blocks: 1 });
    await refreshFeed();
    expect(await refusal(job(caller))).toBe("policy_expired");
  });

  test("refuses a pool outside the signed allow-list", async () => {
    expect(await refusal(job(caller), depsWith(markets.unlisted))).toBe("pool_not_allowed");
  });

  test("refuses a token outside the signed allow-list", async () => {
    const u = caller;
    const onlyT0 = buildSwapKeyPolicy({
      account: u.main.address,
      sessionKey: u.session.account!.address,
      adapter: A.adapter!,
      caps: [{ token: t0, maxPerTx: E18, maxPerDay: 2n * E18 }],
      pools: [markets.main.key],
      expiresAt: u.policy.expiresAt,
      nonce: await nextPolicyNonce(pub, A.policy!, u.main.address),
      now: (await pub.getBlock()).timestamp,
    });
    await applyPolicy(u.main, onlyT0);
    expect(await refusal(job(u, swap(0.5), onlyT0))).toBe("ok");
    expect(await refusal(job(u, swap(0.5, "T1", "T0"), onlyT0))).toBe("token_not_allowed");
  });

  test("refuses over the per-tx cap and over the per-day cap", async () => {
    expect(await refusal(job(caller, swap(1.01)))).toBe("over_tx_cap");
    const r = await executeWaves(deps, { followers: [job(caller, swap(0.9))], caller: job(caller, swap(0.9)) });
    expect([r.followers[0]?.status, r.caller?.status]).toEqual(["included", "included"]);
    expect(await refusal(job(caller, swap(0.5)))).toBe("over_day_cap"); // 1.8 + 0.5 > 2
    expect(await refusal(job(caller, swap(0.5, "T1", "T0")))).toBe("ok"); // other token's budget
  });

  test("refuses a stale oracle", async () => {
    await testClient.increaseTime({ seconds: 61 });
    await testClient.mine({ blocks: 1 });
    expect(await refusal(job(caller))).toBe("stale_oracle");
  });

  test("refuses a skewed pool (spot outside the oracle band)", async () => {
    expect(await refusal(job(caller), depsWith(markets.skewed))).toBe("pool_outside_band");
  });

  test("malicious-hook pool: spot looks fine, simulation catches the skim", async () => {
    const p = await planSwap(depsWith(markets.hooked), job(caller));
    expect(p.ok).toBe(false);
    if (!p.ok) {
      expect(p.reason).toBe("simulation_reverted");
      expect(p.detail).toBe("InsufficientOutput");
    }
  });

  test("the session key can't move funds through the account directly", async () => {
    const acct = caller.main.address;
    const callData = encodeFunctionData({ abi: erc20, functionName: "transfer", args: [caller.session.account!.address, 1n] });
    const batch = encodeAbiParameters(
      [{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "callData", type: "bytes" }] }],
      [[{ target: t0, value: 0n, callData }]],
    );
    const BATCH = `0x01${"0".repeat(62)}` as Hex;
    for (const functionName of ["execute", "executeFromExecutor"])
      await expect(
        pub.simulateContract({ account: caller.session.account!, address: acct, abi: accountAbi, functionName, args: [BATCH, batch] } as never),
      ).rejects.toThrow(/NotSelf|NotExecutor/);
    await expect(
      pub.simulateContract({ account: caller.session.account!, address: t0, abi: erc20, functionName: "transferFrom", args: [acct, caller.session.account!.address, 1n] }),
    ).rejects.toThrow();
  });
});
