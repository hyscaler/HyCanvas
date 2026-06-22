// @hc/timeline - beat snapping.
// Cuts, clip edges, and markers snap to a precomputed beat grid (integer frames).

/**
 * Snap a frame to the nearest beat marker within `toleranceFrames`. If no beat
 * is within tolerance, the original frame is returned unchanged. `beatsFrames`
 * need not be sorted. A tolerance of 0 snaps only when the frame is exactly on a
 * beat.
 */
export function snapFrameToBeats(
  frame: number,
  beatsFrames: number[],
  toleranceFrames: number,
): number {
  if (beatsFrames.length === 0) return frame;
  const tol = Math.max(0, toleranceFrames);
  let best = frame;
  let bestDist = Infinity;
  for (const beat of beatsFrames) {
    const dist = Math.abs(beat - frame);
    if (dist <= tol && dist < bestDist) {
      bestDist = dist;
      best = beat;
    }
  }
  return best;
}
