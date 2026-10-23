// Caller standing (expansion #9): the qualification ladder and a risk-adjusted score, built only from
// the public record (sealed calls, their P&L stamps, the caller's filled size). Every sealed call counts
// toward the ladder, paper included (Dry Run). The score is on live calls once any live call has a P&L,
// otherwise on paper calls, labelled by `basis`; the two are never blended.

/** A caller is followable after this many sealed calls over this many days, within this drawdown. */
export const LADDER = { minCalls: 20, minDays: 30, maxDrawdownPct: 25 } as const;
/** Score = return / max(drawdown, floor): a caller who never drew down can't divide by ~0. */
const DRAWDOWN_FLOOR_PCT = 5;

export type StandingCall = { stampedAt: Date; pnlUsd: number | null; sizeUsd: number; mode?: string };

export type Standing = {
  sealedCalls: number;
  daysActive: number;
  scoredCalls: number;
  /** Sum of per-call returns (P&L / caller's filled notional), in percent. */
  returnPct: number;
  /** Largest fall of that running sum from its peak, in percentage points. */
  maxDrawdownPct: number;
  /** returnPct / max(maxDrawdownPct, 5); null before any scored call. */
  score: number | null;
  /** Which calls the score is on: live once any live call has a P&L, else paper; null before any. */
  basis: "live" | "paper" | null;
  checks: { calls: boolean; days: boolean; drawdown: boolean };
  followable: boolean;
};

export function standing(calls: readonly StandingCall[], now = Date.now()): Standing {
  const first = calls.reduce((m, c) => Math.min(m, c.stampedAt.getTime()), Infinity);
  const daysActive = Number.isFinite(first) ? Math.max(0, Math.floor((now - first) / 86_400_000)) : 0;
  const withPnl = calls.filter((c) => c.pnlUsd != null && Number.isFinite(c.pnlUsd) && c.sizeUsd > 0);
  const live = withPnl.filter((c) => c.mode !== "paper");
  const basis = live.length ? "live" : withPnl.length ? "paper" : null;
  const scored = (live.length ? live : withPnl).sort((a, b) => a.stampedAt.getTime() - b.stampedAt.getTime());
  let equity = 0, peak = 0, maxDrawdownPct = 0;
  for (const c of scored) {
    equity += (c.pnlUsd! / c.sizeUsd) * 100;
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak - equity);
  }
  const checks = {
    calls: calls.length >= LADDER.minCalls,
    days: daysActive >= LADDER.minDays,
    drawdown: maxDrawdownPct <= LADDER.maxDrawdownPct,
  };
  return {
    sealedCalls: calls.length,
    daysActive,
    scoredCalls: scored.length,
    returnPct: equity,
    maxDrawdownPct,
    score: scored.length ? equity / Math.max(maxDrawdownPct, DRAWDOWN_FLOOR_PCT) : null,
    basis,
    checks,
    followable: checks.calls && checks.days && checks.drawdown,
  };
}

/** Leaderboard order: followable callers first, then by score (unscored last), then by sealed calls. */
export const byStanding = (a: Standing, b: Standing) =>
  Number(b.followable) - Number(a.followable) ||
  (b.score ?? -Infinity) - (a.score ?? -Infinity) ||
  b.sealedCalls - a.sealedCalls;
