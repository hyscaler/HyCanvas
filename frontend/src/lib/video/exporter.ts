// In-browser timeline export: record the preview compositor's canvas plus the
import { CodedError } from "../errors";
// WebAudio mix in real time via MediaRecorder. MP4 where the browser can mux
// it, WebM (VP9/VP8) everywhere else. A realtime pass is the honest tradeoff
// for a dependency-free exporter: a 60s video takes 60s to render.

export interface RecorderTarget {
  mimeType: string;
  extension: "mp4" | "webm";
}

/** The best MediaRecorder container/codec this browser supports.
 *  preferWebm reorders the candidates so WebM wins when available. */
export function pickRecorderTarget(preferWebm = false): RecorderTarget | null {
  if (typeof MediaRecorder === "undefined") return null;
  const mp4: RecorderTarget[] = [
    { mimeType: "video/mp4;codecs=avc1,mp4a.40.2", extension: "mp4" },
    { mimeType: "video/mp4", extension: "mp4" },
  ];
  const webm: RecorderTarget[] = [
    { mimeType: "video/webm;codecs=vp9,opus", extension: "webm" },
    { mimeType: "video/webm;codecs=vp8,opus", extension: "webm" },
    { mimeType: "video/webm", extension: "webm" },
  ];
  const candidates = preferWebm ? [...webm, ...mp4] : [...mp4, ...webm];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c.mimeType)) ?? null;
}

export interface ExportController {
  /** Resolves with the finished file when stop() is called (or on error). */
  done: Promise<Blob>;
  stop: () => void;
}

/**
 * Start recording a canvas + audio mix. The caller drives playback from frame
 * 0 and calls stop() when the playhead passes the end.
 */
export function startRecording(
  canvas: HTMLCanvasElement,
  audio: MediaStream | null,
  fps: number,
  target: RecorderTarget,
): ExportController {
  const stream = canvas.captureStream(fps);
  if (audio) for (const t of audio.getAudioTracks()) stream.addTrack(t);
  const recorder = new MediaRecorder(stream, {
    mimeType: target.mimeType,
    videoBitsPerSecond: 12_000_000,
    audioBitsPerSecond: 192_000,
  });
  const chunks: BlobPart[] = [];
  const done = new Promise<Blob>((resolve, reject) => {
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => resolve(new Blob(chunks, { type: target.mimeType.split(";")[0] }));
    recorder.onerror = () => reject(new CodedError("errors.recording_failed", "Recording failed."));
  });
  recorder.start(1000);
  return {
    done,
    stop: () => {
      if (recorder.state !== "inactive") recorder.stop();
      for (const t of stream.getTracks()) t.stop();
    },
  };
}

/** Trigger a browser download for a rendered file. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
