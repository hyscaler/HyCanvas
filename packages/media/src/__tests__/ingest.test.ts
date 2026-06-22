import { describe, it, expect } from "vitest";
import { fitWithin, coverSize, thumbnailSize, exifTransform, orientedDimensions } from "../ingest";
import { rankSimilar } from "../similar";

describe("ingest geometry", () => {
  it("fitWithin scales down preserving aspect, never upscaling", () => {
    expect(fitWithin(4000, 2000, 1000, 1000)).toEqual({ width: 1000, height: 500 });
    expect(fitWithin(2000, 4000, 1000, 1000)).toEqual({ width: 500, height: 1000 });
    expect(fitWithin(300, 200, 1000, 1000)).toEqual({ width: 300, height: 200 }); // no upscale
    expect(fitWithin(0, 0, 100, 100)).toEqual({ width: 0, height: 0 });
  });

  it("coverSize overflows the box on one axis", () => {
    const s = coverSize(4000, 2000, 1000, 1000);
    expect(Math.max(s.width, s.height)).toBeGreaterThanOrEqual(1000);
    expect(Math.min(s.width, s.height)).toBe(1000); // shorter side exactly covers
  });

  it("thumbnailSize bounds the longest edge", () => {
    expect(thumbnailSize(2048, 1024)).toEqual({ width: 512, height: 256 });
  });

  it("exifTransform maps orientations to rotate + mirror", () => {
    expect(exifTransform(1)).toEqual({ rotate: 0, mirrored: false });
    expect(exifTransform(6)).toEqual({ rotate: 90, mirrored: false });
    expect(exifTransform(3)).toEqual({ rotate: 180, mirrored: false });
    expect(exifTransform(2)).toEqual({ rotate: 0, mirrored: true });
    expect(exifTransform(99)).toEqual({ rotate: 0, mirrored: false }); // fallback
  });

  it("orientedDimensions swaps for 90/270 rotations", () => {
    expect(orientedDimensions(800, 600, 1)).toEqual({ width: 800, height: 600 });
    expect(orientedDimensions(800, 600, 6)).toEqual({ width: 600, height: 800 }); // 90deg
    expect(orientedDimensions(800, 600, 8)).toEqual({ width: 600, height: 800 }); // 270deg
    expect(orientedDimensions(800, 600, 3)).toEqual({ width: 800, height: 600 }); // 180deg
  });
});

describe("rankSimilar", () => {
  const items = [
    { id: "a", hash: "0000" },
    { id: "b", hash: "0001" }, // 1 bit off
    { id: "c", hash: "1111" }, // 4 bits off
    { id: "d", hash: "00" }, // wrong length: skipped
  ];

  it("ranks nearest first by Hamming distance", () => {
    const r = rankSimilar("0000", items);
    expect(r.map((h) => h.item.id)).toEqual(["a", "b", "c"]);
    expect(r[0].distance).toBe(0);
    expect(r[1].distance).toBe(1);
  });

  it("excludeExact drops the identical item", () => {
    const r = rankSimilar("0000", items, { excludeExact: true });
    expect(r.map((h) => h.item.id)).toEqual(["b", "c"]);
  });

  it("maxDistance and limit filter results", () => {
    expect(rankSimilar("0000", items, { maxDistance: 1 }).map((h) => h.item.id)).toEqual(["a", "b"]);
    expect(rankSimilar("0000", items, { limit: 1 }).map((h) => h.item.id)).toEqual(["a"]);
  });
});
