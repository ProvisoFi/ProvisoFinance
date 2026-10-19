"use client";

// 📖 Docs: obsidian/frontend/text-engine.md → "Blur In — every heading"

import { Children, isValidElement, type CSSProperties, type ReactNode, type Ref } from "react";

import { RobotText as TextEngine } from "./robot-text";

/**
 * "Blur In": the text resolves out of a soft blur, letter by letter. Every
 * heading (h1–h6) on the site enters this way; body copy stays static. The
 * spring and stagger are the look — keep them exactly as they are.
 */
export const BLUR_IN = {
  letterOut: { opacity: 0, filter: "blur(8px)" },
  letterIn: { opacity: 1, filter: "blur(0px)" },
  letterConfig: { tension: 98, friction: 17 },
  letterStagger: 36,
} as const;

/** Letters the engine animates in `children` (spaces split words, so they don't count). */
export const letterCount = (children: ReactNode): number => {
  let count = 0;
  Children.forEach(children, (child) => {
    if (typeof child === "string" || typeof child === "number") {
      count += String(child).replace(/\s/g, "").length;
    } else if (isValidElement<{ children?: ReactNode }>(child)) {
      count += letterCount(child.props.children);
    }
  });
  return count;
};

/** Delay that starts a line right after the `letters` before it have started. */
export const blurInAfter = (letters: number): number => letters * BLUR_IN.letterStagger;

type Tag = "span" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

export interface BlurInProps {
  children: ReactNode;
  /**
   * Gate the entrance from outside (e.g. a block's arrival). It plays once,
   * when this is true and the text is in view.
   */
  show?: boolean;
  delay?: number;
  /**
   * The engine's container is a wrapping flex row. `tag` defaults to a span
   * set inside the real heading, so the heading keeps its own box. Align its
   * words with `justify-*`, never `text-*` alone.
   */
  tag?: Tag;
  className?: string;
  /**
   * Sit on the parent's line as an inline box instead of a block row — keeps
   * the parent's line box (its `text-box` trim and `text-align`) in charge.
   */
  inline?: boolean;
  /** One line that must never wrap (a `whitespace-nowrap` heading). */
  nowrap?: boolean;
  /**
   * Gap between words, em. The engine sets words as flex items, so this
   * stands in for the space — match it to the face's own space (with its
   * tracking) where the line's width matters.
   */
  gap?: number;
  ref?: Ref<HTMLElement>;
  /** Below the fold: plain until an idle period after hydration (`RobotText` `idle`). */
  idle?: boolean;
}

export function BlurIn({
  children,
  show = true,
  delay = 0,
  tag = "span",
  className = "",
  inline = false,
  nowrap = false,
  gap = 0.3,
  ref,
  idle = false,
}: BlurInProps) {
  const style: CSSProperties = {
    ...(inline && { display: "inline-flex" }),
    ...(nowrap && { flexWrap: "nowrap" }),
  };
  return (
    <TextEngine
      ref={ref}
      tag={tag}
      mode="once"
      idle={idle}
      enabled={show}
      delayIn={delay}
      columnGap={gap}
      {...BLUR_IN}
      // Words of mixed sizes (serif + script) share a baseline, as inline text did.
      className={`items-baseline ${className}`}
      style={style}
    >
      {children}
    </TextEngine>
  );
}
