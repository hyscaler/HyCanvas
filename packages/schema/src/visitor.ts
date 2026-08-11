// Generic scene-graph traversal shared by validate, the renderer,
// hit-testing, bounds, and serialization, so tree-walk logic lives in one place
//.

import type { Node, GroupNode, FrameNode, GridNode } from "./schema";

export type ContainerNode = GroupNode | FrameNode | GridNode;

/** A container node carries an ordered `children: Node[]` (FR-4). */
export function isContainer(node: Node): node is ContainerNode {
  return node.type === "group" || node.type === "frame" || node.type === "grid";
}

/** Children of a node, or an empty array for leaf nodes.
 *
 *  This is specifically the `children` ARRAY accessor. For "every node nested
 *  below this one, wherever it is stored", use `childNodesOf`. */
export function childrenOf(node: Node): Node[] {
  return isContainer(node) ? (node as ContainerNode).children : [];
}

/** Where a node type stores nested nodes outside `children`, and under which
 *  key, so a traversal can report an accurate path rather than guessing. */
type NestedSlot = { key: string; nodes: Node[]; indexed: boolean };

/**
 * Every node nested below this one, INCLUDING the ones stored outside
 * `children`.
 *
 * A mask keeps its single subject in `child` and a boolean keeps its inputs in
 * `operands`, so a walker that only ever reads `children` cannot see them. That
 * is not a cosmetic gap: it made a masked node invisible to id-uniqueness
 * validation, to comment anchoring, to version diffs, and to the scene build
 * itself, which is why masks did not render at all.
 *
 * The backend's write boundary (`persistence/validate.go`) already descends
 * into both slots, so ids nested there have always shared the one global
 * namespace. This makes the client agree with the server rather than widening
 * anything.
 */
export function nestedSlotsOf(node: Node): NestedSlot[] {
  const slots: NestedSlot[] = [];
  if (isContainer(node)) {
    slots.push({ key: "children", nodes: (node as ContainerNode).children ?? [], indexed: true });
  }
  // Type-gated, matching the Go boundary: a forward-compatible node that
  // happens to carry a `child` or `operands` field with a different meaning
  // must not be walked as if it held nodes.
  if (node.type === "mask") {
    const child = (node as unknown as { child?: Node }).child;
    if (child) slots.push({ key: "child", nodes: [child], indexed: false });
  }
  if (node.type === "boolean") {
    const operands = (node as unknown as { operands?: Node[] }).operands;
    if (operands && operands.length > 0) slots.push({ key: "operands", nodes: operands, indexed: true });
  }
  return slots;
}

/** Every nested node, flattened. Order is `children`, then `child`/`operands`. */
export function childNodesOf(node: Node): Node[] {
  const out: Node[] = [];
  for (const slot of nestedSlotsOf(node)) out.push(...slot.nodes);
  return out;
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
  // Recurses over a single NODE rather than a list, because the two slot shapes
  // produce different pointers: `children` and `operands` are arrays and take
  // an index, while a mask's `child` is one node and its pointer ends at the
  // key. A list-shaped recursion has to special-case the single-node slot at
  // every level, and gets it wrong the moment a mask contains a mask.
  const visitNode = (
    node: Node,
    path: Array<string | number>,
    depth: number,
    parent: Node | null,
  ): void => {
    visit(node, { path, depth, parent });
    for (const slot of nestedSlotsOf(node)) {
      const slotPath = [...path, slot.key];
      if (slot.indexed) {
        slot.nodes.forEach((child, i) => visitNode(child, [...slotPath, i], depth + 1, node));
      } else {
        visitNode(slot.nodes[0], slotPath, depth + 1, node);
      }
    }
  };
  nodes.forEach((node, index) => visitNode(node, [...basePath, index], 0, null));
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
