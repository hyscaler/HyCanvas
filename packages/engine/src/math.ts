// 2D affine matrix and rectangle math for the engine. Pure, allocation-light,
// and dependency-free so it runs identically in browser, worker, and Node.

import type { Transform } from "@hc/schema";

/**
 * A 2D affine matrix mapping a local point (x, y) to
 * (a*x + c*y + e, b*x + d*y + f) - the same component order as the Canvas2D
 * `setTransform(a, b, c, d, e, f)` API.
 */
export interface Mat2D {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DEG2RAD = Math.PI / 180;

export function identity(): Mat2D {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

/** `m * n` - the matrix that applies `n` first, then `m`. */
export function multiply(m: Mat2D, n: Mat2D): Mat2D {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

/**
 * Build the local-to-parent matrix for a node `Transform`. Composition is
 * translate -> rotate -> skew -> scale, all about the node's local origin
 * (0, 0) - i.e. a local point is scaled, skewed, rotated, then translated.
 * Rotation is clockwise in degrees.
 */
export function fromTransform(t: Transform): Mat2D {
  const sx = t.scaleX;
  const sy = t.scaleY;
  const rot = t.rotation * DEG2RAD;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const tanX = t.skewX ? Math.tan(t.skewX * DEG2RAD) : 0;
  const tanY = t.skewY ? Math.tan(t.skewY * DEG2RAD) : 0;

  // R * K * S, then prepend the translation.
  // K*S: [[1, tanX],[tanY,1]] * [[sx,0],[0,sy]]
  const ksa = sx;
  const ksb = tanY * sx;
  const ksc = tanX * sy;
  const ksd = sy;

  return {
    a: cos * ksa - sin * ksb,
    b: sin * ksa + cos * ksb,
    c: cos * ksc - sin * ksd,
    d: sin * ksc + cos * ksd,
    e: t.x,
    f: t.y,
  };
}

/** Decompose an affine matrix back into a translate/rotate/scale Transform (the
 *  inverse of {@link fromTransform} for skew-free matrices; shear is folded into
 *  scale/rotation, so it is approximate when a skew is present). Used to bake a
 *  composed parent transform (e.g. flattened SVG groups) into a node. */
export function decompose(m: Mat2D): Transform {
  const scaleX = Math.hypot(m.a, m.b);
  const det = m.a * m.d - m.b * m.c;
  const scaleY = scaleX ? det / scaleX : Math.hypot(m.c, m.d);
  return {
    x: m.e,
    y: m.f,
    scaleX: scaleX || 1,
    scaleY: scaleY || 1,
    rotation: Math.atan2(m.b, m.a) / DEG2RAD,
  };
}

/** Invert an affine matrix, or return null if it is singular (det ~ 0). */
export function invert(m: Mat2D): Mat2D | null {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-12) return null;
  const id = 1 / det;
  return {
    a: m.d * id,
    b: -m.b * id,
    c: -m.c * id,
    d: m.a * id,
    e: (m.c * m.f - m.d * m.e) * id,
    f: (m.b * m.e - m.a * m.f) * id,
  };
}

export function applyToPoint(m: Mat2D, p: Point): Point {
  return {
    x: m.a * p.x + m.c * p.y + m.e,
    y: m.b * p.x + m.d * p.y + m.f,
  };
}

export function matToArray(m: Mat2D): Float32Array {
  return new Float32Array([m.a, m.b, m.c, m.d, m.e, m.f]);
}

// --- Rect helpers -----------------------------------------------------------

export function rectFromPoints(points: Point[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Axis-aligned bounds of a rect after an affine transform (its 4 corners). */
export function transformRect(m: Mat2D, r: Rect): Rect {
  return rectFromPoints([
    applyToPoint(m, { x: r.x, y: r.y }),
    applyToPoint(m, { x: r.x + r.width, y: r.y }),
    applyToPoint(m, { x: r.x + r.width, y: r.y + r.height }),
    applyToPoint(m, { x: r.x, y: r.y + r.height }),
  ]);
}

export function rectUnion(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

export function rectIntersects(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

export function rectIntersection(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

export function rectContainsPoint(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

/** True when `outer` fully contains `inner`. */
export function rectContainsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/** Grow a rect outward by `amount` on every side (clamped to >= 0 amount). */
export function rectInflate(r: Rect, amount: number): Rect {
  const a = Math.max(0, amount);
  return { x: r.x - a, y: r.y - a, width: r.width + 2 * a, height: r.height + 2 * a };
}
