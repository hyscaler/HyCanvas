// Path simplification and freehand curve fitting.
//
// Two pure helpers used by the pencil tool and the simplify command:
//  - simplifyPolyline: Ramer-Douglas-Peucker decimation of a polyline within a
//    perpendicular-distance tolerance, dropping points that lie close to the
//    chord between their kept neighbours.
//  - fitCubicBeziers: fit a sequence of cubic bezier segments to a polyline so a
//    hand-drawn stroke becomes a small set of smooth curves. Tangents come from a
//    Catmull-Rom estimate at each kept point; control-handle lengths are solved
//    by a least-squares projection onto the chord, then the fit is verified
//    against the source samples and the worst segment is split recursively until
//    every segment is within tolerance.
//
// Both are framework-agnostic and have no I/O, matching the rest of @hc/geometry.

import type { Point } from "./types";

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Perpendicular distance from p to the infinite line through a and b. When a and
// b coincide this degenerates to the point distance, which is the behaviour RDP
// wants (a zero-length chord keeps any point that is not coincident).
function perpDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return dist(p, a);
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

/**
 * Ramer-Douglas-Peucker simplification: returns a subset of `points` (always
 * including the first and last) such that every dropped point lies within
 * `tolerance` of the retained polyline. A noisy stroke collapses to far fewer
 * points; tolerance 0 returns the input unchanged (minus exact duplicates).
 */
