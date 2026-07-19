// @hc/timeline - core timeline model.
//
// A video project lives in a Design whose `meta.kind === "video"`. The timeline
// model defined here is NOT part of the scene graph: clips reference scene nodes
// and assets by id. All times are INTEGER frames at the project frame rate; there
// is no floating-point timecode anywhere in the model.

/** Allowed project frame rates. */
export type Fps = 24 | 25 | 30 | 50 | 60;

/** A rectangle in node-local coordinates (clip crop region). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Easing identifier passed through to the engine; opaque to the timeline model. */
export type Easing = string;

export interface ClipTransition {
  type: "crossDissolve" | "fade" | "wipe" | "slide" | "dipToColor";
  /** Length of the transition in integer frames; always >= 1. */
  durationFrames: number;
  /** dipToColor target color. */
  color?: string;
  easing?: Easing;
}

export interface ChromaKey {
  keyColor: string;
  /** 0..1 */
  tolerance: number;
  /** 0..1 */
  spill: number;
  /** edge feather in px */
  edgeFeather: number;
}

/** Per-clip color adjustments. All fields optional and additive; an absent
 *  object (or neutral values) means the media draws untouched. */
export interface ColorAdjust {
  /** Multiplier, 1 = neutral (typical range 0.5..1.5). */
  brightness?: number;
  /** Multiplier, 1 = neutral. */
  contrast?: number;
  /** Multiplier, 1 = neutral; 0 = grayscale. */
  saturation?: number;
  /** -1 (cool) .. 1 (warm); 0 = neutral. */
  temperature?: number;
  /** Name of the filter preset these values came from (display only). */
  preset?: string;
}

/**
 * A single keyframe track for one animated property. The interpolation
 * primitives live in the animation work; here we only carry the data
 * so timeline edits (split/move/ripple) can be made to preserve keyframes later.
 */
/** A text card rendered by a clip on a "text" track (titles, lower thirds).
 *  Additive: clips without it draw nothing, older projects are unaffected. */
export interface TitleCard {
  text: string;
  /** Font size as a fraction of stage height (default 0.07). */
  sizePct?: number;
  /** CSS text color (default white). */
  color?: string;
  /** CSS color drawn as a band behind each line; empty/undefined = none. */
  background?: string;
  position?: "top" | "center" | "lower-third";
  /** Free positioning nudge from the preset position, as fractions of the
   *  stage size (additive; set by dragging the title on the stage). */
  offsetX?: number;
  offsetY?: number;
  weight?: "normal" | "bold";
  /** Entrance animation (additive; absent = the card just appears). */
  animIn?: "fade" | "slide-up" | "type-on";
  /** Exit animation (additive). */
  animOut?: "fade" | "slide-down";
  /** Length of each animation edge in timeline frames (default 12). */
  animFrames?: number;
}

export interface KeyframeTrack {
  property: string;
  keyframes: { frame: number; value: unknown; easing?: Easing }[];
}

export interface Clip {
  id: string;
  /** User-facing display name (additive; defaults to the asset filename). */
  name?: string;
  /** Link group (additive): clips sharing a groupId move together (e.g. a
   *  video clip and its detached audio). */
  groupId?: string;
  /** Disabled clips keep their slot but render/play nothing (additive). */
  disabled?: boolean;
  /** Per-clip lock: no edits, no drags (additive; track lock still wins). */
  locked?: boolean;
  /** Display color label (CSS color) overriding the track-kind chip color. */
  colorLabel?: string;
  /** scene-graph node this clip renders (video/text/overlay). */
  nodeId?: string;
  /** source media asset (video/audio). */
  assetId?: string;
  /** nested sequence reference (another VideoProject). */
  sequenceId?: string;
  /** position of the clip on its track, in timeline frames. */
  startFrame: number;
  /** source in-point, in source frames. */
  inFrame: number;
  /** source out-point, in source frames (exclusive of `inFrame` span). */
  outFrame: number;
  /** 1 = normal; >1 faster; <1 slower; negative = reverse. Never 0. */
  speed: number;
  crop?: Rect;
  /** How the media fills the stage: cover (scale-crop, default) or contain
   *  (letterbox). Additive. */
  fit?: "cover" | "contain";
  /** Static opacity 0..1 (additive; multiplies any keyframed opacity). */
  opacity?: number;
  /** Static rotation in degrees about the clip center (additive). */
  rotationDeg?: number;
  /** Color adjustments / filter (additive). */
  color?: ColorAdjust;
  transitionIn?: ClipTransition;
  transitionOut?: ClipTransition;
  chromaKey?: ChromaKey;
  /** Text card for clips on "text" tracks. */
  title?: TitleCard;
  keyframes?: KeyframeTrack[];
  /** audio */
  fadeInFrames?: number;
  fadeOutFrames?: number;
  audioGainDb?: number;
}

export interface Track {
  id: string;
  kind: "video" | "audio" | "text" | "effects" | "overlay";
  name?: string;
  locked?: boolean;
  muted?: boolean;
  solo?: boolean;
  hidden?: boolean;
  /** audio tracks */
  gainDb?: number;
  /** -1..1, audio tracks */
  pan?: number;
  /** ordered by startFrame */
  clips: Clip[];
}

