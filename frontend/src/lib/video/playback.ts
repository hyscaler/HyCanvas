// TimelinePlayer: the DOM half of the preview engine. Owns one hidden media
// element per clip (two clips of the same asset need independent seek
// positions), keeps them seeked/playing in sync with the playhead, and routes
// their audio through a WebAudio graph (per-clip gain -> master -> speakers,
// plus a MediaStreamDestination tap so export can record the same mix). All
// of the "what should be seen/heard at frame f" math lives in compositor.ts;
// this class only applies it to elements.

import { type Clip, type VideoProject } from "@hc/timeline";
import {
  activeClipsAt,
  clipGainAt,
  type ActiveClip,
  type ActiveOptions,
  type DrawSource,
} from "./compositor";
import { ChromaKeyer } from "./chromaKey";

export interface ResolvedMedia {
  url: string;
  kind: "video" | "audio";
}

/** Seek tolerance before we snap a media element to the wanted time. */
const DRIFT_PLAYING_S = 0.12;
const DRIFT_PAUSED_S = 0.03;

export class TimelinePlayer {
  private els = new Map<string, HTMLVideoElement | HTMLAudioElement>();
  private keyer: ChromaKeyer | null = null;
  private gains = new Map<string, GainNode>();
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private streamDest: MediaStreamAudioDestinationNode | null = null;

  constructor(
    private resolveMedia: (assetId: string) => ResolvedMedia | null,
    private resolveSequence?: (id: string) => VideoProject | null,
  ) {}

  /** Compositor options matching this player's scope (sequences + xfades). */
  activeOptions(): ActiveOptions {
    return { resolveSequence: this.resolveSequence, xfade: true };
  }

  /** Lazily build the audio graph (must follow a user gesture to be audible). */
  private ensureAudio(): void {
    if (this.ctx) return;
    try {
      const ctx = new AudioContext();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.connect(ctx.destination);
      this.streamDest = ctx.createMediaStreamDestination();
      this.master.connect(this.streamDest);
    } catch {
      this.ctx = null; // no WebAudio: fall back to element.volume
    }
  }

  /** The recorded-mix audio stream for export (built on demand). */
  audioStream(): MediaStream | null {
    this.ensureAudio();
    return this.streamDest?.stream ?? null;
  }

  async resumeAudio(): Promise<void> {
    this.ensureAudio();
    if (this.ctx && this.ctx.state === "suspended") {
      try {
        await this.ctx.resume();
      } catch {
        /* stays suspended until the next gesture */
      }
    }
  }

  private elementFor(clip: Clip): HTMLVideoElement | HTMLAudioElement | null {
    const existing = this.els.get(clip.id);
    if (existing) return existing;
    if (!clip.assetId) return null;
    const media = this.resolveMedia(clip.assetId);
    if (!media) return null;
    const el = document.createElement(media.kind === "video" ? "video" : "audio") as HTMLVideoElement;
    // crossOrigin so drawing to the export canvas never taints it (the asset
    // route sends CORS headers for the app origin).
    el.crossOrigin = "anonymous";
    el.preload = "auto";
    el.src = media.url;
    // Audio routes through the graph; the element itself stays unmuted only
    // when WebAudio is unavailable (volume fallback).
    this.ensureAudio();
    if (this.ctx && this.master) {
      try {
        const src = this.ctx.createMediaElementSource(el);
        const gain = this.ctx.createGain();
        gain.gain.value = 0;
        src.connect(gain);
        gain.connect(this.master);
        this.gains.set(clip.id, gain);
      } catch {
        /* element keeps direct output */
      }
    }
    this.els.set(clip.id, el);
    return el;
  }

  /** Media kind for a clip, when it resolves. */
  kindOf(clip: Clip): "video" | "audio" | null {
    return clip.assetId ? this.resolveMedia(clip.assetId)?.kind ?? null : null;
  }

  /** The drawable source for an active video clip (null until decodable).
   *  Clips with a chromaKey render through the WebGL keyer first, so the
   *  compositor (and therefore the export) draws the keyed frame. */
  drawSource(active: ActiveClip): DrawSource | null {
    if (this.kindOf(active.clip) !== "video") return null;
    const el = this.elementFor(active.clip) as HTMLVideoElement | null;
    if (!el || el.readyState < 2) return null;
    const w = el.videoWidth || 1;
    const h = el.videoHeight || 1;
    const key = active.clip.chromaKey;
    if (key) {
      if (!this.keyer) this.keyer = new ChromaKeyer();
      const keyed = this.keyer.apply(el, w, h, key);
      if (keyed) return { el: keyed, width: w, height: h };
    }
    return { el, width: w, height: h };
  }

