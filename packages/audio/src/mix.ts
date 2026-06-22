// @hc/audio - linear/decibel gain math and the per-clip mixing chain
//. Pure math only; no DSP, no decoding.

import type { AudioMaster, Clip, Track } from "@hc/timeline";

/** Convert decibels to a linear amplitude gain. 0 dB -> 1.0. */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/**
 * Convert a linear amplitude gain to decibels. A gain of 0 (or negative) maps to
 * -Infinity dB (silence). 1.0 -> 0 dB.
 */
export function gainToDb(gain: number): number {
  if (gain <= 0) return -Infinity;
  return 20 * Math.log10(gain);
}

/**
 * Multiply any number of linear gains together, clamped into [0, 1]. Used to
 * combine independent stages (clip x track x master x fade) into one factor.
 */
export function mixGains(...gains: number[]): number {
  let product = 1;
  for (const g of gains) product *= g;
  if (product < 0) product = 0;
  if (product > 1) product = 1;
  return product;
}

/** True if ANY track has solo enabled (and is not hidden). */
export function soloActive(tracks: Track[]): boolean {
  return tracks.some((t) => t.solo === true);
}

/**
 * Whether a track should be heard in the mix. A track is audible when it is not
 * muted, and when solo is active anywhere it must itself be soloed. Hidden tracks
 * (visual property) do not affect audibility on their own; only `muted`/`solo`
 * gate audio.
 */
export function isAudible(track: Track, tracks: Track[]): boolean {
  if (track.muted === true) return false;
  if (soloActive(tracks)) return track.solo === true;
  return true;
}

/**
 * Combine a clip's audio gain, its track gain, and the master gain into a single
 * linear gain factor, honoring mute/solo via {@link isAudible}. A muted (or
 * non-soloed while solo is active) track yields 0. Fades are applied separately
 * by {@link gainAtFrame} and can be folded in by the caller via {@link mixGains}.
 */
export function effectiveClipGain(
  clip: Clip,
  track: Track,
  master: AudioMaster,
  allTracks: Track[] = [track],
): number {
  if (!isAudible(track, allTracks)) return 0;
  const clipGain = dbToGain(clip.audioGainDb ?? 0);
  const trackGain = dbToGain(track.gainDb ?? 0);
  const masterGain = dbToGain(master.gainDb ?? 0);
  return mixGains(clipGain, trackGain, masterGain);
}
