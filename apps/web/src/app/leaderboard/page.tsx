import type { Metadata } from "next";
import Link from "next/link";
import { callerLabel, copyLine, standingText } from "@/lib/proviso/call";
import { getLeaderboard } from "@/lib/server/call";
import { Mark } from "@/views/proviso/shared";

export const revalidate = 60;

const pctText = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(Math.round(n * 10) / 10).toFixed(1)}%`;

export const metadata: Metadata = {
  title: "Leaderboard",
  description:
    "Callers ranked by their sealed record: return over drawdown, never raw P&L. Followable only after 20 sealed calls over 30 days.",
  alternates: { canonical: "https://provisofi.com/leaderboard/" },
};

export default async function LeaderboardPage() {
  const board = await getLeaderboard();
  const ladder = board?.ladder;
  return (
    <main className="call-page">
      <header className="call-top">
        <Link href="/" className="call-brand" aria-label="Proviso home">
          <Mark className="call-mark" /> Proviso
        </Link>
        <Link href="/dashboard/compose/" className="call-cta">
          Write your own call
        </Link>
      </header>
      <article className="call-card">
        <span className="call-eyebrow">LEADERBOARD</span>
        <h1>Ranked by risk, not by luck.</h1>
        <p className="call-why">
          Every caller below sealed their calls on-chain before they fired. The score is the summed return of their closed live
          calls over their worst drawdown, so one lucky trade can&apos;t top the board. Callers with no live result yet are
          scored on their paper calls, marked (paper); the two are never mixed.
          {ladder &&
            ` A caller becomes followable after ${ladder.minCalls} sealed calls over ${ladder.minDays} days, with drawdown under ${ladder.maxDrawdownPct} points.`}
        </p>
      </article>
      {!board ? (
        <p className="call-why">The leaderboard couldn&apos;t be loaded right now.</p>
      ) : !board.callers.length ? (
        <p className="call-why">No sealed calls yet.</p>
      ) : (
        <section className="leaderboard" aria-label="Callers">
          <div className="leaderboard-row leaderboard-head" aria-hidden>
            <span>#</span>
            <span>Caller</span>
            <span>Score</span>
            <span>Return</span>
            <span>Drawdown</span>
            <span>Followers made</span>
            <span>Record</span>
          </div>
          {board.callers.map((c, i) => {
            const t = standingText(c.standing, board.ladder);
            return (
              <Link key={c.caller} href={`/c/${c.caller}/`} className="leaderboard-row">
                <span className="leaderboard-rank">{i + 1}</span>
                <span className="leaderboard-who">
                  <strong>{callerLabel(c.caller, c.displayName)}</strong>
                  <em className={c.standing.followable ? "is-followable" : undefined}>{t.badge}</em>
                </span>
                <span>{t.scoreText}</span>
                <span>{t.returnText}</span>
                <span>{t.drawdownText}</span>
                <span>{c.copy ? pctText(c.copy.followerReturnPct) : "—"}</span>
                <span className="leaderboard-ladder">{t.ladder.slice(0, 2).join(" · ")}</span>
              </Link>
            );
          })}
        </section>
      )}
      {board && board.byFollowers.length > 0 && (
        <section className="leaderboard leaderboard-copy" aria-label="Ranked by what followers made">
          <span className="call-eyebrow">RANKED BY WHAT FOLLOWERS MADE</span>
          {board.byFollowers.map((c, i) => (
            <Link key={c.caller} href={`/c/${c.caller}/`} className="leaderboard-row leaderboard-copy-row">
              <span className="leaderboard-rank">{i + 1}</span>
              <span className="leaderboard-who">
                <strong>{callerLabel(c.caller, c.displayName)}</strong>
              </span>
              <span>{copyLine(c.copy!)}</span>
            </Link>
          ))}
        </section>
      )}
      <p className="call-why leaderboard-note">
        Returns are per call: P&amp;L over the caller&apos;s own filled size, from Proviso&apos;s stamps. Alerts count toward the record
        but carry no P&amp;L. Followers made: their price P&amp;L on closed size, before fees, from the stamped fills of the calls they
        copied (Proviso fills followers before the caller). Past calls don&apos;t predict future ones.
      </p>
      <p className="call-foot">WRITE. SEAL. PROVE.</p>
    </main>
  );
}
