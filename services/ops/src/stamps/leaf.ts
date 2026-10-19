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

export const HOUR_MS = 3_600_000;
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
