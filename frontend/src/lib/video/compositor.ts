// Timeline frame compositor: pure math for what is visible/audible at a frame
// plus a canvas draw routine that composites the active video clips. DOM enters
// only through the caller-provided element resolver, so the timing/transition
// math stays unit-testable.

import {
  clipAtFrame,
  clipDurationFrames,
  clipEndFrame,
  sourceFrameAt,
  type Clip,
  type ClipTransition,
  type ColorAdjust,
  type TitleCard,
  type Track,
  type VideoProject,
} from "@hc/timeline";
import { dbToGain, effectiveClipGain, gainAtFrame, isAudible } from "@hc/audio";

export interface ActiveClip {
  track: Track;
  clip: Clip;
  /** Playhead position inside the clip, in timeline frames from its start. */
  localFrame: number;
  /** Mapped source-media frame (honors in/out, speed, reverse); null off-media. */
  sourceFrame: number | null;
  durationFrames: number;
  /** Frame rate of the project scope this active belongs to (nested
   *  sequences can differ from the top level); callers map sourceFrame to
   *  seconds with THIS, not the top project's fps. */
  scopeFps: number;
  /** Absolute mix gain for expanded sequence children (their whole parent
   *  chain folded in); top-level actives leave it undefined and the caller
   *  computes clipGainAt as before. */
  mixGain?: number;
  /** Expanded from a nested sequence clip. */
  fromSequence?: boolean;
  /** A parent video/overlay track (or the parent clip's own track) is hidden. */
  hiddenByParent?: boolean;
  /** The LEFT half of an overlap cross-dissolve, continuing past its cut
   *  (drawn at constant alpha under the incoming clip's fade-in). */
  xfadeTail?: boolean;
  /** The left clip of an overlap pair inside its own span: its pre-cut
   *  out-fade is replaced by the post-cut tail. */
  suppressOutFade?: boolean;
}

export interface ActiveOptions {
  /** Resolver for nested sequence clips (clip.sequenceId -> child project). */
  resolveSequence?: (id: string) => VideoProject | null;
  /** Include overlap cross-dissolve tails and suppression flags. */
  xfade?: boolean;
  /** Recursion depth (internal). */
  depth?: number;
}

const MAX_SEQUENCE_DEPTH = 16;

/** The overlap window (frames after the cut) when clip L hands off to the
 *  abutting next clip with a crossDissolve authored on BOTH edges; 0 = none. */
export function xfadeWindow(track: Track, left: Clip): number {
  if (left.transitionOut?.type !== "crossDissolve") return 0;
  const end = clipEndFrame(left);
  const right = track.clips.find((c) => c.startFrame === end && c.id !== left.id);
  if (!right || right.transitionIn?.type !== "crossDissolve") return 0;
  return Math.max(1, Math.min(left.transitionOut.durationFrames, right.transitionIn.durationFrames));
}

/** Source frame for a tail continuing `extra` frames past the clip's out. */
function tailSourceFrame(clip: Clip, extra: number): number {
  const mag = Math.abs(clip.speed) || 1;
  if (clip.speed < 0) return Math.max(0, clip.inFrame - Math.round(extra * mag));
  return clip.outFrame + Math.round(extra * mag);
}

/**
 * All clips under the playhead on every track, in track order. With
 * opts.xfade, overlap cross-dissolve tails are emitted just before the
 * incoming clip. With opts.resolveSequence, sequence clips expand recursively
 * into their child project's actives (child track order preserved), each
 * carrying the parent chain's gain and visibility.
 */
