// Reversible edit commands. Every gesture emits one
// command; the global undo stack and keybindings live in the clipboard/shortcuts
// layer. Here we define
// the command data, their inverse, and how to apply them to the editable doc.

import {
  childrenOf,
  isContainer,
  type BlendMode,
  type DesignFile,
  type Effect,
  type Fill,
  type GroupNode,
  type Node,
  type Size,
  type Stroke,
  type Transform,
} from "@hc/schema";
import { fromTransform, multiply, transformRect, type Rect } from "@hc/engine";
import { decompose } from "./transform";
import { locate, removeNode } from "./tree";

export type NodeId = string;
export type ParentRef = NodeId | "page";

export type EditCommand =
  | {
      kind: "transform";
      nodes: NodeId[];
      before: Transform[];
      after: Transform[];
      beforeSizes?: Size[];
      afterSizes?: Size[];
    }
  | { kind: "reorder"; node: NodeId; fromIndex: number; toIndex: number; parent: ParentRef }
  | {
      kind: "reparent";
      node: NodeId;
      fromParent: ParentRef;
      toParent: ParentRef;
      fromIndex: number;
      toIndex: number;
      beforeTransform: Transform;
      afterTransform: Transform;
    }
  | { kind: "group"; groupId: NodeId; members: NodeId[]; parent: ParentRef }
  | { kind: "ungroup"; groupId: NodeId; members: NodeId[]; parent: ParentRef }
  | { kind: "setFlag"; node: NodeId; flag: "locked" | "hidden"; before: boolean; after: boolean }
  | { kind: "setOpacity"; node: NodeId; before: number; after: number }
  | { kind: "setBlend"; node: NodeId; before: BlendMode; after: BlendMode }
  | { kind: "setFills"; node: NodeId; before?: Fill[]; after?: Fill[] }
  | { kind: "setStroke"; node: NodeId; before?: Stroke; after?: Stroke }
  | { kind: "setEffects"; node: NodeId; before?: Effect[]; after?: Effect[] }
  | { kind: "insert"; parent: ParentRef; index: number; node: Node }
  | { kind: "remove"; parent: ParentRef; index: number; node: Node }
  | { kind: "rename"; node: NodeId; before?: string; after?: string };

/** A scene operation: the invertible op vocabulary every Command emits (FR-1).
 *  The history/transaction layer applies and reverses these. */
export type SceneOp = EditCommand;

export interface CommandRecord {
  id: string;
  command: EditCommand;
  ts: number;
  authorId?: string;
}

/** The inverse command, such that applying a command then its inverse is a no-op. */
export function invertCommand(cmd: EditCommand): EditCommand {
  switch (cmd.kind) {
    case "transform":
      return {
        ...cmd,
        before: cmd.after,
        after: cmd.before,
        beforeSizes: cmd.afterSizes,
        afterSizes: cmd.beforeSizes,
      };
    case "reorder":
      return { ...cmd, fromIndex: cmd.toIndex, toIndex: cmd.fromIndex };
    case "reparent":
      return {
        ...cmd,
        fromParent: cmd.toParent,
        toParent: cmd.fromParent,
        fromIndex: cmd.toIndex,
        toIndex: cmd.fromIndex,
        beforeTransform: cmd.afterTransform,
        afterTransform: cmd.beforeTransform,
      };
    case "group":
      return { kind: "ungroup", groupId: cmd.groupId, members: cmd.members, parent: cmd.parent };
    case "ungroup":
      return { kind: "group", groupId: cmd.groupId, members: cmd.members, parent: cmd.parent };
    case "setFlag":
      return { ...cmd, before: cmd.after, after: cmd.before };
    case "setOpacity":
      return { ...cmd, before: cmd.after, after: cmd.before };
    case "setBlend":
      return { ...cmd, before: cmd.after, after: cmd.before };
    case "setFills":
      return { ...cmd, before: cmd.after, after: cmd.before };
    case "setStroke":
      return { ...cmd, before: cmd.after, after: cmd.before };
    case "setEffects":
      return { ...cmd, before: cmd.after, after: cmd.before };
    case "insert":
      return { kind: "remove", parent: cmd.parent, index: cmd.index, node: cmd.node };
    case "remove":
      return { kind: "insert", parent: cmd.parent, index: cmd.index, node: cmd.node };
    case "rename":
      return { ...cmd, before: cmd.after, after: cmd.before };
  }
}

function siblingsForParent(file: DesignFile, parent: ParentRef): Node[] | null {
  if (parent === "page") return file.pages[0].children;
  const loc = locate(file, parent);
  return loc && isContainer(loc.node) ? childrenOf(loc.node) : null;
}

function parentSpaceAABB(node: Node): Rect {
  return transformRect(fromTransform(node.transform), {
    x: 0,
    y: 0,
    width: node.size.width,
    height: node.size.height,
  });
}

