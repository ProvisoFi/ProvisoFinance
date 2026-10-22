import { x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";

// Subset of DstackClient used here, so tests can pass a fake.
export type KeySource = {
  getKey(path: string, purpose: string): Promise<{ key: Uint8Array }>;
  getQuote(reportData: Uint8Array): Promise<{ quote: string; event_log: string }>;
};

const KEY_PATH = "proviso/spec/v1";
const BINDING = utf8ToBytes("proviso-spec-key-v1");

/**
 * The spec-encryption key is derived by dstack KMS from this app's identity: the same
 * compose hash always gets the same key, and nothing outside the CVM can derive it.
 */
export async function deriveSpecKey(source: KeySource) {
  const { key } = await source.getKey(KEY_PATH, "spec-encryption");
  const privateKey = sha256(key);
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

/**
 * TDX report_data binds the public key into the quote, so a verified quote proves the
 * browser is sealing specs to a key that only this attested code holds.
 */
export const reportData = (publicKey: Uint8Array) => sha256(concatBytes(BINDING, publicKey));

/** The spec public key and a TDX quote over its report_data (hex), with the event log, for the browser to verify. */
export async function attest(source: KeySource) {
  const { publicKey } = await deriveSpecKey(source);
  const data = reportData(publicKey);
  const { quote, event_log } = await source.getQuote(data);
  return { publicKey: bytesToHex(publicKey), reportData: bytesToHex(data), quote, eventLog: event_log };
}