export function activeClipsAt(project: VideoProject, frame: number, opts: ActiveOptions = {}): ActiveClip[] {
  const depth = opts.depth ?? 0;
  const out: ActiveClip[] = [];
  for (const track of project.tracks) {
    const clip = clipAtFrame(track, frame);
    // Overlap tail: the previous clip on this track continuing past its cut.
    if (opts.xfade && clip) {
      const prev = track.clips.find(
        (c) => c.id !== clip.id && clipEndFrame(c) === clip.startFrame && xfadeWindow(track, c) > 0,
      );
      if (prev) {
        const extra = frame - clip.startFrame;
        if (extra >= 0 && extra < xfadeWindow(track, prev)) {
          out.push({
            track,
            clip: prev,
            localFrame: frame - prev.startFrame,
            sourceFrame: tailSourceFrame(prev, extra),
            durationFrames: clipDurationFrames(prev),
            scopeFps: project.fps,
            xfadeTail: true,
          });
        }
      }
    }
    if (!clip) continue;
    const base: ActiveClip = {
      track,
      clip,
      localFrame: frame - clip.startFrame,
      sourceFrame: sourceFrameAt(clip, frame),
      durationFrames: clipDurationFrames(clip),
      scopeFps: project.fps,
      suppressOutFade: opts.xfade && xfadeWindow(track, clip) > 0 ? true : undefined,
    };
    // Nested sequence: expand into the child project's actives.
    if (clip.sequenceId && opts.resolveSequence && depth < MAX_SEQUENCE_DEPTH) {
      const child = opts.resolveSequence(clip.sequenceId);
      const childFrame = base.sourceFrame;
      if (child && childFrame !== null) {
        const parentGain =
          effectiveClipGain(clip, track, project.master, project.tracks) *
          gainAtFrame(clip, base.localFrame, base.durationFrames) *
          dbToGain(gainEnvelopeDb(clip, base.localFrame));
        const parentAudible = isAudible(track, project.tracks);
        const kids = activeClipsAt(child, childFrame, { ...opts, depth: depth + 1 });
        for (const kid of kids) {
          const kidGain =
            kid.mixGain ??
            (isAudible(kid.track, child.tracks)
              ? effectiveClipGain(kid.clip, kid.track, child.master, child.tracks) *
                gainAtFrame(kid.clip, kid.localFrame, kid.durationFrames) *
                dbToGain(gainEnvelopeDb(kid.clip, kid.localFrame))
              : 0);
          out.push({
            ...kid,
            fromSequence: true,
            mixGain: parentAudible ? kidGain * parentGain : 0,
            hiddenByParent: kid.hiddenByParent || track.hidden || undefined,
          });
        }
        continue;
      }
    }
    out.push(base);
  }
  return out;
}

/** Visible video-bearing clips bottom-to-top: LATER tracks stack ON TOP. */
export function visibleVideoClipsAt(project: VideoProject, frame: number, opts: ActiveOptions = {}): ActiveClip[] {
  return activeClipsAt(project, frame, { xfade: true, ...opts }).filter(
    (a) =>
      (a.track.kind === "video" || a.track.kind === "overlay") &&
      !a.track.hidden &&
      !a.hiddenByParent &&
      !a.clip.disabled,
  );
}

/** Audible clips at a frame (audio tracks plus the sound of video tracks). */
export function audibleClipsAt(project: VideoProject, frame: number, opts: ActiveOptions = {}): ActiveClip[] {
  return activeClipsAt(project, frame, opts).filter(
    (a) =>
      (a.track.kind === "audio" || a.track.kind === "video" || a.track.kind === "overlay") &&
      !a.clip.disabled &&
      (a.fromSequence ? (a.mixGain ?? 0) > 0 : isAudible(a.track, project.tracks)),
  );
}

// ---------------------------------------------------------------------------
// transitions
// ---------------------------------------------------------------------------

export interface TransitionFx {
  /** 0..1 overall clip opacity from fade/crossDissolve edges. */
  alpha: number;
  /** Reveal fraction (wipe): only `wipe` of the clip is drawn, from `wipeDir`. */
  wipe?: number;
  /** Edge the wipe reveals from (default "left"). */
  wipeDir?: "left" | "right" | "up" | "down";
  /** Horizontal slide offset as a fraction of stage width (slide). */
  slideX?: number;
  /** Vertical slide offset as a fraction of stage height (slide up/down). */
  slideY?: number;
  /** Solid overlay (dipToColor): color + its opacity. */
  dip?: { color: string; alpha: number };
}

function edgeProgress(t: ClipTransition | undefined, localFrame: number, durationFrames: number, edge: "in" | "out"): number | null {
  if (!t || t.durationFrames <= 0) return null;
  const d = Math.min(t.durationFrames, durationFrames);
  if (edge === "in") {
    if (localFrame >= d) return null;
    return Math.max(0, Math.min(1, (localFrame + 1) / d));
  }
  const fromEnd = durationFrames - localFrame;
  if (fromEnd > d) return null;
  return Math.max(0, Math.min(1, fromEnd / d)); // 1 at transition start, ->0 at clip end
}

