import { describe, expect, it } from "vitest";
import { deckThemes } from "../index";

/** The solid or gradient-start color of a theme background, for comparison. */
function baseColor(t: { background: { color?: string } }): string | undefined {
  return t.background.color;
}

describe("deckThemes seed (default hue variety)", () => {
  it("with no brand palette and no seed, defaults to the first curated hue (blue)", () => {
    const [t] = deckThemes({ count: 1 });
    expect(baseColor(t)?.toLowerCase()).toBe("#1f3a93");
  });

  it("different seeds pick different default hues so briefs are not all blue", () => {
    // Two seeds an offset apart must land on different curated hues.
    const a = baseColor(deckThemes({ count: 1, seed: 0 })[0]);
    const b = baseColor(deckThemes({ count: 1, seed: 1 })[0]);
    expect(a).not.toBe(b);
  });

  it("is deterministic: same seed yields the same hue", () => {
    const a = baseColor(deckThemes({ count: 1, seed: 42 })[0]);
    const b = baseColor(deckThemes({ count: 1, seed: 42 })[0]);
    expect(a).toBe(b);
  });

  it("negative seeds are normalized (no crash, valid hue)", () => {
    const t = deckThemes({ count: 1, seed: -7 })[0];
    expect(baseColor(t)).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("a brand palette leads regardless of seed (seed only affects the default hues)", () => {
    const brand = ["#ff0000"];
    const a = baseColor(deckThemes({ count: 1, brandPalette: brand, seed: 3 })[0]);
    const b = baseColor(deckThemes({ count: 1, brandPalette: brand, seed: 99 })[0]);
    expect(a?.toLowerCase()).toBe("#ff0000");
    expect(a).toBe(b);
  });
});
