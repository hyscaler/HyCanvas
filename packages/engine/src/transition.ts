// Slide-to-slide transition compositor (doc 28 FR-13).
//
// Pure and framework-agnostic: given the two slides already rendered into
// image sources (`from` = the leaving slide, `to` = the arriving slide) it
// composites them into a destination `CanvasLike` at eased progress `p` (0..1).
// It never touches React, the DOM, or a specific canvas implementation, so the
// same transition renders identically in editor preview, present mode, the web
// player, and headless export (browser, worker, or server).
//
// Magic Move (`morph`) is two-part by construction: the caller renders the
// buffers with the shared elements hidden (see `morphPlan`), this module
// cross-fades those buffers, and the caller then draws the tweened shared
// elements on top (see `lerpNode`). Splitting it this way keeps the compositor
// free of any scene-rendering dependency while leaving morph fully supported.
//
// Only `CanvasLike` capabilities are used: matrix transforms (there is no
// translate/scale on the interface), clip + rect, drawImage, and globalAlpha.

import type { CanvasLike } from "./types";
import type { DesignFile, Node, PageTransition } from "@hc/schema";

/** Anything the destination context can `drawImage`: an HTMLCanvasElement, an
 *  OffscreenCanvas, an ImageBitmap, or a server canvas surface. */
export type TransitionSurface = unknown;

export interface TransitionFrame {
  /** The leaving slide, already rendered. */
  from: TransitionSurface;
  /** The arriving slide, already rendered. */
  to: TransitionSurface;
  /** Destination pixel width. */
  width: number;
  /** Destination pixel height. */
  height: number;
  /** Eased progress, 0 (fully `from`) to 1 (fully `to`). */
  progress: number;
  /** Background painted before compositing; slides may be transparent. */
  background?: string;
}

/** Set the context transform to translate(tx,ty) then scale(sx,sy). */
function setTRS(ctx: CanvasLike, tx: number, ty: number, sx: number, sy: number): void {
  ctx.setTransform(sx, 0, 0, sy, tx, ty);
}

function reset(ctx: CanvasLike): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function drawAt(ctx: CanvasLike, img: TransitionSurface, dx: number, dy: number, w: number, h: number): void {
  ctx.drawImage?.(img, dx, dy, w, h);
}

/** Draw `img` scaled about the destination center (the cross-zoom primitive). */
function drawScaled(ctx: CanvasLike, img: TransitionSurface, scale: number, W: number, H: number): void {
  ctx.save();
  // translate(W/2,H/2) . scale(s,s) . translate(-W/2,-H/2)
  setTRS(ctx, (W / 2) * (1 - scale), (H / 2) * (1 - scale), scale, scale);
  drawAt(ctx, img, 0, 0, W, H);
  ctx.restore();
  reset(ctx);
}

/**
 * Composite `frame.from` and `frame.to` for `transition` at `frame.progress`.
 *
 * The caller owns rendering each slide into its surface (once per frame) and,
 * for `morph`, drawing the tweened shared elements after this returns.
 * Unknown transition types fall back to showing the arriving slide, matching
 * the `none` behavior, so a forward-compatible file never renders blank.
 */
