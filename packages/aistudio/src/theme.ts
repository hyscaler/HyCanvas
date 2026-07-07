// F39 Phase 2 - deck themes + variations. A DeckTheme is the shared visual
// system (background, kicker) applied to every page of a generated design, so a
// deck looks designed, not assembled. deckThemes() produces N meaningfully
// distinct variants (FR-4) deterministically: variation comes from rotating
// hues and toggling solid/gradient, never randomness.

import { fromHex, toHex } from "@hc/color";
import type { Color } from "@hc/schema";
import type { DeckTheme } from "./outline";

// Curated base hues used when the user has no brand palette. Picked for broad
// appeal and strong contrast with white/near-black text.
const DEFAULT_HUES = ["#1f3a93", "#0f766e", "#7c3aed", "#b91c1c", "#c2410c", "#0e7490", "#4d7c0f", "#9d174d"];

function rotateHue(c: Color, deg: number): Color {
  // Rotate hue in HSL space, preserving rough lightness/saturation.
  const { r, g, b, a } = c.srgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  h = (((h + deg) % 360) + 360) % 360;
  const c1 = (1 - Math.abs(2 * l - 1)) * s;
  const x = c1 * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c1 / 2;
  let rr = 0;
  let gg = 0;
  let bb = 0;
  if (h < 60) [rr, gg, bb] = [c1, x, 0];
  else if (h < 120) [rr, gg, bb] = [x, c1, 0];
  else if (h < 180) [rr, gg, bb] = [0, c1, x];
  else if (h < 240) [rr, gg, bb] = [0, x, c1];
  else if (h < 300) [rr, gg, bb] = [x, 0, c1];
  else [rr, gg, bb] = [c1, 0, x];
  return { srgb: { r: rr + m, g: gg + m, b: bb + m, a } };
}

function darken(c: Color, amt: number): Color {
  const f = Math.max(0, 1 - amt);
  return { srgb: { r: c.srgb.r * f, g: c.srgb.g * f, b: c.srgb.b * f, a: c.srgb.a } };
}

/** Generate N distinct deck themes from a brand palette (if any) or curated
 *  defaults. Each variant differs in base hue and solid/gradient treatment.
 *  Brand fonts (FR-17), when supplied, apply to every variant. */
export function deckThemes(opts: { brandPalette?: string[]; kicker?: string; count: number; fontHeading?: string; fontBody?: string; seed?: number }): DeckTheme[] {
  const count = Math.max(1, Math.min(8, Math.round(opts.count)));
  const brand = (opts.brandPalette ?? [])
    .map(fromHex)
    .filter((c): c is Color => Boolean(c));
  const bases: Color[] = brand.length
    ? brand
    : DEFAULT_HUES.map(fromHex).filter((c): c is Color => Boolean(c));

  // Without a brand palette, offset the starting hue by an optional seed so two
  // different briefs don't both default to the first curated hue (blue). A brand
  // palette always leads with the brand's own first color, so the seed is
  // ignored there.
  const offset = brand.length === 0 && typeof opts.seed === "number" && Number.isFinite(opts.seed)
    ? ((Math.floor(opts.seed) % bases.length) + bases.length) % bases.length
    : 0;

  const themes: DeckTheme[] = [];
  for (let i = 0; i < count; i++) {
    const base = bases[(i + offset) % bases.length];
    // Alternate treatment so consecutive variants look clearly different.
    const treatment = i % 3;
    let background: DeckTheme["background"];
    if (treatment === 0) {
      background = { kind: "solid", color: toHex(base) };
    } else if (treatment === 1) {
      background = {
        kind: "gradient",
        color: toHex(base),
        color2: toHex(darken(rotateHue(base, 18), 0.35)),
        angle: 135,
      };
    } else {
      background = {
        kind: "gradient",
        color: toHex(darken(base, 0.2)),
        color2: toHex(rotateHue(base, -24)),
        angle: 200,
      };
    }
    themes.push({ background, kicker: opts.kicker, fontHeading: opts.fontHeading, fontBody: opts.fontBody });
  }
  return themes;
}
