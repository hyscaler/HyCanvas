import { describe, expect, it } from "vitest";
import { niceStep, rulerTicks } from "./rulerTicks";

describe("rulerTicks", () => {
  it("spaces majors for the zoom and fills fifths between them when there is room", () => {
    // At zoom 1 a 100-unit step is 100px: fifths every 20 units.
    const plan = rulerTicks(1, 300);
    expect(plan.step).toBe(100);
    expect(plan.majors).toEqual([0, 100, 200, 300]);
    expect(plan.minors).toEqual([20, 40, 60, 80, 120, 140, 160, 180, 220, 240, 260, 280]);
  });
  it("falls back to halves when a major is under 75px on screen", () => {
    // At zoom 0.3 the step is 200 units (60px), so halves every 100.
    const plan = rulerTicks(0.3, 600);
    expect(plan.step).toBe(200);
    expect(plan.minors).toEqual([100, 300, 500]);
  });
  it("never lists a major twice as a minor", () => {
    const plan = rulerTicks(2, 1000);
    for (const m of plan.minors) expect(plan.majors).not.toContain(m);
  });
  it("keeps the step ladder", () => {
    expect(niceStep(1)).toBe(100);
    expect(niceStep(4)).toBe(25);
    expect(niceStep(0.05)).toBe(2000);
  });
});
