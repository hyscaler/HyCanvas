import { describe, expect, it } from "vitest";
import {
  adjustSpotlightRadius,
  clamp,
  clampZoom,
  defaultAutoAdvanceMs,
  dwellMs,
  firstVisibleIndex,
  fitZoom,
  formatClock,
  isVisibleSlide,
  lastVisibleIndex,
  nextVisibleIndex,
  prevVisibleIndex,
  RehearsalTimer,
  seekVisible,
  spotlightGeom,
  spotlightDefaultRadius,
  spotlightFalloff,
  spotlightMaxRadius,
  spotlightMinRadius,
  stepZoom,
  visibleIndices,
  visiblePosition,
  zoomMax,
  zoomMin,
  type SlideLike,
} from "./present";

// pages 0,1,2,3,4 with 1 and 3 hidden -> visible full-list indices: 0,2,4
const PAGES: SlideLike[] = [{}, { hidden: true }, {}, { hidden: true }, {}];

describe("visible-slide navigation (FR-1)", () => {
  it("lists only non-hidden slides in document order", () => {
    expect(visibleIndices(PAGES)).toEqual([0, 2, 4]);
  });

  it("reports visibility per index", () => {
    expect(isVisibleSlide(PAGES, 0)).toBe(true);
    expect(isVisibleSlide(PAGES, 1)).toBe(false);
    expect(isVisibleSlide(PAGES, 9)).toBe(false); // out of range
  });

  it("next/prev skip hidden slides", () => {
    expect(nextVisibleIndex(PAGES, 0)).toBe(2);
    expect(nextVisibleIndex(PAGES, 2)).toBe(4);
    expect(nextVisibleIndex(PAGES, 4)).toBe(-1); // nothing after the last visible
    expect(prevVisibleIndex(PAGES, 4)).toBe(2);
    expect(prevVisibleIndex(PAGES, 2)).toBe(0);
    expect(prevVisibleIndex(PAGES, 0)).toBe(-1);
  });

  it("seekVisible returns the start index when it is itself visible", () => {
    expect(seekVisible(PAGES, 2, 1)).toBe(2);
    expect(seekVisible(PAGES, 1, 1)).toBe(2); // skip the hidden 1 forward
    expect(seekVisible(PAGES, 3, -1)).toBe(2); // skip the hidden 3 backward
  });

  it("first/last visible", () => {
    expect(firstVisibleIndex(PAGES)).toBe(0);
    expect(lastVisibleIndex(PAGES)).toBe(4);
    expect(firstVisibleIndex([{ hidden: true }, { hidden: true }])).toBe(-1);
  });

  it("n-of-N reflects only visible slides", () => {
    expect(visiblePosition(PAGES, 0)).toEqual({ position: 1, total: 3 });
    expect(visiblePosition(PAGES, 2)).toEqual({ position: 2, total: 3 });
    expect(visiblePosition(PAGES, 4)).toEqual({ position: 3, total: 3 });
    // a hidden index reports the count at-or-before it, clamped to >= 1
    expect(visiblePosition(PAGES, 3)).toEqual({ position: 2, total: 3 });
  });
});

describe("autopilot dwell (FR-14)", () => {
  it("uses per-slide autoAdvanceMs when present, else the default", () => {
    const pages: SlideLike[] = [{ autoAdvanceMs: 1200 }, {}, { autoAdvanceMs: 0 }];
    expect(dwellMs(pages, 0)).toBe(1200);
    expect(dwellMs(pages, 1)).toBe(defaultAutoAdvanceMs);
    expect(dwellMs(pages, 2)).toBe(0); // an explicit 0 is honored
    expect(dwellMs(pages, 1, 8000)).toBe(8000); // custom default
  });
});

