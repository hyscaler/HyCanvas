// Color-vision-deficiency simulation (F09 FR-10, AC-8). Per-color transform
// plus exported 3x3 matrices for a full-canvas GPU/Canvas2D pixel pass.
//
// Matrices operate on linear-ish sRGB triples (we apply them directly to the
// stored sRGB channels, which matches the common Brettel/Machado-style
// approximations used for editor previews). Achromatopsia uses luma weights.

import type { Color } from "@hc/schema";
import { clamp01, color } from "./convert";

export type CvdType = "protanopia" | "deuteranopia" | "tritanopia" | "achromatopsia";

/** Row-major 3x3 matrices mapping (r,g,b) -> simulated (r,g,b). */
export const cvdMatrices: Record<CvdType, readonly [number, number, number, number, number, number, number, number, number]> = {
  protanopia: [0.567, 0.433, 0.0, 0.558, 0.442, 0.0, 0.0, 0.242, 0.758],
  deuteranopia: [0.625, 0.375, 0.0, 0.7, 0.3, 0.0, 0.0, 0.3, 0.7],
  tritanopia: [0.95, 0.05, 0.0, 0.0, 0.433, 0.567, 0.0, 0.475, 0.525],
  achromatopsia: [0.299, 0.587, 0.114, 0.299, 0.587, 0.114, 0.299, 0.587, 0.114],
};

/** Apply a CVD transform to a single color (preview only; non-destructive). */
export function simulateCvd(c: Color, type: CvdType): Color {
  const m = cvdMatrices[type];
  const { r, g, b, a } = c.srgb;
  return color(
    clamp01(m[0] * r + m[1] * g + m[2] * b),
    clamp01(m[3] * r + m[4] * g + m[5] * b),
    clamp01(m[6] * r + m[7] * g + m[8] * b),
    a,
  );
}
