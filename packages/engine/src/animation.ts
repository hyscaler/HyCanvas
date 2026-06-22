// @hc/engine animation: the pure, framework-free playback math shared by the
// browser preview (editor "Play"), present mode, and (later) server export, so
// what you see is what exports. It computes, for an animation clip
// at a time t, a transform/opacity PATCH composed over a node's static state; it
// never mutates the document. Garbage-free per frame is not required here (the
// patches are small plain objects), but the math is allocation-light.

import type {
  AnimationClip,
  Easing,
  EntrancePreset,
  ExitPreset,
  EmphasisPreset,
  Keyframe,
  KeyframeTrack,
} from "@hc/schema";

/** A transform/opacity offset applied over a node's static transform. All
 *  fields are deltas/multipliers relative to the resting node, so a value of
 *  the identity ({ dx:0, dy:0, scale:1, rotate:0, opacityMul:1 }) is a no-op. */
export interface AnimPatch {
  dx: number; // page-units offset on x
  dy: number; // page-units offset on y
  scale: number; // uniform scale multiplier
  rotate: number; // additional rotation in degrees
  opacityMul: number; // 0..1 multiplier on the node's opacity
}

export const IDENTITY_PATCH: Readonly<AnimPatch> = Object.freeze({
  dx: 0,
  dy: 0,
  scale: 1,
  rotate: 0,
  opacityMul: 1,
});

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const TAU = Math.PI * 2;

/**
 * Evaluate a named easing curve at normalized progress t in [0,1], returning the
 * eased progress (also normalized for non-spring curves). The "spring" curve is a
 * critically-ish damped settle baked deterministically from a closed form so the
 * browser and a headless render agree exactly. It can overshoot
 * past 1 before settling, which reads as a springy pop.
 */
export function evalEasing(easing: Easing, t: number): number {
  const x = clamp01(t);
  switch (easing) {
    case "linear":
      return x;
    case "ease-in":
      return x * x;
    case "ease-out":
      return 1 - (1 - x) * (1 - x);
    case "ease-in-out":
      return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
    case "spring": {
      // Damped oscillation settling to 1; fixed params keep it deterministic.
      if (x >= 1) return 1;
      const omega = 8; // angular frequency
      const zeta = 0.32; // damping ratio (underdamped -> a little overshoot)
      const wd = omega * Math.sqrt(1 - zeta * zeta);
      const env = Math.exp(-zeta * omega * x);
      return 1 - env * (Math.cos(wd * x) + ((zeta * omega) / wd) * Math.sin(wd * x));
    }
    default:
      return x;
  }
}

/**
 * Local progress of a clip at absolute time `tMs` (relative to the slide/loop
 * start), honoring delay. Returns null before the clip's delay (caller decides
 * the pre-start pose), and clamps to 1 after it ends.
 */
function clipProgress(clip: AnimationClip, tMs: number): number | null {
  const start = clip.delayMs;
  if (tMs < start) return null;
  const dur = Math.max(1, clip.durationMs);
  return clamp01((tMs - start) / dur);
}

/** Entrance patch: animates FROM an off pose TO the resting pose (eased 0->1). */
export function entrancePatch(clip: AnimationClip<EntrancePreset>, tMs: number): AnimPatch {
  const raw = clipProgress(clip, tMs);
  // Before the clip starts the element sits in its pre-entrance (off) pose.
  const e = raw === null ? 0 : evalEasing(clip.easing, raw);
  const inv = 1 - e;
  switch (clip.preset) {
    case "fade":
      return { dx: 0, dy: 0, scale: 1, rotate: 0, opacityMul: e };
    case "rise":
      return { dx: 0, dy: inv * 48, scale: 1, rotate: 0, opacityMul: e };
    case "pan":
      return { dx: inv * 80, dy: 0, scale: 1, rotate: 0, opacityMul: e };
    case "pop":
      return { dx: 0, dy: 0, scale: 0.6 + 0.4 * e, rotate: 0, opacityMul: e };
    case "drift":
      return { dx: inv * 24, dy: inv * -24, scale: 0.96 + 0.04 * e, rotate: 0, opacityMul: e };
    case "breathe-in":
      return { dx: 0, dy: 0, scale: 1.12 - 0.12 * e, rotate: 0, opacityMul: e };
    default:
      return { ...IDENTITY_PATCH };
  }
}

