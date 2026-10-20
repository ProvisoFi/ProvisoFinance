import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import type { Hex } from "viem";
import { addressOf } from "../signer/agentKey";

// The pure policy code (types, EIP-712 payloads, pool ids) lives in @proviso/chain so the API and
// the browser build exactly what core and the contracts check. The session key stays here.
export {
  ADAPTER_POLICY_TYPES,
  adapterPolicyFor,
  adapterPolicyTypedData,
  buildSwapKeyPolicy,
  poolId,
  SWAP_KEY_POLICY_TYPES,
  swapKeyPolicyHash,
  swapKeyPolicyTypedData,
  type AdapterPolicy,
  type PoolKey,
  type SwapKeyPolicy,
  type TokenCap,
} from "@proviso/chain";


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
