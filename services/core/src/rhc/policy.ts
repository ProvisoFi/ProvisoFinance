import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import {
  encodeAbiParameters,
  getAddress,
  hashStruct,
  keccak256,
  parseAbiParameters,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { addressOf } from "../signer/agentKey";

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

// --- session key (sealed like the HL agent keys in ../signer/agentKey.ts) ---

export type SealedSessionKey = {
  /** The 7702 account (= main-key EOA). Lowercase. */
  account: Hex;
  /** The session key's address. Lowercase. */
  sessionKey: Hex;
  chainId: number;
  /** Unix seconds; the policy's expiresAt should not exceed it. */
  expiresAt: number;
  nonce: Hex;
  ciphertext: Hex;
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const hex = (b: Uint8Array): Hex => `0x${bytesToHex(b)}`;
const unhex = (h: string) => hexToBytes(h.startsWith("0x") ? h.slice(2) : h);
const aad = (k: Pick<SealedSessionKey, "account" | "sessionKey" | "chainId" | "expiresAt">) =>
  utf8ToBytes(`proviso-swapkey-v1|${k.account}|${k.sessionKey}|${k.chainId}|${k.expiresAt}`);

export class SessionKeyManager {
  readonly #key: Uint8Array;

  constructor(sealKey: Uint8Array) {
    if (!(sealKey instanceof Uint8Array) || sealKey.length !== 32) throw new Error("seal key must be 32 bytes");
    this.#key = sealKey.slice();
  }

  /** Generate and seal a fresh swap key for one account. The clear private key never leaves this call. */
  create(account: string, o: { chainId: number; expiresAt: number }): SealedSessionKey {
    if (!ADDRESS_RE.test(account)) throw new Error("account must be a 20-byte hex address");
    if (!Number.isInteger(o.chainId) || o.chainId <= 0) throw new Error("chainId must be a positive integer");
    if (!Number.isInteger(o.expiresAt) || o.expiresAt <= 0) throw new Error("expiresAt must be unix seconds");
    const sk = secp256k1.utils.randomSecretKey();
    const meta = { account: account.toLowerCase() as Hex, sessionKey: addressOf(sk), chainId: o.chainId, expiresAt: o.expiresAt };
    const nonce = randomBytes(24);
    const ciphertext = xchacha20poly1305(this.#key, nonce, aad(meta)).encrypt(sk);
    sk.fill(0);
    return { ...meta, nonce: hex(nonce), ciphertext: hex(ciphertext) };
  }

  /** Recover the private key; throws if the record was tampered with or sealed under another key. */
  unseal(k: SealedSessionKey): Hex {
    const sk = xchacha20poly1305(this.#key, unhex(k.nonce), aad(k)).decrypt(unhex(k.ciphertext));
    if (addressOf(sk) !== k.sessionKey.toLowerCase()) throw new Error("sealed key does not match session key address");
    const out = hex(sk);
    sk.fill(0);
    return out;
  }
}
