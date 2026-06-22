// Snapping and smart guides (FR-13..FR-15). Pure geometry over page-space AABBs:
// candidates are the edges and centers of other objects, the page box, and the
// grid; the closest within a screen-space threshold wins per axis. Thresholds
// are passed in page units (the caller divides the screen threshold by zoom so
// behavior is consistent across zoom levels).

import type { Rect } from "@hc/engine";

export interface SnapOptions {
  /** Snap distance in page units (screen px / zoom). Default 6. */
  threshold?: number;
  /** Page box, for snapping to page edges/center. */
  pageRect?: Rect;
  /** Grid step in page units, for grid snapping. */
  grid?: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  /** Page-space x positions of matched vertical guides. */
  guidesX: number[];
  /** Page-space y positions of matched horizontal guides. */
  guidesY: number[];
}

function edgesX(r: Rect): number[] {
  return [r.x, r.x + r.width / 2, r.x + r.width];
}
function edgesY(r: Rect): number[] {
  return [r.y, r.y + r.height / 2, r.y + r.height];
}

interface AxisSnap {
  delta: number;
  guide: number | null;
}

function bestAxisSnap(movingEdges: number[], targets: number[], threshold: number): AxisSnap {
  let best: AxisSnap = { delta: 0, guide: null };
  let bestDist = threshold + Number.EPSILON;
  for (const edge of movingEdges) {
    for (const target of targets) {
      const dist = Math.abs(target - edge);
      if (dist <= threshold && dist < bestDist) {
        bestDist = dist;
        best = { delta: target - edge, guide: target };
      }
    }
  }
  return best;
}

/** Compute the snap offset (dx, dy) and matched guide lines for a moving box. */
export function snap(moving: Rect, statics: Rect[], opts: SnapOptions = {}): SnapResult {
  const threshold = opts.threshold ?? 6;
  const targetsX: number[] = [];
  const targetsY: number[] = [];
  for (const s of statics) {
    targetsX.push(...edgesX(s));
    targetsY.push(...edgesY(s));
  }
  if (opts.pageRect) {
    targetsX.push(...edgesX(opts.pageRect));
    targetsY.push(...edgesY(opts.pageRect));
  }
  if (opts.grid && opts.grid > 0) {
    const g = opts.grid;
    for (const e of edgesX(moving)) targetsX.push(Math.round(e / g) * g);
    for (const e of edgesY(moving)) targetsY.push(Math.round(e / g) * g);
  }

  const sx = bestAxisSnap(edgesX(moving), targetsX, threshold);
  const sy = bestAxisSnap(edgesY(moving), targetsY, threshold);
  return {
    dx: sx.delta,
    dy: sy.delta,
    guidesX: sx.guide === null ? [] : [sx.guide],
    guidesY: sy.guide === null ? [] : [sy.guide],
  };
}

/**
 * Equal-spacing detection for 3+ boxes along an axis (FR-14). Returns the common
 * gap when consecutive gaps between sorted boxes match within tolerance.
 */
export function detectEqualSpacing(
  boxes: Rect[],
  axis: "x" | "y",
  tolerance = 0.5,
): { equal: boolean; gap: number } {
  if (boxes.length < 3) return { equal: false, gap: 0 };
  const sorted = [...boxes].sort((a, b) => (axis === "x" ? a.x - b.x : a.y - b.y));
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const gap =
      axis === "x"
        ? cur.x - (prev.x + prev.width)
        : cur.y - (prev.y + prev.height);
    gaps.push(gap);
  }
  const first = gaps[0];
  const equal = gaps.every((g) => Math.abs(g - first) <= tolerance);
  return { equal, gap: equal ? first : 0 };
}
