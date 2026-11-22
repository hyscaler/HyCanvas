// Binds the editor store to a real <canvas>: builds @hc/engine scenes from the
// document and renders them through the Canvas2D path at the store viewport
// (with device-pixel-ratio handling), re-rendering on document/viewport/resize.
//
// Continuous multi-page scroll: all pages are drawn stacked vertically (each at
// a cumulative page-space offset), so scrolling reveals the whole document.
// Editing still targets the ACTIVE page: the coordinate helpers map
// screen <-> the active page's local space at its stacked offset, so selection,
// the gizmo, and hit-testing keep working unchanged. A single-page document has
// offset 0, so it behaves exactly as before.

import { useCallbackRef } from "@/lib/useCallbackRef";
import { useEffect, useRef, type RefObject } from "react";
import { createScene, diffScenes, type CanvasLike, type Point, type Scene, type Viewport } from "@hc/engine";
import { pageToScreen, screenToPage } from "@hc/engine";
import { renderScene } from "@hc/engine";
import { locate } from "@hc/editor";
import { useEditor } from "@/store/editor";
import { imageAssets } from "@/lib/assetProvider";
import { fonts } from "@/lib/fontProvider";
import { pageGap, pageOffsets } from "@/lib/pageLayout";

// Three ways to bring the canvas up to date, cheapest first (#77):
//
//  1. Moving the view (a pan or pinch sends a viewport change every frame).
//     When a full repaint is too slow to keep up, the last full frame is kept
//     as a snapshot and each motion frame just draws it moved and scaled. A
//     full repaint happens when too much of the page is no longer covered by
//     the snapshot, when it has been scaled too far, and once the motion
//     settles. A scene that repaints quickly is always repainted in full, so
//     it never shows a stale or soft frame.
//  2. A live transform (drag, resize, rotate). Only the nodes being moved
//     change, so only the union of their old and new bounds is cleared and
//     repainted, with everything outside it skipped (diffScenes + the
//     renderer's `region`).
//  3. Everything else: a full repaint.
//
// While the view is moving, a phone would also repaint at a device pixel ratio
// near 3 (about 9 backing pixels per CSS pixel). Touch devices paint at most
// MOTION_DPR_CAP during the motion and at full sharpness once it settles. A
// single viewport change (zoom buttons, fit) is not motion and paints sharp.
const MOTION_DPR_CAP = 1.5;
/** A full repaint slower than this cannot keep up with a moving view, so the
 *  view moves a snapshot instead. */
const SLOW_PAINT_MS = 12;
/** Repaint in full once the snapshot covers less than this share of the page
 *  area in view... */
const SNAPSHOT_MIN_COVER = 0.75;
/** ...or has been scaled outside this range (soft when enlarged, wasteful and
 *  aliased when shrunk far). */
const SNAPSHOT_MAX_SCALE = 1.6;
const SNAPSHOT_MIN_SCALE = 0.4;
/** A partial repaint larger than this share of the canvas is not worth the
 *  bookkeeping: repaint in full. */
const PARTIAL_MAX_SHARE = 0.6;
/** Nodes this far (page units) outside a partial repaint's area are still
 *  painted into it: a neighbour's soft shadow or stroke can reach in from
 *  outside its own box, and the clip discards whatever does not. */
const PARTIAL_NEIGHBOUR_PAD = 256;

interface PaintedFrame {
  zoom: number; panX: number; panY: number; dpr: number; width: number; height: number;
  rev: number; stateKey: string; transforming: boolean;
  /** How long the last FULL repaint took. */
  ms: number;
}
/** Viewport changes closer together than this count as one continuous motion. */
const MOTION_GAP_MS = 200;
/** Quiet time after the last change before the full-resolution repaint. */
const SETTLE_MS = 150;

const coarsePointer = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;

export interface CanvasApi {
  scene: () => Scene | null;
  viewport: () => Viewport;
  toPage: (screen: Point) => Point;
  toScreen: (page: Point) => Point;
  /** Index of the page whose stacked band contains a screen point (for
   *  click-to-activate in continuous-scroll mode). */
  pageIndexAt: (screen: Point) => number;
}

