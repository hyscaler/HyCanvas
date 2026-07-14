// View-engagement instrumentation. Records a view
// session when a design is opened (editor or the /shared viewer) and sends a
// periodic heartbeat (every ~15s) while the tab is focused, reporting the
// elapsed ms since the last beat plus the current page. It stops on blur and
// flushes a final beat on unload, so duration reflects actual focused time.
//
// Two modes: an authenticated viewer posts to /designs/:id/view-beat; an
// anonymous share-link viewer posts to /shared/:token/view-beat with a stable,
// client-minted anonId (so unique anonymous viewers are counted distinctly).
// Best-effort: a failed beat is swallowed (insights are non-critical).

import { useEffect } from "react";
import { oc } from "@/lib/sdk";
import { useCallbackRef } from "@/lib/useCallbackRef";

const HEARTBEAT_MS = 15_000;

/** A stable per-browser anonymous viewer id, persisted in localStorage so the
 *  same anonymous visitor is deduped across sessions/reloads (FR-14). */
function getAnonId(): string {
  if (typeof window === "undefined") return "anon";
  const KEY = "oc.anonViewerId";
  let id = window.localStorage.getItem(KEY);
  if (!id) {
    id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `anon-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    window.localStorage.setItem(KEY, id);
  }
  return id;
}

function newSessionId(): string {
  // Called client-side only (from the effect below). Draw 128 bits from the
  // platform CSPRNG via getRandomValues, which is available in both secure and
  // insecure contexts (unlike crypto.randomUUID) and never uses Math.random.
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return "s-" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

interface Options {
  /** The authenticated design id (editor). Mutually exclusive with `token`. */
  designId?: string | null;
  /** The share-link token (anonymous /shared viewer). */
  token?: string | null;
  /** Optional link password to validate the anonymous beat. */
  password?: string;
  /** A getter for the current page id (so the heartbeat reports it). */
  getPageId?: () => string | null | undefined;
  /** Whether instrumentation is active (e.g. only after the design loads). */
  enabled?: boolean;
}

/**
 * Drive view-beat heartbeats for the lifetime of the mounted component (FR-14).
 * No-op until `enabled` and a `designId`/`token` is present. A single stable
 * session id is minted per mount; the hook reports the ms elapsed since the
 * previous beat, attributing it to the current page.
 */
export function useViewBeat(opts: Options): void {
  const { designId, token, password, getPageId, enabled = true } = opts;
  // Stable identity that always reads the latest page getter without re-running
  // the session effect (which must mint exactly one session per mount).
  const currentPageId = useCallbackRef(() => getPageId?.() ?? null);

  useEffect(() => {
    if (!enabled) return;
    if (!designId && !token) return;
    if (typeof window === "undefined") return;

    const sessionId = newSessionId();
    const anonId = token ? getAnonId() : undefined;
    let lastBeat = Date.now();

    const send = (ms: number) => {
      const pageId = currentPageId();
      const beat = Math.max(0, Math.round(ms));
      if (token) {
        void oc
          .sharedViewBeat(token, { anonId: anonId as string, sessionId, pageId, ms: beat, password })
          .catch(() => undefined);
      } else if (designId) {
        void oc.viewBeat(designId, { sessionId, pageId, ms: beat }).catch(() => undefined);
      }
    };

    // Open the session immediately (ms 0 so the row is created up front).
    send(0);

    const tick = () => {
      // Only count time while the tab is visible/focused (FR-14).
      if (typeof document !== "undefined" && document.hidden) {
        lastBeat = Date.now();
        return;
      }
      const now = Date.now();
      send(now - lastBeat);
      lastBeat = now;
    };
    const id = setInterval(tick, HEARTBEAT_MS);

    const onHidden = () => {
      if (document.hidden) {
        // Flush focused time accumulated up to the blur, then pause the clock.
        send(Date.now() - lastBeat);
      }
      lastBeat = Date.now();
    };
    const onUnload = () => send(Date.now() - lastBeat);

    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onUnload);
    window.addEventListener("beforeunload", onUnload);

    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onUnload);
      window.removeEventListener("beforeunload", onUnload);
      // Final flush on unmount (route change away from the design).
      send(Date.now() - lastBeat);
    };
  }, [designId, token, password, enabled, currentPageId]);
}