describe("rehearsal per-slide timer (FR-5)", () => {
  it("accumulates elapsed time per slide and counts visits", () => {
    const t = new RehearsalTimer();
    t.enter(0);
    t.tick(1000);
    t.tick(500);
    t.enter(2);
    t.tick(2000);
    t.enter(0); // revisit slide 0
    t.tick(300);
    const b = t.breakdown();
    expect(b).toEqual([
      { index: 0, elapsedMs: 1800, visits: 2 },
      { index: 2, elapsedMs: 2000, visits: 1 },
    ]);
    expect(t.total()).toBe(3800);
  });

  it("entering the same slide twice in a row does not double-count a visit", () => {
    const t = new RehearsalTimer();
    t.enter(1);
    t.enter(1);
    t.tick(100);
    expect(t.breakdown()).toEqual([{ index: 1, elapsedMs: 100, visits: 1 }]);
  });

  it("reset clears all accounting", () => {
    const t = new RehearsalTimer();
    t.enter(0);
    t.tick(500);
    t.reset();
    expect(t.breakdown()).toEqual([]);
    expect(t.total()).toBe(0);
  });
});

describe("clamp", () => {
  it("bounds a value into [min, max]", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
    expect(clamp(5, 10, 0)).toBe(10); // inverted range collapses to min
  });
});

describe("spotlight geometry (FR-8 magic tools)", () => {
  it("centers on the cursor and bounds the radius", () => {
    const g = spotlightGeom(100, 200, spotlightDefaultRadius);
    expect(g.cx).toBe(100);
    expect(g.cy).toBe(200);
    expect(g.radius).toBe(spotlightDefaultRadius);
    expect(g.outer).toBeCloseTo(spotlightDefaultRadius * (1 + spotlightFalloff));
  });

  it("clamps the radius below the minimum and above the maximum", () => {
    expect(spotlightGeom(0, 0, 1).radius).toBe(spotlightMinRadius);
    expect(spotlightGeom(0, 0, 99999).radius).toBe(spotlightMaxRadius);
  });

  it("adjusts the radius within bounds via a signed step", () => {
    expect(adjustSpotlightRadius(spotlightDefaultRadius, 20)).toBe(spotlightDefaultRadius + 20);
    expect(adjustSpotlightRadius(spotlightMinRadius, -100)).toBe(spotlightMinRadius);
    expect(adjustSpotlightRadius(spotlightMaxRadius, 100)).toBe(spotlightMaxRadius);
  });
});

describe("zoom transform clamp (FR-8 magic tools)", () => {
  it("fit is the identity zoom centered", () => {
    expect(fitZoom()).toEqual({ scale: zoomMin, originX: 0.5, originY: 0.5 });
  });

  it("clamps scale into range and the origin into the surface", () => {
    expect(clampZoom({ scale: 100, originX: 2, originY: -1 })).toEqual({
      scale: zoomMax,
      originX: 1,
      originY: 0,
    });
    // scale <= 1 collapses to the exact fit (origin reset to center)
    expect(clampZoom({ scale: 0.5, originX: 0.2, originY: 0.9 })).toEqual(fitZoom());
  });

  it("steps the zoom keeping the cursor fraction as the new origin", () => {
    const z = stepZoom(fitZoom(), 1, 0.25, 0.75);
    expect(z.scale).toBe(2);
    expect(z.originX).toBe(0.25);
    expect(z.originY).toBe(0.75);
  });

  it("stepping below the minimum resets to fit", () => {
    expect(stepZoom({ scale: 1.1, originX: 0.3, originY: 0.4 }, -1, 0.3, 0.4)).toEqual(fitZoom());
  });

  it("never exceeds the max scale when stepping repeatedly", () => {
    let z = fitZoom();
    for (let i = 0; i < 100; i++) z = stepZoom(z, 1, 0.5, 0.5);
    expect(z.scale).toBe(zoomMax);
  });
});

describe("formatClock", () => {
  it("formats m:ss and h:mm:ss, with a sign for negatives (countdown overrun)", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(65000)).toBe("1:05");
    expect(formatClock(3661000)).toBe("1:01:01");
    expect(formatClock(-5000)).toBe("-0:05");
  });
});
