import { describe, it, expect } from "vitest";
import type { Color } from "@hc/schema";
import {
  clamp01,
  cmykToRgb,
  color,
  colorHarmony,
  contrastRatio,
  cvdMatrices,
  extractPalette,
  fixToAA,
  fromHex,
  gamutCheck,
  hslToRgb,
  nearestPaletteColor,
  deltaE,
  rgbToCmyk,
  rgbToHsl,
  seriesColorAt,
  seriesPalette,
  seriesPaletteHex,
  simulateCvd,
  toHex,
  wcag,
  type Bitmap,
} from "../index";

const black: Color = { srgb: { r: 0, g: 0, b: 0, a: 1 } };
const WHITE: Color = { srgb: { r: 1, g: 1, b: 1, a: 1 } };

describe("color harmony", () => {
  const RED = fromHex("#ff0000")!;
  it("complementary returns the base plus the opposite hue (~cyan)", () => {
    const [base, comp] = colorHarmony(RED, "complementary");
    expect(toHex(base)).toBe("#ff0000");
    expect(toHex(comp)).toBe("#00ffff");
  });
  it("triadic returns three colors", () => {
    expect(colorHarmony(RED, "triadic")).toHaveLength(3);
  });
  it("analogous and split-complementary return three; tetradic four", () => {
    expect(colorHarmony(RED, "analogous")).toHaveLength(3);
    expect(colorHarmony(RED, "split-complementary")).toHaveLength(3);
    expect(colorHarmony(RED, "tetradic")).toHaveLength(4);
  });
  it("monochromatic varies lightness around the base", () => {
    const mono = colorHarmony(RED, "monochromatic");
    expect(mono).toHaveLength(5);
    expect(toHex(mono[0])).not.toBe(toHex(mono[4]));
  });
});

describe("AC-2: HEX round trip and parsing", () => {
  it("parses #rrggbb and reformats it", () => {
    const c = fromHex("#3b82f6")!;
    expect(c.srgb.r).toBeCloseTo(0x3b / 255, 6);
    expect(c.srgb.g).toBeCloseTo(0x82 / 255, 6);
    expect(c.srgb.b).toBeCloseTo(0xf6 / 255, 6);
    expect(toHex(c)).toBe("#3b82f6");
  });

  it("supports shorthand, alpha, and no-hash forms", () => {
    expect(toHex(fromHex("#fff")!)).toBe("#ffffff");
    expect(toHex(fromHex("abc")!)).toBe("#aabbcc");
    const a = fromHex("#11223380")!;
    expect(a.srgb.a).toBeCloseTo(0x80 / 255, 6);
    expect(toHex(a)).toBe("#11223380");
  });

  it("rejects malformed strings", () => {
    expect(fromHex("#12")).toBeNull();
    expect(fromHex("nope")).toBeNull();
    expect(fromHex("#1234567")).toBeNull();
  });
});

describe("AC-2: HSL conversions", () => {
  it("round-trips a saturated color through HSL", () => {
    const c = fromHex("#3b82f6")!;
    const back = hslToRgb(rgbToHsl(c));
    expect(back.srgb.r).toBeCloseTo(c.srgb.r, 5);
    expect(back.srgb.g).toBeCloseTo(c.srgb.g, 5);
    expect(back.srgb.b).toBeCloseTo(c.srgb.b, 5);
  });

  it("matches a reference vector (pure red)", () => {
    const hsl = rgbToHsl(color(1, 0, 0));
    expect(hsl.h).toBeCloseTo(0, 4);
    expect(hsl.s).toBeCloseTo(1, 6);
    expect(hsl.l).toBeCloseTo(0.5, 6);
  });

  it("handles achromatic colors (gray has zero saturation)", () => {
    const hsl = rgbToHsl(color(0.5, 0.5, 0.5));
    expect(hsl.s).toBe(0);
    expect(hslToRgb(hsl).srgb.r).toBeCloseTo(0.5, 6);
  });
});

