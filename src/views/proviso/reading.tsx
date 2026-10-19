import Link from "next/link";
import { SiteNav, SiteFooter } from "@/views/product/site-shell";
import { PageMotion } from "@/views/proviso/page-motion";
import data from "@/data/proviso/legal.json";
export function LegalPage({ kind }: { kind: keyof typeof data.pages }) {
  const page = data.pages[kind];
  return (
    <div className="reading-page">
      <SiteNav />
      <PageMotion />
      <main id="main" className="reading-main">
        <div className="reading-head">
          <span className="eyebrow">
            PROVISO / THE DETAILS / 20 OCTOBER 2026
          </span>
          <h1>{page.title}</h1>
          <p>{page.subtitle}</p>
        </div>
        <div className="reading-layout">
          <nav className="reading-nav" aria-label="Legal pages">
            {(
              [
                ["terms", "Terms of use"],
                ["privacy", "Privacy notice"],
                ["risk", "Risk disclosure"],
              ] as const
            ).map(([key, label]) => (
              <Link
                key={key}
                className={kind === key ? "active" : ""}
                href={`/legal/${key}/`}
                aria-current={kind === key ? "page" : undefined}
              >
                {label}
              </Link>
            ))}
            <Link href="/docs/">Documentation ↗</Link>
          </nav>
          <article className="reading-content">
            {page.sections.map((s, i) => (
              <section key={s.heading}>
                <span className="eyebrow muted">0{i + 1}</span>
                <h2>{s.heading}</h2>
                {s.paragraphs.map((p) => (
                  <p key={p}>{p}</p>
                ))}
              </section>
            ))}
            {kind === "risk" && (
              <div className="source-links">
                <span className="eyebrow">
                  FURTHER READING / VENUE DOCUMENTATION
                </span>
                {data.citations
                  .filter((c) => c.id.startsWith("hyperliquid-"))
                  .map((c) => (
                    <a key={c.id} href={c.url} target="_blank" rel="noreferrer">
                      {c.title} ↗
                    </a>
                  ))}
              </div>
            )}
            {kind === "privacy" && (
              <div className="source-links">
                <a
                  href="https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage"
                  target="_blank"
                  rel="noreferrer"
                >
                  About browser local storage ↗
                </a>
              </div>
            )}
          </article>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
