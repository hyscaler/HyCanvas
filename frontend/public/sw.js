/* HyCanvas web push service worker (doc 17 FR-13).
 *
 * Handles two events:
 *  - "push": parse the JSON payload the backend sent (title/body/url/data) and
 *    show a system notification. Falls back to a generic message if the payload
 *    is missing or unparseable, so a malformed push never throws.
 *  - "notificationclick": close the notification and focus an already-open
 *    HyCanvas tab (navigating it to the deep link), or open a new window to
 *    the deep link when none is open.
 *
 * This file ships verbatim from /public in the static export and is registered
 * client-side by src/lib/push.ts. It must stay framework-free (no imports).
 */

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
    icon: "/favicon.ico",
    badge: "/favicon.ico",
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
