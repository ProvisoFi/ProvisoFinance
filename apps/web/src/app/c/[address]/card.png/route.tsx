// The share card X and Telegram show for a caller's profile link (TU-21). Public record only.
// Served at /c/<address>/card.png: a path with a file extension skips the trailing-slash redirect.
import { ImageResponse } from "next/og";
import { profileStats, shortAddr } from "@/lib/proviso/call";
import { getProfile } from "@/lib/server/call";

const size = { width: 1200, height: 630 };
export const revalidate = 60;

/** The card: caller, headline numbers, and the promise. */
export async function GET(_req: Request, { params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const p = await getProfile(address);
  const s = p ? profileStats(p.ideas) : null;
  const stat = (label: string, value: string) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "18px 26px", border: "1px solid #ffffff2a", borderRadius: 10, minWidth: 190 }}>
      <div style={{ display: "flex", fontSize: 18, letterSpacing: 4, color: "#8a8a8a" }}>{label}</div>
      <div style={{ display: "flex", fontSize: 44, letterSpacing: -1 }}>{value}</div>
    </div>
  );
  const pnl = s?.hasPnl ? `${s.pnlUsd >= 0 ? "+" : "−"}$${Math.abs(s.pnlUsd).toFixed(2)}` : "—";
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "60px 72px",
          background: "radial-gradient(900px 500px at 85% 10%, #1f1f1f, #0a0a0a 70%)",
          color: "#ededed",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 34, letterSpacing: -1 }}>
            <svg width="34" height="37" viewBox="0 0 44 48" fill="#ededed">
              <path d="M2 3h16v7H9v31h9v7H2z" />
              <circle cx="28" cy="18" r="15" />
            </svg>
            Proviso
          </div>
          <div style={{ display: "flex", fontSize: 20, letterSpacing: 6, color: "#8a8a8a" }}>CALLER RECORD</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 22 }}>
            <div style={{ display: "flex", fontSize: 64, letterSpacing: -3 }}>{p ? (p.displayName ?? shortAddr(p.caller)) : "Unknown caller"}</div>
            {p?.displayName ? <div style={{ display: "flex", fontSize: 26, color: "#8a8a8a", letterSpacing: 1 }}>{shortAddr(p.caller)}</div> : null}
          </div>
          <div style={{ display: "flex", fontSize: 28, color: "#9b9b9b" }}>
            Every call sealed on-chain before it fired. Nothing deleted, nothing edited.
          </div>
        </div>
        <div style={{ display: "flex", gap: 18 }}>
          {stat("CALLS", String(s?.total ?? 0))}
          {stat("FIRED", String(s?.fired ?? 0))}
          {stat("WIN RATE", s?.winRate == null ? "—" : `${Math.round(s.winRate * 100)}%`)}
          {stat("P&L", pnl)}
        </div>
      </div>
    ),
    { ...size, headers: { "cache-control": "public, max-age=60, s-maxage=60" } },
  );
}
