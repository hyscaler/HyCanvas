// CRDT reconciler (FR-1, FR-2). The editor mutates a plain JS
// `DesignFile`; this module pushes that plain object INTO a live Y.Doc's nested
// shared types under DESIGN_ROOT_KEY, producing the MINIMAL set of Yjs ops that
// makes the Y.Doc match the JS doc. Minimal ops matter: when two clients edit
// different nodes (or different fields of one node), the granular ops merge
// conflict-free under Yjs CRDT semantics with no lost intent (AC-2/AC-3). A
// naive "clear and re-toY the whole tree" would touch every node and clobber
// concurrent edits, so we diff structurally instead.
//
// Mapping mirrors @hc/schema's snapshot bridge exactly (objects -> Y.Map,
// arrays -> Y.Array, primitives as-is), so `fromY(ydoc)` after `reconcile(doc,
// ydoc)` deep-equals `doc`.

import * as Y from "yjs";
import { DESIGN_ROOT_KEY, type DesignFile } from "@hc/schema";

/** Origin tag stamped on the transaction wrapping a local reconcile. The client
 *  binding observes for updates whose origin is NOT this, to apply remote edits
 *  without echoing them back. */
export const LOCAL_ORIGIN = "local";

type JsonObject = Record<string, unknown>;

/**
 * Materialize a plain JSON value as the equivalent Yjs shared type using THIS
 * package's `Y` (objects -> Y.Map, arrays -> Y.Array, primitives as-is). Mirrors
 * @hc/schema's `toY` exactly; kept local so every Y type we insert is created
 * from the same yjs module instance as the target doc (inserting a Y type from a
 * different module copy throws "Unexpected content type").
 */
function jsonToY(value: unknown): unknown {
  if (Array.isArray(value)) {
    const arr = new Y.Array<unknown>();
    arr.push(value.map(jsonToY));
    return arr;
  }
  if (isPlainObject(value)) {
    const map = new Y.Map<unknown>();
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) map.set(k, jsonToY(v));
    }
    return map;
  }
  return value; // string | number | boolean | null
}

