// Sealed box to an X25519 public key (the core enclave's attested spec key):
//   ephemeral X25519 → HKDF-SHA256 → XChaCha20-Poly1305.
// Layout: version(1) ‖ ephemeralPub(32) ‖ nonce(24) ‖ ciphertext+tag.
// Only the holder of the recipient private key (inside the enclave) can open it.
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";

const VERSION = 1;
const INFO = utf8ToBytes("proviso-seal-v1");
const HEADER = 1 + 32 + 24;

const boxKey = (shared: Uint8Array, ephPub: Uint8Array, recipientPub: Uint8Array) =>
  hkdf(sha256, shared, concatBytes(ephPub, recipientPub), INFO, 32);

export function seal(recipientPub: Uint8Array, plaintext: Uint8Array): Uint8Array {
  if (recipientPub.length !== 32) throw new Error("Recipient key must be 32 bytes");
  const ephPriv = x25519.utils.randomSecretKey();
  const ephPub = x25519.getPublicKey(ephPriv);
  const key = boxKey(x25519.getSharedSecret(ephPriv, recipientPub), ephPub, recipientPub);
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(key, nonce, ephPub).encrypt(plaintext);
  return concatBytes(new Uint8Array([VERSION]), ephPub, nonce, ct);
}

export function open(recipientPriv: Uint8Array, box: Uint8Array): Uint8Array {
  if (box.length < HEADER + 16 || box[0] !== VERSION) throw new Error("Not a sealed box");
  const ephPub = box.subarray(1, 33);
  const nonce = box.subarray(33, HEADER);
  const recipientPub = x25519.getPublicKey(recipientPriv);
  const key = boxKey(x25519.getSharedSecret(recipientPriv, ephPub), ephPub, recipientPub);
  return xchacha20poly1305(key, nonce, ephPub).decrypt(box.subarray(HEADER));
}

// Symmetric form for the owner's recovery export: version(1) ‖ nonce(24) ‖ ciphertext+tag.
export function encrypt(key: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const nonce = randomBytes(24);
  return concatBytes(new Uint8Array([VERSION]), nonce, xchacha20poly1305(key, nonce).encrypt(plaintext));
}

export function decrypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length < 25 + 16 || data[0] !== VERSION) throw new Error("Not an encrypted export");
  return xchacha20poly1305(key, data.subarray(1, 25)).decrypt(data.subarray(25));
}
