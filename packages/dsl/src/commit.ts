import rfc8785 from "canonicalize";
import { bytesToHex, concat, isAddress, keccak256, type Address, type Hex } from "viem";
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

/**
 * keccak256(owner ‖ canonical ‖ salt), matching ThesisSeal.revealEntry/revealExit. The owner is
 * bound in so a copied hash pair sealed under another key never verifies.
 */
export function commit(owner: Address, canonical: Uint8Array, salt: Hex): Hex {
  if (!isAddress(owner, { strict: false })) throw new Error("Owner must be an address");
  if (!/^0x[0-9a-fA-F]{64}$/.test(salt)) throw new Error("Salt must be 32 bytes of hex");
  return keccak256(concat([owner, bytesToHex(canonical), salt]));
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
/** The exit part, `{ v, exit }`, committed by exitHash and revealed only when the position closes. */
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

/** Parses (filling defaults), canonicalizes both parts and commits for `owner`. Throws on an invalid spec. */
export function splitCommitments(input: SpecInput, o: { owner: Address; saltE?: Hex; saltX?: Hex }): Commitments {
  const spec = Spec.parse(input);
  const saltE = o.saltE ?? newSalt();
  const saltX = o.saltX ?? newSalt();
  const canonicalEntry = canonicalize(entryPart(spec));
  const canonicalExit = canonicalize(exitPart(spec));
  return {
    entryHash: commit(o.owner, canonicalEntry, saltE),
    exitHash: commit(o.owner, canonicalExit, saltX),
    canonicalEntry,
    canonicalExit,
    saltE,
    saltX,
  };
}
