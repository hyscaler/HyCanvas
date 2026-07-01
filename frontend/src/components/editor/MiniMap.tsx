// Mini-map / zoom overview: a small thumbnail of the active page's CONTENT extent
// (all nodes unioned with the page rect, so it tracks objects parked beyond the
// page edge on an infinite board, F30 FR-1) with a rectangle marking the visible
// viewport. Click or drag inside it to pan. Shown only when content extends beyond
// the visible viewport (i.e. panning is meaningful).

import { useEffect, useRef } from "react";
import { createScene, renderScene, type CanvasLike, type Viewport } from "@hc/engine";
import { useEditor } from "@/store/editor";
import { imageAssets } from "@/lib/assetProvider";

const MAP_W = 150;
const MAP_MAX_H = 110;

export function MiniMap() {
  const rev = useEditor((s) => s.rev);
  const activePage = useEditor((s) => s.activePage);
  const viewport = useEditor((s) => s.viewport);
  const viewportSize = useEditor((s) => s.viewportSize);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const doc = useEditor.getState().doc;
  const page = doc.pages[activePage];
  // Content extent (node union ∪ page rect). The store memoizes contentBounds() by
  // rev/page, so calling it every render (incl. each pan frame) is O(1) unless the
  // scene actually changed. rev/activePage are read as subscriptions so this
  // re-renders on edits and page switches.
  void rev;
  void activePage;
  const bounds = useEditor.getState().contentBounds() ?? { x: 0, y: 0, width: page?.width ?? 1, height: page?.height ?? 1 };
  const bw = Math.max(1, bounds.width);
  const bh = Math.max(1, bounds.height);
  const scale = Math.min(MAP_W / bw, MAP_MAX_H / bh);
  const mw = Math.max(1, Math.round(bw * scale));
  const mh = Math.max(1, Math.round(bh * scale));

  // Visible region in page coords -> map coords (offset by the content origin).
  const z = viewport.zoom || 1;
  const visX = viewportSize.width / z;
  const visY = viewportSize.height / z;
  const rectLeft = (viewport.panX - bounds.x) * scale;
  const rectTop = (viewport.panY - bounds.y) * scale;
  const rectW = visX * scale;
  const rectH = visY * scale;

  // Hide when the visible viewport already covers all content (nothing to overview).
  const fits = visX >= bw - 1 && visY >= bh - 1;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !page) return;
    canvas.width = mw;
    canvas.height = mh;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, mw, mh);
    // Pan the overview to the content origin so off-page (incl. negative) content
    // is captured; cull is implicitly disabled (the whole extent is in view).
    const vp: Viewport = { zoom: scale, panX: bounds.x, panY: bounds.y, dpr: 1, width: mw, height: mh };
    try {
      renderScene(createScene(doc, activePage), ctx as unknown as CanvasLike, vp, { assets: imageAssets });
    } catch {
      /* tainted image: leave the white thumbnail */
    }
  }, [rev, activePage, mw, mh, scale, doc, page, bounds.x, bounds.y]);

  if (!page || fits) return null;

  const panTo = (clientX: number, clientY: number) => {
    const el = canvasRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = bounds.x + (clientX - r.left) / scale;
    const py = bounds.y + (clientY - r.top) / scale;
    useEditor.getState().setViewport({ panX: px - visX / 2, panY: py - visY / 2 });
  };

  // Sits above the zoom control (pinned at bottom-4 right-4) so the two do not
  // overlap in the bottom-right corner.
  return (
    <div className="absolute bottom-16 right-4 z-10 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-md" style={{ width: mw, height: mh }}>
      <canvas
        ref={canvasRef}
        className="block cursor-pointer"
        onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); panTo(e.clientX, e.clientY); }}
        onPointerMove={(e) => { if (e.buttons === 1) panTo(e.clientX, e.clientY); }}
      />
      <div
        className="pointer-events-none absolute border-2 border-brand-500/80"
        style={{
          left: Math.max(0, Math.min(rectLeft, mw)),
          top: Math.max(0, Math.min(rectTop, mh)),
          width: Math.max(4, Math.min(rectW, mw)),
          height: Math.max(4, Math.min(rectH, mh)),
        }}
      />
    </div>
  );
}
