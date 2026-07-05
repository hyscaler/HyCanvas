// Validation gate for the bundled sticker library: every sticker must parse
// through the SAME SVG-to-vector path the editor uses on insert (addIconSvg ->
// flattenSvgToNodes), stay inside the 0 0 100 100 viewBox, and avoid syntax the
// parser cannot round-trip (strokes, transforms, groups, gradients, text).

import { describe, it, expect } from "vitest";
import { STICKERS } from "./stickers";
import { flattenSvgToNodes } from "./svgFlatten";

const WRAPPER = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">';
const FORBIDDEN = /stroke|transform=|<g[ >]|<defs|<text|<image|<line[ >]|<polyline|url\(|href|class=|opacity=/i;

describe("bundled sticker library", () => {
  it("has globally unique ids", () => {
    const seen = new Map<string, number>();
    for (const s of STICKERS) seen.set(s.id, (seen.get(s.id) ?? 0) + 1);
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
    expect(dupes, `duplicate sticker ids: ${dupes.join(", ")}`).toEqual([]);
  });

  it("uses the standard 0 0 100 100 wrapper", () => {
    for (const s of STICKERS) {
      expect(s.svg.startsWith(WRAPPER), `sticker ${s.id} has a non-standard wrapper`).toBe(true);
    }
  });

  it("contains no stroke/transform/group/gradient/text syntax", () => {
    for (const s of STICKERS) {
      expect(FORBIDDEN.test(s.svg), `sticker ${s.id} uses forbidden svg syntax`).toBe(false);
    }
  });

  it("round-trips every sticker through the insert parser", () => {
    for (const s of STICKERS) {
      const { nodes } = flattenSvgToNodes(s.svg, { fallbackFill: true });
      expect(nodes.length, `sticker ${s.id} parsed to zero nodes`).toBeGreaterThanOrEqual(1);
    }
  });

  it("keeps every coordinate within the viewBox (with tolerance)", () => {
    for (const s of STICKERS) {
      // Strip hex colors first so #ef4444 doesn't read as the number 4444.
      // Relative path deltas (e.g. "l-4 42") are legitimately negative, so the
      // check is on magnitude: nothing in a 100x100 sticker exceeds |102|.
      const inner = s.svg.slice(WRAPPER.length).replace(/#[0-9a-fA-F]{3,8}/g, "");
      const nums = inner.match(/-?\d+(?:\.\d+)?/g) ?? [];
      for (const n of nums) {
        const v = Number(n);
        expect(Math.abs(v) <= 102, `sticker ${s.id} has out-of-range number ${v}`).toBe(true);
      }
    }
  });

  it("gives every category-pack sticker search keywords", () => {
    for (const s of STICKERS) {
      if (!s.id.includes("-")) continue; // original inline set predates keywords
      expect((s.keywords ?? []).length, `sticker ${s.id} is missing keywords`).toBeGreaterThanOrEqual(2);
    }
  });
});
