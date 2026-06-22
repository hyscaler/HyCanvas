// Scene-tree navigation helpers shared across the editor controller: locate a
// node and its parent/siblings, compute world matrices and axis-aligned bounds,
// and move nodes between sibling arrays. Operates on a plain DesignFile (the
// editable doc); under collaboration the same ops run inside a Yjs txn.

import {
  childrenOf,
  isContainer,
  type DesignFile,
  type Node,
  type Page,
} from "@hc/schema";
import {
  fromTransform,
  identity,
  invert,
  multiply,
  transformRect,
  type Mat2D,
  type Rect,
} from "@hc/engine";

export interface NodeLocation {
  node: Node;
  /** The containing group/frame/grid, or null when the node is a direct page child. */
  parent: Node | null;
  /** The children array the node lives in (page.children or container.children). */
  siblings: Node[];
  index: number;
  page: Page;
}

/** Find a node anywhere in the document, with its parent, siblings, and index. */
export function locate(file: DesignFile, id: string): NodeLocation | null {
  for (const page of file.pages) {
    const found = locateIn(page.children, id, null, page);
    if (found) return found;
  }
  return null;
}

function locateIn(
  siblings: Node[],
  id: string,
  parent: Node | null,
  page: Page,
): NodeLocation | null {
  for (let i = 0; i < siblings.length; i++) {
    const node = siblings[i];
    if (node.id === id) return { node, parent, siblings, index: i, page };
    if (isContainer(node)) {
      const inner = locateIn(childrenOf(node), id, node, page);
      if (inner) return inner;
    }
  }
  return null;
}

/** Map of every node id to the node, across all pages. */
export function nodeMap(file: DesignFile): Map<string, Node> {
  const m = new Map<string, Node>();
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      m.set(n.id, n);
      if (isContainer(n)) walk(childrenOf(n));
    }
  };
  for (const page of file.pages) walk(page.children);
  return m;
}

/** Local->world matrix for a node, composing the chain from the page root. */
export function worldMatrix(file: DesignFile, id: string): Mat2D | null {
  for (const page of file.pages) {
    const chain = matrixChain(page.children, id, identity());
    if (chain) return chain;
  }
  return null;
}

function matrixChain(siblings: Node[], id: string, parentWorld: Mat2D): Mat2D | null {
  for (const node of siblings) {
    const world = multiply(parentWorld, fromTransform(node.transform));
    if (node.id === id) return world;
    if (isContainer(node)) {
      const inner = matrixChain(childrenOf(node), id, world);
      if (inner) return inner;
    }
  }
  return null;
}

/** Axis-aligned page-space bounds of a node (its box under the world matrix). */
export function worldAABB(file: DesignFile, id: string): Rect | null {
  const loc = locate(file, id);
  const world = worldMatrix(file, id);
  if (!loc || !world) return null;
  return transformRect(world, {
    x: 0,
    y: 0,
    width: loc.node.size.width,
    height: loc.node.size.height,
  });
}

/** The page-space AABB enclosing several nodes. */
export function unionAABB(file: DesignFile, ids: string[]): Rect | null {
  let out: Rect | null = null;
  for (const id of ids) {
    const b = worldAABB(file, id);
    if (!b) continue;
    out = out ? rectUnion(out, b) : b;
  }
  return out;
}

function rectUnion(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Convert a page-space drag delta into the node's PARENT space, so move/resize
 * track the cursor even when the node lives inside a rotated/scaled group. For
 * a top-level node the parent is the page (identity), so the delta is returned
 * unchanged.
 */
export function parentSpaceDelta(
  file: DesignFile,
  id: string,
  dx: number,
  dy: number,
): { dx: number; dy: number } {
  const world = worldMatrix(file, id);
  const loc = locate(file, id);
  if (!world || !loc) return { dx, dy };
  const localInv = invert(fromTransform(loc.node.transform));
  if (!localInv) return { dx, dy };
  // parentWorld = world * inverse(local); independent of the node's own transform.
  const pw = multiply(world, localInv);
  const det = pw.a * pw.d - pw.b * pw.c;
  if (Math.abs(det) < 1e-12) return { dx, dy };
  return {
    dx: (pw.d * dx - pw.c * dy) / det,
    dy: (-pw.b * dx + pw.a * dy) / det,
  };
}

/** Children array a node belongs to is mutated in place by these helpers. */
export function removeNode(file: DesignFile, id: string): NodeLocation | null {
  const loc = locate(file, id);
  if (!loc) return null;
  loc.siblings.splice(loc.index, 1);
  return loc;
}
