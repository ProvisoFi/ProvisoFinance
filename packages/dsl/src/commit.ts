import rfc8785 from "canonicalize";
import { bytesToHex, concat, keccak256, type Hex } from "viem";
import { Spec, type SpecInput } from "./schema.ts";

/** RFC 8785 (JCS) canonical JSON as UTF-8 bytes. */
export function canonicalize(part: unknown): Uint8Array {
  const s = rfc8785(part);
  if (s === undefined) throw new Error("Value has no canonical JSON form");
  return new TextEncoder().encode(s);
}

/** 32 random bytes from the platform CSPRNG (browser, Node, Bun, Vercel). */
export function newSalt(): Hex {
  return bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

/** keccak256(canonical ‖ salt), matching ThesisSeal.revealEntry/revealExit. */
export function commit(canonical: Uint8Array, salt: Hex): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(salt)) throw new Error("Salt must be 32 bytes of hex");
  return keccak256(concat([bytesToHex(canonical), salt]));
}

/**
 * C17 choice: the entry part is the whole spec minus `exit`, so the trigger, actions, limits,
 * mode, fire, cooldown and expiry are all bound by entryHash and revealed together at fire.
 * The exit part is { v, exit } and stays sealed until the position closes.
 */
export function entryPart(spec: Spec) {
  const { exit: _, ...entry } = spec;
  return entry;
}
export function exitPart(spec: Spec) {
  return { v: spec.v, exit: spec.exit };
}

export type Commitments = {
  entryHash: Hex;
  exitHash: Hex;
  canonicalEntry: Uint8Array;
  canonicalExit: Uint8Array;
  saltE: Hex;
  saltX: Hex;
};

/** Parses (filling defaults), canonicalizes both parts and commits. Throws on an invalid spec. */
export function splitCommitments(
  input: SpecInput,
  salts: { saltE?: Hex; saltX?: Hex } = {},
): Commitments {
  const spec = Spec.parse(input);
  const saltE = salts.saltE ?? newSalt();
  const saltX = salts.saltX ?? newSalt();
  const canonicalEntry = canonicalize(entryPart(spec));
  const canonicalExit = canonicalize(exitPart(spec));
  return {
    entryHash: commit(canonicalEntry, saltE),
    exitHash: commit(canonicalExit, saltX),
    canonicalEntry,
    canonicalExit,
    saltE,
    saltX,
  };
}
