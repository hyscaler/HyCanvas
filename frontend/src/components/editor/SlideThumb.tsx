// A rendered thumbnail of one page, shared by the slide bar and the overview
// (doc 28 FR-5). Extracted so both surfaces draw through one code path: a
// thumbnail that disagreed with the canvas would be worse than none.
//
// Only the active page can change, so a non-active thumbnail's scene cannot
// differ between renders; its repaint is gated on `rev` accordingly, which
// keeps a single drag from rebuilding every page's scene.

import { useEffect, useRef } from "react";
import { createScene, renderScene, type CanvasLike, type Viewport } from "@hc/engine";
import { imageAssets } from "@/lib/assetProvider";
import { useEditor } from "@/store/editor";

export function SlideThumb({ index, width, height }: { index: number; width: number; height: number }) {
  const rev = useEditor((s) => s.rev);
  const activePage = useEditor((s) => s.activePage);
  const liveRev = index === activePage ? rev : 0;
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const doc = useEditor.getState().doc;
    const pg = doc.pages[index];
    if (!pg) return;
    const scale = Math.min(width / pg.width, height / pg.height);
    const cw = Math.max(1, Math.round(pg.width * scale));
    const ch = Math.max(1, Math.round(pg.height * scale));
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, cw, ch);
    const vp: Viewport = { zoom: scale, panX: 0, panY: 0, dpr: 1, width: cw, height: ch };
    try {
      renderScene(createScene(doc, index), ctx as unknown as CanvasLike, vp, { assets: imageAssets });
    } catch {
      /* a tainted/cross-origin image can throw; the thumbnail just shows white */
    }
  }, [liveRev, index, width, height]);

  return <canvas ref={ref} className="max-h-full max-w-full" />;
}
