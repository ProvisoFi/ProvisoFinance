import { describe, expect, test } from "bun:test";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import fc from "fast-check";
import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { buildHourRoot, hourOf, KIND, leafHash, LEAF_ENCODING, sequenceGaps, verifyProof, type LeafValues } from "./leaf";

const h = (n: number) => keccak256(`0x${n.toString(16).padStart(2, "0")}`);
const leaf = (thesisId: bigint, seq: number, kind = KIND.FIRE as number, d = h(seq)): LeafValues => [thesisId, seq, kind, d];

const arbLeaves = fc
  .uniqueArray(fc.tuple(fc.bigInt({ min: 0n, max: 2n ** 64n }), fc.integer({ min: 1, max: 2 ** 32 - 1 })), {
    minLength: 1,
    maxLength: 40,
    selector: ([t, s]) => `${t}:${s}`,
  })
  .chain((keys) =>
    fc.tuple(
      fc.constant(keys),
      fc.array(fc.integer({ min: 0, max: 4 }), { minLength: keys.length, maxLength: keys.length }),
      fc.array(fc.uint8Array({ minLength: 32, maxLength: 32 }), { minLength: keys.length, maxLength: keys.length }),
    ),
  )
  .map(([keys, kinds, datas]) =>
    keys.map(([t, s], i): LeafValues => [t, s, kinds[i]!, keccak256(datas[i]!)]),
  );

describe("kind codes", () => {
  test("match the spec", () => {
    expect(KIND).toEqual({ FIRE: 0, FILL: 1, EXIT: 2, PNL: 3, EXPIRE: 4 });
  });
});

describe("leafHash", () => {
  test("is the StandardMerkleTree double hash over (uint256, uint32, uint8, bytes32)", () => {
    const v = leaf(42n, 7, KIND.PNL, h(1));
    const enc = encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint32" }, { type: "uint8" }, { type: "bytes32" }],
      [42n, 7, 3, h(1)],
    );
    expect(leafHash(v)).toBe(keccak256(keccak256(enc)));
    expect(leafHash(v)).toBe(StandardMerkleTree.of([v], LEAF_ENCODING).leafHash(v) as Hex);
  });

  test("is deterministic and sensitive to every field", () => {
    const v = leaf(1n, 1, KIND.FILL, h(9));
    expect(leafHash(v)).toBe(leafHash([...v] as LeafValues));
    const variants: LeafValues[] = [leaf(2n, 1, 1, h(9)), leaf(1n, 2, 1, h(9)), leaf(1n, 1, 2, h(9)), leaf(1n, 1, 1, h(8))];
    for (const w of variants) expect(leafHash(w)).not.toBe(leafHash(v));
  });

  test("property: matches the tree's own leaf hash", () => {
    fc.assert(
      fc.property(arbLeaves, (leaves) => {
        const { tree } = buildHourRoot(leaves);
        for (const v of leaves) expect(leafHash(v)).toBe(tree.leafHash(v) as Hex);
      }),
      { numRuns: 30 },
    );
  });
});

describe("buildHourRoot", () => {
  test("rejects an empty hour", () => {
    expect(() => buildHourRoot([])).toThrow();
  });

  test("one leaf: root is the leaf hash and the proof is empty", () => {
    const v = leaf(5n, 1);
    const { root, leafCount, tree } = buildHourRoot([v]);
    expect(root).toBe(leafHash(v));
    expect(leafCount).toBe(1);
    expect(tree.getProof(v)).toEqual([]);
    expect(verifyProof({ thesisId: 5n, seq: 1, kind: 0, dataHash: v[3], proof: [] }, root)).toBe(true);
  });

  test("property: root is independent of insert order", () => {
    fc.assert(
      fc.property(
        arbLeaves.chain((l) => fc.tuple(fc.constant(l), fc.shuffledSubarray(l, { minLength: l.length }))),
        ([leaves, shuffled]) => {
          expect(buildHourRoot(shuffled).root).toBe(buildHourRoot(leaves).root);
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe("verifyProof", () => {
  test("property: every leaf's proof verifies, a tampered one does not", () => {
    fc.assert(
      fc.property(arbLeaves, (leaves) => {
        const { root, tree } = buildHourRoot(leaves);
        for (const [thesisId, seq, kind, dataHash] of leaves) {
          const proof = tree.getProof([thesisId, seq, kind, dataHash]) as Hex[];
          const p = { thesisId: thesisId.toString(), seq, kind, dataHash, proof };
          expect(verifyProof(p, root)).toBe(true);
          expect(verifyProof(JSON.parse(JSON.stringify(p)), root)).toBe(true);
          expect(verifyProof({ ...p, seq: seq === 1 ? 2 : seq - 1 }, root)).toBe(false);
          expect(verifyProof({ ...p, kind: (kind + 1) % 5 }, root)).toBe(false);
          expect(verifyProof({ ...p, dataHash: h(255) }, root)).toBe(false);
        }
      }),
      { numRuns: 30 },
    );
  });

  test("wrong root and malformed input are just false", () => {
    const leaves = [leaf(1n, 1), leaf(1n, 2), leaf(2n, 1)];
    const { tree } = buildHourRoot(leaves);
    const proof = tree.getProof(leaves[0]!) as Hex[];
    const p = { thesisId: 1n, seq: 1, kind: 0, dataHash: leaves[0]![3], proof };
    expect(verifyProof(p, h(77))).toBe(false);
    expect(verifyProof({ ...p, dataHash: "0x1234" as Hex }, buildHourRoot(leaves).root)).toBe(false);
    expect(verifyProof({ ...p, thesisId: "not a number" }, buildHourRoot(leaves).root)).toBe(false);
  });
});

describe("sequenceGaps", () => {
  test("finds missing seqs from 1", () => {
    expect(sequenceGaps([])).toEqual([]);
    expect(sequenceGaps([1, 2, 3])).toEqual([]);
    expect(sequenceGaps([3, 1, 2])).toEqual([]);
    expect(sequenceGaps([2, 5])).toEqual([1, 3, 4]);
    expect(sequenceGaps([1, 1, 4])).toEqual([2, 3]);
  });

  test("property: gaps ∪ seqs = 1..max, disjoint", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 200 })), (seqs) => {
        const gaps = sequenceGaps(seqs);
        const max = Math.max(0, ...seqs);
        const all = new Set([...gaps, ...seqs]);
        expect(all.size).toBe(max);
        for (const g of gaps) expect(seqs).not.toContain(g);
      }),
    );
  });
});

test("hourOf floors to the hour", () => {
  expect(hourOf(new Date("2026-10-19T13:59:59.999Z")).toISOString()).toBe("2026-10-19T13:00:00.000Z");
  expect(hourOf(new Date("2026-10-19T14:00:00.000Z")).toISOString()).toBe("2026-10-19T14:00:00.000Z");
});