/** True for a plain JS object (the things that map to a Y.Map). */
function isPlainObject(v: unknown): v is JsonObject {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** An array whose items are all objects carrying a string `id` (pages, children,
 *  operands): such arrays are diffed by id so reorders/inserts/removals are
 *  granular and matched items recurse. Empty arrays are not keyed. */
function isKeyedArray(arr: unknown[]): arr is JsonObject[] {
  return (
    arr.length > 0 &&
    arr.every((it) => isPlainObject(it) && typeof (it as JsonObject).id === "string")
  );
}

/** Structural deep-equality for JSON values (used to decide whether an idless /
 *  primitive array needs replacing). Key order is ignored for objects. */
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

/**
 * Project a live Y value back to plain JSON (objects from Y.Map, arrays from
 * Y.Array, primitives as-is). Mirrors @hc/schema's `fromY`/`toDesignFile`, but
 * kept local so the `instanceof Y.Map` checks run against THIS package's `Y`
 * instance. Used both for diff equality checks and by {@link fromDoc}.
 */
export function yToJson(value: unknown): unknown {
  if (value instanceof Y.Array) return value.toArray().map(yToJson);
  if (value instanceof Y.Map) {
    const obj: JsonObject = {};
    for (const [k, v] of value.entries()) obj[k] = yToJson(v);
    return obj;
  }
  return value;
}

/**
 * Sync a plain JS object into a Y.Map: set only changed scalar keys, recurse
 * into child Y.Map/Y.Array (creating one when missing or the wrong type), and
 * delete Y keys that are absent from the JS object. `undefined` JS values are
 * treated as absent (matching toY, which skips undefined).
 */
function reconcileMap(target: Y.Map<unknown>, source: JsonObject): void {
  // Update / insert keys present in the source.
  for (const key of Object.keys(source)) {
    const sv = source[key];
    if (sv === undefined) {
      if (target.has(key)) target.delete(key);
      continue;
    }
    reconcileChild(target, key, sv);
  }
  // Delete keys the source no longer has.
  for (const key of [...target.keys()]) {
    if (!(key in source) || source[key] === undefined) target.delete(key);
  }
}

/** Reconcile a single child slot (`key`) of a Y.Map against a JS value. */
function reconcileChild(parent: Y.Map<unknown>, key: string, sv: unknown): void {
  const cur = parent.get(key);
  if (Array.isArray(sv)) {
    if (cur instanceof Y.Array) {
      reconcileArray(cur, sv);
    } else {
      const arr = new Y.Array<unknown>();
      parent.set(key, arr);
      reconcileArray(arr, sv);
    }
    return;
  }
  if (isPlainObject(sv)) {
    if (cur instanceof Y.Map) {
      reconcileMap(cur, sv);
    } else {
      const map = new Y.Map<unknown>();
      parent.set(key, map);
      reconcileMap(map, sv);
    }
    return;
  }
  // Scalar: write only when it actually differs (minimal ops).
  if (cur !== sv) parent.set(key, sv);
}

/** Reconcile a Y.Array against a JS array. */
function reconcileArray(target: Y.Array<unknown>, source: unknown[]): void {
  if (isKeyedArray(source)) {
    reconcileKeyedArray(target, source);
  } else {
    reconcilePlainArray(target, source);
  }
}

/**
 * Idless / primitive array (path segments, dash patterns, run text...): there is
 * no stable key to diff against, so replace the contents only when the array
 * actually changed. Replacing in one transaction keeps it a single granular op
 * scoped to this array, not the whole tree.
 */
function reconcilePlainArray(target: Y.Array<unknown>, source: unknown[]): void {
  if (deepEqual(yToJson(target), source)) return;
  if (target.length > 0) target.delete(0, target.length);
  target.push(source.map(jsonToY));
}

/**
 * Keyed array (items have stable `id`): diff by id so concurrent edits to
 * different items never collide. Steps: (1) remove items whose id vanished,
 * (2) recurse into items that still exist, (3) insert brand-new items, then
 * (4) reorder so the Y.Array order matches the JS order.
 */
function reconcileKeyedArray(target: Y.Array<unknown>, source: JsonObject[]): void {
  // Index the live array by id.
  const liveById = new Map<string, Y.Map<unknown>>();
  for (const item of target.toArray()) {
    if (item instanceof Y.Map) {
      const id = item.get("id");
      if (typeof id === "string") liveById.set(id, item);
    }
  }
  const sourceIds = new Set(source.map((s) => s.id as string));

  // (1) Remove items no longer present (delete from the tail to keep indices
  // valid as we splice).
  for (let i = target.length - 1; i >= 0; i--) {
    const item = target.get(i);
    const id = item instanceof Y.Map ? item.get("id") : undefined;
    if (typeof id !== "string" || !sourceIds.has(id)) {
      target.delete(i, 1);
      if (typeof id === "string") liveById.delete(id);
    }
  }

  // (2) Recurse into matched items; (3) insert new items, appended in source
  // order so a later reorder pass settles them into place.
  for (const s of source) {
    const id = s.id as string;
    const live = liveById.get(id);
    if (live) {
      reconcileMap(live, s);
    } else {
      const map = new Y.Map<unknown>();
      target.push([map]);
      reconcileMap(map, s);
      liveById.set(id, map);
    }
  }

  // (4) Reorder to match the source order. Yjs has no move primitive and forbids
  // re-integrating a shared type once it has been deleted, so a misplaced item
  // cannot be "moved" by delete+reinsert of the SAME Y.Map; instead the misplaced
  // item is deleted and a FRESH Y.Map (rebuilt from source) is inserted at the
  // right slot. Items that did NOT move are left untouched, so their granular
  // content merges are preserved.
  //
  // KNOWN LIMITATION (concurrent reorder + concurrent content edit): if a peer
  // concurrently edits the CONTENT of a node that this reconcile MOVES, the
  // peer's edit is lost on merge. It targeted the original Y.Map, which this move
  // tombstones via the delete; the freshly inserted Y.Map carries only this
  // client's local content. The loss is inherent to expressing a move as
  // delete+insert under a move-less CRDT, not something rebuilding from the live
  // Y.Map state would avoid (the peer's edit is not yet local at reconcile time;
  // it is destroyed when its update later merges onto the tombstoned map). A true
  // fix requires a CRDT move primitive. Reorders are far rarer than content
  // edits, and a moved node is usually the one the mover is actively working,
  // so the practical exposure is small; we accept it rather than risk a larger
  // structural rewrite.
  for (let i = 0; i < source.length; i++) {
    const wantId = source[i].id as string;
    const haveItem = target.get(i);
    const haveId = haveItem instanceof Y.Map ? haveItem.get("id") : undefined;
    if (haveId === wantId) continue;
    // Find where the wanted item currently sits (it is somewhere after i, since
    // everything before i is already in order) and remove it from there.
    let from = -1;
    for (let j = i + 1; j < target.length; j++) {
      const it = target.get(j);
      if (it instanceof Y.Map && it.get("id") === wantId) {
        from = j;
        break;
      }
    }
    if (from < 0) continue; // defensive: it was inserted/recursed above
    target.delete(from, 1);
    const fresh = new Y.Map<unknown>();
    target.insert(i, [fresh]);
    reconcileMap(fresh, source[i]);
    liveById.set(wantId, fresh);
  }
}

/**
 * Idempotently sync a plain JS `DesignFile` into a Y.Doc's nested shared types
 * under DESIGN_ROOT_KEY, producing minimal Yjs ops. Runs inside one
 * `ydoc.transact(..., LOCAL_ORIGIN)` so the whole reconcile is a single,
 * locally-originated update the binding can tell apart from remote updates.
 *
 * After `reconcile(doc, ydoc)`, `fromY(ydoc)` (a.k.a. `toDesignFile(ydoc)`)
 * deep-equals `doc`.
 */
export function reconcile(doc: DesignFile, ydoc: Y.Doc): void {
  const root = ydoc.getMap(DESIGN_ROOT_KEY);
  ydoc.transact(() => {
    reconcileMap(root, doc as unknown as JsonObject);
  }, LOCAL_ORIGIN);
}

/**
 * Project a Y.Doc's design state back to a plain `DesignFile` (the inverse of
 * {@link reconcile}). Equivalent to @hc/schema's `toDesignFile`, but uses this
 * package's `Y` so it works on docs whose shared types were created here even
 * when a bundler hands the two packages distinct yjs module instances.
 */
export function fromDoc(ydoc: Y.Doc): DesignFile {
  return yToJson(ydoc.getMap(DESIGN_ROOT_KEY)) as DesignFile;
}

/**
 * Reconcile a single node's plain-JSON state into an existing Y.Map with minimal
 * ops (the same structural diff `reconcile` applies to the whole tree, scoped to
 * one node). Used by the server-side lock enforcement (`enforce.ts`) to revert a
 * protected node to its prior snapshot without touching sibling nodes. The
 * caller wraps this in its own (server-origin) transaction.
 */
export function reconcileNodeMap(target: Y.Map<unknown>, source: JsonObject): void {
  reconcileMap(target, source);
}
