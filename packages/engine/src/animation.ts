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
  /** v23 keyframe channels (absolute overrides; undefined = no override). */
  color?: import("@hc/schema").Color;
  width?: number;
  height?: number;
}

export const identityPatch: Readonly<AnimPatch> = Object.freeze({
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
    case "ease-in-cubic":
      return x * x * x;
    case "ease-out-cubic":
      return 1 - Math.pow(1 - x, 3);
    case "ease-out-back": {
      // Slight overshoot past 1 then settle (a gentle "back" ease).
      const c1 = 1.70158, c3 = c1 + 1;
      return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
    }
    case "bounce": {
      // Standard ease-out bounce.
      const n1 = 7.5625, d1 = 2.75;
      let t = x;
      if (t < 1 / d1) return n1 * t * t;
      if (t < 2 / d1) { t -= 1.5 / d1; return n1 * t * t + 0.75; }
      if (t < 2.5 / d1) { t -= 2.25 / d1; return n1 * t * t + 0.9375; }
      t -= 2.625 / d1; return n1 * t * t + 0.984375;
    }
    case "spring":
      return springEase(x);
    default:
      return x;
  }
}

/**
 * Damped-oscillation spring settling to 1, deterministic for given params
 * (F28 completion C13). `stiffness` maps to the angular frequency (default 8)
 * and `damping` to the damping ratio (default 0.32, underdamped for a little
 * overshoot); both CLAMP into the stable range here, so any stored value -
 * including one written by a newer client - renders sanely.
 */
export function springEase(t: number, stiffness?: number, damping?: number): number {
  const x = clamp01(t);
  if (x >= 1) return 1;
  const omega = Math.min(40, Math.max(1, stiffness ?? 8));
  const zeta = Math.min(0.999, Math.max(0.05, damping ?? 0.32));
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  const env = Math.exp(-zeta * omega * x);
  return 1 - env * (Math.cos(wd * x) + ((zeta * omega) / wd) * Math.sin(wd * x));
}

/** Evaluate a CSS-style cubic-bezier easing [x1,y1,x2,y2] at progress x in [0,1].
 *  Solves x(t)=x for t (Newton + bisection fallback), then returns y(t). */
export function cubicBezierEase(x: number, x1: number, y1: number, x2: number, y2: number): number {
  const xc = clamp01(x);
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  let t = xc;
  for (let i = 0; i < 8; i++) { // Newton-Raphson
    const dx = sampleX(t) - xc;
    if (Math.abs(dx) < 1e-5) break;
    const d = sampleDX(t);
    if (Math.abs(d) < 1e-6) break;
    t -= dx / d;
  }
  if (t < 0 || t > 1) { // bisection fallback
    let lo = 0, hi = 1;
    t = xc;
    for (let i = 0; i < 20; i++) { const xv = sampleX(t); if (Math.abs(xv - xc) < 1e-5) break; if (xv < xc) lo = t; else hi = t; t = (lo + hi) / 2; }
  }
  return ((ay * t + by) * t + cy) * t;
}

/** Eased progress for a clip, using its custom cubic-bezier when present, else
 *  its named easing curve. Single source of truth for clip timing. */
export function clipEase(clip: { easing: Easing; bezier?: [number, number, number, number]; spring?: { stiffness?: number; damping?: number } }, t: number): number {
  if (clip.bezier) return cubicBezierEase(t, clip.bezier[0], clip.bezier[1], clip.bezier[2], clip.bezier[3]);
  if (clip.easing === "spring" && clip.spring) return springEase(t, clip.spring.stiffness, clip.spring.damping);
  return evalEasing(clip.easing, t);
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
  const e = raw === null ? 0 : clipEase(clip, raw);
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
    case "typewriter":
    case "word-wipe":
      // Reveal is a content effect (handled in poseDesignAt), so the node itself
      // stays put and fully opaque; characters/words appear over the clip.
      return { ...identityPatch };
    case "tumble":
      return { dx: 0, dy: inv * 32, scale: 0.7 + 0.3 * e, rotate: -180 * inv, opacityMul: e };
    case "stomp":
      return { dx: 0, dy: 0, scale: 1.6 - 0.6 * e, rotate: 0, opacityMul: e };
    case "zoom-in":
      return { dx: 0, dy: 0, scale: 0.2 + 0.8 * e, rotate: 0, opacityMul: e };
    default:
      return { ...identityPatch };
  }
}

/** Eased entrance progress in [0,1] (0 before the clip's delay, 1 after it ends).
 *  Used by text reveal ("typewriter") to decide how many characters are shown. */
