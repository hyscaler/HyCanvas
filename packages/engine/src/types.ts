// Public runtime types for @hc/engine. None are persisted;
// the engine only reads the scene-model file format and produces pixels + hit results.

import type { DesignFile, Node, Size } from "@hc/schema";
import type { Point, Rect } from "./math";

export type { Point, Rect } from "./math";
export type { Size } from "@hc/schema";

export interface Viewport {
  zoom: number; // 1 = 100%
  panX: number; // page-space point shown at the viewport's top-left
  panY: number;
  dpr: number; // device pixel ratio
  width: number; // viewport size in CSS px
  height: number;
}

export interface SceneNode {
  node: Node; // reference into the scene graph
  worldTransform: Float32Array; // cached 2D affine (a,b,c,d,e,f)
  worldBounds: Rect; // axis-aligned page-space bounds incl. effect bleed
  dirty: boolean;
  parent: SceneNode | null;
  children?: SceneNode[];
}

export interface HitOpts {
  /** Skip locked nodes (default true). */
  ignoreLocked?: boolean;
  /** Descend into containers (default true). */
  deep?: boolean;
  /** Use true-shape geometry rather than the bounding box (default true). */
  alpha?: boolean;
}

export interface Scene {
  file: DesignFile;
  activePageId: string;
  root: SceneNode; // active page subtree
  markDirty(nodeId: string): void;
  invalidateRegion(rect: Rect): void;
  /** Page-space rectangle currently needing repaint, or null if clean. */
  dirtyRegion(): Rect | null;
  clearDirty(): void;
  hitTest(point: Point, opts?: HitOpts): Node | null;
  hitTestRect(rect: Rect, mode: "intersect" | "contain"): Node[];
  getBounds(nodeId: string): Rect | null;
  /** Page-space AABB of a connector's routed line (resolved against the live
   *  node boxes), or null if the node is not a connector. Selection UI uses this
   *  because a connector's own transform/size box sits at the origin, not on the
   *  drawn line. */
  connectorBounds(nodeId: string): Rect | null;
  /** Look up the runtime SceneNode for a graph node id. */
  getSceneNode(nodeId: string): SceneNode | null;
  /** Node ids that reference a given asset (for region-invalidation, FR-11). */
  nodesUsingAsset(assetId: string): string[];
  /** Selectable leaf nodes whose page-space AABB intersects `rect`, via a spatial
   *  index (F30 FR-27). Sublinear; powers presence interest-management and the AI
   *  agent's off-screen context. Excludes the page root and containers. */
  queryViewport(rect: Rect): Node[];
}

export type RenderContextKind = "2d" | "webgl2" | "webgpu";

export interface RenderTarget {
  kind: "canvas" | "offscreen" | "node";
  context: RenderContextKind;
  /** A CanvasRenderingContext2D-compatible drawing context. */
  ctx: CanvasLike;
  width: number;
  height: number;
}

/** The subset of the Canvas2D API the renderer relies on (so any conforming
 *  context - browser, OffscreenCanvas, or a Node canvas - works, and tests can
 *  supply a recording double). */