export function simplifyPolyline(points: Point[], tolerance: number): Point[] {
  if (points.length <= 2) return points.slice();
  const tol = Math.max(0, tolerance);
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;

  // Iterative stack-based RDP (no recursion depth limit on huge strokes).
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!;
    let maxDist = -1;
    let index = -1;
    for (let i = start + 1; i < end; i++) {
      const d = perpDistance(points[i], points[start], points[end]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (index !== -1 && maxDist > tol) {
      keep[index] = true;
      stack.push([start, index]);
      stack.push([index, end]);
    }
  }

  const out: Point[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/** A fitted cubic bezier: endpoints p0/p3 with absolute control points c1/c2. */
export interface CubicBezier {
  p0: Point;
  c1: Point;
  c2: Point;
  p3: Point;
}

function cubicAt(b: CubicBezier, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const bb = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * b.p0.x + bb * b.c1.x + c * b.c2.x + d * b.p3.x,
    y: a * b.p0.y + bb * b.c1.y + c * b.c2.y + d * b.p3.y,
  };
}

function norm(v: Point): Point {
  const l = Math.hypot(v.x, v.y);
  return l < 1e-9 ? { x: 0, y: 0 } : { x: v.x / l, y: v.y / l };
}

// Chord-length parameterization of a point run, normalized to [0,1]. Used both
// to assign each sample a t for the least-squares fit and to measure error.
function chordParameters(points: Point[]): number[] {
  const u = [0];
  for (let i = 1; i < points.length; i++) u.push(u[i - 1] + dist(points[i], points[i - 1]));
  const total = u[u.length - 1];
  if (total < 1e-9) return points.map((_, i) => i / Math.max(1, points.length - 1));
  return u.map((d) => d / total);
}

// Least-squares fit of one cubic to `points` given fixed unit tangents at the
// endpoints (Graphics Gems "An Algorithm for Automatically Fitting Digitized
// Curves" / Schneider). Returns absolute control points.
function fitOneCubic(points: Point[], tHat0: Point, tHat3: Point, u: number[]): CubicBezier {
  const p0 = points[0];
  const p3 = points[points.length - 1];
  // Bernstein basis weighted tangents.
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < points.length; i++) {
    const t = u[i];
    const b0 = (1 - t) ** 3;
    const b1 = 3 * (1 - t) ** 2 * t;
    const b2 = 3 * (1 - t) * t * t;
    const b3 = t ** 3;
    const a0 = { x: tHat0.x * b1, y: tHat0.y * b1 };
    const a1 = { x: tHat3.x * b2, y: tHat3.y * b2 };
    c00 += a0.x * a0.x + a0.y * a0.y;
    c01 += a0.x * a1.x + a0.y * a1.y;
    c11 += a1.x * a1.x + a1.y * a1.y;
    const tmp = {
      x: points[i].x - (p0.x * (b0 + b1) + p3.x * (b2 + b3)),
      y: points[i].y - (p0.y * (b0 + b1) + p3.y * (b2 + b3)),
    };
    x0 += a0.x * tmp.x + a0.y * tmp.y;
    x1 += a1.x * tmp.x + a1.y * tmp.y;
  }
  const det = c00 * c11 - c01 * c01;
  let alpha0 = 0;
  let alpha1 = 0;
  if (Math.abs(det) > 1e-9) {
    alpha0 = (x0 * c11 - c01 * x1) / det;
    alpha1 = (c00 * x1 - x0 * c01) / det;
  }
  // Guard against degenerate/negative handle lengths: fall back to a third of
  // the chord (Wu/Barsky heuristic) so the curve stays well-formed.
  const segLen = dist(p0, p3);
  if (alpha0 < 1e-6 || alpha1 < 1e-6) {
    alpha0 = segLen / 3;
    alpha1 = segLen / 3;
  }
  return {
    p0,
    c1: { x: p0.x + tHat0.x * alpha0, y: p0.y + tHat0.y * alpha0 },
    c2: { x: p3.x + tHat3.x * alpha1, y: p3.y + tHat3.y * alpha1 },
    p3,
  };
}

// Largest TRUE (nearest-point) distance from any source point to the fitted
// cubic, and which interior sample was worst. The nearest point is found by
// dense sampling of the curve, so the reported error matches the geometric
// deviation a viewer sees (not just the deviation at the chord parameter).
function maxFitError(points: Point[], bez: CubicBezier): { error: number; index: number } {
  const steps = 48;
  const curve: Point[] = [];
  for (let s = 0; s <= steps; s++) curve.push(cubicAt(bez, s / steps));
  let error = 0;
  let index = Math.floor(points.length / 2);
  for (let i = 1; i < points.length - 1; i++) {
    let best = Infinity;
    for (const q of curve) {
      const d = dist(points[i], q);
      if (d < best) best = d;
    }
    if (best > error) {
      error = best;
      index = i;
    }
  }
  return { error, index };
}

// Unit tangent at an interior point via a Catmull-Rom style central difference.
function tangentAt(points: Point[], i: number): Point {
  const prev = points[Math.max(0, i - 1)];
  const next = points[Math.min(points.length - 1, i + 1)];
  return norm({ x: next.x - prev.x, y: next.y - prev.y });
}

function fitRecursive(points: Point[], tHat0: Point, tHat3: Point, tolerance: number, depth: number): CubicBezier[] {
  if (points.length < 2) return [];
  if (points.length === 2) {
    const len = dist(points[0], points[1]) / 3;
    return [
      {
        p0: points[0],
        c1: { x: points[0].x + tHat0.x * len, y: points[0].y + tHat0.y * len },
        c2: { x: points[1].x + tHat3.x * len, y: points[1].y + tHat3.y * len },
        p3: points[1],
      },
    ];
  }
  const u = chordParameters(points);
  const bez = fitOneCubic(points, tHat0, tHat3, u);
  const { error, index } = maxFitError(points, bez);
  if (error <= tolerance || depth > 24 || index <= 0 || index >= points.length - 1) return [bez];
  // Split at the worst sample; the shared tangent there keeps the join smooth.
  const split = tangentAt(points, index);
  const left = fitRecursive(points.slice(0, index + 1), tHat0, { x: -split.x, y: -split.y }, tolerance, depth + 1);
  const right = fitRecursive(points.slice(index), split, tHat3, tolerance, depth + 1);
  return [...left, ...right];
}

/**
 * Fit a polyline to a minimal set of smooth cubic bezier segments within
 * `tolerance` (max perpendicular sample error). Endpoint tangents are derived
 * from the neighbouring samples, so adjacent fitted segments meet smoothly.
 * Returns an empty array for fewer than two distinct points.
 */
export function fitCubicBeziers(points: Point[], tolerance: number): CubicBezier[] {
  // Drop exact-duplicate consecutive points so tangents stay defined.
  const pts: Point[] = [];
  for (const p of points) {
    const last = pts[pts.length - 1];
    if (!last || dist(last, p) > 1e-6) pts.push(p);
  }
  if (pts.length < 2) return [];
  const tHat0 = tangentAt(pts, 0);
  const tHatEnd = tangentAt(pts, pts.length - 1);
  // The end tangent must point back into the curve for the fit's convention.
  return fitRecursive(pts, tHat0, { x: -tHatEnd.x, y: -tHatEnd.y }, Math.max(1e-6, tolerance), 0);
}
