import { describe, expect, it } from "vitest";
import { avoidRect } from "./avoidRect";

// Zoom control box in a 1000x700 viewport, anchored bottom-end.
const ltrControl = { left: 640, top: 644, width: 344, height: 40 };
const rtlControl = { left: 16, top: 644, width: 344, height: 40 };

describe("avoidRect", () => {
  it("leaves the strip alone when it is clear of the control", () => {
    const strip = { left: 100, top: 400, width: 800, height: 42 };
    expect(avoidRect(strip, ltrControl)).toEqual(strip);
    expect(avoidRect(strip, null)).toEqual(strip);
  });

  it("trims the end of the strip when the control sits to its right (LTR)", () => {
    const r = avoidRect({ left: 100, top: 640, width: 800, height: 42 }, ltrControl);
    expect(r).toEqual({ left: 100, top: 640, width: 532, height: 42 });
    expect(r.left + r.width).toBeLessThanOrEqual(ltrControl.left);
  });

  it("trims the start of the strip when the control sits to its left (RTL)", () => {
    const r = avoidRect({ left: 100, top: 640, width: 800, height: 42 }, rtlControl);
    expect(r.left).toBe(368);
    expect(r.left + r.width).toBe(900);
  });

  it("drops the strip below the control when too little width would remain", () => {
    const r = avoidRect({ left: 650, top: 640, width: 300, height: 42 }, ltrControl);
    expect(r.top).toBe(644 + 40 + 8);
    expect(r.width).toBe(300);
  });
});
