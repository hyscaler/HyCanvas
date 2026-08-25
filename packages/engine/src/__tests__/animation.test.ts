import { describe, it, expect } from "vitest";
import type { AnimationClip, EntrancePreset, ExitPreset, EmphasisPreset } from "@hc/schema";
import {
  evalEasing,
  cubicBezierEase,
  entrancePatch,
  exitPatch,
  emphasisPatch,
  imageMotionPatch,
  clipEnd,
  transitionProgress,
  appliedOpacity,
  identityPatch,
  customPatch,
  samplePath,
  springEase,
  clipEase,
} from "../animation";

const clip = <P extends string>(preset: P, durationMs = 500, delayMs = 0): AnimationClip<P> => ({
  preset,
  durationMs,
  delayMs,
  easing: "linear",
});

describe("evalEasing", () => {
  it("pins endpoints for every named curve", () => {
    for (const e of ["linear", "ease-in", "ease-out", "ease-in-out", "spring"] as const) {
      expect(evalEasing(e, 0)).toBeCloseTo(0, 5);
      expect(evalEasing(e, 1)).toBeCloseTo(1, 5);
    }
  });

  it("clamps out-of-range progress", () => {
    expect(evalEasing("linear", -1)).toBe(0);
    expect(evalEasing("linear", 2)).toBe(1);
  });

  it("cubic-bezier: linear control points are the identity; endpoints pinned", () => {
    expect(cubicBezierEase(0, 0.42, 0, 0.58, 1)).toBeCloseTo(0, 4);
    expect(cubicBezierEase(1, 0.42, 0, 0.58, 1)).toBeCloseTo(1, 4);
    // A straight diagonal (0,0,1,1) is the identity.
    expect(cubicBezierEase(0.5, 1 / 3, 1 / 3, 2 / 3, 2 / 3)).toBeCloseTo(0.5, 3);
    // ease-in-like curve sits below the diagonal at the midpoint.
    expect(cubicBezierEase(0.5, 0.42, 0, 0.58, 1)).toBeCloseTo(0.5, 2);
    expect(cubicBezierEase(0.25, 0.42, 0, 1, 1)).toBeLessThan(0.25);
  });

  it("eases as expected at the midpoint", () => {
    expect(evalEasing("linear", 0.5)).toBeCloseTo(0.5, 5);
    expect(evalEasing("ease-in", 0.5)).toBeCloseTo(0.25, 5);
    expect(evalEasing("ease-out", 0.5)).toBeCloseTo(0.75, 5);
  });

  it("spring overshoots before settling and is deterministic", () => {
    const a = evalEasing("spring", 0.2);
    const b = evalEasing("spring", 0.2);
    expect(a).toBe(b); // no randomness
    // somewhere in the curve it crosses above 1 (overshoot)
    let over = false;
    for (let i = 0; i <= 100; i++) if (evalEasing("spring", i / 100) > 1.001) over = true;
    expect(over).toBe(true);
  });
});

describe("entrancePatch", () => {
  it("starts off and ends at the resting pose for fade", () => {
    const c = clip<EntrancePreset>("fade");
    expect(entrancePatch(c, 0).opacityMul).toBeCloseTo(0, 5);
    expect(entrancePatch(c, 500).opacityMul).toBeCloseTo(1, 5);
    expect(entrancePatch(c, 500).scale).toBeCloseTo(1, 5);
  });

  it("rise approaches the resting position", () => {
    const c = clip<EntrancePreset>("rise");
    expect(entrancePatch(c, 0).dy).toBeGreaterThan(0);
    expect(entrancePatch(c, 500).dy).toBeCloseTo(0, 5);
  });

  it("respects delay (off pose before the clip starts)", () => {
    const c = clip<EntrancePreset>("fade", 500, 200);
    expect(entrancePatch(c, 100).opacityMul).toBeCloseTo(0, 5);
    expect(entrancePatch(c, 700).opacityMul).toBeCloseTo(1, 5);
  });

  it("pop scales up from 0.6 to 1", () => {
    const c = clip<EntrancePreset>("pop");
    expect(entrancePatch(c, 0).scale).toBeCloseTo(0.6, 5);
    expect(entrancePatch(c, 500).scale).toBeCloseTo(1, 5);
  });
});