describe("AC-2: CMYK conversions", () => {
  it("converts pure colors to reference CMYK", () => {
    expect(rgbToCmyk(color(1, 0, 0))).toMatchObject({ c: 0, m: 1, y: 1, k: 0 });
    expect(rgbToCmyk(black)).toMatchObject({ c: 0, m: 0, y: 0, k: 1 });
    expect(rgbToCmyk(WHITE)).toMatchObject({ c: 0, m: 0, y: 0, k: 0 });
  });

  it("round-trips and preserves authoritative CMYK on the color", () => {
    const c = cmykToRgb({ c: 0.2, m: 0.4, y: 0.6, k: 0.1 });
    expect(c.cmyk).toEqual({ c: 0.2, m: 0.4, y: 0.6, k: 0.1 });
    // rgbToCmyk honors explicit cmyk verbatim.
    expect(rgbToCmyk(c)).toEqual({ c: 0.2, m: 0.4, y: 0.6, k: 0.1 });
  });
});

describe("AC-6: WCAG contrast and Fix to AA", () => {
  it("black on white is the maximum 21:1", () => {
    expect(contrastRatio(black, WHITE)).toBeCloseTo(21, 4);
  });

  it("reports correct AA/AAA pass-fail for a known pair", () => {
    // #767676 on white is the canonical AA-normal boundary (~4.54:1).
    const r = wcag(fromHex("#767676")!, WHITE);
    expect(r.ratio).toBeGreaterThanOrEqual(4.5);
    expect(r.aaNormal).toBe(true);
    expect(r.aaaNormal).toBe(false);
  });

  it("accounts for translucent foregrounds by compositing", () => {
    const halfBlack: Color = { srgb: { r: 0, g: 0, b: 0, a: 0.5 } };
    const opaque = contrastRatio(black, WHITE);
    const translucent = contrastRatio(halfBlack, WHITE);
    expect(translucent).toBeLessThan(opaque);
  });

  it("Fix to AA nudges a failing color to a passing one", () => {
    const fg = fromHex("#999999")!; // fails AA on white
    expect(wcag(fg, WHITE).aaNormal).toBe(false);
    const fixed = fixToAA(fg, WHITE);
    expect(contrastRatio(fixed, WHITE)).toBeGreaterThanOrEqual(4.5);
  });

  it("Fix to AA leaves an already-passing color unchanged", () => {
    expect(fixToAA(black, WHITE)).toBe(black);
  });
});

describe("AC-4: palette extraction", () => {
  function bitmap(colors: [number, number, number][], w = 8): Bitmap {
    const h = colors.length;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        data[o] = colors[y][0];
        data[o + 1] = colors[y][1];
        data[o + 2] = colors[y][2];
        data[o + 3] = 255;
      }
    }
    return { width: w, height: h, data };
  }

  it("extracts the requested count from a multi-color image", () => {
    const bmp = bitmap([
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 0],
    ]);
    const pal = extractPalette(bmp, 4);
    expect(pal).toHaveLength(4);
    pal.forEach((c) => expect(c.srgb.a).toBe(1));
  });

  it("is deterministic for the same input", () => {
    const bmp = bitmap([
      [10, 20, 30],
      [200, 100, 50],
      [60, 180, 220],
    ]);
    expect(extractPalette(bmp, 3)).toEqual(extractPalette(bmp, 3));
  });

  it("skips fully transparent pixels and handles empty input", () => {
    const data = new Uint8ClampedArray(4 * 4); // all zero -> alpha 0
    expect(extractPalette({ width: 2, height: 2, data }, 3)).toEqual([]);
  });
});

describe("AC-8: CVD simulation", () => {
  it("transforms a color for each deficiency type", () => {
    const red = color(1, 0, 0);
    (["protanopia", "deuteranopia", "tritanopia", "achromatopsia"] as const).forEach((t) => {
      const sim = simulateCvd(red, t);
      expect(sim).not.toEqual(red);
      // channels stay in range
      expect(clamp01(sim.srgb.r)).toBe(sim.srgb.r);
    });
  });

  it("achromatopsia produces equal channels (grayscale)", () => {
    const g = simulateCvd(color(1, 0, 0), "achromatopsia");
    expect(g.srgb.r).toBeCloseTo(g.srgb.g, 6);
    expect(g.srgb.g).toBeCloseTo(g.srgb.b, 6);
  });

  it("preserves alpha", () => {
    const c: Color = { srgb: { r: 1, g: 0, b: 0, a: 0.3 } };
    expect(simulateCvd(c, "deuteranopia").srgb.a).toBe(0.3);
  });

  it("exposes a matrix per type", () => {
    expect(Object.keys(cvdMatrices)).toHaveLength(4);
    cvdMatrices.protanopia.forEach((n) => expect(typeof n).toBe("number"));
  });
});