export function renderTransition(ctx: CanvasLike, transition: PageTransition, frame: TransitionFrame): void {
  const { from, to, width: W, height: H, background = "#ffffff" } = frame;
  const p = Math.min(1, Math.max(0, frame.progress));

  reset(ctx);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, W, H);

  const dir = transition.direction ?? "left";
  const sign = dir === "right" || dir === "down" ? -1 : 1;
  const horizontal = dir === "left" || dir === "right";

  switch (transition.type) {
    case "fade":
    case "dissolve":
    // Magic Move cross-fades its (shared-element-free) buffers exactly like a
    // fade; the caller draws the tweened shared elements over the result.
    case "morph": {
      ctx.globalAlpha = 1 - p;
      drawAt(ctx, from, 0, 0, W, H);
      ctx.globalAlpha = p;
      drawAt(ctx, to, 0, 0, W, H);
      ctx.globalAlpha = 1;
      break;
    }
    case "slide": {
      // The incoming slide slides in over the (stationary) outgoing one.
      drawAt(ctx, from, 0, 0, W, H);
      const dx = horizontal ? sign * (1 - p) * W : 0;
      const dy = horizontal ? 0 : sign * (1 - p) * H;
      drawAt(ctx, to, dx, dy, W, H);
      break;
    }
    case "push": {
      // Both slides move together: outgoing pushed out, incoming pushed in.
      const dx = horizontal ? sign * p * W : 0;
      const dy = horizontal ? 0 : sign * p * H;
      drawAt(ctx, from, -dx, -dy, W, H);
      drawAt(ctx, to, horizontal ? sign * W - dx : 0, horizontal ? 0 : sign * H - dy, W, H);
      break;
    }
    case "morph-lite": {
      // A simple cross-zoom: the outgoing slide zooms out + fades, the incoming
      // zooms in from slightly small + fades in.
      ctx.globalAlpha = 1 - p;
      drawScaled(ctx, from, 1 + 0.12 * p, W, H);
      ctx.globalAlpha = p;
      drawScaled(ctx, to, 0.88 + 0.12 * p, W, H);
      ctx.globalAlpha = 1;
      break;
    }
    case "wipe": {
      // The incoming slide is revealed under a growing clip rect in `dir`.
      drawAt(ctx, from, 0, 0, W, H);
      ctx.save();
      ctx.beginPath();
      if (horizontal) {
        const w = p * W;
        ctx.rect(dir === "right" ? W - w : 0, 0, w, H);
      } else {
        const h = p * H;
        ctx.rect(0, dir === "down" ? H - h : 0, W, h);
      }
      ctx.clip();
      drawAt(ctx, to, 0, 0, W, H);
      ctx.restore();
      reset(ctx);
      break;
    }
    case "flip": {
      // Horizontal card flip: outgoing squashes to a sliver, incoming expands.
      const first = p < 0.5;
      const s = first ? 1 - p * 2 : (p - 0.5) * 2;
      ctx.save();
      // translate(W/2,0) . scale(s,1) . translate(-W/2,0)
      setTRS(ctx, (W / 2) * (1 - s), 0, s, 1);
      drawAt(ctx, first ? from : to, 0, 0, W, H);
      ctx.restore();
      reset(ctx);
      break;
    }
    case "zoom": {
      // Outgoing holds; incoming zooms up from the center with a fade.
      drawAt(ctx, from, 0, 0, W, H);
      ctx.globalAlpha = p;
      drawScaled(ctx, to, 0.3 + 0.7 * p, W, H);
      ctx.globalAlpha = 1;
      break;
    }
    default: {
      drawAt(ctx, to, 0, 0, W, H);
    }
  }
  ctx.globalAlpha = 1;
  reset(ctx);
}

// --- Exit / asymmetric transitions (v22, F28 completion C03) -----------------
//
// When the LEAVING page carries its own `transitionOut`, both slides animate
// simultaneously over one duration: the arriving slide per ITS transition
// underneath, the leaving slide per its exit type ON TOP (so the audience
// watches the old slide leave and the new one already in place beneath).
// Pure like renderTransition; a caller with no exit set gets the classic
// single-transition composite, bit for bit.