describe("exitPatch", () => {
  it("starts at the resting pose and ends gone", () => {
    const c = clip<ExitPreset>("fade-out");
    expect(exitPatch(c, 0).opacityMul).toBeCloseTo(1, 5);
    expect(exitPatch(c, 500).opacityMul).toBeCloseTo(0, 5);
  });
});

describe("emphasisPatch", () => {
  it("loops: identity at loop boundary, oscillates within", () => {
    const c = clip<EmphasisPreset>("wiggle", 1000);
    expect(emphasisPatch(c, 0).rotate).toBeCloseTo(0, 5);
    expect(emphasisPatch(c, 1000).rotate).toBeCloseTo(0, 5); // wrapped
    expect(Math.abs(emphasisPatch(c, 250).rotate)).toBeGreaterThan(0);
  });

  it("spin advances rotation across the cycle", () => {
    const c = clip<EmphasisPreset>("spin", 1000);
    expect(emphasisPatch(c, 500).rotate).toBeCloseTo(180, 5);
  });
});

describe("imageMotionPatch", () => {
  it("zooms in for ken burns and returns near start each loop", () => {
    const m = { kind: "kenburns" as const, intensity: 1 };
    expect(imageMotionPatch(m, 0, 1000).scale).toBeCloseTo(1, 2);
    expect(imageMotionPatch(m, 500, 1000).scale).toBeGreaterThan(1);
  });

  it("scales magnitude with intensity (zero intensity is near-identity)", () => {
    const m = { kind: "parallax" as const, intensity: 0 };
    const p = imageMotionPatch(m, 300, 1000);
    expect(p.dx).toBeCloseTo(0, 5);
    expect(p.scale).toBeCloseTo(1, 5);
  });
});

describe("clipEnd", () => {
  it("is delay + duration, 0 when absent", () => {
    expect(clipEnd(clip("fade", 500, 200))).toBe(700);
    expect(clipEnd(undefined)).toBe(0);
  });
});

describe("transitionProgress", () => {
  it("runs 0..1 across the duration and clamps past the end", () => {
    expect(transitionProgress(0, 400)).toBeCloseTo(0, 5);
    expect(transitionProgress(400, 400)).toBeCloseTo(1, 5);
    expect(transitionProgress(800, 400)).toBeCloseTo(1, 5);
    expect(transitionProgress(200, 400)).toBeCloseTo(0.5, 5); // ease-in-out is symmetric at mid
  });

  it("snaps to 1 for a zero/absent duration (instant switch)", () => {
    expect(transitionProgress(0, 0)).toBe(1);
    expect(transitionProgress(0, -10)).toBe(1);
  });
});

describe("identityPatch", () => {
  it("is a no-op patch", () => {
    expect(identityPatch).toEqual({ dx: 0, dy: 0, scale: 1, rotate: 0, opacityMul: 1 });
  });
});

describe("appliedOpacity", () => {
  it("multiplies the resting opacity by the patch multiplier", () => {
    expect(appliedOpacity(0.5, 0.5)).toBeCloseTo(0.25, 5);
    expect(appliedOpacity(0.8, 1)).toBeCloseTo(0.8, 5);
  });

  it("clamps a spring-overshoot multiplier so it never exceeds the resting opacity", () => {
    // A spring easing carries opacityMul above 1 somewhere on the curve; the
    // applied opacity must stay <= base at every sampled point.
    let sawOvershoot = false;
    for (let i = 0; i <= 100; i++) {
      const mul = evalEasing("spring", i / 100);
      if (mul > 1.001) sawOvershoot = true;
      expect(appliedOpacity(1, mul)).toBeLessThanOrEqual(1);
    }
    expect(sawOvershoot).toBe(true); // the curve does overshoot, so the clamp matters
    expect(appliedOpacity(1, 1.3)).toBe(1); // would be 1.3 unclamped
  });

  it("clamps below zero to zero", () => {
    expect(appliedOpacity(0.7, -0.2)).toBe(0);
  });
});

