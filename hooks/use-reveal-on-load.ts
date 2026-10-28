import { useLayoutEffect, useRef, type RefObject } from "react";

const REVEAL_FRAMES: Keyframe[] = [
  { filter: "blur(4px)", opacity: 0 },
  { filter: "blur(0)", opacity: 1 },
];

const REVEAL_TIMING: KeyframeAnimationOptions = { duration: 320, easing: "cubic-bezier(0.22, 1, 0.36, 1)" };

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useRevealOnLoad(container: RefObject<HTMLElement | null>, loaded: boolean) {
  const wasLoading = useRef(!loaded);
  useLayoutEffect(() => {
    if (!loaded) {
      wasLoading.current = true;
      return;
    }
    if (!wasLoading.current) return;
    wasLoading.current = false;
    if (prefersReducedMotion()) return;
    container.current?.querySelectorAll("[data-reveal]").forEach((element) => {
      element.animate(REVEAL_FRAMES, REVEAL_TIMING);
    });
  }, [container, loaded]);
}
