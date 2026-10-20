import type { Action } from "@proviso/dsl";
import {
  BaseError,
  ContractFunctionRevertedError,
  encodeAbiParameters,
  keccak256,
  parseAbi,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
} from "viem";
import { poolId, swapKeyPolicyHash, type PoolKey, type SwapKeyPolicy } from "./policy";

// Robinhood Chain spot executor (Backend §3, §6 R4). For an `rhc.swap` action: size the input from
// the oracle, quote minOut from the Chainlink band (never below the adapter's own floor), check the
// pool's spot price sits inside that band, pre-check the swap-key policy, simulate
// SwapKeyPolicy.executeSwap as the session key, then send. Followers go first; the caller's swap is
// sent only after every follower tx is included.

export const swapKeyPolicyAbi = parseAbi([
  "struct Policy { address account; address sessionKey; address adapter; address[] tokens; uint256[] maxPerTx; uint256[] maxPerDay; bytes32[] poolIds; uint64 expiresAt; uint64 nonce; }",
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "function setPolicy(Policy p, bytes mainKeySig)",
  "function revoke()",
  "function executeSwap(Policy p, PoolKey key, bool zeroForOne, uint256 amountIn, uint256 minOut) returns (uint256 amountOut)",
  "function activePolicy(address account) view returns (bytes32)",
  "function lastNonce(address account) view returns (uint64)",
  "function remainingToday(Policy p, address token) view returns (uint256)",
  "function hashPolicy(Policy p) pure returns (bytes32)",
  "function adapter() view returns (address)",
  "error BadPolicy()",
  "error BadSignature()",
  "error StaleNonce()",
  "error NotSessionKey()",
  "error PolicyNotActive()",
  "error PolicyExpired()",
  "error PoolNotAllowed()",
  "error TokenNotAllowed()",
  "error OverTxCap()",
  "error OverDayCap()",
  "error AllowanceLeft()",
  // bubbled from the adapter through the account
  "error NotAllowListed()",
  "error AmountOutOfRange()",
  "error StaleOracle()",
  "error MinOutBelowBand()",
  "error InsufficientOutput()",
  "error Overcharged()",
  "error NativeInputUnsupported()",
]);

export const swapAdapterAbi = parseAbi([
  "struct Policy { address account; address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; address oracle; bool baseIsCurrency0; uint256 multiplier; uint16 maxSlipBps; uint256 maxIn0; uint256 maxIn1; uint64 expiresAt; uint64 nonce; }",
  "function setPolicy(Policy p, bytes mainKeySig)",
  "function lastPolicyNonce(address account) view returns (uint64)",
]);

const feedAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);
const extsloadAbi = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]);

export const MAX_ORACLE_AGE_S = 60n; // ProvisoSwapAdapter.MAX_ORACLE_AGE
const BPS = 10_000n;
const Q192 = 2n ** 192n;

/** One allow-listed pool with the oracle terms the main key signed into the adapter policy. */
export type RhcMarket = {
  /** DSL coin names for currency0 / currency1, e.g. ["TSLA", "USDG"]. */
  symbols: readonly [string, string];
  key: PoolKey;
  decimals: readonly [number, number];
  oracle: Address;
  /** Feed prices currency1 per currency0 when true (the quote side is treated as USD). */
  baseIsCurrency0: boolean;
  /** 1e18 = 1; 1e18 for multiplier-embedded Stock Token feeds. */
  multiplier: bigint;
  /** The adapter policy's maxSlipBps; minOut is never below this floor. */
  adapterMaxSlipBps: number;
};

export type RhcSwapAction = Extract<Action, { venue: "rhc" }>;

export type ExecutorDeps = {
  publicClient: PublicClient;
  swapKeyPolicy: Address;
  poolManager: Address;
  markets: readonly RhcMarket[];
};

export type SwapJob = {
  action: RhcSwapAction;
  policy: SwapKeyPolicy;
  /** The session key's wallet (its account must be policy.sessionKey). */
  wallet: WalletClient;
  /** Exact tokenIn amount (base units) instead of sizing from action.size.usd: exits sell what was bought. */
  amountIn?: bigint;
};

export type RefusalCode =
  | "unsupported_action"
  | "unknown_market"
  | "wrong_session_key"
  | "policy_not_active"
  | "policy_expired"
  | "pool_not_allowed"
  | "token_not_allowed"
  | "over_tx_cap"
  | "over_day_cap"
  | "stale_oracle"
  | "pool_outside_band"
  | "simulation_reverted";

export type SwapPlan =
  | {
      ok: true;
      key: PoolKey;
      zeroForOne: boolean;
      tokenIn: Address;
      amountIn: bigint;
      minOut: bigint;
      /** Output the simulation returned. */
      expectedOut: bigint;
    }
  | { ok: false; reason: RefusalCode; detail?: string };

export type SwapResult =
  | { status: "refused"; reason: RefusalCode; detail?: string }
  | { status: "included"; hash: Hash; amountIn: bigint; minOut: bigint; blockNumber: bigint }
  | { status: "failed"; hash?: Hash; detail: string };

