// Evidence leaves and hourly roots (Backend §3). Isomorphic: viem + merkle-tree only, so the
// browser can import this file to verify a proof against StampRoots.roots(hourStart).root.
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { encodeAbiParameters, keccak256, type Hex } from "viem";

export const KIND = { FIRE: 0, FILL: 1, EXIT: 2, PNL: 3, EXPIRE: 4 } as const;
export type StampKind = keyof typeof KIND;

/** OpenZeppelin StandardMerkleTree encoding of one evidence leaf. */
export const LEAF_ENCODING = ["uint256", "uint32", "uint8", "bytes32"];
/** [thesisId, seq, kind code, dataHash = keccak256(canonicalize(data))] */
export type LeafValues = [thesisId: bigint, seq: number, kind: number, dataHash: Hex];

/**
 * Leaf data schema. Version 2 (2026-10-23) adds, inside `data` (so the leaf encoding and every proof
 * stay the same; leaves from before carry no `v`):
 *  - `mode`: the call's mode: "live" (trades), "alert" (no orders), "paper" (simulated, no money moves).
 *  - `fillModel`: how fills in this record are priced: "venue" (reported by the venue: Hyperliquid
 *    order responses, Robinhood Chain receipts), "none" (alerts place nothing), later "paper-v1".
 *  - `market`: venue-qualified market, e.g. "hl:BTC", "hl:xyz:TSLA", "rhc:TSLA"; null for leaves
 *    about the whole call (EXIT, PNL, EXPIRE).
 *  - `session`: the market's session when the leaf was written: "24/7" for Hyperliquid crypto perps;
 *    "pre" | "regular" | "post" | "closed" for Robinhood Chain Stock Tokens by the US equity clock
 *    (New York time, weekends closed, exchange holidays not yet applied); null where not classified yet
 *    (HIP-3 markets get theirs from the session guards).
 */
export const LEAF_SCHEMA = 2;
export type LeafMode = "live" | "alert" | "paper";
export type LeafMeta = { v: typeof LEAF_SCHEMA; mode: LeafMode | null; fillModel: string | null; market: string | null; session: string | null };

/** How a call's fills are priced in its record. */
export const fillModelFor = (mode: string | null): string | null =>
  mode === "live" ? "venue" : mode === "alert" ? "none" : mode === "paper" ? "paper-v1" : null;

/** New York wall clock for `at`: weekday 0 = Sunday, minutes since midnight. */
function nyClock(at: Date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { day, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

/** The session label for `market` at `at` (see LEAF_SCHEMA). */
export function sessionOf(market: string | null, at: Date): string | null {
  if (!market) return null;
  const [venue, ...rest] = market.split(":");
  if (venue === "hl" && rest.length === 1) return "24/7"; // Hyperliquid crypto perps
  if (venue !== "rhc") return null; // HIP-3 (e.g. hl:xyz:…): classified by the session guards
  const { day, minutes } = nyClock(at);
  if (day === 0 || day === 6) return "closed";
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return "pre";
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return "regular";
  if (minutes >= 16 * 60 && minutes < 20 * 60) return "post";
  return "closed";
}

export const HOUR_MS = 3_600_000;
/** Start of the UTC hour containing `at`. */
export const hourOf = (at: Date) => new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);

/** StandardMerkleTree leaf hash: keccak256(bytes.concat(keccak256(abi.encode(values)))). */
export function leafHash(values: LeafValues): Hex {
  const [thesisId, seq, kind, dataHash] = values;
  const enc = encodeAbiParameters(
    LEAF_ENCODING.map((type) => ({ type })),
    [thesisId, seq, kind, dataHash],
  );
  return keccak256(keccak256(enc));
}

/** Tree over one hour's leaves. StandardMerkleTree sorts leaves, so the root ignores input order. */
export function buildHourRoot(leaves: LeafValues[]) {
  if (!leaves.length) throw new Error("Cannot build a root over zero leaves");
  const tree = StandardMerkleTree.of(leaves, LEAF_ENCODING);
  return { root: tree.root as Hex, leafCount: leaves.length, tree };
}

export type LeafProof = {
  thesisId: string | bigint; // decimal string in JSON responses
  seq: number;
  kind: number;
  dataHash: Hex;
  proof: Hex[];
};

/** True iff the leaf is in the tree with this root. Pass the on-chain root, not the API's. */
export function verifyProof(p: LeafProof, root: Hex): boolean {
  try {
    return StandardMerkleTree.verify(root, LEAF_ENCODING, [BigInt(p.thesisId), p.seq, p.kind, p.dataHash], p.proof);
  } catch {
    return false; // malformed input is just an invalid proof
  }
}

/** Missing seq numbers between 1 and the highest seen (seqs start at 1). A truncated tail is invisible. */
export function sequenceGaps(seqs: Iterable<number>): number[] {
  const seen = new Set(seqs);
  const max = Math.max(0, ...seen);
  const gaps: number[] = [];
  for (let s = 1; s <= max; s++) if (!seen.has(s)) gaps.push(s);
  return gaps;
}
