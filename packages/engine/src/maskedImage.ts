// Apply an image's alpha mask (ImageNode.alphaMask, schema v20).
//
// The mask is a GRAYSCALE asset: white keeps, black hides. Canvas compositing
// works on alpha, not luminance, so `destination-in` cannot consume the mask
// directly; the luminance has to become alpha first. That is a per-pixel pass,
// which is exactly why the result is cached rather than recomputed per frame.
//
// The cache mirrors `duotone.ts`: a small LRU keyed by a content string, so the
// work runs when the image or the mask changes and not on every paint. That
// matters more here than for duotone, because a refinement brush will change
// the mask repeatedly and each change must invalidate exactly one entry.

import type { CanvasLike } from "./types";

interface Entry {
  key: string;
  canvas: HTMLCanvasElement | OffscreenCanvas;
}

const CACHE: Entry[] = [];
const CACHE_MAX = 12;
/** Cap the working buffer, as duotone does: a mask is smoothed by scaling, so
 *  a gigapixel source gains nothing from a gigapixel mask pass. */
const MAX_DIM = 2048;

function makeCanvas(w: number, h: number): (HTMLCanvasElement | OffscreenCanvas) | null {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }
  return null;
}

function get2d(c: HTMLCanvasElement | OffscreenCanvas): CanvasRenderingContext2D | null {
  return c.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | null;
}

/**
 * Composite `img` with `mask`, returning a cached canvas, or null where the
 * runtime has no canvas or the inputs are unusable.
 *
 * Returning null rather than throwing is deliberate: the caller then draws the
 * UNMASKED image. Both outcomes are wrong when a mask exists, but showing the
 * whole photo is recoverable and obvious, whereas failing to draw leaves a hole
 * the user cannot diagnose.
 */
export function maskedCanvas(
  key: string,
  img: CanvasImageSource,
  mask: CanvasImageSource,
  naturalWidth: number,
  naturalHeight: number,
): (HTMLCanvasElement | OffscreenCanvas) | null {
  const hit = CACHE.find((e) => e.key === key);
  if (hit) {
    // Move to the front: plain LRU, so a document cycling through several
    // masked images does not evict the one being edited.
    CACHE.splice(CACHE.indexOf(hit), 1);
    CACHE.unshift(hit);
    return hit.canvas;
  }

  const scale = Math.min(1, MAX_DIM / Math.max(naturalWidth, naturalHeight, 1));
  const w = Math.max(1, Math.round(naturalWidth * scale));
  const h = Math.max(1, Math.round(naturalHeight * scale));

  const out = makeCanvas(w, h);
  if (!out) return null;
  const ctx = get2d(out);
  if (!ctx) return null;

  // The mask, rasterized to the working size and converted luminance -> alpha.
  const maskBuf = makeCanvas(w, h);
  if (!maskBuf) return null;
  const mctx = get2d(maskBuf);
  if (!mctx) return null;
  try {
    mctx.drawImage(mask, 0, 0, w, h);
    const data = mctx.getImageData(0, 0, w, h);
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
      // Rec. 601 luma, matching `luminance601` in effects.ts so a mask authored
      // against one part of the engine behaves the same in the other.
      const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      // A mask that already carries alpha (a cutout PNG rather than a grayscale
      // one) must not be double-counted, so the two are multiplied.
      px[i + 3] = Math.round((lum * px[i + 3]) / 255);
      px[i] = 0;
      px[i + 1] = 0;
      px[i + 2] = 0;
    }
    mctx.putImageData(data, 0, 0);
  } catch {
    // getImageData throws on a tainted canvas (a cross-origin mask without
    // CORS). Unmasked is the safe degradation.
    return null;
  }

  try {
    ctx.drawImage(img, 0, 0, w, h);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(maskBuf, 0, 0);
    ctx.globalCompositeOperation = "source-over";
  } catch {
    return null;
  }

  CACHE.unshift({ key, canvas: out });
  if (CACHE.length > CACHE_MAX) CACHE.length = CACHE_MAX;
  return out;
}

/** Drop cached composites. For tests and for an explicit invalidation. */
export function clearMaskCache(): void {
  CACHE.length = 0;
}

/** Whether a context can support masking at all, so callers can probe once. */
export function maskingAvailable(ctx: CanvasLike): boolean {
  return !!ctx.drawImage && (typeof OffscreenCanvas !== "undefined" || typeof document !== "undefined");
}
