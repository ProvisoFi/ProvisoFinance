import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import type { Hex } from "./policy";

// Per-user trade-only Hyperliquid agent keys (Backend §6). The private key exists in clear
// only inside the enclave; at rest it is XChaCha20-Poly1305 sealed under a caller-supplied
// 32-byte key, with the user, agent, name and expiry bound as associated data.

export const DEFAULT_AGENT_TTL_MS = 90 * 86_400_000;

export type SealedAgentKey = {
  /** The user's main (master) address that approves the agent. Lowercase. */
  user: Hex;
  /** The agent's address. Lowercase. */
  agent: Hex;
  name: string;
  version: number;
  /** Unix ms; also carried in the approve name as `valid_until`. */
  validUntil: number;
  nonce: Hex;
  ciphertext: Hex;
};

export type RotationReason = "refunded" | "expired";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const hex = (b: Uint8Array): Hex => `0x${bytesToHex(b)}`;
const unhex = (h: string) => hexToBytes(h.startsWith("0x") ? h.slice(2) : h);

/** Lowercase Ethereum address of a secp256k1 private key (what viem's privateKeyToAddress computes). */
export function addressOf(privateKey: Hex | Uint8Array): Hex {
  const sk = typeof privateKey === "string" ? unhex(privateKey) : privateKey;
  return hex(keccak_256(secp256k1.getPublicKey(sk, false).slice(1)).slice(-20));
}

/** `proviso-<first 8 hex of user address>-v<version>`; re-approving a name on Hyperliquid replaces that agent. */
export function agentName(user: string, version: number): string {
  if (!ADDRESS_RE.test(user)) throw new Error("user must be a 20-byte hex address");
  if (!Number.isInteger(version) || version < 1) throw new Error("version must be a positive integer");
  return `proviso-${user.slice(2, 10).toLowerCase()}-v${version}`;
}

/** Fields for the main key's ApproveAgent signature (HL convention: `name valid_until <ms>`). */
export const typedApproveAgentFields = (k: SealedAgentKey) => ({
  agentAddress: k.agent,
  agentName: `${k.name} valid_until ${k.validUntil}`,
});

/** True when the account was re-funded from empty: Hyperliquid may have pruned the agent, so a fresh one is needed. */
export const refundedFromEmpty = (prevAccountValue: number | null | undefined, accountValue: number) =>
  prevAccountValue === 0 && accountValue > 0;

const aad = (k: Pick<SealedAgentKey, "user" | "agent" | "name" | "validUntil">) =>
  utf8ToBytes(`proviso-agent-v1|${k.user}|${k.agent}|${k.name}|${k.validUntil}`);

/** Creates, seals (XChaCha20-Poly1305 under the 32-byte seal key, metadata bound as AAD), unseals and rotates per-user Hyperliquid agent keys valid for `ttlMs` (default 90 days). */
export class AgentKeyManager {
  readonly #key: Uint8Array;

  constructor(sealKey: Uint8Array, readonly ttlMs = DEFAULT_AGENT_TTL_MS) {
    if (!(sealKey instanceof Uint8Array) || sealKey.length !== 32) throw new Error("seal key must be 32 bytes");
    if (!(ttlMs > 0)) throw new Error("ttlMs must be positive");
    this.#key = sealKey.slice();
  }

  /** Generate and seal a fresh agent key. The clear private key never leaves this call. */
  create(user: string, version = 1, now = Date.now()): SealedAgentKey {
    const name = agentName(user, version);
    const sk = secp256k1.utils.randomSecretKey();
    const meta = { user: user.toLowerCase() as Hex, agent: addressOf(sk), name, version, validUntil: now + this.ttlMs };
    const nonce = randomBytes(24);
    const ciphertext = xchacha20poly1305(this.#key, nonce, aad(meta)).encrypt(sk);
    sk.fill(0);
    return { ...meta, nonce: hex(nonce), ciphertext: hex(ciphertext) };
  }

  /** Recover the private key; throws if the record was tampered with or sealed under another key. */
  unseal(k: SealedAgentKey): Hex {
    const sk = xchacha20poly1305(this.#key, unhex(k.nonce), aad(k)).decrypt(unhex(k.ciphertext));
    if (addressOf(sk) !== k.agent.toLowerCase()) throw new Error("sealed key does not match agent address");
    const out = hex(sk);
    sk.fill(0);
    return out;
  }

  /** Why this key must be replaced before signing again, or null if it is still good. */
  rotationReason(
    k: SealedAgentKey,
    o: { prevAccountValue?: number | null; accountValue: number; now?: number },
  ): RotationReason | null {
    if (refundedFromEmpty(o.prevAccountValue, o.accountValue)) return "refunded";
    if ((o.now ?? Date.now()) >= k.validUntil) return "expired";
    return null;
  }

  /** A fresh key at the next version (new name, so the old agent is never re-approved). */
  rotate(k: SealedAgentKey, now = Date.now()): SealedAgentKey {
    return this.create(k.user, k.version + 1, now);
  }
}
