// Canvas2D render path. Draws a scene to any CanvasRenderingContext2D-compatible
// context (browser canvas, OffscreenCanvas, a Node canvas, or a test recording
// double), so the same code paints on screen and headless (FR-1, FR-10, FR-14).
// Honors transforms, opacity, blend modes, clipping, gradients, node effects
// (blur/shadow/glow/outline via the CSS filter), and the asset provider for
// media, with per-node error isolation and placeholders for unknown/unloaded
// content. The GPU path is layered on later.

import {
  isContainer,
  isUnknownNode,
  type BlendMode,
  type ChartNode,
  type ChartType,
  type Color,
  type Fill,
  type ImageNode,
  type InkNode,
  type Node,
  type ShapeNode,
  type TableNode,
  type TextEffect,
} from "@hc/schema";
import { fitRect } from "./image";
import { buildClipFromPathData } from "./pathclip";
import { layoutText, isTabRun, tabRunWidth, type MeasureFn } from "@hc/text";
import { colorToCss } from "./color";
import { applyTextCase, canvasFontString, fontFamilyStack } from "./fonts";
import { effectsFilter, outlineSpecs, duotoneEffect } from "./effects";
import { duotoneCanvas } from "./duotone";
import { resolveFill } from "./fills";
import { groupedBarLayout, radarPoint, seriesMax, stackedBase, stackedMax, categoryCount, tickCount } from "./chart";
import { SERIES_PALETTE_HEX } from "@hc/color";
import { fromTransform } from "./math";
import type { AssetProvider, CanvasGradientLike, CanvasLike, Scene, SceneNode, Viewport } from "./types";

// No-op kept for API compatibility (a previous text-layout cache was reverted
// because it could leave text-dense pages blank; layout is recomputed per draw).
export function bumpTextLayout(): void {}

export interface Render2DOptions {
  /** Called when a node throws during draw; the node still renders a placeholder. */
  onError?: (err: unknown, nodeId: string) => void;
  /** Loaded media/fonts; when absent, media draws a neutral placeholder (FR-11). */
  assets?: AssetProvider;
  /** Skip expensive work during interaction (reserved for adaptive quality). */
  quality?: "full" | "low";
  /** Clear the canvas before drawing (default true). Set false to draw multiple
   *  scenes onto one canvas, e.g. stacked pages in continuous-scroll mode. */
  clear?: boolean;
  /** Skip drawing this node (and its subtree). Used to hide a text node while it
   *  is being edited in the live HTML overlay, so the two don't double up. */
  skipNodeId?: string;
  /** Skip drawing these nodes (and their subtrees). Per-client visual hide that
   *  does not touch the document, used by whiteboard private mode to hide other
   *  participants' new contributions until reveal (FR-15). */
  hiddenIds?: ReadonlySet<string>;
  /** Viewport culling + sub-pixel LOD (FR-27); default on. Set false to force a
   *  full paint of every node (e.g. off-screen thumbnail/export of a whole page). */
  cull?: boolean;
  /** Draw ONLY the page background (fill), then return. Used by the editor's
   *  two-pass stacked render: all page backgrounds first, so a later page's
   *  background never covers an earlier page's overflowing content. */
  backgroundOnly?: boolean;
  /** Skip the page background fill and draw only the content. The other half of
   *  the two-pass render (content composited on top of every background). */
  skipBackground?: boolean;
  /** Node ids to render at reduced opacity (and their subtrees). The editor sets
   *  this to the element(s) being actively moved/resized so the page shows through
   *  them during the gesture. */
  fadeIds?: ReadonlySet<string>;
  /** Clip each top-level element to the page rectangle so content that overflows
   *  the artboard is hidden (clean page edges). Off by default so
   *  export/thumbnail render the full content. `revealIds` are exempt. */
  clipToPage?: boolean;
  /** Top-level node ids exempt from `clipToPage`, drawn unclipped so their
   *  overflow is visible. The editor sets this to the current selection so a
   *  selected element reveals the parts hidden past the page edge. */
  revealIds?: ReadonlySet<string>;
}

/** Absolute page-space box of a node, keyed by node id. Used to resolve
 *  connector endpoints (attached to other nodes) at render time, so moving a
 *  connected node re-routes the connector on the next frame for free. */
type BoxMap = Record<string, { x: number; y: number; width: number; height: number }>;

// Opacity for an element while it is actively being moved/resized, so the page
// and content behind it show through (live-transform translucency).
const LIVE_TRANSFORM_ALPHA = 0.5;
// Opacity for the part of a selected element that spills past the page edge, so
// the revealed overflow reads as "outside the artboard" while the in-page part
// stays crisp (pasteboard dimming).
const OVERFLOW_REVEAL_ALPHA = 0.4;
const PLACEHOLDER_FILL = "rgba(0, 0, 0, 0.06)";
const PLACEHOLDER_STROKE = "rgba(0, 0, 0, 0.25)";
const MISSING_FILL = "rgba(220, 38, 38, 0.10)";
const MISSING_STROKE = "rgba(220, 38, 38, 0.6)";

/** Map a scene-model blend mode to a Canvas2D globalCompositeOperation. */
export function blendToComposite(mode: BlendMode): string {
  return mode === "normal" ? "source-over" : mode;
}

function placeholderBox(
  ctx: CanvasLike,
  w: number,
  h: number,
  fill = PLACEHOLDER_FILL,
  stroke = PLACEHOLDER_STROKE,
): void {
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1;
  ctx.strokeRect(0, 0, w, h);
}

function setStroke(ctx: CanvasLike, width: number, style: string | CanvasGradientLike): void {
  ctx.lineWidth = width;
  ctx.strokeStyle = style;
  ctx.stroke();
}

/** Trace a shape's outline into the current path (no fill/stroke), so the same
 *  geometry can be filled, stroked, or used as a clip (for image fills). */
function shapePath(ctx: CanvasLike, node: ShapeNode): void {
  const { width: w, height: h } = node.size;
  if (node.shape === "ellipse" && ctx.ellipse) {
    ctx.beginPath();
    ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    return;
  }
  if (node.shape === "rect" || node.shape === "custom") {
    const cr = node.cornerRadius;
    const hasRadius = !!cr && !!(cr.topLeft || cr.topRight || cr.bottomRight || cr.bottomLeft);
    ctx.beginPath();
    if (cr && hasRadius && ctx.roundRect) ctx.roundRect(0, 0, w, h, [cr.topLeft, cr.topRight, cr.bottomRight, cr.bottomLeft]);
    else { ctx.moveTo(0, 0); ctx.lineTo(w, 0); ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath(); }
    return;
  }
  const pts = polyPoints(node);
  if (pts.length > 0) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  }
}

/** Paint a pattern fill (tiled image) clipped to the current shape path. Returns
 *  true when it handled the fill (asset ready or a placeholder was drawn). */
function paintPattern(
  ctx: CanvasLike,
  pat: { assetId: string; scale: number; rotation?: number; repeat: "tile" | "mirror" | "no-repeat" },
  w: number,
  h: number,
  assets?: AssetProvider,
): boolean {
  if (!ctx.createPattern) return false;
  const status = assets ? assets.status(pat.assetId) : "loading";
  const img = status === "ready" ? assets?.image(pat.assetId) : null;
  if (!img) {
    placeholderBox(ctx, w, h, status === "missing" ? MISSING_FILL : undefined, status === "missing" ? MISSING_STROKE : undefined);
    return true;
  }
  // Canvas2D has no native mirror repetition; "mirror" falls back to tiling.
  const repetition = pat.repeat === "no-repeat" ? "no-repeat" : "repeat";
  const pattern = ctx.createPattern(img, repetition);
  if (!pattern) return false;
  const s = pat.scale > 0 ? pat.scale : 1;
  const rot = ((pat.rotation ?? 0) * Math.PI) / 180;
  // Scale/rotate the pattern space where supported (browser + node-canvas).
  if (pattern.setTransform && typeof DOMMatrix !== "undefined") {
    const cos = Math.cos(rot), sin = Math.sin(rot);
    try { pattern.setTransform(new DOMMatrix([cos * s, sin * s, -sin * s, cos * s, 0, 0])); } catch { /* unsupported: native scale */ }
  }
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, w, h);
  return true;
}

function drawShape(ctx: CanvasLike, node: ShapeNode, assets?: AssetProvider): void {
  const { width: w, height: h } = node.size;
  // Pattern fill (tiled image): clip to the shape outline, then tile the asset.
  const patFill = node.fills.find((f) => f.type === "pattern") as { assetId: string; scale: number; rotation?: number; repeat: "tile" | "mirror" | "no-repeat" } | undefined;
  if (patFill && ctx.save && ctx.restore && ctx.clip && ctx.createPattern) {
    ctx.save();
    shapePath(ctx, node);
    ctx.clip();
    paintPattern(ctx, patFill, w, h, assets);
    ctx.restore();
    if (node.stroke) { shapePath(ctx, node); setStroke(ctx, node.stroke.width, resolveFill(ctx, node.stroke.fill, w, h)); }
    return;
  }
  // Image fill: clip to the shape outline and draw the image honoring the
  // fill's crop/fit (the crop overlay writes fills[0].crop, the same model as
  // the image node), so adjusting an image inside a shape renders faithfully.
  const imgFill = node.fills.find((f) => f.type === "image") as
    | { source: { assetId: string }; fit?: ImageNode["fit"]; crop?: { x: number; y: number; width: number; height: number }; focalPoint?: { x: number; y: number } }
    | undefined;
  if (imgFill && ctx.save && ctx.restore && ctx.clip) {
    const assetId = imgFill.source.assetId;
    const status = assets ? assets.status(assetId) : "loading";
    ctx.save();
    shapePath(ctx, node);
    ctx.clip();
    const img = status === "ready" ? assets?.image(assetId) : null;
    if (img && ctx.drawImage) {
      const el = img as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number };
      const iw = (el.naturalWidth || el.width || 1) as number;
      const ih = (el.naturalHeight || el.height || 1) as number;
      const crop = imgFill.crop ?? { x: 0, y: 0, width: 1, height: 1 };
      const fr = fitRect(iw * crop.width, ih * crop.height, w, h, imgFill.fit ?? "cover", imgFill.focalPoint);
      const sx = (crop.x + fr.source.x * crop.width) * iw;
      const sy = (crop.y + fr.source.y * crop.height) * ih;
      const sw = fr.source.width * crop.width * iw;
      const sh = fr.source.height * crop.height * ih;
      ctx.drawImage(img as CanvasImageSource, sx, sy, sw, sh, fr.dest.x, fr.dest.y, fr.dest.width, fr.dest.height);
    } else {
      placeholderBox(ctx, w, h, status === "missing" ? MISSING_FILL : undefined, status === "missing" ? MISSING_STROKE : undefined);
    }
    ctx.restore();
    if (node.stroke) { shapePath(ctx, node); setStroke(ctx, node.stroke.width, resolveFill(ctx, node.stroke.fill, w, h)); }
    return;
  }
  const fillStyle = node.fills.length > 0 ? resolveFill(ctx, node.fills[0], w, h) : null;
  if (fillStyle !== null) ctx.fillStyle = fillStyle;

  switch (node.shape) {
    case "ellipse":
      if (ctx.ellipse) {
        ctx.beginPath();
        ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        if (fillStyle !== null) ctx.fill();
        if (node.stroke) setStroke(ctx, node.stroke.width, resolveFill(ctx, node.stroke.fill, w, h));
      } else if (fillStyle !== null) {
        ctx.fillRect(0, 0, w, h);
      }
      break;
    case "rect":
    case "custom": {
      const cr = node.cornerRadius;
      const hasRadius = !!cr && !!(cr.topLeft || cr.topRight || cr.bottomRight || cr.bottomLeft);
      if (cr && hasRadius && ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(0, 0, w, h, [cr.topLeft, cr.topRight, cr.bottomRight, cr.bottomLeft]);
        if (fillStyle !== null) ctx.fill();
        if (node.stroke) {
          ctx.lineWidth = node.stroke.width;
          ctx.strokeStyle = resolveFill(ctx, node.stroke.fill, w, h);
          ctx.stroke();
        }
      } else {
        if (fillStyle !== null) ctx.fillRect(0, 0, w, h);
        if (node.stroke) {
          ctx.lineWidth = node.stroke.width;
          ctx.strokeStyle = resolveFill(ctx, node.stroke.fill, w, h);
          ctx.strokeRect(0, 0, w, h);
        }
      }
      break;
    }
    default: {
      const pts = polyPoints(node);
      if (pts.length > 0) {
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
        if (fillStyle !== null) ctx.fill();
        if (node.stroke) setStroke(ctx, node.stroke.width, resolveFill(ctx, node.stroke.fill, w, h));
      }
    }
  }
}

