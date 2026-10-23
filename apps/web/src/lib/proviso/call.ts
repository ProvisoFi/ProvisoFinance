// Share cards for sealed calls (TU-13): the public link, its one-line status, and the share text.
// Public facts only: never the sealed levels.

/** The public facts records.call returns (dates as ISO strings once they cross to the browser). */
export type PublicCall = {
  id: string;
  owner: string;
  mode: string;
  state: string;
  stampedAt: string | Date;
  expiresAt: string | Date;
  sealTx: string | null;
  fires: { at: string | Date; refMark: string | null }[];
  revealKind: string | null;
  revealTx: string | null;
  pnlUsd: number | null;
  /** The caller's optional profile name (unverified: always shown with the address). */
  ownerName?: string | null;
};

const SITE = (process.env.NEXT_PUBLIC_SITE_URL || "https://provisofi.com").replace(/\/$/, "");

/** The call's public page (also its share-card link). */
export const callUrl = (id: string) => `${SITE}/call/${id}/`;

/** `0x1234…abcd`. */
export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** "name · 0x1234…abcd", or just the short address without a name. */
export const callerLabel = (address: string, name?: string | null) => (name ? `${name} · ${shortAddr(address)}` : shortAddr(address));

const day = (d: string | Date) =>
  new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** What happened to the call so far, in one line. */
export function callStatus(c: PublicCall): { label: string; line: string } {
  const fired = c.fires.at(-1);
  const px = Number(fired?.refMark);
  const mark = fired?.refMark && Number.isFinite(px) ? ` at $${px.toLocaleString("en-US", { maximumFractionDigits: px >= 1 ? 2 : 6 })}` : "";
  const pnl = c.pnlUsd == null ? "" : ` · P&L ${c.pnlUsd >= 0 ? "+" : "−"}$${Math.abs(c.pnlUsd).toFixed(2)}`;
  if (c.mode === "paper") {
    const s = callStatus({ ...c, mode: "live" });
    return { label: `PAPER · ${s.label}`, line: s.line.replace("P&L", "simulated P&L") };
  }
  switch (c.state) {
    case "live":
    case "alert":
      return { label: "SEALED", line: `Waiting for its conditions until ${day(c.expiresAt)}` };
    case "fired":
      return { label: "FIRED", line: `Fired ${fired ? day(fired.at) : ""}${mark}`.trim() };
    case "closed":
      return { label: "CLOSED", line: `Fired${mark}, then closed${pnl}` };
    case "stopped":
      return { label: "STOPPED", line: `Stopped by its caller${pnl}` };
    case "expired":
      return { label: "EXPIRED", line: `Expired ${day(c.expiresAt)} without firing` };
    case "retired":
      return { label: "RETIRED", line: "Retired by its caller before it fired" };
    default:
      return { label: c.state.toUpperCase(), line: "" };
  }
}

/** The post text for sharing a call, by state (paper calls say so). */
export function shareText(state: string, mode?: string): string {
  if (mode === "paper")
    return "A paper call on my Proviso record: sealed on-chain before it fired, simulated on real order books. No money moved. 🔒";
  if (state === "live" || state === "alert")
    return "I sealed a call on Proviso before the market moved. 🔒 It stays private until it fires, and nobody can edit it.";
  if (state === "fired" || state === "closed") return "My sealed call fired. Sealed on-chain before it happened. 🔒";
  return "A sealed call on my Proviso record. Every call stays on it, win or not. 🔒";
}

