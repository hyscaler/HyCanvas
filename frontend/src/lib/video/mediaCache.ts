// Media probing + analysis cache for the video editor. One entry per asset
// URL: metadata (duration/dimensions), a filmstrip thumbnail strip for video
// clips, and min/max peak buckets for audio waveforms. Everything is cached by
// promise so concurrent callers share one probe, and failures are cached too
// (a broken asset should not re-probe on every render).

export interface MediaInfo {
  durationMs: number;
  width?: number;
  height?: number;
}

const infoCache = new Map<string, Promise<MediaInfo>>();
const filmstripCache = new Map<string, Promise<string>>();
const peaksCache = new Map<string, Promise<number[]>>();

/** Probe duration (and dimensions for video) from media metadata. */
export function probeMedia(url: string, kind: "video" | "audio"): Promise<MediaInfo> {
  let p = infoCache.get(url);
  if (!p) {
    p = new Promise<MediaInfo>((resolve, reject) => {
      const el = document.createElement(kind === "video" ? "video" : "audio") as HTMLVideoElement;
      el.crossOrigin = "anonymous";
      el.preload = "metadata";
      el.onloadedmetadata = () => {
        resolve({
          durationMs: Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : 0,
          width: kind === "video" ? el.videoWidth : undefined,
          height: kind === "video" ? el.videoHeight : undefined,
        });
        el.src = "";
      };
      el.onerror = () => reject(new Error("Could not read media metadata."));
      el.src = url;
    });
    infoCache.set(url, p);
  }
  return p;
}

/**
 * Render a horizontal filmstrip of poster frames (dataURL) for a video asset.
 * Sequential seeks on a throwaway element; tiles are drawn cover-fit.
 */
export function filmstrip(url: string, tiles = 6, tileW = 96, tileH = 48): Promise<string> {
  const key = `${url}#${tiles}x${tileW}x${tileH}`;
  let p = filmstripCache.get(key);
  if (!p) {
    p = (async () => {
      const video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.preload = "auto";
      video.muted = true;
      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error("video load failed"));
        video.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = tiles * tileW;
      canvas.height = tileH;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      const dur = Math.max(0.001, video.duration);
      for (let i = 0; i < tiles; i++) {
        // Sample tile centers, avoiding the exact first/last frame (often black).
        const t = dur * ((i + 0.5) / tiles);
        await new Promise<void>((resolve, reject) => {
          video.onseeked = () => resolve();
          video.onerror = () => reject(new Error("seek failed"));
          video.currentTime = Math.min(dur - 0.001, t);
        });
        const sw = video.videoWidth || 1;
        const sh = video.videoHeight || 1;
        // Cover-fit the tile.
        const scale = Math.max(tileW / sw, tileH / sh);
        const dw = sw * scale;
        const dh = sh * scale;
        ctx.drawImage(video, i * tileW + (tileW - dw) / 2, (tileH - dh) / 2, dw, dh);
      }
      video.src = "";
      return canvas.toDataURL("image/jpeg", 0.6);
    })();
    filmstripCache.set(key, p);
  }
  return p;
}

const decodeCache = new Map<string, Promise<{ samples: Float32Array; sampleRate: number }>>();

/** Decode an audio (or video soundtrack) file to mono PCM once, cached by URL.
 *  Used by beat detection (P7.3). Uses OfflineAudioContext (no user gesture). */
export function decodeMono(url: string): Promise<{ samples: Float32Array; sampleRate: number }> {
  let p = decodeCache.get(url);
  if (!p) {
    p = (async () => {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`audio fetch failed (${res.status})`);
      const raw = await res.arrayBuffer();
      const ctx = new OfflineAudioContext(1, 1, 44100);
      const buf = await ctx.decodeAudioData(raw);
      // Down-mix to mono (average channels) so detection is channel-agnostic.
      const ch = buf.numberOfChannels;
      const out = new Float32Array(buf.length);
      for (let c = 0; c < ch; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < d.length; i++) out[i] += d[i] / ch;
      }
      return { samples: out, sampleRate: buf.sampleRate };
    })();
    decodeCache.set(url, p);
  }
  return p;
}

/**
 * Extract normalized waveform peaks (0..1 max-abs per bucket) for an audio (or
 * video soundtrack) asset. Decodes the whole file once via WebAudio.
 */
export function peaks(url: string, buckets = 200): Promise<number[]> {
  const key = `${url}#${buckets}`;
  let p = peaksCache.get(key);
  if (!p) {
    p = (async () => {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`audio fetch failed (${res.status})`);
      const raw = await res.arrayBuffer();
      // OfflineAudioContext decodes without needing a user gesture.
      const ctx = new OfflineAudioContext(1, 1, 44100);
      const buf = await ctx.decodeAudioData(raw);
      const data = buf.getChannelData(0);
      const out = new Array<number>(buckets).fill(0);
      const per = Math.max(1, Math.floor(data.length / buckets));
      for (let b = 0; b < buckets; b++) {
        let max = 0;
        const start = b * per;
        const end = Math.min(data.length, start + per);
        for (let i = start; i < end; i += 32) {
          const v = Math.abs(data[i]);
          if (v > max) max = v;
        }
        out[b] = max;
      }
      // Normalize so quiet recordings still read visually.
      const top = Math.max(0.01, ...out);
      return out.map((v) => v / top);
    })();
    peaksCache.set(key, p);
  }
  return p;
}

/** Draw peak buckets into a small dataURL strip (chrome visualization). */
export async function waveformDataUrl(url: string, width = 240, height = 40): Promise<string> {
  const pk = await peaks(url, Math.max(32, Math.floor(width / 2)));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  const per = width / pk.length;
  for (let i = 0; i < pk.length; i++) {
    const h = Math.max(1, pk[i] * (height - 4));
    ctx.fillRect(i * per, (height - h) / 2, Math.max(1, per - 1), h);
  }
  return canvas.toDataURL("image/png");
}
