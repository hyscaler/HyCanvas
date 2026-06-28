// True-shape point hit-testing in a node's LOCAL coordinate space (the node box
// is [0,0,width,height]). Callers transform the page-space point into local
// space via the inverse world matrix before calling these (see scene.ts).

import type { Node } from "@hc/schema";
import type { Point } from "./math";

function inBox(p: Point, w: number, h: number): boolean {
  return p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h;
}

/** Regular polygon / star vertices inscribed in the node box. */
function polygonPoints(
  w: number,
  h: number,
  sides: number,
  innerRatio?: number,
): Point[] {
  const cx = w / 2;
  const cy = h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const pts: Point[] = [];
  const n = Math.max(3, Math.floor(sides));
  const isStar = innerRatio !== undefined && innerRatio > 0;
  const count = isStar ? n * 2 : n;
  for (let i = 0; i < count; i++) {
    // Start at the top point.
    const ang = -Math.PI / 2 + (Math.PI * 2 * i) / count;
    const r = isStar && i % 2 === 1 ? innerRatio! : 1;
    pts.push({ x: cx + Math.cos(ang) * rx * r, y: cy + Math.sin(ang) * ry * r });
  }
  return pts;
}

function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const intersect =
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * True if a local-space point lies within a node's geometry. When `precise` is
 * false, only the bounding box is tested. Pixel-alpha hit-testing (sampling the
 * rendered alpha) is deferred to the GPU/canvas path; shape geometry is used
 * here for ellipses, polygons, stars, and lines.
 */
export function pointInLocalShape(node: Node, p: Point, precise: boolean): boolean {
  const { width: w, height: h } = node.size;
  if (!precise) return inBox(p, w, h);

  switch (node.type) {
    case "shape": {
      const shape = (node as { shape?: string }).shape;
      if (shape === "ellipse") {
        const cx = w / 2;
        const cy = h / 2;
        if (cx <= 0 || cy <= 0) return false;
        const nx = (p.x - cx) / cx;
        const ny = (p.y - cy) / cy;
        return nx * nx + ny * ny <= 1;
      }
      if (shape === "triangle") {
        return pointInPolygon(p, [
          { x: w / 2, y: 0 },
          { x: w, y: h },
          { x: 0, y: h },
        ]);
      }
      if (shape === "polygon" || shape === "star") {
        const sides = (node as { sides?: number }).sides ?? 5;
        const inner =
          shape === "star" ? ((node as { innerRadius?: number }).innerRadius ?? 0.5) : undefined;
        return pointInPolygon(p, polygonPoints(w, h, sides, inner));
      }
      return inBox(p, w, h); // rect / custom -> box
    }
    case "line": {
      const pts = (node as { points?: Point[] }).points ?? [];
      const half = Math.max(2, ((node as { stroke?: { width?: number } }).stroke?.width ?? 1) / 2);
      for (let i = 0; i < pts.length - 1; i++) {
        if (distToSegment(p, pts[i], pts[i + 1]) <= half) return true;
      }
      return false;
    }
    case "ink": {
      // Hit along the point stream within half the brush width (plus a small
      // tolerance), so a thin stroke is still clickable but its mostly-empty
      // bounding box is not.
      const pts = (node as { points?: Point[] }).points ?? [];
      const half = Math.max(3, ((node as { brush?: { width?: number } }).brush?.width ?? 1) / 2 + 2);
      if (pts.length === 1) return distToSegment(p, pts[0], pts[0]) <= half;
      for (let i = 0; i < pts.length - 1; i++) {
        if (distToSegment(p, pts[i], pts[i + 1]) <= half) return true;
      }
      return false;
    }
    default:
      return inBox(p, w, h);
  }
}
