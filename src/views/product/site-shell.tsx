"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Children, useState, useEffect, type ReactNode } from "react";
import { Mark, Icon, Socials } from "@/views/proviso/shared";
import { PageMotion } from "@/views/proviso/page-motion";
import { Glyph, type GlyphName } from "@/views/proviso/glyph";

export const productLinks: [string, string, string, GlyphName][] = [
  ["/protocol/", "The protocol", "The complete thesis lifecycle", "protocol"],
  ["/proof-of-call/", "Proof of Call", "Commitment and disclosure", "proof"],
  ["/fair-copy/", "Fair Copy", "The follower-first sequence", "copy"],
  ["/execution/", "Execution", "Signals, checks, and order flow", "position"],
  [
    "/security/",
    "Self-custody",
    "Your accounts, limited permissions",
    "privacy",
  ],
  ["/testing/", "Strategy testing", "A reproducible view of history", "replay"],
  ["/integrations/", "Integrations", "Venues and data dependencies", "network"],
  ["/records/", "The record", "Every call, in context", "records"],
];
export function SiteNav({ dark = false }: { dark?: boolean }) {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [progress, setProgress] = useState(0);
  const path = usePathname();
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setScrolled(window.scrollY > 32);
        const height =
          document.documentElement.scrollHeight - window.innerHeight;
        setProgress(height > 0 ? Math.min(1, window.scrollY / height) : 0);
      });
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [path]);
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", f);
    return () => document.removeEventListener("keydown", f);
  }, []);
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header
        className={`p-nav ${dark ? "dark" : ""} ${scrolled ? "is-scrolled" : ""} ${open ? "menu-is-open" : ""}`}
      >
        <span
          className="p-scroll-progress"
          style={{ transform: `scaleX(${progress})` }}
          aria-hidden="true"
        />
        <Link href="/" className="brand" aria-label="Proviso home">
          <Mark />
          <span>Proviso</span>
        </Link>
        <nav aria-label="Main navigation">
          <button
            aria-expanded={open}
            aria-controls="product-menu"
            onClick={() => setOpen(!open)}
          >
            Explore Proviso <Icon name="chevron" size={13} />
          </button>
          <Link href="/docs/">Documentation</Link>
          <Link href="/docs/architecture/">Architecture</Link>
        </nav>
        <div className="p-nav-end">
          <div className="p-nav-social">
            <Socials />
          </div>
          <Link className="button small" href="/dashboard/">
            Open workspace <Icon name="diagonal" size={15} />
          </Link>
          <button
            className="p-mobile-menu"
            aria-label={open ? "Close site menu" : "Open site menu"}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <Icon name={open ? "close" : "menu"} />
          </button>
        </div>
        {open && (
          <div id="product-menu" className="p-mega-menu">
            <div className="p-menu-intro">
              <span className="eyebrow">INSIDE PROVISO</span>
              <h3>
                Every clause.
                <br />A clearer picture.
              </h3>
              <p>
                Explore the product, its principles, and the systems behind it.
              </p>
            </div>
            <div className="p-menu-links">
              {productLinks.map(([href, title, sub, icon]) => (
                <Link href={href} key={href}>
                  <Glyph name={icon} size={25} />
                  <span>
                    <strong>{title}</strong>
                    <small>{sub}</small>
                  </span>
                  <Icon name="diagonal" size={13} />
                </Link>
              ))}
            </div>
            <div className="p-mobile-docs">
              <Link href="/docs/">Documentation</Link>
              <Link href="/docs/architecture/">Architecture</Link>
              <Socials />
            </div>
          </div>
        )}
      </header>
      {open && (
        <button
          aria-label="Close navigation overlay"
          className="p-menu-overlay"
          onClick={() => setOpen(false)}
        />
      )}
    </>
  );
}
export function SiteFooter() {
  return (
    <footer className="p-footer">
      <div className="p-footer-top">
        <div>
          <span className="eyebrow">THE NEXT CALL IS YOURS.</span>
          <h2>
            Give conviction
            <br />a place on the record.
          </h2>
          <Link href="/dashboard/" className="button light">
            Enter the workspace <Icon name="diagonal" size={17} />
          </Link>
        </div>
        <div className="p-footer-links">
          <div>
            <span className="eyebrow">THE PRODUCT</span>
            {productLinks.slice(0, 4).map(([href, label]) => (
              <Link key={href} href={href}>
                {label}
              </Link>
            ))}
          </div>
          <div>
            <span className="eyebrow">THE DETAILS</span>
            {productLinks.slice(4).map(([href, label]) => (
              <Link key={href} href={href}>
                {label}
              </Link>
            ))}
          </div>
          <div>
            <span className="eyebrow">RESOURCES</span>
            <Link href="/docs/">Documentation</Link>
            <Link href="/docs/architecture/">Architecture</Link>
            <Link href="/legal/terms/">Terms</Link>
            <Link href="/legal/privacy/">Privacy</Link>
            <Link href="/legal/risk/">Risk disclosure</Link>
          </div>
        </div>
      </div>
      <div className="p-footer-bottom">
        <Link href="/" className="brand">
          <Mark />
          <span>Proviso</span>
        </Link>
        <span>© 2026 Proviso</span>
        <p>Write with intent. Act within limits. Keep the record.</p>
        <Socials />
      </div>
    </footer>
  );
}
export function ProductShell({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`product-page ${className}`}>
      <SiteNav />
      <PageMotion />
      <main id="main">
        {Children.toArray(children)[0]}
        <ChapterNav />
        {Children.toArray(children).slice(1)}
      </main>
      <SiteFooter />
    </div>
  );
}
export function ProductHero({
  index,
  kicker,
  title,
  description,
  children,
  dark = false,
}: {
  index: string;
  kicker: string;
  title: ReactNode;
  description: string;
  children?: ReactNode;
  dark?: boolean;
}) {
  return (
    <section className={`p-hero ${dark ? "p-hero-dark" : ""}`}>
      <div className="p-hero-heading">
        <span className="eyebrow">
          {index} / {kicker.toUpperCase()}
        </span>
        <h1>{title}</h1>
        <p>{description}</p>
        <span className="p-design-label">THESIS TRADING / PROVISO</span>
      </div>
      {children}
    </section>
  );
}
export function ProductSection({
  id,
  number,
  label,
  title,
  children,
  className = "",
}: {
  id?: string;
  number: string;
  label: string;
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id || `chapter-${number.toLowerCase()}`}
      data-chapter={label}
      className={`p-section ${className}`}
    >
      <div className="p-section-index">
        <span className="eyebrow">
          {number} / {label.toUpperCase()}
        </span>
        {title && <h2>{title}</h2>}
      </div>
      <div className="p-section-content">{children}</div>
    </section>
  );
}
export function ProductCTA({
  title,
  body,
  href,
  label,
}: {
  title: string;
  body: string;
  href: string;
  label: string;
}) {
  return (
    <div className="p-cta">
      <div>
        <h2>{title}</h2>
        <p>{body}</p>
      </div>
      <Link className="button" href={href}>
        {label}
        <Icon name="diagonal" size={17} />
      </Link>
    </div>
  );
}
function ChapterNav() {
  const path = usePathname();
  const [chapters, setChapters] = useState<{ id: string; label: string }[]>([]);
  const [active, setActive] = useState("");
  useEffect(() => {
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>("[data-chapter]"),
    );
    setChapters(
      nodes.map((el) => ({ id: el.id, label: el.dataset.chapter || "" })),
    );
    const update = () => {
      let current = nodes[0]?.id || "";
      for (const el of nodes)
        if (el.getBoundingClientRect().top <= 210) current = el.id;
      setActive(current);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, [path]);
  if (!chapters.length) return null;
  return (
    <nav className="p-chapter-nav" aria-label="On this page">
      <span>IN THIS CHAPTER</span>
      <div>
        {chapters.map((c, i) => (
          <a
            key={c.id}
            href={`#${c.id}`}
            aria-current={active === c.id ? "location" : undefined}
          >
            <small>{String(i + 1).padStart(2, "0")}</small>
            {c.label}
          </a>
        ))}
      </div>
      <a className="p-chapter-top" href="#main" aria-label="Back to top">
        ↑
      </a>
    </nav>
  );
}
