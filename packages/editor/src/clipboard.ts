// Clipboard, duplicate, and copy-style/paste-style. All of
// these produce a self-contained scene fragment or a set of SceneOps; the OS
// clipboard interop (async Clipboard API, PNG snapshot, MIME mirror) and the
// off-main-thread serialization belong to the browser layer and are deferred.
//
// A copied payload reuses the open file format's `Node` shape, so a
// selection is essentially a mini design and cross-design/cross-tab paste keeps
// full fidelity. Pasted nodes get fresh ids with internal references rewritten.

import {
  childrenOf,
  type BlendMode,
  type DesignFile,
  type Effect,
  type Fill,
  type Node,
  type Stroke,
} from "@hc/schema";
import { locate, unionAABB } from "./tree";
import type { ParentRef, SceneOp } from "./commands";

export const CLIPBOARD_SCHEMA_VERSION = 1;
export const DEFAULT_PASTE_OFFSET = 16; // px, down-right cascade (FR-3)

export interface ClipboardPayload {
  format: "hycanvas.clipboard";
  schemaVersion: number;
  source: { designId: string; pageId: string };
  nodes: Node[]; // self-contained scene fragment (top-level selection)
  assetIds: string[]; // referenced assets so cross-design paste can import them
  bounds: { x: number; y: number; width: number; height: number };
}

export interface StyleClip {
  fills?: Fill[];
  stroke?: Stroke;
  effects?: Effect[];
  opacity?: number;
  blendMode?: BlendMode;
}

// Node types that carry node-level fills / strokes. Text fills live per run
// and are intentionally out of node-level copy-style for now.
const FILL_NODES = new Set(["shape", "path", "icon", "sticker", "frame", "grid", "boolean"]);
const STROKE_NODES = new Set(["shape", "path", "line", "frame", "grid", "connector", "boolean"]);

type AnyRec = Record<string, unknown>;

