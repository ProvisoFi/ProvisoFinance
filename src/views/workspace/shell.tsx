"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Mark, Icon, Socials } from "@/views/proviso/shared";
import { Glyph, type GlyphName } from "@/views/proviso/glyph";
import { PageMotion } from "@/views/proviso/page-motion";
import { WorkspaceProvider, useWorkspace } from "./provider";

const nav: [string, string, GlyphName][] = [
  ["", "Overview", "overview"],
  ["compose", "Write a thesis", "compose"],
  ["records", "Call ledger", "records"],
  ["proof", "Proof of Call", "proof"],
  ["fair-copy", "Fair Copy", "copy"],
  ["replay", "Strategy tester", "replay"],
  ["connections", "Accounts & routes", "accounts"],
  ["controls", "Risk controls", "limits"],
  ["activity", "Activity", "activity"],
];
function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const [menu, setMenu] = useState(false);
  const { notice, clearNotice, data } = useWorkspace();
  useEffect(() => {
    setMenu(false);
  }, [path]);
  useEffect(() => {
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(false);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, []);
  const active =
    nav.find(
      ([slug]) =>
        path.replace(/\/$/, "") === `/dashboard${slug ? "/" + slug : ""}`,
    )?.[1] || "Workspace";
  return (
    <div className={`workspace-v2 w-route-${path.split("/")[2] || "overview"}`}>
      <PageMotion />
      <a href="#main" className="skip-link">
        Skip to workspace
      </a>
      <aside
        className={`w-sidebar ${menu ? "is-open" : ""}`}
        aria-label="Workspace navigation"
      >
        <Link href="/" className="brand">
          <Mark />
          <span>Proviso</span>
        </Link>
        <div className="w-workspace-id">
          <span className="w-label">PERSONAL WORKSPACE</span>
          <span>
            <i /> Thesis desk <small>01</small>
          </span>
        </div>
        <nav>
          {nav.map(([slug, label, icon], i) => (
            <Link
              key={slug}
              href={`/dashboard/${slug ? slug + "/" : ""}`}
              aria-current={active === label ? "page" : undefined}
            >
              <Glyph name={icon} size={22} />
              <span>{label}</span>
              {slug === "records" ? (
                <em>{data.drafts.length.toString().padStart(2, "0")}</em>
              ) : (
                <small>{(i + 1).toString().padStart(2, "0")}</small>
              )}
            </Link>
          ))}
        </nav>
        <div className="w-sidebar-bottom">
          <Link href="/protocol/">
            <Glyph name="protocol" size={20} />
            Explore the protocol
            <Icon name="diagonal" size={13} />
          </Link>
          <Link href="/docs/architecture/">
            <Glyph name="architecture" size={20} />
            Architecture
            <Icon name="diagonal" size={13} />
          </Link>
          <div className="w-side-signature">
            <span>WRITE. SEAL. PROVE.</span>
            <Socials />
          </div>
        </div>
      </aside>
      {menu && (
        <button
          className="w-nav-backdrop"
          aria-label="Close workspace navigation"
          onClick={() => setMenu(false)}
        />
      )}
      <div className="w-body">
        <header className="w-topbar">
          <button
            className="w-menu-button"
            aria-label={menu ? "Close workspace menu" : "Open workspace menu"}
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            <Icon name={menu ? "close" : "menu"} />
          </button>
          <span className="w-breadcrumb">
            <span>Proviso</span>
            <i>/</i>
            {active}
          </span>
          <div className="w-topbar-right">
            <span className="w-local-status">
              <i /> Account not linked
            </span>
            <Link href="/dashboard/connections/" className="w-connect">
              <span className="account-avatar">
                <Glyph name="accounts" size={16} />
              </span>
              Connect account
              <Icon name="diagonal" size={14} />
            </Link>
          </div>
        </header>
        <main className="w-main" id="main">
          {children}
        </main>
        <footer className="w-footer">
          <span className="w-label">PROVISO / CONVICTION, ON RECORD.</span>
          <nav>
            <Link href="/docs/">Docs</Link>
            <Link href="/legal/terms/">Terms</Link>
            <Link href="/legal/privacy/">Privacy</Link>
            <Link href="/legal/risk/">Risk</Link>
          </nav>
          <span>Your ideas. Your rules. Your record.</span>
        </footer>
      </div>
      {notice && (
        <div className="w-toast" role="status">
          <Icon name="check" size={18} />
          <span>{notice}</span>
          <button aria-label="Dismiss notification" onClick={clearNotice}>
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
export function WorkspaceShell({ children }: { children: ReactNode }) {
  return (
    <WorkspaceProvider>
      <Shell>{children}</Shell>
    </WorkspaceProvider>
  );
}
