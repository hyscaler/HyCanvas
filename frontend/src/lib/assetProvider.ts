// Browser image asset provider for the engine (image decode path, browser
// flavor). Maps an asset id to a loaded HTMLImageElement so renderScene can
// draw real images via ctx.drawImage. Seeded from a design's AssetRef[] (their
// CDN/blob urls) and from in-editor image placement. Worker/GPU texture upload
// and crop/fit fidelity remain deferred; this draws the image into the node box.

import type { AssetProvider, AssetStatus } from "@hc/engine";

interface Entry {
  url: string;
  status: AssetStatus;
  img: HTMLImageElement | null;
}

class ImageAssetProvider implements AssetProvider {
  private entries = new Map<string, Entry>();
  private subs = new Set<(assetId: string) => void>();

  /** Register an asset id -> url and begin loading it (idempotent per url). */
  register(assetId: string, url: string): void {
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

  /** Register every image AssetRef of a design (by id -> url). */
  registerAll(assets: { id: string; url: string; kind?: string }[]): void {
    for (const a of assets) {
      if (a.url) this.register(a.id, a.url);
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
