// Mini-map / zoom overview (a la Canva's navigator): a small thumbnail of the
// CONTENT extent of the page currently under the viewport (all nodes unioned
// with the page rect, so it tracks objects parked beyond the page edge on an
// infinite board, F30 FR-1) with a rectangle marking the visible viewport. Click
// or drag inside it to pan. Shown only when content extends beyond the visible
// viewport (i.e. panning is meaningful).
//
// Coordinate spaces matter here: pages are stacked vertically in WORLD space
// (page i occupies world Y [pageTop(i), pageTop(i)+height]) while node/content
// bounds are page-LOCAL (Y from 0). The viewport (panX/panY) is world space, so
// the "you are here" rectangle maps the viewport into the viewed page's local
// space by subtracting that page's stacked offset. We resolve the viewed page
// from the viewport (not the active page) so it stays correct during wheel
// scroll (which does not change the active page).
//
// Like the main canvas, the thumbnail registers the doc's fonts and image assets
// and repaints when they finish loading; without that, text and images render
// blank in the overview.

import { useCallback, useEffect, useRef } from "react";
import { createScene, renderScene, type CanvasLike, type Viewport } from "@hc/engine";
import { useEditor } from "@/store/editor";
import { imageAssets } from "@/lib/assetProvider";
import { fonts } from "@/lib/fontProvider";
import { PAGE_GAP, pageOffsets } from "@/lib/pageLayout";

const MAP_W = 150;
const MAP_MAX_H = 110;

export function MiniMap() {
  const rev = useEditor((s) => s.rev);
  const activePage = useEditor((s) => s.activePage);
  const viewport = useEditor((s) => s.viewport);
  const viewportSize = useEditor((s) => s.viewportSize);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const doc = useEditor.getState().doc;
  void activePage; // read as a subscription so the map re-renders on page switches

  const z = viewport.zoom || 1;
  const visX = viewportSize.width / z;
  const visY = viewportSize.height / z;

  // Which page is under the viewport center? (Its stacked band contains the
  // center; same half-gap rule as the canvas hit-testing.)
  const offs = pageOffsets(doc);
  const worldCY = viewport.panY + visY / 2;
  let viewed = doc.pages.length - 1;
  for (let i = 0; i < doc.pages.length; i++) {
    if (worldCY < offs[i] + doc.pages[i].height + PAGE_GAP / 2) { viewed = i; break; }
  }
  const page = doc.pages[viewed];
  const pageOffY = offs[viewed] ?? 0;

  // Content extent of the viewed page (node union ∪ page rect), page-local.
  const bounds = useEditor.getState().pageContentBounds(viewed) ?? { x: 0, y: 0, width: page?.width ?? 1, height: page?.height ?? 1 };
  const bw = Math.max(1, bounds.width);
  const bh = Math.max(1, bounds.height);
  const scale = Math.min(MAP_W / bw, MAP_MAX_H / bh);
  const mw = Math.max(1, Math.round(bw * scale));
  const mh = Math.max(1, Math.round(bh * scale));

  // Visible region -> map coords. X: world == page-local (pages sit at x=0). Y:
  // rebase the world viewport top into the viewed page's local space.
  const rectLeft = (viewport.panX - bounds.x) * scale;
  const rectTop = (viewport.panY - pageOffY - bounds.y) * scale;
  const rectW = visX * scale;
  const rectH = visY * scale;
  let rl = rectLeft, rt = rectTop, rw = rectW, rh = rectH;
  if (rl < 0) { rw += rl; rl = 0; }
  if (rt < 0) { rh += rt; rt = 0; }
  rw = Math.max(3, Math.min(rw, mw - rl));
  rh = Math.max(3, Math.min(rh, mh - rt));

  const fits = visX >= bw - 1 && visY >= bh - 1;

  // Paint the viewed page's content into the thumbnail. Shared by the layout
  // effect and the asset/font load subscriptions so late-loading text and images
  // fill in instead of leaving a blank overview.
  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !page) return;
    canvas.width = mw;
    canvas.height = mh;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, mw, mh);
    // Pan the overview to the content origin so off-page (incl. negative) content
    // is captured; unclipped (no page clip) so the full extent shows.
    const vp: Viewport = { zoom: scale, panX: bounds.x, panY: bounds.y, dpr: 1, width: mw, height: mh };
    try {
      renderScene(createScene(doc, viewed), ctx as unknown as CanvasLike, vp, { assets: imageAssets, cull: false });
    } catch {
      /* tainted image: leave what we have */
    }
    // A hairline page border so the artboard always reads as a card (Canva-like),
    // even when its background is white or it is mostly empty.
    const px = (0 - bounds.x) * scale;
    const py = (0 - bounds.y) * scale;
    ctx.strokeStyle = "rgba(0,0,0,0.18)";
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 0.5, py + 0.5, page.width * scale - 1, page.height * scale - 1);
  }, [doc, viewed, mw, mh, scale, bounds.x, bounds.y, page, rev]);

  // Register the doc's assets/fonts (idempotent) and paint; repaint when any
  // finish loading, mirroring the main canvas. `fits` must be a dependency:
  // when the map transitions hidden -> visible (zooming in flips `fits` false
  // and mounts the canvas) none of paint's own inputs change, so without it
  // the fresh canvas stays blank until the next document edit repaints it.
  useEffect(() => {
    imageAssets.registerAll(doc.assets ?? []);
    fonts.ensureForDoc(doc);
    paint();
  }, [doc, paint, fits]);
  useEffect(() => imageAssets.onChange(() => paint()), [paint]);
  useEffect(() => fonts.onChange(() => paint()), [paint]);

  if (!page || fits) return null;

  const panTo = (clientX: number, clientY: number) => {
    const el = canvasRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = bounds.x + (clientX - r.left) / scale; // page-local (== world x)
    const py = bounds.y + (clientY - r.top) / scale; // page-local y
    // Recenter the viewport on that point, back in world coords (add the page's
    // stacked offset to Y).
    useEditor.getState().setViewport({ panX: px - visX / 2, panY: pageOffY + py - visY / 2 });
  };

  // Sits above the zoom control (pinned at bottom-4 right-4) so the two do not
  // overlap in the bottom-right corner.
  return (
    <div className="absolute bottom-16 right-4 z-10 overflow-hidden rounded-lg border border-neutral-200 bg-surface shadow-md" style={{ width: mw, height: mh }}>
      <canvas
        ref={canvasRef}
        className="block cursor-pointer"
        onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); panTo(e.clientX, e.clientY); }}
        onPointerMove={(e) => { if (e.buttons === 1) panTo(e.clientX, e.clientY); }}
      />
      <div
        className="pointer-events-none absolute border-2 border-brand-500/80"
        style={{ left: rl, top: rt, width: rw, height: rh }}
      />
    </div>
  );
}
