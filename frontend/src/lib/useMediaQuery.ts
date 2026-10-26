import { useEffect, useState } from "react";

/**
 * Subscribe to a CSS media query and return whether it currently matches. Uses
 * matchMedia so layout decisions (the editor's overlay-vs-push panels, the
 * dashboard's drawer) track real breakpoints without polling the viewport on
 * every resize. SSR-safe (returns false until mounted); the listener is added
 * once and cleaned up on unmount, and setState only fires from the change event
 * (never synchronously in render), so it is React-compiler-safe with no update
 * loop.
 */
export function useMediaQuery(query: string): boolean {
  // Lazy initializer reads the current match on the client (false during SSR),
  // so the effect never has to setState synchronously in its body. The effect
  // only subscribes; setState fires from the change-event callback. The query
  // strings used here are constant per call site, so there is no stale-initial
  // concern across renders.
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}
