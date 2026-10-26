import { describe, expect, it } from "vitest";
import type { BrandKit } from "@hc/sdk";
import { colorsFromHexes, contrastPairs, draftToPatch, duplicatePatch, emptyDraft, hexToColor, kitToDraft, withNeutrals } from "./brandDraft";

function kit(): BrandKit {
  return {
    id: "k1",
    workspaceId: "w1",
    name: "Acme",
    version: 3,
    isDefault: false,
    palettes: [
      { id: "p1", name: "Main", colors: [
        { id: "s1", role: "primary", name: "Acme Red", value: { srgb: { r: 0.9, g: 0.2, b: 0.27, a: 0.5 } } },
        { id: "s2", role: "accent", value: hexToColor("#1d3557") },
      ] },
      { id: "p2", name: "Seasonal", colors: [{ id: "s9", role: "accent", value: hexToColor("#ffcc00") }] },
    ],
    fonts: [
      { id: "f1", role: "heading", fontFamily: "Space Grotesk", defaultStyle: { weight: 700 } },
      { id: "f2", role: "body", fontFamily: "Work Sans" },
      { id: "f3", role: "caption", fontFamily: "IBM Plex Mono" },
    ],
    logos: [{ id: "l1", label: "Mark", assetId: "a1", variants: { dark: "a2" }, minSizePx: 24 }],
    voice: { tone: ["Bold"], doSay: [], dontSay: [], modelProfileId: "mp1" },
    collections: [{ id: "c1", kind: "icons", assetIds: ["a5"] }],
    controls: { lockColors: true, lockFonts: false, restrictTemplates: false, lintPolicy: "warn" },
    createdAt: "",
    updatedAt: "",
  };
}

describe("brand draft", () => {
  it("round-trips a kit without losing what the draft does not edit", () => {
    const k = kit();
    const patch = draftToPatch(kitToDraft(k), k, "Palette");
    // The untouched swatch keeps its name and exact value (alpha included).
    expect(patch.palettes?.[0].colors[0]).toEqual(k.palettes[0].colors[0]);
    // Extra palettes, other font roles, a font's default style, logo
    // variants and the voice's model profile all survive.
    expect(patch.palettes?.[1]).toEqual(k.palettes[1]);
    expect(patch.fonts).toEqual(k.fonts);
    expect(patch.logos).toEqual(k.logos);
    expect(patch.voice?.modelProfileId).toBe("mp1");
    // Controls round-trip as stored; collections are never part of an edit patch.
    expect(patch.controls).toEqual(k.controls);
    expect(patch).not.toHaveProperty("collections");
  });

  it("writes edited controls and logo sizing", () => {
    const k = kit();
    const d = kitToDraft(k);
    d.controls = { ...d.controls, lockFonts: true, lintPolicy: "block" };
    d.logos[0] = { ...d.logos[0], clearSpaceRatio: 0.5, minSizePx: undefined };
    const patch = draftToPatch(d, k, "Palette");
    expect(patch.controls).toEqual({ lockColors: true, lockFonts: true, restrictTemplates: false, lintPolicy: "block" });
    expect(patch.logos?.[0]).toEqual({ id: "l1", label: "Mark", assetId: "a1", variants: { dark: "a2" }, clearSpaceRatio: 0.5, minSizePx: undefined });
  });

  it("starts a fresh draft with the server's default controls", () => {
    expect(emptyDraft().controls).toEqual({ lockColors: false, lockFonts: false, restrictTemplates: false, lintPolicy: "warn" });
  });

  it("writes edited colors and fonts in place", () => {
    const k = kit();
    const d = kitToDraft(k);
    d.colors[1].hex = "#00ff00";
    d.headingFont = "Fraunces";
    d.bodyFont = "";
    d.accentFont = "Syne";
    const patch = draftToPatch(d, k, "Palette");
    expect(patch.palettes?.[0].colors[1]).toMatchObject({ id: "s2", role: "accent", value: hexToColor("#00ff00") });
    expect(patch.fonts).toEqual([
      { id: "f1", role: "heading", fontFamily: "Fraunces", defaultStyle: { weight: 700 }, fontAssetId: null },
      { id: "f3", role: "caption", fontFamily: "IBM Plex Mono" },
      expect.objectContaining({ role: "accent", fontFamily: "Syne" }),
    ]);
  });

  it("builds a fresh kit's patch from an empty draft plus colors", () => {
    const d = emptyDraft();
    d.name = "  New brand ";
    d.colors = colorsFromHexes(["#AA0000", "#aa0000", "nope", "#00aa00", "#0000aa"]);
    const patch = draftToPatch(d, null, "Palette");
    expect(patch.name).toBe("New brand");
    expect(patch.palettes?.[0].name).toBe("Palette");
    expect(patch.palettes?.[0].colors.map((c) => c.role)).toEqual(["primary", "secondary", "accent"]);
    expect(patch.voice).toBeNull();
    expect(patch.fonts).toEqual([]);
  });

  it("duplicates every array by value", () => {
    const k = kit();
    const p = duplicatePatch(k);
    expect(p.collections).toEqual(k.collections);
    expect(p.collections).not.toBe(k.collections);
    expect(p.controls).toEqual(k.controls);
  });

  it("adds text and background neutrals that meet AAA", () => {
    const out = withNeutrals(colorsFromHexes(["#9b2c72", "#e0457b"]));
    const text = out.find((c) => c.role === "text");
    const bg = out.find((c) => c.role === "background");
    expect(text && bg).toBeTruthy();
    expect(contrastPairs(out)[0]).toMatchObject({ fg: text, bg });
    expect(contrastPairs(out)[0].ratio).toBeGreaterThanOrEqual(7);
    // Run again: nothing more is added.
    expect(withNeutrals(out)).toHaveLength(out.length);
  });

  it("gives an extracted near-black or near-white the neutral role instead of adding one", () => {
    const out = withNeutrals(colorsFromHexes(["#9b2c72", "#e0457b", "#111111", "#fafafa"]));
    expect(out.map((c) => c.role)).toEqual(["primary", "secondary", "text", "background"]);
  });

  it("lists only pairs readable as body text, lighter color as background", () => {
    const pairs = contrastPairs(colorsFromHexes(["#ffffff", "#777777", "#000000"]));
    expect(pairs.map((p) => [p.fg.hex, p.bg.hex])).toEqual([["#000000", "#ffffff"], ["#000000", "#777777"]]);
  });
});
