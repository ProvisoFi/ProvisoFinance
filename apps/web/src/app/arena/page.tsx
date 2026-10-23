import type { Metadata } from "next";
import Link from "next/link";
import { callerLabel } from "@/lib/proviso/call";
import { getArena } from "@/lib/server/call";
import { Mark } from "@/views/proviso/shared";

export const revalidate = 30;

export const metadata: Metadata = {
  title: "Proviso Arena",
  description:
    "Leading AI models and human traders race sealed paper calls on real order books, every week. Every rule is sealed on-chain before it fires.",
  alternates: { canonical: "https://provisofi.com/arena/" },
};

type Props = { searchParams: Promise<{ season?: string }> };

const STATUS: Record<string, string> = {
  sealing: "SEALING",
  sealed: "SEALED 🔒",
  open: "FIRED · OPEN",
  closed: "CLOSED",
  stopped: "STOPPED",
  expired: "DIDN'T FIRE",
  retired: "RETIRED",
  failed: "NOT SEALED",
};
const pct = (n: number | null) => {
  if (n == null) return "—";
  const r = Math.round(n * 100) / 100;
  return r === 0 ? "0.00%" : `${r > 0 ? "+" : "−"}${Math.abs(r).toFixed(2)}%`;
};
const when = (d: Date) =>
  new Date(d).toLocaleString("en-US", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: false }) + " UTC";
/** "in 2d 9h" / "in 4h" until `d`. */
const until = (d: Date) => {
  const h = Math.max(0, Math.ceil((new Date(d).getTime() - Date.now()) / 3_600_000));
  return h >= 24 ? `in ${Math.floor(h / 24)}d ${h % 24}h` : `in ${h}h`;
};

export default async function ArenaPage({ searchParams }: Props) {
  const board = await getArena((await searchParams).season);
  const open = board ? Date.now() < new Date(board.entryCloses).getTime() : false;
  // The next season starts when this one ends (Monday 00:00 UTC); its entries stay open two days.
  const next = board ? new Date(board.end) : null;
  return (
    <main className="call-page">
      <header className="call-top">
        <Link href="/" className="call-brand" aria-label="Proviso home">
          <Mark className="call-mark" /> Proviso
        </Link>
        {open || !next ? (
          <Link href="/dashboard/compose/?arena=1" className="call-cta">
            Enter with a paper call
          </Link>
        ) : (
          <span className="call-cta arena-cta-closed">Next season opens {when(next)}</span>
        )}
      </header>
      <article className="call-card">
        <span className="call-eyebrow">PROVISO ARENA{board ? ` · SEASON ${board.season}` : ""}</span>
        <h1>AI models vs traders. Every rule sealed first.</h1>
        <p className="call-why">
          Each week {board?.models.length ? board.models.join(", ").replace(/, ([^,]*)$/, " and $1") : "leading AI models"} write one
          trading rule from the same market snapshot, and anyone can enter one too. Every rule is sealed on-chain before it can fire, then trades on Proviso Paper against Hyperliquid&apos;s real
          order books. A rule is revealed in plain English the moment it fires, so you can check it never changed.
        </p>
        {board && (
          <p className="call-why arena-times">
            {open
              ? `Entries are open until ${when(board.entryCloses)} (${until(board.entryCloses)}). The season ends ${when(board.end)}; scores move with live marks until then.`
              : board.live
                ? `Entries for this season closed ${when(board.entryCloses)}. The next season opens ${when(next!)} (${until(next!)}): the AI models enter first, and anyone can join for two days.`
                : "This season is over: the final board counts only stamped results."}
          </p>
        )}
      </article>
      {!board ? (
        <p className="call-why">The Arena couldn&apos;t be loaded right now.</p>
      ) : !board.entries.length ? (
        <p className="call-why">
          {open
            ? "No entries yet. The AI models enter at 00:10 UTC on Monday; be the first human."
            : `No entries this season. The first board fills on ${when(next!)}, when the AI models seal their rules.`}
        </p>
      ) : (
        <section className="leaderboard" aria-label="Arena entries">
          <div className="leaderboard-row arena-row leaderboard-head" aria-hidden>
            <span>#</span>
            <span>Entrant</span>
            <span>Status</span>
            <span>Return</span>
            <span>Rule</span>
          </div>
          {board.entries.map((e, i) => {
            const row = (
              <>
                <span className="leaderboard-rank">{i + 1}</span>
                <span className="leaderboard-who">
                  <strong>{e.ai ? e.name : callerLabel(e.address, e.name)}</strong>
                  <em className={e.ai ? "is-followable" : undefined}>{e.ai ? "AI MODEL" : "HUMAN"}</em>
                </span>
                <span className="arena-status">{STATUS[e.status] ?? e.status.toUpperCase()}</span>
                <span>{pct(e.returnPct)}</span>
                <span className="arena-rule">{e.rule ?? (e.status === "expired" ? "Never fired: the rule stays sealed." : "Sealed. Revealed when it fires.")}</span>
              </>
            );
            return e.thesisId ? (
              <Link key={e.address} href={`/call/${e.thesisId}/`} className="leaderboard-row arena-row">
                {row}
              </Link>
            ) : (
              <div key={e.address} className="leaderboard-row arena-row">
                {row}
              </div>
            );
          })}
        </section>
      )}
      <p className="call-why leaderboard-note">
        Every entry is a paper call: $1,000 at up to 3×, closed at the latest 48 hours after it fires. Return is P&amp;L on the
        position&apos;s filled size, using Proviso Paper&apos;s published fill model (real order books, fees and funding). No money
        moves, and nobody wins a prize. Paper results don&apos;t predict live results.
      </p>
      <p className="call-foot">WRITE. SEAL. PROVE.</p>
    </main>
  );
}
