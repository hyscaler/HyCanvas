// Flatten a VectorPath's curves to polylines for hit-testing, bounds, boolean
// ops, and the Canvas2D fallback. Uniform cubic subdivision (a fixed step count)
// is used; adaptive flatness refinement is a later enhancement.

import type { SubPath, VectorPath } from "@hc/schema";
import type { Point } from "./types";

const DEFAULT_STEPS = 16;

function cubicAt(p0: Point, c1: Point, c2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * c1.x + c * c2.x + d * p3.x,
    y: a * p0.y + b * c1.y + c * c2.y + d * p3.y,
  };
}

/** Flatten one subpath to a polyline of points. */
export function subpathToPolyline(sub: SubPath, steps = DEFAULT_STEPS): Point[] {
  const a = sub.anchors;
  if (a.length === 0) return [];
  const pts: Point[] = [{ x: a[0].x, y: a[0].y }];
  const segments = sub.closed ? a.length : a.length - 1;
  for (let i = 0; i < segments; i++) {
    const cur = a[i];
    const next = a[(i + 1) % a.length];
    const curved = cur.outHandle || next.inHandle;
    if (curved) {
      const c1 = { x: cur.x + (cur.outHandle?.x ?? 0), y: cur.y + (cur.outHandle?.y ?? 0) };
      const c2 = { x: next.x + (next.inHandle?.x ?? 0), y: next.y + (next.inHandle?.y ?? 0) };
      for (let s = 1; s <= steps; s++) {
        pts.push(cubicAt({ x: cur.x, y: cur.y }, c1, c2, { x: next.x, y: next.y }, s / steps));
      }
    } else {
      pts.push({ x: next.x, y: next.y });
    }
  }
  return pts;
}

/** Polyline points per subpath. */
export function pathToPolylines(path: VectorPath, steps = DEFAULT_STEPS): Point[][] {
  return path.subpaths.map((s) => subpathToPolyline(s, steps));
}

/** Flatten a whole path into a curve-free VectorPath (anchors only). */
export function flatten(path: VectorPath, steps = DEFAULT_STEPS): VectorPath {
  return {
    fillRule: path.fillRule,
    subpaths: path.subpaths.map((s) => ({
      closed: s.closed,
      anchors: subpathToPolyline(s, steps).map((p) => ({ x: p.x, y: p.y, corner: true })),
    })),
  };
}
