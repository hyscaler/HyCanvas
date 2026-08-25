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
import type { Color, DesignFile, Node, PageTransition, TextNode } from "@hc/schema";
import { evalEasing, transitionEasing } from "./animation";
import { planWordMorph, wordMorphEligible, wordMorphNodes } from "./textmorph";

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
  /** Eased progress for the LEAVING layer when it runs on its own clock (the
   *  exit transition's duration/easing differ from the arriving one's). Only
   *  `renderTransitionPair` reads it; absent means the shared `progress`. */
  exitProgress?: number;
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
 * `enter` first, then the leaving slide draws per `exit` on top; each layer
 * runs on ITS OWN clock (`progress` for arriving, `exitProgress` for leaving,
 * both clamped), so an exit's own duration and easing are honored even when
 * they differ from the arriving transition's.
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
  const pExit = Math.min(1, Math.max(0, frame.exitProgress ?? frame.progress));
  reset(ctx);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, W, H);
  drawArrivingLayer(ctx, enter, to, p, W, H);
  drawLeavingLayer(ctx, exit, from, pExit, W, H);
  ctx.globalAlpha = 1;
  reset(ctx);
}

/** The composite window for one navigation step: the longer of the arriving
 *  transition and the leaving page's exit (0 when neither is set). Callers
 *  size their transition phase with this so an EXIT-ONLY page still plays. */
export function transitionPairDurationMs(enter: PageTransition | undefined, exit: PageTransition | undefined): number {
  const enterMs = enter && enter.type !== "none" ? enter.durationMs : 0;
  const exitMs = exit && exit.type !== "none" ? exit.durationMs : 0;
  return Math.max(enterMs, exitMs);
}

/** The effective arriving transition for a pair window: a page with no own
 *  transition arrives as `none` (placed at once beneath the leaving layer). */
export function pairEnterTransition(enter: PageTransition | undefined): PageTransition {
  return enter ?? { type: "none", durationMs: 0 };
}

/** The shared elements a Magic Move tweens, indexed under the arriving node id.
 *  `fromNodes`/`toNodes` are ORIGINAL document references (callers hide them
 *  while rendering the crossfade buffers); `fromPose`/`toPose` are flattened
 *  clones whose transforms are ABSOLUTE (group offsets baked in), which is
 *  what the tweened overlay renders (C06 nested matching). */
export interface MorphPlan {
  ids: string[];
  fromNodes: Map<string, Node>;
  toNodes: Map<string, Node>;
  fromPose: Map<string, Node>;
  toPose: Map<string, Node>;
}

/** A match candidate: the original node plus its accumulated page-absolute
 *  translate/scale (containers with rotation or flips are never descended -
 *  flattening them would skew member positions, same rule as PPTX export). */
interface MorphCandidate {
  node: Node;
  tx: number;
  ty: number;
  sx: number;
  sy: number;
}

/** The forced-match token (C09): a node NAME starting with `!!` pair-matches
 *  across slides by that name regardless of id, one per side. */
function forcedToken(n: Node): string | null {
  const name = n.name?.trim();
  return name && name.startsWith("!!") && name.length > 2 ? name : null;
}

/** Flatten a candidate into a standalone clone with an absolute transform. */
function poseOf(c: MorphCandidate): Node {
  const t = c.node.transform;
  return {
    ...c.node,
    transform: {
      ...t,
      x: c.tx + t.x * c.sx,
      y: c.ty + t.y * c.sy,
      scaleX: t.scaleX * c.sx,
      scaleY: t.scaleY * c.sy,
    },
  } as Node;
}

/** Children of an unmatched, unrotated, unflipped container, as candidates in
 *  the container's accumulated space. */
function descend(c: MorphCandidate): MorphCandidate[] {
  const n = c.node;
  if (n.type !== "group" && n.type !== "frame") return [];
  const t = n.transform;
  if ((t.rotation ?? 0) !== 0 || t.scaleX * c.sx < 0 || t.scaleY * c.sy < 0) return [];
  const kids = (n as { children?: Node[] }).children ?? [];
  return kids
    .filter((k) => !k.hidden)
    .map((k) => ({ node: k, tx: c.tx + t.x * c.sx, ty: c.ty + t.y * c.sy, sx: c.sx * t.scaleX, sy: c.sy * t.scaleY }));
}

/**
 * Plan a Magic Move: the elements shared between two slides.
 *
 * Matching precedence per round: a forced `!!name` token (C09, exactly one
 * carrier per side), then stable schema node id (the open format's advantage
 * over name heuristics), then a name unique on BOTH sides, which covers
 * "duplicate the slide, then move an element" since duplication regenerates
 * ids but keeps names. Top-level elements (groups included, tweened as units)
 * match first; containers that stay UNMATCHED are then descended so a node
 * moving into or out of a group still morphs, round by round (C06). Returns
 * null when nothing is shared, so the caller falls back to a plain crossfade.
 */