// --- Phase 3: animation depth (C11-C13) ----------------------------------------
describe("v23 keyframe channels (C12)", () => {
  it("width/height/color interpolate between the keyframes that define them", () => {
    const track = {
      durationMs: 1000,
      keyframes: [
        { t: 0, width: 100, color: { srgb: { r: 1, g: 0, b: 0, a: 1 } }, easing: "linear" as const },
        { t: 1000, width: 300, color: { srgb: { r: 0, g: 0, b: 1, a: 1 } } },
      ],
    };
    const mid = customPatch(track as never, 500);
    expect(mid.width).toBeCloseTo(200, 5);
    expect(mid.color!.srgb.r).toBeCloseTo(0.5, 5);
    expect(mid.color!.srgb.b).toBeCloseTo(0.5, 5);
    expect(mid.height).toBeUndefined(); // never defined: no override
  });

  it("a channel defined on ONE keyframe holds at both boundaries; sparse channels sample independently", () => {
    const track = {
      durationMs: 1000,
      keyframes: [
        { t: 0, dx: 0, easing: "linear" as const },
        { t: 500, width: 200, easing: "linear" as const },
        { t: 1000, dx: 100 },
      ],
    };
    expect(customPatch(track as never, 250).width).toBe(200); // held BEFORE the first defined too (no mid-track snap)
    expect(customPatch(track as never, 750).width).toBe(200); // held past the last defined
    expect(customPatch(track as never, 750).dx).toBeCloseTo(50, 5); // transform segments unaffected
  });

  it("legacy tracks without new channels evaluate bit-for-bit as before", () => {
    const track = { durationMs: 1000, keyframes: [{ t: 0, dx: 0, easing: "linear" as const }, { t: 1000, dx: 100 }] };
    const p = customPatch(track as never, 400);
    expect(p.dx).toBeCloseTo(40, 5);
    expect(p.width).toBeUndefined();
    expect(p.color).toBeUndefined();
  });
});

describe("motion paths (C11)", () => {
  it("samplePath walks the polyline by arc length with the tangent angle", () => {
    const path = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
    expect(samplePath(path, 0)).toEqual({ x: 0, y: 0, angleDeg: 0 });
    const quarter = samplePath(path, 0.25);
    expect(quarter.x).toBeCloseTo(50, 5);
    expect(quarter.y).toBeCloseTo(0, 5);
    const threeQ = samplePath(path, 0.75);
    expect(threeQ.x).toBeCloseTo(100, 5);
    expect(threeQ.y).toBeCloseTo(50, 5);
    expect(threeQ.angleDeg).toBeCloseTo(90, 5); // heading down
    expect(samplePath(path, 1).y).toBeCloseTo(100, 5);
  });

  it("a track path drives dx/dy instead of the keyframes and orients when asked", () => {
    const track = {
      durationMs: 1000,
      path: [{ x: 0, y: 0 }, { x: 0, y: 200 }],
      orient: true,
      keyframes: [{ t: 0, dx: 999, easing: "linear" as const }, { t: 1000, dx: 999, scale: 2 }],
    };
    const mid = customPatch(track as never, 500);
    expect(mid.dx).toBeCloseTo(0, 5); // path wins over the keyframe dx
    expect(mid.dy).toBeCloseTo(100, 5);
    expect(mid.rotate).toBeCloseTo(90, 5); // tangent straight down
    expect(mid.scale).toBeCloseTo(1.5, 5); // other channels keep evaluating
  });
});

describe("spring parameters (C13)", () => {
  it("clipEase honors clip.spring; defaults match the classic curve; params clamp", () => {
    const classic = { easing: "spring" as const };
    const parameterized = { easing: "spring" as const, spring: { stiffness: 20, damping: 0.8 } };
    expect(clipEase(classic, 0.3)).toBeCloseTo(evalEasing("spring", 0.3), 10);
    expect(clipEase(parameterized, 0.3)).not.toBeCloseTo(clipEase(classic, 0.3), 3);
    expect(springEase(1, 20, 0.8)).toBe(1); // settles exactly
    expect(springEase(0.5, -100, 99)).toBeGreaterThan(0); // hostile params clamp, stay finite
    expect(Number.isFinite(springEase(0.5, -100, 99))).toBe(true);
  });
});
