// Pages strip (Canva-style): live thumbnails you can switch, drag to reorder,
// add, duplicate, and delete.

import { useEffect, useRef, useState } from "react";
import { Plus, Copy, Trash2, Eye, EyeOff } from "lucide-react";
import { createScene, renderScene, type CanvasLike, type Viewport } from "@hc/engine";
import { useEditor } from "@/store/editor";
import { imageAssets } from "@/lib/assetProvider";

const THUMB_W = 80;
const THUMB_H = 52;

function PageThumb({ index }: { index: number }) {
  const rev = useEditor((s) => s.rev);
  const activePage = useEditor((s) => s.activePage);
  // Only the active page is editable, so a non-active thumbnail's content can't
  // change between renders; gate its re-render on rev so a single drag doesn't
  // rebuild every page's scene. Structural ops (add/move/delete) re-key/re-index
  // the row, which re-runs the effect anyway.
  const liveRev = index === activePage ? rev : 0;
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const doc = useEditor.getState().doc;
    const pg = doc.pages[index];
    if (!pg) return;
    const scale = Math.min(THUMB_W / pg.width, THUMB_H / pg.height);
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
  }, [liveRev, index]);
  return <canvas ref={ref} className="max-h-full max-w-full" />;
}

export function PagesBar() {
  useEditor((s) => s.rev);
  const active = useEditor((s) => s.activePage);
  const pages = useEditor.getState().doc.pages;
  const st = useEditor.getState;
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  return (
    <div className="oc-scroll flex shrink-0 items-center gap-2 overflow-x-auto border-t border-neutral-200 bg-white px-3 py-2">
      {pages.map((p, i) => {
        const hidden = !!(p as { hidden?: boolean }).hidden;
        return (
        <div key={p.id} className="group relative shrink-0">
          <button
            draggable
            onDragStart={() => setDragIdx(i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => { if (dragIdx !== null && dragIdx !== i) st().movePage(dragIdx, i); setDragIdx(null); }}
            onDragEnd={() => setDragIdx(null)}
            onClick={() => {
              const s = st();
              s.setActivePage(i);
              // Scroll the stacked canvas so this page sits near the top of the
              // viewport (PAGE_GAP must match useEditorCanvas: 48).
              let off = 0;
              for (let k = 0; k < i; k++) off += (s.doc.pages[k]?.height ?? 0) + 72;
              s.setViewport({ panY: off - 40 / (s.viewport.zoom || 1) });
            }}
            title={`${p.name ?? `Page ${i + 1}`}${hidden ? " (hidden in present)" : ""}`}
            className={`relative grid place-items-center overflow-hidden rounded-md border bg-white transition ${
              i === active ? "border-brand-500 ring-2 ring-brand-200" : "border-neutral-200 hover:border-neutral-300"
            } ${dragIdx === i ? "opacity-50" : ""} ${hidden ? "opacity-50" : ""}`}
            style={{ width: THUMB_W, height: THUMB_H }}
          >
            <PageThumb index={i} />
            {hidden && (
              <span className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-0.5 bg-neutral-900/70 py-0.5 text-[9px] font-medium text-white">
                <EyeOff size={9} /> Hidden
              </span>
            )}
          </button>
          <span className="mt-0.5 block text-center text-[10px] text-neutral-400">{i + 1}</span>
          <button
            onClick={() => st().setPageHidden(!hidden, i)}
            title={hidden ? "Show slide while presenting" : "Hide slide while presenting"}
            className="absolute -left-1.5 -top-1.5 hidden h-5 w-5 place-items-center rounded-full bg-white text-neutral-400 shadow group-hover:grid hover:text-brand-700"
          >
            {hidden ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
          {pages.length > 1 && (
            <button
              onClick={() => st().deletePage(i)}
              title="Delete page"
              className="absolute -right-1.5 -top-1.5 hidden h-5 w-5 place-items-center rounded-full bg-white text-neutral-400 shadow group-hover:grid hover:text-red-600"
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
        );
      })}
      <button
        onClick={() => st().duplicatePage()}
        title="Duplicate current page"
        className="grid shrink-0 place-items-center rounded-md border border-neutral-200 text-neutral-500 hover:border-brand-300 hover:text-brand-700"
        style={{ width: 40, height: THUMB_H }}
      >
        <Copy size={16} />
      </button>
      <button
        onClick={() => st().addPage()}
        title="Add page"
        className="grid shrink-0 place-items-center rounded-md border border-dashed border-neutral-300 text-neutral-500 hover:border-brand-400 hover:text-brand-700"
        style={{ width: 40, height: THUMB_H }}
      >
        <Plus size={18} />
      </button>
      <span className="ml-1 shrink-0 text-xs text-neutral-400">Page {active + 1} of {pages.length}</span>
    </div>
  );
}