/** X and Telegram share links for a call. */
export function shareLinks(id: string, state: string, mode?: string) {
  const url = callUrl(id);
  const text = shareText(state, mode);
  return {
    x: `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
    telegram: `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`,
    url,
  };
}

// --- caller profiles (TU-21) ---

/** One idea as records.get returns it (only what the profile shows). */
export type ProfileIdea = PublicCall & { stampCount: number };

/** A caller's public profile page. */
export const profileUrl = (address: string) => `${SITE}/c/${address.toLowerCase()}/`;

/** Headline numbers for a caller, from their public record. Win rate counts only calls with a P&L. */
export function profileStats(ideas: readonly ProfileIdea[]) {
  const count = (states: string[]) => ideas.filter((i) => states.includes(i.state)).length;
  const withPnl = ideas.filter((i) => i.pnlUsd != null);
  const wins = withPnl.filter((i) => i.pnlUsd! > 0).length;
  const firstSealed = ideas.reduce<number | null>((m, i) => {
    const t = new Date(i.stampedAt).getTime();
    return m == null || t < m ? t : m;
  }, null);
  return {
    total: ideas.length,
    waiting: count(["live", "alert"]),
    fired: ideas.filter((i) => i.fires.length > 0).length,
    closed: count(["closed", "stopped"]),
    expired: count(["expired"]),
    retired: count(["retired"]),
    pnlUsd: withPnl.reduce((s, i) => s + i.pnlUsd!, 0),
    hasPnl: withPnl.length > 0,
    wins,
    losses: withPnl.length - wins,
    winRate: withPnl.length ? wins / withPnl.length : null,
    since: firstSealed == null ? null : new Date(firstSealed).toISOString(),
  };
}

/** X and Telegram share links for a caller's profile. */
export function profileShareLinks(address: string, total: number) {
  const url = profileUrl(address);

  const text = `My trading calls, sealed on-chain before they fired. ${total} call${total === 1 ? "" : "s"}, wins and losses, nothing deleted. 🔒`;
  return {
    x: `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
    telegram: `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`,
    url,
  };
}

type StandingView = {
  sealedCalls: number;
  daysActive: number;
  scoredCalls: number;
  returnPct: number;
  maxDrawdownPct: number;
  score: number | null;
  basis?: "live" | "paper" | null;
  checks: { calls: boolean; days: boolean; drawdown: boolean };
  followable: boolean;
};
type Ladder = { minCalls: number; minDays: number; maxDrawdownPct: number };
/** Rounded first, so a tiny loss reads "0.0%" rather than "−0.0%". */
const pct = (n: number) => {
  const r = Math.round(n * 10) / 10;
  return r === 0 ? "0.0%" : `${r > 0 ? "+" : "−"}${Math.abs(r).toFixed(1)}%`;
};
/** Plain-language standing (expansion #9): ladder progress, return, drawdown and the risk-adjusted score. */
export function standingText(s: StandingView, l: Ladder) {
  return {
    badge: s.followable ? "Followable" : "Building a record",
    ladder: [
      `${Math.min(s.sealedCalls, l.minCalls)}/${l.minCalls} sealed calls`,
      `${Math.min(s.daysActive, l.minDays)}/${l.minDays} days`,
      `drawdown ${s.maxDrawdownPct.toFixed(1)} of ${l.maxDrawdownPct} pts max`,
    ],
    returnText: s.scoredCalls ? pct(s.returnPct) : "—",
    drawdownText: s.scoredCalls ? `${s.maxDrawdownPct.toFixed(1)} pts` : "—",
    scoreText: s.score == null ? "—" : `${(Math.round(s.score * 100) / 100 || 0).toFixed(2)}${s.basis === "paper" ? " (paper)" : ""}`,
  };
}

/** Dry Run nudges on a paper call: profitable first, then 30 and 10 days of record. Null when there's nothing to say. */
export function paperNudge(i: { mode: string; state: string; stampedAt: string | Date; pnlUsd: number | null }, now = Date.now()): string | null {
  if (i.mode !== "paper") return null;
  const days = Math.floor((now - new Date(i.stampedAt).getTime()) / 86_400_000);
  if (i.pnlUsd != null && i.pnlUsd > 0)
    return `This paper call made $${i.pnlUsd.toFixed(2)} on real order books. Seal the same rule live to put it on your record.`;
  if (days >= 30) return "30 days on paper. Live calls are what make you followable: seal your best rule live when you're ready.";
  if (days >= 10) return "10 days on paper. Try a change in Dry Run before you seal the next one.";
  return null;
}
