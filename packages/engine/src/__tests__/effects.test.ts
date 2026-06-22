import { describe, it, expect } from "vitest";
import type { Color, Effect } from "@hc/schema";
import {
  adjustmentOpToFilters,
  effectsFilter,
  duotoneEffect,
  duotoneLut,
  applyDuotone,
  luminance601,
} from "../effects";

const srgb = (r: number, g: number, b: number, a = 1): Color => ({ srgb: { r, g, b, a } });

describe("adjustmentOpToFilters (F24)", () => {
  it("passes native CSS filters straight through", () => {
    expect(adjustmentOpToFilters("brightness", 1.2)).toEqual(["brightness(1.2)"]);
    expect(adjustmentOpToFilters("contrast", 0.8)).toEqual(["contrast(0.8)"]);
    expect(adjustmentOpToFilters("saturate", 1.5)).toEqual(["saturate(1.5)"]);
    expect(adjustmentOpToFilters("grayscale", 0.5)).toEqual(["grayscale(0.5)"]);
    expect(adjustmentOpToFilters("sepia", 0.3)).toEqual(["sepia(0.3)"]);
    expect(adjustmentOpToFilters("hue-rotate", 45)).toEqual(["hue-rotate(45deg)"]);
    expect(adjustmentOpToFilters("blur", 4)).toEqual(["blur(4px)"]);
    expect(adjustmentOpToFilters("blur-amount", 2)).toEqual(["blur(2px)"]);
  });

  it("neutral values are a no-op (identity) for extended ops (AC-2)", () => {
    for (const name of ["exposure", "warmth", "temperature", "tint", "vibrance", "highlights", "shadows", "hue-rotate"]) {
      expect(adjustmentOpToFilters(name, 0)).toEqual([]);
    }
    expect(adjustmentOpToFilters("blur", 0)).toEqual([]);
  });

  it("exposure maps to a brightness multiplier", () => {
    expect(adjustmentOpToFilters("exposure", 0.5)).toEqual(["brightness(1.5000)"]);
  });

  it("vibrance is a half-strength saturation lift", () => {
    expect(adjustmentOpToFilters("vibrance", 1)).toEqual(["saturate(1.5000)"]);
  });

  it("warmth is a symmetric, reversible hue-rotate + saturate around 0", () => {
    const warm = adjustmentOpToFilters("warmth", 0.5);
    const cool = adjustmentOpToFilters("warmth", -0.5);
    // Both legs use the same two filter functions (no sepia desaturation).
    expect(warm[0]).toMatch(/^hue-rotate\(/);
    expect(warm[1]).toMatch(/^saturate\(/);
    expect(cool[0]).toMatch(/^hue-rotate\(/);
    expect(cool[1]).toMatch(/^saturate\(/);
    // Hue rotation is opposite-signed (mirror images); warm rotates negative.
    expect(warm[0]).toBe("hue-rotate(-6.00deg)");
    expect(cool[0]).toBe("hue-rotate(6.00deg)");
    // Saturation lift is symmetric (depends only on magnitude).
    expect(warm[1]).toBe(cool[1]);
    expect(warm[1]).toBe("saturate(1.0500)");
    // temperature is an alias for warmth.
    expect(adjustmentOpToFilters("temperature", 0.5)).toEqual(warm);
  });

  it("tint rotates hue green<->magenta", () => {
    expect(adjustmentOpToFilters("tint", 1)).toEqual(["hue-rotate(40.00deg)"]);
    expect(adjustmentOpToFilters("tint", -1)).toEqual(["hue-rotate(-40.00deg)"]);
  });

  it("highlights and shadows combine brightness + contrast", () => {
    expect(adjustmentOpToFilters("highlights", 1).length).toBe(2);
    expect(adjustmentOpToFilters("shadows", -1).length).toBe(2);
  });

  it("unknown ops contribute nothing", () => {
    expect(adjustmentOpToFilters("nope", 5)).toEqual([]);
  });
});

describe("effectsFilter with extended adjustment ops", () => {
  it("joins multiple ops from one adjustment effect into a filter string", () => {
    const effects: Effect[] = [
      { kind: "adjustment", ops: [
        { name: "brightness", value: 1.1 },
        { name: "exposure", value: 0.2 },
        { name: "warmth", value: 0.5 },
      ] },
    ];
    const out = effectsFilter(effects);
    expect(out).toContain("brightness(1.1)");
    expect(out).toContain("brightness(1.2000)");
    expect(out).toContain("hue-rotate(");
    expect(out).toContain("saturate(");
  });

  it("returns 'none' for an empty or undefined effects list", () => {
    expect(effectsFilter()).toBe("none");
    expect(effectsFilter([])).toBe("none");
  });

  it("duotone does not contribute to the CSS filter string", () => {
    const effects: Effect[] = [{ kind: "duotone", shadows: srgb(0, 0, 0), highlights: srgb(1, 1, 1), intensity: 1 }];
    expect(effectsFilter(effects)).toBe("none");
  });
});

describe("duotone helpers (F24 FR-12)", () => {
  it("duotoneEffect returns the last duotone in the stack", () => {
    const a: Effect = { kind: "duotone", shadows: srgb(0, 0, 0), highlights: srgb(1, 0, 0), intensity: 0.5 };
    const b: Effect = { kind: "duotone", shadows: srgb(0, 0, 1), highlights: srgb(0, 1, 0), intensity: 1 };
    expect(duotoneEffect([a, b])).toBe(b);
    expect(duotoneEffect([{ kind: "blur", radius: 2 }])).toBeUndefined();
  });

  it("luminance601 weights green most, blue least", () => {
    expect(luminance601(255, 0, 0)).toBeCloseTo(76.245, 2);
    expect(luminance601(0, 255, 0)).toBeCloseTo(149.685, 2);
    expect(luminance601(0, 0, 255)).toBeCloseTo(29.07, 2);
    expect(luminance601(255, 255, 255)).toBeCloseTo(255, 4);
  });

  it("duotoneLut maps 0 to shadows and 255 to highlights", () => {
    // Endpoints are exact: black->shadows at index 0, white->highlights at 255.
    const lut = duotoneLut(srgb(0, 0, 0), srgb(1, 1, 1));
    expect(lut.length).toBe(256 * 3);
    expect([lut[0], lut[1], lut[2]]).toEqual([0, 0, 0]);
    const last = 255 * 3;
    expect([lut[last], lut[last + 1], lut[last + 2]]).toEqual([255, 255, 255]);
    // The ramp is monotonically non-decreasing between the endpoints.
    const colored = duotoneLut(srgb(0.1, 0.2, 0.3), srgb(0.9, 0.8, 0.7));
    expect(colored[0]).toBeLessThan(colored[255 * 3]); // shadows R < highlights R
  });

  it("applyDuotone at intensity 1 fully recolors by luminance, preserving alpha", () => {
    const lut = duotoneLut(srgb(0, 0, 0), srgb(1, 1, 1)); // black->white ramp
    // a mid-gray pixel (lum ~128) and an opaque red pixel
    const data = new Uint8ClampedArray([128, 128, 128, 200, 255, 0, 0, 255]);
    applyDuotone(data, lut, 1);
    // gray -> its own luminance gray, alpha unchanged
    expect(data[3]).toBe(200);
    // red(lum 76) -> 76 gray on all channels
    expect(data[4]).toBe(76);
    expect(data[5]).toBe(76);
    expect(data[6]).toBe(76);
    expect(data[7]).toBe(255);
  });

  it("applyDuotone at intensity 0 is a no-op", () => {
    const lut = duotoneLut(srgb(1, 0, 0), srgb(0, 0, 1));
    const data = new Uint8ClampedArray([10, 20, 30, 255]);
    applyDuotone(data, lut, 0);
    expect(Array.from(data)).toEqual([10, 20, 30, 255]);
  });

  it("applyDuotone skips fully transparent pixels", () => {
    const lut = duotoneLut(srgb(1, 0, 0), srgb(0, 0, 1));
    const data = new Uint8ClampedArray([10, 20, 30, 0]);
    applyDuotone(data, lut, 1);
    expect(Array.from(data)).toEqual([10, 20, 30, 0]);
  });
});
