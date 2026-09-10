// Photo-grid track sizes: a cell can take more of the grid than its neighbours
// instead of every cell splitting the space evenly (#40).
//
// The weights come out of the design file, which another client may have
// written, so the cases that matter most are the malformed ones: a stale array
// sized for a different track count, or a weight that would collapse or invert
// a track. Each of those must fall back to the even split every grid had
// before track sizes existed, never lay out at proportions nobody chose.
import { describe, it, expect } from "vitest";
import { gridCellBox, type GridSpan } from "./editor";

const SIZE = { width: 400, height: 400 };
const one = (row: number, col: number): GridSpan => ({ row, col, rowSpan: 1, colSpan: 1 });

/** Widths of every column in a single row, left to right. */
const rowWidths = (cols: number, gap: number, tracks?: { colWidths?: number[] }) =>
  Array.from({ length: cols }, (_, c) => gridCellBox(SIZE, 1, cols, gap, one(0, c), tracks).width);

describe("grid track sizes", () => {
  it("splits evenly when no weights are given", () => {
    // The behavior every existing grid has, and what an older file still gets.
    expect(rowWidths(4, 0)).toEqual([100, 100, 100, 100]);
  });

  it("sizes columns in proportion to their weights", () => {
    // 2:1:1 of 400px.
    expect(rowWidths(3, 0, { colWidths: [2, 1, 1] })).toEqual([200, 100, 100]);
  });

  it("treats weights as ratios, not pixels, so only their proportion matters", () => {
    // Same shape at a wildly different scale: a grid is resized freely, and
    // stored pixels would overflow it or leave a gap the moment it changed.
    expect(rowWidths(3, 0, { colWidths: [200, 100, 100] })).toEqual(
      rowWidths(3, 0, { colWidths: [2, 1, 1] }),
    );
    expect(rowWidths(3, 0, { colWidths: [0.02, 0.01, 0.01] })).toEqual(
      rowWidths(3, 0, { colWidths: [2, 1, 1] }),
    );
  });

  it("positions each column after the ones before it, gaps included", () => {
    const tracks = { colWidths: [3, 1] };
    const gap = 20;
    const first = gridCellBox(SIZE, 1, 2, gap, one(0, 0), tracks);
    const second = gridCellBox(SIZE, 1, 2, gap, one(0, 1), tracks);
    // 380 free after the gap, split 3:1.
    expect(first.width).toBeCloseTo(285, 5);
    expect(second.width).toBeCloseTo(95, 5);
    expect(first.x).toBe(0);
    expect(second.x).toBeCloseTo(first.width + gap, 5);
    // The row still exactly fills the grid.
    expect(second.x + second.width).toBeCloseTo(SIZE.width, 5);
  });

  it("keeps the axes independent", () => {
    const box = gridCellBox(SIZE, 2, 2, 0, one(0, 0), { colWidths: [3, 1] });
    expect(box.width).toBeCloseTo(300, 5); // weighted
    expect(box.height).toBeCloseTo(200, 5); // rows untouched, so even
  });

  it("spans weighted tracks by summing them and the gap between", () => {
    const gap = 10;
    const tracks = { colWidths: [2, 1, 1] };
    const span = gridCellBox(SIZE, 1, 3, gap, { row: 0, col: 0, rowSpan: 1, colSpan: 2 }, tracks);
    const a = gridCellBox(SIZE, 1, 3, gap, one(0, 0), tracks);
    const b = gridCellBox(SIZE, 1, 3, gap, one(0, 1), tracks);
    expect(span.width).toBeCloseTo(a.width + b.width + gap, 5);
  });

  describe("falls back to an even split rather than trusting bad data", () => {
    const even = rowWidths(3, 0);

    it("when the array is sized for a different track count", () => {
      // The shape left behind by adding or removing a column.
      expect(rowWidths(3, 0, { colWidths: [1, 1] })).toEqual(even);
      expect(rowWidths(3, 0, { colWidths: [1, 1, 1, 1] })).toEqual(even);
    });

    it("when a weight would collapse or invert a track", () => {
      expect(rowWidths(3, 0, { colWidths: [1, 0, 1] })).toEqual(even);
      expect(rowWidths(3, 0, { colWidths: [1, -2, 1] })).toEqual(even);
    });

    it("when a weight is not a finite number", () => {
      expect(rowWidths(3, 0, { colWidths: [1, NaN, 1] })).toEqual(even);
      expect(rowWidths(3, 0, { colWidths: [1, Infinity, 1] })).toEqual(even);
    });

    it("when the array is empty", () => {
      expect(rowWidths(3, 0, { colWidths: [] })).toEqual(even);
    });
  });

  it("conserves the grid's width however the weights are shaped", () => {
    for (const w of [[1, 1, 1], [5, 1, 1], [1, 9, 2], [0.5, 0.25, 0.25]]) {
      const gap = 12;
      const widths = rowWidths(3, gap, { colWidths: w });
      const used = widths.reduce((a, b) => a + b, 0) + gap * 2;
      expect(used).toBeCloseTo(SIZE.width, 5);
    }
  });
});