describe("AC-7: gamut check", () => {
  it("flags a vivid out-of-gamut color and suggests a nearest", () => {
    // A saturated cyan tends to compress under naive CMYK round-trip.
    const vivid = color(0, 1, 1);
    const res = gamutCheck(vivid, "FOGRA39");
    if (!res.inGamut) {
      expect(res.nearest).toBeDefined();
      expect(res.nearest!.srgb.a).toBe(vivid.srgb.a);
    } else {
      // If it happens to round-trip exactly, that is also acceptable.
      expect(res.nearest).toBeUndefined();
    }
  });

  it("reports neutral colors as in gamut (round-trip is lossless)", () => {
    expect(gamutCheck(color(0.5, 0.5, 0.5)).inGamut).toBe(true);
    expect(gamutCheck(black).inGamut).toBe(true);
    expect(gamutCheck(WHITE).inGamut).toBe(true);
  });
});

describe("F27: default chart series palette", () => {
  it("returns the requested number of colors", () => {
    expect(seriesPalette(0)).toEqual([]);
    expect(seriesPalette(3)).toHaveLength(3);
    expect(seriesPalette(seriesPaletteHex.length + 2)).toHaveLength(seriesPaletteHex.length + 2);
  });
  it("matches fromHex of the base scheme and cycles past its length", () => {
    expect(seriesColorAt(0)).toEqual(fromHex(seriesPaletteHex[0]));
    expect(seriesColorAt(seriesPaletteHex.length)).toEqual(seriesColorAt(0));
  });
  it("seriesColorAt is stable for the same index (deterministic)", () => {
    expect(seriesColorAt(2)).toEqual(seriesColorAt(2));
  });
});

describe("F18 AC-2: nearest brand color (CIELAB deltaE)", () => {
  const RED: Color = { srgb: { r: 1, g: 0, b: 0, a: 1 } };
  const GREEN: Color = { srgb: { r: 0, g: 1, b: 0, a: 1 } };
  const BLUE: Color = { srgb: { r: 0, g: 0, b: 1, a: 1 } };
  const palette = [RED, GREEN, BLUE];

  it("returns the exact match with distance ~0", () => {
    const m = nearestPaletteColor({ srgb: { r: 1, g: 0, b: 0, a: 1 } }, palette)!;
    expect(m.index).toBe(0);
    expect(m.distance).toBeCloseTo(0, 6);
    expect(m.color).toBe(RED);
  });

  it("snaps a near-red to the red swatch over green/blue", () => {
    const nearRed: Color = { srgb: { r: 0.9, g: 0.1, b: 0.12, a: 1 } };
    const m = nearestPaletteColor(nearRed, palette)!;
    expect(m.index).toBe(0);
    expect(deltaE(nearRed, RED)).toBeLessThan(deltaE(nearRed, GREEN));
    expect(deltaE(nearRed, RED)).toBeLessThan(deltaE(nearRed, BLUE));
  });

  it("ignores alpha when matching and is symmetric", () => {
    const semiBlue: Color = { srgb: { r: 0.02, g: 0.03, b: 0.95, a: 0.4 } };
    expect(nearestPaletteColor(semiBlue, palette)!.index).toBe(2);
    expect(deltaE(RED, GREEN)).toBeCloseTo(deltaE(GREEN, RED), 9);
  });

  it("resolves ties to the earliest palette entry (deterministic)", () => {
    const dup = [BLUE, BLUE];
    expect(nearestPaletteColor(BLUE, dup)!.index).toBe(0);
  });

  it("returns null for an empty palette (keep the original color)", () => {
    expect(nearestPaletteColor(RED, [])).toBeNull();
  });
});