export interface CanvasLike {
  save(): void;
  restore(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  /** Cubic bezier (optional; engines without it fall back to a straight line). */
  bezierCurveTo?(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void;
  /** Quadratic bezier (optional; engines without it fall back to a straight line). */
  quadraticCurveTo?(cpx: number, cpy: number, x: number, y: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  /** Rounded-rect path (optional; engines without it fall back to square corners). */
  roundRect?(x: number, y: number, w: number, h: number, radii: number | number[]): void;
  ellipse?(
    x: number,
    y: number,
    rx: number,
    ry: number,
    rotation: number,
    start: number,
    end: number,
  ): void;
  /** Circular arc path (optional; call sites capability-probe before use). */
  arc?(x: number, y: number, radius: number, start: number, end: number): void;
  fill(fillRule?: "nonzero" | "evenodd"): void;
  stroke(): void;
  clip(fillRule?: "nonzero" | "evenodd"): void;
  fillText(text: string, x: number, y: number): void;
  /** Optional glyph stroke for outlined/hollow text. */
  strokeText?(text: string, x: number, y: number): void;
  lineJoin?: string;
  // Optional, capability-probed at call sites so partial contexts still work.
  // 5-arg (dx,dy,dw,dh) destination-only, or 9-arg with a source sub-rectangle
  // (sx,sy,sw,sh,dx,dy,dw,dh) used to honor image crop/fit/focal.
  drawImage?(
    image: unknown,
    a: number,
    b: number,
    c: number,
    d: number,
    dx?: number,
    dy?: number,
    dw?: number,
    dh?: number,
  ): void;
  createLinearGradient?(x0: number, y0: number, x1: number, y1: number): CanvasGradientLike;
  createRadialGradient?(
    x0: number,
    y0: number,
    r0: number,
    x1: number,
    y1: number,
    r1: number,
  ): CanvasGradientLike;
  createConicGradient?(startAngle: number, x: number, y: number): CanvasGradientLike;
  /** Optional tiling pattern from an image (browser + node canvas); used for
   *  pattern fills. Repetition is "repeat" | "repeat-x" | "repeat-y" | "no-repeat". */
  createPattern?(image: unknown, repetition: string | null): CanvasPatternLike | null;
  /** Optional text measurement (browser/Node canvas); used for line wrapping. */
  measureText?(text: string): { width: number };
  globalAlpha: number;
  globalCompositeOperation: string;
  fillStyle: string | CanvasGradientLike | CanvasPatternLike;
  strokeStyle: string | CanvasGradientLike;
  lineWidth: number;
  font: string;
  textAlign: string;
  /** CSS filter string ("blur(4px) drop-shadow(...)"); "none" to clear. */
  filter?: string;
  // Canvas2D drop-shadow state (browser + node canvas). Optional + capability-
  // probed so partial contexts still work; used e.g. to lift a sticky note off
  // the board. Reset to a transparent color / zero offsets after use.
  shadowColor?: string;
  shadowBlur?: number;
  shadowOffsetX?: number;
  shadowOffsetY?: number;
}

export interface CanvasGradientLike {
  addColorStop(offset: number, color: string): void;
}

export interface CanvasPatternLike {
  /** Apply a transform (scale/rotation) to the pattern space; optional because
   *  some headless canvases lack it (then the pattern tiles at native scale). */
  setTransform?(matrix: unknown): void;
}

export type AssetStatus = "ready" | "loading" | "missing";

/**
 * Supplies loaded media/fonts to the renderer and notifies it when a resource
 * resolves, so the engine can draw a placeholder first and region-invalidate
 * only the affected nodes once the asset arrives (FR-11). Implementations live
 * with uploads/fonts; the engine only consumes this interface.
 */
export interface AssetProvider {
  /** Loaded, drawable image for an asset id, or null if not ready. */
  image(assetId: string): unknown | null;
  status(assetId: string): AssetStatus;
  /** Subscribe to "this asset changed state"; returns an unsubscribe fn. */
  onChange(cb: (assetId: string) => void): () => void;
}

export interface EngineConfig {
  preferGpu: boolean; // default true; false forces Canvas2D
  tileSize: number; // dirty-rect tile px, default 256
  maxTextureSize: number;
  interactionQuality: "full" | "adaptive"; // default adaptive
}

export type EngineEvent = "frame" | "asset" | "error";

export interface Renderer {
  setViewport(v: Partial<Viewport>): void;
  getViewport(): Viewport;
  fit(mode: "fit" | "fill" | "1:1" | number): void; // number = explicit zoom
  renderFrame(timeMs?: number): void;
  pageToScreen(p: Point): Point;
  screenToPage(p: Point): Point;
  renderMiniMap(maxSize: Size): unknown;
  on(event: EngineEvent, cb: (e: unknown) => void): void;
  dispose(): void;
}

export const DEFAULT_CONFIG: EngineConfig = {
  preferGpu: true,
  tileSize: 256,
  maxTextureSize: 4096,
  interactionQuality: "adaptive",
};

export type { DesignFile, Node };