/** Combined transition effect for a clip at a local frame. */
export function transitionFxAt(clip: Clip, localFrame: number, durationFrames: number): TransitionFx {
  const fx: TransitionFx = { alpha: 1 };
  const applyEdge = (t: ClipTransition | undefined, edge: "in" | "out") => {
    const p = edgeProgress(t, localFrame, durationFrames, edge);
    if (p === null || !t) return;
    // p ramps 0->1 over the in edge and 1->0 over the out edge; for both, `p`
    // is "how present the clip is".
    switch (t.type) {
      case "crossDissolve":
      case "fade":
        fx.alpha *= p;
        break;
      case "wipe":
        fx.wipe = Math.min(fx.wipe ?? 1, p);
        if (t.direction) fx.wipeDir = t.direction;
        break;
      case "slide": {
        if (!t.direction) {
          // Legacy: in slides from the left; out slides away to the right.
          fx.slideX = (fx.slideX ?? 0) + (edge === "in" ? p - 1 : 1 - p);
          break;
        }
        // Directional: the clip enters from `direction` (off = -1 -> 0) and exits
        // back to it (0 -> -1). `off` is the offset toward the entry edge.
        const off = edge === "in" ? p - 1 : -(1 - p);
        if (t.direction === "left") fx.slideX = (fx.slideX ?? 0) + off;
        else if (t.direction === "right") fx.slideX = (fx.slideX ?? 0) - off;
        else if (t.direction === "up") fx.slideY = (fx.slideY ?? 0) + off;
        else if (t.direction === "down") fx.slideY = (fx.slideY ?? 0) - off;
        break;
      }
      case "dipToColor":
        fx.dip = { color: t.color ?? "#000000", alpha: 1 - p };
        break;
    }
  };
  applyEdge(clip.transitionIn, "in");
  applyEdge(clip.transitionOut, "out");
  return fx;
}

// ---------------------------------------------------------------------------
// audio gains
// ---------------------------------------------------------------------------

/** Piecewise-linear interpolation over ducking automation points. */
export function duckDbAtFrame(points: { frame: number; musicGainDb: number }[], frame: number): number {
  if (!points.length) return 0;
  if (frame <= points[0].frame) return points[0].musicGainDb;
  for (let i = 1; i < points.length; i++) {
    if (frame <= points[i].frame) {
      const a = points[i - 1];
      const b = points[i];
      const span = b.frame - a.frame;
      const t = span > 0 ? (frame - a.frame) / span : 1;
      return a.musicGainDb + (b.musicGainDb - a.musicGainDb) * t;
    }
  }
  return points[points.length - 1].musicGainDb;
}

/** The clip's volume-envelope value (dB) at a local frame: keyframes on the
 *  "gain" property, linearly interpolated; 0 dB when unset. */
export function gainEnvelopeDb(clip: Clip, localFrame: number): number {
  const track = clip.keyframes?.find((t) => t.property === "gain");
  if (!track) return 0;
  return evalProperty(track.keyframes, localFrame, 0);
}

/**
 * Linear playback gain for one clip at a frame: clip x track x master (dB)
 * composed by @hc/audio, times the clip's fade envelope, times the keyframed
 * volume envelope, times the ducking automation when this track is the
 * ducked music track.
 */
export function clipGainAt(
  project: VideoProject,
  track: Track,
  clip: Clip,
  localFrame: number,
  duckPoints?: { frame: number; musicGainDb: number }[],
): number {
  if (!isAudible(track, project.tracks)) return 0;
  let gain = effectiveClipGain(clip, track, project.master, project.tracks);
  gain *= gainAtFrame(clip, localFrame, clipDurationFrames(clip));
  gain *= dbToGain(gainEnvelopeDb(clip, localFrame));
  if (duckPoints && project.master.ducking?.musicTrackId === track.id) {
    gain *= dbToGain(duckDbAtFrame(duckPoints, clip.startFrame + localFrame));
  }
  return gain;
}

// ---------------------------------------------------------------------------
// color adjustments
// ---------------------------------------------------------------------------

/** Named filter presets: applying one copies these values onto the clip so the
 *  sliders always show (and can further tweak) the real numbers. */
export const COLOR_PRESETS: { name: string; label: string; color: ColorAdjust }[] = [
  { name: "vivid", label: "Vivid", color: { saturation: 1.35, contrast: 1.08 } },
  { name: "warm", label: "Warm", color: { temperature: 0.5, saturation: 1.05 } },
  { name: "cool", label: "Cool", color: { temperature: -0.5 } },
  { name: "mono", label: "Mono", color: { saturation: 0, contrast: 1.05 } },
  { name: "faded", label: "Faded", color: { contrast: 0.85, saturation: 0.85, brightness: 1.05 } },
  { name: "noir", label: "Noir", color: { saturation: 0, contrast: 1.3, brightness: 0.95 } },
];