function polyPoints(node: ShapeNode): { x: number; y: number }[] {
  const { width: w, height: h } = node.size;
  if (node.shape === "triangle") {
    return [
      { x: w / 2, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ];
  }
  const sides = Math.max(3, Math.floor(node.sides ?? 5));
  const star = node.shape === "star";
  const inner = star ? (node.innerRadius ?? 0.5) : 1;
  const count = star ? sides * 2 : sides;
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    const ang = -Math.PI / 2 + (Math.PI * 2 * i) / count;
    const r = star && i % 2 === 1 ? inner : 1;
    pts.push({ x: w / 2 + Math.cos(ang) * (w / 2) * r, y: h / 2 + Math.sin(ang) * (h / 2) * r });
  }
  return pts;
}

function drawMedia(ctx: CanvasLike, w: number, h: number, assetId: string, assets?: AssetProvider): void {
  const status = assets ? assets.status(assetId) : "loading";
  if (status === "ready") {
    const img = assets?.image(assetId);
    if (img && ctx.drawImage) {
      ctx.drawImage(img, 0, 0, w, h);
      return;
    }
  }
  if (status === "missing") {
    placeholderBox(ctx, w, h, MISSING_FILL, MISSING_STROKE); // dangling asset (FR-11)
    return;
  }
  placeholderBox(ctx, w, h); // loading: neutral skeleton
}

/**
 * Draw an image honoring its crop sub-rectangle, fit mode, and focal point.
 * The crop (normalized to the full source) selects the visible region of the
 * asset; fitRect then maps that cropped source into the node box.
 */
function drawImageNode(ctx: CanvasLike, node: ImageNode, w: number, h: number, assets?: AssetProvider): void {
  const assetId = node.source.assetId;
  const status = assets ? assets.status(assetId) : "loading";
  if (status === "ready") {
    let img = assets?.image(assetId);
    if (img && ctx.drawImage) {
      const natW = node.source.naturalWidth || 1;
      const natH = node.source.naturalHeight || 1;
      // Source-pixel basis for the crop/sample math. The duotone buffer may be
      // downscaled (capped longest side), so sampling must use the buffer's own
      // dimensions, not the natural ones.
      let srcW = natW;
      let srcH = natH;
      // Duotone (FR-12): swap in a cached luminance->gradient mapped copy so the
      // per-pixel work runs only when source/colors/intensity change.
      const duo = duotoneEffect(node.effects);
      if (duo && duo.intensity > 0) {
        const mapped = duotoneCanvas(
          assetId,
          img as CanvasImageSource,
          natW,
          natH,
          duo.shadows,
          duo.highlights,
          duo.intensity,
        );
        if (mapped) {
          img = mapped;
          const mw = (mapped as { width?: number }).width;
          const mh = (mapped as { height?: number }).height;
          if (mw && mh) { srcW = mw; srcH = mh; }
        }
      }
      const crop = node.crop ?? { x: 0, y: 0, width: 1, height: 1 };
      const fr = fitRect(srcW * crop.width, srcH * crop.height, w, h, node.fit, node.focalPoint);
      const sx = (crop.x + fr.source.x * crop.width) * srcW;
      const sy = (crop.y + fr.source.y * crop.height) * srcH;
      const sw = fr.source.width * crop.width * srcW;
      const sh = fr.source.height * crop.height * srcH;
      ctx.drawImage(img, sx, sy, sw, sh, fr.dest.x, fr.dest.y, fr.dest.width, fr.dest.height);
      return;
    }
  }
  if (status === "missing") {
    placeholderBox(ctx, w, h, MISSING_FILL, MISSING_STROKE);
    return;
  }
  placeholderBox(ctx, w, h);
}

/** Anchor on a box for a connector endpoint. "auto" picks the side midpoint
 *  nearest `toward`; mirrors @hc/whiteboard anchorPoint without adding the dep. */
function connectorAnchorPoint(
  box: { x: number; y: number; width: number; height: number },
  anchor: string,
  toward: { x: number; y: number } | null,
): { x: number; y: number } {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  switch (anchor) {
    case "top": return { x: cx, y: box.y };
    case "bottom": return { x: cx, y: box.y + box.height };
    case "left": return { x: box.x, y: cy };
    case "right": return { x: box.x + box.width, y: cy };
    case "center": return { x: cx, y: cy };
    default: {
      const sides = [
        { x: cx, y: box.y },
        { x: box.x + box.width, y: cy },
        { x: cx, y: box.y + box.height },
        { x: box.x, y: cy },
      ];
      const target = toward ?? { x: box.x + box.width, y: cy };
      let best = sides[0];
      let bestD = Infinity;
      for (const s of sides) {
        const d = (s.x - target.x) ** 2 + (s.y - target.y) ** 2;
        if (d < bestD) { bestD = d; best = s; }
      }
      return best;
    }
  }
}

type ConnEndPoint = { point?: { x: number; y: number }; attach?: { nodeId: string; anchor: string } };

/** Resolve a connector endpoint to an absolute page-space point: an attached
 *  node's anchor (from the live box map) or its floating point. */
function resolveConnectorEnd(
  ep: ConnEndPoint,
  boxes: BoxMap,
  toward: { x: number; y: number } | null,
): { x: number; y: number } {
  if (ep.attach && boxes[ep.attach.nodeId]) {
    return connectorAnchorPoint(boxes[ep.attach.nodeId], ep.attach.anchor, toward);
  }
  if (ep.point) return { x: ep.point.x, y: ep.point.y };
  return { x: 0, y: 0 };
}

/** Center of an endpoint's reference box (or its floating point) used to steer
 *  the opposite endpoint's "auto" anchor. */
function connectorEndRef(ep: ConnEndPoint, boxes: BoxMap): { x: number; y: number } | null {
  if (ep.attach && boxes[ep.attach.nodeId]) {
    const b = boxes[ep.attach.nodeId];
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }
  if (ep.point) return { x: ep.point.x, y: ep.point.y };
  return null;
}

/** Draw a cap (arrow/triangle/dot) at `tip`, pointing away from `from`. */
function drawCap(
  ctx: CanvasLike,
  cap: { kind: string; size: number } | undefined,
  from: { x: number; y: number },
  tip: { x: number; y: number },
  width: number,
  color: string | CanvasGradientLike,
): void {
  if (!cap || cap.kind === "none") return;
  const a = Math.atan2(tip.y - from.y, tip.x - from.x);
  const len = Math.max(8, (cap.size || width * 3.5));
  if (cap.kind === "dot") {
    const r = Math.max(3, cap.size / 2 || width * 1.5);
    ctx.fillStyle = color;
    if (ctx.ellipse) {
      ctx.beginPath();
      ctx.ellipse(tip.x, tip.y, r, r, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillRect(tip.x - r, tip.y - r, r * 2, r * 2);
    }
    return;
  }
  // arrow / triangle: a filled wedge at the tip.
  const spread = cap.kind === "triangle" ? Math.PI / 5 : Math.PI / 7;
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(tip.x - len * Math.cos(a - spread), tip.y - len * Math.sin(a - spread));
  ctx.lineTo(tip.x - len * Math.cos(a + spread), tip.y - len * Math.sin(a + spread));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

/**
 * Draw a connector as a routed polyline between its two endpoints, in the
 * connector node's LOCAL space (the page-space points are offset by the
 * connector's own world origin, which `paint` has already applied to ctx).
 * Attached endpoints resolve from the live box map, so moving a connected node
 * re-routes the connector on the next frame.
 */
function drawConnector(
  ctx: CanvasLike,
  node: Node,
  boxes: BoxMap,
  origin: { x: number; y: number },
): void {
  const conn = node as unknown as {
    route: "straight" | "elbow" | "curved";
    start: ConnEndPoint;
    end: ConnEndPoint;
    stroke: { fill: import("@hc/schema").Fill; width: number };
    startCap?: { kind: string; size: number };
    endCap?: { kind: string; size: number };
    waypoints?: { x: number; y: number }[];
    label?: { text: string; position?: number };
  };
  const startRef = connectorEndRef(conn.start, boxes);
  const endRef = connectorEndRef(conn.end, boxes);
  const a = resolveConnectorEnd(conn.start, boxes, endRef);
  const b = resolveConnectorEnd(conn.end, boxes, startRef);

  // Build the routed polyline in page space.
  let pts: { x: number; y: number }[];
  let curved = false;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const wps = conn.waypoints && conn.waypoints.length > 0 ? conn.waypoints : null;
  if (wps) {
    // User waypoints (FR-8): visit each in order. Elbow keeps every leg
    // axis-aligned; straight/curved pass through directly (drawn as a polyline).
    const through = [a, ...wps, b];
    pts = conn.route === "elbow" ? orthogonalChain(through) : through;
  } else if (conn.route === "straight" || (dx === 0 && dy === 0)) {
    pts = [a, b];
  } else if (Math.abs(dx) >= Math.abs(dy)) {
    if (dy === 0) pts = [a, b];
    else { const midX = a.x + dx / 2; pts = [a, { x: midX, y: a.y }, { x: midX, y: b.y }, b]; }
  } else {
    if (dx === 0) pts = [a, b];
    else { const midY = a.y + dy / 2; pts = [a, { x: a.x, y: midY }, { x: b.x, y: midY }, b]; }
  }
  // For a curved route with no explicit waypoints, draw a single quadratic
  // through the midpoint (the long-standing smooth look).
  if (!wps) curved = conn.route === "curved" && pts.length > 2;

  // Shift page-space points into the connector node's local space.
  const lx = (p: { x: number; y: number }) => p.x - origin.x;
  const ly = (p: { x: number; y: number }) => p.y - origin.y;

  const width = conn.stroke?.width ?? 2;
  const color = resolveFill(ctx, conn.stroke.fill, 1, 1);
  ctx.beginPath();
  ctx.moveTo(lx(pts[0]), ly(pts[0]));
  if (curved && ctx.quadraticCurveTo) {
    const mid = { x: a.x + dx / 2, y: a.y + dy / 2 };
    ctx.quadraticCurveTo(lx(mid), ly(mid), lx(b), ly(b));
  } else {
    for (let i = 1; i < pts.length; i++) ctx.lineTo(lx(pts[i]), ly(pts[i]));
  }
  setStroke(ctx, width, color);

  // Caps point along the first/last segment. Use endpoint neighbors as the
  // "from" reference so the arrow aligns with the incoming direction.
  const startNeighbor = pts[1] ?? b;
  const endNeighbor = pts[pts.length - 2] ?? a;
  if (conn.startCap) drawCap(ctx, conn.startCap, { x: lx(startNeighbor), y: ly(startNeighbor) }, { x: lx(a), y: ly(a) }, width, color);
  if (conn.endCap) drawCap(ctx, conn.endCap, { x: lx(endNeighbor), y: ly(endNeighbor) }, { x: lx(b), y: ly(b) }, width, color);

  // Connector label (FR-8): a small chip with the text, anchored at a fraction
  // along the polyline so it stays attached as the route re-flows.
  if (conn.label && conn.label.text) {
    const t = Math.max(0, Math.min(1, conn.label.position ?? 0.5));
    const at = pointAlong(pts, t);
    const cx = lx(at);
    const cy = ly(at);
    ctx.font = "12px system-ui, sans-serif";
    const tw = ctx.measureText ? ctx.measureText(conn.label.text).width : conn.label.text.length * 7;
    const padX = 5;
    const chipW = tw + padX * 2;
    const chipH = 18;
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(cx - chipW / 2, cy - chipH / 2, chipW, chipH, 4);
      ctx.fill();
    } else {
      ctx.fillRect(cx - chipW / 2, cy - chipH / 2, chipW, chipH);
    }
    ctx.fillStyle = "#334155";
    ctx.textAlign = "center";
    ctx.fillText(conn.label.text, cx, cy + 4);
  }
}

/** Visit each point with axis-aligned segments, inserting an L-bend between any
 *  two that are not already aligned (engine mirror of @hc/whiteboard routing). */
function orthogonalChain(points: { x: number; y: number }[]): { x: number; y: number }[] {
  if (points.length === 0) return [];
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const p = out[out.length - 1];
    const q = points[i];
    if (p.x !== q.x && p.y !== q.y) out.push({ x: q.x, y: p.y });
    out.push(q);
  }
  return out;
}