export function entranceProgress(clip: AnimationClip<EntrancePreset>, tMs: number): number {
  const raw = clipProgress(clip, tMs);
  return raw === null ? 0 : clipEase(clip, raw);
}

/** Exit patch: animates FROM the resting pose TO an off pose (eased 0->1). At
 *  e=0 it is the identity; at e=1 the element is fully gone. */
export function exitPatch(clip: AnimationClip<ExitPreset>, tMs: number): AnimPatch {
  const raw = clipProgress(clip, tMs);
  const e = raw === null ? 0 : clipEase(clip, raw);
  switch (clip.preset) {
    case "fade-out":
      return { dx: 0, dy: 0, scale: 1, rotate: 0, opacityMul: 1 - e };
    case "sink":
      return { dx: 0, dy: e * 48, scale: 1, rotate: 0, opacityMul: 1 - e };
    case "pop-out":
      return { dx: 0, dy: 0, scale: 1 - 0.4 * e, rotate: 0, opacityMul: 1 - e };
    case "drift-out":
      return { dx: e * 24, dy: e * -24, scale: 1 - 0.04 * e, rotate: 0, opacityMul: 1 - e };
    case "tumble-out":
      return { dx: 0, dy: e * 32, scale: 1 - 0.3 * e, rotate: 180 * e, opacityMul: 1 - e };
    case "zoom-out":
      return { dx: 0, dy: 0, scale: 1 - 0.8 * e, rotate: 0, opacityMul: 1 - e };
    default:
      return { ...identityPatch };
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
  if (local < clip.delayMs) return { ...identityPatch };
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
    case "flicker":
      // Opacity blink, settling to fully visible at the loop ends.
      return { dx: 0, dy: 0, scale: 1, rotate: 0, opacityMul: 0.4 + 0.6 * Math.abs(Math.sin(p * TAU * 2)) };
    case "jiggle":
      return { dx: 5 * Math.sin(p * TAU * 3), dy: 0, scale: 1, rotate: 0, opacityMul: 1 };
    case "bob":
      return { dx: 0, dy: -6 * Math.sin(p * Math.PI), scale: 1, rotate: 0, opacityMul: 1 };
    default:
      return { ...identityPatch };
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
/** Sample a polyline motion path at progress e (0..1 of total arc length),
 *  returning the offset and the tangent angle in degrees (F28 completion
 *  C11). Pure; exported for the editor overlay and tests. */
export function samplePath(path: { x: number; y: number }[], e: number): { x: number; y: number; angleDeg: number } {
  if (path.length === 0) return { x: 0, y: 0, angleDeg: 0 };
  if (path.length === 1) return { x: path[0].x, y: path[0].y, angleDeg: 0 };
  const segs: number[] = [];
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const len = Math.hypot(path[i + 1].x - path[i].x, path[i + 1].y - path[i].y);
    segs.push(len);
    total += len;
  }
  if (total <= 0) return { x: path[0].x, y: path[0].y, angleDeg: 0 };
  let dist = clamp01(e) * total;
  for (let i = 0; i < segs.length; i++) {
    if (dist <= segs[i] || i === segs.length - 1) {
      const f = segs[i] > 0 ? Math.min(1, dist / segs[i]) : 1;
      const ax = path[i].x, ay = path[i].y;
      const bx = path[i + 1].x, by = path[i + 1].y;
      return {
        x: ax + (bx - ax) * f,
        y: ay + (by - ay) * f,
        angleDeg: (Math.atan2(by - ay, bx - ax) * 180) / Math.PI,
      };
    }
    dist -= segs[i];
  }
  return { x: path[path.length - 1].x, y: path[path.length - 1].y, angleDeg: 0 };
}

/** Sample one keyframe channel independently: interpolate between the
 *  keyframes that DEFINE it (v23 channels are sparse), HOLDING at both
 *  boundaries - the first defined value before its time, the last past its
 *  time - exactly as the transform channels hold, so a lone width/color
 *  keyframe mid-track never makes the node snap. `sorted` is time-ascending. */
function sampleChannel<T>(
  sorted: Keyframe[],
  t: number,
  get: (k: Keyframe) => T | undefined,
  mix: (a: T, b: T, e: number) => T,
): T | undefined {
  let prev: Keyframe | null = null;
  let next: Keyframe | null = null;
  for (const k of sorted) {
    if (get(k) === undefined) continue;
    if (k.t <= t) prev = k;
    else { next = k; break; }
  }
  if (!prev && !next) return undefined;
  if (!prev) return get(next!)!; // hold the first defined value before its time
  if (!next) return get(prev)!; // hold the last defined value past its time
  const span = Math.max(1e-6, next.t - prev.t);
  const e = evalEasing(prev.easing ?? "linear", (t - prev.t) / span);
  return mix(get(prev)!, get(next)!, e);
}

export function customPatch(track: KeyframeTrack, tMs: number): AnimPatch {
  const kfs = track.keyframes;
  const hasPath = Array.isArray(track.path) && track.path.length >= 2;
  if (!kfs.length && !hasPath) return { ...identityPatch };
  const dur = Math.max(1, track.durationMs);
  let t = tMs;
  if (track.loop) t = ((tMs % dur) + dur) % dur;
  else t = t < 0 ? 0 : t > dur ? dur : t;

  // Base pose from the classic segment interpolation (unchanged math).
  let base: AnimPatch;
  if (!kfs.length) {
    base = { ...identityPatch };
  } else {
    const sorted = kfs.length > 1 ? [...kfs].sort((a, b) => a.t - b.t) : kfs;
    if (t <= sorted[0].t) base = keyframePatch(sorted[0]);
    else {
      const last = sorted[sorted.length - 1];
      if (t >= last.t) base = keyframePatch(last);
      else {
        let i = 0;
        while (i < sorted.length - 1 && sorted[i + 1].t <= t) i++;
        const a = sorted[i];
        const b = sorted[i + 1];
        const span = Math.max(1e-6, b.t - a.t);
        const e = evalEasing(a.easing ?? "linear", (t - a.t) / span);
        base = {
          dx: lerp(a.dx ?? 0, b.dx ?? 0, e),
          dy: lerp(a.dy ?? 0, b.dy ?? 0, e),
          scale: lerp(a.scale ?? 1, b.scale ?? 1, e),
          rotate: lerp(a.rotate ?? 0, b.rotate ?? 0, e),
          opacityMul: lerp(a.opacity ?? 1, b.opacity ?? 1, e),
        };
      }
    }
    // v23 channels sample INDEPENDENTLY of the transform segments, between the
    // keyframes that define them.
    const sorted2 = kfs.length > 1 ? [...kfs].sort((a, b) => a.t - b.t) : kfs;
    const num = (x: number, y: number, e: number) => x + (y - x) * e;
    const width = sampleChannel(sorted2, t, (k) => k.width, num);
    const height = sampleChannel(sorted2, t, (k) => k.height, num);
    const color = sampleChannel(sorted2, t, (k) => k.color, (a, b, e) => ({
      srgb: {
        r: num(a.srgb.r, b.srgb.r, e),
        g: num(a.srgb.g, b.srgb.g, e),
        b: num(a.srgb.b, b.srgb.b, e),
        a: num(a.srgb.a, b.srgb.a, e),
      },
    }));
    if (width !== undefined) base.width = width;
    if (height !== undefined) base.height = height;
    if (color !== undefined) base.color = color;
  }

  // Motion path (C11): drives dx/dy INSTEAD of the keyframe dx/dy channels,
  // eased over the whole track by the first keyframe's easing (or linear).
  if (hasPath) {
    const e = evalEasing(kfs[0]?.easing ?? "linear", t / dur);
    const s = samplePath(track.path!, e);
    base.dx = s.x;
    base.dy = s.y;
    if (track.orient) base.rotate += s.angleDeg;
  }
  return base;
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

/** The easing names a transition may carry (v22). The schema deliberately
 *  stores a PLAIN string so future names keep validating on older clients;
 *  THIS clamp is where an unknown name degrades to the classic default. */
const transitionEasings: ReadonlySet<string> = new Set([
  "linear", "ease-in", "ease-out", "ease-in-out", "spring", "ease-in-cubic", "ease-out-cubic", "ease-out-back", "bounce",
]);

/** Resolve a transition's easing string to a known Easing (default ease-in-out). */
export function transitionEasing(easing: string | undefined): Easing {
  return easing && transitionEasings.has(easing) ? (easing as Easing) : "ease-in-out";
}

/**
 * Normalized, eased progress (0..1) of a page transition `durationMs` long at
 * elapsed time `tMs`, shared by present mode's slide-to-slide cross effects so
 * the math lives next to the rest of the playback engine. A zero/absent duration
 * snaps straight to 1 (an instant switch). The per-transition easing (v22)
 * shapes the curve; absent or unknown names use the classic soft ease-in-out.
 */
export function transitionProgress(tMs: number, durationMs: number, easing?: string): number {
  if (durationMs <= 0) return 1;
  return evalEasing(transitionEasing(easing), clamp01(tMs / durationMs));
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