/** True when the adjustments draw identically to no adjustments. */
export function colorIsNeutral(c: ColorAdjust | undefined): boolean {
  if (!c) return true;
  return (
    (c.brightness ?? 1) === 1 &&
    (c.contrast ?? 1) === 1 &&
    (c.saturation ?? 1) === 1 &&
    (c.temperature ?? 0) === 0
  );
}

/** Canvas2D `ctx.filter` string for the brightness/contrast/saturation part
 *  ("" = none). Temperature is drawn as a blend overlay, not a filter. */
export function colorFilter(c: ColorAdjust | undefined): string {
  if (!c) return "";
  const parts: string[] = [];
  const b = c.brightness ?? 1;
  const ct = c.contrast ?? 1;
  const s = c.saturation ?? 1;
  if (b !== 1) parts.push(`brightness(${b})`);
  if (ct !== 1) parts.push(`contrast(${ct})`);
  if (s !== 1) parts.push(`saturate(${s})`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// keyframes
// ---------------------------------------------------------------------------

/** Evaluated animatable properties of a clip at one local frame. */
export interface ClipPose {
  /** 0..1 opacity multiplier. */
  opacity: number;
  /** Center offset as a fraction of stage width/height. */
  dx: number;
  dy: number;
  /** Scale multiplier about the stage center. */
  scale: number;
  /** Rotation in degrees about the clip center. */
  rotation: number;
}

const POSE_DEFAULTS: ClipPose = { opacity: 1, dx: 0, dy: 0, scale: 1, rotation: 0 };

/** Easing curve for the segment LEAVING a keyframe (stored on that keyframe).
 *  Unknown/absent names fall back to linear, so older files are unaffected. */
export function applyEasing(t: number, easing: string | undefined): number {
  switch (easing) {
    case "easeIn":
      return t * t;
    case "easeOut":
      return 1 - (1 - t) * (1 - t);
    case "easeInOut":
      return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) * (-2 * t + 2)) / 2;
    default:
      return t;
  }
}

/** Interpolation over one property's keyframes at a local frame, honoring each
 *  segment's easing (taken from the keyframe the segment departs from). */
function evalProperty(kf: { frame: number; value: unknown; easing?: string }[], frame: number, fallback: number): number {
  const pts = kf
    .map((k) => ({ frame: k.frame, value: typeof k.value === "number" ? k.value : NaN, easing: k.easing }))
    .filter((k) => Number.isFinite(k.value))
    .sort((a, b) => a.frame - b.frame);
  if (!pts.length) return fallback;
  if (frame <= pts[0].frame) return pts[0].value;
  for (let i = 1; i < pts.length; i++) {
    if (frame <= pts[i].frame) {
      const a = pts[i - 1];
      const b = pts[i];
      const span = b.frame - a.frame;
      const t = span > 0 ? (frame - a.frame) / span : 1;
      return a.value + (b.value - a.value) * applyEasing(t, a.easing);
    }
  }
  return pts[pts.length - 1].value;
}

/** Evaluate a clip's keyframe tracks (opacity/dx/dy/scale/rotation) at a local
 *  frame, folding in the clip's static opacity and rotation. */
export function evalKeyframes(tracks: Clip["keyframes"], frame: number, clip?: Clip): ClipPose {
  const pose = { ...POSE_DEFAULTS };
  for (const t of tracks ?? []) {
    if (t.property === "opacity") pose.opacity = Math.max(0, Math.min(1, evalProperty(t.keyframes, frame, 1)));
    else if (t.property === "dx") pose.dx = evalProperty(t.keyframes, frame, 0);
    else if (t.property === "dy") pose.dy = evalProperty(t.keyframes, frame, 0);
    else if (t.property === "scale") pose.scale = Math.max(0.01, evalProperty(t.keyframes, frame, 1));
    else if (t.property === "rotation") pose.rotation = evalProperty(t.keyframes, frame, 0);
  }
  if (clip?.opacity !== undefined) pose.opacity *= Math.max(0, Math.min(1, clip.opacity));
  if (clip?.rotationDeg) pose.rotation += clip.rotationDeg;
  return pose;
}

