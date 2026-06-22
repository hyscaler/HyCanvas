// Align, distribute, tidy-up, and z-order (FR-16..FR-18). Geometry functions
// take page-space AABBs (from tree.worldAABB) and return per-id position deltas
// the caller applies via a transform command; order() returns the reordered
// children array (back-to-front).

import type { Node } from "@hc/schema";
import type { Rect } from "@hc/engine";

export interface ArrangeItem {
  id: string;
  bounds: Rect;
}
export type Delta = { dx: number; dy: number };
export type AlignEdge = "left" | "hcenter" | "right" | "top" | "vmiddle" | "bottom";

export function alignDeltas(items: ArrangeItem[], edge: AlignEdge, target: Rect): Map<string, Delta> {
  const out = new Map<string, Delta>();
  for (const it of items) {
    const b = it.bounds;
    let dx = 0;
    let dy = 0;
    switch (edge) {
      case "left":
        dx = target.x - b.x;
        break;
      case "hcenter":
        dx = target.x + target.width / 2 - (b.x + b.width / 2);
        break;
      case "right":
        dx = target.x + target.width - (b.x + b.width);
        break;
      case "top":
        dy = target.y - b.y;
        break;
      case "vmiddle":
        dy = target.y + target.height / 2 - (b.y + b.height / 2);
        break;
      case "bottom":
        dy = target.y + target.height - (b.y + b.height);
        break;
    }
    out.set(it.id, { dx, dy });
  }
  return out;
}

/** Distribute 3+ items evenly, by leading edge or by equal gaps (FR-17). */
export function distributeDeltas(
  items: ArrangeItem[],
  axis: "h" | "v",
  by: "edge" | "gap",
): Map<string, Delta> {
  const out = new Map<string, Delta>();
  if (items.length < 3) return out;
  const pos = (b: Rect) => (axis === "h" ? b.x : b.y);
  const size = (b: Rect) => (axis === "h" ? b.width : b.height);
  const sorted = [...items].sort((a, b) => pos(a.bounds) - pos(b.bounds));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  if (by === "edge") {
    const step = (pos(last.bounds) - pos(first.bounds)) / (sorted.length - 1);
    sorted.forEach((it, i) => {
      const targetPos = pos(first.bounds) + i * step;
      out.set(it.id, axisDelta(axis, targetPos - pos(it.bounds)));
    });
  } else {
    const span = pos(last.bounds) + size(last.bounds) - pos(first.bounds);
    const totalSize = sorted.reduce((s, it) => s + size(it.bounds), 0);
    const gap = (span - totalSize) / (sorted.length - 1);
    let cursor = pos(first.bounds);
    sorted.forEach((it) => {
      out.set(it.id, axisDelta(axis, cursor - pos(it.bounds)));
      cursor += size(it.bounds) + gap;
    });
  }
  return out;
}

function axisDelta(axis: "h" | "v", d: number): Delta {
  return axis === "h" ? { dx: d, dy: 0 } : { dx: 0, dy: d };
}

/**
 * Tidy up: arrange a selection into a row with a uniform gap inferred from the
 * current spacing (default 16), top-aligned to the topmost item (FR-17).
 */
export function tidyUpDeltas(items: ArrangeItem[], defaultGap = 16): Map<string, Delta> {
  const out = new Map<string, Delta>();
  if (items.length === 0) return out;
  const sorted = [...items].sort((a, b) => a.bounds.x - b.bounds.x);
  const top = Math.min(...sorted.map((it) => it.bounds.y));

  // Infer gap from the median existing horizontal gap, else the default.
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push(sorted[i].bounds.x - (sorted[i - 1].bounds.x + sorted[i - 1].bounds.width));
  }
  gaps.sort((a, b) => a - b);
  const gap = gaps.length ? Math.max(0, gaps[Math.floor(gaps.length / 2)]) : defaultGap;

  let cursor = sorted[0].bounds.x;
  for (const it of sorted) {
    out.set(it.id, { dx: cursor - it.bounds.x, dy: top - it.bounds.y });
    cursor += it.bounds.width + gap;
  }
  return out;
}

/** Reorder selected nodes within a back-to-front children array (FR-18). */
export function order(
  children: Node[],
  ids: string[],
  op: "front" | "back" | "forward" | "backward",
): Node[] {
  const sel = new Set(ids);
  const result = [...children];
  switch (op) {
    case "front": {
      const moving = result.filter((n) => sel.has(n.id));
      const rest = result.filter((n) => !sel.has(n.id));
      return [...rest, ...moving];
    }
    case "back": {
      const moving = result.filter((n) => sel.has(n.id));
      const rest = result.filter((n) => !sel.has(n.id));
      return [...moving, ...rest];
    }
    case "forward": {
      // Move each selected node one step toward the front (higher index).
      for (let i = result.length - 2; i >= 0; i--) {
        if (sel.has(result[i].id) && !sel.has(result[i + 1].id)) {
          [result[i], result[i + 1]] = [result[i + 1], result[i]];
        }
      }
      return result;
    }
    case "backward": {
      for (let i = 1; i < result.length; i++) {
        if (sel.has(result[i].id) && !sel.has(result[i - 1].id)) {
          [result[i], result[i - 1]] = [result[i - 1], result[i]];
        }
      }
      return result;
    }
  }
}
