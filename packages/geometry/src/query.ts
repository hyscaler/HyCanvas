// Bounds and point-in-path queries over a VectorPath. Curves are
// flattened first so results match the boolean/render pipeline.

import type { VectorPath } from "@hc/schema";
import { pathToPolylines } from "./flatten";
import type { Point, Rect } from "./types";

/** Axis-aligned bounds of a path (flattened). */
export function bounds(path: VectorPath): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of pathToPolylines(path)) {
    for (const p of poly) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// Winding-number contribution of a polygon ring for a point.
function windingContribution(poly: Point[], p: Point): number {
  let wind = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (a.y <= p.y) {
      if (b.y > p.y && cross(a, b, p) > 0) wind++;
    } else if (b.y <= p.y && cross(a, b, p) < 0) {
      wind--;
    }
  }
  return wind;
}

function cross(a: Point, b: Point, p: Point): number {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}

// Even-odd crossing parity over all rings.
function crossingParity(polys: Point[][], p: Point): boolean {
  let inside = false;
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const intersect = a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
      if (intersect) inside = !inside;
    }
  }
  return inside;
}

/** True if a point is inside the path under the given fill rule. */
export function pointInPath(path: VectorPath, p: Point, rule: VectorPath["fillRule"] = path.fillRule): boolean {
  const polys = pathToPolylines(path);
  if (rule === "evenodd") return crossingParity(polys, p);
  let total = 0;
  for (const poly of polys) total += windingContribution(poly, p);
  return total !== 0;
}
