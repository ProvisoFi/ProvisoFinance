"use client";
import { useEffect } from "react";
import { usePathname } from "next/navigation";

/** Progressive enhancement: content stays visible without JavaScript. */
export function PageMotion() {
  const path = usePathname();
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const targets = document.querySelectorAll<HTMLElement>(
      ".p-hero-heading, .p-hero > :last-child, .p-section-index, .p-section-content, .p-doc-grid > a, .p-scenario, .p-disclosure-stage, .p-cta, .w-panel, .w-page-title, .w-stats-strip, .w-copy-top, .reading-content > section",
    );
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-revealed");
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.07, rootMargin: "0px 0px -24px 0px" },
    );
    targets.forEach((el, i) => {
      el.style.setProperty("--entrance-delay", `${Math.min(i % 3, 2) * 65}ms`);
      observer.observe(el);
    });
    return () => {
      observer.disconnect();
      targets.forEach((el) => el.classList.remove("is-revealed"));
    };
  }, [path]);
  return null;
}