const refuse = (reason: RefusalCode, detail?: string): SwapPlan => ({ ok: false, reason, detail });
const sameAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function resolveMarket(markets: readonly RhcMarket[], tokenIn: string, tokenOut: string) {
  for (const market of markets) {
    const [s0, s1] = market.symbols;
    if (s0 === tokenIn && s1 === tokenOut) return { market, zeroForOne: true };
    if (s1 === tokenIn && s0 === tokenOut) return { market, zeroForOne: false };
  }
  return undefined;
}

export type OracleQuote = { answer: bigint; feedDecimals: number; updatedAt: bigint };

/** Fair output at the oracle price, floor-rounded exactly like ProvisoSwapAdapter._oracleFloor. */
export function oracleFairOut(m: RhcMarket, zeroForOne: boolean, amountIn: bigint, q: OracleQuote): bigint {
  const [decB, decQ] = m.baseIsCurrency0 ? [m.decimals[0], m.decimals[1]] : [m.decimals[1], m.decimals[0]];
  const num = q.answer * m.multiplier * 10n ** BigInt(decQ);
  const den = 10n ** BigInt(q.feedDecimals + 18 + decB);
  const sellingBase = zeroForOne === m.baseIsCurrency0;
  return sellingBase ? (amountIn * num) / den : (amountIn * den) / num;
}

/** Input amount worth `usd`, treating the feed's quote currency as USD (USDG). */
export function amountInForUsd(m: RhcMarket, zeroForOne: boolean, usd: number, q: OracleQuote): bigint {
  const usdE6 = BigInt(Math.round(usd * 1e6));
  const sellingBase = zeroForOne === m.baseIsCurrency0;
  const decIn = BigInt(zeroForOne ? m.decimals[0] : m.decimals[1]);
  if (!sellingBase) return (usdE6 * 10n ** decIn) / 1_000_000n;
  return (usdE6 * 10n ** decIn * 10n ** BigInt(q.feedDecimals) * 10n ** 18n) / (1_000_000n * q.answer * m.multiplier);
}

/** minOut = the stricter of the action's slippage and the adapter policy's band. */
export function quoteMinOut(m: RhcMarket, zeroForOne: boolean, amountIn: bigint, maxSlipPct: number, q: OracleQuote) {
  const fair = oracleFairOut(m, zeroForOne, amountIn, q);
  const slipBps = BigInt(Math.round(maxSlipPct * 100));
  if (slipBps <= 0n || slipBps >= BPS) throw new Error("maxSlipPct out of range");
  const actionFloor = (fair * (BPS - slipBps)) / BPS;
  const adapterFloor = (fair * (BPS - BigInt(m.adapterMaxSlipBps))) / BPS;
  return actionFloor > adapterFloor ? actionFloor : adapterFloor;
}

/** Output at the pool's spot price after the LP fee (no price impact). */
export function spotOut(sqrtPriceX96: bigint, lpFee: number, zeroForOne: boolean, amountIn: bigint): bigint {
  const afterFee = (amountIn * (1_000_000n - BigInt(lpFee))) / 1_000_000n;
  const p2 = sqrtPriceX96 * sqrtPriceX96;
  return zeroForOne ? (afterFee * p2) / Q192 : (afterFee * Q192) / p2;
}

/** slot0 through PoolManager.extsload (what StateView.getSlot0 reads). */
export async function readSlot0(client: PublicClient, poolManager: Address, key: PoolKey) {
  const slot = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId(key), 6n]));
  const word = BigInt(await client.readContract({ address: poolManager, abi: extsloadAbi, functionName: "extsload", args: [slot] }));
  const sqrtPriceX96 = word & ((1n << 160n) - 1n);
  const lpFee = Number((word >> 208n) & 0xffffffn);
  return { sqrtPriceX96, lpFee };
}

async function readOracle(client: PublicClient, oracle: Address): Promise<OracleQuote> {
  const [feedDecimals, round] = await Promise.all([
    client.readContract({ address: oracle, abi: feedAbi, functionName: "decimals" }),
    client.readContract({ address: oracle, abi: feedAbi, functionName: "latestRoundData" }),
  ]);
  return { answer: round[1], feedDecimals, updatedAt: round[3] };
}

function revertName(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.signature ?? r.shortMessage;
    return e.shortMessage;
  }
  return String(e);
}

