import type { ReactNode } from "react";

export type GlyphName =
  | "overview"
  | "compose"
  | "records"
  | "proof"
  | "copy"
  | "accounts"
  | "limits"
  | "replay"
  | "activity"
  | "architecture"
  | "protocol"
  | "signal"
  | "funding"
  | "position"
  | "exit"
  | "expiry"
  | "privacy"
  | "route"
  | "fees"
  | "network";

/** A bespoke 32px instrument-glyph family. Each product concept has its own silhouette. */
const glyphs: Record<GlyphName, ReactNode> = {
  overview: (
    <>
      <path d="M3 13V3h10M19 3h10v10M29 19v10H19M13 29H3V19" />
      <path d="M8 21l5-8 5 4 6-9" />
      <circle cx="24" cy="8" r="2" fill="currentColor" />
    </>
  ),
  compose: (
    <>
      <path d="M4 4h16M4 4v24h24V15M9 10h9M9 16h5" />
      <path d="m15 25 3-8L27 7l4 4-10 10zM24 10l4 4" />
    </>
  ),
  records: (
    <>
      <path d="M7 3h19v26H7M3 8h7M3 16h7M3 24h7M12 9h9M12 15h9M12 21h5" />
      <path d="M23 28v3H10" />
    </>
  ),
  proof: (
    <>
      <path d="M16 2 28 9v14l-12 7-12-7V9zM4 9l12 7 12-7M16 16v14" />
      <path d="m10 13 12-7M9 21l4 2M20 20l4-2" />
    </>
  ),
  copy: (
    <>
      <path d="M3 5h7v7h16M3 19h7v7h16M23 9l4 3-4 3M23 23l4 3-4 3" />
      <circle cx="3" cy="5" r="2" />
      <circle cx="3" cy="19" r="2" />
      <path d="M16 12v7" strokeDasharray="2 3" />
    </>
  ),
  accounts: (
    <>
      <path d="M3 8h10v16H3zM19 3h10v16H19zM7 12h2M7 20h2M23 7h2M23 15h2M13 16h6M24 23v6H8v-1" />
      <circle cx="24" cy="24" r="2" fill="currentColor" />
    </>
  ),
  limits: (
    <>
      <path d="M5 3v26M16 3v26M27 3v26" />
      <path
        d="M1 8h8v5H1zM12 19h8v5h-8zM23 9h8v5h-8z"
        fill="var(--glyph-fill, #121313)"
      />
    </>
  ),
  replay: (
    <>
      <path d="M3 3v25h27M8 23V8h19v15M8 13h19M8 18h19" />
      <path d="m10 21 5-6 4 2 6-8" strokeWidth="1.7" />
      <path d="M14 4h10M17 1l-3 3 3 3" />
      <circle cx="25" cy="9" r="2" fill="currentColor" stroke="none" />
    </>
  ),
  activity: (
    <>
      <path d="M2 17h5l4-10 5 20 5-15 4 5h5" />
      <path d="M2 3h5M25 3h5M2 29h5M25 29h5" />
    </>
  ),
  architecture: (
    <>
      <path d="M12 2h8v7h-8zM2 23h8v7H2zM22 23h8v7h-8zM16 9v7M6 23v-7h20v7" />
      <circle cx="16" cy="16" r="2" fill="currentColor" />
    </>
  ),
  protocol: (
    <>
      <path d="M2 4h8v8H2zM22 20h8v8h-8zM6 12v12h16M10 8h16v12" />
      <path d="m13 5 3 3-3 3M15 21l3 3-3 3" />
    </>
  ),
  signal: (
    <>
      <path d="M3 26h26M5 22V12M12 22V6M19 22v-7M26 22V3" />
      <circle cx="5" cy="10" r="2" />
      <circle cx="19" cy="13" r="2" />
    </>
  ),
  funding: (
    <>
      <circle cx="16" cy="16" r="12" />
      <path d="M16 7v18M21 10h-8a4 4 0 0 0 0 7h6a3 3 0 0 1 0 6h-8M26 3l3 3M3 26l3 3" />
    </>
  ),
  position: (
    <>
      <path d="M3 28h26M6 21V9M11 27V3M20 23V7M25 19V2" />
      <path d="M3 11h6v7H3zM17 9h6v11h-6z" fill="var(--glyph-fill,#121313)" />
    </>
  ),
  exit: (
    <>
      <path d="M15 4H4v24h11M10 16h19M22 9l7 7-7 7" />
      <path d="M11 2v4M11 26v4" />
    </>
  ),
  expiry: (
    <>
      <path d="M6 3h20M6 29h20M9 3v7l7 6 7-6V3M9 29v-7l7-6 7 6v7" />
      <path d="M12 25h8M12 7h8" />
    </>
  ),
  privacy: (
    <>
      <path d="m16 2 12 5v10c0 8-12 13-12 13S4 25 4 17V7zM10 15h12v8H10zM12 15v-3a4 4 0 0 1 8 0v3" />
      <circle cx="16" cy="19" r="1" fill="currentColor" />
    </>
  ),
  route: (
    <>
      <circle cx="6" cy="7" r="4" />
      <circle cx="26" cy="25" r="4" />
      <path d="M10 7h10a6 6 0 0 1 0 12h-8a6 6 0 0 0 0 12M26 13v8M23 18l3 3 3-3" />
    </>
  ),
  fees: (
    <>
      <path d="M5 2h22v28l-4-3-4 3-4-3-4 3-6-3zM10 8h12M10 13h5M11 23l10-7" />
      <circle cx="11" cy="17" r="1.5" />
      <circle cx="21" cy="22" r="1.5" />
    </>
  ),
  network: (
    <>
      <path d="m16 3 12 7v13l-12 7-12-7V10zM4 10h24M4 23h24M16 3c-8 7-8 20 0 27M16 3c8 7 8 20 0 27" />
    </>
  ),
};
export function Glyph({
  name,
  size = 28,
  className = "",
}: {
  name: GlyphName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={`proviso-glyph ${className}`}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinejoin="miter"
      strokeLinecap="square"
      aria-hidden="true"
    >
      {glyphs[name]}
    </svg>
  );
}
