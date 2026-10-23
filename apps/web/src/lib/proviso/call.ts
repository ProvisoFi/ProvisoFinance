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
};

const SITE = (process.env.NEXT_PUBLIC_SITE_URL || "https://provisofi.com").replace(/\/$/, "");

/** The call's public page (also its share-card link). */
export const callUrl = (id: string) => `${SITE}/call/${id}/`;

/** `0x1234…abcd`. */
export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const day = (d: string | Date) =>
  new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** What happened to the call so far, in one line. */
export function callStatus(c: PublicCall): { label: string; line: string } {
  const fired = c.fires.at(-1);
  const mark = fired?.refMark ? ` at $${Number(fired.refMark).toLocaleString("en-US", { maximumFractionDigits: 6 })}` : "";
  const pnl = c.pnlUsd == null ? "" : ` · P&L ${c.pnlUsd >= 0 ? "+" : "−"}$${Math.abs(c.pnlUsd).toFixed(2)}`;
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

/** The post text for sharing a call, by state. */
export function shareText(state: string): string {
  if (state === "live" || state === "alert")
    return "I sealed a call on Proviso before the market moved. 🔒 It stays private until it fires, and nobody can edit it.";
  if (state === "fired" || state === "closed") return "My sealed call fired. Sealed on-chain before it happened. 🔒";
  return "A sealed call on my Proviso record. Every call stays on it, win or not. 🔒";
}

/** X and Telegram share links for a call. */
export function shareLinks(id: string, state: string) {
  const url = callUrl(id);
  const text = shareText(state);
  return {
    x: `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
    telegram: `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`,
    url,
  };
}