/** The point at fraction `t` (0..1) of a polyline's arc length. */
function pointAlong(pts: { x: number; y: number }[], t: number): { x: number; y: number } {
  if (pts.length === 0) return { x: 0, y: 0 };
  if (pts.length === 1) return pts[0];
  let total = 0;
  const segLen: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    segLen.push(d);
    total += d;
  }
  if (total === 0) return pts[0];
  let target = t * total;
  for (let i = 0; i < segLen.length; i++) {
    if (target <= segLen[i] || i === segLen.length - 1) {
      const f = segLen[i] === 0 ? 0 : target / segLen[i];
      return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * f, y: pts[i].y + (pts[i + 1].y - pts[i].y) * f };
    }
    target -= segLen[i];
  }
  return pts[pts.length - 1];
}

/** Draw an ink stroke as a variable-width filled ribbon (FR-5). Pen width
 *  responds to per-point pressure; marker keeps a flat nib; highlighter is
 *  semi-transparent and multiplies onto the content beneath it. A fill ribbon
 *  (rather than a stroked polyline) gives round, pressure-shaped edges without
 *  needing lineCap/arc, which the partial CanvasLike does not guarantee. */
function drawInk(ctx: CanvasLike, node: InkNode): void {
  const pts = node.points;
  if (pts.length === 0) return;
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const baseR = Math.max(0.5, node.brush.width / 2);
  const isPen = node.brush.mode === "pen";
  const radiusAt = (i: number): number => {
    if (!isPen) return baseR; // marker / highlighter: flat, constant nib
    const pr = pts[i].p;
    return baseR * (typeof pr === "number" ? 0.35 + 0.65 * clamp01(pr) : 1);
  };
  const dot = (x: number, y: number, r: number) => {
    if (ctx.ellipse) {
      ctx.beginPath();
      ctx.ellipse(x, y, r, r, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  };

  // Snapshot and restore the specific properties we touch (rather than ctx.save,
  // which the dirty-tile renderer counts per node), matching the chart/legend draw
  // style. brush opacity composes with the node opacity the caller already applied.
  const prevAlpha = ctx.globalAlpha;
  const prevComp = ctx.globalCompositeOperation;
  const prevFill = ctx.fillStyle;
  const done = () => {
    ctx.globalAlpha = prevAlpha;
    ctx.globalCompositeOperation = prevComp;
    ctx.fillStyle = prevFill;
  };
  ctx.globalAlpha = prevAlpha * clamp01(node.brush.opacity);
  if (node.brush.mode === "highlighter") ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = colorToCss(node.brush.color);

  if (pts.length === 1) {
    dot(pts[0].x, pts[0].y, radiusAt(0));
    done();
    return;
  }

  // Offset each point along its central-difference normal to build the two ribbon
  // edges, then fill the closed outline (left forward, right backward).
  const n = pts.length;
  const left: { x: number; y: number }[] = [];
  const right: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(n - 1, i + 1)];
    const len = Math.hypot(next.x - prev.x, next.y - prev.y) || 1;
    const nx = -(next.y - prev.y) / len; // tangent rotated 90deg
    const ny = (next.x - prev.x) / len;
    const r = radiusAt(i);
    left.push({ x: pts[i].x + nx * r, y: pts[i].y + ny * r });
    right.push({ x: pts[i].x - nx * r, y: pts[i].y - ny * r });
  }
  ctx.beginPath();
  ctx.moveTo(left[0].x, left[0].y);
  for (let i = 1; i < n; i++) ctx.lineTo(left[i].x, left[i].y);
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(right[i].x, right[i].y);
  ctx.closePath();
  ctx.fill();
  // Round end caps for pen/marker; highlighter keeps flat (chisel) ends.
  if (node.brush.mode !== "highlighter") {
    dot(pts[0].x, pts[0].y, radiusAt(0));
    dot(pts[n - 1].x, pts[n - 1].y, radiusAt(n - 1));
  }
  done();
}

