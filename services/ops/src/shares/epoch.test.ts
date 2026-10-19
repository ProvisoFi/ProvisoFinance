import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { concat, encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { allocate, callerWeights, computeEpoch, MIN_HOLD_MS, verifyShare, type FollowerPosition } from "./epoch";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const A = addr(0xa);
const B = addr(0xb);
const C = addr(0xc);
const D = addr(0xd);
const F1 = addr(0xf1);
const F2 = addr(0xf2);

const START = new Date("2026-10-01T00:00:00Z");
const END = new Date("2026-10-08T00:00:00Z");
const t = (hours: number) => new Date(START.getTime() + hours * 3_600_000);
const DAY = 24;
const pos = (caller: Address, follower: Address, notionalUsd: number, open: number, close: number | null): FollowerPosition => ({
  caller,
  follower,
  notionalUsd,
  openedAt: t(open),
  closedAt: close === null ? null : t(close),
});
const base = { linkFlags: [], excluded: [], start: START, end: END };
const weights = (positions: FollowerPosition[], extra: Partial<typeof base> = {}) =>
  callerWeights({ ...base, ...extra, positions });

// OpenZeppelin MerkleProof.processProof with commutative keccak, written out like Solidity does it.
const solidityLeaf = (caller: Address, amount: bigint) =>
  keccak256(concat([keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [caller, amount]))]));
const solidityVerify = (proof: Hex[], root: Hex, leaf: Hex) =>
  proof.reduce((h, p) => keccak256(BigInt(h) < BigInt(p) ? concat([h, p]) : concat([p, h])), leaf) === root;

describe("callerWeights", () => {
  test("money × time, summed per caller", () => {
    const w = weights([pos(A, F1, 1000, 0, DAY), pos(A, F2, 500, 0, 2 * DAY), pos(B, F1, 10, 0, DAY)]);
    expect(w.get(A)).toBe(100_000n * 86_400_000n * 2n);
    expect(w.get(B)).toBe(1000n * 86_400_000n);
  });

  test("holds under 30 minutes don't count; exactly 30 minutes does", () => {
    const short = { ...pos(A, F1, 1e6, 1, null), closedAt: new Date(t(1).getTime() + MIN_HOLD_MS - 1) };
    const exact = { ...pos(B, F1, 1, 1, null), closedAt: new Date(t(1).getTime() + MIN_HOLD_MS) };
    const w = weights([short, exact]);
    expect(w.has(A)).toBe(false);
    expect(w.get(B)).toBe(100n * BigInt(MIN_HOLD_MS));
  });

  test("open positions run to epoch end; time outside the epoch is clipped", () => {
    const w = weights([pos(A, F1, 1, 7 * DAY - 1, null), pos(B, F1, 1, -DAY, 1), pos(C, F1, 1, -2 * DAY, -DAY)]);
    expect(w.get(A)).toBe(100n * 3_600_000n);
    expect(w.get(B)).toBe(100n * 3_600_000n); // opened before start: only the in-epoch hour counts
    expect(w.has(C)).toBe(false); // closed before the epoch
  });

  test("self-follows, linked pairs (either order, any case) and geofenced addresses are excluded", () => {
    const positions = [pos(A, A, 1, 0, DAY), pos(B, F1, 1, 0, DAY), pos(C, F2, 1, 0, DAY), pos(D, F1, 1, 0, DAY), pos(D, F2, 1, 0, DAY)];
    const w = weights(positions, {
      linkFlags: [{ a: F1.toUpperCase().replace("0X", "0x"), b: B }] as never,
      excluded: [C.toUpperCase().replace("0X", "0x"), F2] as never,
    });
    expect([...w.keys()]).toEqual([D]);
    expect(w.get(D)).toBe(100n * 86_400_000n); // only F1's position: F2 is geofenced
  });

  test("bad input throws", () => {
    expect(() => weights([pos(A, F1, -1, 0, DAY)])).toThrow("notional");
    expect(() => weights([pos(A, F1, NaN, 0, DAY)])).toThrow("notional");
    expect(() => weights([pos("0x123" as Address, F1, 1, 0, DAY)])).toThrow("address");
  });
});

describe("allocate", () => {
  const m = (...ws: [Address, bigint][]) => new Map(ws);

  test("pro rata when nobody hits the cap", () => {
    const out = allocate(m([A, 3n], [B, 1n]), 1000n, 10_000n);
    expect(out).toEqual(m([A, 750n], [B, 250n]));
  });

  test("capped leftover is redistributed to uncapped callers", () => {
    expect(allocate(m([A, 8n], [B, 1n], [C, 1n]), 100n, 50n)).toEqual(m([A, 50n], [B, 25n], [C, 25n]));
  });

  test("redistribution iterates until stable", () => {
    // round 1 caps A (58.8 > 30); round 2 then caps B (50 > 30); C and D split the remaining 40
    const out = allocate(m([A, 10n], [B, 5n], [C, 1n], [D, 1n]), 100n, 30n);
    expect(out).toEqual(m([A, 30n], [B, 30n], [C, 20n], [D, 20n]));
  });

  test("everyone capped leaves the rest of the pool unallocated", () => {
    const out = allocate(m([A, 1n], [B, 1n], [C, 1n]), 100n, 10n);
    expect([...out.values()]).toEqual([10n, 10n, 10n]);
  });

  test("flooring never over-allocates; dust is under one unit per caller", () => {
    const out = allocate(m([A, 1n], [B, 1n], [C, 1n]), 100n, 1000n);
    expect([...out.values()]).toEqual([33n, 33n, 33n]);
  });

  test("no weight, zero pool, zero cap", () => {
    expect(allocate(new Map(), 100n, 10n).size).toBe(0);
    expect(allocate(m([A, 0n]), 100n, 10n).size).toBe(0);
    expect([...allocate(m([A, 1n]), 0n, 10n).values()]).toEqual([0n]);
    expect([...allocate(m([A, 1n]), 100n, 0n).values()]).toEqual([0n]);
    expect(() => allocate(m([A, 1n]), -1n, 0n)).toThrow();
  });
});

