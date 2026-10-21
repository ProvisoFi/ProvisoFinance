// Browser-side verification of the core enclave's attestation before sealing a spec to its key.
// The attestation reaches the browser through the API, so nothing in it is trusted until:
// 1. The TDX quote verifies (Intel DCAP via dcap-qvl: quote signature, QE report, PCK chain to Intel's
//    root CA, CRLs and an acceptable TCB status). Collateral comes from Phala's PCCS; it is Intel-signed,
//    so the PCCS is only trusted to be available.
// 2. The TD is not a debug TD, and runs an allow-listed dstack OS (MRTD, RTMR1, RTMR2).
// 3. The event log replays to the quoted RTMR3 and its compose-hash is allow-listed (allowed-compose.ts).
// 4. REPORTDATA is sha256("proviso-spec-key-v1" ‖ publicKey), zero-padded to 64 bytes.
// Not covered: freshness (the quote is made once at boot; there is no browser nonce).
import init, { js_get_collateral, js_verify } from "@phala/dcap-qvl-web";
import { sha256, sha384 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { ALLOWED_COMPOSE_HASHES, ALLOWED_OS } from "./allowed-compose.ts";

const BINDING = utf8ToBytes("proviso-spec-key-v1");
const PCCS_URL = "https://pccs.phala.network";
const OK_TCB = ["UpToDate", "SWHardeningNeeded"];

export type Attestation = { publicKey: string; reportData: string; quote: string; eventLog: string };
// The TD report fields dcap-qvl returns (hex, no 0x) that the checks below read.
export type TdReport = { td_attributes: string; mr_td: string; rt_mr1: string; rt_mr2: string; rt_mr3: string; report_data: string };
type Event = { imr: number; event_type: number; event: string; event_payload: string };

const strip = (h: string) => (h.startsWith("0x") ? h.slice(2) : h).toLowerCase();
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

let wasm: Promise<unknown> | undefined;

// Returns the 32-byte key to seal to, or throws if any check fails. `collateral`/`now` are for tests.
export async function verifyAttestation(a: Attestation, opts: { collateral?: unknown; now?: number } = {}): Promise<Uint8Array> {
  let td: TdReport;
  try {
    wasm ??= init().catch((e) => ((wasm = undefined), Promise.reject(e)));
    await wasm;
    const quote = hexToBytes(strip(a.quote));
    const collateral = opts.collateral ?? (await js_get_collateral(PCCS_URL, quote));
    const r = js_verify(quote, collateral, BigInt(opts.now ?? Math.floor(Date.now() / 1000)));
    if (!OK_TCB.includes(r.status)) throw new Error(`TCB status is ${r.status}`);
    if (!r.report?.TD10) throw new Error("not a TDX TD report");
    td = r.report.TD10;
  } catch (e) {
    throw new Error(`The enclave's TDX quote did not verify (${reason(e)}).`);
  }
  return checkReport(a, td);
}

// The checks on a verified TD report: debug bit, OS, app (RTMR3 → compose-hash) and key binding.
export function checkReport(a: Attestation, td: TdReport): Uint8Array {
  if (parseInt(td.td_attributes.slice(0, 2), 16) & 1) throw new Error("The enclave is a debug TD.");
  if (!ALLOWED_OS.some((o) => o.mrtd === td.mr_td && o.rtmr1 === td.rt_mr1 && o.rtmr2 === td.rt_mr2))
    throw new Error("The enclave runs an unknown OS image.");

  if (replayRtmr3(a.eventLog) !== td.rt_mr3) throw new Error("The enclave's event log does not match its quote.");
  const compose = rtmr3Events(a.eventLog).filter((e) => e.event === "compose-hash");
  if (compose.length !== 1 || !ALLOWED_COMPOSE_HASHES.includes(compose[0]!.event_payload))
    throw new Error("The enclave runs an app version this page does not allow.");

  const key = hexToBytes(strip(a.publicKey));
  if (key.length !== 32) throw new Error("Enclave key must be 32 bytes");
  const expected = bytesToHex(sha256(concatBytes(BINDING, key)));
  if (strip(a.reportData) !== expected) throw new Error("Attestation does not bind this key");
  if (td.report_data !== expected.padEnd(128, "0")) throw new Error("Quote does not carry this key");
  return key;
}

const rtmr3Events = (eventLog: string) => (JSON.parse(eventLog) as Event[]).filter((e) => e.imr === 3);

// dstack extends RTMR3 with sha384(event_type as u32 LE ‖ ":" ‖ event ‖ ":" ‖ payload), from 48 zero bytes.
export function replayRtmr3(eventLog: string): string {
  let rtmr3 = new Uint8Array(48);
  for (const e of rtmr3Events(eventLog)) {
    const type = new Uint8Array(4);
    new DataView(type.buffer).setUint32(0, e.event_type, true);
    const digest = sha384(concatBytes(type, utf8ToBytes(":"), utf8ToBytes(e.event), utf8ToBytes(":"), hexToBytes(e.event_payload)));
    rtmr3 = sha384(concatBytes(rtmr3, digest));
  }
  return bytesToHex(rtmr3);
}