/**
 * Upsert a pose keyframe for direct manipulation. Static-pose rule: while a
 * property has at most ONE keyframe, dragging updates that single keyframe in
 * place (the clip keeps a constant pose); with 2+ keyframes the drag writes a
 * keyframe at the given local frame, editing the animation curve.
 */
export function upsertPoseKeyframe(
  tracks: Clip["keyframes"],
  property: "dx" | "dy" | "scale" | "opacity",
  frame: number,
  value: number,
): NonNullable<Clip["keyframes"]> {
  const list = tracks ? [...tracks] : [];
  const idx = list.findIndex((t) => t.property === property);
  if (idx < 0) return [...list, { property, keyframes: [{ frame, value }] }];
  const existing = list[idx];
  if (existing.keyframes.length <= 1) {
    const at = existing.keyframes[0]?.frame ?? frame;
    list[idx] = { ...existing, keyframes: [{ frame: at, value }] };
    return list;
  }
  const keyframes = [...existing.keyframes.filter((k) => k.frame !== frame), { frame, value }].sort(
    (a, b) => a.frame - b.frame,
  );
  list[idx] = { ...existing, keyframes };
  return list;
}

// ---------------------------------------------------------------------------
// motion presets
// ---------------------------------------------------------------------------

export type MotionPreset = "fade-in" | "fade-out" | "pop-in" | "slide-in" | "slide-out";

export const MOTION_PRESETS: { name: MotionPreset; label: string }[] = [
  { name: "fade-in", label: "Fade in" },
  { name: "pop-in", label: "Pop in" },
  { name: "slide-in", label: "Slide in" },
  { name: "fade-out", label: "Fade out" },
  { name: "slide-out", label: "Slide out" },
];

/** Replace one property's keyframes inside [from, to] with the given entries,
 *  keeping keyframes outside the window (so an entrance preset composes with
 *  an exit preset on the same property). */
function setEdgeKeys(
  tracks: NonNullable<Clip["keyframes"]>,
  property: string,
  entries: { frame: number; value: number; easing?: string }[],
  from: number,
  to: number,
): NonNullable<Clip["keyframes"]> {
  const idx = tracks.findIndex((t) => t.property === property);
  const kept = idx >= 0 ? tracks[idx].keyframes.filter((k) => k.frame < from || k.frame > to) : [];
  const keyframes = [...kept, ...entries].sort((a, b) => a.frame - b.frame);
  if (idx < 0) return [...tracks, { property, keyframes }];
  const next = [...tracks];
  next[idx] = { ...next[idx], keyframes };
  return next;
}

/**
 * Write a one-click motion preset as ordinary pose keyframes over the clip's
 * entrance or exit window. Entrance and exit presets compose; re-applying a
 * preset overwrites only its own window.
 */
export function applyMotionPreset(
  tracks: Clip["keyframes"],
  preset: MotionPreset,
  durationFrames: number,
  edgeFrames = 12,
): NonNullable<Clip["keyframes"]> {
  let out: NonNullable<Clip["keyframes"]> = tracks ? [...tracks] : [];
  const edge = Math.max(2, Math.min(edgeFrames, Math.floor(durationFrames / 2)));
  const inEnd = edge;
  const outStart = Math.max(0, durationFrames - 1 - edge);
  const last = Math.max(1, durationFrames - 1);
  switch (preset) {
    case "fade-in":
      out = setEdgeKeys(out, "opacity", [{ frame: 0, value: 0 }, { frame: inEnd, value: 1 }], 0, inEnd);
      break;
    case "fade-out":
      out = setEdgeKeys(out, "opacity", [{ frame: outStart, value: 1 }, { frame: last, value: 0 }], outStart, last);
      break;
    case "pop-in":
      out = setEdgeKeys(out, "opacity", [{ frame: 0, value: 0 }, { frame: inEnd, value: 1 }], 0, inEnd);
      out = setEdgeKeys(
        out,
        "scale",
        [{ frame: 0, value: 0.6, easing: "easeOut" }, { frame: inEnd, value: 1 }],
        0,
        inEnd,
      );
      break;
    case "slide-in":
      out = setEdgeKeys(out, "opacity", [{ frame: 0, value: 0 }, { frame: inEnd, value: 1 }], 0, inEnd);
      out = setEdgeKeys(
        out,
        "dx",
        [{ frame: 0, value: -0.4, easing: "easeOut" }, { frame: inEnd, value: 0 }],
        0,
        inEnd,
      );
      break;
    case "slide-out":
      out = setEdgeKeys(out, "opacity", [{ frame: outStart, value: 1 }, { frame: last, value: 0 }], outStart, last);
      out = setEdgeKeys(
        out,
        "dx",
        [{ frame: outStart, value: 0, easing: "easeIn" }, { frame: last, value: 0.4 }],
        outStart,
        last,
      );
      break;
  }
  return out;
}

