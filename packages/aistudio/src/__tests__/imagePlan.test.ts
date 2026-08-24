import { describe, expect, it } from "vitest";
import { promptAssetKey, routeImageSource } from "../index";

describe("promptAssetKey", () => {
  it("is stable across case and whitespace variants", () => {
    const a = promptAssetKey("A calm  Mountain lake");
    expect(promptAssetKey("a calm mountain LAKE ")).toBe(a);
    expect(a).toMatch(/^aiimg-[0-9a-f]{8}$/);
  });
  it("differs for different prompts", () => {
    expect(promptAssetKey("a cat")).not.toBe(promptAssetKey("a dog"));
  });
});

describe("routeImageSource", () => {
  it("routes short concrete subjects to stock", () => {
    expect(routeImageSource("a barista pouring latte art")).toBe("stock");
    expect(routeImageSource("mountain lake at sunrise")).toBe("stock");
  });
  it("routes stylized or abstract prompts to generation", () => {
    expect(routeImageSource("abstract gradient background with generous empty space")).toBe("generate");
    expect(routeImageSource("isometric 3d render of a rocket")).toBe("generate");
    expect(routeImageSource("a flat design illustration of teamwork")).toBe("generate");
  });
  it("routes long descriptive prompts to generation", () => {
    expect(routeImageSource("a barista pouring latte art in a sunlit cafe while customers watch from wooden tables")).toBe("generate");
  });
  it("routes empty prompts to generation (the safe default)", () => {
    expect(routeImageSource("  ")).toBe("generate");
  });
});

describe("changedImagePrompts", () => {
  it("returns only new or genuinely changed prompts", async () => {
    const { changedImagePrompts } = await import("../index");
    const current = { pic: "a lighthouse at dusk", side: "a harbor" };
    expect(changedImagePrompts(current, { pic: "a lighthouse at dusk", side: "a MOUNTAIN" })).toEqual({ side: "a MOUNTAIN" });
    expect(changedImagePrompts(current, { fresh: "something new" })).toEqual({ fresh: "something new" });
  });

  it("normalizes case and whitespace like the reuse key (not a change)", async () => {
    const { changedImagePrompts } = await import("../index");
    expect(changedImagePrompts({ pic: "A  Lighthouse at dusk" }, { pic: "a lighthouse at DUSK " })).toEqual({});
  });
});
