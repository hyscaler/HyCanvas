// Translate scene-model node effects into Canvas2D painting. Blur, glow, and drop
// shadows map cleanly onto the CSS filter string the 2D context understands;
// outlines are stroked separately. Color adjustments map onto CSS
// filter functions where native, or approximate combinations otherwise. The
// duotone effect is a per-pixel luminance->gradient map rendered to a
// cached offscreen buffer (see duotone helpers below), not a CSS filter.

import type { Color, Effect } from "@hc/schema";
import { colorToCss } from "./color";

/**
 * Map a single adjustment op onto zero or more CSS filter functions.
 *
 * Native CSS filters (brightness/contrast/saturate/grayscale/sepia/invert/
 * hue-rotate/blur) pass straight through. The extended ops that have no
 * native filter are approximated by combining native ones:
 *  - exposure: a brightness multiplier (1 + value).
 *  - warmth/temperature: a reversible white-balance-ish approximation, a small
 *    hue-rotate (warm toward red/orange, cool toward blue) plus a gentle
 *    saturation lift, symmetric around 0. Approximate but live.
 *  - tint: green<->magenta, approximated as a hue rotation about the green axis.
 *  - vibrance: a gentler saturation lift than `saturate`.
 *  - highlights/shadows: tonal pushes approximated with brightness+contrast.
 * Each op's neutral value is a no-op (identity) so a default slider changes
 * nothing (AC-2).
 */
export function adjustmentOpToFilters(name: string, value: number): string[] {
  switch (name) {
    case "brightness":
    case "contrast":
    case "saturate":
    case "grayscale":
    case "sepia":
    case "invert":
      return [`${name}(${value})`];
    case "hue-rotate":
      return value !== 0 ? [`hue-rotate(${value}deg)`] : [];
    case "blur":
    case "blur-amount":
      return value > 0 ? [`blur(${value}px)`] : [];
    // --- extended F24 ops approximated from native filters ------------------
    case "exposure":
      // value in roughly -1..1; neutral 0. Acts as a brightness multiplier.
      return value !== 0 ? [`brightness(${(1 + value).toFixed(4)})`] : [];
    case "vibrance":
      // value -1..1; neutral 0. Half-strength saturation lift to protect skin.
      return value !== 0 ? [`saturate(${(1 + value * 0.5).toFixed(4)})`] : [];
    case "warmth":
    case "temperature": {
      // value -1..1; neutral 0. A reversible white-balance-ish approximation:
      // a small hue rotation (warm -> toward red/orange, cool -> toward blue)
      // plus a gentle saturation lift, symmetric around 0 so warm and cool are
      // mirror images. Neutral (0) is a true no-op.
      if (value === 0) return [];
      return [`hue-rotate(${(-value * 12).toFixed(2)}deg)`, `saturate(${(1 + Math.abs(value) * 0.1).toFixed(4)})`];
    }
    case "tint": {
      // value -1..1 green<->magenta; neutral 0. Approximate via hue rotation.
      if (value === 0) return [];
      return [`hue-rotate(${(value * 40).toFixed(2)}deg)`];
    }
    case "highlights": {
      // value -1..1; neutral 0. Push upper tones: brightness with a touch of
      // inverse contrast so midtones move less than highlights.
      if (value === 0) return [];
      return [`brightness(${(1 + value * 0.25).toFixed(4)})`, `contrast(${(1 - value * 0.08).toFixed(4)})`];
    }
    case "shadows": {
      // value -1..1; neutral 0. Lift/crush shadows via contrast + brightness.
      if (value === 0) return [];
      return [`contrast(${(1 - value * 0.18).toFixed(4)})`, `brightness(${(1 + value * 0.12).toFixed(4)})`];
    }
    default:
      return [];
  }
}

/** A CSS filter string for a node's effects, or "none". */
export function effectsFilter(effects?: Effect[]): string {
  if (!effects || effects.length === 0) return "none";
  const parts: string[] = [];
  for (const e of effects) {
    switch (e.kind) {
      case "blur":
        if (e.radius > 0) parts.push(`blur(${e.radius}px)`);
        break;
      case "glow":
        parts.push(`drop-shadow(0px 0px ${e.radius}px ${colorToCss(e.color)})`);
        break;
      case "shadow":
        if (e.type === "drop") {
          parts.push(
            `drop-shadow(${e.offsetX}px ${e.offsetY}px ${e.blur}px ${colorToCss(e.color)})`,
          );
        }
        break;
      case "adjustment":
        // Color adjustments map onto CSS filter functions.
        for (const op of e.ops) {
          for (const f of adjustmentOpToFilters(op.name, op.value)) parts.push(f);
        }
        break;
      default:
        break; // outline (stroked separately), duotone (offscreen), inner shadow deferred
    }
  }
  return parts.length > 0 ? parts.join(" ") : "none";
}

export interface OutlineSpec {
  color: string;
  width: number;
}

/** Outline effects, as stroke specs to draw around the node box. */
export function outlineSpecs(effects?: Effect[]): OutlineSpec[] {
  if (!effects) return [];
  const out: OutlineSpec[] = [];
  for (const e of effects) {
    if (e.kind === "outline") out.push({ color: colorToCss(e.color), width: e.width });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Duotone
// ---------------------------------------------------------------------------

/** The active duotone effect on a node, if any (the last one wins). */
export function duotoneEffect(effects?: Effect[]): (Effect & { kind: "duotone" }) | undefined {
  if (!effects) return undefined;
  let found: (Effect & { kind: "duotone" }) | undefined;
  for (const e of effects) if (e.kind === "duotone") found = e;
  return found;
}

/** Rec. 601 luma of an sRGB triple in 0..255. Pure and allocation-free. */
export function luminance601(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Build a 256-entry RGB lookup table that maps a luminance bucket (0..255) to
 * the duotone gradient color: dark pixels toward `shadows`, light pixels toward
 * `highlights`, linearly interpolated. Pure (no canvas), so it can be unit
 * tested and cached by the renderer keyed on the two colors.
 */
export function duotoneLut(shadows: Color, highlights: Color): Uint8ClampedArray {
  const s = shadows.srgb;
  const h = highlights.srgb;
  const sr = s.r * 255, sg = s.g * 255, sb = s.b * 255;
  const hr = h.r * 255, hg = h.g * 255, hb = h.b * 255;
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const o = i * 3;
    lut[o] = sr + (hr - sr) * t;
    lut[o + 1] = sg + (hg - sg) * t;
    lut[o + 2] = sb + (hb - sb) * t;
  }
  return lut;
}

/**
 * Apply a duotone map to RGBA pixel data in place, blending the mapped color
 * against the original by `intensity` (0 = original, 1 = full duotone). Alpha
 * is preserved. Pure over the buffer (no canvas), so it is unit testable and
 * reusable in the worker/headless paths. `lut` comes from {@link duotoneLut}.
 */
export function applyDuotone(
  data: Uint8ClampedArray,
  lut: Uint8ClampedArray,
  intensity: number,
): void {
  const k = intensity < 0 ? 0 : intensity > 1 ? 1 : intensity;
  if (k === 0) return;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 0) continue; // fully transparent pixels carry no color to map
    const lum = luminance601(data[i], data[i + 1], data[i + 2]) | 0;
    const o = lum * 3;
    data[i] = data[i] + (lut[o] - data[i]) * k;
    data[i + 1] = data[i + 1] + (lut[o + 1] - data[i + 1]) * k;
    data[i + 2] = data[i + 2] + (lut[o + 2] - data[i + 2]) * k;
  }
}
