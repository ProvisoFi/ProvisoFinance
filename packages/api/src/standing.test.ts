import { expect, test } from "bun:test";
import { byStanding, LADDER, standing, type StandingCall } from "./standing";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 30);
const call = (daysAgo: number, pnlUsd: number | null = null, sizeUsd = 100): StandingCall => ({ stampedAt: new Date(NOW - daysAgo * DAY), pnlUsd, sizeUsd });

test("the ladder needs 20 sealed calls over 30 days within a 25-point drawdown", () => {
  const ok = Array.from({ length: 20 }, (_, i) => call(40 - i, i % 2 ? 5 : -3));
  expect(standing(ok, NOW)).toMatchObject({ sealedCalls: 20, daysActive: 40, followable: true, checks: { calls: true, days: true, drawdown: true } });
  expect(standing(ok.slice(0, 19), NOW).checks.calls).toBe(false);
  expect(standing(ok.map((c) => ({ ...c, stampedAt: new Date(NOW - 10 * DAY) })), NOW).checks.days).toBe(false);
  const crash = [...ok, call(1, -30)]; // one -30% call after the peak
  expect(standing(crash, NOW).checks.drawdown).toBe(false);
  expect(standing(crash, NOW).followable).toBe(false);
  expect(LADDER).toEqual({ minCalls: 20, minDays: 30, maxDrawdownPct: 25 });
});

test("returns and drawdown come from P&L over filled size; alerts and unfilled calls aren't scored", () => {
  const s = standing([call(5, 10), call(4, -20), call(3, 5, 50), call(2), call(1, 3, 0)], NOW);
  expect(s.scoredCalls).toBe(3);
  expect(s.returnPct).toBeCloseTo(10 - 20 + 10, 9); // +10%, -20%, +10%
  expect(s.maxDrawdownPct).toBeCloseTo(20, 9);
  expect(s.score).toBeCloseTo(0, 9);
  expect(standing([call(1)], NOW).score).toBeNull();
  expect(standing([call(1, 2)], NOW).score).toBeCloseTo(2 / 5, 9); // drawdown floored at 5
  expect(standing([], NOW)).toMatchObject({ sealedCalls: 0, daysActive: 0, score: null, followable: false });
});

test("leaderboard order: followable first, then score, unscored last, then sealed calls", () => {
  const q = Array.from({ length: 20 }, (_, i) => call(40 - i, 1));
  const followable = standing(q, NOW);
  const strong = standing([call(3, 30)], NOW);
  const weak = standing([call(3, 2)], NOW);
  const busy = standing([call(3), call(2), call(1)], NOW);
  const quiet = standing([call(3)], NOW);
  expect([quiet, weak, busy, strong, followable].sort(byStanding)).toEqual([followable, strong, weak, busy, quiet]);
});