/** Set every keyframe's easing on one property track (segment shaping). */
export function setTrackEasing(
  tracks: Clip["keyframes"],
  property: string,
  easing: string | undefined,
): NonNullable<Clip["keyframes"]> {
  const list = tracks ? [...tracks] : [];
  const idx = list.findIndex((t) => t.property === property);
  if (idx < 0) return list;
  list[idx] = {
    ...list[idx],
    keyframes: list[idx].keyframes.map((k) => ({ ...k, easing })),
  };
  return list;
}

// ---------------------------------------------------------------------------
// drawing
// ---------------------------------------------------------------------------

/** Cover-fit (scale-crop) or contain-fit (letterbox) a source rect into the stage. */
export function fitRect(
  sw: number,
  sh: number,
  dw: number,
  dh: number,
  fit: "cover" | "contain",
): { x: number; y: number; w: number; h: number } {
  const scale =
    fit === "contain"
      ? Math.min(dw / Math.max(1, sw), dh / Math.max(1, sh))
      : Math.max(dw / Math.max(1, sw), dh / Math.max(1, sh));
  const w = sw * scale;
  const h = sh * scale;
  return { x: (dw - w) / 2, y: (dh - h) / 2, w, h };
}

export interface DrawSource {
  el: CanvasImageSource;
  width: number;
  height: number;
}

/**
 * Composite one timeline frame onto a 2d context sized to the project stage.
 * `resolve` maps a clip to its current drawable media (or null when the media
 * is not ready; the clip is skipped). Later tracks draw on top.
 */
export function drawTimelineFrame(
  ctx: CanvasRenderingContext2D,
  project: VideoProject,
  frame: number,
  resolve: (active: ActiveClip) => DrawSource | null,
  opts: ActiveOptions = {},
): void {
  const { width: W, height: H } = project.stage;
  ctx.fillStyle = project.background ?? "#000000";
  ctx.fillRect(0, 0, W, H);
  for (const active of visibleVideoClipsAt(project, frame, opts)) {
    const src = resolve(active);
    if (!src) continue;
    // Overlap tail draws at constant full alpha; the incoming clip's fade-in
    // on top produces the true crossfade blend. A suppressed out-fade means
    // this clip hands off via the tail instead of fading before its cut.
    const fxClip = active.suppressOutFade ? { ...active.clip, transitionOut: undefined } : active.clip;
    const fx = active.xfadeTail
      ? { alpha: 1 }
      : transitionFxAt(fxClip, active.localFrame, active.durationFrames);
    const pose = evalKeyframes(active.clip.keyframes, active.localFrame, active.clip);
    if ((fx.alpha * pose.opacity <= 0.001 && !fx.dip)) continue;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, fx.alpha * pose.opacity));
    if (fx.wipe !== undefined && fx.wipe < 1) {
      const r = Math.max(0, fx.wipe);
      ctx.beginPath();
      // Reveal a growing band from the chosen edge (default left).
      if (fx.wipeDir === "right") ctx.rect(W * (1 - r), 0, W * r, H);
      else if (fx.wipeDir === "up") ctx.rect(0, 0, W, H * r);
      else if (fx.wipeDir === "down") ctx.rect(0, H * (1 - r), W, H * r);
      else ctx.rect(0, 0, W * r, H);
      ctx.clip();
    }
    if (fx.slideX || fx.slideY) ctx.translate((fx.slideX ?? 0) * W, (fx.slideY ?? 0) * H);
    // Keyframed pose: offset + scale + rotation about the stage center.
    if (pose.dx || pose.dy || pose.scale !== 1 || pose.rotation) {
      ctx.translate(W / 2 + pose.dx * W, H / 2 + pose.dy * H);
      if (pose.rotation) ctx.rotate((pose.rotation * Math.PI) / 180);
      ctx.scale(pose.scale, pose.scale);
      ctx.translate(-W / 2, -H / 2);
    }
    // Source rect: the clip's crop when set (media pixels), else the full media.
    const crop = active.clip.crop;
    const sx = crop?.x ?? 0;
    const sy = crop?.y ?? 0;
    const sw = crop?.width ?? src.width;
    const sh = crop?.height ?? src.height;
    const d = fitRect(sw, sh, W, H, active.clip.fit ?? "cover");
    // Color adjustments: brightness/contrast/saturation via ctx.filter (a
    // no-op string where the browser lacks support: graceful degrade), then
    // temperature as a warm/cool overlay blended onto the drawn region.
    const filter = colorFilter(active.clip.color);
    if (filter) ctx.filter = filter;
    ctx.drawImage(src.el, sx, sy, sw, sh, d.x, d.y, d.w, d.h);
    if (filter) ctx.filter = "none";
    const temp = active.clip.color?.temperature ?? 0;
    if (temp !== 0) {
      ctx.globalCompositeOperation = "overlay";
      ctx.globalAlpha *= Math.min(0.35, Math.abs(temp) * 0.35);
      ctx.fillStyle = temp > 0 ? "#ff8c1e" : "#1e78ff";
      ctx.fillRect(d.x, d.y, d.w, d.h);
    }
    ctx.restore();
    if (fx.dip && fx.dip.alpha > 0.001) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, fx.dip.alpha));
      ctx.fillStyle = fx.dip.color;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
  }
  // Title cards draw over the media, honoring their fade/dissolve edges and
  // their own entrance/exit animations.
  for (const active of activeTitleClipsAt(project, frame, opts)) {
    const fx = transitionFxAt(active.clip, active.localFrame, active.durationFrames);
    const anim = titleAnimAt(active.clip.title as TitleCard, active.localFrame, active.durationFrames);
    const alpha = fx.alpha * anim.alpha;
    if (alpha <= 0.001) continue;
    drawTitleCard(ctx, project, active.clip.title as TitleCard, alpha, anim);
  }
}

