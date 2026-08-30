// Speaker coach analysis (F28 completion C20): pure accumulation over
// finalized speech chunks - pacing, filler words, long pauses.

import { describe, expect, it } from "vitest";
import { CoachTracker } from "./speech";

describe("CoachTracker", () => {
  it("computes WPM over the session, counts fillers and long pauses", () => {
    const c = new CoachTracker();
    c.feed({ text: "welcome to the um quarterly review", atMs: 0 });
    c.feed({ text: "um basically the numbers look good", atMs: 10_000 });
    c.feed({ text: "questions", atMs: 20_000 }); // 10s gaps > 2.5s threshold
    const s = c.stats(30_000);
    expect(s.totalWords).toBe(13);
    expect(s.wpm).toBe(Math.round(13 / 0.5)); // 30s elapsed
    expect(s.fillers.um).toBe(2);
    expect(s.fillers.basically).toBe(1);
    expect(s.fillerTotal).toBe(3);
    expect(s.longPauses).toBe(2);
  });

  it("an empty session reports zeros without dividing by zero", () => {
    const s = new CoachTracker().stats(1000);
    expect(s.totalWords).toBe(0);
    expect(s.wpm).toBe(0);
    expect(s.longPauses).toBe(0);
  });

  it("rapid consecutive chunks count no pauses", () => {
    const c = new CoachTracker();
    c.feed({ text: "one", atMs: 0 });
    c.feed({ text: "two", atMs: 500 });
    c.feed({ text: "three", atMs: 1000 });
    expect(c.stats(2000).longPauses).toBe(0);
  });
});
