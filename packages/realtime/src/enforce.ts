// Server-side per-node lock enforcement helpers (collaboration FR-8 / brand
// controls FR-6, defense-in-depth). The authoritative room Y.Doc already rejects every update
// from a viewer connection (the read-only gate in seed.ts). These pure,
// socket-free helpers add the finer rule for EDITOR connections: an editor must
// not mutate a node another client collab-locked, nor a brand locked-region node
// while lacking manage-brand.
//
// Because a Yjs update is opaque and applies atomically, we cannot inspect it
// before applying. Instead the gateway enforces by SNAPSHOT-AND-CORRECT: it
// serializes the protected nodes BEFORE applying the update, applies it, then
// calls {@link restoreNodes} to push the snapshot back into any protected node
// that changed. The correction runs in a dedicated SERVER-origin transaction and
// produces minimal ops (reusing the reconciler), so the offender's edits to
// NON-protected nodes survive untouched and every client (including the
// offender) converges back to the protected node's prior state.
//
// These helpers reuse the existing Y-walk (yToJson) and the minimal reconcile
// rather than duplicating the nested-structure traversal.

import * as Y from "yjs";
import { DESIGN_ROOT_KEY } from "@hc/schema";
import { yToJson, reconcileNodeMap } from "./reconcile";

/** Origin tag stamped on the corrective transaction. Distinct from the local
 *  (reconcile) and remote (applied client update) origins so the gateway can
 *  tell a server correction apart and never echoes it back to its author as a
 *  fresh remote edit. */
export const SERVER_ORIGIN = "server";

/** A protected node's serialized state captured before an update is applied.
 *  `null` means the node was absent at snapshot time. */
export type NodeSnapshot = Map<string, Record<string, unknown> | null>;

/** True for a plain JS object (a node serialized from a Y.Map). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Locate the Y.Map for a node id by walking the design's pages and their
 * children recursively (so nodes nested in groups/frames are found). Returns the
 * Y.Map, or null when no node with that id exists in the doc. Pure read; no
 * mutation.
 */
export function findNodeMap(ydoc: Y.Doc, nodeId: string): Y.Map<unknown> | null {
  const root = ydoc.getMap(DESIGN_ROOT_KEY);
  const pages = root.get("pages");
  if (!(pages instanceof Y.Array)) return null;
  for (const page of pages.toArray()) {
    if (!(page instanceof Y.Map)) continue;
    const children = page.get("children");
    if (children instanceof Y.Array) {
      const found = searchChildren(children, nodeId);
      if (found) return found;
    }
  }
  return null;
}

/** Depth-first search of a children Y.Array for a node id, recursing into any
 *  child that itself carries a `children` Y.Array (group/frame). */
