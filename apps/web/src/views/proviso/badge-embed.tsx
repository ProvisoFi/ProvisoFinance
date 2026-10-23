"use client";
// Copy-paste embed code for a caller's live record badge (HTML for sites and Substack, Markdown for READMEs).
import { useState } from "react";

export function BadgeEmbed({ profile, badge, who }: { profile: string; badge: string; who: string }) {
  const [copied, setCopied] = useState("");
  const alt = `Proviso sealed record: ${who}`.replace(/"/g, "");
  const codes: [string, string][] = [
    ["HTML", `<a href="${profile}"><img src="${badge}" alt="${alt}" width="360" height="64"></a>`],
    ["Markdown", `[![${alt}](${badge})](${profile})`],
  ];
  return (
    <section className="badge-embed" aria-label="Record badge">
      <span className="call-eyebrow">LIVE RECORD BADGE</span>
      {/* eslint-disable-next-line @next/next/no-img-element -- a live SVG from this site */}
      <img src={new URL(badge).pathname} alt={alt} width={360} height={64} />
      <p>Put it in a bio, a Substack or a README. It updates on its own and links here, where every call checks itself.</p>
      {codes.map(([label, code]) => (
        <div key={label} className="badge-code">
          <code>{code}</code>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(code).then(() => setCopied(label));
            }}
          >
            {copied === label ? "Copied" : `Copy ${label}`}
          </button>
        </div>
      ))}
    </section>
  );
}