  /**
   * Align every media element with the playhead: seek/play/pause the active
   * clips, silence and pause the rest, and apply the per-clip mix gain.
   */
  syncAt(
    project: VideoProject,
    frame: number,
    playing: boolean,
    duckPoints?: { frame: number; musicGainDb: number }[],
  ): void {
    const active = activeClipsAt(project, frame, this.activeOptions());
    const activeIds = new Set<string>();
    for (const a of active) {
      const { clip, track } = a;
      if (!clip.assetId) continue;
      if (track.kind !== "video" && track.kind !== "audio" && track.kind !== "overlay") continue;
      const el = this.elementFor(clip);
      if (!el) continue;
      activeIds.add(clip.id);
      const fps = a.scopeFps || project.fps;
      const wantS = a.sourceFrame !== null ? a.sourceFrame / fps : null;
      const reversed = clip.speed < 0;
      // A hidden video track is a VISUAL toggle: its sound stays governed by
      // the mixer (mute/solo), not by visibility. Expanded sequence children
      // carry their absolute mix gain; an xfade tail is past its own span so
      // the fade envelope has already reached silence (gain 0 via localFrame).
      const gain = a.xfadeTail
        ? 0
        : a.mixGain ?? clipGainAt(project, track, clip, a.localFrame, duckPoints);
      this.applyGain(clip.id, el, reversed ? 0 : gain);
      if (wantS === null) {
        el.pause();
        continue;
      }
      if (playing && !reversed) {
        el.playbackRate = Math.min(16, Math.max(0.0625, Math.abs(clip.speed)));
        if (Math.abs(el.currentTime - wantS) > DRIFT_PLAYING_S) el.currentTime = wantS;
        if (el.paused) void el.play().catch(() => undefined);
      } else {
        // Paused, scrubbing, or reverse playback (elements cannot play
        // backwards: reverse renders by per-frame seeking, audio muted).
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - wantS) > DRIFT_PAUSED_S) el.currentTime = wantS;
      }
    }
    // Everything not under the playhead: pause + silence.
    for (const [clipId, el] of this.els) {
      if (activeIds.has(clipId)) continue;
      if (!el.paused) el.pause();
      this.applyGain(clipId, el, 0);
    }
  }

  private applyGain(clipId: string, el: HTMLVideoElement | HTMLAudioElement, gain: number): void {
    const node = this.gains.get(clipId);
    if (node) {
      node.gain.value = gain;
      el.muted = false;
    } else {
      // Volume fallback clamps to 0..1 (no boost without WebAudio).
      el.volume = Math.max(0, Math.min(1, gain));
      el.muted = gain <= 0;
    }
  }

  pauseAll(): void {
    for (const el of this.els.values()) if (!el.paused) el.pause();
  }

  /** Drop elements whose clips no longer exist (post-delete housekeeping).
   *  Walks nested sequences too, so opening a sequence never prunes the
   *  parent's elements and vice versa. */
  prune(project: VideoProject): void {
    const live = new Set<string>();
    const seen = new Set<string>();
    const walk = (p: VideoProject, depth: number) => {
      if (depth > 16) return;
      for (const t of p.tracks) {
        for (const c of t.clips) {
          live.add(c.id);
          if (c.sequenceId && this.resolveSequence && !seen.has(c.sequenceId)) {
            seen.add(c.sequenceId);
            const child = this.resolveSequence(c.sequenceId);
            if (child) walk(child, depth + 1);
          }
        }
      }
    };
    walk(project, 0);
    for (const [clipId, el] of this.els) {
      if (live.has(clipId)) continue;
      el.pause();
      el.src = "";
      this.els.delete(clipId);
      const g = this.gains.get(clipId);
      if (g) {
        g.disconnect();
        this.gains.delete(clipId);
      }
    }
  }

  dispose(): void {
    for (const el of this.els.values()) {
      el.pause();
      el.src = "";
    }
    this.els.clear();
    for (const g of this.gains.values()) g.disconnect();
    this.gains.clear();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.master = null;
    this.streamDest = null;
  }
}

