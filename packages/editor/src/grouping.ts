// Grouping (FR-20, FR-21). group() collects selected siblings under a new
// GroupNode preserving world transforms; ungroup() dissolves a group, baking its
// transform back into the children. Both return the reversible EditCommand.

import type { DesignFile } from "@hc/schema";
import { applyGroup, applyUngroup, type EditCommand, type ParentRef } from "./commands";
import { locate } from "./tree";

function newId(): string {
  return globalThis.crypto.randomUUID();
}

function parentRefOf(file: DesignFile, id: string): ParentRef {
  const loc = locate(file, id);
  return loc && loc.parent ? loc.parent.id : "page";
}

/** Group selected nodes; returns the new group id and the command performed. */
export function group(
  file: DesignFile,
  ids: string[],
  groupId: string = newId(),
): { groupId: string; command: EditCommand } | null {
  if (ids.length === 0) return null;
  const parent = parentRefOf(file, ids[0]);
  const created = applyGroup(file, groupId, ids, parent);
  if (!created) return null;
  return { groupId, command: { kind: "group", groupId, members: ids, parent } };
}

/** Ungroup a group; returns the freed child ids and the command performed. */
export function ungroup(
  file: DesignFile,
  groupId: string,
): { members: string[]; command: EditCommand } | null {
  const loc = locate(file, groupId);
  if (!loc || loc.node.type !== "group") return null;
  const parent = loc.parent ? loc.parent.id : "page";
  const members = applyUngroup(file, groupId);
  return { members, command: { kind: "ungroup", groupId, members, parent } };
}
