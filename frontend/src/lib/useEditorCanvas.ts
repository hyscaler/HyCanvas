// Binds the editor store to a real <canvas>: builds @hc/engine scenes from the
// document and renders them through the Canvas2D path at the store viewport
// (with device-pixel-ratio handling), re-rendering on document/viewport/resize.
//
// Continuous multi-page scroll: all pages are drawn stacked vertically (each at
// a cumulative page-space offset), so scrolling reveals the whole document like
// Canva. Editing still targets the ACTIVE page: the coordinate helpers map
// screen <-> the active page's local space at its stacked offset, so selection,
// the gizmo, and hit-testing keep working unchanged. A single-page document has
// offset 0, so it behaves exactly as before.

import { useCallbackRef } from "@/lib/useCallbackRef";
import { useEffect, useRef, type RefObject } from "react";
import { createScene, type CanvasLike, type Point, type Scene, type Viewport } from "@hc/engine";
import { pageToScreen, screenToPage } from "@hc/engine";
import { renderScene } from "@hc/engine";
import type { DesignFile } from "@hc/schema";
import { useEditor } from "@/store/editor";
import { imageAssets } from "@/lib/assetProvider";
import { fonts } from "@/lib/fontProvider";

export interface CanvasApi {
  scene: () => Scene | null;
  viewport: () => Viewport;
  toPage: (screen: Point) => Point;
  toScreen: (page: Point) => Point;
  /** Index of the page whose stacked band contains a screen point (for
   *  click-to-activate in continuous-scroll mode). */
  pageIndexAt: (screen: Point) => number;
}

/** Gap between stacked pages, in page-space units. */
const PAGE_GAP = 72;

/** Cumulative top offset (page-space Y) of each page in the stack. */
function pageOffsets(doc: DesignFile): number[] {
  const offs: number[] = [];
  let y = 0;
  for (const p of doc.pages) {
    offs.push(y);
    y += p.height + PAGE_GAP;
  }
  return offs;
}

export function useEditorCanvas(canvasRef: RefObject<HTMLCanvasElement | null>): CanvasApi {
  // Lazily-built, per-page scene cache, invalidated when the doc rev changes.
  // Only pages that are drawn (visible) get built, so a 100+ page document does
  // O(visible) work per edit/scroll instead of O(all pages).
  const sceneCacheRef = useRef<{ rev: number; scenes: Map<number, Scene> }>({ rev: -1, scenes: new Map() });
  const sizeRef = useRef({ width: 1, height: 1, dpr: 1 });
  const fittedRef = useRef(false);
  const rev = useEditor((s) => s.rev);
  const viewport = useEditor((s) => s.viewport);
  const activePage = useEditor((s) => s.activePage);
  const editingTextId = useEditor((s) => s.editingTextId);
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

  const render = useCallbackRef(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
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
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const base = buildViewport();
    const doc = useEditor.getState().doc;
    if (!doc.pages.length) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
    const offs = pageOffsets(doc);
    // Viewport culling: only draw pages whose stacked band intersects the visible
    // area (plus a half-screen buffer so scrolling reveals neighbors smoothly).
    const z = base.zoom || 1;
    const viewTop = base.panY;
    const viewBottom = base.panY + (base.height || 0) / z;
    const buf = ((base.height || 0) / z) * 0.5;
    const skipNodeId = useEditor.getState().editingTextId ?? undefined;
    let drawn = 0;
    for (let i = 0; i < doc.pages.length; i++) {
      const top = offs[i];
      const bottom = top + doc.pages[i].height;
      if (bottom < viewTop - buf || top > viewBottom + buf) continue;
      const vp: Viewport = { ...base, panY: base.panY - top };
      // Clear the whole canvas once (on the first drawn page), then composite the
      // rest on top so stacked pages don't erase each other.
      renderScene(getScene(i), ctx as unknown as CanvasLike, vp, { assets: imageAssets, clear: drawn === 0 ? undefined : false, skipNodeId });
      drawn++;
    }
    if (drawn === 0) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); }
  });

  // On a doc change, (re)register assets/fonts and repaint. Scenes rebuild lazily
  // per visible page via getScene (the cache invalidates on the rev change).
  useEffect(() => {
    const doc = useEditor.getState().doc;
    imageAssets.registerAll(doc.assets ?? []);
    fonts.ensureForDoc(doc);
    render();
  }, [rev, render]);

  // Repaint when an image asset or a web font finishes loading.
  useEffect(() => imageAssets.onChange(() => render()), [render]);
  useEffect(() => fonts.onChange(() => render()), [render]);

  // Repaint on viewport, active-page, or text-edit (skip) change.
  useEffect(() => {
    render();
  }, [viewport, activePage, editingTextId, render]);

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
        const bottom = top + doc.pages[i].height + PAGE_GAP / 2;
        if (gy < bottom) return i;
      }
      return doc.pages.length - 1;
    },
  };
}
