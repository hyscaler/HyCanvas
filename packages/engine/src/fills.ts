// Resolve a color Fill to a Canvas2D paint: a real CanvasGradient where the
// context supports it, otherwise a representative solid. Image/pattern fills are
// painted as media via the asset provider (render2d.ts), not here.

import type { Color, Fill, GradientFill, GradientStop } from "@hc/schema";
import { colorToCss } from "./color";
import type { CanvasGradientLike, CanvasLike } from "./types";

function firstStopColor(fill: GradientFill): string {
  if (fill.stops.length > 0) return colorToCss(fill.stops[0].color);
  if (fill.mesh && fill.mesh.points.length > 0) return colorToCss(fill.mesh.points[0].color);
  return "rgba(0, 0, 0, 0)";
}

function addStops(g: CanvasGradientLike, stops: GradientStop[]): void {
  // Clamp positions and skip any non-finite offset so one bad stop can't throw.
  for (const s of stops) {
    const p = Number.isFinite(s.position) ? Math.max(0, Math.min(1, s.position)) : 0;
    g.addColorStop(p, colorToCss(s.color));
  }
}

const finite = (x: number): boolean => Number.isFinite(x);

function resolveGradient(
  ctx: CanvasLike,
  fill: GradientFill,
  w: number,
  h: number,
): string | CanvasGradientLike {
  // A malformed design (e.g. a page with no width/height) must not crash the
  // whole canvas: when the box dimensions aren't finite, fall back to a solid.
  if (!finite(w) || !finite(h)) return firstStopColor(fill);
  const center = fill.center ?? { x: 0.5, y: 0.5 };
  if (fill.gradient === "linear") {
    if (!ctx.createLinearGradient) return firstStopColor(fill);
    const angle = finite(fill.angle as number) ? (fill.angle as number) : 0;
    const rad = (angle * Math.PI) / 180;
    const dx = Math.cos(rad);
    const dy = Math.sin(rad);
    const cx = w / 2;
    const cy = h / 2;
    const ext = (Math.abs(dx) * w + Math.abs(dy) * h) / 2;
    const x0 = cx - dx * ext, y0 = cy - dy * ext, x1 = cx + dx * ext, y1 = cy + dy * ext;
    if (!finite(x0) || !finite(y0) || !finite(x1) || !finite(y1)) return firstStopColor(fill);
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    addStops(g, fill.stops);
    return g;
  }
  if (fill.gradient === "radial") {
    const r = (fill.radius ?? 0.5) * Math.max(w, h);
    if (!ctx.createRadialGradient || !(r > 0)) return firstStopColor(fill);
    const cx = center.x * w;
    const cy = center.y * h;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    addStops(g, fill.stops);
    return g;
  }
  if (fill.gradient === "conic") {
    if (!ctx.createConicGradient) return firstStopColor(fill);
    const angle = finite(fill.angle as number) ? (fill.angle as number) : 0;
    const cx = center.x * w, cy = center.y * h;
    if (!finite(cx) || !finite(cy)) return firstStopColor(fill);
    const g = ctx.createConicGradient((angle * Math.PI) / 180, cx, cy);
    addStops(g, fill.stops);
    return g;
  }
  // mesh: a representative solid for the Canvas2D baseline (shader path later).
  return firstStopColor(fill);
}

/** A fillStyle/strokeStyle value for a fill over a node box of size w x h. */
export function resolveFill(
  ctx: CanvasLike,
  fill: Fill,
  w: number,
  h: number,
): string | CanvasGradientLike {
  switch (fill.type) {
    case "solid":
      return colorToCss(fill.color);
    case "gradient":
      return resolveGradient(ctx, fill, w, h);
    case "pattern":
    case "image":
      return "rgba(0, 0, 0, 0)"; // painted as media via the asset provider
    default:
      return "rgba(0, 0, 0, 0)";
  }
}

export type { Color };
