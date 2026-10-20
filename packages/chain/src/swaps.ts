import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hashStruct,
  keccak256,
  parseAbi,
  parseAbiParameters,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { entryPoint07Address, getUserOperationHash, type UserOperation } from "viem/account-abstraction";
import { TESTNET_TEST_FEEDS } from "./chains.ts";

// Robinhood Chain swap-key policy (Backend §3). The browser's main key signs two EIP-712 messages:
// the SwapKeyPolicy (what the session key may do: tokens, caps, pools, expiry) and one adapter
// Policy per pool (oracle band and adapter-side caps). The session key lives sealed in the enclave.

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };

/** Mirrors SwapKeyPolicy.Policy. Caps are in tokenIn base units, aligned with `tokens`. */
export type SwapKeyPolicy = {
  account: Address;
  sessionKey: Address;
  adapter: Address;
  tokens: readonly Address[];
  maxPerTx: readonly bigint[];
  maxPerDay: readonly bigint[];
  poolIds: readonly Hex[];
  expiresAt: bigint; // unix seconds
  nonce: bigint;
};

/** Mirrors ProvisoSwapAdapter.Policy. */
export type AdapterPolicy = {
  account: Address;
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  oracle: Address;
  baseIsCurrency0: boolean;
  multiplier: bigint; // 1e18 = 1; 1e18 for multiplier-embedded feeds
  maxSlipBps: number;
  maxIn0: bigint;
  maxIn1: bigint;
  expiresAt: bigint;
  nonce: bigint;
};

