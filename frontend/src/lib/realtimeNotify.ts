// Listeners notified when the server pushes a `{ t: "notify" }` frame (FR-13):
// a new in-app notification was created for the caller on this
// design, so an open client refetches its unread count without polling. The
// frame carries no content; the client re-reads over REST (which re-checks
// ownership). Module-level so it survives client reconnects.
//
// Kept out of realtime.ts so the notifications bell, which every dashboard
// renders, does not load the realtime client and its CRDT sync protocol.
const notifyListeners = new Set<(designId: string) => void>();

/** Subscribe to live notification signals; returns an unsubscribe. */
export function onNotify(fn: (designId: string) => void): () => void {
  notifyListeners.add(fn);
  return () => notifyListeners.delete(fn);
}

/** Fan a notify frame out to every subscriber (called by the realtime client). */
export function emitNotify(designId: string): void {
  for (const fn of notifyListeners) fn(designId);
}