/** Apply a command to the editable document, mutating it in place. */
export function applyCommand(file: DesignFile, cmd: EditCommand): void {
  switch (cmd.kind) {
    case "transform": {
      cmd.nodes.forEach((id, i) => {
        const loc = locate(file, id);
        if (!loc) return;
        loc.node.transform = cmd.after[i];
        if (cmd.afterSizes?.[i]) loc.node.size = cmd.afterSizes[i];
      });
      return;
    }
    case "setFlag": {
      const loc = locate(file, cmd.node);
      if (loc) (loc.node as unknown as Record<string, unknown>)[cmd.flag] = cmd.after;
      return;
    }
    case "setOpacity": {
      const loc = locate(file, cmd.node);
      if (loc) loc.node.opacity = cmd.after;
      return;
    }
    case "setBlend": {
      const loc = locate(file, cmd.node);
      if (loc) loc.node.blendMode = cmd.after;
      return;
    }
    case "setFills": {
      const loc = locate(file, cmd.node);
      if (!loc) return;
      const node = loc.node as unknown as Record<string, unknown>;
      if (cmd.after === undefined) delete node.fills;
      else node.fills = cmd.after;
      return;
    }
    case "setStroke": {
      const loc = locate(file, cmd.node);
      if (!loc) return;
      const node = loc.node as unknown as Record<string, unknown>;
      if (cmd.after === undefined) delete node.stroke;
      else node.stroke = cmd.after;
      return;
    }
    case "setEffects": {
      const loc = locate(file, cmd.node);
      if (!loc) return;
      const node = loc.node as unknown as Record<string, unknown>;
      if (cmd.after === undefined) delete node.effects;
      else node.effects = cmd.after;
      return;
    }
    case "insert": {
      const siblings = siblingsForParent(file, cmd.parent);
      if (!siblings) return;
      const at = Math.max(0, Math.min(cmd.index, siblings.length));
      siblings.splice(at, 0, cmd.node);
      return;
    }
    case "remove": {
      const siblings = siblingsForParent(file, cmd.parent);
      if (!siblings) return;
      const at = siblings.findIndex((n) => n.id === cmd.node.id);
      if (at >= 0) siblings.splice(at, 1);
      return;
    }
    case "rename": {
      const loc = locate(file, cmd.node);
      if (loc) loc.node.name = cmd.after;
      return;
    }
    case "reorder": {
      const siblings = siblingsForParent(file, cmd.parent);
      if (!siblings) return;
      const from = siblings.findIndex((n) => n.id === cmd.node);
      if (from < 0) return;
      const [node] = siblings.splice(from, 1);
      const to = Math.max(0, Math.min(cmd.toIndex, siblings.length));
      siblings.splice(to, 0, node);
      return;
    }
    case "reparent": {
      const loc = removeNode(file, cmd.node);
      if (!loc) return;
      loc.node.transform = cmd.afterTransform;
      const target = siblingsForParent(file, cmd.toParent);
      if (!target) return;
      // Insert at the recorded index so z-order is preserved (and restored on
      // undo) instead of always appending to the end.
      const at = Math.max(0, Math.min(cmd.toIndex, target.length));
      target.splice(at, 0, loc.node);
      return;
    }
    case "group":
      applyGroup(file, cmd.groupId, cmd.members, cmd.parent);
      return;
    case "ungroup":
      applyUngroup(file, cmd.groupId);
      return;
  }
}

/** Collect members under a new identity-positioned group; visuals are preserved
 *  because the group is a pure translation to the members' bounding origin. */
export function applyGroup(
  file: DesignFile,
  groupId: NodeId,
  members: NodeId[],
  parent: ParentRef,
): GroupNode | null {
  const siblings = siblingsForParent(file, parent);
  if (!siblings) return null;
  const memberSet = new Set(members);

  // Union AABB of members in parent space; the group origin sits there.
  let union: Rect | null = null;
  for (const n of siblings) {
    if (!memberSet.has(n.id)) continue;
    const b = parentSpaceAABB(n);
    union = union ? rectUnion(union, b) : b;
  }
  if (!union) return null;

  const insertAt = siblings.findIndex((n) => memberSet.has(n.id));
  const children: Node[] = [];
  for (let i = siblings.length - 1; i >= 0; i--) {
    if (memberSet.has(siblings[i].id)) {
      const [child] = siblings.splice(i, 1);
      // Offset child into group-local space (group is translate-only, identity scale/rot).
      child.transform = {
        ...child.transform,
        x: child.transform.x - union.x,
        y: child.transform.y - union.y,
      };
      children.unshift(child);
    }
  }

  const group: GroupNode = {
    id: groupId,
    type: "group",
    transform: { x: union.x, y: union.y, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: union.width, height: union.height },
    opacity: 1,
    blendMode: "normal",
    aspectLocked: true,
    children,
  };
  siblings.splice(Math.max(0, insertAt), 0, group);
  return group;
}

/** Dissolve a group, baking its transform into each child to preserve visuals. */
export function applyUngroup(file: DesignFile, groupId: NodeId): NodeId[] {
  const loc = locate(file, groupId);
  if (!loc || loc.node.type !== "group") return [];
  const group = loc.node as GroupNode;
  const groupMatrix = fromTransform(group.transform);

  const restored: Node[] = group.children.map((child) => {
    const childWorld = multiply(groupMatrix, fromTransform(child.transform));
    return { ...child, transform: { ...decompose(childWorld) } };
  });

  loc.siblings.splice(loc.index, 1, ...restored);
  return restored.map((n) => n.id);
}

function rectUnion(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}