function drawNodeContent(ctx: CanvasLike, node: Node, assets?: AssetProvider, boxes?: BoxMap, origin?: { x: number; y: number }): void {
  const { width: w, height: h } = node.size;
  // Unknown / newer node type: inert placeholder using transform/size (FR-2).
  // Excluding it first lets the switch narrow cleanly to the known node types.
  if (isUnknownNode(node)) {
    placeholderBox(ctx, w, h);
    return;
  }
  switch (node.type) {
    case "text": {
      // Full line-break layout via @hc/text: word wrap, inline run flow, list
      // markers, paragraph spacing/indents. Uses the canvas's own measureText
      // (when present) so wrapping matches the device font metrics.
      const lctx = ctx as unknown as { letterSpacing?: string };
      const measure: MeasureFn | undefined = ctx.measureText
        ? (text, style) => {
            ctx.font = canvasFontString(style);
            // Include letter-spacing in the measurement so it matches the drawn
            // advance (the draw loop sets ctx.letterSpacing per segment).
            if ("letterSpacing" in (ctx as object)) lctx.letterSpacing = `${style.letterSpacing ?? 0}px`;
            return ctx.measureText!(text).width;
          }
        : undefined;
      const pad = node.box.padding ?? { t: 0, r: 0, b: 0, l: 0 };
      const contentW = w - pad.l - pad.r;
      // Background highlight hugs the TEXT per line, not the box.
      // Resolve its fill + padding/roundness once; the rects are drawn per line
      // (behind the glyphs) inside the line loop below.
      const hl = (node.textEffects ?? []).find((e) => e.kind === "highlight");
      const hlFill = hl ? resolveFill(ctx, hl.color, w, h) : null;
      const hlPad = hl ? Math.max(0, hl.padding ?? 0) : 0;
      const hlRad = hl ? Math.max(0, hl.radius ?? 0) : 0;
      // Glyph outline (hollow/outlined text) from an "outline" effect.
      const outline = (node.effects ?? []).find((e) => e.kind === "outline") as { color: { srgb: { r: number; g: number; b: number; a: number } }; width: number } | undefined;
      if (outline && "lineJoin" in (ctx as object)) (ctx as { lineJoin?: string }).lineJoin = "round";
      // Named text effects resolved once, applied behind/around the
      // run fill in the segment loop below. Shadows need a flat CSS color (a
      // gradient can't be a shadowColor), so resolve effect fills to a flat color.
      const tfx: TextEffect[] = node.textEffects ?? [];
      const eShadow = tfx.find((e) => e.kind === "shadow") as Extract<TextEffect, { kind: "shadow" }> | undefined;
      const eLift = tfx.find((e) => e.kind === "lift") as Extract<TextEffect, { kind: "lift" }> | undefined;
      const eGlow = tfx.find((e) => e.kind === "glow") as Extract<TextEffect, { kind: "glow" }> | undefined;
      const eNeon = tfx.find((e) => e.kind === "neon") as Extract<TextEffect, { kind: "neon" }> | undefined;
      const eEcho = tfx.find((e) => e.kind === "echo") as Extract<TextEffect, { kind: "echo" }> | undefined;
      const eHollow = tfx.find((e) => e.kind === "hollow") as Extract<TextEffect, { kind: "hollow" }> | undefined;
      const eSplice = tfx.find((e) => e.kind === "splice") as Extract<TextEffect, { kind: "splice" }> | undefined;
      const eOutlineFx = tfx.find((e) => e.kind === "outline") as Extract<TextEffect, { kind: "outline" }> | undefined;
      const fillVisible = !eHollow; // hollow = glyph outline only, no fill
      // Flat effect color with its alpha scaled: shadow `opacity` and glow
      // `intensity` are schema knobs that must actually dim the cast. One
      // flattener feeds both paths so shadow colors can't drift from other
      // effect colors, and colorToCss keeps channel clamping.
      const flatColorAlpha = (fill: Fill, mult: number): string => {
        const c = fill.type === "solid" ? fill.color : fill.type === "gradient" && fill.stops[0] ? fill.stops[0].color : { srgb: { r: 0, g: 0, b: 0, a: 1 } };
        const m = Math.max(0, Math.min(1, mult));
        return colorToCss({ srgb: { ...c.srgb, a: (c.srgb.a ?? 1) * m } });
      };
      const flatColor = (fill: Fill): string => flatColorAlpha(fill, 1);
      const sctx = ctx as unknown as { shadowColor: string; shadowBlur: number; shadowOffsetX: number; shadowOffsetY: number };
      const hasShadowApi = "shadowBlur" in (ctx as object);
      const clearShadow = () => { if (hasShadowApi) { sctx.shadowColor = "rgba(0,0,0,0)"; sctx.shadowBlur = 0; sctx.shadowOffsetX = 0; sctx.shadowOffsetY = 0; } };
      // Measure the cased text (upper/title change glyph widths) so center/right
      // alignment positions the actually-drawn text.
      type Seg = { text: string; style: typeof node.content[0]["runs"][0]["style"] };
      const segWidth = (s: Seg) => {
        const t = applyTextCase(s.text, s.style.case);
        return measure ? measure(t, s.style) : t.length * s.style.fontSize * 0.55;
      };
      // Visual advance of one segment at running position `pos`: tabs jump to the
      // next stop, sub/superscript glyphs are drawn at 0.66 size, everything else
      // is its measured width. The single source of truth for both the line-width
      // calc and the draw loop, so center/right/justify and the highlight rect
      // line up exactly with the painted glyphs (tabs and script included).
      const segAdvance = (s: Seg, pos: number, tabStops: number[] | undefined): number => {
        if (isTabRun(s.text)) return tabRunWidth(s.text, pos, tabStops, s.style.fontSize);
        if (s.style.script === "super" || s.style.script === "sub") {
          const t = applyTextCase(s.text, s.style.case);
          const ds = { ...s.style, fontSize: s.style.fontSize * 0.66 };
          return measure ? measure(t, ds) : t.length * ds.fontSize * 0.55;
        }
        return segWidth(s);
      };
      // True visual width of a line, walking left-to-right (a tab's width depends
      // on where it sits, so this must be sequential, not a sum).
      const lineAdvance = (segs: Seg[], tabStops: number[] | undefined) => {
        let pos = 0;
        for (const s of segs) pos += segAdvance(s, pos, tabStops);
        return pos;
      };
      // Always lay segments out left-to-right so each keeps its own font/color
      // (canvas textAlign would force one style across the whole line).
      ctx.textAlign = "left";
      const { lines } = layoutText(node, measure ? { measure } : {});
      // Vertical alignment within the box (top/middle/bottom): shift every line
      // by the slack between the laid-out text block and the box's content area.
      const vAlign = node.box.verticalAlign ?? "top";
      let vShift = 0;
      if (vAlign !== "top" && lines.length) {
        const last = lines[lines.length - 1];
        const used = last.y + last.height - pad.t;
        const slack = Math.max(0, h - pad.t - pad.b - used);
        vShift = vAlign === "middle" ? slack / 2 : slack;
      }
      const isWs = (t: string) => t.length > 0 && t.trim() === "";
      // Curved text: lay glyphs along a circular arc. Skips the
      // normal line loop; effects/lists are not combined with curve.
      const arcCurv = node.flow?.kind === "arc" ? node.flow.curvature : 0;
      for (let li = 0; !arcCurv && li < lines.length; li++) {
        const line = lines[li];
        const lineTabStops = node.content[line.paragraph]?.style?.tabStops;
        const align = line.align === "justify" ? "left" : line.align;
        const baseline = line.y + line.height + vShift;
        const lineWidth = lineAdvance(line.segments, lineTabStops);
        // Justify: spread slack across the line's whitespace segments, but never
        // on the last line of a paragraph (or a list line), matching print/CSS.
        const lastOfPara = li === lines.length - 1 || lines[li + 1].paragraph !== line.paragraph;
        // Column-aware origin/width: when the line carries a column (multi-column
        // text), align within that column; otherwise use the full content box, so
        // single-column layout is numerically unchanged.
        const colLeft = pad.l + (line.colLeft ?? 0);
        const colW = line.colWidth ?? contentW;
        let justifyExtra = 0;
        if (line.align === "justify" && !lastOfPara && !line.marker) {
          // Stretch spaces, not tabs (tabs are positional and keep their stops).
          const ws = line.segments.filter((s) => isWs(s.text) && !isTabRun(s.text)).length;
          const slack = (colLeft + colW) - (colLeft + line.x) - lineWidth;
          if (ws > 0 && slack > 0) justifyExtra = slack / ws;
        }
        // Start x for the whole line, honoring alignment + the line's indent.
        // List items always start after the marker gutter (text is not centered
        // away from its bullet), so use the indent for list lines.
        const startX =
          line.marker || align === "left"
            ? colLeft + line.x
            : align === "center"
              ? colLeft + (colW - lineWidth) / 2
              : colLeft + colW - lineWidth;
        // Per-line background highlight: a rounded rect hugging this line's
        // visible text (trailing whitespace trimmed), sized to the line's font.
        if (hl && hlFill) {
          let visW = lineWidth;
          for (let k = line.segments.length - 1; k >= 0; k--) {
            if (isWs(line.segments[k].text)) visW -= segWidth(line.segments[k]);
            else break;
          }
          if (visW > 0) {
            const fs = line.segments.reduce((m, s) => Math.max(m, s.style.fontSize), 0) || 16;
            const vpad = fs * 0.15;
            const rx = startX - hlPad;
            const ry = baseline - fs * 0.82 - vpad;
            const rw = visW + hlPad * 2;
            const rh = fs + vpad * 2;
            const rr = Math.min(hlRad, rh / 2);
            ctx.fillStyle = hlFill;
            if (rr > 0 && ctx.roundRect) { ctx.beginPath(); ctx.roundRect(rx, ry, rw, rh, rr); ctx.fill(); }
            else ctx.fillRect(rx, ry, rw, rh);
          }
        }
        if (line.marker) {
          ctx.font = canvasFontString(line.marker.style);
          ctx.fillStyle = line.marker.style.fill.type === "solid" ? colorToCss(line.marker.style.fill.color) : "rgba(0,0,0,1)";
          ctx.fillText(line.marker.text, pad.l + line.marker.x, baseline);
        }
        let x = startX;
        for (const seg of line.segments) {
          // Sub/superscript + baseline shift: smaller glyphs on a raised/lowered
          // baseline. Layout wrapped at full size; the visual advance uses the
          // drawn size so script glyphs sit tight.
          const script = seg.style.script;
          const scripted = script === "super" || script === "sub";
          const drawStyle = scripted ? { ...seg.style, fontSize: seg.style.fontSize * 0.66 } : seg.style;
          ctx.font = canvasFontString(drawStyle);
          if ("letterSpacing" in (ctx as object)) lctx.letterSpacing = `${seg.style.letterSpacing ?? 0}px`;
          // OpenType ligatures: Canvas2D can't toggle arbitrary features, but
          // `textRendering` switches the default ligature/kerning behavior, so
          // features.liga === 0 disables them ("optimizeSpeed"), else default.
          (ctx as unknown as { textRendering?: string }).textRendering = seg.style.features?.liga === 0 ? "optimizeSpeed" : "auto";
          const t = applyTextCase(seg.text, seg.style.case);
          // Advance for this segment, computed exactly as the line-width walk did
          // (tab stops from x-startX, 0.66 for script, measured otherwise) so the
          // glyphs land where alignment positioned the line.
          const stepW = segAdvance(seg, x - startX, lineTabStops);
          const fs = seg.style.fontSize;
          const baseY = baseline - (seg.style.baselineShift ?? 0) + (script === "super" ? -fs * 0.33 : script === "sub" ? fs * 0.16 : 0);
          // Solid or gradient run fill. A gradient spans the whole text box
          // (resolveFill works in the node's local 0..w/0..h space, the same space
          // the glyphs are drawn in) so it reads as one gradient across the text.
          const segCss = seg.style.fill.type === "solid"
            ? colorToCss(seg.style.fill.color)
            : seg.style.fill.type === "gradient"
              ? resolveFill(ctx, seg.style.fill, w, h)
              : "rgba(0,0,0,1)";
          if (!isWs(seg.text)) {
            // Echo: faded offset copies trailing behind the glyphs.
            if (eEcho && ctx.fillText) {
              const ecol = flatColor(eEcho.color);
              const n = Math.max(1, Math.min(8, Math.round(eEcho.count) || 3));
              const off = eEcho.offset || fs * 0.12;
              const g = ctx as { globalAlpha?: number };
              for (let i = n; i >= 1; i--) {
                const a = 0.3 * (1 - (i - 1) / (n + 1));
                const prev = typeof g.globalAlpha === "number" ? g.globalAlpha : 1;
                if (typeof g.globalAlpha === "number") g.globalAlpha = prev * a;
                ctx.fillStyle = ecol;
                ctx.fillText(t, x + off * i, baseY + off * i);
                if (typeof g.globalAlpha === "number") g.globalAlpha = prev;
              }
            }
            // Outline strokes: legacy node.effects outline, plus named outline/splice.
            if (outline && ctx.strokeText) { ctx.lineWidth = outline.width; ctx.strokeStyle = colorToCss(outline.color); ctx.strokeText(t, x, baseY); }
            if (eOutlineFx && ctx.strokeText) { ctx.lineWidth = Math.max(0.5, eOutlineFx.width); ctx.strokeStyle = resolveFill(ctx, eOutlineFx.color, w, h); ctx.strokeText(t, x, baseY); }
            if (eSplice && ctx.strokeText) { const o = eSplice.offset || 0; ctx.lineWidth = Math.max(0.5, eSplice.thickness); ctx.strokeStyle = flatColor(eSplice.color); ctx.strokeText(t, x + o, baseY + o); }
            // Glow / neon / shadow / lift cast via the canvas drop shadow.
            if (hasShadowApi) {
              if (eGlow) { const gi = Math.max(0.2, eGlow.intensity || 1); sctx.shadowColor = flatColorAlpha(eGlow.color, gi); sctx.shadowBlur = Math.max(0, eGlow.radius); sctx.shadowOffsetX = 0; sctx.shadowOffsetY = 0; }
              else if (eNeon) { sctx.shadowColor = flatColor(eNeon.color); sctx.shadowBlur = Math.max(4, fs * 0.5 * Math.max(0.2, eNeon.intensity || 1)); sctx.shadowOffsetX = 0; sctx.shadowOffsetY = 0; }
              else if (eShadow) { sctx.shadowColor = flatColorAlpha(eShadow.color, eShadow.opacity ?? 1); sctx.shadowBlur = Math.max(0, eShadow.blur); sctx.shadowOffsetX = eShadow.dx; sctx.shadowOffsetY = eShadow.dy; }
              else if (eLift) { const k = Math.max(0.1, eLift.intensity || 0.5); sctx.shadowColor = `rgba(0,0,0,${0.35 * k})`; sctx.shadowBlur = fs * 0.3 * k + 2; sctx.shadowOffsetX = 0; sctx.shadowOffsetY = fs * 0.06; }
            }
            if (fillVisible && ctx.fillText) {
              ctx.fillStyle = segCss;
              ctx.fillText(t, x, baseY);
              // Glow intensity above 1 brightens by stacking passes (the canvas
              // shadow alpha caps at the color's own); blur stays the Size knob's.
              if (eGlow && hasShadowApi && (eGlow.intensity ?? 1) > 1) {
                for (let gp = Math.min(2, Math.round(eGlow.intensity) - 1); gp > 0; gp--) ctx.fillText(t, x, baseY);
              }
            }
            clearShadow();
            // Neon: a crisp second pass so the bright core reads over the glow.
            if (eNeon && fillVisible && ctx.fillText) { ctx.fillStyle = segCss; ctx.fillText(t, x, baseY); }
            // Hollow: glyph outline only (no fill drawn above).
            if (eHollow && ctx.strokeText) { ctx.lineWidth = Math.max(0.5, eHollow.thickness || Math.max(1, fs / 16)); ctx.strokeStyle = segCss; ctx.strokeText(t, x, baseY); }
          }
          // Underline / strikethrough decoration, drawn in the run's own color.
          const dec = seg.style.decoration;
          if (dec && dec.length && ctx.beginPath) {
            ctx.strokeStyle = segCss;
            ctx.lineWidth = Math.max(1, fs / 16);
            if (dec.includes("underline")) {
              const uy = baseY + fs * 0.12;
              ctx.beginPath(); ctx.moveTo(x, uy); ctx.lineTo(x + stepW, uy); ctx.stroke();
            }
            if (dec.includes("strikethrough")) {
              const sy = baseY - fs * 0.3;
              ctx.beginPath(); ctx.moveTo(x, sy); ctx.lineTo(x + stepW, sy); ctx.stroke();
            }
          }
          // Hyperlink runs get an underline cue (unless already underlined), in
          // the run's own color, so links read as links on the canvas.
          if (seg.style.link && !isWs(seg.text) && !(dec && dec.includes("underline")) && ctx.beginPath) {
            ctx.strokeStyle = segCss;
            ctx.lineWidth = Math.max(1, fs / 16);
            const uy = baseY + fs * 0.12;
            ctx.beginPath(); ctx.moveTo(x, uy); ctx.lineTo(x + stepW, uy); ctx.stroke();
          }
          x += stepW + (justifyExtra && isWs(seg.text) && !isTabRun(seg.text) ? justifyExtra : 0);
        }
      }
      // Curved text: place each glyph on a circle so arc length == text width.
      // Positive curvature bows up (rainbow), negative bows down. Rotation keeps
      // each glyph tangent to the arc; composed via transform() (translate+rotate).
      if (arcCurv && ctx.save && ctx.restore && ctx.fillText) {
        const glyphs: { ch: string; style: Seg["style"] }[] = [];
        for (const p of node.content) for (const run of p.runs) {
          for (const ch of Array.from(applyTextCase(run.text, run.style.case))) glyphs.push({ ch, style: run.style });
        }
        const adv = glyphs.map((g) => (measure ? measure(g.ch, g.style) : g.ch.length * g.style.fontSize * 0.55));
        const W = adv.reduce((s, a) => s + a, 0);
        if (W > 0) {
          const theta = Math.max(-3, Math.min(3, arcCurv));
          const R = W / Math.abs(theta);
          const up = theta > 0;
          const cx = pad.l + contentW / 2;
          const yBase = h / 2;
          const cy = up ? yBase + R : yBase - R;
          ctx.textAlign = "center";
          let s = 0;
          for (let i = 0; i < glyphs.length; i++) {
            const g = glyphs[i];
            const phi = (s + adv[i] / 2 - W / 2) / R;
            const gx = cx + R * Math.sin(phi);
            const gy = up ? cy - R * Math.cos(phi) : cy + R * Math.cos(phi);
            const rot = up ? phi : -phi;
            ctx.save();
            ctx.transform(Math.cos(rot), Math.sin(rot), -Math.sin(rot), Math.cos(rot), gx, gy);
            ctx.font = canvasFontString(g.style);
            ctx.fillStyle = g.style.fill.type === "solid"
              ? colorToCss(g.style.fill.color)
              : g.style.fill.type === "gradient" && g.style.fill.stops[0]
                ? colorToCss(g.style.fill.stops[0].color)
                : "rgba(0,0,0,1)";
            ctx.fillText(g.ch, 0, 0);
            ctx.restore();
            s += adv[i];
          }
          ctx.textAlign = "left";
        }
      }
      if ("letterSpacing" in (ctx as object)) lctx.letterSpacing = "0px";
      break;
    }
    case "shape":
      drawShape(ctx, node, assets);
      break;
    case "line": {
      const pts = node.points;
      if (pts.length >= 2) {
        const col = resolveFill(ctx, node.stroke.fill, w, h);
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        setStroke(ctx, node.stroke.width, col);
        if (node.endCap === "arrow") arrowhead(ctx, pts[pts.length - 2], pts[pts.length - 1], node.stroke.width, col);
        if (node.startCap === "arrow") arrowhead(ctx, pts[1], pts[0], node.stroke.width, col);
      }
      break;
    }
    case "path": {
      const segs = node.segments;
      // Compound path: all contours join the primary one so interior contours
      // cut holes under the even-odd fill rule. A node whose primary contour
      // is degenerate still draws its remaining contours.
      const contours = node.contours?.filter((c) => c.segments.length >= 2) ?? [];
      if (segs.length >= 2 || contours.length) {
        const segTo = (from: typeof segs[0], to: typeof segs[0]) => {
          if ((from.cOut || to.cIn) && ctx.bezierCurveTo) {
            const c1 = from.cOut ?? { x: from.x, y: from.y };
            const c2 = to.cIn ?? { x: to.x, y: to.y };
            ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, to.x, to.y);
          } else {
            ctx.lineTo(to.x, to.y);
          }
        };
        const trace = (ss: typeof segs, closed: boolean) => {
          ctx.moveTo(ss[0].x, ss[0].y);
          for (let i = 1; i < ss.length; i++) segTo(ss[i - 1], ss[i]);
          if (closed) {
            segTo(ss[ss.length - 1], ss[0]);
            ctx.closePath();
          }
        };
        ctx.beginPath();
        if (segs.length >= 2) trace(segs, node.closed);
        for (const c of contours) trace(c.segments, c.closed);
        if (node.fills && node.fills.length > 0) {
          ctx.fillStyle = resolveFill(ctx, node.fills[0], w, h);
          if (contours.length) ctx.fill("evenodd");
          else ctx.fill();
        }
        if (node.stroke) setStroke(ctx, node.stroke.width, resolveFill(ctx, node.stroke.fill, w, h));
      }
      break;
    }
    case "boolean": {
      const r = node.result;
      if (r && r.subpaths.length > 0) {
        ctx.beginPath();
        for (const sp of r.subpaths) {
          const as = sp.anchors;
          if (as.length < 2) continue;
          ctx.moveTo(as[0].x, as[0].y);
          for (let i = 1; i < as.length; i++) ctx.lineTo(as[i].x, as[i].y);
          if (sp.closed) ctx.closePath();
        }
        if (node.fills && node.fills.length > 0) {
          ctx.fillStyle = resolveFill(ctx, node.fills[0], w, h);
          ctx.fill(); // nonzero winding renders holes from the clipper correctly
        }
        if (node.stroke) setStroke(ctx, node.stroke.width, resolveFill(ctx, node.stroke.fill, w, h));
      } else {
        placeholderBox(ctx, w, h);
      }
      break;
    }
    case "connector":
      // Whiteboard/diagram connector: a routed polyline between
      // two endpoints, resolved against the live node box map so it re-routes
      // when a connected node moves. Drawn in the connector's local space.
      drawConnector(ctx, node, boxes ?? {}, origin ?? { x: 0, y: 0 });
      break;
    case "ink":
      // Board-native ink stroke (pen/marker/highlighter) drawn in local space.
      drawInk(ctx, node);
      break;
    case "frame": {
      const hasFill = !!node.fills && node.fills.length > 0;
      if (hasFill) {
        ctx.fillStyle = resolveFill(ctx, node.fills![0], w, h);
        ctx.fillRect(0, 0, w, h);
      }
      // Section chrome for NON-clipping frames (e.g. whiteboard sections
      // FR-3): a faint surface when unfilled, a visible boundary, and the name
      // label above the top edge - so an empty section is not invisible. Clipping
      // frames (design image frames) keep their plain fill-only look.
      if (!node.clip) {
        if (!hasFill) {
          ctx.fillStyle = "rgba(148, 163, 184, 0.07)";
          ctx.fillRect(0, 0, w, h);
        }
        ctx.strokeStyle = "rgba(100, 116, 139, 0.55)";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(0.75, 0.75, Math.max(0, w - 1.5), Math.max(0, h - 1.5));
        if (typeof node.name === "string" && node.name.length > 0) {
          const fs = 14;
          ctx.font = `600 ${fs}px ${"system-ui, sans-serif"}`;
          ctx.fillStyle = "rgba(71, 85, 105, 0.95)";
          ctx.textAlign = "left";
          ctx.fillText(node.name, 2, -7);
        }
      }
      break;
    }
    case "image":
      drawImageNode(ctx, node, w, h, assets);
      break;
    case "video":
      drawMedia(ctx, w, h, node.assetId, assets);
      break;
    case "table":
      drawTable(ctx, node, w, h);
      break;
    case "chart":
      drawChart(ctx, node, w, h);
      break;
    case "qr":
      drawQr(ctx, node, w, h);
      break;
    case "icon":
    case "sticker":
    case "embed": // never a live iframe in-canvas (Section 10): poster/placeholder only
      placeholderBox(ctx, w, h);
      break;
    case "sticky": {
      // Whiteboard sticky note: a paper card with a soft drop
      // shadow (lifts it off the board), near-square corners, a faint top-down
      // sheen, and a folded bottom-right corner - so it reads as a sticky, not a
      // rounded box. `fontScale` is the auto-fit multiplier from @hc/whiteboard.
      const radius = Math.min(2, w / 2, h / 2);
      const base = node.fill && node.fill.type === "solid" ? node.fill.color.srgb : null;
      const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
      const rgba = (r: number, g: number, b: number, a: number) =>
        `rgba(${Math.round(clamp01(r) * 255)},${Math.round(clamp01(g) * 255)},${Math.round(clamp01(b) * 255)},${a})`;

      // Card fill: a subtle vertical gradient (lighter at the top) for paper
      // depth, falling back to the solid fill when gradients aren't available.
      let cardFill: string | CanvasGradientLike = resolveFill(ctx, node.fill, w, h);
      if (base && ctx.createLinearGradient) {
        const g = ctx.createLinearGradient(0, 0, 0, h);
        g.addColorStop(0, rgba(base.r + (1 - base.r) * 0.12, base.g + (1 - base.g) * 0.12, base.b + (1 - base.b) * 0.12, base.a));
        g.addColorStop(1, rgba(base.r * 0.96, base.g * 0.96, base.b * 0.96, base.a));
        cardFill = g;
      }

      // Soft drop shadow under the card.
      const canShadow = "shadowColor" in ctx;
      if (canShadow) {
        ctx.shadowColor = "rgba(15, 23, 42, 0.20)";
        ctx.shadowBlur = Math.min(18, Math.max(6, w * 0.06));
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = Math.min(10, Math.max(3, h * 0.035));
      }
      ctx.fillStyle = cardFill;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(0, 0, w, h, radius);
      else ctx.rect(0, 0, w, h);
      ctx.fill();
      // Clear the shadow before drawing details on top of the card.
      if (canShadow) {
        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
      }

      // Folded bottom-right corner: a darker triangle of the fill suggests the
      // peeled underside of a paper note.
      const fold = Math.min(22, w * 0.16, h * 0.16);
      if (fold > 5) {
        ctx.fillStyle = base ? rgba(base.r * 0.8, base.g * 0.8, base.b * 0.8, base.a) : "rgba(0,0,0,0.12)";
        ctx.beginPath();
        ctx.moveTo(w - fold, h);
        ctx.lineTo(w, h - fold);
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fill();
      }
      if (node.text) {
        const pad = 12;
        const fontPx = 20 * (node.fontScale || 1);
        ctx.font = `${fontPx}px ${node.fontFamily ?? "sans-serif"}`;
        ctx.fillStyle = colorToCss(node.textColor);
        const maxW = Math.max(1, w - pad * 2);
        const measure = (s: string) => (ctx.measureText ? ctx.measureText(s).width : s.length * fontPx * 0.55);
        // Word-wrap into lines that fit maxW.
        const lines: string[] = [];
        for (const para of node.text.split("\n")) {
          let line = "";
          for (const word of para.split(/(\s+)/)) {
            const next = line + word;
            if (line && measure(next) > maxW) {
              lines.push(line.trimEnd());
              line = word.trimStart();
            } else {
              line = next;
            }
          }
          lines.push(line.trimEnd());
        }
        const lineH = fontPx * 1.25;
        const blockH = lines.length * lineH;
        let y = Math.max(pad, (h - blockH) / 2) + fontPx;
        const align = node.align ?? "left";
        ctx.textAlign = align;
        const x = align === "center" ? w / 2 : align === "right" ? w - pad : pad;
        for (const line of lines) {
          if (y > h) break;
          ctx.fillText(line, x, y);
          y += lineH;
        }
      }
      break;
    }
    case "stamp":
      drawStamp(ctx, node, w, h);
      break;
    case "group":
    case "grid":
    case "audio":
      break; // no own surface
    default:
      placeholderBox(ctx, w, h);
  }
}

