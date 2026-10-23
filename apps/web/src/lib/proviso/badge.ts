// The live record badge (expansion §6 #8): a small SVG for bios, Substacks and READMEs. It links to
// the caller's profile, where every call checks itself in the visitor's browser.
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export type BadgeFacts = { who: string; calls: number; returnText: string; scoreText: string; followersText?: string | null };

/** 360×64 SVG, dark, monospace. Every value is escaped. */
export function badgeSvg(b: BadgeFacts): string {
  const line = [`${b.calls} sealed call${b.calls === 1 ? "" : "s"}`, `return ${b.returnText}`, `score ${b.scoreText}`, ...(b.followersText ? [`followers ${b.followersText}`] : [])].join(" · ");
  const alt = `Proviso sealed record: ${b.who}, ${line}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="64" viewBox="0 0 360 64" role="img" aria-label="${esc(alt)}">
<title>${esc(alt)}</title>
<rect width="360" height="64" rx="8" fill="#0a0a0a"/><rect x=".5" y=".5" width="359" height="63" rx="7.5" fill="none" stroke="#ffffff33"/>
<g fill="#ededed"><path d="M14 14h7v3h-4v14h4v3h-7z"/><circle cx="26" cy="21" r="6.5"/></g>
<text x="44" y="24" fill="#8a8a8a" font-family="Consolas,Menlo,monospace" font-size="9.5" letter-spacing="1.6">PROVISO · SEALED RECORD</text>
<text x="44" y="40" fill="#ededed" font-family="Inter,Segoe UI,Helvetica,Arial,sans-serif" font-size="13" font-weight="600">${esc(b.who.slice(0, 40))}</text>
<text x="14" y="55" fill="#bdbdbd" font-family="Consolas,Menlo,monospace" font-size="9.5">${esc(line.slice(0, 64))}</text>
</svg>`;
}
