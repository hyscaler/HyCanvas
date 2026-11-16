// A one-way channel from the whiteboard chrome to the canvas: "open this sticky
// for typing". The canvas owns the sticky edit overlay, but the toolbar button
// and the S shortcut that add a sticky live in WhiteboardSurface. Without this
// the new sticky stayed closed, so typing right after adding it fell through
// to the board's single-key shortcuts (a "t" added a stray text box) instead of
// going into the note (#84).
//
// Deliberately not a store slice: a transient UI intent, never persisted or
// undone. Nobody listening (no canvas mounted) simply drops the request.

type Listener = (id: string) => void;
const listeners = new Set<Listener>();

export function subscribeStickyEditRequests(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function requestStickyEdit(id: string): void {
  for (const cb of listeners) cb(id);
}