/** Draw an emoji / vote stamp (FR-21): the glyph centered and scaled to the node
 *  box. Emoji render via the platform emoji font; a vote marker is just its
 *  glyph (e.g. a dot). Pure local-space, like the other leaf renderers. */
function drawStamp(ctx: CanvasLike, node: Node, w: number, h: number): void {
  const s = node as unknown as { glyph?: string };
  const glyph = s.glyph || "👍";
  const fs = Math.max(4, Math.min(w, h) * 0.82);
  ctx.font = `${fs}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", system-ui, sans-serif`;
  if ("textAlign" in ctx) (ctx as { textAlign: string }).textAlign = "center";
  if ("textBaseline" in ctx) (ctx as { textBaseline: string }).textBaseline = "middle";
  ctx.fillStyle = "#0f172a";
  ctx.fillText(glyph, w / 2, h / 2);
  // Restore the engine's default baseline so later glyph draws are unaffected.
  if ("textBaseline" in ctx) (ctx as { textBaseline: string }).textBaseline = "alphabetic";
}

/** Draw a QR code from its precomputed module matrix, with a quiet-zone margin. */
function drawQr(ctx: CanvasLike, node: Node, w: number, h: number): void {
  const qr = node as unknown as { modules?: boolean[][]; foreground?: { srgb: { r: number; g: number; b: number; a: number } }; background?: { srgb: { r: number; g: number; b: number; a: number } } };
  const m = qr.modules;
  if (!m || !m.length) {
    placeholderBox(ctx, w, h);
    return;
  }
  const n = m.length;
  const quiet = 4; // standard 4-module quiet zone
  const total = n + quiet * 2;
  const cell = Math.min(w, h) / total;
  const ox = (w - cell * total) / 2 + quiet * cell;
  const oy = (h - cell * total) / 2 + quiet * cell;
  ctx.fillStyle = qr.background ? colorToCss(qr.background) : "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = qr.foreground ? colorToCss(qr.foreground) : "#000000";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (m[r][c]) ctx.fillRect(ox + c * cell, oy + r * cell, cell + 0.5, cell + 0.5);
    }
  }
}

