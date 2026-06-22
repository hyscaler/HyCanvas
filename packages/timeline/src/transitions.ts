// @hc/timeline - clip-to-clip transitions.
// A transition occupies an overlap region between adjacent clips; its duration
// can never exceed the clip it attaches to.

import type { Clip, ClipTransition, Track } from "./model";
import { clipDurationFrames, clipEndFrame, sortClips } from "./model";

/**
 * Clamp a transition's duration so it cannot exceed the clip's timeline length
 * (and is at least 1 frame). Returns a new ClipTransition.
 */
export function clampTransition(t: ClipTransition, clip: Clip): ClipTransition {
  const max = Math.max(1, clipDurationFrames(clip));
  const duration = Math.min(max, Math.max(1, Math.floor(t.durationFrames)));
  return { ...t, durationFrames: duration };
}

/**
 * Attach a transition to the "in" or "out" edge of a clip. The transition is
 * clamped to the clip length. Pure: returns a new Track.
 */
export function addTransition(
  track: Track,
  clipId: string,
  edge: "in" | "out",
  t: ClipTransition,
): Track {
  const clips = track.clips.map((c) => {
    if (c.id !== clipId) return c;
    const clamped = clampTransition(t, c);
    return edge === "in"
      ? { ...c, transitionIn: clamped }
      : { ...c, transitionOut: clamped };
  });
  return { ...track, clips: sortClips(clips) };
}

/**
 * Given two clips that are adjacent on a track (a before b in time), return the
 * frame range [start, end) on the timeline where a cross-clip transition between
 * them overlaps. The overlap is the shorter of a.transitionOut / b.transitionIn,
 * bounded by the actual gap or overlap between the clips.
 *
 * Returns null if no transition is configured on the touching edges or if the
 * clips are not arranged a-then-b.
 */
export function transitionOverlapRegion(
  a: Clip,
  b: Clip,
): { startFrame: number; endFrame: number } | null {
  const aEnd = clipEndFrame(a);
  const bStart = b.startFrame;
  // a must end at or after b begins to share a boundary region; require a before b.
  if (a.startFrame > b.startFrame) return null;

  const outDur = a.transitionOut?.durationFrames ?? 0;
  const inDur = b.transitionIn?.durationFrames ?? 0;
  const requested = Math.max(outDur, inDur);
  if (requested <= 0) return null;

  // The transition is centered on the cut at aEnd / bStart. When clips abut
  // (aEnd === bStart) the overlap is [cut - requested, cut). When b already
  // overlaps a, clamp to the existing overlap.
  const cut = Math.min(aEnd, Math.max(bStart, aEnd));
  let start = cut - requested;
  let end = cut;

  // Do not extend before a's start or after b's end.
  if (start < a.startFrame) start = a.startFrame;
  if (end > clipEndFrame(b)) end = clipEndFrame(b);
  if (end <= start) return null;
  return { startFrame: start, endFrame: end };
}
