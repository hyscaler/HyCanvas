// Beat / onset detection (P7.3) for the video editor's beat-sync: a pure,
// dependency-free energy-flux onset detector over decoded PCM. Given mono
// samples it returns onset times (seconds), which the editor turns into ruler
// markers and a snap grid (snapFrameToBeats). Deliberately simple and
// deterministic so it is unit-testable and matches everywhere.

export interface BeatOptions {
  /** Analysis hop in samples (window = 2*hop). Default 1024. */
  hop?: number;
  /** Onset when the frame energy exceeds this multiple of the local average. */
  threshold?: number;
  /** Minimum seconds between onsets (debounce). Default 0.18s (~330 BPM cap). */
  minGapSec?: number;
}

/** Detect onset times (seconds) in mono PCM `samples` at `sampleRate`. */
export function detectBeatTimes(samples: Float32Array, sampleRate: number, opts: BeatOptions = {}): number[] {
  const hop = Math.max(64, Math.floor(opts.hop ?? 1024));
  const win = hop * 2;
  const threshold = opts.threshold ?? 1.5;
  const minGap = opts.minGapSec ?? 0.18;
  if (samples.length < win || sampleRate <= 0) return [];

  // Per-frame energy (mean square over the window).
  const frames = Math.floor((samples.length - win) / hop) + 1;
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const start = f * hop;
    let sum = 0;
    for (let i = 0; i < win; i++) {
      const v = samples[start + i];
      sum += v * v;
    }
    energy[f] = sum / win;
  }

  // Local-average window (~0.4s) for the adaptive threshold.
  const avgFrames = Math.max(2, Math.round((0.4 * sampleRate) / hop));
  const minGapFrames = Math.max(1, Math.round((minGap * sampleRate) / hop));
  const times: number[] = [];
  let lastOnset = -Infinity;
  for (let f = 1; f < frames - 1; f++) {
    // Local average of the preceding frames (baseline).
    let acc = 0;
    let n = 0;
    for (let k = Math.max(0, f - avgFrames); k < f; k++) {
      acc += energy[k];
      n++;
    }
    const local = n ? acc / n : 0;
    const isPeak = energy[f] >= energy[f - 1] && energy[f] > energy[f + 1];
    if (isPeak && energy[f] > threshold * local && energy[f] > 1e-6 && f - lastOnset >= minGapFrames) {
      times.push((f * hop) / sampleRate);
      lastOnset = f;
    }
  }
  return times;
}

/** Convert onset times (seconds) to integer timeline frames at `fps`. */
export function beatTimesToFrames(times: number[], fps: number): number[] {
  return times.map((t) => Math.round(t * fps));
}
