import { describe, it, expect } from "vitest";
import type { KeyframeTrack } from "@hc/schema";
import { customPatch, customTrackEnd } from "../animation";

const track: KeyframeTrack = {
  durationMs: 1000,
  keyframes: [
    { t: 0, dx: 0, opacity: 0, easing: "linear" },
    { t: 1000, dx: 100, opacity: 1 },
  ],
};

describe("customPatch", () => {
  it("holds the first keyframe before the track starts", () => {
    const p = customPatch(track, -50);
    expect(p.dx).toBe(0);
    expect(p.opacityMul).toBe(0);
  });
  it("interpolates linearly at the midpoint", () => {
    const p = customPatch(track, 500);
    expect(p.dx).toBeCloseTo(50, 3);
    expect(p.opacityMul).toBeCloseTo(0.5, 3);
  });
  it("holds the last keyframe at/after the end", () => {
    const p = customPatch(track, 2000);
    expect(p.dx).toBe(100);
    expect(p.opacityMul).toBe(1);
  });
  it("loops when the track loops", () => {
    const looped: KeyframeTrack = { ...track, loop: true };
    const p = customPatch(looped, 1500); // wraps to 500ms
    expect(p.dx).toBeCloseTo(50, 3);
  });
  it("defaults omitted channels to identity", () => {
    const p = customPatch({ durationMs: 100, keyframes: [{ t: 0 }] }, 0);
    expect(p).toEqual({ dx: 0, dy: 0, scale: 1, rotate: 0, opacityMul: 1 });
  });
  it("reports track end", () => {
    expect(customTrackEnd(track)).toBe(1000);
    expect(customTrackEnd(undefined)).toBe(0);
  });
});
