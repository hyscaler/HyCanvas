import { describe, expect, it } from "vitest";
import { freeStickySpot } from "./stickyPlacement";

describe("freeStickySpot (#93)", () => {
  it("keeps the requested spot when the board is empty", () => {
    expect(freeStickySpot([], 100, 100, 180, 180)).toEqual({ x: 100, y: 100 });
  });

  it("puts a second sticky beside the first instead of on top of it", () => {
    const first = { x: 100, y: 100, w: 180, h: 180 };
    expect(freeStickySpot([first], 100, 100, 180, 180)).toEqual({ x: 300, y: 100 });
  });

  it("never returns a spot that overlaps an existing sticky", () => {
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    for (let i = 0; i < 20; i++) {
      const s = freeStickySpot(placed, 0, 0, 180, 180);
      for (const o of placed) {
        const overlap = s.x < o.x + o.w && s.x + 180 > o.x && s.y < o.y + o.h && s.y + 180 > o.y;
        expect(overlap).toBe(false);
      }
      placed.push({ ...s, w: 180, h: 180 });
    }
  });
});
