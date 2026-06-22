// Generic scene-graph traversal shared by validate, the renderer,
// hit-testing, bounds, and serialization, so tree-walk logic lives in one place
//.

import type { Node, GroupNode, FrameNode, GridNode } from "./schema";

export type ContainerNode = GroupNode | FrameNode | GridNode;

/** A container node carries an ordered `children: Node[]` (FR-4). */
export function isContainer(node: Node): node is ContainerNode {
  return node.type === "group" || node.type === "frame" || node.type === "grid";
}

/** Children of a node, or an empty array for leaf nodes. */
export function childrenOf(node: Node): Node[] {
  return isContainer(node) ? (node as ContainerNode).children : [];
}

export interface VisitInfo {
  /** JSON-pointer-style path segments from the page to this node. */
  path: Array<string | number>;
  /** Container nesting depth; top-level page children are depth 0. */
  depth: number;
  parent: Node | null;
}

export type Visitor = (node: Node, info: VisitInfo) => void;

/**
 * Depth-first, pre-order walk over a list of nodes (a page's `children`).
 * `basePath` is prepended to every reported path so callers can anchor the
 * pointer at, for example, `["pages", 0, "children"]`.
 */
export function walkNodes(
  nodes: Node[],
  visit: Visitor,
  basePath: Array<string | number> = [],
): void {
  const recurse = (
    list: Node[],
    pathPrefix: Array<string | number>,
    depth: number,
    parent: Node | null,
  ): void => {
    list.forEach((node, index) => {
      const path = [...pathPrefix, index];
      visit(node, { path, depth, parent });
      if (isContainer(node)) {
        recurse(childrenOf(node), [...path, "children"], depth + 1, node);
      }
    });
  };
  recurse(nodes, basePath, 0, null);
}

/** Collect every node id in document order. */
export function collectIds(nodes: Node[]): string[] {
  const ids: string[] = [];
  walkNodes(nodes, (node) => ids.push(node.id));
  return ids;
}

/** The deepest container nesting level present (0 for a flat list). */
export function maxDepth(nodes: Node[]): number {
  let max = 0;
  walkNodes(nodes, (_node, info) => {
    if (info.depth > max) max = info.depth;
  });
  return max;
}
