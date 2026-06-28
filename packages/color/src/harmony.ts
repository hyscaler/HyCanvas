// Color-harmony suggestions: given a base color, return a set of colors that sit
// at harmonious hue offsets on the color wheel (complementary, analogous,
// triadic, tetradic, split-complementary, monochromatic). Pure; operates on the
// canonical `Color` type via the HSL conversion in convert.ts.

import type { Color } from "@hc/schema";
import { rgbToHsl, hslToRgb, type Hsl } from "./convert";

export type HarmonyScheme =
  | "complementary"
  | "analogous"
  | "triadic"
  | "tetradic"
  | "split-complementary"
  | "monochromatic";

export const HARMONY_SCHEMES: HarmonyScheme[] = [
  "complementary",
  "analogous",
  "triadic",
  "tetradic",
  "split-complementary",
  "monochromatic",
];

function rot(hsl: Hsl, deg: number): Color {
  return hslToRgb({ ...hsl, h: ((hsl.h + deg) % 360 + 360) % 360 });
}

function withL(hsl: Hsl, l: number): Color {
  return hslToRgb({ ...hsl, l: Math.max(0, Math.min(1, l)) });
}

/** Colors harmonious with `base` for the given scheme, base first. */
export function colorHarmony(base: Color, scheme: HarmonyScheme): Color[] {
  const hsl = rgbToHsl(base);
  switch (scheme) {
    case "complementary":
      return [base, rot(hsl, 180)];
    case "analogous":
      return [rot(hsl, -30), base, rot(hsl, 30)];
    case "triadic":
      return [base, rot(hsl, 120), rot(hsl, 240)];
    case "tetradic":
      return [base, rot(hsl, 90), rot(hsl, 180), rot(hsl, 270)];
    case "split-complementary":
      return [base, rot(hsl, 150), rot(hsl, 210)];
    case "monochromatic": {
      const steps = [-0.3, -0.15, 0, 0.15, 0.3];
      return steps.map((d) => withL(hsl, hsl.l + d));
    }
    default:
      return [base];
  }
}
