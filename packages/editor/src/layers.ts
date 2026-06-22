// Per-node layer state: lock, hide, isolate, opacity, blend, rename (FR-22..FR-24).
// Each mutating op returns the reversible EditCommand it performed (or null if
// the node was not found) so the caller can push it to the undo stack.

import type { BlendMode, DesignFile } from "@hc/schema";
import type { EditCommand } from "./commands";
import { locate } from "./tree";

export function setLocked(file: DesignFile, id: string, value: boolean): EditCommand | null {
  const loc = locate(file, id);
  if (!loc) return null;
  const before = !!loc.node.locked;
  loc.node.locked = value;
  return { kind: "setFlag", node: id, flag: "locked", before, after: value };
}

export function setHidden(file: DesignFile, id: string, value: boolean): EditCommand | null {
  const loc = locate(file, id);
  if (!loc) return null;
  const before = !!loc.node.hidden;
  loc.node.hidden = value;
  return { kind: "setFlag", node: id, flag: "hidden", before, after: value };
}

export function setOpacity(file: DesignFile, id: string, value: number): EditCommand | null {
  const loc = locate(file, id);
  if (!loc) return null;
  const before = loc.node.opacity;
  const after = Math.max(0, Math.min(1, value));
  loc.node.opacity = after;
  return { kind: "setOpacity", node: id, before, after };
}

export function setBlend(file: DesignFile, id: string, mode: BlendMode): EditCommand | null {
  const loc = locate(file, id);
  if (!loc) return null;
  const before = loc.node.blendMode;
  loc.node.blendMode = mode;
  return { kind: "setBlend", node: id, before, after: mode };
}

export function rename(file: DesignFile, id: string, name: string): EditCommand | null {
  const loc = locate(file, id);
  if (!loc) return null;
  const before = loc.node.name;
  loc.node.name = name;
  return { kind: "rename", node: id, before, after: name };
}

/**
 * Isolate (solo): the sibling node ids that should be hidden so only `id` (and
 * its subtree) is visible. Returns [] when `id` is null (isolation cleared).
 * Isolation is a transient editor concern, so this computes the set rather than
 * mutating persisted `hidden` flags (FR-23).
 */
export function isolationHiddenSiblings(file: DesignFile, id: string | null): string[] {
  if (!id) return [];
  const loc = locate(file, id);
  if (!loc) return [];
  return loc.siblings.filter((n) => n.id !== id).map((n) => n.id);
}
