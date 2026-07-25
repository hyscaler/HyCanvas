import { describe, it, expect } from "vitest";
import { detectBeatTimes, beatTimesToFrames } from "./beats";

// A synthetic click track: short energy bursts at known times over silence.
function clickTrack(sampleRate: number, seconds: number, clickTimes: number[]): Float32Array {
  const s = new Float32Array(Math.floor(sampleRate * seconds));
  for (const t of clickTimes) {
    const start = Math.floor(t * sampleRate);
    // A 25ms decaying burst so it registers as an onset.
    const len = Math.floor(0.025 * sampleRate);
    for (let i = 0; i < len && start + i < s.length; i++) {
      s[start + i] = Math.sin((i / sampleRate) * 2 * Math.PI * 1000) * (1 - i / len);
    }
  }
  return s;
}

describe("detectBeatTimes", () => {
  it("finds onsets near a regular click grid", () => {
    const sr = 44100;
    const clicks = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5];
    const beats = detectBeatTimes(clickTrack(sr, 4, clicks), sr);
    // Every click should have a detected onset within ~40ms.
    for (const c of clicks) {
      const near = beats.some((b) => Math.abs(b - c) < 0.04);
      expect(near, `no onset near ${c}s (got ${beats.map((b) => b.toFixed(2)).join(",")})`).toBe(true);
    }
    // And it should not wildly over-detect on the silent gaps.
    expect(beats.length).toBeLessThanOrEqual(clicks.length + 2);
  });

  it("returns nothing for silence and honors the debounce gap", () => {
    const sr = 44100;
    expect(detectBeatTimes(new Float32Array(sr * 2), sr)).toEqual([]);
    // Two clicks 50ms apart with a 0.2s min gap collapse to one onset.
    const beats = detectBeatTimes(clickTrack(sr, 1, [0.3, 0.35]), sr, { minGapSec: 0.2 });
    expect(beats.length).toBe(1);
  });

  it("maps onset times to integer frames", () => {
    expect(beatTimesToFrames([0.5, 1.0], 30)).toEqual([15, 30]);
  });
});
