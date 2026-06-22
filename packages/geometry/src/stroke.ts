// Stroke-to-outline and freehand shape recognition.
//
// strokeToOutline converts a stroked path into a filled outline: each flattened
// segment is thickened into a quad and each vertex into a small disc (round
// join/cap), then everything is unioned via the boolean clipper - so the result
// is a clean filled region that renders identically to the original stroke.
//
// recognizeShape classifies a raw freehand polyline (a pencil stroke) as a line,
// rectangle, ellipse, triangle, or regular polygon so the editor can replace the
// rough trace with a clean parametric shape.

import type { VectorPath } from "@hc/schema";
import type { Point, Rect } from "./types";
import { pathToPolylines } from "./flatten";
import { booleanOp } from "./boolean";
import { simplifyPolyline } from "./simplify";

function polygonPath(pts: Point[]): VectorPath {
  return {
    subpaths: [{ closed: true, anchors: pts.map((p) => ({ x: p.x, y: p.y, corner: true })) }],
    fillRule: "nonzero",
  };
}

function disc(cx: number, cy: number, r: number, n = 12): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return out;
}

/** Convert a stroked path into a filled outline path of the given width. */
export function strokeToOutline(path: VectorPath, width: number, steps?: number): VectorPath {
  const half = Math.max(0.01, width / 2);
  const polylines = pathToPolylines(path, steps);
  const parts: VectorPath[] = [];
  for (const pl of polylines) {
    for (let i = 0; i < pl.length - 1; i++) {
      const a = pl[i];
      const b = pl[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      const nx = (-dy / len) * half, ny = (dx / len) * half;
      parts.push(polygonPath([
        { x: a.x + nx, y: a.y + ny },
        { x: b.x + nx, y: b.y + ny },
        { x: b.x - nx, y: b.y - ny },
        { x: a.x - nx, y: a.y - ny },
      ]));
    }
    // Round joins/caps: a disc at every vertex bridges the quads.
    for (const p of pl) parts.push(polygonPath(disc(p.x, p.y, half)));
  }
  if (!parts.length) return { subpaths: [], fillRule: "nonzero" };
  return booleanOp("union", parts);
}

export type RecognizedShape =
  | { kind: "line"; from: Point; to: Point }
  | { kind: "rect"; bbox: Rect }
  | { kind: "ellipse"; bbox: Rect }
  | { kind: "triangle"; bbox: Rect }
  | { kind: "polygon"; bbox: Rect; sides: number };

/** Perpendicular distance from point p to the line through a and b. */
function perpDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

/** Classify a freehand polyline into a clean shape, or null to keep as-is. */
export function recognizeShape(points: Point[]): RecognizedShape | null {
  if (points.length < 2) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const w = maxX - minX, h = maxY - minY;
  const diag = Math.hypot(w, h);
  if (diag < 1e-6) return null;
  const bbox: Rect = { x: minX, y: minY, width: Math.max(1, w), height: Math.max(1, h) };
  const start = points[0], end = points[points.length - 1];
  const closed = Math.hypot(end.x - start.x, end.y - start.y) <= diag * 0.25;

  if (!closed) {
    let maxd = 0;
    for (const p of points) maxd = Math.max(maxd, perpDist(p, start, end));
    if (maxd <= diag * 0.08) return { kind: "line", from: start, to: end };
    return null; // an open, curvy stroke stays freehand
  }

  // Closed: count corners on the closed loop. A circle simplifies to many
  // corners; a rectangle to ~4, a triangle to ~3.
  const loop = points.concat([start]);
  const simp = simplifyPolyline(loop, diag * 0.06);
  const corners = Math.max(0, simp.length - 1); // last point repeats the start
  if (corners <= 2) return { kind: "ellipse", bbox };
  if (corners === 3) return { kind: "triangle", bbox };
  if (corners === 4) return { kind: "rect", bbox };
  if (corners <= 7) return { kind: "polygon", bbox, sides: corners };
  return { kind: "ellipse", bbox };
}
