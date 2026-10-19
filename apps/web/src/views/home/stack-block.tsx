"use client";

import { type ReactNode, useEffect, useRef } from "react";

import { ARRIVAL_LINE, ENTER_LINE, markArrived, markEntered, onStackFrame } from "./stack-frame";

/**
 * Block transitions — paper over red. Light blocks are sheets laid on top of
 * the previous block; red blocks lie underneath and are uncovered when the
 * sheet above lifts off. With depth: a block underneath moves slower than the
 * sheet above it and sits in shade, out of focus. No shadows at the sheets'
 * edges — the shade on the block underneath is the only depth cue.
 */

export interface StackBlockProps {
  children: ReactNode;
  tone: "dark" | "light";
  id?: string;
  /** Stick under the next block (off for the hero, which scrolls away). */
  stick?: boolean;
  /** The hero: a transparent sheet over Block 02, scrolls away on its own. */
  fixed?: boolean;
  /** Block 02: a top sheet that starts under the hero (its own negative margin). */
  stage?: boolean;
  className?: string;
}

type Role = "cover" | "reveal";

const MAX_SHADE = 0.45;
/** Blur (px) of a block fully in shade — it falls out of focus as it is covered. */
const MAX_BLUR = 10;
/** Parallax of a block underneath, in screens (< 1 keeps its edges covered). */
const DEPTH = 0.22;

/**
 * Paper over red on the 1440 frame. Below it (1024 / 768 / 390) blocks keep
 * their Figma heights, often not a screen tall: every block is a sheet laid
 * on top of the previous one, straight after it in the flow.
 */
const STACKED = "(width >= 1200px)";
const REDUCED = "(prefers-reduced-motion: reduce)";

/** Nearest block sibling, skipping the scroll spacers and anchors around blocks. */
const sibling = (el: Element, dir: "next" | "prev"): Element | null => {
  let n = dir === "next" ? el.nextElementSibling : el.previousElementSibling;
  while (n instanceof HTMLElement && n.dataset.spacer !== undefined) {
    n = dir === "next" ? n.nextElementSibling : n.previousElementSibling;
  }
  return n;
};

/** Role of a block: laid on top (paper), or lying underneath (red). */
const roleOf = (el: Element | null, stacked: boolean): Role | null => {
  if (!(el instanceof HTMLElement) || el.dataset.block === undefined || el.dataset.fixed !== undefined) return null;
  if (el.dataset.stage !== undefined) return "cover";
  if (!stacked) return "cover";
  return el.dataset.headerTone === "light" ? "cover" : "reveal";
};

/** Inline styles this component owns — cleared before every (re)placement. */
const OWNED = ["position", "zIndex", "top", "marginTop", "minHeight", "display", "flexDirection", "justifyContent", "backgroundColor", "transform"] as const;

