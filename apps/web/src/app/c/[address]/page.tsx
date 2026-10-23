import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { chainConfig } from "@proviso/chain";
import { LADDER } from "@proviso/api/standing";
import { callerLabel, callStatus, copyLine, profileShareLinks, profileStats, profileUrl, shortAddr, standingText } from "@/lib/proviso/call";
import { getProfile } from "@/lib/server/call";
import { Mark } from "@/views/proviso/shared";
import { ShareButtons } from "@/views/workspace/share-call";

export const revalidate = 60;

type Props = { params: Promise<{ address: string }> };

const usd = (n: number) => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toFixed(2)}`;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params;
  const p = await getProfile(address);
  if (!p) return { title: "Caller not found" };
  const s = profileStats(p.ideas.filter((i) => i.mode !== "paper"));
  const title = `${callerLabel(p.caller, p.displayName)} · ${s.total} sealed call${s.total === 1 ? "" : "s"}`;
  const description = `A trading record sealed on ${chainConfig().label} before each call fired: ${s.fired} fired, ${s.closed} closed${s.hasPnl ? `, P&L ${usd(s.pnlUsd)}` : ""}. Nothing deleted, nothing edited.`;
  const card = `${profileUrl(p.caller)}card.png`;
  return {
    title,
    description,
    alternates: { canonical: profileUrl(p.caller) },
    openGraph: { title, description, url: profileUrl(p.caller), type: "profile", images: [{ url: card, width: 1200, height: 630, alt: "A Proviso caller record" }] },
    twitter: { card: "summary_large_image", title, description, images: [card] },
  };
}

export default async function ProfilePage({ params }: Props) {
  const { address } = await params;
  const p = await getProfile(address);
  if (!p) notFound();
  // Paper calls are never blended into the live record (expansion #5): their own line below.
  const s = profileStats(p.ideas.filter((i) => i.mode !== "paper"));
  const paper = profileStats(p.ideas.filter((i) => i.mode === "paper"));
  const stats: [string, string][] = [
    ["Sealed calls", String(s.total)],
    ["Waiting", String(s.waiting)],
    ["Fired", String(s.fired)],
    ["Closed", String(s.closed)],
    ["Expired", String(s.expired)],
    ["Retired", String(s.retired)],
    ["Win rate", s.winRate == null ? "—" : `${Math.round(s.winRate * 100)}% (${s.wins}/${s.wins + s.losses})`],
    ["P&L", s.hasPnl ? usd(s.pnlUsd) : "—"],
    ...(paper.total ? ([["Paper calls", `${paper.total} · simulated P&L ${paper.hasPnl ? usd(paper.pnlUsd) : "—"}`]] as [string, string][]) : []),
  ];
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
        <span className="call-eyebrow">CALLER RECORD</span>
        <h1>
          <span className="call-state">{callerLabel(p.caller, p.displayName)}</span>
          {s.total ? `${s.total} sealed call${s.total === 1 ? "" : "s"}, every one on the record` : "No sealed calls yet"}
        </h1>
        <p className="call-why">
          Each call was sealed on {chainConfig().label} before it could fire. Wins, losses, expiries and retirements all stay
          here: nothing can be deleted or edited, not even by the caller.
          {s.since && ` Calling since ${new Date(s.since).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}.`}
        </p>
        <dl className="call-facts profile-facts">
          {stats.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        {(() => {
          const t = standingText(p.standing, LADDER);
          return (
            <div className="profile-standing">
              <span className="call-eyebrow">STANDING · {t.badge.toUpperCase()}</span>
              <p>
                {p.standing.followable
                  ? "This caller has a long enough record to be followed."
                  : `Callers become followable after ${LADDER.minCalls} sealed calls over ${LADDER.minDays} days with drawdown under ${LADDER.maxDrawdownPct} points.`}{" "}
                {t.ladder.join(" · ")}.
              </p>
              <p>
                Return {t.returnText} · max drawdown {t.drawdownText} · risk-adjusted score {t.scoreText} ·{" "}
                <Link href="/leaderboard/">See the leaderboard</Link>
              </p>
              {p.copy && <p className="profile-copy">{copyLine(p.copy)} Followers are filled before the caller.</p>}
            </div>
          );
        })()}
        <div className="profile-actions">
          <ShareButtons links={profileShareLinks(p.caller, s.total)} openLabel="Open the record card" />
          <Link className="w-button secondary profile-follow" href={`/dashboard/fair-copy/?caller=${p.caller}`}>
            Follow this caller
          </Link>
        </div>
      </article>
      {p.ideas.length > 0 && (
        <section className="profile-calls" aria-label="Sealed calls">
          {p.ideas.map((i) => {
            const st = callStatus(i);
            return (
              <Link key={i.id} href={`/call/${i.id}/`} className="profile-call">
                <span className="call-eyebrow">#{i.id}</span>
                <span className="call-state">{st.label}</span>
                <span className="profile-line">{st.line}</span>
                <span className="profile-date">
                  {new Date(i.stampedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}
                </span>
              </Link>
            );
          })}
        </section>
      )}
      <p className="call-foot">WRITE. SEAL. PROVE.</p>
    </main>
  );
}
