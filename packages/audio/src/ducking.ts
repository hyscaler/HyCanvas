// @hc/audio - sidechain ducking solver. Pure and deterministic.
//
// Given the master ducking config and the windows where the voice track is
// active, produce a music-track gain automation curve: 0 dB at rest, ramping
// DOWN to `amountDb` while voice is active (attack), and ramping back UP to 0 dB
// after voice stops (release). attack/release are given in ms and converted to
// frames at the project fps. Output is a list of {frame, musicGainDb} automation
// points, sorted and de-duplicated, suitable for keyframe interpolation.

import type { AudioMaster, Fps } from "@hc/timeline";

export interface VoiceWindow {
  startFrame: number;
  endFrame: number;
}

export interface DuckingPoint {
  frame: number;
  musicGainDb: number;
}

/** Convert a duration in milliseconds to whole frames at the given fps. */
export function msToFrames(ms: number, fps: Fps | number): number {
  return Math.max(0, Math.round((ms / 1000) * fps));
}

/**
 * Derive voice-activity windows from caption/cue ranges. Overlapping or touching
 * cues are merged into contiguous windows. Cues need not be sorted.
 */
export function voiceActivityFromCues(
  cues: { startFrame: number; endFrame: number }[],
): VoiceWindow[] {
  const sorted = cues
    .filter((c) => c.endFrame > c.startFrame)
    .map((c) => ({ startFrame: c.startFrame, endFrame: c.endFrame }))
    .sort((a, b) => a.startFrame - b.startFrame);
  const merged: VoiceWindow[] = [];
  for (const c of sorted) {
    const last = merged[merged.length - 1];
    if (last && c.startFrame <= last.endFrame) {
      last.endFrame = Math.max(last.endFrame, c.endFrame);
    } else {
      merged.push({ ...c });
    }
  }
  return merged;
}

/**
 * Solve the ducking automation curve.
 *
 * For each voice window the curve attacks from the current rest level (0 dB) down
 * to `amountDb`, holds at `amountDb` for the duration of the window, then
 * releases back to 0 dB. Attack begins at the window start; release begins at the
 * window end. Adjacent windows that are closer than the release time keep the
 * music ducked between them (the release is interrupted by the next attack).
 *
 * Returns automation points (frame, musicGainDb). If there is no ducking config
 * or no voice activity, a single flat point at frame 0 (0 dB) is returned so the
 * caller always has a defined curve.
 */
export function solveDucking(
  master: AudioMaster,
  voiceActivity: VoiceWindow[],
  totalFrames: number,
  fps: Fps | number,
): DuckingPoint[] {
  const duck = master.ducking;
  if (!duck || voiceActivity.length === 0) {
    return [{ frame: 0, musicGainDb: 0 }];
  }

  const windows = mergeWindows(voiceActivity);
  const attack = msToFrames(duck.attackMs, fps);
  const release = msToFrames(duck.releaseMs, fps);
  const amount = duck.amountDb; // typically negative (a cut)

  const points: DuckingPoint[] = [];
  const push = (frame: number, db: number) => {
    const f = clampFrame(frame, totalFrames);
    points.push({ frame: f, musicGainDb: db });
  };

  // Always anchor the rest level at frame 0.
  push(0, 0);

  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    const prev = windows[i - 1];

    // Attack: ramp 0 -> amount over [start, start+attack], unless we are still
    // ducked from the previous window's (not yet completed) release.
    const restoredByPrev = prev ? prev.endFrame + release : -Infinity;
    const stillDucked = prev !== undefined && w.startFrame < restoredByPrev;

    if (!stillDucked) {
      push(w.startFrame, 0);
      push(w.startFrame + attack, amount);
    } else {
      // Re-attack from wherever the release had reached; for determinism we just
      // re-assert full duck at the new window start.
      push(w.startFrame, amount);
    }

    // Hold at full duck until the window ends.
    push(w.endFrame, amount);

    // Release: ramp amount -> 0 over [end, end+release], but only if the next
    // window does not interrupt it.
    const next = windows[i + 1];
    const releaseEnd = w.endFrame + release;
    const interrupted = next !== undefined && next.startFrame < releaseEnd;
    if (!interrupted) {
      push(releaseEnd, 0);
    }
  }

  return dedupeSorted(points);
}

function mergeWindows(windows: VoiceWindow[]): VoiceWindow[] {
  const sorted = windows
    .filter((w) => w.endFrame > w.startFrame)
    .map((w) => ({ ...w }))
    .sort((a, b) => a.startFrame - b.startFrame);
  const merged: VoiceWindow[] = [];
  for (const w of sorted) {
    const last = merged[merged.length - 1];
    if (last && w.startFrame <= last.endFrame) {
      last.endFrame = Math.max(last.endFrame, w.endFrame);
    } else {
      merged.push({ ...w });
    }
  }
  return merged;
}

function clampFrame(frame: number, totalFrames: number): number {
  let f = Math.round(frame);
  if (f < 0) f = 0;
  if (totalFrames > 0 && f > totalFrames) f = totalFrames;
  return f;
}

/** Sort by frame and drop points that duplicate the previous frame+value. */
function dedupeSorted(points: DuckingPoint[]): DuckingPoint[] {
  const sorted = [...points].sort((a, b) => a.frame - b.frame);
  const out: DuckingPoint[] = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (last && last.frame === p.frame) {
      // Same frame: keep the more-ducked (lower dB) value so holds win over rest.
      last.musicGainDb = Math.min(last.musicGainDb, p.musicGainDb);
      continue;
    }
    if (last && last.musicGainDb === p.musicGainDb && last.frame === p.frame) continue;
    out.push({ ...p });
  }
  return out;
}