function searchChildren(
  children: Y.Array<unknown>,
  nodeId: string,
): Y.Map<unknown> | null {
  for (const child of children.toArray()) {
    if (!(child instanceof Y.Map)) continue;
    if (child.get("id") === nodeId) return child;
    const grandchildren = child.get("children");
    if (grandchildren instanceof Y.Array) {
      const found = searchChildren(grandchildren, nodeId);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Serialize each id's current node to plain JSON (reusing {@link yToJson} on its
 * Y.Map), returning a Map<id, json|null>. A `null` entry records that the id had
 * no node at snapshot time (so a later re-appearance can be detected). Only the
 * protected ids are walked, so this stays cheap.
 */
export function snapshotNodes(ydoc: Y.Doc, ids: Iterable<string>): NodeSnapshot {
  const snap: NodeSnapshot = new Map();
  for (const id of ids) {
    const map = findNodeMap(ydoc, id);
    snap.set(id, map ? (yToJson(map) as Record<string, unknown>) : null);
  }
  return snap;
}

/**
 * Restore protected nodes to a prior snapshot inside a single SERVER-origin
 * transaction, returning the ids actually corrected. For each snapshotted id:
 *
 *  - If the node is PRESENT and its current serialized state differs from the
 *    snapshot, the snapshot value is reconciled back into its Y.Map (minimal
 *    ops, scoped to that node), reverting any property/transform mutation while
 *    leaving the rest of the doc untouched.
 *  - If the snapshot recorded the node as ABSENT (null) but it is now present,
 *    the (unauthorized) freshly inserted node is removed by reconciling its
 *    parent's children list without it.
 *  - DELETED-NODE CAVEAT: if the snapshot HAD the node but it is now GONE
 *    (the update deleted a locked node), re-inserting it is best-effort and only
 *    works when the node still has a live parent children Y.Array to splice into;
 *    Yjs forbids re-integrating a tombstoned shared type, so a deleted top-level
 *    node cannot be cleanly resurrected here. Such an id is reported as corrected
 *    only when re-insertion succeeds; otherwise it is skipped (the property-
 *    mutation guard above still protects every node that remains present). The
 *    gateway pairs this with the client lock UI, which prevents deleting a locked
 *    node in the first place.
 *
 * The whole pass is one transaction tagged {@link SERVER_ORIGIN} so the gateway
 * can broadcast exactly the corrective delta and never treat it as a new remote
 * edit (no echo loop).
 */
export function restoreNodes(ydoc: Y.Doc, snapshot: NodeSnapshot): string[] {
  const corrected: string[] = [];
  ydoc.transact(() => {
    for (const [id, prior] of snapshot) {
      const current = findNodeMap(ydoc, id);
      if (prior === null) {
        // Was absent; if it appeared, remove the unauthorized insertion.
        if (current && removeNode(ydoc, id)) corrected.push(id);
        continue;
      }
      if (current) {
        // Present in both: revert any change with minimal ops.
        const now = yToJson(current) as Record<string, unknown>;
        if (!deepEqual(now, prior)) {
          reconcileNodeMap(current, prior);
          corrected.push(id);
        }
        continue;
      }
      // Snapshot had it, but it is gone now (deleted by the update). Best-effort
      // re-insertion into its recorded parent's children list.
      if (reinsertNode(ydoc, id, prior)) corrected.push(id);
    }
  }, SERVER_ORIGIN);
  return corrected;
}

/** Remove a node by id from its parent children Y.Array. Returns whether it was
 *  found and removed. */
function removeNode(ydoc: Y.Doc, nodeId: string): boolean {
  const root = ydoc.getMap(DESIGN_ROOT_KEY);
  const pages = root.get("pages");
  if (!(pages instanceof Y.Array)) return false;
  for (const page of pages.toArray()) {
    if (!(page instanceof Y.Map)) continue;
    const children = page.get("children");
    if (children instanceof Y.Array && removeFromChildren(children, nodeId))
      return true;
  }
  return false;
}

/** Recursively remove a node id from a children Y.Array (and nested groups). */
function removeFromChildren(children: Y.Array<unknown>, nodeId: string): boolean {
  for (let i = 0; i < children.length; i++) {
    const child = children.get(i);
    if (!(child instanceof Y.Map)) continue;
    if (child.get("id") === nodeId) {
      children.delete(i, 1);
      return true;
    }
    const grandchildren = child.get("children");
    if (grandchildren instanceof Y.Array && removeFromChildren(grandchildren, nodeId))
      return true;
  }
  return false;
}

/**
 * Best-effort re-insertion of a deleted locked node. We can only place it back
 * when its recorded parent (a page or a group/frame in the snapshot's shape) is
 * still present and the node id is genuinely gone (Yjs forbids reviving a
 * tombstoned Y.Map, but inserting a FRESH Y.Map built from the snapshot is
 * fine). We append it to the matching parent children list (exact prior index is
 * not recoverable after a structural change, so order is best-effort). Returns
 * whether it was re-inserted. For a top-level node we append to the first page's
 * children; nested originals are not resolvable from the node snapshot alone, so
 * those fall through to false and rely on the present-node guard for protection.
 */
function reinsertNode(
  ydoc: Y.Doc,
  nodeId: string,
  prior: Record<string, unknown>,
): boolean {
  const root = ydoc.getMap(DESIGN_ROOT_KEY);
  const pages = root.get("pages");
  if (!(pages instanceof Y.Array) || pages.length === 0) return false;
  // Re-insert under the first page's children. The node snapshot does not record
  // its parent, so this is a best-effort top-level restore; a node that lived in
  // a group cannot be reliably re-parented from the snapshot alone.
  const firstPage = pages.get(0);
  if (!(firstPage instanceof Y.Map)) return false;
  let children = firstPage.get("children");
  if (!(children instanceof Y.Array)) {
    children = new Y.Array<unknown>();
    firstPage.set("children", children);
  }
  // Guard against double-insert (id already present after a concurrent op).
  if (findNodeMap(ydoc, nodeId)) return false;
  const fresh = new Y.Map<unknown>();
  (children as Y.Array<unknown>).push([fresh]);
  reconcileNodeMap(fresh, prior);
  return true;
}

/** Structural deep-equality for JSON values (key order ignored). Local copy so
 *  this module does not export reconcile internals. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}
