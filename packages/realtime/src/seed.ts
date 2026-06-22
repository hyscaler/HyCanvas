// Server-side room helpers (FR-3, FR-13). These are the pure,
// socket-free pieces the realtime gateway composes: seeding an empty room Y.Doc
// from the latest persisted DesignFile, projecting the room Y.Doc back to a
// DesignFile for the last-client snapshot, and the read-only (viewer) gate.

import * as Y from "yjs";
import { DESIGN_ROOT_KEY, type DesignFile } from "@hc/schema";
import { reconcile, fromDoc } from "./reconcile";

/** True when a Y.Doc has no design state yet (its root map is empty). A freshly
 *  constructed room doc is empty until seeded or until a peer's first sync. */
export function isEmptyDoc(ydoc: Y.Doc): boolean {
  return ydoc.getMap(DESIGN_ROOT_KEY).size === 0;
}

/**
 * Seed an empty room Y.Doc from the latest persisted DesignFile so the first
 * joiner syncs the saved state rather than a blank document. No-op when the doc
 * already has state (a peer synced first, or it was seeded earlier), so it is
 * safe to call on every join. Returns true when it actually seeded.
 */
export function seedDocFromFile(ydoc: Y.Doc, file: DesignFile): boolean {
  if (!isEmptyDoc(ydoc)) return false;
  reconcile(file, ydoc);
  return true;
}

/** Project the room Y.Doc to a plain DesignFile for the last-client snapshot. */
export function docToFile(ydoc: Y.Doc): DesignFile {
  return fromDoc(ydoc);
}

/** FR-13: a read-only (viewer) connection may receive sync/awareness but must
 *  never apply document updates. The gateway calls this before applying an
 *  inbound sync update; viewers are dropped (not applied, not broadcast). */
export function canApplyUpdates(role: "editor" | "viewer"): boolean {
  return role === "editor";
}