/** Entrance/exit animation state of a title card at a local frame. */
export interface TitleAnim {
  /** 0..1 opacity multiplier from the animation edges. */
  alpha: number;
  /** Vertical offset as a fraction of stage height (slide edges). */
  offsetY: number;
  /** Characters revealed so far (type-on entrance); undefined = all. */
  revealChars?: number;
}

/** Compute a title's animation state. Cards without animIn/animOut are static. */
export function titleAnimAt(title: TitleCard, localFrame: number, durationFrames: number): TitleAnim {
  const anim: TitleAnim = { alpha: 1, offsetY: 0 };
  const edge = Math.max(1, Math.min(title.animFrames ?? 12, Math.floor(durationFrames / 2)));
  if (title.animIn && localFrame < edge) {
    const p = Math.max(0, Math.min(1, (localFrame + 1) / edge));
    if (title.animIn === "fade") anim.alpha *= p;
    else if (title.animIn === "slide-up") {
      anim.alpha *= p;
      anim.offsetY += (1 - applyEasing(p, "easeOut")) * 0.06;
    } else if (title.animIn === "type-on") {
      anim.revealChars = Math.max(1, Math.round(title.text.length * p));
    }
  }
  const fromEnd = durationFrames - localFrame;
  if (title.animOut && fromEnd <= edge) {
    const p = Math.max(0, Math.min(1, fromEnd / edge)); // 1 -> 0 toward the end
    anim.alpha *= p;
    if (title.animOut === "slide-down") anim.offsetY += (1 - applyEasing(p, "easeOut")) * 0.06;
  }
  return anim;
}

/** Title clips under the playhead on visible text tracks, in track order. */
export function activeTitleClipsAt(project: VideoProject, frame: number, opts: ActiveOptions = {}): ActiveClip[] {
  return activeClipsAt(project, frame, opts).filter(
    (a) => a.track.kind === "text" && !a.track.hidden && !a.hiddenByParent && !a.clip.disabled && !!a.clip.title?.text,
  );
}

/** Draw one title card (titles/lower-thirds) at the given opacity, optionally
 *  offset/truncated by an entrance/exit animation. */
