import { expect, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519.js";
import { attest, deriveSpecKey, reportData, type KeySource } from "./enclave";

const fake = (seed: number): KeySource => ({
  getKey: async () => ({ key: new Uint8Array(32).fill(seed) }),
  getQuote: async (data) => ({ quote: `quote:${Buffer.from(data).toString("hex")}`, event_log: "[]" }),
});

test("spec key is deterministic per app key and differs across apps", async () => {
  const a1 = await deriveSpecKey(fake(1));
  const a2 = await deriveSpecKey(fake(1));
  const b = await deriveSpecKey(fake(2));
  expect(a1.publicKey).toEqual(a2.publicKey);
  expect(a1.publicKey).not.toEqual(b.publicKey);
  expect(x25519.getPublicKey(a1.privateKey)).toEqual(a1.publicKey);
});

test("quote commits to the published public key", async () => {
  const out = await attest(fake(1));
  const expected = Buffer.from(reportData(Buffer.from(out.publicKey, "hex"))).toString("hex");
  expect(out.reportData).toBe(expected);
  expect(out.quote).toBe(`quote:${expected}`);
});
