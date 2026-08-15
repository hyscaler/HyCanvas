// Group isolation (F40 Phase 1 groundwork).
//
// Group opacity multiplied down per child, so two overlapping children in a
// semi-transparent group each drew at the group's alpha and the overlap came
// out darker, showing a seam along every shared edge.
//
// The pixel proof lives in the Go raster suite, which has a real compositor
// (isolation_test.go asserts overlap alpha == non-overlap alpha, and fails at
// 0.753 vs 0.502 without the fix). Here the testable parts are the decision and
// the degradation, because a headless CanvasLike double has no offscreen canvas
// to composite into.

import { describe, expect, it } from "vitest";
import { needsIsolation } from "../layer";
import { createScene } from "../scene";
import { renderScene } from "../render2d";
import type { DesignFile, Node } from "@hc/schema";

const g = (over: Record<string, unknown>) => ({ opacity: 1, blendMode: "normal", ...over }) as never;

describe("when a group must composite as a unit", () => {
  it("isolates for a non-normal blend mode, even with one child", () => {
    // Blend changes the compositing MODEL, not just the alpha: without a layer
    // each child re-sets globalCompositeOperation and the group's is lost.
    expect(needsIsolation(g({ blendMode: "multiply" }), 1)).toBe(true);
  });

  it("isolates for opacity only when children can overlap", () => {
    // With one child there is nothing to overlap, so multiplying down is
    // pixel-identical and a canvas-sized buffer would be pure cost.
    expect(needsIsolation(g({ opacity: 0.5 }), 1)).toBe(false);
    expect(needsIsolation(g({ opacity: 0.5 }), 2)).toBe(true);
  });

  it("isolates on an explicit flag", () => {
    expect(needsIsolation(g({ isolation: true }), 1)).toBe(true);
  });

  it("leaves the common case alone", () => {
    expect(needsIsolation(g({}), 5)).toBe(false);
    expect(needsIsolation(g({ opacity: 0.5 }), 0)).toBe(false);
  });
});

describe("a runtime with no offscreen canvas degrades rather than failing", () => {
  it("still paints every child of a semi-transparent group", () => {
    // The fallback is the previous multiply-down path: visibly imperfect at
    // overlaps, but the artwork is all there. Losing it would be far worse.
    const child = (id: string, x: number): Node => ({
      id, type: "shape", shape: "rect",
      transform: { x, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 60, height: 40 }, opacity: 1, blendMode: "normal",
      fills: [{ type: "solid", color: { srgb: { r: 1, g: 0, b: 0, a: 1 } } }],
    } as unknown as Node);
    const file = {
      schemaVersion: 19, id: "d", title: "t", assets: [], fonts: [], meta: {},
      pages: [{ id: "p", width: 100, height: 40, children: [{
        id: "grp", type: "group", opacity: 0.5, blendMode: "normal",
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 100, height: 40 },
        children: [child("a", 0), child("b", 40)],
      }] }],
    } as unknown as DesignFile;

    const fills: number[] = [];
    const noop = () => {};
    const ctx = {
      save: noop, restore: noop, beginPath: noop, closePath: noop, clip: noop,
      moveTo: noop, lineTo: noop, bezierCurveTo: noop, quadraticCurveTo: noop,
      translate: noop, rotate: noop, scale: noop, transform: noop, setTransform: noop,
      clearRect: noop, strokeRect: noop, stroke: noop, fill: noop, rect: noop,
      arc: noop, ellipse: noop, roundRect: noop, setLineDash: noop,
      drawImage: noop, fillText: noop, measureText: () => ({ width: 0 }),
      createLinearGradient: () => ({ addColorStop: noop }),
      createRadialGradient: () => ({ addColorStop: noop }),
      createPattern: () => null,
      fillRect: () => { fills.push((ctx as { globalAlpha: number }).globalAlpha); },
      globalAlpha: 1, fillStyle: "", strokeStyle: "", lineWidth: 1,
      filter: "none", globalCompositeOperation: "source-over",
    } as unknown as Parameters<typeof renderScene>[1];

    expect(() =>
      renderScene(createScene(file, 0), ctx, { x: 0, y: 0, width: 100, height: 40, zoom: 1 }),
    ).not.toThrow();
    // Both children drew, each carrying the inherited group alpha.
    expect(fills.filter((a) => a > 0.4 && a < 0.6).length).toBeGreaterThanOrEqual(2);
  });
});