export const SWAP_KEY_POLICY_TYPES = {
  Policy: [
    { name: "account", type: "address" },
    { name: "sessionKey", type: "address" },
    { name: "adapter", type: "address" },
    { name: "tokens", type: "address[]" },
    { name: "maxPerTx", type: "uint256[]" },
    { name: "maxPerDay", type: "uint256[]" },
    { name: "poolIds", type: "bytes32[]" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

export const ADAPTER_POLICY_TYPES = {
  Policy: [
    { name: "account", type: "address" },
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
    { name: "oracle", type: "address" },
    { name: "baseIsCurrency0", type: "bool" },
    { name: "multiplier", type: "uint256" },
    { name: "maxSlipBps", type: "uint16" },
    { name: "maxIn0", type: "uint256" },
    { name: "maxIn1", type: "uint256" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

/** Uniswap v4 PoolId = keccak256(abi.encode(PoolKey)). */
export const poolId = (k: PoolKey): Hex =>
  keccak256(
    encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [
      k.currency0,
      k.currency1,
      k.fee,
      k.tickSpacing,
      k.hooks,
    ]),
  );

export type TokenCap = { token: Address; maxPerTx: bigint; maxPerDay: bigint };

/** Build a policy the contract will accept (same checks as SwapKeyPolicy.setPolicy, minus the nonce). */
export function buildSwapKeyPolicy(o: {
  account: Address;
  sessionKey: Address;
  adapter: Address;
  caps: readonly TokenCap[];
  pools: readonly PoolKey[];
  expiresAt: bigint;
  nonce: bigint;
  now?: bigint;
}): SwapKeyPolicy {
  const now = o.now ?? BigInt(Math.floor(Date.now() / 1000));
  const account = getAddress(o.account);
  const sessionKey = getAddress(o.sessionKey);
  if (sessionKey === zeroAddress || sessionKey === account) throw new Error("session key must differ from account");
  if (o.caps.length === 0 || o.pools.length === 0) throw new Error("policy needs at least one token and one pool");
  const tokens = o.caps.map((c) => getAddress(c.token));
  if (tokens.some((t) => t === zeroAddress)) throw new Error("native input is unsupported");
  if (new Set(tokens).size !== tokens.length) throw new Error("duplicate token");
  if (o.caps.some((c) => c.maxPerTx <= 0n || c.maxPerDay < c.maxPerTx)) throw new Error("caps need 0 < maxPerTx <= maxPerDay");
  if (o.expiresAt <= now) throw new Error("expiry must be in the future");
  if (o.nonce <= 0n || o.nonce >= 2n ** 64n) throw new Error("nonce must fit uint64 and be > 0");
  return {
    account,
    sessionKey,
    adapter: getAddress(o.adapter),
    tokens,
    maxPerTx: o.caps.map((c) => c.maxPerTx),
    maxPerDay: o.caps.map((c) => c.maxPerDay),
    poolIds: o.pools.map(poolId),
    expiresAt: o.expiresAt,
    nonce: o.nonce,
  };
}

/** What the browser's main key signs (viem signTypedData / eth_signTypedData_v4). */
export const swapKeyPolicyTypedData = (p: SwapKeyPolicy, o: { chainId: number; verifyingContract: Address }) =>
  ({
    domain: { name: "Proviso Swap Key Policy", version: "1", chainId: o.chainId, verifyingContract: o.verifyingContract },
    types: SWAP_KEY_POLICY_TYPES,
    primaryType: "Policy",
    message: p,
  }) as const;

export const adapterPolicyTypedData = (p: AdapterPolicy, o: { chainId: number; verifyingContract: Address }) =>
  ({
    domain: { name: "Proviso Swap Adapter", version: "1", chainId: o.chainId, verifyingContract: o.verifyingContract },
    types: ADAPTER_POLICY_TYPES,
    primaryType: "Policy",
    message: p,
  }) as const;

/** EIP-712 struct hash; equals SwapKeyPolicy.activePolicy(account) once applied. */
export const swapKeyPolicyHash = (p: SwapKeyPolicy): Hex =>
  hashStruct({ data: p, primaryType: "Policy", types: SWAP_KEY_POLICY_TYPES });

/** Adapter policy for one pool, mirroring that pool's key. */
export const adapterPolicyFor = (
  key: PoolKey,
  o: Omit<AdapterPolicy, "currency0" | "currency1" | "fee" | "tickSpacing" | "hooks">,
): AdapterPolicy => ({ ...o, currency0: key.currency0, currency1: key.currency1, fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks });

// --- one-time account setup (EIP-7702 -> ZeroDev Kernel v3.3, SwapKeyPolicy as executor) ---
// Embedded (Privy) wallets only: MetaMask won't 7702-delegate to arbitrary contracts. The user signs
// the 7702 authorization plus one UserOp (installModule); the relayer submits both in a single
// type-4 handleOps tx with gas price 0 in the UserOp, so the user needs no ETH.

export const KERNEL_V33_IMPLEMENTATION = "0xd6CEDDe84be40893d153Be9d467CD6aD37875b28" as Address;
export const ENTRY_POINT_V07 = entryPoint07Address;
export const MODULE_TYPE_EXECUTOR = 2n;
export const kernelAbi = parseAbi([
  "function installModule(uint256 moduleType, address module, bytes initData) payable",
  "function uninstallModule(uint256 moduleType, address module, bytes deInitData) payable",
  "function isModuleInstalled(uint256 moduleType, address module, bytes additionalContext) view returns (bool)",
]);
export const entryPointNonceAbi = parseAbi(["function getNonce(address sender, uint192 key) view returns (uint256)"]);

/** Kernel executor initData: hook (20 bytes, 0 = none) ++ abi.encode(executorData, hookData). */
export const EXECUTOR_INIT_DATA = concat([zeroAddress, encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], ["0x", "0x"])]);

/** Code of an EOA delegated to Kernel v3.3 (EIP-7702 designator). */
export const kernelDelegationCode = `0xef0100${KERNEL_V33_IMPLEMENTATION.slice(2).toLowerCase()}` as Hex;

/** The UserOp that installs SwapKeyPolicy; nonce key 0 = Kernel's 7702 root (ECDSA by the EOA). */
export function installPolicyUserOp(o: { account: Address; swapKeyPolicy: Address; nonce: bigint }): UserOperation<"0.7"> {
  return {
    sender: o.account,
    nonce: o.nonce,
    callData: encodeFunctionData({ abi: kernelAbi, functionName: "installModule", args: [MODULE_TYPE_EXECUTOR, o.swapKeyPolicy, EXECUTOR_INIT_DATA] }),
    callGasLimit: 300_000n,
    verificationGasLimit: 300_000n,
    preVerificationGas: 60_000n,
    // The relayer pays the outer tx; a zero fee means no prefund from the account.
    maxFeePerGas: 0n,
    maxPriorityFeePerGas: 0n,
    signature: "0x",
  };
}

/** What the EOA signs (personal_sign of these 32 bytes, i.e. signMessage({ message: { raw } })). */
export const userOpHash = (op: UserOperation<"0.7">, chainId: number) =>
  getUserOperationHash({ userOperation: op, entryPointAddress: ENTRY_POINT_V07, entryPointVersion: "0.7", chainId });

// --- testnet swap markets ---

/** One allow-listed pool and the oracle terms signed into the adapter policy. */
export type SwapMarket = {
  /** DSL coin names for currency0 / currency1. */
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

/**
 * Robinhood Chain testnet: tUSDG is Proviso's mock USDG (6 decimals; real testnet USDG isn't
 * obtainable), TSLA the candidate Stock Token; pool and liquidity from core's smoke-swaps script.
 */
export const TESTNET_SWAP = {
  usdg: "0x9c38b572260c79c4a01d71f85b1f222865804c2a" as Address,
  /** Uniswap v4 PoolSwapTest the ops aligner trades through (scripts/deploy-pool-swap-test.ts). */
  swapRouter: "0x0b7080d05b8071f5be5e7e538296af753ac81f7e" as Address,
  tsla: "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E" as Address,
  amzn: "0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02" as Address,
  markets: [
    {
      symbols: ["USDG", "TSLA"],
      key: { currency0: "0x9c38b572260c79c4a01d71f85b1f222865804c2a", currency1: "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E", fee: 3000, tickSpacing: 60, hooks: zeroAddress },
      decimals: [6, 18],
      oracle: TESTNET_TEST_FEEDS["TSLA/USDG"].feed as Address,
      baseIsCurrency0: false,
      multiplier: 10n ** 18n,
      adapterMaxSlipBps: 300,
    },
    {
      // AMZN sorts before tUSDG, so here the Stock Token is currency0.
      symbols: ["AMZN", "USDG"],
      key: { currency0: "0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02", currency1: "0x9c38b572260c79c4a01d71f85b1f222865804c2a", fee: 3000, tickSpacing: 60, hooks: zeroAddress },
      decimals: [18, 6],
      oracle: TESTNET_TEST_FEEDS["AMZN/USDG"].feed as Address,
      baseIsCurrency0: true,
      multiplier: 10n ** 18n,
      adapterMaxSlipBps: 300,
    },
  ] as readonly SwapMarket[],
  /** Default caps a user signs, per token (base units) and per pool for the adapter. */
  caps: {
    "0x9c38b572260c79c4a01d71f85b1f222865804c2a": { maxPerTx: 100n * 10n ** 6n, maxPerDay: 500n * 10n ** 6n },
    "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E": { maxPerTx: 10n ** 18n, maxPerDay: 2n * 10n ** 18n },
    "0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02": { maxPerTx: 10n ** 18n, maxPerDay: 2n * 10n ** 18n },
  } as Record<string, { maxPerTx: bigint; maxPerDay: bigint }>,
  policyDays: 30,
} as const;

// --- JSON (jsonb rows, tRPC payloads): bigints as decimal strings ---

/** JSON-safe copy: every bigint becomes its decimal string. */
export const toJsonSafe = <T>(v: T): unknown => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));

type Json = Record<string, unknown>;
const big = (x: unknown) => BigInt(x as string);
export const swapKeyPolicyFromJson = (j: Json): SwapKeyPolicy => ({
  account: j.account as Address,
  sessionKey: j.sessionKey as Address,
  adapter: j.adapter as Address,
  tokens: j.tokens as Address[],
  maxPerTx: (j.maxPerTx as string[]).map(big),
  maxPerDay: (j.maxPerDay as string[]).map(big),
  poolIds: j.poolIds as Hex[],
  expiresAt: big(j.expiresAt),
  nonce: big(j.nonce),
});
export const adapterPolicyFromJson = (j: Json): AdapterPolicy => ({
  account: j.account as Address,
  currency0: j.currency0 as Address,
  currency1: j.currency1 as Address,
  fee: Number(j.fee),
  tickSpacing: Number(j.tickSpacing),
  hooks: j.hooks as Address,
  oracle: j.oracle as Address,
  baseIsCurrency0: Boolean(j.baseIsCurrency0),
  multiplier: big(j.multiplier),
  maxSlipBps: Number(j.maxSlipBps),
  maxIn0: big(j.maxIn0),
  maxIn1: big(j.maxIn1),
  expiresAt: big(j.expiresAt),
  nonce: big(j.nonce),
});
export const userOpFromJson = (j: Json): UserOperation<"0.7"> => ({
  sender: j.sender as Address,
  nonce: big(j.nonce),
  callData: j.callData as Hex,
  callGasLimit: big(j.callGasLimit),
  verificationGasLimit: big(j.verificationGasLimit),
  preVerificationGas: big(j.preVerificationGas),
  maxFeePerGas: big(j.maxFeePerGas),
  maxPriorityFeePerGas: big(j.maxPriorityFeePerGas),
  signature: (j.signature as Hex) ?? "0x",
});

/** What swapKey.prepare stores in swap_keys.setup and the browser signs. */
export type SwapSetup = {
  chainId: number;
  /** Null when the account is already delegated to Kernel v3.3 with SwapKeyPolicy installed. */
  install: null | {
    /** Null when the account is already delegated (only the UserOp is left). */
    authorization: { address: Address; chainId: number; nonce: number } | null;
    userOp: UserOperation<"0.7">;
    userOpHash: Hex;
  };
  adapterPolicies: AdapterPolicy[];
  policy: SwapKeyPolicy;
};

export const swapSetupFromJson = (j: Record<string, any>): SwapSetup => ({
  chainId: Number(j.chainId),
  install: j.install
    ? {
        authorization: j.install.authorization
          ? { address: j.install.authorization.address, chainId: Number(j.install.authorization.chainId), nonce: Number(j.install.authorization.nonce) }
          : null,
        userOp: userOpFromJson(j.install.userOp),
        userOpHash: j.install.userOpHash,
      }
    : null,
  adapterPolicies: (j.adapterPolicies as Json[]).map(adapterPolicyFromJson),
  policy: swapKeyPolicyFromJson(j.policy),
});

// --- pool reads (evaluator inputs and the validator's depth floor) ---

const extsloadAbi = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]);
export const feedRoundAbi = parseAbi(["function latestRoundData() view returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80)"]);
type Reader = { readContract(a: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown> };

/** USD price of a market's non-quote token from the pool's slot0 (via PoolManager.extsload). */
export async function poolPriceUsd(r: Reader, poolManager: Address, m: SwapMarket, quote = "USDG"): Promise<number> {
  const slot = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId(m.key), 6n]));
  const word = BigInt((await r.readContract({ address: poolManager, abi: extsloadAbi, functionName: "extsload", args: [slot] })) as Hex);
  const sqrt = Number(word & ((1n << 160n) - 1n)) / 2 ** 96;
  const oneIn0 = sqrt * sqrt * 10 ** (m.decimals[0] - m.decimals[1]); // currency1 per currency0
  return m.symbols[1] === quote ? oneIn0 : 1 / oneIn0;
}

