// follows.sealed_allowlist: the one shape the API writes and core reads (P-M1).
// The API used to store `{ coins, sides, maxUsd, maxLev }` while core only read an array, so every
// follow fell back to tap-to-confirm. Both sides now go through `allowEntries`, which also reads old rows.

export type AllowEntry = { coin: string; side: "long" | "short" | "both"; maxUsd: number; maxLev: number };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
const side = (v: unknown) => (v === "long" || v === "short" || v === "both" ? v : undefined);

/** Normalizes a stored allow-list (array of entries, or the old object form) to entries; null when none. */
export function allowEntries(raw: unknown): AllowEntry[] | null {
  if (raw == null || typeof raw !== "object") return null;
  const out: AllowEntry[] = [];
  if (Array.isArray(raw)) {
    for (const e of raw as Record<string, unknown>[]) {
      const s = side(e?.side), maxUsd = num(e?.maxUsd), maxLev = num(e?.maxLev);
      if (typeof e?.coin === "string" && e.coin && s && maxUsd && maxLev) out.push({ coin: e.coin, side: s, maxUsd, maxLev });
    }
  } else {
    const o = raw as { coins?: unknown; sides?: unknown; maxUsd?: unknown; maxLev?: unknown };
    const sides = Array.isArray(o.sides) ? o.sides.filter((s) => s === "long" || s === "short") : [];
    const maxUsd = num(o.maxUsd), maxLev = num(o.maxLev);
    const s = sides.includes("long") && sides.includes("short") ? "both" : (sides[0] as "long" | "short" | undefined);
    if (Array.isArray(o.coins) && s && maxUsd && maxLev)
      for (const coin of o.coins) if (typeof coin === "string" && coin) out.push({ coin, side: s, maxUsd, maxLev });
  }
  return out.length ? out : null;
}
