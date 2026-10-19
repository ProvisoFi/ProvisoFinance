// What gets sealed for the enclave and for the owner's recovery export: the full spec
// plus both salts. Plaintext of this payload must never be logged or stored server-side.
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { decrypt, encrypt, open, seal } from "./box.ts";

export type SealedPayload = { v: 1; spec: unknown; saltE: `0x${string}`; saltX: `0x${string}` };

const enc = (p: SealedPayload) => utf8ToBytes(JSON.stringify(p));
const dec = (b: Uint8Array): SealedPayload => {
  const p = JSON.parse(new TextDecoder().decode(b));
  if (p?.v !== 1 || typeof p.saltE !== "string" || typeof p.saltX !== "string") throw new Error("Bad payload");
  return p;
};

export const sealSpec = (enclavePub: Uint8Array, p: SealedPayload) => seal(enclavePub, enc(p));
export const openSpec = (enclavePriv: Uint8Array, box: Uint8Array) => dec(open(enclavePriv, box));

// The recovery key comes from the owner's wallet signature over a fixed message, so the
// owner can always re-derive it and Proviso never holds it. Deterministic for EOAs (RFC 6979).
export const RECOVERY_MESSAGE =
  "Proviso recovery key v1\n\nSigning this derives the key that encrypts your idea backups. It costs nothing and moves no funds.";

export const recoveryKey = (signature: `0x${string}`) => sha256(hexToBytes(signature.slice(2)));
export const encryptRecovery = (key: Uint8Array, p: SealedPayload) => encrypt(key, enc(p));
export const decryptRecovery = (key: Uint8Array, data: Uint8Array) => dec(decrypt(key, data));
