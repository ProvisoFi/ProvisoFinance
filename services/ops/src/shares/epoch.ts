// Caller shares per epoch (Backend §8). Pure: positions in, allocations + Merkle proofs out.
// Leaves match CallerShare.claim: keccak256(bytes.concat(keccak256(abi.encode(caller, amount)))).
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { isAddress, type Address, type Hex } from "viem";

export const MIN_HOLD_MS = 30 * 60_000;
export const SHARE_ENCODING = ["address", "uint256"];

export type FollowerPosition = {
  caller: string;
  follower: string;
  notionalUsd: number;
  openedAt: Date;
  closedAt: Date | null; // null = still open; held until the epoch end
};

export type EpochInput = {
  positions: FollowerPosition[];
  linkFlags: Iterable<{ a: string; b: string }>; // linked pairs; a follower linked to its caller doesn't count
  excluded: Iterable<string>; // geofenced addresses: neither earn as callers nor count as followers
  pool: bigint; // USDG base units (6 decimals)
  cap: bigint; // max per caller per epoch, base units
  start: Date;
  end: Date;
};

export type CallerAllocation = { caller: Address; weight: bigint; amount: bigint; proof: Hex[] };
export type EpochResult = { root: Hex | null; total: bigint; allocations: CallerAllocation[] };

const lc = (a: string) => a.toLowerCase();
const pairKey = (a: string, b: string) => [lc(a), lc(b)].sort().join(":");

/**
 * Qualifying weight per caller: notional (cents) × milliseconds held inside [start, end), for holds
 * of at least 30 minutes (whole hold, open positions measured to `end`).
 */
export function callerWeights(input: Omit<EpochInput, "pool" | "cap">): Map<Address, bigint> {
  const links = new Set([...input.linkFlags].map((f) => pairKey(f.a, f.b)));
  const excluded = new Set([...input.excluded].map(lc));
  const start = input.start.getTime();
  const end = input.end.getTime();
  const weights = new Map<Address, bigint>();
  for (const p of input.positions) {
    const caller = lc(p.caller) as Address;
    const follower = lc(p.follower);
    if (!isAddress(caller, { strict: false })) throw new Error(`Bad caller address ${p.caller}`);
    if (!Number.isFinite(p.notionalUsd) || p.notionalUsd < 0) throw new Error(`Bad notional ${p.notionalUsd}`);
    if (caller === follower || excluded.has(caller) || excluded.has(follower) || links.has(pairKey(caller, follower)))
      continue;
    const opened = p.openedAt.getTime();
    const closed = p.closedAt?.getTime() ?? end;
    if (closed - opened < MIN_HOLD_MS) continue;
    const held = Math.min(closed, end) - Math.max(opened, start);
    if (held <= 0) continue;
    const w = BigInt(Math.round(p.notionalUsd * 100)) * BigInt(held);
    if (w > 0n) weights.set(caller, (weights.get(caller) ?? 0n) + w);
  }
  return weights;
}

/**
 * pool × weight share per caller, floored, capped at `cap`; what capped callers can't take is
 * re-split pro rata among the rest until no one exceeds the cap. Sum never exceeds the pool;
 * flooring dust (< 1 base unit per caller) stays unallocated.
 */
export function allocate(weights: Map<Address, bigint>, pool: bigint, cap: bigint): Map<Address, bigint> {
  if (pool < 0n || cap < 0n) throw new Error("pool and cap must be non-negative");
  const out = new Map<Address, bigint>();
  let active = [...weights].filter(([, w]) => w > 0n);
  let remaining = pool;
  while (active.length) {
    const total = active.reduce((s, [, w]) => s + w, 0n);
    const over = active.filter(([, w]) => (remaining * w) / total > cap);
    if (!over.length) {
      for (const [c, w] of active) out.set(c, (remaining * w) / total);
      break;
    }
    for (const [c] of over) out.set(c, cap);
    remaining -= cap * BigInt(over.length); // stays >= 0: each capped share was > cap
    active = active.filter(([c]) => !out.has(c));
  }
  return out;
}

/** Full epoch: weights → allocations → StandardMerkleTree ["address","uint256"] with per-caller proofs. */
export function computeEpoch(input: EpochInput): EpochResult {
  const weights = callerWeights(input);
  const amounts = [...allocate(weights, input.pool, input.cap)].filter(([, a]) => a > 0n);
  if (!amounts.length) return { root: null, total: 0n, allocations: [] };
  const tree = StandardMerkleTree.of(amounts, SHARE_ENCODING);
  const allocations = amounts
    .map(([caller, amount]) => ({
      caller,
      weight: weights.get(caller)!,
      amount,
      proof: tree.getProof([caller, amount]) as Hex[],
    }))
    .sort((x, y) => (x.caller < y.caller ? -1 : 1));
  return { root: tree.root as Hex, total: amounts.reduce((s, [, a]) => s + a, 0n), allocations };
}

/** Same check CallerShare.claim does, for tests and the claim UI. */
export const verifyShare = (root: Hex, caller: Address, amount: bigint, proof: Hex[]) =>
  StandardMerkleTree.verify(root, SHARE_ENCODING, [caller, amount], proof);
