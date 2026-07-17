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
  /** assetId behind each element, for re-resolving media URLs. */
  private elAssets = new Map<string, string>();
  private keyer: ChromaKeyer | null = null;
  private gains = new Map<string, GainNode>();
  private panners = new Map<string, StereoPannerNode>();
  /** Per-track bus: a unity gain feeding master + a metering analyser. */
  private trackBuses = new Map<string, { node: GainNode; analyser: AnalyserNode; buf: Uint8Array<ArrayBuffer> }>();
  private clipTrack = new Map<string, string>();
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** Speaker tap AFTER the export tap: muting the preview never mutes exports. */
  private monitor: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private levelBuf: Uint8Array<ArrayBuffer> | null = null;
  private streamDest: MediaStreamAudioDestinationNode | null = null;
  private muted = false;
  /** Global preview playback rate multiplier (1 = realtime). */
  private rate = 1;

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
      this.monitor = ctx.createGain();
      this.monitor.gain.value = this.muted ? 0 : 1;
      this.master.connect(this.monitor);
      this.monitor.connect(ctx.destination);
      this.streamDest = ctx.createMediaStreamDestination();
      this.master.connect(this.streamDest);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.levelBuf = new Uint8Array(this.analyser.fftSize);
      this.master.connect(this.analyser);
    } catch {
      this.ctx = null; // no WebAudio: fall back to element.volume
    }
  }

  /** Mute/unmute the speakers only (the export mix keeps playing through). */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.monitor) this.monitor.gain.value = muted ? 0 : 1;
  }

  isMuted(): boolean {
    return this.muted;
  }

  /** Preview playback rate multiplier; exports force it back to 1. */
  setRate(rate: number): void {
    this.rate = Math.min(4, Math.max(0.25, rate || 1));
  }

  /** Instantaneous output peak 0..1 (pre-monitor, so it meters even muted). */
  level(): number {
    if (!this.analyser || !this.levelBuf) return 0;
    this.analyser.getByteTimeDomainData(this.levelBuf);
    let peak = 0;
    for (let i = 0; i < this.levelBuf.length; i++) {
      const v = Math.abs(this.levelBuf[i] - 128) / 128;
      if (v > peak) peak = v;
    }
    return peak;
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

  private trackBus(trackId: string): GainNode | null {
    if (!this.ctx || !this.master) return null;
    const existing = this.trackBuses.get(trackId);
    if (existing) return existing.node;
    const node = this.ctx.createGain();
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 256;
    node.connect(this.master);
    node.connect(analyser);
    this.trackBuses.set(trackId, { node, analyser, buf: new Uint8Array(analyser.fftSize) });
    return node;
  }

  /** Instantaneous peak 0..1 for one track's bus (0 when it has no bus yet). */
  trackLevel(trackId: string): number {
    const bus = this.trackBuses.get(trackId);
    if (!bus) return 0;
    bus.analyser.getByteTimeDomainData(bus.buf);
    let peak = 0;
    for (let i = 0; i < bus.buf.length; i++) {
      const v = Math.abs(bus.buf[i] - 128) / 128;
      if (v > peak) peak = v;
    }
    return peak;
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
        const panner = this.ctx.createStereoPanner();
        src.connect(gain);
        gain.connect(panner);
        panner.connect(this.master);
        this.gains.set(clip.id, gain);
        this.panners.set(clip.id, panner);
      } catch {
        /* element keeps direct output */
      }
    }
    this.els.set(clip.id, el);
    this.elAssets.set(clip.id, clip.assetId);
    return el;
  }

  /**
   * Re-resolve every element's media URL and swap sources that changed.
   * The exact export flips the resolver from preview proxies to ORIGINALS and
   * calls this, so the recording never captures a 540p proxy; the following
   * syncAt re-seeks each element to the playhead.
   */
  refreshSources(): void {
    for (const [clipId, el] of this.els) {
      const assetId = this.elAssets.get(clipId);
      if (!assetId) continue;
      const media = this.resolveMedia(assetId);
      if (!media) continue;
      const abs = new URL(media.url, window.location.href).href;
      if (el.src !== abs) {
        const t = el.currentTime;
        el.src = media.url;
        try {
          el.currentTime = t;
        } catch {
          /* not seekable yet; syncAt will seek once metadata lands */
        }
      }
    }
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
      const gain = a.xfadeTail || clip.disabled
        ? 0
        : a.mixGain ?? clipGainAt(project, track, clip, a.localFrame, duckPoints);
      this.applyGain(clip.id, el, reversed ? 0 : gain);
      const panner = this.panners.get(clip.id);
      if (panner) {
        panner.pan.value = Math.max(-1, Math.min(1, track.pan ?? 0));
        // (Re)route to the owning track's bus for per-track metering.
        if (this.clipTrack.get(clip.id) !== track.id) {
          const bus = this.trackBus(track.id);
          if (bus) {
            panner.disconnect();
            panner.connect(bus);
            this.clipTrack.set(clip.id, track.id);
          }
        }
      }
      if (wantS === null) {
        el.pause();
        continue;
      }
      if (playing && !reversed) {
        el.playbackRate = Math.min(16, Math.max(0.0625, Math.abs(clip.speed) * this.rate));
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
      this.elAssets.delete(clipId);
      const g = this.gains.get(clipId);
      if (g) {
        g.disconnect();
        this.gains.delete(clipId);
      }
      const pn = this.panners.get(clipId);
      if (pn) {
        pn.disconnect();
        this.panners.delete(clipId);
      }
      this.clipTrack.delete(clipId);
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
    this.monitor = null;
    this.analyser = null;
    this.levelBuf = null;
    this.streamDest = null;
  }
}

