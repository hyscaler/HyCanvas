// Client-side scene-cut detection: sample the video at a coarse rate into a
// tiny luma buffer and flag frames whose mean absolute difference from the
// previous sample spikes. No AI, no server; good enough to propose split
// points which the user can always undo.

import { CodedError } from "../errors";

const SAMPLE_W = 64;
const SAMPLE_H = 36;

export interface SceneDetectOptions {
  /** Samples per second of source time (default 4). */
  sampleFps?: number;
  /** Normalized luma-difference threshold 0..1 that marks a cut (default 0.16). */
  threshold?: number;
  /** Minimum seconds between cuts (default 0.5). */
  minGapS?: number;
}

/** Detect cut points; resolves to seconds into the source. */
export async function detectSceneSeconds(url: string, opts: SceneDetectOptions = {}): Promise<number[]> {
  const sampleFps = opts.sampleFps ?? 4;
  const threshold = opts.threshold ?? 0.16;
  const minGapS = opts.minGapS ?? 0.5;

  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.preload = "auto";
  video.muted = true;
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new CodedError("errors.video_load_failed", "video load failed"));
    video.src = url;
  });
  const dur = video.duration;
  if (!Number.isFinite(dur) || dur <= 0) return [];

  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE_W;
  canvas.height = SAMPLE_H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [];

  const cuts: number[] = [];
  let prev: Uint8ClampedArray | null = null;
  let lastCut = -minGapS;
  const step = 1 / sampleFps;
  // Seek with a timeout fallback: seeking to the CURRENT position fires no
  // `seeked` event, and an occasional missed event must not hang detection.
  const seekTo = (t: number) =>
    new Promise<void>((resolve) => {
      const target = Math.min(dur - 0.001, Math.max(0.001, t));
      if (Math.abs(video.currentTime - target) < 0.0005 && video.readyState >= 2) {
        resolve();
        return;
      }
      let timer = 0;
      const done = () => {
        video.removeEventListener("seeked", done);
        window.clearTimeout(timer);
        resolve();
      };
      timer = window.setTimeout(done, 1500);
      video.addEventListener("seeked", done);
      video.currentTime = target;
    });
  for (let t = 0; t < dur; t += step) {
    await seekTo(t);
    ctx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);
    const data = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
    const luma = new Uint8ClampedArray(SAMPLE_W * SAMPLE_H);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      luma[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    }
    if (prev) {
      let sum = 0;
      for (let j = 0; j < luma.length; j++) sum += Math.abs(luma[j] - prev[j]);
      const diff = sum / (luma.length * 255);
      if (diff > threshold && t - lastCut >= minGapS) {
        cuts.push(t);
        lastCut = t;
      }
    }
    prev = luma;
  }
  video.src = "";
  return cuts;
}