describe("computeEpoch", () => {
  const USDG = 1_000_000n;

  test("matches CallerShare.claim's leaf and proof check, computed by hand", () => {
    const r = computeEpoch({
      ...base,
      positions: [pos(A, F1, 5000, 0, 3 * DAY), pos(B, F1, 1000, 0, DAY), pos(C, F2, 2500, 0, 2 * DAY)],
      pool: 1000n * USDG,
      cap: 600n * USDG,
    });
    expect(r.allocations.length).toBe(3);
    expect(r.total).toBeLessThanOrEqual(1000n * USDG);
    for (const a of r.allocations) {
      expect(solidityVerify(a.proof, r.root!, solidityLeaf(a.caller, a.amount))).toBe(true);
      expect(solidityVerify(a.proof, r.root!, solidityLeaf(a.caller, a.amount + 1n))).toBe(false);
      expect(verifyShare(r.root!, a.caller, a.amount, a.proof)).toBe(true);
    }
    // A: 15000 usd-days, B: 1000, C: 5000 of 21000 → A ≈ 714.28 > 600 cap → A = 600, B/C split 400 as 1:5
    expect(r.allocations.map((a) => a.amount)).toEqual([600n * USDG, 66_666_666n, 333_333_333n]);
  });

  test("single caller: root is the leaf, proof is empty", () => {
    const r = computeEpoch({ ...base, positions: [pos(A, F1, 1, 0, DAY)], pool: 5n * USDG, cap: 10n * USDG });
    expect(r.root).toBe(solidityLeaf(A, 5n * USDG));
    expect(r.allocations[0]!.proof).toEqual([]);
  });

  test("nothing qualifying gives no root", () => {
    expect(computeEpoch({ ...base, positions: [pos(A, A, 1, 0, DAY)], pool: USDG, cap: USDG })).toEqual({
      root: null,
      total: 0n,
      allocations: [],
    });
  });

  const arbPositions = fc.array(
    fc.record({
      caller: fc.integer({ min: 1, max: 8 }).map(addr),
      follower: fc.integer({ min: 1, max: 12 }).map((n) => addr(0x100 + n)),
      notionalUsd: fc.integer({ min: 0, max: 1e9 }).map((cents) => cents / 100),
      open: fc.integer({ min: -48 * 60, max: 7 * DAY * 60 }), // minutes; integers since fc doubles skew tiny
      len: fc.option(fc.integer({ min: 0, max: 10 * DAY * 60 })),
    }),
    { maxLength: 40 },
  );
  // fc.bigInt shrinks toward tiny values; mix whole-dollar amounts with raw base units
  const arbUsdg = fc.oneof(fc.bigInt({ min: 0n, max: 10n ** 12n }), fc.nat(1_000_000).map((n) => BigInt(n) * USDG));

  test("property: sum ≤ pool, each ≤ cap, every proof verifies on the Solidity path", () => {
    let multi = 0;
    fc.assert(
      fc.property(arbPositions, arbUsdg, arbUsdg, (ps, pool, cap) => {
        const positions = ps.map((p) => pos(p.caller, p.follower, p.notionalUsd, p.open / 60, p.len === null ? null : (p.open + p.len) / 60));
        const r = computeEpoch({ ...base, positions, pool, cap });
        if (r.allocations.length > 1) multi++;
        expect(r.total).toBeLessThanOrEqual(pool);
        expect(r.total).toBe(r.allocations.reduce((s, a) => s + a.amount, 0n));
        for (const a of r.allocations) {
          expect(a.amount).toBeLessThanOrEqual(cap);
          expect(a.amount).toBeGreaterThan(0n);
          expect(solidityVerify(a.proof, r.root!, solidityLeaf(a.caller, a.amount))).toBe(true);
        }
        // with no one capped, only flooring dust stays behind
        const w = callerWeights({ ...base, positions });
        if (cap > 0n && w.size && r.allocations.every((a) => a.amount < cap)) expect(pool - r.total).toBeLessThan(BigInt(Math.max(1, w.size)));
      }),
      { numRuns: 300 },
    );
    expect(multi).toBeGreaterThan(50); // the property actually exercised multi-caller trees
  });
});
