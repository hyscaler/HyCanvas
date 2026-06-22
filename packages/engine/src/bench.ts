// Rendering performance harness. Times the CPU-side cost of
// the Canvas2D render path - scene build, world transforms, dirty-rect, and the
// per-node draw-call dispatch - against a no-op context, so it measures engine
// throughput independent of the actual rasterizer/GPU. It gives a baseline for
// the 60fps/1000-element target and a regression guard, and a yardstick for the
// future WebGL/WebGPU path. Pure + headless: runs in Node, a worker, or a test.

import type { DesignFile } from "@hc/schema";
import { createScene } from "./scene";
import { renderScene } from "./render2d";
import type { CanvasLike, CanvasGradientLike, Viewport } from "./types";

const NULL_GRADIENT: CanvasGradientLike = { addColorStop: () => {} };

/** A CanvasLike that does nothing: every draw call is a no-op and every state
 *  setter is ignored. Lets the benchmark exercise the full render traversal and
 *  call dispatch without a real rasterizer. */
export function createNullContext(): CanvasLike {
  const noop = (): void => {};
  return {
    save: noop, restore: noop,
    setTransform: noop, transform: noop,
    clearRect: noop, fillRect: noop, strokeRect: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
    bezierCurveTo: noop, quadraticCurveTo: noop, rect: noop, roundRect: noop, ellipse: noop,
    fill: noop, stroke: noop, clip: noop,
    fillText: noop, strokeText: noop,
    drawImage: noop,
    createLinearGradient: () => NULL_GRADIENT,
    createRadialGradient: () => NULL_GRADIENT,
    createConicGradient: () => NULL_GRADIENT,
    measureText: (t: string) => ({ width: t.length * 8 }),
    lineJoin: "miter",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    fillStyle: "#000",
    strokeStyle: "#000",
    lineWidth: 1,
    font: "16px sans-serif",
    textAlign: "left",
    filter: "none",
    shadowColor: "rgba(0,0,0,0)",
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
  };
}

export interface BenchResult {
  /** Number of top-level nodes on the benchmarked page. */
  nodeCount: number;
  /** Frames timed (after warmup). */
  frames: number;
  /** Mean frame time in milliseconds. */
  avgMs: number;
  /** Fastest / slowest frame (ms). */
  minMs: number;
  maxMs: number;
  /** Frames-per-second implied by the mean frame time. */
  fps: number;
}

export interface BenchOptions {
  viewport?: Partial<Viewport>;
  /** Timed frames (default 60). */
  frames?: number;
  /** Untimed warmup frames to prime caches/JIT (default 5). */
  warmup?: number;
  /** Monotonic clock; defaults to performance.now / Date.now. */
  now?: () => number;
}

const defaultNow: () => number =
  typeof performance !== "undefined" ? () => performance.now() : () => Date.now();

/** Render `file` repeatedly against a null context and report frame timings. */
export function benchmarkRender(file: DesignFile, opts: BenchOptions = {}): BenchResult {
  const frames = opts.frames ?? 60;
  const warmup = opts.warmup ?? 5;
  const now = opts.now ?? defaultNow;
  const page = file.pages[0];
  const viewport: Viewport = {
    zoom: 1, panX: 0, panY: 0, dpr: 1,
    width: page?.width ?? 1920, height: page?.height ?? 1080,
    ...opts.viewport,
  };
  const ctx = createNullContext();
  const scene = createScene(file, 0);

  for (let i = 0; i < warmup; i++) renderScene(scene, ctx, viewport);

  let total = 0, minMs = Infinity, maxMs = 0;
  for (let i = 0; i < frames; i++) {
    const t0 = now();
    renderScene(scene, ctx, viewport);
    const dt = now() - t0;
    total += dt;
    if (dt < minMs) minMs = dt;
    if (dt > maxMs) maxMs = dt;
  }
  const avgMs = total / Math.max(1, frames);
  return {
    nodeCount: page?.children.length ?? 0,
    frames,
    avgMs,
    minMs: minMs === Infinity ? 0 : minMs,
    maxMs,
    fps: avgMs > 0 ? 1000 / avgMs : Infinity,
  };
}