/** Draw only the ARRIVING layer of `t` at progress p (no outgoing slide). */
function drawArrivingLayer(ctx: CanvasLike, t: PageTransition, img: TransitionSurface, p: number, W: number, H: number): void {
  const dir = t.direction ?? "left";
  const sign = dir === "right" || dir === "down" ? -1 : 1;
  const horizontal = dir === "left" || dir === "right";
  switch (t.type) {
    case "slide":
    case "push": {
      drawAt(ctx, img, horizontal ? sign * (1 - p) * W : 0, horizontal ? 0 : sign * (1 - p) * H, W, H);
      break;
    }
    case "wipe": {
      ctx.save();
      ctx.beginPath();
      if (horizontal) {
        const w = p * W;
        ctx.rect(dir === "right" ? W - w : 0, 0, w, H);
      } else {
        const h = p * H;
        ctx.rect(0, dir === "down" ? H - h : 0, W, h);
      }
      ctx.clip();
      drawAt(ctx, img, 0, 0, W, H);
      ctx.restore();
      reset(ctx);
      break;
    }
    case "zoom": {
      ctx.globalAlpha = p;
      drawScaled(ctx, img, 0.3 + 0.7 * p, W, H);
      ctx.globalAlpha = 1;
      break;
    }
    case "morph-lite": {
      ctx.globalAlpha = p;
      drawScaled(ctx, img, 0.88 + 0.12 * p, W, H);
      ctx.globalAlpha = 1;
      break;
    }
    case "flip": {
      const s = p; // expand over the whole window (the pair has no shared sliver midpoint)
      ctx.save();
      setTRS(ctx, (W / 2) * (1 - s), 0, s, 1);
      drawAt(ctx, img, 0, 0, W, H);
      ctx.restore();
      reset(ctx);
      break;
    }
    case "none": {
      drawAt(ctx, img, 0, 0, W, H);
      break;
    }
    default: {
      // fade / dissolve / morph, and any future type: alpha in.
      ctx.globalAlpha = p;
      drawAt(ctx, img, 0, 0, W, H);
      ctx.globalAlpha = 1;
    }
  }
}

/** Draw only the LEAVING layer of `t` at progress p (fully gone at p=1). */
function drawLeavingLayer(ctx: CanvasLike, t: PageTransition, img: TransitionSurface, p: number, W: number, H: number): void {
  const dir = t.direction ?? "left";
  const sign = dir === "right" || dir === "down" ? -1 : 1;
  const horizontal = dir === "left" || dir === "right";
  switch (t.type) {
    case "slide":
    case "push": {
      drawAt(ctx, img, horizontal ? -sign * p * W : 0, horizontal ? 0 : -sign * p * H, W, H);
      break;
    }
    case "wipe": {
      // The un-wiped remainder of the outgoing slide shrinks in `dir`.
      ctx.save();
      ctx.beginPath();
      if (horizontal) {
        const w = (1 - p) * W;
        ctx.rect(dir === "right" ? 0 : W - w, 0, w, H);
      } else {
        const h = (1 - p) * H;
        ctx.rect(0, dir === "down" ? 0 : H - h, W, h);
      }
      ctx.clip();
      drawAt(ctx, img, 0, 0, W, H);
      ctx.restore();
      reset(ctx);
      break;
    }
    case "zoom": {
      ctx.globalAlpha = 1 - p;
      drawScaled(ctx, img, 1 + 0.3 * p, W, H);
      ctx.globalAlpha = 1;
      break;
    }
    case "morph-lite": {
      ctx.globalAlpha = 1 - p;
      drawScaled(ctx, img, 1 + 0.12 * p, W, H);
      ctx.globalAlpha = 1;
      break;
    }
    case "flip": {
      const s = 1 - p;
      ctx.save();
      setTRS(ctx, (W / 2) * (1 - s), 0, s, 1);
      drawAt(ctx, img, 0, 0, W, H);
      ctx.restore();
      reset(ctx);
      break;
    }
    case "none": {
      // An explicit none exit means the outgoing slide is simply gone.
      break;
    }
    default: {
      // fade / dissolve / morph, and any future type: alpha out.
      ctx.globalAlpha = 1 - p;
      drawAt(ctx, img, 0, 0, W, H);
      ctx.globalAlpha = 1;
    }
  }
}

/**
 * Composite one navigation step honoring the leaving page's exit transition.
 * With no `exit` this IS `renderTransition(enter)` - callers can switch to
 * this helper unconditionally. With an exit set, the arriving slide draws per
 * `enter` first, then the leaving slide draws per `exit` on top.
 */