export interface AudioMaster {
  gainDb: number;
  ducking?: {
    musicTrackId: string;
    voiceTrackId: string;
    amountDb: number;
    attackMs: number;
    releaseMs: number;
  };
}

export interface CaptionTrack {
  id: string;
  /** BCP-47 */
  lang: string;
  source: "auto" | "manual" | "translated";
  style: unknown;
  cues: { id: string; startFrame: number; endFrame: number; text: string }[];
}

export interface VideoProject {
  stage: { width: number; height: number };
  /** Stage background color behind all clips (additive; default black). */
  background?: string;
  fps: Fps;
  /** computed extent of the timeline, in frames. */
  durationFrames: number;
  /** User-set duration floor (additive): the timeline never reports shorter
   *  than this, so trailing space can hold black/audio after the last clip. */
  minDurationFrames?: number;
  tracks: Track[];
  master: AudioMaster;
  /** Subtitle tracks (additive; older projects simply omit it). */
  captions?: CaptionTrack[];
  /** Ruler markers, in timeline frames (additive). */
  markers?: number[];
  /** Export/preview range (in/out marks), in timeline frames (additive). */
  range?: { startFrame: number; endFrame: number };
}

// ---------------------------------------------------------------------------
// id generation
// ---------------------------------------------------------------------------

let __idCounter = 0;
/**
 * Deterministic-enough unique id for new structures. Not cryptographic; the
 * timeline only needs uniqueness within a project document.
 */
export function genId(prefix = "id"): string {
  __idCounter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${__idCounter.toString(36)}${rand}`;
}

// ---------------------------------------------------------------------------
// constructors
// ---------------------------------------------------------------------------

export interface NewProjectOpts {
  stage?: { width: number; height: number };
  fps?: Fps;
  tracks?: Track[];
  master?: AudioMaster;
  durationFrames?: number;
}

/** Construct a fresh, empty video project with sane defaults. */
export function newProject(opts: NewProjectOpts = {}): VideoProject {
  const tracks = opts.tracks ?? [];
  const project: VideoProject = {
    stage: opts.stage ?? { width: 1920, height: 1080 },
    fps: opts.fps ?? 30,
    durationFrames: 0,
    tracks,
    master: opts.master ?? { gainDb: 0 },
  };
  project.durationFrames = opts.durationFrames ?? projectDurationFrames(project);
  return project;
}

/** Construct a fresh empty track of the given kind. */
export function newTrack(kind: Track["kind"], name?: string): Track {
  const track: Track = { id: genId("track"), kind, clips: [] };
  if (name !== undefined) track.name = name;
  return track;
}

// ---------------------------------------------------------------------------
// duration helpers
// ---------------------------------------------------------------------------

/**
 * Number of source frames covered by a clip's in/out window. Always >= 0.
 * Independent of speed.
 */
export function clipSourceSpan(clip: Clip): number {
  return Math.max(0, clip.outFrame - clip.inFrame);
}

/**
 * Number of TIMELINE frames a clip occupies. The source window
 * (outFrame - inFrame) is stretched/compressed by |speed|. Always >= 1 for a
 * non-empty source window.
 */
export function clipDurationFrames(clip: Clip): number {
  const span = clipSourceSpan(clip);
  if (span <= 0) return 0;
  return Math.max(1, Math.ceil(span / Math.abs(clip.speed)));
}

/** The exclusive end frame of a clip on its track: startFrame + duration. */
export function clipEndFrame(clip: Clip): number {
  return clip.startFrame + clipDurationFrames(clip);
}

/** The largest clipEndFrame on the track, i.e. the track's used extent. */
export function trackDurationFrames(track: Track): number {
  let end = 0;
  for (const clip of track.clips) {
    const e = clipEndFrame(clip);
    if (e > end) end = e;
  }
  return end;
}

/** The largest track extent across the whole project. */
export function projectDurationFrames(project: VideoProject): number {
  let end = 0;
  for (const track of project.tracks) {
    const e = trackDurationFrames(track);
    if (e > end) end = e;
  }
  return end;
}

/** True if two clips overlap on a track (half-open [start, end) ranges). */
export function clipsOverlap(a: Clip, b: Clip): boolean {
  const aStart = a.startFrame;
  const aEnd = clipEndFrame(a);
  const bStart = b.startFrame;
  const bEnd = clipEndFrame(b);
  return aStart < bEnd && bStart < aEnd;
}

/**
 * The clip occupying a given timeline frame on a track, or null. Uses half-open
 * ranges: a clip covers [startFrame, clipEndFrame). If clips overlap, the first
 * matching clip in track order is returned.
 */
export function clipAtFrame(track: Track, frame: number): Clip | null {
  for (const clip of track.clips) {
    if (frame >= clip.startFrame && frame < clipEndFrame(clip)) return clip;
  }
  return null;
}

/** Find a clip by id within a track. */
export function findClip(track: Track, clipId: string): Clip | null {
  return track.clips.find((c) => c.id === clipId) ?? null;
}

/** Return a track's clips sorted by startFrame (stable). */
export function sortClips(clips: Clip[]): Clip[] {
  return [...clips].sort((a, b) => a.startFrame - b.startFrame);
}
