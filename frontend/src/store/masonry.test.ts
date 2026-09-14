// Masonry packing for image collages (#39): images keep their own aspect ratio
// and each column advances independently, so a set of mixed shapes packs
// without cropping or leaving gaps.
//
// The aspect ratios come out of the design file, which another client may have
// written, so the malformed cases matter as much as the happy path: a zero, a
// negative, or a NaN aspect must produce a usable box rather than a collapsed
// or inverted one.
import { describe, it, expect } from "vitest";
import { masonryBoxes } from "./editor";

const WIDTH = 300;

describe("masonry packing", () => {
  it("splits the width into equal columns, gaps included", () => {
    const boxes = masonryBoxes(WIDTH, 3, 10, [1, 1, 1]);
    // 300 - 2 gaps of 10 = 280, in three columns.
    for (const b of boxes) expect(b.width).toBeCloseTo(280 / 3, 5);
    expect(boxes[0].x).toBe(0);
    expect(boxes[1].x).toBeCloseTo(280 / 3 + 10, 5);
    expect(boxes[2].x).toBeCloseTo((280 / 3) * 2 + 20, 5);
    // The row still exactly fills the width.
    expect(boxes[2].x + boxes[2].width).toBeCloseTo(WIDTH, 5);
  });

  it("sizes each item to its own aspect ratio", () => {
    // This is the whole point: a 2:1 image is half as tall as a 1:1 one at the
    // same column width, and neither is cropped to match the other.
    const boxes = masonryBoxes(WIDTH, 2, 0, [2, 1]);
    expect(boxes[0].height).toBeCloseTo(150 / 2, 5);
    expect(boxes[1].height).toBeCloseTo(150 / 1, 5);
  });

  it("fills the first row left to right before stacking", () => {
    const boxes = masonryBoxes(WIDTH, 3, 0, [1, 1, 1]);
    expect(boxes.map((b) => b.y)).toEqual([0, 0, 0]);
    expect(boxes[0].x).toBeLessThan(boxes[1].x);
    expect(boxes[1].x).toBeLessThan(boxes[2].x);
  });

  it("sends the next item to the shortest column", () => {
    // Column 0 gets a tall 1:2 image, column 1 a short 2:1. The third item
    // belongs under the SHORT one, which is what keeps the columns even.
    const boxes = masonryBoxes(200, 2, 0, [0.5, 2, 1]);
    expect(boxes[0].height).toBeCloseTo(200, 5); // 100 wide / 0.5
    expect(boxes[1].height).toBeCloseTo(50, 5); // 100 wide / 2
    expect(boxes[2].x).toBeCloseTo(boxes[1].x, 5);
    expect(boxes[2].y).toBeCloseTo(50, 5);
  });

  it("leaves a gap between stacked items too", () => {
    const boxes = masonryBoxes(100, 1, 12, [1, 1]);
    expect(boxes[0].height).toBeCloseTo(100, 5);
    expect(boxes[1].y).toBeCloseTo(100 + 12, 5);
  });

  it("never overlaps two items in the same column", () => {
    const boxes = masonryBoxes(WIDTH, 2, 6, [1, 1.5, 0.8, 2, 1.2, 0.6]);
    const byCol = new Map<number, { y: number; height: number }[]>();
    for (const b of boxes) {
      const col = Math.round(b.x);
      byCol.set(col, [...(byCol.get(col) ?? []), b]);
    }
    for (const items of byCol.values()) {
      items.sort((a, b) => a.y - b.y);
      for (let i = 1; i < items.length; i++) {
        expect(items[i].y).toBeGreaterThanOrEqual(items[i - 1].y + items[i - 1].height);
      }
    }
  });

  describe("falls back to a square rather than trusting bad data", () => {
    const square = masonryBoxes(100, 1, 0, [1])[0].height;

    it("when the aspect is zero or negative", () => {
      expect(masonryBoxes(100, 1, 0, [0])[0].height).toBeCloseTo(square, 5);
      expect(masonryBoxes(100, 1, 0, [-2])[0].height).toBeCloseTo(square, 5);
    });

    it("when the aspect is not a finite number", () => {
      expect(masonryBoxes(100, 1, 0, [NaN])[0].height).toBeCloseTo(square, 5);
      expect(masonryBoxes(100, 1, 0, [Infinity])[0].height).toBeCloseTo(square, 5);
    });
  });

  it("treats a column count below one as a single column", () => {
    // Unreachable from the UI, but a file written elsewhere can carry it.
    expect(masonryBoxes(100, 0, 0, [1, 1]).every((b) => b.x === 0)).toBe(true);
  });

  it("returns nothing for no items rather than an empty column", () => {
    expect(masonryBoxes(WIDTH, 3, 8, [])).toEqual([]);
  });

  it("gives every box a positive size, whatever the inputs", () => {
    // A grid dragged narrower than its own gaps would otherwise compute
    // negative column widths.
    for (const b of masonryBoxes(10, 4, 20, [1, 3, 0.2])) {
      expect(b.width).toBeGreaterThan(0);
      expect(b.height).toBeGreaterThan(0);
    }
  });
});
