// @hc/timeline - source-time mapping and frame-rate conversion.
// All math is integer-frame; speed/reverse are honored exactly.

import type { Clip, Fps } from "./model";
import { clipDurationFrames } from "./model";

/**
 * Map a TIMELINE frame to the SOURCE frame it should read from, honoring speed
 * and reverse. Returns null if `timelineFrame` is outside the clip's on-timeline
 * window [startFrame, startFrame + duration).
 *
 * Forward (speed > 0): source = inFrame + round(localFrame * speed).
 * Reverse (speed < 0): source counts down from the out-point, so the first
 *   on-timeline frame reads the last source frame.
 *
 * The result is clamped into [inFrame, outFrame - 1] so it always references a
 * real source frame within the clip window.
 */
export function sourceFrameAt(clip: Clip, timelineFrame: number): number | null {
  const duration = clipDurationFrames(clip);
  if (duration <= 0) return null;
  const local = timelineFrame - clip.startFrame;
  if (local < 0 || local >= duration) return null;

  const speedMag = Math.abs(clip.speed);
  const lastSource = clip.outFrame - 1; // inclusive last source frame
  if (clip.speed < 0) {
    // Reverse: local 0 -> lastSource, increasing local walks back toward inFrame.
    const src = lastSource - Math.round(local * speedMag);
    return clamp(src, clip.inFrame, lastSource);
  }
  const src = clip.inFrame + Math.round(local * speedMag);
  return clamp(src, clip.inFrame, lastSource);
}

function clamp(v: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Convert a frame index from one frame rate to another, rounding to the nearest
 * integer frame. Used to conform clips authored at a different source fps to the
 * project fps. Frame 0 always maps to frame 0.
 */
export function remapFps(frame: number, fromFps: Fps | number, toFps: Fps | number): number {
  if (fromFps === toFps) return frame;
  return Math.round((frame * toFps) / fromFps);
}
