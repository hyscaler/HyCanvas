/* HyCanvas service worker: web push (doc 17 FR-13) plus the installable app
 * shell (offline page, asset caching, update flow).
 *
 * Push:
 *  - "push": parse the JSON payload the backend sent (title/body/url/data) and
 *    show a system notification. Falls back to a generic message if the payload
 *    is missing or unparseable, so a malformed push never throws.
 *  - "notificationclick": close the notification and focus an already-open
 *    HyCanvas tab (navigating it to the deep link), or open a new window to
 *    the deep link when none is open.
 *
 * App shell (only when BUILD below was stamped by scripts/build-sw.mjs, which
 * the production frontend build runs; the raw file served by `next dev` keeps
 * BUILD null and does push only, so dev never caches anything):
 *  - install: precache the shell of THIS build (offline page, icons, and the
 *    hashed chunks the main pages load) into caches named after the build id.
 *  - activate: delete every cache from other builds, then claim open pages.
 *  - fetch: hashed /_next/static/* and static icons/fonts are cache first;
 *    HTML navigations are network first and fall back to the offline page only
 *    on a network failure. /api, /realtime, /mcp, health checks and anything
 *    not same-origin GET are never intercepted, so auth, uploads and exports
 *    always go to the server.
 *
 * Upgrade safety: HTML is never served from a cache, so a page always comes
 * from the binary that is running and only references that binary's hashed
 * chunks. A new binary ships a new sw.js (its bytes carry the build id), which
 * installs next to the old one and waits; the page shows "A new version is
 * available" and posts SKIP_WAITING only when the user chooses to reload.
 *
 * This file ships from /public in the static export and is registered by
 * src/lib/sw.ts. It must stay framework-free (no imports).
 */

// Replaced at build time with {"id": "<build id>", "precache": [...]}.
const BUILD = /*__HC_BUILD__*/ null;

const CACHE_PREFIX = "hc-";
const SHELL_CACHE = BUILD ? CACHE_PREFIX + "shell-" + BUILD.id : "";
const RUNTIME_CACHE = BUILD ? CACHE_PREFIX + "runtime-" + BUILD.id : "";
const OFFLINE_URL = "/offline.html";

// Server namespaces the worker must never answer for: the API (auth, uploads,
// exports, jobs all live under /api), the realtime socket, the MCP endpoint,
// health probes, and the worker script itself.
const BYPASS = /^\/(api|realtime|mcp|healthz|readyz)(\/|$)|^\/sw\.js$/;
// Static files whose bytes only change with a new build (and so a new cache).
const STATIC_FILE = /^\/(_next\/static\/.+|[^/]+\.(png|svg|ico|webmanifest)|brand\/.+\.(png|svg|ico)|.+\.(woff2?|ttf|otf))$/;

self.addEventListener("install", (event) => {
  if (!BUILD) return;
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // cache: "reload" skips the HTTP cache so the shell is exactly what the
      // running binary serves.
      cache.addAll(BUILD.precache.map((url) => new Request(url, { cache: "reload" }))),
    ),
  );
});

self.addEventListener("activate", (event) => {
  if (!BUILD) return;
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, RUNTIME_CACHE]);
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith(CACHE_PREFIX) && !keep.has(n)).map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "SKIP_WAITING") self.skipWaiting();
  else if (data.type === "GET_BUILD" && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ build: BUILD ? BUILD.id : null });
  }
});

async function fromCache(request) {
  const shell = await caches.open(SHELL_CACHE);
  const hit = await shell.match(request);
  if (hit) return hit;
  const runtime = await caches.open(RUNTIME_CACHE);
  return runtime.match(request);
}

async function cacheFirst(request) {
  const hit = await fromCache(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && response.type === "basic") {
    const copy = response.clone();
    caches.open(RUNTIME_CACHE).then((c) => c.put(request, copy)).catch(() => undefined);
  }
  return response;
}

async function networkFirstNavigation(request) {
  try {
    return await fetch(request);
  } catch (err) {
    // Only a network failure lands here; a 404 or a 502 from a proxy during a
    // restart is a real answer and passes through untouched.
    const offline = await fromCache(OFFLINE_URL);
    if (offline) return offline;
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  if (!BUILD) return;
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (BYPASS.test(url.pathname)) return;
  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }
  // Everything else (translations, which a self-hoster can replace without a
  // rebuild, and any query-string request) goes straight to the network.
  if (!url.search && STATIC_FILE.test(url.pathname)) event.respondWith(cacheFirst(request));
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title = payload.title || "HyCanvas";
  const body = payload.body || "You have a new notification.";
  const url = payload.url || "/";
  const options = {
    body,
    icon: "/icon-192.png",
    badge: "/badge-72.png",
    // Carry the deep-link target (plus any extra fields) so notificationclick
    // knows where to route.
    data: Object.assign({ url }, payload.data || {}),
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = data.url || "/";
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // Focus an existing HyCanvas tab if one is open, routing it to the link.
      for (const client of clientList) {
        if ("focus" in client) {
          try {
            if ("navigate" in client && target) await client.navigate(target);
          } catch {
            /* cross-origin or navigation blocked: still focus the tab */
          }
          return client.focus();
        }
      }
      // Otherwise open a fresh window to the deep link.
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })(),
  );
});
