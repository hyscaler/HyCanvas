// @hc/audio - per-clip fade envelope.
// Pure math: no DSP, no decoding. Returns a linear gain multiplier in [0,1].

import type { Clip } from "@hc/timeline";

/**
 * Linear fade gain at a position WITHIN a clip, expressed in clip-local frames
 * [0, clipDurationFrames). A fade-in ramps 0 -> 1 over `fadeInFrames`; a fade-out
 * ramps 1 -> 0 over the last `fadeOutFrames`. With no fades configured the gain
 * is 1 everywhere inside the clip. Outside [0, duration) the gain is 0.
 *
 * If fade-in and fade-out regions overlap (very short clip), the lower of the two
 * ramps wins so the envelope never exceeds either ramp.
 */
export function gainAtFrame(clip: Clip, localFrame: number, clipDurationFrames: number): number {
  if (clipDurationFrames <= 0) return 0;
  if (localFrame < 0 || localFrame >= clipDurationFrames) return 0;

  const fadeIn = Math.max(0, Math.floor(clip.fadeInFrames ?? 0));
  const fadeOut = Math.max(0, Math.floor(clip.fadeOutFrames ?? 0));

  let g = 1;

  if (fadeIn > 0 && localFrame < fadeIn) {
    // ramp 0..1 across [0, fadeIn]; reaches 1 exactly at localFrame === fadeIn.
    g = Math.min(g, localFrame / fadeIn);
  }

  if (fadeOut > 0) {
    // frames remaining until the end; full at the very last frame is 0.
    const fromEnd = clipDurationFrames - 1 - localFrame; // 0 at last frame
    if (fromEnd < fadeOut) {
      g = Math.min(g, fromEnd / fadeOut);
    }
  }

  return clamp01(g);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
