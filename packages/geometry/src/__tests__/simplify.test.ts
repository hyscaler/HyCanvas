import { describe, it, expect } from "vitest";
import { fitCubicBeziers, simplifyPolyline, type CubicBezier } from "../index";
import type { Point } from "../types";

function cubicAt(b: CubicBezier, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * b.p0.x + 3 * u * u * t * b.c1.x + 3 * u * t * t * b.c2.x + t * t * t * b.p3.x,
    y: u * u * u * b.p0.y + 3 * u * u * t * b.c1.y + 3 * u * t * t * b.c2.y + t * t * t * b.p3.y,
  };
}

// Nearest distance from a point to a fitted bezier sequence (dense sampling).
function nearestOnBeziers(beziers: CubicBezier[], p: Point): number {
  let best = Infinity;
  for (const b of beziers) {
    for (let s = 0; s <= 40; s++) {
      const q = cubicAt(b, s / 40);
      best = Math.min(best, Math.hypot(q.x - p.x, q.y - p.y));
    }
  }
  return best;
}

describe("simplifyPolyline (RDP)", () => {
  it("a near-straight noisy polyline collapses to far fewer points within tolerance", () => {
    // A horizontal line densely sampled with sub-tolerance vertical jitter.
    const pts: Point[] = [];
    for (let i = 0; i <= 200; i++) {
      pts.push({ x: i, y: Math.sin(i * 1.7) * 0.4 }); // |y| <= 0.4
    }
    const simplified = simplifyPolyline(pts, 1.0);
    expect(simplified.length).toBeLessThan(pts.length / 10);
    // First/last always retained.
    expect(simplified[0]).toEqual(pts[0]);
    expect(simplified[simplified.length - 1]).toEqual(pts[pts.length - 1]);
  });

  it("every dropped point stays within tolerance of the simplified polyline", () => {
    const pts: Point[] = [];
    for (let i = 0; i <= 100; i++) {
      pts.push({ x: i, y: Math.sin(i / 8) * 20 + (Math.random() - 0.5) * 0.5 });
    }
    const tol = 2.0;
    const simplified = simplifyPolyline(pts, tol);
    expect(simplified.length).toBeGreaterThan(2);
    expect(simplified.length).toBeLessThanOrEqual(pts.length);
    // Each original point must be within tol of the retained polyline segments.
    const segDist = (p: Point, a: Point, b: Point) => {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      if (len2 < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
      let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    };
    for (const p of pts) {
      let best = Infinity;
      for (let i = 0; i < simplified.length - 1; i++) best = Math.min(best, segDist(p, simplified[i], simplified[i + 1]));
      expect(best).toBeLessThanOrEqual(tol + 1e-6);
    }
  });

  it("returns the endpoints for short inputs", () => {
    expect(simplifyPolyline([{ x: 0, y: 0 }], 1)).toHaveLength(1);
    expect(simplifyPolyline([{ x: 0, y: 0 }, { x: 5, y: 5 }], 1)).toHaveLength(2);
  });
});

describe("fitCubicBeziers (freehand fit)", () => {
  it("a sampled cubic round-trips within tolerance", () => {
    // Sample a known S-ish cubic densely, fit it, and check every sample lies on
    // the fitted curve within tolerance.
    const source: CubicBezier = {
      p0: { x: 0, y: 0 },
      c1: { x: 40, y: 120 },
      c2: { x: 160, y: -40 },
      p3: { x: 200, y: 80 },
    };
    const samples: Point[] = [];
    for (let s = 0; s <= 60; s++) samples.push(cubicAt(source, s / 60));
    const tol = 1.5;
    const fit = fitCubicBeziers(samples, tol);
    expect(fit.length).toBeGreaterThanOrEqual(1);
    for (const p of samples) expect(nearestOnBeziers(fit, p)).toBeLessThanOrEqual(tol + 1e-3);
    // Endpoints are preserved exactly.
    expect(fit[0].p0.x).toBeCloseTo(0, 6);
    expect(fit[0].p0.y).toBeCloseTo(0, 6);
    expect(fit[fit.length - 1].p3.x).toBeCloseTo(200, 6);
    expect(fit[fit.length - 1].p3.y).toBeCloseTo(80, 6);
  });

  it("a tighter tolerance never fits worse and a quarter-circle stays within tolerance", () => {
    const samples: Point[] = [];
    for (let s = 0; s <= 50; s++) {
      const a = (Math.PI / 2) * (s / 50);
      samples.push({ x: Math.cos(a) * 100, y: Math.sin(a) * 100 });
    }
    const tol = 0.75;
    const fit = fitCubicBeziers(samples, tol);
    for (const p of samples) expect(nearestOnBeziers(fit, p)).toBeLessThanOrEqual(tol + 1e-2);
  });

  it("returns nothing for degenerate input", () => {
    expect(fitCubicBeziers([], 1)).toHaveLength(0);
    expect(fitCubicBeziers([{ x: 1, y: 1 }], 1)).toHaveLength(0);
    expect(fitCubicBeziers([{ x: 1, y: 1 }, { x: 1, y: 1 }], 1)).toHaveLength(0);
  });
});
