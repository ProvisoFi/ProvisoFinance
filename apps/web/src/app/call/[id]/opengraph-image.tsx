// The share card X and Telegram show for a call link (TU-13). Public facts only.
import { ImageResponse } from "next/og";
import { callStatus, shortAddr } from "@/lib/proviso/call";
import { getCall } from "@/lib/server/call";

export const alt = "A sealed call on Proviso";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const revalidate = 60;

const day = (d: string | Date) =>
  new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** The card: state and status line, call number, caller, seal date, and the promise. */
export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await getCall(id);
  const s = c ? callStatus(c) : { label: "NOT FOUND", line: "No sealed call with this number" };
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "64px 72px",
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
          <div style={{ display: "flex", fontSize: 20, letterSpacing: 6, color: "#8a8a8a" }}>
            SEALED CALL #{c?.id ?? id}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <div
            style={{
              display: "flex",
              alignSelf: "flex-start",
              padding: "8px 18px",
              border: "2px solid #ededed",
              borderRadius: 999,
              fontSize: 22,
              letterSpacing: 5,
            }}
          >
            {s.label}
          </div>
          <div style={{ display: "flex", fontSize: 66, lineHeight: 1.05, letterSpacing: -3, maxWidth: 1000 }}>{s.line}</div>
          <div style={{ display: "flex", fontSize: 28, color: "#9b9b9b", maxWidth: 980, lineHeight: 1.35 }}>
            Sealed on-chain before it could fire. Private until it does. Nobody can edit it.
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 22, color: "#8a8a8a", letterSpacing: 2 }}>
          <div style={{ display: "flex" }}>
            {c ? `${shortAddr(c.owner)} · sealed ${day(c.stampedAt)}` : ""}
          </div>
          <div style={{ display: "flex" }}>provisofi.com</div>
        </div>
      </div>
    ),
    size,
  );
}