/** Visit a node and every descendant (container children, mask child, boolean operands). */
function visitTree(node: Node, fn: (n: Node) => void): void {
  fn(node);
  for (const c of childrenOf(node)) visitTree(c, fn);
  const rec = node as unknown as AnyRec;
  if (node.type === "mask" && rec.child) visitTree(rec.child as Node, fn);
  if (node.type === "boolean" && Array.isArray(rec.operands)) {
    for (const op of rec.operands as Node[]) visitTree(op, fn);
  }
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Asset ids referenced by a fragment (image sources, pattern/image fills). */
export function collectAssetIds(nodes: Node[]): string[] {
  const ids = new Set<string>();
  const scanFills = (fills: unknown) => {
    if (!Array.isArray(fills)) return;
    for (const f of fills as AnyRec[]) {
      if (f && (f.type === "pattern" || f.type === "image")) {
        const src = f.source as AnyRec | undefined;
        const a = (src?.assetId ?? f.assetId) as string | undefined;
        if (a) ids.add(a);
      }
    }
  };
  for (const root of nodes) {
    visitTree(root, (n) => {
      const rec = n as unknown as AnyRec;
      if (n.type === "image") {
        const src = rec.source as AnyRec | undefined;
        if (src?.assetId) ids.add(src.assetId as string);
      }
      scanFills(rec.fills);
    });
  }
  return [...ids];
}

/**
 * The selection "roots": ids that are not a descendant of another selected id.
 * Operations like copy/duplicate/delete act on roots so a container and one of
 * its own descendants are not processed twice.
 */
export function selectionRoots(file: DesignFile, selection: string[]): string[] {
  const selSet = new Set(selection);
  return selection.filter((id) => {
    const loc = locate(file, id);
    if (!loc) return false;
    let p = loc.parent;
    while (p) {
      if (selSet.has(p.id)) return false;
      const pl = locate(file, p.id);
      p = pl ? pl.parent : null;
    }
    return true;
  });
}

/**
 * Serialize the top-level selection into a native clipboard payload (FR-2).
 * Descendants of a selected container are carried within it, not duplicated as
 * top-level entries.
 */
export function serializeSelection(
  file: DesignFile,
  selection: string[],
  source: { designId: string; pageId: string },
): ClipboardPayload | null {
  if (selection.length === 0) return null;
  const roots = selectionRoots(file, selection);
  const nodes = roots
    .map((id) => locate(file, id))
    .filter((l): l is NonNullable<typeof l> => !!l)
    .map((l) => deepClone(l.node));
  if (nodes.length === 0) return null;
  const b = unionAABB(file, roots) ?? { x: 0, y: 0, width: 0, height: 0 };
  return {
    format: "hycanvas.clipboard",
    schemaVersion: CLIPBOARD_SCHEMA_VERSION,
    source,
    nodes,
    assetIds: collectAssetIds(nodes),
    bounds: b,
  };
}

let pasteIdCounter = 0;
/** Default fresh-id generator; pass a custom one in tests for determinism. */
export function defaultIdGen(): string {
  return `n-${++pasteIdCounter}`;
}

/**
 * Clone a fragment with fresh ids, rewriting internal references (connector
 * endpoint attachments) so a paste is self-consistent. Returns the new nodes
 * and the old->new id map.
 */
export function remapIds(
  nodes: Node[],
  idGen: () => string = defaultIdGen,
): { nodes: Node[]; idMap: Map<string, string> } {
  const cloned = deepClone(nodes);
  const idMap = new Map<string, string>();
  for (const root of cloned) {
    visitTree(root, (n) => {
      const fresh = idGen();
      idMap.set(n.id, fresh);
      n.id = fresh;
    });
  }
  // Rewrite connector endpoint attachments that point inside the fragment.
  for (const root of cloned) {
    visitTree(root, (n) => {
      if (n.type !== "connector") return;
      const rec = n as unknown as AnyRec;
      for (const key of ["start", "end"] as const) {
        const ep = rec[key] as AnyRec | undefined;
        const attach = ep?.attach as AnyRec | undefined;
        const old = attach?.nodeId as string | undefined;
        if (old && idMap.has(old)) attach!.nodeId = idMap.get(old);
      }
    });
  }
  return { nodes: cloned, idMap };
}

/** Translate the fragment's top-level nodes by (dx, dy) in place. */
function offsetNodes(nodes: Node[], dx: number, dy: number): void {
  for (const n of nodes) {
    n.transform = { ...n.transform, x: n.transform.x + dx, y: n.transform.y + dy };
  }
}

export interface PasteOptions {
  /** "normal" centers the fragment on `at` and cascades; "in-place" keeps coords. */
  mode: "normal" | "in-place";
  /** Page-space point to center the fragment's bounding box on (viewport center). */
  at?: { x: number; y: number };
  /** Repeat index for the cascade offset (0 for the first paste). */
  cascadeIndex?: number;
  idGen?: () => string;
}

export interface PasteResult {
  ops: SceneOp[];
  nodeIds: string[];
  nodes: Node[];
}

/**
 * Produce the insert ops for pasting a payload into the first page (FR-3).
 * Fresh ids are assigned; normal paste centers the fragment's bounding box on
 * `at` (the viewport center) with a cascade offset, in-place paste keeps the
 * original coordinates. Always targets page 0 (the editor core is page-0
 * scoped; cross-page paste lands with multi-page support).
 */
export function pasteOps(file: DesignFile, payload: ClipboardPayload, opts: PasteOptions): PasteResult {
  const { nodes } = remapIds(payload.nodes, opts.idGen);
  if (opts.mode === "normal") {
    const cascade = (opts.cascadeIndex ?? 0) * DEFAULT_PASTE_OFFSET;
    // Center the fragment's bounding box on `at`, then cascade down-right.
    const center = {
      x: payload.bounds.x + payload.bounds.width / 2,
      y: payload.bounds.y + payload.bounds.height / 2,
    };
    const at = opts.at ?? center;
    const dx = at.x - center.x + cascade;
    const dy = at.y - center.y + cascade;
    offsetNodes(nodes, dx, dy);
  }
  const children = file.pages[0].children;
  const start = children.length;
  const ops: SceneOp[] = nodes.map((node, i) => ({
    kind: "insert",
    parent: "page" as ParentRef,
    index: start + i,
    node,
  }));
  return { ops, nodeIds: nodes.map((n) => n.id), nodes };
}

export interface DuplicateResult {
  ops: SceneOp[];
  nodeIds: string[];
}

/**
 * Duplicate the selection roots with a fresh id each, offset by (offset) and
 * appended after their original parent's children (FR-5). The same `offset`
 * passed to a subsequent duplicate implements power-duplicate. Selection is
 * reduced to roots so a container and its own descendant are not cloned twice.
 */
export function duplicateOps(
  file: DesignFile,
  selection: string[],
  offset: { x: number; y: number } = { x: DEFAULT_PASTE_OFFSET, y: DEFAULT_PASTE_OFFSET },
  idGen: () => string = defaultIdGen,
): DuplicateResult {
  const ops: SceneOp[] = [];
  const nodeIds: string[] = [];
  // Track how many clones we have appended to each parent so successive clones
  // into the same parent get increasing indices (preserving their order).
  const appended = new Map<string, number>();
  for (const id of selectionRoots(file, selection)) {
    const loc = locate(file, id);
    if (!loc) continue;
    const { nodes } = remapIds([loc.node], idGen);
    const clone = nodes[0];
    offsetNodes([clone], offset.x, offset.y);
    const parent: ParentRef = loc.parent ? loc.parent.id : "page";
    const extra = appended.get(parent) ?? 0;
    ops.push({ kind: "insert", parent, index: loc.siblings.length + extra, node: clone });
    appended.set(parent, extra + 1);
    nodeIds.push(clone.id);
  }
  return { ops, nodeIds };
}

/**
 * Produce remove ops for the selection roots, ordered so undo restores them to
 * their original positions (FR-7). This is the engine behind delete and the
 * removal half of cut. Removes are emitted in descending document index so that
 * their inverse inserts (applied in reverse) re-create ascending indices.
 */
export function removeSelectionOps(file: DesignFile, selection: string[]): SceneOp[] {
  const locs = selectionRoots(file, selection)
    .map((id) => locate(file, id))
    .filter((l): l is NonNullable<typeof l> => !!l)
    .sort((a, b) => b.index - a.index);
  return locs.map((loc) => ({
    kind: "remove",
    parent: (loc.parent ? loc.parent.id : "page") as ParentRef,
    index: loc.index,
    node: loc.node,
  }));
}

export interface CutResult {
  payload: ClipboardPayload | null;
  ops: SceneOp[];
}

/** Cut = copy the selection to a payload, then remove it (FR, AC-1 path). */
export function cut(
  file: DesignFile,
  selection: string[],
  source: { designId: string; pageId: string },
): CutResult {
  return {
    payload: serializeSelection(file, selection, source),
    ops: removeSelectionOps(file, selection),
  };
}

/** Capture style-only properties from a node (FR-6). */
export function captureStyle(file: DesignFile, nodeId: string): StyleClip | null {
  const loc = locate(file, nodeId);
  if (!loc) return null;
  const rec = loc.node as unknown as AnyRec;
  const clip: StyleClip = {};
  if (Array.isArray(rec.fills)) clip.fills = deepClone(rec.fills as Fill[]);
  if (rec.stroke) clip.stroke = deepClone(rec.stroke as Stroke);
  if (Array.isArray(rec.effects)) clip.effects = deepClone(rec.effects as Effect[]);
  clip.opacity = loc.node.opacity;
  clip.blendMode = loc.node.blendMode;
  return clip;
}

export interface PasteStyleResult {
  ops: SceneOp[];
  /** Which style fields were applied to each target node id. */
  applied: Record<string, string[]>;
}

/**
 * Apply a captured style to the selection, adapting per node type and reporting
 * what was applied (FR-6, AC-4). Fills/strokes are skipped on node types that
 * do not support them (for example, text fills live per run).
 */
export function pasteStyleOps(file: DesignFile, selection: string[], clip: StyleClip): PasteStyleResult {
  const ops: SceneOp[] = [];
  const applied: Record<string, string[]> = {};
  for (const id of selection) {
    const loc = locate(file, id);
    if (!loc || loc.node.locked) continue; // never restyle a locked node
    const type = loc.node.type;
    const rec = loc.node as unknown as AnyRec;
    const fields: string[] = [];
    if (clip.fills && FILL_NODES.has(type)) {
      ops.push({ kind: "setFills", node: id, before: rec.fills as Fill[] | undefined, after: deepClone(clip.fills) });
      fields.push("fill");
    }
    if (clip.stroke && STROKE_NODES.has(type)) {
      ops.push({ kind: "setStroke", node: id, before: rec.stroke as Stroke | undefined, after: deepClone(clip.stroke) });
      fields.push("stroke");
    }
    if (clip.effects) {
      ops.push({ kind: "setEffects", node: id, before: rec.effects as Effect[] | undefined, after: deepClone(clip.effects) });
      fields.push("effects");
    }
    if (clip.opacity !== undefined && clip.opacity !== loc.node.opacity) {
      ops.push({ kind: "setOpacity", node: id, before: loc.node.opacity, after: clip.opacity });
      fields.push("opacity");
    }
    if (clip.blendMode !== undefined && clip.blendMode !== loc.node.blendMode) {
      ops.push({ kind: "setBlend", node: id, before: loc.node.blendMode, after: clip.blendMode });
      fields.push("blendMode");
    }
    if (fields.length) applied[id] = fields;
  }
  return { ops, applied };
}