/**
 * Pool depth in USD: the quote tokens a ±2% price move trades through, both sides, from the
 * pool's active liquidity (Pool.State slot0 at +0, liquidity at +3).
 * ponytail: assumes the active liquidity spans ±2%; sum ticks if positions get that narrow.
 */
export async function poolDepthUsd(r: Reader, poolManager: Address, m: SwapMarket, quote = "USDG"): Promise<number> {
  const base = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId(m.key), 6n])));
  const word = (o: bigint) =>
    r.readContract({ address: poolManager, abi: extsloadAbi, functionName: "extsload", args: [`0x${(base + o).toString(16).padStart(64, "0")}`] }) as Promise<Hex>;
  const [w0, w3] = await Promise.all([word(0n), word(3n)]);
  const sqrt = Number(BigInt(w0) & ((1n << 160n) - 1n)) / 2 ** 96;
  const L = Number(BigInt(w3) & ((1n << 128n) - 1n));
  if (!sqrt || !L) return 0;
  const up = Math.sqrt(1.02) - 1, down = 1 - Math.sqrt(0.98);
  const quoteIs1 = m.symbols[1] === quote;
  // Δy = L·Δ√P (currency1), Δx = L·Δ(1/√P) (currency0)
  const q = quoteIs1 ? L * sqrt * (up + down) : (L / sqrt) * (1 - 1 / Math.sqrt(1.02) + 1 / Math.sqrt(0.98) - 1);
  return q / 10 ** m.decimals[quoteIs1 ? 1 : 0];
}

