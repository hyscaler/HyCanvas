// Renderer lifecycle: capability probe, viewport control, frame painting, and
// coordinate conversion (FR-1, FR-3, FR-12, FR-13). The GPU (WebGL2/WebGPU) and
// OffscreenCanvas-worker paths are deferred; this wires the Canvas2D path and
// the probe/fallback seam so enabling GPU later is additive.

import type { Size } from "@hc/schema";
import { renderScene, type Render2DOptions } from "./render2d";
import {
  defaultViewport,
  fit as fitViewport,
  pageToScreen as pToS,
  screenToPage as sToP,
  type FitMode,
} from "./viewport";
import {
  DEFAULT_CONFIG,
  type AssetProvider,
  type EngineConfig,
  type EngineEvent,
  type Point,
  type RenderContextKind,
  type Renderer,
  type RenderTarget,
  type Scene,
  type Viewport,
} from "./types";

/** Whether an accelerated context is usable. GPU paths are deferred, so this is
 *  currently always false and the engine cleanly uses Canvas2D (FR-13, AC-6). */
export function gpuAvailable(): boolean {
  return false;
}

/** Choose the render context, honoring `preferGpu` and falling back to 2d. */
export function probeContext(target: RenderTarget, config: EngineConfig): RenderContextKind {
  if (config.preferGpu && target.context !== "2d" && gpuAvailable()) {
    return target.context;
  }
  return "2d";
}

function activePageSize(scene: Scene): Size {
  const page = scene.file.pages.find((p) => p.id === scene.activePageId) ?? scene.file.pages[0];
  return { width: page.width, height: page.height };
}

class RendererImpl implements Renderer {
  private viewport: Viewport;
  private readonly listeners: Record<EngineEvent, Array<(e: unknown) => void>> = {
    frame: [],
    asset: [],
    error: [],
  };
  readonly contextKind: RenderContextKind;
  private unsubscribeAssets: (() => void) | null = null;

  constructor(
    private scene: Scene,
    private target: RenderTarget,
    private config: EngineConfig,
    private assets?: AssetProvider,
  ) {
    this.contextKind = probeContext(target, config);
    const dpr = typeof globalThis !== "undefined" && "devicePixelRatio" in globalThis
      ? (globalThis as { devicePixelRatio?: number }).devicePixelRatio || 1
      : 1;
    this.viewport = defaultViewport(target.width, target.height, dpr);

    // When an asset resolves, invalidate only the regions of nodes that use it
    // and signal listeners; no full-canvas reflow (FR-11).
    if (this.assets) {
      this.unsubscribeAssets = this.assets.onChange((assetId) => {
        const nodeIds = this.scene.nodesUsingAsset(assetId);
        for (const id of nodeIds) this.scene.markDirty(id);
        this.emit("asset", { assetId, nodeIds });
      });
    }
  }

  getViewport(): Viewport {
    return { ...this.viewport };
  }

  setViewport(v: Partial<Viewport>): void {
    const merged = { ...this.viewport, ...v };
    // Guard against a non-positive/non-finite zoom, which would make
    // screenToPage divide by zero and poison every coordinate conversion.
    if (!(merged.zoom > 0) || !isFinite(merged.zoom)) merged.zoom = this.viewport.zoom;
    this.viewport = merged;
    // A viewport change invalidates the whole surface (FR-4).
    this.scene.invalidateRegion({ x: -Infinity, y: -Infinity, width: Infinity, height: Infinity });
  }

  fit(mode: FitMode): void {
    this.viewport = fitViewport(this.viewport, activePageSize(this.scene), mode);
  }

  renderFrame(timeMs?: number): void {
    const opts: Render2DOptions = {
      onError: (err, nodeId) => this.emit("error", { err, nodeId }),
      assets: this.assets,
    };
    renderScene(this.scene, this.target.ctx, this.viewport, opts);
    this.scene.clearDirty();
    this.emit("frame", { timeMs: timeMs ?? 0 });
  }

  pageToScreen(p: Point): Point {
    return pToS(this.viewport, p);
  }

  screenToPage(p: Point): Point {
    return sToP(this.viewport, p);
  }

  renderMiniMap(maxSize: Size): unknown {
    // Best-effort: needs a canvas factory. Available in browser/worker via
    // OffscreenCanvas; returns null headless (Node) where no factory exists.
    const Off = (globalThis as { OffscreenCanvas?: typeof OffscreenCanvas }).OffscreenCanvas;
    if (!Off) return null;
    const page = activePageSize(this.scene);
    const scale = Math.min(maxSize.width / page.width, maxSize.height / page.height, 1);
    const canvas = new Off(Math.ceil(page.width * scale), Math.ceil(page.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    renderScene(this.scene, ctx as unknown as RenderTarget["ctx"], {
      zoom: scale,
      panX: 0,
      panY: 0,
      dpr: 1,
      width: page.width * scale,
      height: page.height * scale,
    });
    return canvas;
  }

  on(event: EngineEvent, cb: (e: unknown) => void): void {
    this.listeners[event].push(cb);
  }

  private emit(event: EngineEvent, payload: unknown): void {
    for (const cb of this.listeners[event]) cb(payload);
  }

  dispose(): void {
    this.unsubscribeAssets?.();
    this.unsubscribeAssets = null;
    this.listeners.frame = [];
    this.listeners.asset = [];
    this.listeners.error = [];
  }
}

/** Mount a live renderer over a scene and target. An optional asset provider
 *  supplies loaded media/fonts and drives region-invalidation on load (FR-11). */
export function mountRenderer(
  scene: Scene,
  target: RenderTarget,
  config: Partial<EngineConfig> = {},
  assets?: AssetProvider,
): Renderer {
  return new RendererImpl(scene, target, { ...DEFAULT_CONFIG, ...config }, assets);
}

export interface OneShotOptions extends Render2DOptions {
  viewport?: Viewport;
}

/** One-shot render (headless export and thumbnails). Renders the full
 *  page at 1:1 unless a viewport is supplied. */
export function render(scene: Scene, target: RenderTarget, opts: OneShotOptions = {}): void {
  const page = activePageSize(scene);
  const viewport =
    opts.viewport ??
    defaultViewport(target.width || page.width, target.height || page.height, 1);
  renderScene(scene, target.ctx, viewport, opts);
}