/** Filled arrowhead at `tip`, pointing away from `from` (for line end caps). */
function arrowhead(ctx: CanvasLike, from: { x: number; y: number }, tip: { x: number; y: number }, width: number, color: string | CanvasGradientLike): void {
  const a = Math.atan2(tip.y - from.y, tip.x - from.x);
  const len = Math.max(8, width * 3.5);
  const spread = Math.PI / 7;
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(tip.x - len * Math.cos(a - spread), tip.y - len * Math.sin(a - spread));
  ctx.lineTo(tip.x - len * Math.cos(a + spread), tip.y - len * Math.sin(a + spread));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

/** Linear interpolation between two sRGB colors (t in 0..1), for color scales. */
function lerpColor(a: Color, b: Color, t: number): Color {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  const mix = (x: number, y: number) => x + (y - x) * u;
  return {
    srgb: {
      r: mix(a.srgb.r, b.srgb.r),
      g: mix(a.srgb.g, b.srgb.g),
      b: mix(a.srgb.b, b.srgb.b),
      a: mix(a.srgb.a ?? 1, b.srgb.a ?? 1),
    },
  };
}

/** Draw a table: per-cell fills (incl. styled header row + conditional rules) +
 *  text, then grid lines honoring the optional border style. */
function drawTable(ctx: CanvasLike, node: TableNode, w: number, h: number): void {
  const xs = [0];
  for (const cw of node.colWidths) xs.push(xs[xs.length - 1] + cw);
  const ys = [0];
  for (const rh of node.rowHeights) ys.push(ys[ys.length - 1] + rh);
  const totalW = xs[xs.length - 1] || w;
  const totalH = ys[ys.length - 1] || h;

  const header = node.headerStyle;
  const headerRows = header?.enabled ? 1 : 0;
  const rules = node.conditional ?? [];
  // Numeric value of a cell ("1,234", "45%", "$9" all parse), or NaN.
  const cellNum = (c: TableNode["cells"][number]): number =>
    parseFloat(String(c.content?.[0]?.text ?? "").replace(/[,%$\s]/g, ""));
  // Cache per-scope numeric ranges (column index, or -1 for the whole data area).
  const rangeCache = new Map<number, { min: number; max: number }>();
  const rangeFor = (column?: number): { min: number; max: number } => {
    const key = column ?? -1;
    const hit = rangeCache.get(key);
    if (hit) return hit;
    let min = Infinity, max = -Infinity;
    for (const c of node.cells) {
      if (c.row < headerRows) continue;
      if (column !== undefined && c.col !== column) continue;
      const n = cellNum(c);
      if (Number.isFinite(n)) { if (n < min) min = n; if (n > max) max = n; }
    }
    const r = { min, max };
    rangeCache.set(key, r);
    return r;
  };
  const cmp = (a: number, op: string, b: number): boolean =>
    op === ">" ? a > b : op === "<" ? a < b : op === ">=" ? a >= b : op === "<=" ? a <= b : op === "==" ? a === b : a !== b;

  for (const cell of node.cells) {
    const cx = xs[cell.col] ?? 0;
    const cy = ys[cell.row] ?? 0;
    const cw = (xs[cell.col + (cell.colSpan || 1)] ?? totalW) - cx;
    const ch = (ys[cell.row + (cell.rowSpan || 1)] ?? totalH) - cy;
    const isHeader = !!header?.enabled && cell.row === 0;

    // Conditional formatting (data cells only): derive a fill / text color and an
    // optional data-bar from the cell's numeric value. Later rules win.
    let ruleFill: string | CanvasGradientLike | undefined;
    let ruleText: Color | undefined;
    let dataBar: { css: string; frac: number } | undefined;
    if (!isHeader && rules.length) {
      const val = cellNum(cell);
      if (Number.isFinite(val)) {
        for (const rule of rules) {
          if (rule.column !== undefined && rule.column !== cell.col) continue;
          if (rule.kind === "highlight") {
            if (cmp(val, rule.op, rule.value)) {
              if (rule.fill) ruleFill = resolveFill(ctx, rule.fill, cw, ch);
              if (rule.textColor) ruleText = rule.textColor;
            }
          } else if (rule.kind === "colorScale") {
            const { min, max } = rangeFor(rule.column);
            const t = max > min ? (val - min) / (max - min) : 0;
            ruleFill = colorToCss(lerpColor(rule.min, rule.max, t));
          } else {
            const { min, max } = rangeFor(rule.column);
            const t = max > min ? (val - min) / (max - min) : 0;
            dataBar = { css: colorToCss(rule.color), frac: Math.max(0, Math.min(1, t)) };
          }
        }
      }
    }

    // Conditional fill > per-cell fill > header fill (first row).
    const baseFill = cell.fill ?? (isHeader ? header?.fill : undefined);
    if (ruleFill) {
      ctx.fillStyle = ruleFill;
      ctx.fillRect(cx, cy, cw, ch);
    } else if (baseFill) {
      ctx.fillStyle = resolveFill(ctx, baseFill, cw, ch);
      ctx.fillRect(cx, cy, cw, ch);
    }
    if (dataBar) {
      ctx.save();
      ctx.globalAlpha = ctx.globalAlpha * 0.45;
      ctx.fillStyle = dataBar.css;
      ctx.fillRect(cx + 1, cy + 1, Math.max(0, (cw - 2) * dataBar.frac), ch - 2);
      ctx.restore();
    }

    const run = cell.content?.[0];
    if (run?.text) {
      const size = run.fontSize ?? 14;
      const bold = isHeader && header?.bold !== false;
      const weight = bold ? Math.max(700, run.weight ?? 700) : run.weight ?? 400;
      ctx.font = `${run.italic ? "italic " : ""}${weight} ${size}px ${fontFamilyStack("system")}`;
      // Conditional text color > header text color > cell text color > run color.
      const textColor = ruleText ?? (isHeader ? header?.textColor : undefined) ?? cell.textColor ?? run.color;
      ctx.fillStyle = textColor ? colorToCss(textColor) : "#18181b";
      const align = cell.align ?? "left";
      ctx.textAlign = align;
      const tx = align === "center" ? cx + cw / 2 : align === "right" ? cx + cw - 6 : cx + 6;
      ctx.fillText(run.text, tx, cy + size + 6);
    }
  }

  const bs = node.borderStyle;
  if (bs && bs.show === false) return; // borders explicitly hidden
  const borderColor = bs?.color ? colorToCss(bs.color) : node.borders ? resolveFill(ctx, node.borders.fill, totalW, totalH) : "#d4d4d8";
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = bs?.width ?? node.borders?.width ?? 1;
  ctx.beginPath();
  for (const gx of xs) { ctx.moveTo(gx, 0); ctx.lineTo(gx, totalH); }
  for (const gy of ys) { ctx.moveTo(0, gy); ctx.lineTo(totalW, gy); }
  ctx.stroke();
}

function seriesColor(s: { color?: { srgb: { r: number; g: number; b: number; a: number } } }, i: number): string {
  return s.color ? colorToCss(s.color) : SERIES_PALETTE_HEX[i % SERIES_PALETTE_HEX.length];
}

/** Draw the formatted numeric value above/at a point (chart data labels). */
function valueLabel(ctx: CanvasLike, text: string, x: number, y: number): void {
  ctx.font = `500 10px ${fontFamilyStack("system")}`;
  ctx.fillStyle = "#52525b";
  ctx.textAlign = "center";
  ctx.fillText(text, x, y);
}

/** Approximate text width using measureText when the context supports it, else
 *  a per-character estimate (about 6px at the legend's 11px font). */
function textWidth(ctx: CanvasLike, text: string): number {
  if (ctx.measureText) {
    try { return ctx.measureText(text).width; } catch { /* fall through */ }
  }
  return text.length * 6;
}

/** Truncate `text` with a trailing ellipsis so it fits within `maxWidth` px. */
function ellipsize(ctx: CanvasLike, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (textWidth(ctx, text) <= maxWidth) return text;
  const ell = "…";
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (textWidth(ctx, text.slice(0, mid) + ell) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo) + ell : "";
}

/** Draw the legend swatches+labels along one edge of the chart node. Labels are
 *  clipped/ellipsized to stay within the band chartInsets reserves (a vertical
 *  band of 80px, the full width for top/bottom) so many or long series names
 *  never overrun the node bounds or overlap the plot. */
function drawLegend(ctx: CanvasLike, node: ChartNode, w: number, h: number, position: string): void {
  const series = node.series ?? [];
  if (series.length === 0) return;
  ctx.font = `500 11px ${fontFamilyStack("system")}`;
  ctx.textAlign = "left";
  const sw = 10, gap = 6, rowH = 16, itemGap = 16;
  if (position === "top" || position === "bottom") {
    const y = position === "top" ? 4 : h - rowH + 4;
    const maxX = w - 8; // keep within the node's right edge
    let x = 8;
    for (let j = 0; j < series.length; j++) {
      if (x + sw + gap >= maxX) break; // no room left for another item
      ctx.fillStyle = seriesColor(series[j], j);
      ctx.fillRect(x, y, sw, sw);
      const labelX = x + sw + gap;
      const label = ellipsize(ctx, series[j].name, maxX - labelX);
      ctx.fillStyle = "#3f3f46";
      ctx.fillText(label, labelX, y + sw);
      x = labelX + textWidth(ctx, label) + itemGap;
    }
  } else {
    // chartInsets reserves 80px on the legend side; keep labels inside it.
    const band = 80;
    const x = position === "left" ? 6 : w - band + 6;
    const labelMax = band - sw - gap - 6;
    let y = 10;
    for (let j = 0; j < series.length; j++) {
      if (y + sw > h) break; // ran out of vertical room
      ctx.fillStyle = seriesColor(series[j], j);
      ctx.fillRect(x, y, sw, sw);
      ctx.fillStyle = "#3f3f46";
      ctx.fillText(ellipsize(ctx, series[j].name, labelMax), x + sw + gap, y + sw);
      y += rowH;
    }
  }
}

/** Format a numeric Y-axis tick label compactly (drop trailing zeros). */
function tickLabel(v: number): string {
  if (!Number.isFinite(v)) return "";
  return String(Math.round(v * 100) / 100);
}

/** Draw the left Y axis: a vertical line, evenly spaced tick marks, and value
 *  labels from 0 to `maxV`. Stays within the reserved left inset (labels are
 *  right-aligned just left of the axis). For value-based charts only. */
function drawYAxis(ctx: CanvasLike, x0: number, y0: number, ph: number, maxV: number): void {
  const ticks = tickCount(ph);
  ctx.strokeStyle = "#d4d4d8";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x0, y0 + ph);
  ctx.stroke();
  ctx.font = `500 9px ${fontFamilyStack("system")}`;
  ctx.fillStyle = "#52525b";
  ctx.textAlign = "right";
  for (let t = 0; t <= ticks; t++) {
    const frac = t / ticks;
    const ty = y0 + ph - frac * ph;
    ctx.strokeStyle = "#d4d4d8";
    ctx.beginPath();
    ctx.moveTo(x0 - 3, ty);
    ctx.lineTo(x0, ty);
    ctx.stroke();
    ctx.fillText(tickLabel(maxV * frac), x0 - 5, ty + 3);
  }
}