// --- the full setup a main key signs (swapKey.prepare and the live smoke share this) ---

type ChainReader = Reader & {
  getCode(a: { address: Address }): Promise<Hex | undefined>;
  getTransactionCount(a: { address: Address }): Promise<number>;
};

/** Builds every payload for one account, skipping the 7702 / install steps already done on-chain. */
export async function buildSwapSetup(
  r: ChainReader,
  o: {
    chainId: number;
    account: Address;
    sessionKey: Address;
    expiresAt: bigint;
    swapAdapter: Address;
    swapKeyPolicy: Address;
    markets: readonly SwapMarket[];
    caps: Record<string, { maxPerTx: bigint; maxPerDay: bigint }>;
  },
): Promise<SwapSetup> {
  const read = (address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[]) =>
    r.readContract({ address, abi, functionName, args }) as Promise<any>;
  const policyAbi = parseAbi(["function lastNonce(address) view returns (uint64)", "function lastPolicyNonce(address) view returns (uint64)"]);
  const delegated = (await r.getCode({ address: o.account }))?.toLowerCase() === kernelDelegationCode;
  const installed = delegated && (await read(o.account, kernelAbi, "isModuleInstalled", [MODULE_TYPE_EXECUTOR, o.swapKeyPolicy, "0x"]));
  let install: SwapSetup["install"] = null;
  if (!installed) {
    const op = installPolicyUserOp({ account: o.account, swapKeyPolicy: o.swapKeyPolicy, nonce: await read(ENTRY_POINT_V07, entryPointNonceAbi, "getNonce", [o.account, 0n]) });
    install = {
      // The relayer sends the tx, so the authorization uses the account's current nonce.
      authorization: delegated ? null : { address: KERNEL_V33_IMPLEMENTATION, chainId: o.chainId, nonce: await r.getTransactionCount({ address: o.account }) },
      userOp: op,
      userOpHash: userOpHash(op, o.chainId),
    };
  }
  const cap = (t: Address) => {
    const c = o.caps[t];
    if (!c) throw new Error(`no cap for token ${t}`);
    return c;
  };
  const lastAdapterNonce = (await read(o.swapAdapter, policyAbi, "lastPolicyNonce", [o.account])) as bigint;
  const adapterPolicies = o.markets.map((m, i) =>
    adapterPolicyFor(m.key, {
      account: o.account,
      oracle: m.oracle,
      baseIsCurrency0: m.baseIsCurrency0,
      multiplier: m.multiplier,
      maxSlipBps: m.adapterMaxSlipBps,
      maxIn0: cap(m.key.currency0).maxPerTx,
      maxIn1: cap(m.key.currency1).maxPerTx,
      expiresAt: o.expiresAt,
      nonce: lastAdapterNonce + 1n + BigInt(i),
    }),
  );
  const tokens = [...new Set(o.markets.flatMap((m) => [m.key.currency0, m.key.currency1]))];
  const policy = buildSwapKeyPolicy({
    account: o.account,
    sessionKey: o.sessionKey,
    adapter: o.swapAdapter,
    caps: tokens.map((token) => ({ token, ...cap(token) })),
    pools: o.markets.map((m) => m.key),
    expiresAt: o.expiresAt,
    nonce: ((await read(o.swapKeyPolicy, policyAbi, "lastNonce", [o.account])) as bigint) + 1n,
  });
  return { chainId: o.chainId, install, adapterPolicies, policy };
}

