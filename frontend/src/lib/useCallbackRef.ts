// A stable callback identity that always invokes the latest closure, so it can
// be listed in effect deps without re-running them on every render.
import { useCallback, useLayoutEffect, useRef } from "react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useCallbackRef<T extends (...args: any[]) => any>(fn: T): T {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  const stable = useCallback((...args: unknown[]) => ref.current(...args), []);
  return stable as unknown as T;
}
