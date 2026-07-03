import { describe, it, expect } from "vitest";
import type { Rect } from "@hc/engine";
import { spacingSnap, resizeSpacingSnap } from "../snapping";

// Two neighbors sharing a horizontal band with the moving box.
const L: Rect = { x: 0, y: 0, width: 40, height: 40 };
const R: Rect = { x: 200, y: 0, width: 40, height: 40 };

describe("spacingSnap", () => {
  it("centers a box between two neighbors so both gaps are equal", () => {
    // span between L.right (40) and R.left (200) is 160; a 60-wide box centers
    // at x=90 with equal 50px gaps. From x=88 it should snap +2.
    const res = spacingSnap({ x: 88, y: 5, width: 60, height: 30 }, [L, R], "x", 8);
    expect(res.delta).toBe(2);
    expect(res.guide?.gap).toBe(50);
    expect(res.guide?.segments).toHaveLength(2);
  });

  it("does not snap when the box is farther than the threshold", () => {
    const res = spacingSnap({ x: 70, y: 5, width: 60, height: 30 }, [L, R], "x", 8);
    expect(res.delta).toBe(0);
    expect(res.guide).toBeNull();
  });

  it("extends an evenly spaced chain by matching the neighbor's own gap", () => {
    // left2 [0..40], left [80..120] have a 40px gap; a box near 158 snaps to
    // 160 so its gap to `left` also equals 40, with a reference-gap segment.
    const left2: Rect = { x: 0, y: 0, width: 40, height: 40 };
    const left: Rect = { x: 80, y: 0, width: 40, height: 40 };
    const res = spacingSnap({ x: 158, y: 5, width: 30, height: 30 }, [left2, left], "x", 8);
    expect(res.delta).toBe(2);
    expect(res.guide?.gap).toBe(40);
    expect(res.guide?.segments).toHaveLength(2);
  });

  it("ignores neighbors that do not share a band on the cross axis", () => {
    // moving box is far below both neighbors, so nothing is in-line with it.
    const res = spacingSnap({ x: 88, y: 500, width: 60, height: 30 }, [L, R], "x", 8);
    expect(res.guide).toBeNull();
  });

  it("works on the vertical axis too", () => {
    const T: Rect = { x: 0, y: 0, width: 40, height: 40 };
    const B: Rect = { x: 0, y: 200, width: 40, height: 40 };
    const res = spacingSnap({ x: 5, y: 88, width: 30, height: 60 }, [T, B], "y", 8);
    expect(res.delta).toBe(2);
    expect(res.guide?.axis).toBe("y");
    expect(res.guide?.gap).toBe(50);
  });
});

describe("resizeSpacingSnap", () => {
  // Left neighbor right edge at 40, right neighbor left edge at 300.
  const L: Rect = { x: 0, y: 0, width: 40, height: 100 };
  const R: Rect = { x: 300, y: 0, width: 40, height: 100 };

  it("snaps the east edge so both neighbor gaps match", () => {
    // Box left edge = 100 -> left gap = 60. Dragging the east edge to ~238 would
    // make the right gap 62; it should snap right edge to 240 (gap 60).
    const res = resizeSpacingSnap({ x: 100, y: 20, width: 138, height: 40 }, "e", [L, R], 8);
    expect(res).not.toBeNull();
    expect(res!.gap).toBe(60);
    expect(res!.delta).toBe(2); // 238 -> 240
    expect(res!.axis).toBe("x");
  });

  it("snaps the west edge so both neighbor gaps match", () => {
    // Box right edge = 240 -> right gap = 60. Left edge near 98 snaps to 100.
    const res = resizeSpacingSnap({ x: 98, y: 20, width: 142, height: 40 }, "w", [L, R], 8);
    expect(res).not.toBeNull();
    expect(res!.gap).toBe(60);
    expect(res!.delta).toBe(2); // left 98 -> 100
  });

  it("returns null without a neighbor on both sides", () => {
    expect(resizeSpacingSnap({ x: 100, y: 20, width: 138, height: 40 }, "e", [L], 8)).toBeNull();
  });

  it("returns null when the snap is out of threshold", () => {
    expect(resizeSpacingSnap({ x: 100, y: 20, width: 120, height: 40 }, "e", [L, R], 8)).toBeNull();
  });

  it("ignores neighbors that don't overlap on the cross axis", () => {
    const far: Rect = { x: 300, y: 500, width: 40, height: 40 };
    expect(resizeSpacingSnap({ x: 100, y: 20, width: 138, height: 40 }, "e", [L, far], 8)).toBeNull();
  });

  it("works on the vertical (south) edge", () => {
    const Tn: Rect = { x: 0, y: 0, width: 100, height: 40 };
    const B: Rect = { x: 0, y: 300, width: 100, height: 40 };
    // top edge = 100 -> top gap = 60; south edge near 238 snaps to 240.
    const res = resizeSpacingSnap({ x: 20, y: 100, width: 40, height: 138 }, "s", [Tn, B], 8);
    expect(res).not.toBeNull();
    expect(res!.axis).toBe("y");
    expect(res!.gap).toBe(60);
    expect(res!.delta).toBe(2);
  });
});
