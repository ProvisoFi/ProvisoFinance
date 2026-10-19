"use client";

import { useEffect } from "react";
import Lenis from "lenis";
import { useScroll } from "@/hooks/smooth-scroll/use-scroll";
import { subscribeToTickerFirst } from "@/lib/animation/ticker";
import { useShallow } from "zustand/react/shallow";

export function ScrollLayout({ children }: { children: React.ReactNode }) {
  // Server-safe rendering
  return (
    <div className="scroll-layout w-full">
      {/* Static content that can be rendered on server */}
      <div className="scroll-layout-content">{children}</div>

      {/* Client-only functionality */}
      <ScrollController />
    </div>
  );
}

function ScrollController() {
  const isEnableScroll = useScroll((state) => state.isEnableScroll);
  const [lenis, setLenis] = useScroll(
    useShallow((state) => [state.lenis, state.setLenis]),
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash;
    if (!hash) window.scrollTo(0, 0);
    const lenis = new Lenis({
      smoothWheel: true,
      // Read the page height live: cached dimensions went stale when content
      // grew after mount (pinned stages, sheet spacers) and cut the page off.
      naiveDimensions: true,
      // In-page links jump at once, through Lenis — a native jump made
      // during wheel inertia was overwritten by the easing scroll.
      anchors: { immediate: true },
      // syncTouch: true,
    });
    // A deep link (/#discovery) lands on its block once Lenis is in charge.
    if (hash) requestAnimationFrame(() => lenis.scrollTo(hash, { immediate: true }));
    (window as typeof window & { lenis: Lenis }).lenis = lenis;
    setLenis(lenis);

    // Lenis leads the shared ticker: every scroll-linked subscriber then reads
    // this frame's scroll, not the previous one.
    const stopRaf = subscribeToTickerFirst((time) => lenis.raf(time));

    return () => {
      // Stop the loop before destroying Lenis — otherwise it keeps calling
      // `raf` on a destroyed instance after unmount/HMR.
      stopRaf();
      lenis.destroy();
      setLenis(null);
    };
  }, [setLenis]);

  useEffect(() => {
    if (isEnableScroll) {
      lenis?.start();
      enableNativeScroll(true);
    } else {
      lenis?.stop();
      enableNativeScroll(false);
    }
  }, [isEnableScroll, lenis]);

  return null; // This component doesn't render anything visible
}

const enableNativeScroll = (value: boolean) => {
  if (typeof document === "undefined") return;
  if (!document) return;
  const html = document.querySelector("html");
  if (!html) return;
  if (!value) {
    html.style.position = "relative";
    html.style.overflow = "hidden";
    html.style.height = "100%";
  } else {
    html.style.removeProperty("position");
    html.style.removeProperty("overflow");
    html.style.removeProperty("height");
  }
};
