// Installing HyCanvas as an app (the PWA: manifest.webmanifest + sw.js).
//
// Chromium browsers (Chrome, Edge, Samsung Internet, desktop and Android) fire
// `beforeinstallprompt` once the page qualifies; holding on to that event is
// the only way to open the install dialog from our own button. It can fire
// before React mounts, so the listener is attached at import (from _app),
// not in a component.
//
// Safari on iPhone and iPad has no such event: the only way in is Share, then
// Add to Home Screen, so there the button explains those steps instead.
// Anything already running as the installed app shows no button at all.

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type InstallState =
  /** The browser can show its install dialog now. */
  | "prompt"
  /** iPhone/iPad Safari: install by hand from the Share menu. */
  | "ios"
  /** Already running as the installed app, or nothing to offer. */
  | "none";

let deferred: InstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((cb) => cb());

function standalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    nav.standalone === true ||
    window.matchMedia?.("(display-mode: standalone)").matches ||
    window.matchMedia?.("(display-mode: window-controls-overlay)").matches ||
    false
  );
}

function iosSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  // iPadOS reports a Mac user agent; a touch screen tells them apart.
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  // Only Safari can add to the home screen on older iOS; other iOS browsers
  // carry their own tag in the user agent.
  return ios && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    // Keep the browser's own mini-infobar out of the way; our button asks.
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    installed = true;
    notify();
  });
}

export function installState(): InstallState {
  if (installed || standalone()) return "none";
  if (deferred) return "prompt";
  if (iosSafari()) return "ios";
  return "none";
}

export function subscribeInstallState(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Open the browser's install dialog. Resolves true when the user accepted.
 *  The event is single-use, so it is dropped either way; the browser fires a
 *  fresh one later if the app is still installable. */
export async function promptInstall(): Promise<boolean> {
  const ev = deferred;
  if (!ev) return false;
  deferred = null;
  notify();
  await ev.prompt();
  const { outcome } = await ev.userChoice;
  return outcome === "accepted";
}