/** Chart types that plot values against a numeric Y axis (so a Y axis with
 *  ticks/labels is meaningful). Pie/donut/radar and the placeholder types are
 *  excluded. */
function hasValueAxis(type: ChartType): boolean {
  return type === "bar" || type === "barStacked" || type === "barGrouped" ||
    type === "line" || type === "area" || type === "scatter";
}

/** Insets the plot rect to make room for title, legend, and axis labels. */
function chartInsets(node: ChartNode, w: number, h: number): { x0: number; y0: number; pw: number; ph: number } {
  const style = node.style;
  let top = 14, bottom = 14, left = 14, right = 14;
  if (style?.title) top += 18;
  if (style?.legend?.show) {
    const pos = style.legend.position;
    if (pos === "top") top += 18;
    else if (pos === "bottom") bottom += 18;
    else if (pos === "left") left += 80;
    else right += 80;
  }
  if (style?.axes?.yLabel) left += 14;
  if (style?.axes?.xLabel) bottom += 14;
  // Reserve room for Y tick labels when a value axis is drawn.
  if (style?.axes?.showY !== false && hasValueAxis(node.chartType)) left += 22;
  return { x0: left, y0: top, pw: Math.max(1, w - left - right), ph: Math.max(1, h - top - bottom) };
}

/** Draw the optional chart title and axis labels (rendered as native text). */
function drawChartChrome(ctx: CanvasLike, node: ChartNode, w: number, h: number): void {
  const style = node.style;
  if (!style) return;
  if (style.title) {
    ctx.font = `600 13px ${fontFamilyStack("system")}`;
    ctx.fillStyle = "#18181b";
    ctx.textAlign = "center";
    ctx.fillText(style.title, w / 2, 14);
  }
  if (style.axes?.xLabel) {
    ctx.font = `500 11px ${fontFamilyStack("system")}`;
    ctx.fillStyle = "#52525b";
    ctx.textAlign = "center";
    ctx.fillText(style.axes.xLabel, w / 2, h - 4);
  }
  if (style.axes?.yLabel) {
    ctx.font = `500 11px ${fontFamilyStack("system")}`;
    ctx.fillStyle = "#52525b";
    ctx.textAlign = "center";
    ctx.fillText(style.axes.yLabel, 8, h / 2);
  }
  if (style.legend?.show) drawLegend(ctx, node, w, h, style.legend.position);
}

/** Draw the supported chart types as native vector + text. Unsupported types
 *  (gauge/funnel/progress) fall back to a placeholder. */
function drawChart(ctx: CanvasLike, node: ChartNode, w: number, h: number): void {
  const series = node.series ?? [];
  if (series.length === 0) { placeholderBox(ctx, w, h); return; }
  const type = node.chartType;
  const showValues = node.style?.valueLabels === true;
  drawChartChrome(ctx, node, w, h);

  if (type === "pie" || type === "donut") {
    if (!ctx.ellipse) { placeholderBox(ctx, w, h); return; } // no arc support
    const { x0, y0, pw, ph } = chartInsets(node, w, h);
    const vals = series[0].values;
    const total = vals.reduce((a, b) => a + Math.max(0, b), 0) || 1;
    const cx = x0 + pw / 2, cy = y0 + ph / 2;
    const r = Math.max(2, Math.min(pw, ph) / 2);
    let a0 = -Math.PI / 2;
    for (let i = 0; i < vals.length; i++) {
      const a1 = a0 + (Math.max(0, vals[i]) / total) * Math.PI * 2;
      const col = SERIES_PALETTE_HEX[i % SERIES_PALETTE_HEX.length];
      if (type === "donut") {
        ctx.beginPath();
        ctx.ellipse(cx, cy, r * 0.78, r * 0.78, 0, a0, a1);
        ctx.strokeStyle = col;
        ctx.lineWidth = r * 0.42;
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.ellipse(cx, cy, r, r, 0, a0, a1);
        ctx.closePath();
        ctx.fillStyle = col;
        ctx.fill();
      }
      if (showValues) {
        const mid = (a0 + a1) / 2;
        valueLabel(ctx, String(vals[i]), cx + Math.cos(mid) * r * 0.6, cy + Math.sin(mid) * r * 0.6);
      }
      a0 = a1;
    }
    return;
  }

  const { x0, y0, pw, ph } = chartInsets(node, w, h);
  const n = categoryCount(node.categories ?? [], series);
  if (n === 0) { placeholderBox(ctx, w, h); return; }

  if (type === "radar") {
    drawRadar(ctx, node, x0 + pw / 2, y0 + ph / 2, Math.max(2, Math.min(pw, ph) / 2), n);
    return;
  }

  if (type === "scatter") {
    drawScatter(ctx, node, x0, y0, pw, ph, n, showValues);
    return;
  }

  const stacked = type === "barStacked";
  const maxV = (stacked ? stackedMax(series, n) : seriesMax(series)) || 1;

  // baseline (x axis), drawn unless the x axis is explicitly hidden
  if (node.style?.axes?.showX !== false) {
    ctx.strokeStyle = "#d4d4d8";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y0 + ph);
    ctx.lineTo(x0 + pw, y0 + ph);
    ctx.stroke();
  }
  // left value (y) axis with ticks/labels, unless explicitly hidden
  if (node.style?.axes?.showY !== false) drawYAxis(ctx, x0, y0, ph, maxV);

  if (type === "bar" || type === "barGrouped" || type === "barStacked") {
    for (let i = 0; i < n; i++) {
      if (stacked) {
        const slot = pw / n;
        const barW = slot * 0.6;
        const bx = x0 + i * slot + (slot - barW) / 2;
        for (let j = 0; j < series.length; j++) {
          const v = Math.max(0, series[j].values[i] ?? 0);
          const bh = (v / maxV) * ph;
          const base = stackedBase(series, i, j);
          const by = y0 + ph - ((base + v) / maxV) * ph;
          ctx.fillStyle = seriesColor(series[j], j);
          ctx.fillRect(bx, by, barW, bh);
          if (showValues && v > 0) valueLabel(ctx, String(series[j].values[i]), bx + barW / 2, by + 10);
        }
      } else {
        for (let j = 0; j < series.length; j++) {
          const v = series[j].values[i] ?? 0;
          const bh = (Math.max(0, v) / maxV) * ph;
          const g = groupedBarLayout(pw, n, series.length, i, j);
          ctx.fillStyle = seriesColor(series[j], j);
          ctx.fillRect(x0 + g.x, y0 + ph - bh, g.width * 0.9, bh);
          if (showValues) valueLabel(ctx, String(v), x0 + g.x + g.width * 0.45, y0 + ph - bh - 3);
        }
      }
    }
    return;
  }

  // line / area
  const step = n > 1 ? pw / (n - 1) : 0;
  for (let j = 0; j < series.length; j++) {
    const col = seriesColor(series[j], j);
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const v = series[j].values[i] ?? 0;
      const px = x0 + i * step;
      const py = y0 + ph - (Math.max(0, v) / maxV) * ph;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    if (type === "area") {
      ctx.lineTo(x0 + (n - 1) * step, y0 + ph);
      ctx.lineTo(x0, y0 + ph);
      ctx.closePath();
      ctx.fillStyle = col;
      const prevAlpha = ctx.globalAlpha;
      ctx.globalAlpha = prevAlpha * 0.35;
      ctx.fill();
      ctx.globalAlpha = prevAlpha;
    } else {
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (showValues) {
      for (let i = 0; i < n; i++) {
        const v = series[j].values[i] ?? 0;
        valueLabel(ctx, String(v), x0 + i * step, y0 + ph - (Math.max(0, v) / maxV) * ph - 4);
      }
    }
  }
}

