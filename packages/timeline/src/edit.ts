// @hc/timeline - pure clip edit operations.
//
// Every function returns a NEW Track/Clip and never mutates its input. Tracks
// keep their clips sorted by startFrame after an edit. All math is integer-frame.

import type { Clip, Track } from "./model";
import { clipDurationFrames, clipEndFrame, genId, sortClips } from "./model";

function cloneClip(clip: Clip): Clip {
  return { ...clip };
}

function withClips(track: Track, clips: Clip[]): Track {
  return { ...track, clips: sortClips(clips) };
}

function replaceClip(track: Track, clipId: string, next: Clip | null, extra: Clip[] = []): Track {
  const clips: Clip[] = [];
  for (const c of track.clips) {
    if (c.id === clipId) {
      if (next) clips.push(next);
      clips.push(...extra);
    } else {
      clips.push(c);
    }
  }
  return withClips(track, clips);
}

/**
 * Trim one edge of a clip by `deltaFrames` (positive grows the source window in
 * the direction of the edge, negative shrinks it). Trimming the "in" edge also
 * moves the clip's startFrame so the body stays put on the timeline. The source
 * window is clamped so that:
 *   - the window stays within [0, +inf) on the in side,
 *   - the resulting source span is >= 1 frame,
 *   - startFrame never goes negative.
 *
 * Semantics (timeline-editor convention):
 *   edge "in",  +delta  -> trim later: inFrame += delta, startFrame += delta.
 *   edge "in",  -delta  -> extend earlier: inFrame -= |delta|, startFrame -= |delta|.
 *   edge "out", +delta  -> extend later: outFrame += delta.
 *   edge "out", -delta  -> trim earlier: outFrame -= |delta|.
 */
export function trim(
  track: Track,
  clipId: string,
  edge: "in" | "out",
  deltaFrames: number,
): Track {
  const clip = track.clips.find((c) => c.id === clipId);
  if (!clip) return track;
  const next = cloneClip(clip);

  if (edge === "in") {
    // New in-point, clamped to >= 0 and to leave at least 1 source frame.
    let newIn = clip.inFrame + deltaFrames;
    if (newIn < 0) newIn = 0;
    if (newIn > clip.outFrame - 1) newIn = clip.outFrame - 1;
    const applied = newIn - clip.inFrame; // how far the in-point actually moved
    next.inFrame = newIn;
    let newStart = clip.startFrame + applied;
    if (newStart < 0) {
      // Cannot move start below 0; pull the in-point back to compensate.
      next.inFrame = Math.max(0, newIn - newStart);
      newStart = 0;
      if (next.inFrame > next.outFrame - 1) next.inFrame = next.outFrame - 1;
    }
    next.startFrame = newStart;
  } else {
    let newOut = clip.outFrame + deltaFrames;
    if (newOut < clip.inFrame + 1) newOut = clip.inFrame + 1;
    next.outFrame = newOut;
  }

  return replaceClip(track, clipId, next);
}

/**
 * Split a clip at a TIMELINE frame into two abutting clips. The left piece keeps
 * the original id and occupies [startFrame, atFrame); the right piece gets a new
 * id and starts exactly at `atFrame`, so the two pieces tile the original span
 * with no gap or overlap. Source in/out points are split at the source frame
 * that the cut maps to, honoring speed.
 *
 * Returns the track unchanged if the clip is missing or the cut is not strictly
 * inside the clip body.
 */
export function splitClip(track: Track, clipId: string, atFrame: number): Track {
  const clip = track.clips.find((c) => c.id === clipId);
  if (!clip) return track;

  const start = clip.startFrame;
  const end = clipEndFrame(clip);
  if (atFrame <= start || atFrame >= end) return track; // must be strictly inside

  const local = atFrame - start;
  const speedMag = Math.abs(clip.speed);

  if (clip.speed < 0) {
    // Reverse: source walks down from outFrame. The cut source point separates
    // the upper (first-played) and lower (later-played) halves of the window.
    const splitSrc = clip.outFrame - Math.round(local * speedMag);
    const clampedSrc = Math.min(clip.outFrame - 1, Math.max(clip.inFrame + 1, splitSrc));
    const left: Clip = { ...cloneClip(clip), inFrame: clampedSrc, outFrame: clip.outFrame };
    const right: Clip = {
      ...cloneClip(clip),
      id: genId("clip"),
      inFrame: clip.inFrame,
      outFrame: clampedSrc,
      startFrame: atFrame,
    };
    return replaceClip(track, clipId, left, [right]);
  }

  const splitSrc = clip.inFrame + Math.round(local * speedMag);
  const clampedSrc = Math.min(clip.outFrame - 1, Math.max(clip.inFrame + 1, splitSrc));
  const left: Clip = { ...cloneClip(clip), inFrame: clip.inFrame, outFrame: clampedSrc };
  const right: Clip = {
    ...cloneClip(clip),
    id: genId("clip"),
    inFrame: clampedSrc,
    outFrame: clip.outFrame,
    startFrame: atFrame,
  };
  return replaceClip(track, clipId, left, [right]);
}

/**
 * Remove a clip and shift every later clip on the same track LEFT by the removed
 * clip's timeline duration, closing the gap. Clips that start before the removed
 * clip are left untouched.
 */
export function rippleDelete(track: Track, clipId: string): Track {
  const clip = track.clips.find((c) => c.id === clipId);
  if (!clip) return track;
  const removedDuration = clipDurationFrames(clip);
  const removedStart = clip.startFrame;

  const clips: Clip[] = [];
  for (const c of track.clips) {
    if (c.id === clipId) continue;
    if (c.startFrame >= removedStart) {
      clips.push({ ...c, startFrame: Math.max(0, c.startFrame - removedDuration) });
    } else {
      clips.push(c);
    }
  }
  return withClips(track, clips);
}

/** Reposition a clip to a new start frame, clamped to >= 0. */
export function moveClip(track: Track, clipId: string, toStartFrame: number): Track {
  const clip = track.clips.find((c) => c.id === clipId);
  if (!clip) return track;
  const next = { ...cloneClip(clip), startFrame: Math.max(0, Math.floor(toStartFrame)) };
  return replaceClip(track, clipId, next);
}

/**
 * Change a clip's playback speed. Valid magnitudes are 0.1..100; negative values
 * mean reverse. The value is clamped into range (preserving sign) and 0 is
 * coerced to 1. Nothing else is recomputed: the timeline duration derives from
 * speed via clipDurationFrames.
 */
export function setSpeed(clip: Clip, speed: number): Clip {
  let s = speed;
  if (s === 0 || Number.isNaN(s)) s = 1;
  const sign = s < 0 ? -1 : 1;
  const mag = Math.min(100, Math.max(0.1, Math.abs(s)));
  return { ...cloneClip(clip), speed: sign * mag };
}

/** True if the clip plays its source backward. */
export function isReversed(clip: Clip): boolean {
  return clip.speed < 0;
}