export function morphPlan(from: DesignFile, fromPage: number, to: DesignFile, toPage: number): MorphPlan | null {
  const ids: string[] = [];
  const fromNodes = new Map<string, Node>();
  const toNodes = new Map<string, Node>();
  const fromPose = new Map<string, Node>();
  const toPose = new Map<string, Node>();

  let fromPool: MorphCandidate[] = (from.pages[fromPage]?.children ?? [])
    .filter((n) => !n.hidden)
    .map((n) => ({ node: n, tx: 0, ty: 0, sx: 1, sy: 1 }));
  let toPool: MorphCandidate[] = (to.pages[toPage]?.children ?? [])
    .filter((n) => !n.hidden)
    .map((n) => ({ node: n, tx: 0, ty: 0, sx: 1, sy: 1 }));

  for (let round = 0; round < 8 && fromPool.length && toPool.length; round++) {
    const matchedFrom = new Set<MorphCandidate>();
    const matchedTo = new Set<MorphCandidate>();
    const record = (f: MorphCandidate, t: MorphCandidate) => {
      ids.push(t.node.id);
      fromNodes.set(t.node.id, f.node);
      toNodes.set(t.node.id, t.node);
      fromPose.set(t.node.id, poseOf(f));
      toPose.set(t.node.id, poseOf(t));
      matchedFrom.add(f);
      matchedTo.add(t);
    };

    // 1. Forced tokens: exactly one carrier per side, else automatic rules.
    const forcedFrom = new Map<string, MorphCandidate[]>();
    for (const c of fromPool) {
      const tok = forcedToken(c.node);
      if (tok) (forcedFrom.get(tok) ?? forcedFrom.set(tok, []).get(tok)!).push(c);
    }
    const forcedTo = new Map<string, MorphCandidate[]>();
    for (const c of toPool) {
      const tok = forcedToken(c.node);
      if (tok) (forcedTo.get(tok) ?? forcedTo.set(tok, []).get(tok)!).push(c);
    }
    for (const [tok, tos] of forcedTo) {
      const froms = forcedFrom.get(tok);
      if (froms?.length === 1 && tos.length === 1) record(froms[0], tos[0]);
    }

    // 2. Stable id, then 3. name unique on both sides (within this round).
    const fromById = new Map(fromPool.filter((c) => !matchedFrom.has(c)).map((c) => [c.node.id, c]));
    const fromByName = new Map<string, MorphCandidate[]>();
    for (const c of fromPool) {
      if (matchedFrom.has(c) || !c.node.name) continue;
      (fromByName.get(c.node.name) ?? fromByName.set(c.node.name, []).get(c.node.name)!).push(c);
    }
    const toNameCount = new Map<string, number>();
    for (const c of toPool) {
      if (matchedTo.has(c) || !c.node.name) continue;
      toNameCount.set(c.node.name, (toNameCount.get(c.node.name) ?? 0) + 1);
    }
    for (const tc of toPool) {
      if (matchedTo.has(tc)) continue;
      let match = fromById.get(tc.node.id);
      if (match && matchedFrom.has(match)) match = undefined;
      if (!match && tc.node.name && toNameCount.get(tc.node.name) === 1) {
        const byName = fromByName.get(tc.node.name)?.filter((c) => !matchedFrom.has(c));
        if (byName && byName.length === 1) match = byName[0];
      }
      if (match) record(match, tc);
    }

    // 4. Descend UNMATCHED containers on both sides for the next round, so
    // regrouped elements still find each other (matched containers tween as
    // units and never expose their children separately). Unmatched LEAVES
    // stay in the pool: the other side may only reach their partner after
    // descending one more level.
    const next = (pool: MorphCandidate[], matched: Set<MorphCandidate>) => {
      const out: MorphCandidate[] = [];
      let descended = false;
      for (const c of pool) {
        if (matched.has(c)) continue;
        const kids = descend(c);
        if (kids.length) {
          descended = true;
          out.push(...kids);
        } else if (c.node.type !== "group" && c.node.type !== "frame") {
          out.push(c); // leaves persist; exhausted containers drop
        }
      }
      return { out, descended };
    };
    const nf = next(fromPool, matchedFrom);
    const nt = next(toPool, matchedTo);
    // No new depth on either side means another round cannot match anything
    // the current round could not; stop rather than spin on stable pools.
    if (!nf.descended && !nt.descended) break;
    fromPool = nf.out;
    toPool = nt.out;
  }

  return ids.length ? { ids, fromNodes, toNodes, fromPose, toPose } : null;
}

/** Lerp a solid color in sRGB (alpha included). */
function lerpColor(a: Color, b: Color, p: number): Color {
  const L = (x: number, y: number) => x + (y - x) * p;
  return { srgb: { r: L(a.srgb.r, b.srgb.r), g: L(a.srgb.g, b.srgb.g), b: L(a.srgb.b, b.srgb.b), a: L(a.srgb.a, b.srgb.a) } };
}

/** Tween one fill toward another when their shapes agree: solid-to-solid
 *  lerps the color; gradient-to-gradient with the SAME kind and stop count
 *  lerps stop colors and positions; anything else snaps to the destination
 *  (C08 - path/shape morphing stays out of scope). */
