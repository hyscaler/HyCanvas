// Perceptual nearest-color matching (F18 FR-3, AC-2). Used by brand re-skin to
// snap an on-canvas color to its closest brand-palette swatch. Distance is
// measured in CIELAB with the CIE76 deltaE metric, which is a sound, cheap
// perceptual distance (good enough for palette snapping; CIEDE2000 is overkill
// here). Pure functions over the canonical sRGB `Color` from @hc/schema.

import type { Color } from "@hc/schema";

/** A point in CIE L*a*b* (D65). */
export interface Lab {
  l: number;
  a: number;
  b: number;
}

/** Linearize an sRGB component (0..1) to linear light. */
function lin(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

// D65 reference white in XYZ (scaled to 100).
const XN = 95.047;
const YN = 100.0;
const ZN = 108.883;

function pivot(t: number): number {
  // CIE epsilon/kappa pivot for the f(t) used in XYZ -> Lab.
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}

/**
 * Convert a Color to CIE L*a*b*. Alpha is ignored (matching is over the visible
 * hue/lightness, not transparency). sRGB is linearized, projected to XYZ under
 * D65, then to Lab.
 */
export function rgbToLab(c: Color): Lab {
  const r = lin(c.srgb.r);
  const g = lin(c.srgb.g);
  const b = lin(c.srgb.b);

  // Linear sRGB -> XYZ (D65), scaled to 100.
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) * 100;
  const y = (r * 0.2126729 + g * 0.7151522 + b * 0.072175) * 100;
  const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) * 100;

  const fx = pivot(x / XN);
  const fy = pivot(y / YN);
  const fz = pivot(z / ZN);

  return {
    l: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

/** CIE76 deltaE: Euclidean distance in Lab. Symmetric; 0 means identical. */
export function deltaE(a: Color, b: Color): number {
  const la = rgbToLab(a);
  const lb = rgbToLab(b);
  const dl = la.l - lb.l;
  const da = la.a - lb.a;
  const db = la.b - lb.b;
  return Math.sqrt(dl * dl + da * da + db * db);
}

/** The result of a nearest-color lookup: the matched swatch, its index in the
 *  palette, and the perceptual distance to the query (smaller is closer). */
export interface NearestMatch {
  color: Color;
  index: number;
  distance: number;
}

/**
 * Find the perceptually nearest color in `palette` to `target` (FR-3). Returns
 * null only when the palette is empty (the caller then keeps the original color,
 * never forcing a bad match edge case). Deterministic: ties resolve to
 * the earliest palette entry, so re-skin is reproducible.
 */
export function nearestPaletteColor(
  target: Color,
  palette: readonly Color[],
): NearestMatch | null {
  if (palette.length === 0) return null;
  let bestIndex = 0;
  let bestDist = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const d = deltaE(target, palette[i]);
    if (d < bestDist) {
      bestDist = d;
      bestIndex = i;
    }
  }
  return { color: palette[bestIndex], index: bestIndex, distance: bestDist };
}
