import { canonicalize, Spec, type SpecInput } from "@proviso/dsl";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";

/** Bump whenever replay semantics change; old test ids then stop matching. */
export const TESTER_VERSION = "1";

/** sha256(canonicalize(spec) ‖ JSON(sorted snapshot ids) ‖ TESTER_VERSION), hex. Defaults are filled first. */
export function testId(spec: Spec | SpecInput, snapshotIds: readonly string[], version = TESTER_VERSION): string {
  const ids = JSON.stringify([...snapshotIds].sort());
  return bytesToHex(sha256(concatBytes(canonicalize(Spec.parse(spec)), utf8ToBytes(ids), utf8ToBytes(version))));
}