/** Scatter: each series' values plotted against their category index. */
function drawScatter(ctx: CanvasLike, node: ChartNode, x0: number, y0: number, pw: number, ph: number, n: number, showValues: boolean): void {
  const series = node.series ?? [];
  const maxV = seriesMax(series) || 1;
  if (node.style?.axes?.showX !== false) {
    ctx.strokeStyle = "#d4d4d8";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y0 + ph);
    ctx.lineTo(x0 + pw, y0 + ph);
    ctx.stroke();
  }
  if (node.style?.axes?.showY !== false) drawYAxis(ctx, x0, y0, ph, maxV);
  const step = n > 1 ? pw / (n - 1) : 0;
  for (let j = 0; j < series.length; j++) {
    ctx.fillStyle = seriesColor(series[j], j);
    for (let i = 0; i < series[j].values.length; i++) {
      const v = series[j].values[i] ?? 0;
      const px = x0 + i * step;
      const py = y0 + ph - (Math.max(0, v) / maxV) * ph;
      if (ctx.ellipse) {
        ctx.beginPath();
        ctx.ellipse(px, py, 4, 4, 0, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(px - 3, py - 3, 6, 6);
      }
      if (showValues) valueLabel(ctx, String(v), px, py - 6);
    }
  }
}

/** Radar/spider: each series is a closed polygon over the category axes. */
function drawRadar(ctx: CanvasLike, node: ChartNode, cx: number, cy: number, radius: number, n: number): void {
  const series = node.series ?? [];
  const maxV = seriesMax(series) || 1;
  // axis web
  ctx.strokeStyle = "#e4e4e7";
  ctx.lineWidth = 1;
  for (let i = 0; i < n; i++) {
    const p = radarPoint(cx, cy, radius, i, n, maxV, maxV);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }
  for (let j = 0; j < series.length; j++) {
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const v = series[j].values[i] ?? 0;
      const p = radarPoint(cx, cy, radius, i, n, v, maxV);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.strokeStyle = seriesColor(series[j], j);
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function paint(
  ctx: CanvasLike,
  sn: SceneNode,
  parentAlpha: number,
  opts: Render2DOptions,
  boxes: BoxMap,
  cull: { x: number; y: number; w: number; h: number; zoom: number } | null,
): void {
  const node = sn.node;
  if (node.hidden || node.id === opts.skipNodeId || opts.hiddenIds?.has(node.id)) return;
  const { width: w, height: h } = node.size;

  // Viewport culling + LOD (FR-27): skip leaf nodes fully outside the viewport,
  // and sub-pixel leaves when zoomed out, so render cost tracks visible detail.
  // Containers always descend (their own box may not bound overflowing children);
  // connectors route beyond their own box, so neither is culled here.
  if (cull && !isContainer(node) && node.type !== "connector") {
    const b = sn.worldBounds;
    const offscreen = b.x > cull.x + cull.w || b.x + b.width < cull.x || b.y > cull.y + cull.h || b.y + b.height < cull.y;
    if (offscreen || Math.max(b.width, b.height) * cull.zoom < 0.5) return;
  }

  ctx.save();
  const m = fromTransform(node.transform);
  ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);

  // Fade an actively transformed element (and its subtree) so the page shows
  // through it while it is being moved/resized (live translucency).
  const fade = opts.fadeIds && opts.fadeIds.has(node.id) ? LIVE_TRANSFORM_ALPHA : 1;
  const alpha = parentAlpha * node.opacity * fade;
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = blendToComposite(node.blendMode);

  if (isContainer(node) && (node as { clip?: boolean }).clip) {
    // Clip to the frame's mask shape so the fill AND children follow rounded
    // corners / an ellipse, not just a rectangle.
    const fr = node as { maskShape?: "rect" | "ellipse" | "custom"; maskPath?: string; cornerRadius?: { topLeft: number; topRight: number; bottomRight: number; bottomLeft: number } };
    const cr = fr.cornerRadius;
    const hasRadius = !!cr && (cr.topLeft > 0 || cr.topRight > 0 || cr.bottomRight > 0 || cr.bottomLeft > 0);
    ctx.beginPath();
    let clipped = false;
    if (fr.maskShape === "custom" && fr.maskPath) {
      clipped = buildClipFromPathData(ctx, fr.maskPath, w, h); // falls through to rect if unparseable
    }
    if (clipped) {
      // custom path already on the context
    } else if (fr.maskShape === "ellipse" && ctx.ellipse) {
      ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    } else if (hasRadius && cr && ctx.roundRect) {
      ctx.roundRect(0, 0, w, h, [cr.topLeft, cr.topRight, cr.bottomRight, cr.bottomLeft]);
    } else {
      ctx.rect(0, 0, w, h);
    }
    ctx.clip();
  }

  // Effects (blur/shadow/glow) via the CSS filter, applied to this node's own
  // content only; reset before children so they are not double-filtered (FR-5).
  const supportsFilter = "filter" in ctx;
  const filter = effectsFilter(node.effects);
  if (supportsFilter && filter !== "none") ctx.filter = filter;

  try {
    // The connector's local origin is its accumulated world translate; paint()
    // has already applied that transform to ctx, so resolved page-space points
    // are shifted by it back into local space.
    const origin = { x: sn.worldTransform[4], y: sn.worldTransform[5] };
    drawNodeContent(ctx, node, opts.assets, boxes, origin);
  } catch (err) {
    // One bad node never blanks the canvas (Section 5): isolate and placeholder.
    opts.onError?.(err, node.id);
    try {
      placeholderBox(ctx, w, h, MISSING_FILL, MISSING_STROKE);
    } catch {
      /* ignore secondary failure */
    }
  }

  if (supportsFilter) ctx.filter = "none";

  // Outline effects are stroked around the box (not expressible as a filter).
  // Text consumes its outline as a glyph stroke instead, so skip the box here.
  if (node.type !== "text") {
    for (const o of outlineSpecs(node.effects)) {
      ctx.lineWidth = o.width;
      ctx.strokeStyle = o.color;
      ctx.strokeRect(0, 0, w, h);
    }
  }

  if (sn.children) {
    for (const child of sn.children) paint(ctx, child, alpha, opts, boxes, cull);
  }

  ctx.restore();
}

/** Build a node-id -> absolute page-space box map by walking the scene tree.
 *  Connectors resolve attached endpoints against this, so they re-route when a
 *  connected node moves (the scene is rebuilt each rev). The box uses the node's
 *  world translate and scaled size (rotation is ignored: whiteboard nodes are
 *  axis-aligned, and the anchor math only needs an axis-aligned box). */
function buildBoxMap(sn: SceneNode, out: BoxMap): void {
  const wt = sn.worldTransform;
  // Scale factors from the world affine (length of the basis vectors).
  const sx = Math.hypot(wt[0], wt[1]) || 1;
  const sy = Math.hypot(wt[2], wt[3]) || 1;
  out[sn.node.id] = {
    x: wt[4],
    y: wt[5],
    width: sn.node.size.width * sx,
    height: sn.node.size.height * sy,
  };
  if (sn.children) for (const c of sn.children) buildBoxMap(c, out);
}

/** Render a scene to a 2D context at the given viewport. */
export function renderScene(
  scene: Scene,
  ctx: CanvasLike,
  viewport: Viewport,
  opts: Render2DOptions = {},
): void {
  const dpr = viewport.dpr || 1;
  const s = viewport.zoom * dpr;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (opts.clear !== false) ctx.clearRect(0, 0, viewport.width * dpr, viewport.height * dpr);
  ctx.setTransform(s, 0, 0, s, -viewport.panX * s, -viewport.panY * s);

  // Reset compositing state so a frame is self-contained and deterministic
  // (FR-14), regardless of any state the incoming context was left in.
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  if ("filter" in ctx) ctx.filter = "none";

  const page = scene.file.pages.find((p) => p.id === scene.activePageId) ?? scene.file.pages[0];
  if (!opts.skipBackground && page.background) {
    ctx.fillStyle = resolveFill(ctx, page.background, page.width, page.height);
    ctx.fillRect(0, 0, page.width, page.height);
  }
  // Background-only pass (two-pass stacked render): the caller draws every page's
  // background first, then a second pass draws all content on top, so content is
  // never clipped and never covered by a neighbouring page's background.
  if (opts.backgroundOnly) return;

  // Resolve connector endpoints against the live node boxes so attached
  // connectors re-route when a connected node moves (FR-4).
  const boxes: BoxMap = {};
  buildBoxMap(scene.root, boxes);

  // Page-space viewport rect for culling: pan is the top-left page point, and
  // width/zoom is the visible page span. Disabled (null) when opts.cull === false.
  const cull =
    opts.cull === false
      ? null
      : { x: viewport.panX, y: viewport.panY, w: viewport.width / viewport.zoom, h: viewport.height / viewport.zoom, zoom: viewport.zoom };

  const kids = scene.root.children;
  if (kids) {
    // Page clipping each top-level element is clipped to the page
    // rect so overflow past the artboard edge is hidden, keeping clean page edges.
    // Selected/transforming nodes (revealIds) draw unclipped so their hidden
    // overflow reappears while selected. When clipToPage is off (export/thumbnail)
    // nothing is clipped, so the full content still renders. Clipping is per-node
    // (not one clip for the whole pass) to preserve z-order between clipped and
    // revealed elements.
    const reveal = opts.revealIds;
    const fade = opts.fadeIds;
    const pw = page.width, ph = page.height;
    const OUT = 1e6; // outer bound for the "outside the page" inverse clip
    const clipToRect = () => { ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip(); };
    for (const child of kids) {
      const n = child.node;
      if (!opts.clipToPage) {
        paint(ctx, child, 1, opts, boxes, cull); // unclipped (export/thumbnail/whiteboard)
        continue;
      }
      if (reveal && reveal.has(n.id)) {
        // Revealed (selected). During an active transform the whole element is
        // already faded (fadeIds), so draw it once unclipped. Otherwise show the
        // in-page part crisp and the overflow dimmed, so it reads as off-artboard.
        if (fade && fade.has(n.id)) {
          paint(ctx, child, 1, opts, boxes, cull);
        } else {
          ctx.save(); clipToRect(); paint(ctx, child, 1, opts, boxes, cull); ctx.restore();
          ctx.save();
          ctx.beginPath();
          ctx.rect(-OUT, -OUT, OUT * 2, OUT * 2);
          ctx.rect(0, 0, pw, ph);
          ctx.clip("evenodd"); // everything except the page rect
          paint(ctx, child, OVERFLOW_REVEAL_ALPHA, opts, boxes, cull);
          ctx.restore();
        }
        continue;
      }
      // Not revealed: clip overflow to the page (hidden). Fast path: a leaf,
      // unrotated node whose box is fully in-bounds can't overflow, so skip the
      // per-node clip entirely (the common case).
      const b = boxes[n.id];
      const t = n.transform;
      // Only skip the clip when the box is a reliable, axis-aligned footprint:
      // unrotated and un-flipped (negative scale mirrors the box to the other
      // side of the origin, so buildBoxMap's positive-magnitude box would be
      // mis-placed and could hide a real overflow).
      const axisAligned = (t?.rotation ?? 0) === 0 && (t?.scaleX ?? 1) > 0 && (t?.scaleY ?? 1) > 0;
      const inBounds = !isContainer(n) && axisAligned && !!b &&
        b.x >= 0 && b.y >= 0 && b.x + b.width <= pw && b.y + b.height <= ph;
      if (inBounds) {
        paint(ctx, child, 1, opts, boxes, cull);
      } else {
        ctx.save(); clipToRect(); paint(ctx, child, 1, opts, boxes, cull); ctx.restore();
      }
    }
  }
}