export function renderTransitionPair(
  ctx: CanvasLike,
  enter: PageTransition,
  exit: PageTransition | undefined,
  frame: TransitionFrame,
): void {
  if (!exit) {
    renderTransition(ctx, enter, frame);
    return;
  }
  const { from, to, width: W, height: H, background = "#ffffff" } = frame;
  const p = Math.min(1, Math.max(0, frame.progress));
  reset(ctx);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, W, H);
  drawArrivingLayer(ctx, enter, to, p, W, H);
  drawLeavingLayer(ctx, exit, from, p, W, H);
  ctx.globalAlpha = 1;
  reset(ctx);
}

/** The shared elements a Magic Move tweens, indexed under the arriving node id. */
export interface MorphPlan {
  ids: string[];
  fromNodes: Map<string, Node>;
  toNodes: Map<string, Node>;
}

/**
 * Plan a Magic Move: the top-level children shared between two slides.
 *
 * Matching is by stable schema node id first (the open format's advantage over
 * PowerPoint's name heuristics), then by a name unique on BOTH sides, which
 * covers "duplicate the slide, then move an element" since duplication
 * regenerates ids but keeps names. Returns null when nothing is shared, so the
 * caller can fall back to a plain cross-fade.
 */
export function morphPlan(from: DesignFile, fromPage: number, to: DesignFile, toPage: number): MorphPlan | null {
  const fromCh = from.pages[fromPage]?.children ?? [];
  const toCh = to.pages[toPage]?.children ?? [];
  const fromById = new Map(fromCh.map((n) => [n.id, n]));
  const fromByName = new Map<string, Node[]>();
  for (const n of fromCh) {
    if (!n.name) continue;
    const bucket = fromByName.get(n.name);
    if (bucket) bucket.push(n);
    else fromByName.set(n.name, [n]);
  }
  const toNameCount = new Map<string, number>();
  for (const n of toCh) if (n.name) toNameCount.set(n.name, (toNameCount.get(n.name) ?? 0) + 1);

  const ids: string[] = [];
  const fromNodes = new Map<string, Node>();
  const toNodes = new Map<string, Node>();
  for (const tn of toCh) {
    let match: Node | undefined = fromById.get(tn.id);
    if (!match && tn.name && toNameCount.get(tn.name) === 1) {
      const byName = fromByName.get(tn.name);
      if (byName && byName.length === 1) match = byName[0]; // unique on both sides
    }
    if (match) {
      ids.push(tn.id);
      fromNodes.set(tn.id, match);
      toNodes.set(tn.id, tn);
    }
  }
  return ids.length ? { ids, fromNodes, toNodes } : null;
}

/** Interpolate a node between its outgoing and incoming pose (transform/size/
 *  opacity) at eased progress `p`; appearance is taken from the destination. */
export function lerpNode(a: Node, b: Node, p: number): Node {
  const L = (x: number, y: number) => x + (y - x) * p;
  const ta = a.transform;
  const tb = b.transform;
  return {
    ...b,
    transform: {
      ...tb,
      x: L(ta.x, tb.x),
      y: L(ta.y, tb.y),
      scaleX: L(ta.scaleX, tb.scaleX),
      scaleY: L(ta.scaleY, tb.scaleY),
      rotation: L(ta.rotation, tb.rotation),
    },
    size: { width: L(a.size.width, b.size.width), height: L(a.size.height, b.size.height) },
    opacity: L(a.opacity, b.opacity),
  } as Node;
}

/** Build the design a morph draws on top: the arriving page with only the
 *  shared elements, posed at `p`. Render this after `renderTransition`. */
export function morphDesignAt(plan: MorphPlan, to: DesignFile, toPage: number, p: number): DesignFile {
  const children = plan.ids.map((id) => lerpNode(plan.fromNodes.get(id)!, plan.toNodes.get(id)!, p));
  const pages = to.pages.map((pg, i) => (i === toPage ? { ...pg, children } : pg));
  return { ...to, pages } as DesignFile;
}

/** The ids a morph tweens, which the caller must hide while rendering the two
 *  buffers so they are not also cross-faded underneath the tweened layer. */
export function morphHiddenIds(plan: MorphPlan): Set<string> {
  const ids = new Set<string>();
  for (const n of plan.fromNodes.values()) ids.add(n.id);
  for (const n of plan.toNodes.values()) ids.add(n.id);
  return ids;
}
