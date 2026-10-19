// Link heuristics and records weights (Backend §6). Flags only: nothing here blocks a
// trade; flagged followers are excluded from the caller's shares.

export type Transfer = { from: string; to: string; usd: number; time: number };
export type Fill = { account: string; coin: string; isBuy: boolean; time: number; viaProviso?: boolean };
export type Pair = { caller: string; follower: string };
export type LinkReason = "direct_transfer" | "shared_funder" | "timing";
export type LinkFlag = { a: string; b: string; reason: LinkReason; score: number };

export const MIN_HOLD_MS = 30 * 60_000;
export const EXCLUDE_SCORE = 0.5;
const DAY_MS = 86_400_000;

export function linkFlags(
  transfers: Transfer[],
  fills: Fill[],
  pairs: Pair[],
  opts: { windowSec?: number; ignoreFunders?: Iterable<string> } = {},
): LinkFlag[] {
  const lc = (s: string) => s.toLowerCase();
  const windowMs = (opts.windowSec ?? 60) * 1000;
  const ignore = new Set([...(opts.ignoreFunders ?? [])].map(lc)); // bridges and exchange hot wallets
  const funders = new Map<string, Set<string>>();
  for (const t of transfers) {
    const to = lc(t.to);
    if (!funders.has(to)) funders.set(to, new Set());
    if (!ignore.has(lc(t.from))) funders.get(to)!.add(lc(t.from));
  }
  const flags: LinkFlag[] = [];
  for (const { caller, follower } of pairs) {
    const a = lc(caller), b = lc(follower);
    if (transfers.some((t) => (lc(t.from) === a && lc(t.to) === b) || (lc(t.from) === b && lc(t.to) === a)))
      flags.push({ a, b, reason: "direct_transfer", score: 1 });
    const fa = funders.get(a) ?? new Set<string>();
    if ([...(funders.get(b) ?? [])].some((x) => x !== a && x !== b && fa.has(x)))
      flags.push({ a, b, reason: "shared_funder", score: 0.6 });
    // Follower trades of their own, same coin and side, shortly before the caller's: front-running.
    // Proviso's own wave-1 copies precede the caller by design and are excluded.
    const theirs = fills.filter((f) => lc(f.account) === b && !f.viaProviso);
    const hits = fills.filter((c) => lc(c.account) === a && theirs.some((f) =>
      f.coin === c.coin && f.isBuy === c.isBuy && f.time < c.time && c.time - f.time <= windowMs)).length;
    // ponytail: linear count score, swap for a base-rate-adjusted test if false positives bite
    if (hits > 0) flags.push({ a, b, reason: "timing", score: Math.min(1, hits / 4) });
  }
  return flags;
}

/** Money × days; holds under 30 minutes count zero. */
export const holdWeight = (notionalUsd: number, openedAt: number, closedAt: number) =>
  closedAt - openedAt < MIN_HOLD_MS ? 0 : (notionalUsd * (closedAt - openedAt)) / DAY_MS;

export type Hold = { follower: string; notionalUsd: number; openedAt: number; closedAt: number };

/** Summed weight per follower for one caller, without followers flagged against that caller. */
export function followerWeights(caller: string, holds: Hold[], flags: LinkFlag[], minScore = EXCLUDE_SCORE) {
  const c = caller.toLowerCase();
  const excluded = new Set(
    flags.filter((f) => f.score >= minScore && (f.a === c || f.b === c)).map((f) => (f.a === c ? f.b : f.a)),
  );
  const out = new Map<string, number>();
  for (const h of holds) {
    const k = h.follower.toLowerCase();
    if (excluded.has(k)) continue;
    out.set(k, (out.get(k) ?? 0) + holdWeight(h.notionalUsd, h.openedAt, h.closedAt));
  }
  return out;
}
