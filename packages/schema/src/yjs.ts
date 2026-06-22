// Yjs bridge (Section 6.6). At edit time the design is a Yjs document;
// a database snapshot is a deterministic projection of that CRDT state. The
// mapping is generic and bidirectional: objects become Y.Map, arrays become
// Y.Array, primitives are stored as-is. This yields exactly the structure the
// spec describes (pages and children as Y.Arrays, scalar props as Y.Map entries)
// and is lossless, including UnknownNode.raw and `data` extension slots (AC-2).

import * as Y from "yjs";
import type { DesignFile } from "./schema";

/** Root Y.Map key holding the serialized design inside a Y.Doc. */
export const DESIGN_ROOT_KEY = "design";

type Json = unknown;

/**
 * Convert a plain JSON value into the equivalent Yjs shared type: objects become
 * Y.Map, arrays become Y.Array, primitives are returned as-is. Exported so the
 * realtime reconciler (`@hc/realtime`) can materialize new subtrees inside a
 * live Y.Doc using exactly the same mapping the snapshot bridge uses.
 */
export function toY(value: Json): unknown {
  if (Array.isArray(value)) {
    const arr = new Y.Array<unknown>();
    arr.push(value.map(toY));
    return arr;
  }
  if (value !== null && typeof value === "object") {
    const map = new Y.Map<unknown>();
    for (const [k, v] of Object.entries(value as Record<string, Json>)) {
      if (v !== undefined) map.set(k, toY(v));
    }
    return map;
  }
  return value; // string | number | boolean | null
}

/**
 * Project a Yjs shared type back to a plain JSON value (the inverse of
 * {@link toY}). Exported so consumers can read a subtree of a live Y.Doc without
 * round-tripping the whole document.
 */
export function fromY(value: unknown): Json {
  if (value instanceof Y.Array) {
    return value.toArray().map(fromY);
  }
  if (value instanceof Y.Map) {
    const obj: Record<string, Json> = {};
    for (const [k, v] of value.entries()) {
      obj[k] = fromY(v);
    }
    return obj;
  }
  return value;
}

/** Build a Yjs document from a `DesignFile` (the inverse of `toDesignFile`). */
export function fromDesignFile(file: DesignFile): Y.Doc {
  const doc = new Y.Doc();
  const root = doc.getMap(DESIGN_ROOT_KEY);
  for (const [k, v] of Object.entries(file)) {
    if (v !== undefined) root.set(k, toY(v));
  }
  return doc;
}

/** Project a Yjs document back to a plain `DesignFile`. Pure and lossless. */
export function toDesignFile(doc: Y.Doc): DesignFile {
  const root = doc.getMap(DESIGN_ROOT_KEY);
  const obj: Record<string, Json> = {};
  for (const [k, v] of root.entries()) {
    obj[k] = fromY(v);
  }
  return obj as unknown as DesignFile;
}