export function drawTitleCard(
  ctx: CanvasRenderingContext2D,
  project: VideoProject,
  title: TitleCard,
  alpha: number,
  anim?: TitleAnim,
): void {
  const { width: W, height: H } = project.stage;
  const fontPx = Math.max(10, Math.round(H * (title.sizePct ?? 0.07)));
  const lineH = Math.round(fontPx * 1.25);
  // Layout always uses the FULL text so a type-on reveal never reflows lines.
  const lines = title.text.split("\n");
  // Characters still hidden by a type-on entrance, consumed from the last line up.
  let hidden =
    anim?.revealChars !== undefined ? Math.max(0, title.text.length - anim.revealChars) : 0;
  const pos = title.position ?? "center";
  // Baseline of the LAST line for each position preset.
  const blockH = lineH * (lines.length - 1);
  const lastBaseline =
    pos === "top" ? Math.round(H * 0.1) + fontPx + blockH
    : pos === "lower-third" ? Math.round(H * 0.8)
    : Math.round(H / 2 + fontPx / 2) + Math.round(blockH / 2);
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.translate((title.offsetX ?? 0) * W, (title.offsetY ?? 0) * H + (anim?.offsetY ?? 0) * H);
  ctx.font = `${title.weight === "normal" ? 400 : 700} ${fontPx}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const pad = Math.round(fontPx * 0.35);
  let y = lastBaseline;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const cut = Math.min(hidden, line.length);
    hidden = Math.max(0, hidden - line.length - 1); // the newline counts as hidden too
    const shown = cut > 0 ? line.slice(0, line.length - cut) : line;
    if (title.background) {
      const w = ctx.measureText(line).width;
      ctx.fillStyle = title.background;
      ctx.fillRect(W / 2 - w / 2 - pad, y - fontPx - pad / 2, w + pad * 2, fontPx + pad);
    }
    if (shown) {
      ctx.fillStyle = title.color ?? "#ffffff";
      // Left-anchor the revealed prefix inside the full line's centered box so
      // type-on grows rightward instead of re-centering every frame.
      const fullW = ctx.measureText(line).width;
      ctx.textAlign = "left";
      ctx.fillText(shown, W / 2 - fullW / 2, y);
      ctx.textAlign = "center";
    }
    y -= lineH;
  }
  ctx.restore();
}

/** Bounding box of a title card on the stage (canvas px), for hit-testing.
 *  Mirrors drawTitleCard's layout math exactly. */
export function titleBounds(
  ctx: CanvasRenderingContext2D,
  project: VideoProject,
  title: TitleCard,
): { x: number; y: number; w: number; h: number } {
  const { width: W, height: H } = project.stage;
  const fontPx = Math.max(10, Math.round(H * (title.sizePct ?? 0.07)));
  const lineH = Math.round(fontPx * 1.25);
  const lines = title.text.split("\n");
  const pos = title.position ?? "center";
  const blockH = lineH * (lines.length - 1);
  const lastBaseline =
    pos === "top" ? Math.round(H * 0.1) + fontPx + blockH
    : pos === "lower-third" ? Math.round(H * 0.8)
    : Math.round(H / 2 + fontPx / 2) + Math.round(blockH / 2);
  ctx.save();
  ctx.font = `${title.weight === "normal" ? 400 : 700} ${fontPx}px system-ui, sans-serif`;
  let maxW = 0;
  for (const line of lines) maxW = Math.max(maxW, ctx.measureText(line).width);
  ctx.restore();
  const pad = Math.round(fontPx * 0.35);
  const top = lastBaseline - blockH - fontPx - pad / 2;
  return {
    x: W / 2 - maxW / 2 - pad + (title.offsetX ?? 0) * W,
    y: top + (title.offsetY ?? 0) * H,
    w: maxW + pad * 2,
    h: blockH + fontPx + pad,
  };
}

/** Draw the active caption cue (if any) bottom-center onto the stage. */
export function drawCaption(
  ctx: CanvasRenderingContext2D,
  project: VideoProject,
  text: string,
  style?: { sizePct?: number; color?: string; background?: string },
): void {
  const { width: W, height: H } = project.stage;
  const fontPx = Math.max(12, Math.round(H * (style?.sizePct ?? 0.045)));
  ctx.save();
  ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  const lines = text.split("\n");
  const pad = Math.round(fontPx * 0.35);
  const lineH = Math.round(fontPx * 1.25);
  let y = H - Math.round(H * 0.06);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const w = ctx.measureText(line).width;
    ctx.fillStyle = style?.background ?? "rgba(0,0,0,0.65)";
    ctx.fillRect(W / 2 - w / 2 - pad, y - lineH, w + pad * 2, lineH + Math.round(pad / 2));
    ctx.fillStyle = style?.color ?? "#ffffff";
    ctx.fillText(line, W / 2, y);
    y -= lineH + 4;
  }
  ctx.restore();
}