function lerpFill(a: unknown, b: unknown, p: number): unknown {
  const fa = a as { type?: string; color?: Color; gradient?: string; stops?: { position: number; color: Color }[] } | undefined;
  const fb = b as { type?: string; color?: Color; gradient?: string; stops?: { position: number; color: Color }[] } | undefined;
  if (!fa || !fb) return b;
  if (fa.type === "solid" && fb.type === "solid" && fa.color && fb.color) {
    return { ...fb, color: lerpColor(fa.color, fb.color, p) };
  }
  if (
    fa.type === "gradient" && fb.type === "gradient" && fa.gradient === fb.gradient &&
    Array.isArray(fa.stops) && Array.isArray(fb.stops) && fa.stops.length === fb.stops.length
  ) {
    const L = (x: number, y: number) => x + (y - x) * p;
    return { ...fb, stops: fb.stops.map((sb, i) => ({ ...sb, position: L(fa.stops![i].position, sb.position), color: lerpColor(fa.stops![i].color, sb.color, p) })) };
  }
  return b;
}

/** Interpolate a node between its outgoing and incoming pose at eased progress
 *  `p`: transform/size/opacity, and (C08) appearance where the shapes agree -
 *  solid fill colors, index-matched gradient stops, stroke color and width,
 *  and per-corner radius. Unmatched appearance snaps to the destination. */
export function lerpNode(a: Node, b: Node, p: number): Node {
  const L = (x: number, y: number) => x + (y - x) * p;
  const ta = a.transform;
  const tb = b.transform;
  const out = {
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
  const ra = a as unknown as { fills?: unknown[]; stroke?: { color?: Color; fill?: unknown; width?: number }; cornerRadius?: { topLeft: number; topRight: number; bottomRight: number; bottomLeft: number } };
  const rb = b as unknown as { fills?: unknown[]; stroke?: { color?: Color; fill?: unknown; width?: number }; cornerRadius?: { topLeft: number; topRight: number; bottomRight: number; bottomLeft: number } };
  const ro = out as unknown as typeof rb;
  if (Array.isArray(ra.fills) && Array.isArray(rb.fills) && ra.fills.length === rb.fills.length) {
    ro.fills = rb.fills.map((fb, i) => lerpFill(ra.fills![i], fb, p));
  }
  if (ra.stroke && rb.stroke) {
    ro.stroke = { ...rb.stroke };
    if (ra.stroke.color && rb.stroke.color) ro.stroke.color = lerpColor(ra.stroke.color, rb.stroke.color, p);
    if (ra.stroke.fill && rb.stroke.fill) ro.stroke.fill = lerpFill(ra.stroke.fill, rb.stroke.fill, p);
    if (typeof ra.stroke.width === "number" && typeof rb.stroke.width === "number") ro.stroke.width = L(ra.stroke.width, rb.stroke.width);
  }
  if (ra.cornerRadius || rb.cornerRadius) {
    const z = { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 };
    const ca = ra.cornerRadius ?? z;
    const cb = rb.cornerRadius ?? z;
    ro.cornerRadius = {
      topLeft: L(ca.topLeft, cb.topLeft),
      topRight: L(ca.topRight, cb.topRight),
      bottomRight: L(ca.bottomRight, cb.bottomRight),
      bottomLeft: L(ca.bottomLeft, cb.bottomLeft),
    };
  }
  return out;
}

/**
 * Build the design a morph draws on top: the arriving page with only the
 * shared elements, posed at `p`. Render this after `renderTransition`.
 *
 * Poses come from the plan's FLATTENED clones, so nested matches (C06) draw
 * at their true page positions. Per-element easing (C07): when the arriving
 * node's entrance easing is set and the caller supplies `linearProgress`,
 * that element re-eases its own motion from the LINEAR clock (spring
 * included) instead of riding the transition's global curve. Word-level text
 * morph (C10): an eligible text pair whose words differ dances its common
 * words instead of snapping content.
 */
export function morphDesignAt(plan: MorphPlan, to: DesignFile, toPage: number, p: number, opts: { linearProgress?: number } = {}): DesignFile {
  const children: Node[] = [];
  for (const id of plan.ids) {
    const a = plan.fromPose.get(id)!;
    const b = plan.toPose.get(id)!;
    const easing = (plan.toNodes.get(id) as unknown as { animation?: { entrance?: { easing?: string } } }).animation?.entrance?.easing;
    const pe = easing && opts.linearProgress !== undefined
      ? evalEasing(transitionEasing(easing), Math.min(1, Math.max(0, opts.linearProgress)))
      : p;
    if (a.type === "text" && b.type === "text" && wordMorphEligible(a, b)) {
      const wordPlan = planWordMorph(a as TextNode, b as TextNode);
      if (wordPlan) {
        children.push(...wordMorphNodes(a as TextNode, b as TextNode, wordPlan, pe));
        continue;
      }
    }
    children.push(lerpNode(a, b, pe));
  }
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
