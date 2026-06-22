import { describe, it, expect } from "vitest";
import type { Fill } from "@hc/schema";
import { resolveFill } from "../fills";
import type { CanvasLike } from "../types";

// A fake 2D context that throws on non-finite gradient coords, exactly as a real
// CanvasRenderingContext2D does, so the test proves the guard prevents the throw.
function fakeCtx(): CanvasLike {
  const grad = { addColorStop() {} };
  return {
    createLinearGradient(x0: number, y0: number, x1: number, y1: number) {
      if (![x0, y0, x1, y1].every(Number.isFinite)) throw new Error("non-finite coords");
      return grad;
    },
  } as unknown as CanvasLike;
}

const black = { srgb: { r: 0, g: 0, b: 0, a: 1 } };
const white = { srgb: { r: 1, g: 1, b: 1, a: 1 } };
const linear = (angle: number): Fill => ({ type: "gradient", gradient: "linear", angle, stops: [{ position: 0, color: black }, { position: 1, color: white }] }) as Fill;

describe("resolveFill gradient guards", () => {
  it("falls back to a solid color when the box size is non-finite (no throw)", () => {
    const r = resolveFill(fakeCtx(), linear(140), NaN, 100);
    expect(typeof r).toBe("string"); // a CSS color, not a gradient object
  });

  it("returns a real gradient for finite dimensions", () => {
    const r = resolveFill(fakeCtx(), linear(140), 1920, 1080);
    expect(typeof r).toBe("object");
  });

  it("tolerates a non-finite angle without throwing", () => {
    expect(() => resolveFill(fakeCtx(), linear(NaN), 800, 600)).not.toThrow();
  });
});
