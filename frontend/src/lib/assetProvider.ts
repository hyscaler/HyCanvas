// Browser image asset provider for the engine (image decode path, browser
// flavor). Maps an asset id to a loaded HTMLImageElement so renderScene can
// draw real images via ctx.drawImage. Seeded from a design's AssetRef[] (their
// CDN/blob urls) and from in-editor image placement. Worker/GPU texture upload
// and crop/fit fidelity remain deferred; this draws the image into the node box.

import type { AssetProvider, AssetStatus } from "@hc/engine";
import { resolveAssetUrl } from "@/lib/sdk";

interface Entry {
  url: string;
  status: AssetStatus;
  img: HTMLImageElement | HTMLVideoElement | null;
  video?: boolean;
}

class ImageAssetProvider implements AssetProvider {
  private entries = new Map<string, Entry>();
  private subs = new Set<(assetId: string) => void>();

  /** Register an asset id -> url and begin loading it (idempotent per url).
   *  Server-relative urls are resolved against the API origin here: documents
   *  can carry them (upload responses are relative unless the backend has a
   *  publicURL), and loading one against the frontend dev origin 404s, which
   *  reads as a permanently "missing" asset. In the same-origin dist build the
   *  resolution is the identity, so this only matters where it helps. */
  register(assetId: string, url: string): void {
    url = resolveAssetUrl(url);
    const existing = this.entries.get(assetId);
    if (existing && existing.url === url) return;
    const entry: Entry = { url, status: "loading", img: null };
    this.entries.set(assetId, entry);
    if (typeof window === "undefined") return;
    const img = new Image();
    img.crossOrigin = "anonymous"; // keep the export canvas untainted where CORS allows
    img.onload = () => {
      entry.img = img;
      entry.status = "ready";
      this.notify(assetId);
    };
    img.onerror = () => {
      entry.status = "missing";
      this.notify(assetId);
    };
    img.src = url;
  }

  /** Register a video asset id -> url as an HTMLVideoElement so the engine can
   *  draw the current frame via ctx.drawImage. Notifies on load and on seek so
   *  the canvas repaints when the frame changes (scrubbing/playback). */
  registerVideo(assetId: string, url: string): void {
    url = resolveAssetUrl(url); // same relative-url resolution as register()
    const existing = this.entries.get(assetId);
    if (existing && existing.url === url) return;
    const entry: Entry = { url, status: "loading", img: null, video: true };
    this.entries.set(assetId, entry);
    if (typeof window === "undefined") return;
    const v = document.createElement("video");
    v.crossOrigin = "anonymous";
    v.muted = true; // required for programmatic play without a gesture
    v.playsInline = true;
    v.preload = "auto";
    const ready = () => { entry.img = v; entry.status = "ready"; this.notify(assetId); };
    v.addEventListener("loadeddata", ready);
    v.addEventListener("seeked", () => this.notify(assetId));
    v.addEventListener("timeupdate", () => this.notify(assetId));
    v.addEventListener("error", () => { entry.status = "missing"; this.notify(assetId); });
    v.src = url;
  }

  /** The underlying HTMLVideoElement for a video asset (for scrub/play control). */
  videoEl(assetId: string): HTMLVideoElement | null {
    const e = this.entries.get(assetId);
    return e?.video && e.img instanceof HTMLVideoElement ? e.img : null;
  }

  /** Register every AssetRef of a design (by id -> url); videos load as <video>. */
  registerAll(assets: { id: string; url: string; kind?: string }[]): void {
    for (const a of assets) {
      if (!a.url) continue;
      if (a.kind === "video") this.registerVideo(a.id, a.url);
      else this.register(a.id, a.url);
    }
  }

  image(assetId: string): unknown | null {
    return this.entries.get(assetId)?.img ?? null;
  }

  /** Source URL for an asset id (used by the crop overlay's preview image). */
  url(assetId: string): string | null {
    return this.entries.get(assetId)?.url ?? null;
  }

  status(assetId: string): AssetStatus {
    return this.entries.get(assetId)?.status ?? "missing";
  }

  onChange(cb: (assetId: string) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  private notify(assetId: string): void {
    for (const cb of this.subs) cb(assetId);
  }
}

/** Shared provider for the editor canvas and export. */
export const imageAssets = new ImageAssetProvider();
