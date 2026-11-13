// The one place the app talks to its service worker (/sw.js, see the comment
// at the top of public/sw.js for what it caches and why).
//
// Production pages register it on every load (AppUpdateNotice in _app). Push
// (lib/push.ts) reuses the same registration, which is also how push keeps
// working under `next dev`: there the raw, unstamped worker does push only and
// never caches.
//
// Updates: a new binary ships a new sw.js, which installs and then WAITS while
// any page still runs the old build. watchForUpdates() reports that moment so
// the app can offer a reload; applyUpdate() activates the waiting worker and
// reloads only this tab, on the user's click. Nothing here reloads a page on
// its own, so an editor with unsaved changes is never thrown away (and a
// user-requested reload still goes through the editor's beforeunload guard).

const SW_URL = "/sw.js";
const SCOPE = "/";
// How often a long-lived tab asks the server whether sw.js changed. The browser
// also checks on every navigation; this covers a tab left open across a
// deploy.
const UPDATE_INTERVAL_MS = 30 * 60 * 1000;
const FOCUS_CHECK_MIN_MS = 60 * 1000;

let registering: Promise<ServiceWorkerRegistration | null> | null = null;
let reloadOnControllerChange = false;

export function isServiceWorkerSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator;
}

/** Register /sw.js once per page and return the registration (null when the
 *  browser has no service worker support or registration failed). */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!isServiceWorkerSupported()) return Promise.resolve(null);
  if (!registering) {
    registering = navigator.serviceWorker
      // updateViaCache "none": update checks always reach the server, whatever
      // a proxy in front of the binary does with Cache-Control.
      .register(SW_URL, { scope: SCOPE, updateViaCache: "none" })
      .catch(() => {
        registering = null;
        return null;
      });
  }
  return registering;
}

/** The registration with an active worker, registering first if needed. */
export async function readyRegistration(): Promise<ServiceWorkerRegistration> {
  await registerServiceWorker();
  return navigator.serviceWorker.ready;
}

/** The existing registration, without registering. */
export async function existingRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  if (!isServiceWorkerSupported()) return undefined;
  return navigator.serviceWorker.getRegistration(SCOPE);
}

/**
 * Call onUpdate whenever a newer worker than the one serving this page is ready:
 * one is waiting, or one took over from another tab. The first install on a
 * page that had no worker is not an update and is not reported. Returns a
 * cleanup function.
 */
export function watchForUpdates(onUpdate: () => void): () => void {
  if (!isServiceWorkerSupported()) return () => undefined;
  const sw = navigator.serviceWorker;
  let hadController = Boolean(sw.controller);
  let reg: ServiceWorkerRegistration | null = null;
  let stopped = false;
  let lastCheck = Date.now();

  const watchInstalling = (worker: ServiceWorker | null) => {
    if (!worker) return;
    worker.addEventListener("statechange", () => {
      if (!stopped && worker.state === "installed" && sw.controller) onUpdate();
    });
  };
  const onUpdateFound = () => watchInstalling(reg?.installing ?? null);
  const onControllerChange = () => {
    if (reloadOnControllerChange) {
      window.location.reload();
      return;
    }
    // Another tab activated the new worker. This page still runs the old build,
    // so offer the reload here too (never reload it for the user).
    if (hadController && !stopped) onUpdate();
    hadController = true;
  };
  const check = () => {
    lastCheck = Date.now();
    reg?.update().catch(() => undefined);
  };
  const onVisible = () => {
    if (document.visibilityState === "visible" && Date.now() - lastCheck > FOCUS_CHECK_MIN_MS) check();
  };

  sw.addEventListener("controllerchange", onControllerChange);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", check);
  const timer = window.setInterval(check, UPDATE_INTERVAL_MS);

  void registerServiceWorker().then((r) => {
    if (!r || stopped) return;
    reg = r;
    if (r.waiting && sw.controller) onUpdate();
    watchInstalling(r.installing);
    r.addEventListener("updatefound", onUpdateFound);
  });

  return () => {
    stopped = true;
    sw.removeEventListener("controllerchange", onControllerChange);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("online", check);
    window.clearInterval(timer);
    reg?.removeEventListener("updatefound", onUpdateFound);
  };
}

/** Activate the waiting worker (if any) and reload this tab onto the new build. */
export async function applyUpdate(): Promise<void> {
  const reg = await existingRegistration();
  const waiting = reg?.waiting;
  if (!waiting) {
    window.location.reload();
    return;
  }
  reloadOnControllerChange = true;
  waiting.postMessage({ type: "SKIP_WAITING" });
  // If the takeover never arrives (the worker was replaced again meanwhile),
  // reload anyway: a navigation always fetches fresh HTML from the server.
  window.setTimeout(() => window.location.reload(), 4000);
}
