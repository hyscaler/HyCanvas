// Offscreen layers for group isolation (F40 Phase 1 groundwork).
//
// Group opacity multiplied DOWN per child (`parentAlpha * node.opacity`)
// instead of compositing the group as a unit. The difference is visible the
// moment two children in a semi-transparent group overlap: each is drawn at the
// group's alpha independently, so the overlap is darker than the rest and the
// group shows seams along every shared edge. A group blend mode fared worse
// still, because each child re-sets `globalCompositeOperation` for its own
// blend and the group's is simply lost.
//
// Both need the same thing: draw the subtree into its own buffer at full
// strength, then composite that buffer once.
//
// The engine must stay usable in a tab, in a worker, and headless, so nothing
// here assumes a DOM. `makeLayerCanvas` mirrors the probe `duotone.ts` already
// uses for its offscreen cache, and every caller treats a null result as "this
// runtime cannot isolate", falling back to the previous multiply-down path
// rather than failing to draw.

import type { CanvasLike } from "./types";

export type LayerCanvas = HTMLCanvasElement | OffscreenCanvas;

/** An offscreen buffer, or null where the runtime has no canvas to give. */
export function makeLayerCanvas(w: number, h: number): LayerCanvas | null {
  if (w <= 0 || h <= 0) return null;
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }
  return null;
}

/** A 2D context for a layer, or null when the runtime declines to provide one. */
export function layerContext(c: LayerCanvas): CanvasLike | null {
  // No `willReadFrequently` here, unlike duotone: a layer is composited with
  // drawImage and never read back, and the hint pushes some browsers onto a
  // slower software path.
  const ctx = (c as HTMLCanvasElement).getContext("2d");
  return (ctx as unknown as CanvasLike) ?? null;
}

/**
 * Whether a node's children must be composited as a unit rather than
 * individually.
 *
 * `kids > 1` guards the opacity case on purpose. With a single child there is
 * nothing to overlap, so multiplying the alpha down produces exactly the same
 * pixels as compositing a layer would, and allocating a full-canvas buffer for
 * it would be pure cost. Blend and an explicit isolation request are different:
 * they change the compositing MODEL rather than just the alpha, so they matter
 * even for one child.
 */
export function needsIsolation(
  node: { opacity: number; blendMode?: string; isolation?: boolean },
  kids: number,
): boolean {
  if (kids === 0) return false;
  if (node.blendMode && node.blendMode !== "normal") return true;
  if (node.isolation) return true;
  return node.opacity < 1 && kids > 1;
}