export function StackBlock({ children, tone, id, stick = true, fixed = false, stage = false, className = "" }: StackBlockProps) {
  const ref = useRef<HTMLDivElement>(null);
  const shade = useRef<HTMLDivElement>(null);
  const focus = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    const layer = shade.current;
    const blurLayer = focus.current;
    if (!el || !layer || !blurLayer) return;
    const next = sibling(el, "next");
    const prev = sibling(el, "prev");
    const stackedMq = window.matchMedia(STACKED);
    const reducedMq = window.matchMedia(REDUCED);

    // The hero is on screen from the start.
    if (fixed) markArrived(el);

    let sticky = stick;
    let reveal = false;
    let coverNext = false;
    let spacer: HTMLDivElement | null = null;

    // Heights are in lvh, not innerHeight: a phone/tablet toolbar sliding in
    // or out mid-scroll must not move the margins, spacers and sticky tops.
    const place = () => {
      const h = el.offsetHeight;
      el.style.top = sticky ? `min(0px, calc(100lvh - ${h}px))` : "";
      if (spacer) spacer.style.height = `max(0px, calc(200lvh - ${h}px))`;
    };

    // Works out the block's role for the current width — again whenever the
    // width crosses the stacked range (a tablet or phone turned sideways).
    const setup = () => {
      for (const key of OWNED) el.style[key] = "";
      spacer?.remove();
      spacer = null;

      const stacked = stackedMq.matches;
      const role = fixed ? null : roleOf(el, stacked);
      const nextRole = roleOf(next, stacked);
      // The last block lifts off the footer, which always lies underneath.
      const nextIsUnder = nextRole === "reveal" || !(next instanceof HTMLElement);
      reveal = role === "reveal";
      sticky = fixed ? stick : reveal || !nextIsUnder;
      coverNext = sticky && next instanceof HTMLElement && (nextRole === "cover" || fixed);

      if (!fixed) {
        el.style.position = sticky ? "sticky" : "relative";
        // Layers rise in page order; a block lying underneath slots just under
        // the sheet above it, yet above every earlier (stuck) sheet.
        const index = [...(el.parentElement?.querySelectorAll(":scope > [data-block]") ?? [])].indexOf(el);
        el.style.zIndex = String(reveal ? 2 * index - 3 : 2 * index);
      }

      // A block lying underneath starts one screen up, under the sheet above
      // (margin-top −100lvh). A spacer after it buys the scroll it needs: one
      // screen for the sheet above to lift off, then it is fully seen before
      // the next sheet is laid over it. (Not a bottom margin — a sticky box
      // counts its margin and would leave early.)
      // Every sheet is at least a screen tall (in its own ground): a shorter
      // one would let the block lying under it show past its edge, or let
      // that block's depth shift carry it out above the sheet.
      if (stacked && !fixed && !stage) {
        const section = el.firstElementChild;
        el.style.minHeight = "100lvh";
        el.style.display = "flex";
        el.style.flexDirection = "column";
        el.style.justifyContent = "center";
        if (section instanceof HTMLElement) el.style.backgroundColor = getComputedStyle(section).backgroundColor;
      }
      if (reveal && !stage) {
        el.style.marginTop = "-100lvh";
        spacer = document.createElement("div");
        spacer.dataset.spacer = "";
        spacer.setAttribute("aria-hidden", "true");
        el.after(spacer);
      }
      place();
      last = "";
      applied = 0;
    };

    // Depth: a block underneath moves slower than the sheet above it (shifted
    // by DEPTH of a screen, never past that sheet's edge, so no gap opens) and
    // sits in shade, blurred — while it is being covered, or not yet uncovered.
    let last = "";
    let under = 0;
    let shift = 0;
    /** The depth shift currently on the element (its rect includes it). */
    let applied = 0;
    let arrived = fixed;
    let entered = fixed;
    const stopFrame = onStackFrame({
      read: () => {
        const vh = window.innerHeight;
        const nextTop = coverNext && next instanceof HTMLElement ? next.getBoundingClientRect().top : vh;
        const covered = coverNext ? Math.min(1, Math.max(0, (vh - nextTop) / vh)) : 0;
        const prevBottom = reveal && prev instanceof HTMLElement ? prev.getBoundingClientRect().bottom : 0;
        const hidden = Math.min(1, Math.max(0, prevBottom / vh));
        under = Math.max(covered, hidden);
        shift = fixed || reducedMq.matches ? 0 : (hidden - covered) * DEPTH * vh;
        // A sheet shorter than the screen must not drift up off the sheet
        // coming over it — the gap would show an older block.
        if (shift < 0 && coverNext) {
          const bottom = el.getBoundingClientRect().bottom - applied;
          shift = Math.max(shift, Math.min(0, nextTop - bottom));
        }
        if (!arrived) {
          // Where the block is actually visible from: its own top, or the
          // edge of the sheet still lying over it.
          const visibleTop = Math.max(el.getBoundingClientRect().top, prevBottom);
          arrived = visibleTop <= ARRIVAL_LINE * vh;
          entered ||= visibleTop <= ENTER_LINE * vh;
        }
      },
      write: () => {
        if (entered) markEntered(el);
        if (arrived) markArrived(el);
        const key = `${under.toFixed(3)}|${shift.toFixed(1)}`;
        if (key === last) return;
        last = key;
        layer.style.opacity = String(under * MAX_SHADE);
        layer.style.visibility = under > 0 ? "visible" : "hidden";
        // A backdrop blur of its own, at full opacity: on the shade layer
        // the blur would fade with the shade's opacity.
        const blur = under > 0 ? `blur(${(under * MAX_BLUR).toFixed(1)}px)` : "";
        blurLayer.style.backdropFilter = blur;
        blurLayer.style.setProperty("-webkit-backdrop-filter", blur);
        blurLayer.style.visibility = under > 0 ? "visible" : "hidden";
        applied = Number(shift.toFixed(1));
        el.style.transform = shift ? `translate3d(0, ${shift.toFixed(1)}px, 0)` : "";
      },
    });

    setup();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    stackedMq.addEventListener("change", setup);

    return () => {
      spacer?.remove();
      ro.disconnect();
      stackedMq.removeEventListener("change", setup);
      stopFrame();
    };
  }, [stick, fixed, stage]);

  return (
    <>
      {/* Jump target for #id links: where the block is fully seen. For a
          block lying underneath that is where the sheet above has lifted off
          — its own box starts a screen higher, under that sheet. */}
      {id && <div id={id} data-spacer aria-hidden className="h-0" />}
      <div
        ref={ref}
        data-block
        data-fixed={fixed ? "" : undefined}
        data-stage={stage ? "" : undefined}
        data-header-tone={tone}
        className={`${stick ? "sticky" : "relative"} ${className}`}
      >
        {children}
        <div ref={focus} aria-hidden className="pointer-events-none invisible absolute inset-0" />
        <div
          ref={shade}
          aria-hidden
          className="pointer-events-none invisible absolute inset-0 bg-sheet-shade opacity-0"
        />
      </div>
    </>
  );
}
