// Region extraction / conversion (FR-13). Clones a frame, a node selection, or
// a marquee rect out of a whiteboard DesignFile into a fresh DesignFile, one
// page per logical region. Coordinates are localized to each page origin and
// node ids are regenerated. Pure: the input design is never mutated.

import {
  createBlankDesign,
  newId,
  type DesignFile,
  type FrameNode,
  type Node,
  type Page,
} from "@hc/schema";
import type { Box } from "./routing";

export interface RegionScope {
  frameId?: string;
  nodeIds?: string[];
  rect?: Box;
}

export interface ExtractOpts {
  target?: "design" | "presentation";
}

/** Axis-aligned bounds of a node from its transform translate + size. */
function nodeBox(node: Node): Box {
  const x = node.transform?.x ?? 0;
  const y = node.transform?.y ?? 0;
  const width = node.size?.width ?? 0;
  const height = node.size?.height ?? 0;
  return { x, y, width, height };
}

function boxesIntersect(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function unionBounds(nodes: Node[]): Box {
  if (nodes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const b = nodeBox(n);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Structured deep clone (no shared references with the input). */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Deep-copy a node tree, regenerating every id (including nested children). */
function cloneWithNewIds(node: Node): Node {
  const copy = deepClone(node);
  regenIds(copy);
  return copy;
}

function regenIds(node: Node): void {
  node.id = newId();
  const anyNode = node as unknown as { children?: Node[]; child?: Node };
  if (Array.isArray(anyNode.children)) {
    for (const c of anyNode.children) regenIds(c);
  }
  if (anyNode.child) regenIds(anyNode.child);
}

/** Translate a node's top-level position by (-dx, -dy) to page-local space. */
function localize(node: Node, dx: number, dy: number): void {
  if (node.transform) {
    node.transform = { ...node.transform, x: node.transform.x - dx, y: node.transform.y - dy };
  }
}

function isFrame(node: Node): node is FrameNode {
  return node.type === "frame";
}

/** Collect every node on every page of the design (top-level only per page). */
function findFrame(design: DesignFile, frameId: string): { frame: FrameNode } | undefined {
  for (const page of design.pages) {
    for (const node of page.children) {
      if (node.id === frameId && isFrame(node)) return { frame: node };
    }
  }
  return undefined;
}

function makePage(name: string, nodes: Node[], origin: Box): Page {
  const localized = nodes.map((n) => {
    const c = cloneWithNewIds(n);
    localize(c, origin.x, origin.y);
    return c;
  });
  return {
    id: newId(),
    name,
    width: Math.max(1, origin.width),
    height: Math.max(1, origin.height),
    children: localized,
  };
}

/**
 * Build a new DesignFile from a region of `design`.
 *  - frameId pointing at a frame that itself contains child frames (sections):
 *    one page per child frame (its own children localized to that section).
 *  - frameId pointing at a plain frame: one page with the frame's children.
 *  - nodeIds: one page with the selected nodes (searched across all pages).
 *  - rect: one page with all top-level nodes intersecting the rect.
 */
export function extractRegion(
  design: DesignFile,
  scope: RegionScope,
  opts: ExtractOpts = {},
): DesignFile {
  const out = createBlankDesign({ title: design.title, unit: design.unit });
  out.meta = { ...design.meta, kind: "whiteboard", extractedTarget: opts.target ?? "design" };

  const pages: Page[] = [];

  if (scope.frameId) {
    const found = findFrame(design, scope.frameId);
    if (!found) {
      out.pages = [makePage("Page 1", [], { x: 0, y: 0, width: 1, height: 1 })];
      return out;
    }
    const frame = found.frame;
    const childFrames = frame.children.filter(isFrame);
    if (childFrames.length > 0) {
      // Sectioned frame: one page per child frame.
      for (const section of childFrames) {
        const origin = nodeBox(section);
        const nodes = section.children;
        pages.push(makePage(section.name ?? "Section", nodes, origin));
      }
    } else {
      const origin = nodeBox(frame);
      pages.push(makePage(frame.name ?? "Frame", frame.children, origin));
    }
  } else if (scope.nodeIds && scope.nodeIds.length > 0) {
    const idSet = new Set(scope.nodeIds);
    const selected: Node[] = [];
    for (const page of design.pages) {
      for (const node of page.children) {
        if (idSet.has(node.id)) selected.push(node);
      }
    }
    const origin = unionBounds(selected);
    pages.push(makePage("Page 1", selected, origin));
  } else if (scope.rect) {
    const rect = scope.rect;
    const hit: Node[] = [];
    for (const page of design.pages) {
      for (const node of page.children) {
        if (boxesIntersect(nodeBox(node), rect)) hit.push(node);
      }
    }
    pages.push(makePage("Page 1", hit, rect));
  } else {
    pages.push(makePage("Page 1", [], { x: 0, y: 0, width: 1, height: 1 }));
  }

  out.pages = pages.length > 0 ? pages : [makePage("Page 1", [], { x: 0, y: 0, width: 1, height: 1 })];
  return out;
}
