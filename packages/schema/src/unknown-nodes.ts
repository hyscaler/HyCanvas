// Forward-compatibility helpers for node types written by a newer client
// (FR-3, FR-12, Section 5). Unknown types are never dropped: they are wrapped
// into an `UnknownNode` that preserves the original verbatim in `raw`, so an
// older client can render a placeholder and re-serialize the node identically.

import { isKnownNodeType, type Node, type NodeBase, type UnknownNode } from "./schema";

/** True when a node's `type` has no concrete schema in this client. */
export function isUnknownNode(node: Node): node is UnknownNode {
  return !isKnownNodeType(node.type);
}

const BASE_KEYS: (keyof NodeBase)[] = [
  "id", "type", "transform", "size", "opacity", "blendMode",
  "effects", "constraints", "locked", "hidden", "name", "link", "animations", "data",
];

/**
 * Wrap a raw node of an unrecognized type into an `UnknownNode`: known base
 * fields are surfaced for generic operations (select/move/lock/reorder) while
 * the complete original is preserved in `raw` for lossless round-trips.
 * Idempotent: a node that already carries `raw` is returned unchanged.
 */
export function wrapUnknownNode(node: Record<string, unknown>): UnknownNode {
  if ("raw" in node && node.raw && typeof node.raw === "object") {
    return node as unknown as UnknownNode;
  }
  const wrapped: Record<string, unknown> = { raw: { ...node } };
  for (const key of BASE_KEYS) {
    if (node[key] !== undefined) wrapped[key] = node[key];
  }
  return wrapped as unknown as UnknownNode;
}

/** Recover the original node object preserved inside an `UnknownNode`. */
export function unwrapUnknownNode(node: UnknownNode): Record<string, unknown> {
  return node.raw;
}
