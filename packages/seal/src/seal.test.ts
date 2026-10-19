import { expect, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519.js";
import fc from "fast-check";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { checkAttestation, quoteReportData } from "./attestation.ts";
import { decrypt, encrypt, open, seal } from "./box.ts";
import { decryptRecovery, encryptRecovery, openSpec, recoveryKey, sealSpec, type SealedPayload } from "./spec.ts";

const priv = x25519.utils.randomSecretKey();
const pub = x25519.getPublicKey(priv);
const payload: SealedPayload = { v: 1, spec: { v: 1, mode: "live" }, saltE: `0x${"11".repeat(32)}`, saltX: `0x${"22".repeat(32)}` };

test("sealed box round trip for any plaintext", () => {
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 4096 }), (pt) => {
      expect(open(priv, seal(pub, pt))).toEqual(pt);
    }),
  );
});

test("only the recipient key opens it, and tampering fails", () => {
  const box = seal(pub, new TextEncoder().encode("secret"));
  expect(() => open(x25519.utils.randomSecretKey(), box)).toThrow();
  const tampered = box.slice();
  tampered[tampered.length - 1] ^= 1;
  expect(() => open(priv, tampered)).toThrow();
  // The ephemeral key is bound as associated data: swapping it fails too.
  const swapped = box.slice();
  swapped[5] ^= 1;
  expect(() => open(priv, swapped)).toThrow();
});

test("each seal is randomized", () => {
  const pt = new Uint8Array([1, 2, 3]);
  expect(seal(pub, pt)).not.toEqual(seal(pub, pt));
});

test("spec payload seals to the enclave and to the recovery key", () => {
  expect(openSpec(priv, sealSpec(pub, payload))).toEqual(payload);
  const key = recoveryKey(`0x${"ab".repeat(65)}`);
  expect(decryptRecovery(key, encryptRecovery(key, payload))).toEqual(payload);
  expect(() => decryptRecovery(recoveryKey(`0x${"cd".repeat(65)}`), encryptRecovery(key, payload))).toThrow();
});

test("symmetric round trip and wrong-key failure", () => {
  const key = new Uint8Array(32).fill(7);
  const pt = new TextEncoder().encode("backup");
  expect(decrypt(key, encrypt(key, pt))).toEqual(pt);
  expect(() => decrypt(new Uint8Array(32), encrypt(key, pt))).toThrow();
});


test("attestation must bind the key into the quote's report data", () => {
  const rd = sha256(concatBytes(utf8ToBytes("proviso-spec-key-v1"), pub));
  const quote = new Uint8Array(1000);
  quote.set(rd, 568);
  const a = { publicKey: bytesToHex(pub), reportData: bytesToHex(rd), quote: bytesToHex(quote), eventLog: "[]" };
  expect(checkAttestation(a)).toEqual(pub);
  expect(quoteReportData(a.quote).slice(0, 64)).toBe(bytesToHex(rd));
  const other = x25519.getPublicKey(x25519.utils.randomSecretKey());
  expect(() => checkAttestation({ ...a, publicKey: bytesToHex(other) })).toThrow("does not bind");
  expect(() => checkAttestation({ ...a, quote: bytesToHex(new Uint8Array(1000)) })).toThrow("Quote");
});
