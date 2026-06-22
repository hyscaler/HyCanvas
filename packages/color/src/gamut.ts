// CMYK gamut check (F09 FR-12, AC-7). Determines whether an sRGB color survives
// a round trip into the target CMYK profile, and if not, offers the nearest
// in-gamut suggestion (the round-tripped color, which is by construction
// reproducible in CMYK).
//
// Uses the naive device CMYK transform for v1 (matching `convert.ts`); a real
// ICC/CMM round trip can replace the internals without changing the signature.

import type { Color } from "@hc/schema";
import { cmykToRgb, rgbToCmyk } from "./convert";

export interface GamutResult {
  inGamut: boolean;
  /** Nearest reproducible color when out of gamut; omitted when already in gamut. */
  nearest?: Color;
}

/** Euclidean distance in sRGB space (ignoring alpha). */
function dist(a: Color, b: Color): number {
  const dr = a.srgb.r - b.srgb.r;
  const dg = a.srgb.g - b.srgb.g;
  const db = a.srgb.b - b.srgb.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Check whether `c` is reproducible in `cmykProfile`. A color is considered in
 * gamut when the sRGB -> CMYK -> sRGB round trip returns (within tolerance) the
 * same color. The round-tripped color is the nearest in-gamut suggestion.
 */
export function gamutCheck(c: Color, cmykProfile?: string, tolerance = 1 / 255): GamutResult {
  const round = cmykToRgb(rgbToCmyk(c, cmykProfile), cmykProfile);
  // Carry the original alpha through; gamut concerns the chromatic channels.
  round.srgb.a = c.srgb.a;
  const d = dist(c, round);
  if (d <= tolerance) return { inGamut: true };
  return { inGamut: false, nearest: round };
}
