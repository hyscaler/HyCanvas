import { describe, it, expect } from "vitest";
import { fitStickyFontScale } from "../sticky";

describe("fitStickyFontScale", () => {
  const W = 200;
  const H = 200;

  it("empty text returns the max scale", () => {
    expect(fitStickyFontScale("", W, H, { maxScale: 3 })).toBe(3);
  });

  it("is monotonic: more text yields a smaller-or-equal scale", () => {
    const short = fitStickyFontScale("Hi", W, H);
    const medium = fitStickyFontScale("A medium length sentence here", W, H);
    const long = fitStickyFontScale(
      "A much much longer paragraph of text that should clearly need a smaller font size to fit inside the same little sticky card area",
      W,
      H,
    );
    expect(medium).toBeLessThanOrEqual(short);
    expect(long).toBeLessThanOrEqual(medium);
    expect(long).toBeLessThan(short);
  });

  it("clamps to maxScale for tiny text", () => {
    expect(fitStickyFontScale("a", W, H, { maxScale: 2, minScale: 0.25 })).toBe(2);
  });

  it("clamps to minScale for overwhelming text", () => {
    const huge = "word ".repeat(2000);
    expect(fitStickyFontScale(huge, 100, 100, { minScale: 0.3, maxScale: 3 })).toBe(0.3);
  });

  it("stays within the clamp range", () => {
    const s = fitStickyFontScale("some moderate text content", W, H, {
      minScale: 0.5,
      maxScale: 2,
    });
    expect(s).toBeGreaterThanOrEqual(0.5);
    expect(s).toBeLessThanOrEqual(2);
  });

  it("a single very long word forces a smaller scale than the same length split into words", () => {
    const oneWord = fitStickyFontScale("supercalifragilisticexpialidocious", W, H);
    const split = fitStickyFontScale("super cali fragilistic", W, H);
    expect(oneWord).toBeLessThanOrEqual(split);
  });
});
