// What gets sealed for the enclave and for the owner's recovery export: the full spec
// plus both salts. Plaintext of this payload must never be logged or stored server-side.
// `purpose` and `owner` domain-separate boxes: a thesis box never opens as a test (whose results
// would reveal its levels), a test box never opens as a thesis, and neither opens for another owner.
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { decrypt, encrypt, open, seal } from "./box.ts";

export type SealPurpose = "thesis" | "test";
export type SealedPayload = { v: 1; purpose: SealPurpose; owner: `0x${string}`; spec: unknown; saltE: `0x${string}`; saltX: `0x${string}` };
/** As opened: boxes sealed before purposes existed (mainnet theses #1-#3) have neither field. */
export type OpenedPayload = Omit<SealedPayload, "purpose" | "owner"> & Partial<Pick<SealedPayload, "purpose" | "owner">>;

const enc = (p: SealedPayload) => utf8ToBytes(JSON.stringify(p));
const dec = (b: Uint8Array): OpenedPayload => {
  const p = JSON.parse(new TextDecoder().decode(b));
  if (p?.v !== 1 || typeof p.saltE !== "string" || typeof p.saltX !== "string") throw new Error("Bad payload");
  return p;
};

/** Seals a spec payload to the enclave's attested public key. */
export const sealSpec = (enclavePub: Uint8Array, p: SealedPayload) => seal(enclavePub, enc(p));

/** Opens a box only for the purpose and owner it was sealed for. A payload without a purpose is a legacy thesis. */
export function openSpec(enclavePriv: Uint8Array, box: Uint8Array, want: { purpose: SealPurpose; owner: string }): OpenedPayload {
  const p = dec(open(enclavePriv, box));
  if ((p.purpose ?? "thesis") !== want.purpose) throw new Error("Payload is for another purpose");
  if (p.owner === undefined && want.purpose === "test") throw new Error("Payload has no owner");
  if (p.owner !== undefined && String(p.owner).toLowerCase() !== want.owner.toLowerCase()) throw new Error("Payload is for another owner");
  return p;
}

// The recovery key comes from the owner's wallet signature over a fixed message, so the
// owner can always re-derive it and Proviso never holds it. Deterministic for EOAs (RFC 6979).
export const RECOVERY_MESSAGE =
  "Proviso recovery key v1\n\nSigning this derives the key that encrypts your idea backups. It costs nothing and moves no funds.";

/** The 32-byte recovery key: sha256 of the owner's signature over `RECOVERY_MESSAGE`. */
export const recoveryKey = (signature: `0x${string}`) => sha256(hexToBytes(signature.slice(2)));
/** Encrypts a payload under the owner's recovery key for their backup export. */
export const encryptRecovery = (key: Uint8Array, p: SealedPayload) => encrypt(key, enc(p));
/** Decrypts a recovery export; throws on a wrong key or a malformed payload. */
export const decryptRecovery = (key: Uint8Array, data: Uint8Array) => dec(decrypt(key, data));