export function useEditorCanvas(canvasRef: RefObject<HTMLCanvasElement | null>): CanvasApi {
  // Lazily-built, per-page scene cache, invalidated when the doc rev changes.
  // Only pages that are drawn (visible) get built, so a 100+ page document does
  // O(visible) work per edit/scroll instead of O(all pages).
  const sceneCacheRef = useRef<{ rev: number; scenes: Map<number, Scene> }>({ rev: -1, scenes: new Map() });
  const sizeRef = useRef({ width: 1, height: 1, dpr: 1 });
  const fittedRef = useRef(false);
  // What is on the canvas right now, for the snapshot and partial paths.
  const paintRef = useRef<{
    /** The last full repaint (viewport, document state, cost). */
    last: PaintedFrame | null;
    /** The canvas holds a true render of `last` (false after a snapshot frame). */
    contentFull: boolean;
    /** Something other than node geometry changed: the next paint must be full. */
    fullNeeded: boolean;
    /** The scenes that were painted, per page, to diff the next edit against. */
    scenes: Map<number, Scene>;
    /** The moving view's snapshot of a full frame, and the viewport it shows. */
    snap: { canvas: HTMLCanvasElement; zoom: number; panX: number; panY: number; dpr: number; width: number; height: number } | null;
    /** Bumped when an image or font finishes loading, so a snapshot of the
     *  frame before it is not reused. */
    epoch: number;
  }>({ last: null, contentFull: false, fullNeeded: true, scenes: new Map(), snap: null, epoch: 0 });
  // Pan/zoom motion tracking for the reduced-resolution repaint (see above).
  const motionRef = useRef<{ active: boolean; lastChange: number; prev: string; settle: ReturnType<typeof setTimeout> | null }>({
    active: false,
    lastChange: 0,
    prev: "",
    settle: null,
  });
  const rev = useEditor((s) => s.rev);
  const viewport = useEditor((s) => s.viewport);
  const activePage = useEditor((s) => s.activePage);
  const editingTextId = useEditor((s) => s.editingTextId);
  const maskRefining = useEditor((s) => s.maskRefining);
  const transforming = useEditor((s) => s.transforming);
  const hoverId = useEditor((s) => s.hoverId);
  const docId = useEditor((s) => s.doc.id);

  // Re-arm the one-time center+fit when a different document is loaded in place.
  useEffect(() => {
    fittedRef.current = false;
  }, [docId]);

  // Base (global stacked space) viewport.
  const buildViewport = (): Viewport => ({
    zoom: viewport.zoom,
    panX: viewport.panX,
    panY: viewport.panY,
    dpr: sizeRef.current.dpr,
    width: sizeRef.current.width,
    height: sizeRef.current.height,
  });

  // Viewport whose origin is the ACTIVE page's top-left in the stack, so the
  // coordinate helpers (and thus the gizmo/hit-testing) work in active-page
  // local space exactly as in the single-page model.
  const coordViewport = (): Viewport => {
    const st = useEditor.getState();
    const offs = pageOffsets(st.doc);
    // Read the LIVE active page (not the render closure) so a setActivePage()
    // earlier in the same event maps coordinates against the just-clicked page.
    const i = Math.max(0, Math.min(st.activePage, st.doc.pages.length - 1));
    return { ...buildViewport(), panY: viewport.panY - (offs[i] ?? 0) };
  };

  // Build (or reuse) the scene for one page. The cache is dropped whenever the
  // doc rev changes, so an edit rebuilds only the pages that get drawn.
  const getScene = (i: number): Scene => {
    const st = useEditor.getState();
    const cache = sceneCacheRef.current;
    if (cache.rev !== st.rev) { cache.rev = st.rev; cache.scenes.clear(); }
    let s = cache.scenes.get(i);
    if (!s) { s = createScene(st.doc, i); cache.scenes.set(i, s); }
    return s;
  };

  const render = useCallbackRef((reason: "doc" | "other" = "other") => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const paint = paintRef.current;
    // Only an edit of the document can be painted partially; any other reason
    // to repaint (viewport, hover, a loaded image, a resize) means a full one.
    if (reason !== "doc") paint.fullNeeded = true;
    const fullDpr = window.devicePixelRatio || 1;
    const moving = motionRef.current.active;
    const dpr = moving && coarsePointer() ? Math.min(fullDpr, MOTION_DPR_CAP) : fullDpr;
    const rect = canvas.getBoundingClientRect();
    sizeRef.current = { width: rect.width, height: rect.height, dpr };
    useEditor.getState().setViewportSize(rect.width, rect.height);
    if (!fittedRef.current && rect.width > 0 && rect.height > 0) {
      fittedRef.current = true;
      useEditor.getState().fitToScreen();
      return; // fitToScreen changes the viewport, which re-invokes render()
    }
    const bw = Math.max(1, Math.round(rect.width * dpr));
    const bh = Math.max(1, Math.round(rect.height * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const sizeCanvas = () => {
      if (canvas.width !== bw) canvas.width = bw;
      if (canvas.height !== bh) canvas.height = bh;
    };
    const base = buildViewport();
    const st = useEditor.getState();
    const doc = st.doc;
    if (!doc.pages.length) {
      sizeCanvas();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      paint.last = null; paint.contentFull = false; paint.snap = null; paint.scenes = new Map();
      return;
    }
    const offs = pageOffsets(doc);
    // Content is clipped to its own page (clean edges): an element that
    // overflows the artboard is hidden on the pasteboard, EXCEPT the current
    // selection, which draws unclipped so a selected element reveals the parts
    // hidden past the edge (and can be resized back). Fade the element being
    // dragged/resized so the page shows through it during the gesture.
    const live = st.transforming;
    const selection = st.selection;
    const fadeIds = live ? new Set(selection) : undefined;
    // Reveal (draw unclipped) the selection's TOP-LEVEL ancestors, since the page
    // clip is applied per top-level element. Whiteboards are an unbounded surface,
    // so never page-clip them.
    const isBoard = (doc.meta as { kind?: string } | undefined)?.kind === "whiteboard";
    const clipToPage = !isBoard;
    const topAncestor = (id: string): string => {
      let cur = id;
      for (let i = 0; i < 64; i++) {
        const loc = locate(doc, cur);
        if (!loc || !loc.parent) return cur;
        cur = loc.parent.id;
      }
      return cur;
    };
    // Reveal the selection AND the hovered element, so an overflowing element
    // shows its off-page overflow (dimmed) on hover, matching the hover outline.
    // Skip hover-reveal during a live transform: hoverId isn't updated mid-drag,
    // so a stale hover could otherwise reveal an unrelated element.
    const hovered = !live ? st.hoverId : null;
    const revealSrc = hovered ? [...selection, hovered] : selection;
    const revealIds = clipToPage && revealSrc.length
      ? new Set(revealSrc.map(topAncestor))
      : undefined;
    // Skip the node being text-edited (the DOM overlay shows it) and the image
    // whose mask is being brush-refined: the refine overlay draws the LIVE
    // composite itself, and the engine's committed render underneath would show
    // the old mask through every freshly erased region.
    const skipNodeId = st.editingTextId ?? st.maskRefining ?? undefined;
    // Private mode (FR-15): visually hide other participants' new contributions
    // (empty set unless a private round is hiding, so the common path is free).
    const hiddenIds = st.privateHiddenIds();
    const activeIdx = Math.max(0, Math.min(st.activePage, doc.pages.length - 1));
    // Everything besides the viewport and node geometry that a frame depends on.
    const stateKey = `${activeIdx}|${skipNodeId ?? ""}|${live ? 1 : 0}|${hovered ?? ""}|${selection.join(",")}|${hiddenIds.size}|${paint.epoch}`;
    const last = paint.last;

    // --- 1. A moving view over a scene that is slow to repaint: move a snapshot.
    if (moving && last && last.ms > SLOW_PAINT_MS && last.rev === st.rev && last.stateKey === stateKey && (paint.snap || paint.contentFull)) {
      if (!paint.snap) {
        // The canvas still holds the last full frame: keep a copy (before any
        // resize below clears it) with the viewport it was painted at.
        const copy = document.createElement("canvas");
        copy.width = canvas.width;
        copy.height = canvas.height;
        const cctx = copy.getContext("2d");
        if (cctx) {
          cctx.drawImage(canvas, 0, 0);
          paint.snap = { canvas: copy, zoom: last.zoom, panX: last.panX, panY: last.panY, dpr: last.dpr, width: last.width, height: last.height };
        }
      }
      const snap = paint.snap;
      if (snap) {
        const s1 = base.zoom * dpr;
        const k = s1 / (snap.zoom * snap.dpr);
        // The page area in view, and how much of it the snapshot holds.
        const vx0 = base.panX, vy0 = base.panY, vx1 = base.panX + rect.width / base.zoom, vy1 = base.panY + rect.height / base.zoom;
        let nx0 = vx0, ny0 = vy0, nx1 = vx1, ny1 = vy1;
        if (!isBoard) {
          const lastIdx = doc.pages.length - 1;
          const maxW = doc.pages.reduce((m, p) => Math.max(m, p.width), 0);
          nx0 = Math.max(vx0, 0); ny0 = Math.max(vy0, 0);
          nx1 = Math.min(vx1, maxW); ny1 = Math.min(vy1, offs[lastIdx] + doc.pages[lastIdx].height);
        }
        const needed = Math.max(0, nx1 - nx0) * Math.max(0, ny1 - ny0);
        const cx0 = Math.max(nx0, snap.panX), cy0 = Math.max(ny0, snap.panY);
        const cx1 = Math.min(nx1, snap.panX + snap.width / snap.zoom), cy1 = Math.min(ny1, snap.panY + snap.height / snap.zoom);
        const covered = Math.max(0, cx1 - cx0) * Math.max(0, cy1 - cy0);
        const cover = needed > 0 ? covered / needed : 1;
        if (cover >= SNAPSHOT_MIN_COVER && k <= SNAPSHOT_MAX_SCALE && k >= SNAPSHOT_MIN_SCALE) {
          sizeCanvas();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.globalAlpha = 1;
          ctx.globalCompositeOperation = "source-over";
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(snap.canvas, (snap.panX - base.panX) * s1, (snap.panY - base.panY) * s1, snap.canvas.width * k, snap.canvas.height * k);
          paint.contentFull = false;
          return;
        }
      }
      // Too little of the view is covered (or it is scaled too far): repaint
      // in full below, and the next motion frame snapshots that.
      paint.snap = null;
    }

    // Viewport culling: only draw pages whose stacked band intersects the visible
    // area (plus a half-screen buffer so scrolling reveals neighbors smoothly).
    const z = base.zoom || 1;
    const viewTop = base.panY;
    const viewBottom = base.panY + (base.height || 0) / z;
    const buf = ((base.height || 0) / z) * 0.5;
    const visible: number[] = [];
    for (let i = 0; i < doc.pages.length; i++) {
      const top = offs[i];
      const bottom = top + doc.pages[i].height;
      if (bottom < viewTop - buf || top > viewBottom + buf) continue;
      visible.push(i);
    }
    // Two-pass render so no page's content is ever clipped or covered by another
    // page's background: pass 1 draws every visible page's background (bottom),
    // pass 2 draws all content on top. Content that overflows a page edge stays
    // visible on the pasteboard and above neighbouring pages' backgrounds.
    // `region` (global stacked page space) limits the work to a partial repaint;
    // the caller has clipped and cleared it.
    const drawPages = (region: { x: number; y: number; width: number; height: number } | null) => {
      const regionFor = (i: number) => (region
        ? { x: region.x - PARTIAL_NEIGHBOUR_PAD, y: region.y - offs[i] - PARTIAL_NEIGHBOUR_PAD, width: region.width + 2 * PARTIAL_NEIGHBOUR_PAD, height: region.height + 2 * PARTIAL_NEIGHBOUR_PAD }
        : undefined);
      visible.forEach((i, k) => {
        const vp: Viewport = { ...base, panY: base.panY - offs[i] };
        renderScene(getScene(i), ctx as unknown as CanvasLike, vp, { assets: imageAssets, clear: region || k > 0 ? false : undefined, backgroundOnly: true, region: regionFor(i) });
      });
      // Content pass. During a drag, draw the active page's content last so the
      // dragged element sits above other pages' content too.
      const order = live ? [...visible].sort((a, b) => (a === activeIdx ? 1 : 0) - (b === activeIdx ? 1 : 0)) : visible;
      for (const i of order) {
        const vp: Viewport = { ...base, panY: base.panY - offs[i] };
        renderScene(getScene(i), ctx as unknown as CanvasLike, vp, { assets: imageAssets, clear: false, skipBackground: true, skipNodeId, hiddenIds, fadeIds, clipToPage, revealIds, region: regionFor(i) });
      }
    };
    const rememberScenes = () => {
      paint.scenes = new Map(visible.map((i) => [i, getScene(i)] as const));
    };

    // --- 2. A live transform: repaint only where nodes moved.
    const sameView = last && last.zoom === base.zoom && last.panX === base.panX && last.panY === base.panY && last.dpr === dpr && canvas.width === bw && canvas.height === bh;
    if (reason === "doc" && !paint.fullNeeded && paint.contentFull && last && sameView && live && last.transforming && last.stateKey === stateKey && visible.length > 0) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      let partial = true;
      for (const i of visible) {
        const prev = paint.scenes.get(i);
        if (!prev) { partial = false; break; }
        const change = diffScenes(prev, getScene(i));
        if (change.kind === "all") { partial = false; break; }
        if (change.kind === "none") continue;
        x0 = Math.min(x0, change.rect.x); y0 = Math.min(y0, change.rect.y + offs[i]);
        x1 = Math.max(x1, change.rect.x + change.rect.width); y1 = Math.max(y1, change.rect.y + change.rect.height + offs[i]);
      }
      if (partial) {
        if (x1 < x0) {
          // No node moved (the edit did not touch geometry in view).
          rememberScenes();
          last.rev = st.rev;
          return;
        }
        // To device pixels, padded for antialiasing, clamped to the canvas.
        const s = base.zoom * dpr;
        const PAD = 3;
        const dx0 = Math.max(0, Math.floor((x0 - base.panX) * s) - PAD), dy0 = Math.max(0, Math.floor((y0 - base.panY) * s) - PAD);
        const dx1 = Math.min(bw, Math.ceil((x1 - base.panX) * s) + PAD), dy1 = Math.min(bh, Math.ceil((y1 - base.panY) * s) + PAD);
        const share = (Math.max(0, dx1 - dx0) * Math.max(0, dy1 - dy0)) / (bw * bh);
        if (share <= PARTIAL_MAX_SHARE) {
          if (dx1 > dx0 && dy1 > dy0) {
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.beginPath();
            ctx.rect(dx0, dy0, dx1 - dx0, dy1 - dy0);
            ctx.clip();
            ctx.clearRect(dx0, dy0, dx1 - dx0, dy1 - dy0);
            // The same area in page space, for the renderer to skip the rest.
            drawPages({ x: base.panX + dx0 / s, y: base.panY + dy0 / s, width: (dx1 - dx0) / s, height: (dy1 - dy0) / s });
            ctx.restore();
          }
          rememberScenes();
          last.rev = st.rev;
          return;
        }
      }
    }

    // --- 3. A full repaint.
    sizeCanvas();
    const t0 = performance.now();
    if (visible.length === 0) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    } else {
      drawPages(null);
    }
    paint.last = { zoom: base.zoom, panX: base.panX, panY: base.panY, dpr, width: rect.width, height: rect.height, rev: st.rev, stateKey, transforming: live, ms: performance.now() - t0 };
    paint.contentFull = true;
    paint.fullNeeded = false;
    paint.snap = null;
    rememberScenes();
  });

  // On a doc change, (re)register assets/fonts and repaint. Scenes rebuild lazily
  // per visible page via getScene (the cache invalidates on the rev change).
  useEffect(() => {
    const doc = useEditor.getState().doc;
    imageAssets.registerAll(doc.assets ?? []);
    fonts.ensureForDoc(doc);
    render("doc");
  }, [rev, render]);

  // Repaint when an image asset or a web font finishes loading.
  useEffect(() => imageAssets.onChange(() => { paintRef.current.epoch++; render(); }), [render]);
  useEffect(() => fonts.onChange(() => { paintRef.current.epoch++; render(); }), [render]);

  // Detect continuous pan/zoom: the second viewport change inside MOTION_GAP_MS
  // starts a motion, and SETTLE_MS without a change ends it with a full repaint
  // at full resolution. Declared before the repaint effect so a change that
  // starts a motion is already painted as one.
  useEffect(() => {
    const m = motionRef.current;
    const key = `${viewport.zoom}|${viewport.panX}|${viewport.panY}`;
    if (key === m.prev) return;
    const first = m.prev === "";
    m.prev = key;
    if (first) return;
    const now = performance.now();
    const continuous = now - m.lastChange < MOTION_GAP_MS;
    m.lastChange = now;
    if (!continuous && !m.active) return;
    m.active = true;
    if (m.settle) clearTimeout(m.settle);
    m.settle = setTimeout(() => {
      m.settle = null;
      m.active = false;
      render();
    }, SETTLE_MS);
  }, [viewport, render]);

  // Repaint on viewport, active-page, text-edit (skip), mask-refine (skip),
  // live-transform, or hover change (hover reveals a selected/overflowing
  // element's off-page overflow).
  useEffect(() => {
    render();
  }, [viewport, activePage, editingTextId, maskRefining, transforming, hoverId, render]);

  useEffect(() => () => {
    const m = motionRef.current;
    if (m.settle) clearTimeout(m.settle);
  }, []);

  // Repaint on container resize.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => render());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [canvasRef, render]);

  // Repaint on window resize / device-pixel-ratio change.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => render();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [render]);

  return {
    scene: () => {
      const st = useEditor.getState();
      if (!st.doc.pages.length) return null;
      return getScene(Math.max(0, Math.min(st.activePage, st.doc.pages.length - 1)));
    },
    viewport: buildViewport,
    toPage: (screen) => screenToPage(coordViewport(), screen),
    toScreen: (page) => pageToScreen(coordViewport(), page),
    pageIndexAt: (screen) => {
      const doc = useEditor.getState().doc;
      const offs = pageOffsets(doc);
      const gy = screenToPage(buildViewport(), screen).y; // global stacked Y
      for (let i = 0; i < doc.pages.length; i++) {
        const top = offs[i];
        const bottom = top + doc.pages[i].height + pageGap / 2;
        if (gy < bottom) return i;
      }
      return doc.pages.length - 1;
    },
  };
}