/** The EIP-712 payloads of a setup, in signing order. */
export const swapSetupTypedData = (s: SwapSetup, o: { swapAdapter: Address; swapKeyPolicy: Address }) => ({
  adapter: s.adapterPolicies.map((p) => adapterPolicyTypedData(p, { chainId: s.chainId, verifyingContract: o.swapAdapter })),
  policy: swapKeyPolicyTypedData(s.policy, { chainId: s.chainId, verifyingContract: o.swapKeyPolicy }),
});

// --- what the browser checks before signing anything the server built ---

/**
 * Throws unless `s` is exactly the setup this client expects for `account`: the 7702 target is
 * Kernel v3.3 on this chain, the UserOp only installs SwapKeyPolicy (zero fee) and its hash is
 * recomputed, and both policies name the known adapter, pools, oracles and caps with a bounded
 * expiry. The caller then signs typed data rebuilt locally, never the server's copy.
 */
export function checkSwapSetup(
  s: SwapSetup,
  o: {
    account: Address;
    chainId: number;
    swapAdapter: Address;
    swapKeyPolicy: Address;
    markets: readonly SwapMarket[];
    caps: Record<string, { maxPerTx: bigint; maxPerDay: bigint }>;
    maxDays: number;
    now?: number;
  },
) {
  const fail = (what: string) => {
    throw new Error(`Refusing to sign: unexpected ${what} in the swap setup.`);
  };
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const nowS = BigInt(Math.floor((o.now ?? Date.now()) / 1000));
  const maxExpiry = nowS + BigInt(o.maxDays * 86_400 + 3_600);
  if (s.chainId !== o.chainId) fail("chain");
  if (s.install) {
    const a = s.install.authorization;
    if (a && (!same(a.address, KERNEL_V33_IMPLEMENTATION) || a.chainId !== o.chainId)) fail("delegation target");
    const op = s.install.userOp;
    const want = installPolicyUserOp({ account: o.account, swapKeyPolicy: o.swapKeyPolicy, nonce: op.nonce });
    if (!same(op.sender, o.account) || op.callData.toLowerCase() !== want.callData.toLowerCase()) fail("account operation");
    if (op.maxFeePerGas !== 0n || op.maxPriorityFeePerGas !== 0n || op.paymaster || op.factory) fail("account operation fee");
    if (userOpHash(op, o.chainId).toLowerCase() !== s.install.userOpHash.toLowerCase()) fail("account operation hash");
  }
  const capOf = (t: Address) => o.caps[t] ?? o.caps[Object.keys(o.caps).find((k) => same(k, t)) ?? ""] ?? fail(`token ${t}`)!;
  if (s.adapterPolicies.length !== o.markets.length) fail("adapter policy count");
  s.adapterPolicies.forEach((p, i) => {
    const m = o.markets[i]!;
    const ok =
      same(p.account, o.account) && same(p.currency0, m.key.currency0) && same(p.currency1, m.key.currency1) &&
      p.fee === m.key.fee && p.tickSpacing === m.key.tickSpacing && same(p.hooks, m.key.hooks) && same(p.oracle, m.oracle) &&
      p.baseIsCurrency0 === m.baseIsCurrency0 && p.multiplier === m.multiplier && p.maxSlipBps === m.adapterMaxSlipBps &&
      p.maxIn0 === capOf(m.key.currency0).maxPerTx && p.maxIn1 === capOf(m.key.currency1).maxPerTx && p.expiresAt <= maxExpiry;
    if (!ok) fail("adapter policy");
  });
  const p = s.policy;
  const tokens = [...new Set(o.markets.flatMap((m) => [m.key.currency0, m.key.currency1]))];
  const ids = o.markets.map((m) => poolId(m.key).toLowerCase());
  const ok =
    same(p.account, o.account) && same(p.adapter, o.swapAdapter) && !same(p.sessionKey, o.account) &&
    p.tokens.length === tokens.length &&
    p.tokens.every((t, i) => same(t, tokens[i]!) && p.maxPerTx[i] === capOf(t).maxPerTx && p.maxPerDay[i] === capOf(t).maxPerDay) &&
    p.poolIds.length === ids.length && p.poolIds.every((id, i) => id.toLowerCase() === ids[i]) &&
    p.expiresAt > nowS && p.expiresAt <= maxExpiry;
  if (!ok) fail("swap-key policy");
}

