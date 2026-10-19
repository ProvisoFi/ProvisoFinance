// Browser-side checks on the core enclave's attestation before sealing a spec to its key.
// 1. The key binding: reportData must be sha256("proviso-spec-key-v1" ‖ publicKey).
// 2. The quote must carry that reportData (TDX v4 quote: 48-byte header, then the TD report
//    body whose last 64 bytes are REPORTDATA, i.e. bytes 568..632).
// Verifying the quote's signature chain and measurements against the published compose
// hash is done by a TDX verifier (Phala's), not here.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

const BINDING = utf8ToBytes("proviso-spec-key-v1");
const REPORT_DATA_OFFSET = 48 + 520;

export type Attestation = { publicKey: string; reportData: string; quote: string; eventLog: string };

const strip = (h: string) => (h.startsWith("0x") ? h.slice(2) : h);

export function quoteReportData(quoteHex: string): string {
  const q = hexToBytes(strip(quoteHex));
  if (q.length < REPORT_DATA_OFFSET + 64) throw new Error("Quote too short");
  return bytesToHex(q.subarray(REPORT_DATA_OFFSET, REPORT_DATA_OFFSET + 64));
}

// Returns the 32-byte key to seal to, or throws if the attestation doesn't bind it.
export function checkAttestation(a: Attestation): Uint8Array {
  const key = hexToBytes(strip(a.publicKey));
  if (key.length !== 32) throw new Error("Enclave key must be 32 bytes");
  const expected = bytesToHex(sha256(concatBytes(BINDING, key)));
  if (strip(a.reportData) !== expected) throw new Error("Attestation does not bind this key");
  // dstack pads 32-byte report data to the 64-byte field with zeros.
  if (quoteReportData(a.quote) !== expected.padEnd(128, "0")) throw new Error("Quote does not carry this key");
  return key;
}