/** Exit patch: animates FROM the resting pose TO an off pose (eased 0->1). At
 *  e=0 it is the identity; at e=1 the element is fully gone. */
export function exitPatch(clip: AnimationClip<ExitPreset>, tMs: number): AnimPatch {
  const raw = clipProgress(clip, tMs);
  const e = raw === null ? 0 : evalEasing(clip.easing, raw);
  switch (clip.preset) {
    case "fade-out":
      return { dx: 0, dy: 0, scale: 1, rotate: 0, opacityMul: 1 - e };
    case "sink":
      return { dx: 0, dy: e * 48, scale: 1, rotate: 0, opacityMul: 1 - e };
    case "pop-out":
      return { dx: 0, dy: 0, scale: 1 - 0.4 * e, rotate: 0, opacityMul: 1 - e };
    case "drift-out":
      return { dx: e * 24, dy: e * -24, scale: 1 - 0.04 * e, rotate: 0, opacityMul: 1 - e };
    default:
      return { ...IDENTITY_PATCH };
  }
}

/**
 * Emphasis patch: a LOOPING idle animation. `tMs` is wrapped by the clip period
 * (delay + duration) so it cycles forever; the returned patch oscillates around
 * the identity and is the identity at the loop boundaries.
 */
export function emphasisPatch(clip: AnimationClip<EmphasisPreset>, tMs: number): AnimPatch {
  const period = Math.max(1, clip.durationMs);
  // Phase 0..1 within the active part of the loop (after delay), else resting.
  const cycle = period + clip.delayMs;
  const local = ((tMs % cycle) + cycle) % cycle;
  if (local < clip.delayMs) return { ...IDENTITY_PATCH };
  const p = (local - clip.delayMs) / period; // 0..1
  const sine = Math.sin(p * TAU); // -1..1, zero at the ends
  switch (clip.preset) {
    case "pulse": {
      const s = 1 + 0.08 * Math.sin(p * Math.PI); // single half-cycle swell
      return { dx: 0, dy: 0, scale: s, rotate: 0, opacityMul: 1 };
    }
    case "wiggle":
      return { dx: 0, dy: 0, scale: 1, rotate: 6 * sine, opacityMul: 1 };
    case "spin":
      return { dx: 0, dy: 0, scale: 1, rotate: 360 * p, opacityMul: 1 };
    case "breathe": {
      const s = 1 + 0.06 * Math.sin(p * Math.PI);
      return { dx: 0, dy: 0, scale: s, rotate: 0, opacityMul: 0.85 + 0.15 * Math.sin(p * Math.PI) };
    }
    case "tada": {
      // brief scale-up plus a couple of rotational shakes
      const s = 1 + 0.1 * Math.sin(p * Math.PI);
      return { dx: 0, dy: 0, scale: s, rotate: 4 * Math.sin(p * TAU * 3), opacityMul: 1 };
    }
    default:
      return { ...IDENTITY_PATCH };
  }
}

