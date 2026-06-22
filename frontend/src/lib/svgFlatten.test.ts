import { describe, it, expect } from "vitest";
import { parseTransform } from "./svgFlatten";

describe("parseTransform (SVG group-transform flattening)", () => {
  it("returns identity for empty/missing", () => {
    expect(parseTransform(null)).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    expect(parseTransform("")).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  });

  it("parses translate and scale", () => {
    expect(parseTransform("translate(10,20)")).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 10, f: 20 });
    expect(parseTransform("scale(2)")).toEqual({ a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 });
    expect(parseTransform("scale(2,3)")).toEqual({ a: 2, b: 0, c: 0, d: 3, e: 0, f: 0 });
  });

  it("parses rotate (90deg maps +x to +y)", () => {
    const m = parseTransform("rotate(90)");
    expect(m.a).toBeCloseTo(0, 6);
    expect(m.b).toBeCloseTo(1, 6);
    expect(m.c).toBeCloseTo(-1, 6);
    expect(m.d).toBeCloseTo(0, 6);
  });

  it("rotate about a center keeps that point fixed", () => {
    const m = parseTransform("rotate(90 5 5)");
    // point (5,5): x' = a*5 + c*5 + e ; y' = b*5 + d*5 + f
    expect(m.a * 5 + m.c * 5 + m.e).toBeCloseTo(5, 6);
    expect(m.b * 5 + m.d * 5 + m.f).toBeCloseTo(5, 6);
  });

  it("composes a list left-to-right (outermost first)", () => {
    // translate(10,0) scale(2): a point (1,0) -> scale -> (2,0) -> translate -> (12,0)
    const m = parseTransform("translate(10,0) scale(2)");
    expect(m.a).toBe(2);
    expect(m.e).toBe(10);
    expect(m.a * 1 + m.e).toBe(12);
  });

  it("passes a matrix() through verbatim", () => {
    expect(parseTransform("matrix(1,2,3,4,5,6)")).toEqual({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 });
  });
});
