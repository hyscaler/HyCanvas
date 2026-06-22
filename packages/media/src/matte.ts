// Alpha-matte refinement and pixel-brush core: the pure, framework-free
// math behind "refine edges" after background removal / magic grab, plus a manual
// matte brush (erase/restore) for touch-ups. Operates on an 8-bit alpha matte
// (0 = fully cut out, 255 = fully kept); the interactive canvas layer feeds in the
// matte from the segmentation step and paints brush strokes through here so the
// result is identical headless and on-screen.

export interface MatteRefineOptions {
  /** Contract the matte edge inward by this many pixels (kills haloes). */
  shrink?: number;
  /** Soften the edge with a blur of this radius (feathering). */
  feather?: number;
  /** Expand the matte edge outward by this many pixels (recover thin detail). */
  grow?: number;
}

export interface BrushStamp {
  cx: number;
  cy: number;
  radius: number;
  /** Target alpha the brush paints toward: 0 erases, 255 restores. */
  value: number;
  /** 0 = soft falloff to the edge, 1 = hard edge. */
  hardness?: number;
  /** Overall strength 0..1 applied to the stamp (default 1). */
  flow?: number;
}

const clamp8 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

// Separable box blur of one 1px row/column window of the given radius, run over
// the whole buffer in the x then y direction. Three iterations approximate a
// gaussian; one pass is the cheap default used here per call.
function boxBlur(src: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  if (radius <= 0) return src.slice();
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  const win = radius * 2 + 1;
  // Horizontal.
  for (let y = 0; y < h; y++) {
    let sum = 0;
    const row = y * w;
    for (let x = -radius; x <= radius; x++) sum += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = Math.round(sum / win);
      const add = Math.min(w - 1, x + radius + 1);
      const sub = Math.max(0, x - radius);
      sum += src[row + add] - src[row + sub];
    }
  }
  // Vertical.
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = Math.round(sum / win);
      const add = Math.min(h - 1, y + radius + 1);
      const sub = Math.max(0, y - radius);
      sum += tmp[add * w + x] - tmp[sub * w + x];
    }
  }
  return out;
}

// Separable morphology: extremum (max = dilate/grow, min = erode/shrink) over a
// square structuring element of the given radius.
function morph(src: Uint8Array, w: number, h: number, radius: number, dilate: boolean): Uint8Array {
  if (radius <= 0) return src.slice();
  const pick = dilate ? Math.max : Math.min;
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = src[row + x];
      for (let dx = -radius; dx <= radius; dx++) v = pick(v, src[row + Math.min(w - 1, Math.max(0, x + dx))]);
      tmp[row + x] = v;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let v = tmp[y * w + x];
      for (let dy = -radius; dy <= radius; dy++) v = pick(v, tmp[Math.min(h - 1, Math.max(0, y + dy)) * w + x]);
      out[y * w + x] = v;
    }
  }
  return out;
}

/** Grow (dilate) the matte by `radius` pixels. */
export function growMatte(alpha: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  return morph(alpha, w, h, radius, true);
}

/** Shrink (erode) the matte by `radius` pixels. */
export function shrinkMatte(alpha: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  return morph(alpha, w, h, radius, false);
}

/** Feather the matte edge with a blur of `radius` pixels. */
export function featherMatte(alpha: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  return boxBlur(alpha, w, h, radius);
}

/** Classic "refine edges": optional grow, then shrink (choke), then feather. */
export function refineMatte(alpha: Uint8Array, w: number, h: number, opts: MatteRefineOptions = {}): Uint8Array {
  let a = alpha;
  if (opts.grow && opts.grow > 0) a = growMatte(a, w, h, Math.round(opts.grow));
  if (opts.shrink && opts.shrink > 0) a = shrinkMatte(a, w, h, Math.round(opts.shrink));
  if (opts.feather && opts.feather > 0) a = featherMatte(a, w, h, Math.round(opts.feather));
  return a === alpha ? alpha.slice() : a;
}

/** Paint a brush stamp into the matte in place (manual erase/restore touch-up).
 *  Returns the same buffer for chaining. Soft falloff respects `hardness`. */
export function brushMatte(alpha: Uint8Array, w: number, h: number, stamp: BrushStamp): Uint8Array {
  const { cx, cy, radius, value } = stamp;
  const hardness = Math.min(1, Math.max(0, stamp.hardness ?? 0.5));
  const flow = Math.min(1, Math.max(0, stamp.flow ?? 1));
  if (radius <= 0 || flow <= 0) return alpha;
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(w - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(h - 1, Math.ceil(cy + radius));
  const inner = radius * hardness; // fully-applied core radius
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > radius) continue;
      let t = 1;
      if (d > inner && radius > inner) t = 1 - (d - inner) / (radius - inner);
      t *= flow;
      const i = y * w + x;
      alpha[i] = clamp8(alpha[i] * (1 - t) + value * t);
    }
  }
  return alpha;
}

/** Apply a matte to an RGBA buffer in place by multiplying the existing alpha by
 *  the matte (matte 255 keeps the pixel, 0 cuts it out). Returns the buffer. */
export function applyMatteToRGBA(rgba: Uint8Array | Uint8ClampedArray, alpha: Uint8Array): Uint8Array | Uint8ClampedArray {
  const n = Math.min(rgba.length / 4, alpha.length);
  for (let i = 0; i < n; i++) rgba[i * 4 + 3] = Math.round((rgba[i * 4 + 3] * alpha[i]) / 255);
  return rgba;
}