/** Total ms a clip occupies (delay + duration); 0 when absent. */
export function clipEnd(clip: AnimationClip | undefined): number {
  return clip ? clip.delayMs + Math.max(0, clip.durationMs) : 0;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function keyframePatch(k: Keyframe): AnimPatch {
  return { dx: k.dx ?? 0, dy: k.dy ?? 0, scale: k.scale ?? 1, rotate: k.rotate ?? 0, opacityMul: k.opacity ?? 1 };
}

/** Evaluate a custom keyframe timeline (F25 FR-3) at time t (ms since the track
 *  started), returning the interpolated AnimPatch. Before the first / after the
 *  last keyframe it holds that keyframe's pose; looping wraps t by the duration.
 *  Each keyframe's `easing` shapes the segment to the next. Pure. */
export function customPatch(track: KeyframeTrack, tMs: number): AnimPatch {
  const kfs = track.keyframes;
  if (!kfs.length) return { ...IDENTITY_PATCH };
  const dur = Math.max(1, track.durationMs);
  let t = tMs;
  if (track.loop) t = ((tMs % dur) + dur) % dur;
  else t = t < 0 ? 0 : t > dur ? dur : t;
  const sorted = kfs.length > 1 ? [...kfs].sort((a, b) => a.t - b.t) : kfs;
  if (t <= sorted[0].t) return keyframePatch(sorted[0]);
  const last = sorted[sorted.length - 1];
  if (t >= last.t) return keyframePatch(last);
  let i = 0;
  while (i < sorted.length - 1 && sorted[i + 1].t <= t) i++;
  const a = sorted[i];
  const b = sorted[i + 1];
  const span = Math.max(1e-6, b.t - a.t);
  const e = evalEasing(a.easing ?? "linear", (t - a.t) / span);
  return {
    dx: lerp(a.dx ?? 0, b.dx ?? 0, e),
    dy: lerp(a.dy ?? 0, b.dy ?? 0, e),
    scale: lerp(a.scale ?? 1, b.scale ?? 1, e),
    rotate: lerp(a.rotate ?? 0, b.rotate ?? 0, e),
    opacityMul: lerp(a.opacity ?? 1, b.opacity ?? 1, e),
  };
}

/** The end time (ms) of a custom track, for sequencing/total-duration math. */
export function customTrackEnd(track: KeyframeTrack | undefined): number {
  return track ? Math.max(0, track.durationMs) : 0;
}

/**
 * Apply a patch's opacity multiplier to a node's resting opacity, clamped to
 * [0,1]. A spring easing can carry `opacityMul` past 1 mid-curve, but the
 * resting opacity is the contract ceiling, so the displayed opacity never
 * exceeds it (transform overshoot is intentional and left untouched).
 */
export function appliedOpacity(baseOpacity: number, opacityMul: number): number {
  return clamp01(baseOpacity * opacityMul);
}

/**
 * Normalized, eased progress (0..1) of a page transition `durationMs` long at
 * elapsed time `tMs`, shared by present mode's slide-to-slide cross effects so
 * the math lives next to the rest of the playback engine. A zero/absent duration
 * snaps straight to 1 (an instant switch). Transitions use a soft ease-in-out.
 */
export function transitionProgress(tMs: number, durationMs: number): number {
  if (durationMs <= 0) return 1;
  return evalEasing("ease-in-out", clamp01(tMs / durationMs));
}

/**
 * Ken Burns / parallax photo-motion patch for an image at present time `tMs`.
 * Returns a slow looping zoom+pan whose magnitude scales with `intensity` (0..1).
 * `periodMs` controls the loop length (defaults to a slow 12s drift). Parallax is
 * a gentler pan than ken-burns and zooms less.
 */
export function imageMotionPatch(
  motion: { kind: "kenburns" | "parallax"; intensity: number },
  tMs: number,
  periodMs = 12000,
): AnimPatch {
  const k = clamp01(motion.intensity);
  const p = ((tMs % periodMs) + periodMs) % periodMs / periodMs; // 0..1
  const wave = Math.sin(p * TAU); // smooth, returns to start each loop
  if (motion.kind === "kenburns") {
    const scale = 1 + 0.12 * k * Math.sin(p * Math.PI); // zoom in from rest then back
    return { dx: 18 * k * wave, dy: 10 * k * (1 - Math.cos(p * TAU)) / 2, scale, rotate: 0, opacityMul: 1 };
  }
  // parallax: pan only, very subtle zoom
  return { dx: 28 * k * wave, dy: 0, scale: 1 + 0.04 * k, rotate: 0, opacityMul: 1 };
}