// --- revoke: one UserOp that uninstalls SwapKeyPolicy (its onUninstall clears the active policy) ---

export function revokePolicyUserOp(o: { account: Address; swapKeyPolicy: Address; nonce: bigint }): UserOperation<"0.7"> {
  return {
    ...installPolicyUserOp(o),
    callData: encodeFunctionData({ abi: kernelAbi, functionName: "uninstallModule", args: [MODULE_TYPE_EXECUTOR, o.swapKeyPolicy, "0x"] }),
  };
}

/** Throws unless `op` only uninstalls SwapKeyPolicy from `account`, costs it nothing, and hashes to `hash`. */
export function checkRevokeUserOp(op: UserOperation<"0.7">, hash: Hex, o: { account: Address; chainId: number; swapKeyPolicy: Address }) {
  const want = revokePolicyUserOp({ account: o.account, swapKeyPolicy: o.swapKeyPolicy, nonce: op.nonce });
  const ok =
    op.sender.toLowerCase() === o.account.toLowerCase() && op.callData.toLowerCase() === want.callData.toLowerCase() &&
    op.maxFeePerGas === 0n && op.maxPriorityFeePerGas === 0n && !op.paymaster && !op.factory &&
    userOpHash(op, o.chainId).toLowerCase() === hash.toLowerCase();
  if (!ok) throw new Error("Refusing to sign: unexpected revoke operation.");
}
