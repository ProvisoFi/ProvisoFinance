import { expect, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519.js";
import fc from "fast-check";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { checkReport, replayRtmr3, verifyAttestation, verifyQuote } from "./attestation.ts";
import fixture from "./fixtures/core-attestation.json";
import { decrypt, encrypt, open, seal } from "./box.ts";
import { decryptRecovery, encryptRecovery, openSpec, recoveryKey, sealSpec, type SealedPayload } from "./spec.ts";

const priv = x25519.utils.randomSecretKey();
const pub = x25519.getPublicKey(priv);
const OWNER = `0x${"aa".repeat(20)}` as const;
const payload: SealedPayload = { v: 1, purpose: "thesis", owner: OWNER, spec: { v: 1, mode: "live" }, saltE: `0x${"11".repeat(32)}`, saltX: `0x${"22".repeat(32)}` };

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
  expect(openSpec(priv, sealSpec(pub, payload), { purpose: "thesis", owner: OWNER.toUpperCase() })).toEqual(payload);
  const key = recoveryKey(`0x${"ab".repeat(65)}`);
  expect(decryptRecovery(key, encryptRecovery(key, payload))).toEqual(payload);
  expect(() => decryptRecovery(recoveryKey(`0x${"cd".repeat(65)}`), encryptRecovery(key, payload))).toThrow();
});

test("a box opens only for the purpose and owner it was sealed for; a legacy box is a thesis", () => {
  const test = sealSpec(pub, { ...payload, purpose: "test" });
  expect(openSpec(priv, test, { purpose: "test", owner: OWNER }).purpose).toBe("test");
  expect(() => openSpec(priv, test, { purpose: "thesis", owner: OWNER })).toThrow("another purpose");
  expect(() => openSpec(priv, sealSpec(pub, payload), { purpose: "test", owner: OWNER })).toThrow("another purpose");
  expect(() => openSpec(priv, test, { purpose: "test", owner: `0x${"bb".repeat(20)}` })).toThrow("another owner");
  expect(() => openSpec(priv, sealSpec(pub, payload), { purpose: "thesis", owner: `0x${"bb".repeat(20)}` })).toThrow("another owner");
  // Sealed before purposes existed: opens as a thesis for any owner (the commitment binds it), never as a test.
  const { purpose: _p, owner: _o, ...old } = payload;
  const legacy = seal(pub, new TextEncoder().encode(JSON.stringify(old)));
  expect(openSpec(priv, legacy, { purpose: "thesis", owner: `0x${"bb".repeat(20)}` })).toEqual(old);
  expect(() => openSpec(priv, legacy, { purpose: "test", owner: OWNER })).toThrow("another purpose");
  const noOwner = seal(pub, new TextEncoder().encode(JSON.stringify({ ...old, purpose: "test" })));
  expect(() => openSpec(priv, noOwner, { purpose: "test", owner: OWNER })).toThrow("no owner");
});

test("symmetric round trip and wrong-key failure", () => {
  const key = new Uint8Array(32).fill(7);
  const pt = new TextEncoder().encode("backup");
  expect(decrypt(key, encrypt(key, pt))).toEqual(pt);
  expect(() => decrypt(new Uint8Array(32), encrypt(key, pt))).toThrow();
});


// A real quote from the live core CVM, with the Intel collateral fetched at capture time.
const live = fixture.attestation;
const opts = { collateral: fixture.collateral, now: fixture.now };

test("the live core attestation verifies and yields its key", async () => {
  expect(bytesToHex(await verifyAttestation(live, opts))).toBe(live.publicKey);
});

test("quotes that do not verify are refused", async () => {
  await expect(verifyAttestation({ ...live, quote: bytesToHex(new Uint8Array(5010)) }, opts)).rejects.toThrow("did not verify");
  const debug = hexToBytes(live.quote);
  debug[48 + 120] |= 1; // TDATTRIBUTES.DEBUG: the signature no longer covers it
  await expect(verifyAttestation({ ...live, quote: bytesToHex(debug) }, opts)).rejects.toThrow("did not verify");
  await expect(verifyAttestation(live, { ...opts, now: fixture.now + 400 * 86400 })).rejects.toThrow("did not verify");
});

test("a QE report or QE identity that does not match is refused", async () => {
  // QE report ISVPRODID (quote: 48 header + 584 TD report + 4 + 128 sig/key + 6 cert header, then +256).
  const qe = hexToBytes(live.quote);
  qe[770 + 256] ^= 1;
  await expect(verifyAttestation({ ...live, quote: bytesToHex(qe) }, opts)).rejects.toThrow("qe_report");
  // A QE identity edited to name another QE is no longer Intel-signed.
  const id = JSON.parse(fixture.collateral.qe_identity);
  const otherId = { ...fixture.collateral, qe_identity: JSON.stringify({ ...id, isvprodid: id.isvprodid + 1 }) };
  await expect(verifyAttestation(live, { ...opts, collateral: otherId })).rejects.toThrow("qe_identity");
});

test("a verified report is refused for a debug TD, another OS or app, or another key", async () => {
  const td = verifyQuote(hexToBytes(live.quote), fixture.collateral, fixture.now);
  expect(bytesToHex(checkReport(live, td))).toBe(live.publicKey);
  expect(() => checkReport(live, { ...td, td_attributes: "01" + td.td_attributes.slice(2) })).toThrow("debug TD");
  expect(() => checkReport(live, { ...td, mr_td: "00".repeat(48) })).toThrow("unknown OS");
  // Another compose hash in the event log: RTMR3 no longer matches, and a report that matched it is not allowed.
  const events = JSON.parse(live.eventLog).map((e: { event: string; event_payload: string }) =>
    e.event === "compose-hash" ? { ...e, event_payload: "ab".repeat(32) } : e,
  );
  const wrongApp = { ...live, eventLog: JSON.stringify(events) };
  expect(() => checkReport(wrongApp, td)).toThrow("does not match its quote");
  expect(() => checkReport(wrongApp, { ...td, rt_mr3: replayRtmr3(wrongApp.eventLog) })).toThrow("does not allow");
  // Another key: its own report data does not match the quote's.
  const rd = sha256(concatBytes(utf8ToBytes("proviso-spec-key-v1"), pub));
  expect(() => checkReport({ ...live, publicKey: bytesToHex(pub), reportData: bytesToHex(rd) }, td)).toThrow("Quote does not carry");
  expect(() => checkReport({ ...live, publicKey: bytesToHex(pub) }, td)).toThrow("does not bind");
});
