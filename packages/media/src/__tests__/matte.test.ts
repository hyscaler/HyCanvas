import { describe, it, expect } from "vitest";
import { growMatte, shrinkMatte, featherMatte, refineMatte, brushMatte, applyMatteToRGBA } from "../matte";

// A 7x7 matte with a single fully-opaque 3x3 square in the centre.
function square(): { a: Uint8Array; w: number; h: number } {
  const w = 7, h = 7;
  const a = new Uint8Array(w * h);
  for (let y = 2; y <= 4; y++) for (let x = 2; x <= 4; x++) a[y * w + x] = 255;
  return { a, w, h };
}
const count = (a: Uint8Array, pred: (v: number) => boolean) => a.reduce((n, v) => n + (pred(v) ? 1 : 0), 0);

describe("matte morphology", () => {
  it("grow expands the opaque region", () => {
    const { a, w, h } = square();
    const g = growMatte(a, w, h, 1);
    expect(count(g, (v) => v === 255)).toBe(25); // 3x3 -> 5x5
  });

  it("shrink contracts the opaque region", () => {
    const { a, w, h } = square();
    const s = shrinkMatte(a, w, h, 1);
    expect(count(s, (v) => v === 255)).toBe(1); // 3x3 -> 1x1
  });

  it("feather softens edges into intermediate values", () => {
    const { a, w, h } = square();
    const f = featherMatte(a, w, h, 1);
    expect(count(f, (v) => v > 0 && v < 255)).toBeGreaterThan(0);
    // The very centre stays fully opaque.
    expect(f[3 * w + 3]).toBe(255);
  });
});

describe("refineMatte", () => {
  it("chokes then feathers (grow=0)", () => {
    const { a, w, h } = square();
    const r = refineMatte(a, w, h, { shrink: 1, feather: 1 });
    expect(r).not.toBe(a); // returns a fresh buffer
    expect(r.length).toBe(a.length);
  });

  it("returns a copy when no ops requested", () => {
    const { a, w, h } = square();
    const r = refineMatte(a, w, h, {});
    expect(r).not.toBe(a);
    expect(Array.from(r)).toEqual(Array.from(a));
  });
});

describe("brushMatte", () => {
  it("erases (paints toward 0) at the stamp centre", () => {
    const { a, w, h } = square();
    brushMatte(a, w, h, { cx: 3, cy: 3, radius: 1, value: 0, hardness: 1, flow: 1 });
    expect(a[3 * w + 3]).toBe(0);
  });

  it("restores (paints toward 255) into a cut-out area", () => {
    const w = 5, h = 5;
    const a = new Uint8Array(w * h); // all transparent
    brushMatte(a, w, h, { cx: 2, cy: 2, radius: 1, value: 255, hardness: 1, flow: 1 });
    expect(a[2 * w + 2]).toBe(255);
  });

  it("soft brush leaves a falloff gradient", () => {
    const w = 9, h = 9;
    const a = new Uint8Array(w * h);
    brushMatte(a, w, h, { cx: 4, cy: 4, radius: 3, value: 255, hardness: 0, flow: 1 });
    expect(a[4 * w + 4]).toBe(255); // centre full
    expect(a[4 * w + 6]).toBeGreaterThan(0);
    expect(a[4 * w + 6]).toBeLessThan(255); // edge partial
  });
});

describe("applyMatteToRGBA", () => {
  it("multiplies image alpha by the matte", () => {
    const rgba = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 200]);
    const matte = new Uint8Array([0, 255]);
    applyMatteToRGBA(rgba, matte);
    expect(rgba[3]).toBe(0); // first pixel cut out
    expect(rgba[7]).toBe(200); // second pixel kept
  });
});