/** Size, quote, pre-check and simulate one swap. Sends nothing. */
export async function planSwap(deps: ExecutorDeps, job: SwapJob): Promise<SwapPlan> {
  const { action, policy: p, wallet } = job;
  const c = deps.publicClient;
  if ((action as { venue: string }).venue !== "rhc" || action.action !== "swap") return refuse("unsupported_action");
  const resolved = resolveMarket(deps.markets, action.tokenIn, action.tokenOut);
  if (!resolved) return refuse("unknown_market", `${action.tokenIn}->${action.tokenOut}`);
  const { market: m, zeroForOne } = resolved;
  const sessionAddr = wallet.account?.address;
  if (!sessionAddr || !sameAddr(sessionAddr, p.sessionKey)) return refuse("wrong_session_key");

  const [block, active, oracle, slot0] = await Promise.all([
    c.getBlock(),
    c.readContract({ address: deps.swapKeyPolicy, abi: swapKeyPolicyAbi, functionName: "activePolicy", args: [p.account] }),
    readOracle(c, m.oracle),
    readSlot0(c, deps.poolManager, m.key),
  ]);
  if (active !== swapKeyPolicyHash(p)) return refuse("policy_not_active");
  if (block.timestamp >= p.expiresAt) return refuse("policy_expired");
  if (!p.poolIds.includes(poolId(m.key))) return refuse("pool_not_allowed");
  const tokenIn = zeroForOne ? m.key.currency0 : m.key.currency1;
  const i = p.tokens.findIndex((t) => sameAddr(t, tokenIn));
  if (i < 0) return refuse("token_not_allowed", tokenIn);
  if (oracle.answer <= 0n || block.timestamp > oracle.updatedAt + MAX_ORACLE_AGE_S) return refuse("stale_oracle");

  const amountIn = job.amountIn ?? amountInForUsd(m, zeroForOne, action.size.usd, oracle);
  if (amountIn <= 0n || amountIn > p.maxPerTx[i]!) return refuse("over_tx_cap", `${amountIn} > ${p.maxPerTx[i]}`);
  const remaining = await c.readContract({
    address: deps.swapKeyPolicy,
    abi: swapKeyPolicyAbi,
    functionName: "remainingToday",
    args: [p, tokenIn],
  });
  if (amountIn > remaining) return refuse("over_day_cap", `${amountIn} > ${remaining}`);

  const minOut = quoteMinOut(m, zeroForOne, amountIn, action.maxSlipPct, oracle);
  if (spotOut(slot0.sqrtPriceX96, slot0.lpFee, zeroForOne, amountIn) < minOut) return refuse("pool_outside_band");

  try {
    const sim = await c.simulateContract({
      account: wallet.account!,
      address: deps.swapKeyPolicy,
      abi: swapKeyPolicyAbi,
      functionName: "executeSwap",
      args: [p, m.key, zeroForOne, amountIn, minOut],
    });
    return { ok: true, key: m.key, zeroForOne, tokenIn, amountIn, minOut, expectedOut: sim.result };
  } catch (e) {
    return refuse("simulation_reverted", revertName(e));
  }
}

/** Plan and broadcast one swap; returns the hash without waiting. */
export async function sendSwap(deps: ExecutorDeps, job: SwapJob) {
  const plan = await planSwap(deps, job);
  if (!plan.ok) return { plan };
  const hash = await job.wallet.writeContract({
    account: job.wallet.account!,
    chain: job.wallet.chain ?? null,
    address: deps.swapKeyPolicy,
    abi: swapKeyPolicyAbi,
    functionName: "executeSwap",
    args: [job.policy, plan.key, plan.zeroForOne, plan.amountIn, plan.minOut],
  });
  return { plan, hash };
}

async function settle(deps: ExecutorDeps, sent: Awaited<ReturnType<typeof sendSwap>>): Promise<SwapResult> {
  const { plan, hash } = sent;
  if (!plan.ok) return { status: "refused", reason: plan.reason, detail: plan.detail };
  try {
    const r = await deps.publicClient.waitForTransactionReceipt({ hash: hash! });
    if (r.status !== "success") return { status: "failed", hash, detail: "reverted on-chain" };
    return { status: "included", hash: hash!, amountIn: plan.amountIn, minOut: plan.minOut, blockNumber: r.blockNumber };
  } catch (e) {
    return { status: "failed", hash, detail: revertName(e) };
  }
}

const sendSafe = (deps: ExecutorDeps, job: SwapJob) =>
  sendSwap(deps, job).catch((e): Awaited<ReturnType<typeof sendSwap>> => ({
    plan: { ok: false, reason: "simulation_reverted", detail: revertName(e) },
  }));

/**
 * Fair Copy R4 ordering: every follower swap is sent and included (or refused / failed) before the
 * caller's swap is even planned. A failed follower doesn't block the caller.
 * ponytail: inclusion only, no sequencer-feed check (Backend §6 U: Timeboost / express lane).
 */
export async function executeWaves(deps: ExecutorDeps, w: { followers: readonly SwapJob[]; caller?: SwapJob }) {
  // followers are sent concurrently, so two jobs on one session key would race for its nonce
  const keys = w.followers.map((j) => j.wallet.account?.address.toLowerCase());
  if (new Set(keys).size !== keys.length) throw new Error("one follower job per session key per wave");
  const sent = await Promise.all(w.followers.map((j) => sendSafe(deps, j)));
  const followers = await Promise.all(sent.map((s) => settle(deps, s)));
  const caller = w.caller ? await settle(deps, await sendSafe(deps, w.caller)) : undefined;
  return { followers, caller };
}

/** Next nonce for a new SwapKeyPolicy signature. */
export async function nextPolicyNonce(client: PublicClient, swapKeyPolicy: Address, account: Address) {
  return (await client.readContract({ address: swapKeyPolicy, abi: swapKeyPolicyAbi, functionName: "lastNonce", args: [account] })) + 1n;
}

