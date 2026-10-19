"use client";

import { type ReactNode, useEffect, useRef } from "react";

import { useRobot } from "@/components/common/robot-view";

import { markArrived, onStackFrame } from "./stack-frame";

/**
 * The footer lies under the page, pinned to the bottom of the screen; the last
 * block lifts off it like a curtain. It starts in shadow and brightens as it
 * is uncovered (and its flower drifts into place — `--footer-reveal`).
 * `main` sits above it (z-10). Its reveals (the wordmark pen) wait until it is
 * half uncovered — its own box sits on screen the whole time, under `main`.
 *
 * It is served at opacity 0 and shown once the page's end is within NEAR
 * screens. Under `main` it is never seen before that, but a painted one is
 * still on screen for Chrome: its flower was the phone's LCP (4.2 s, an image
 * nobody sees). Opacity, not visibility, so its links stay in the tab order
 * and the accessibility tree. Shown early enough to be rasterised before it
 * is uncovered, and never hidden again. No-JS gets it as is.
 *
 * The robot form (PageSpeed audits it, D-059) has no reveal: the footer
 * simply follows the page in flow, below the fold. Pinned under `main` it was
 * that form's LCP on phones too (PSI: observed 2.4 s, the lazy flower).
 */

const MAX_SHADE = 0.45;
/** Share of the footer uncovered before its reveals play. */
const ARRIVED = 0.5;
/** Screens between the page's end and the bottom of the screen at which the footer is painted. */
const NEAR = 1.5;

export function FooterReveal({ children }: { children: ReactNode }) {
  const robot = useRobot();
  const ref = useRef<HTMLDivElement>(null);
  const shade = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    const layer = shade.current;
    const main = el?.previousElementSibling;
    if (!el || !layer || !(main instanceof HTMLElement)) return;
    const flower = el.querySelector<HTMLElement>("[data-footer-flower]");
    let last = -1;
    let shown = 0;
    let near = false;
    let painted = false;
    return onStackFrame({
      read: () => {
        const uncovered = window.innerHeight - main.getBoundingClientRect().bottom;
        shown = Math.min(1, Math.max(0, uncovered / el.offsetHeight));
        near ||= uncovered > -NEAR * window.innerHeight;
      },
      write: () => {
        if (near && !painted) {
          painted = true;
          el.style.opacity = "1";
        }
        if (shown >= ARRIVED) markArrived(el);
        const value = Math.round((1 - shown) * MAX_SHADE * 1000) / 1000;
        if (value === last) return;
        last = value;
        layer.style.opacity = String(value);
        // Footer flower parallax: it drifts up into place as revealed. Written
        // on the flower alone — a custom property on the wrapper restyled the
        // whole footer every frame.
        if (flower) flower.style.transform = `translate3d(0, ${((1 - shown) * 14).toFixed(3)}%, 0)`;
      },
    });
  }, []);

  return (
    <div
      ref={ref}
      data-block
      data-footer-reveal
      data-header-tone="dark"
      className={robot ? "relative z-0" : "sticky bottom-0 z-0 opacity-0"}
    >
      <noscript>
        <style>{"[data-footer-reveal]{opacity:1}"}</style>
      </noscript>
      {children}
      <div ref={shade} aria-hidden className="pointer-events-none absolute inset-0 bg-sheet-shade opacity-45" />
    </div>
  );
}
