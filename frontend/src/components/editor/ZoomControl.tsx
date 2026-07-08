// Floating zoom control (bottom-right): zoom in/out, a percentage menu with
// presets, fit-page, and zoom-to-selection. Shared by the design canvas and the
// whiteboard surface so both editors have identical zoom affordances. Renders
// absolutely, so it needs a positioned ancestor.

import { useEffect, useRef, useState } from "react";
import { Minus, Plus, ChevronDown, Check } from "lucide-react";
import { IconButton } from "@/components/ui/IconButton";
import { useEditor } from "@/store/editor";

const ZOOM_PRESETS = [0.25, 0.5, 1, 2];

export function ZoomControl() {
  const zoom = useEditor((s) => s.viewport.zoom);
  const setViewport = useEditor((s) => s.setViewport);
  const [menuOpen, setMenuOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const by = (f: number) => setViewport({ zoom: Math.min(8, Math.max(0.05, zoom * f)) });
  // Zoom to an absolute level while keeping the viewport centre fixed, mirroring
  // the canvas Cmd+/- path so the % presets feel identical to keyboard zoom.
  const setZoom = (z: number) => {
    const s = useEditor.getState();
    const { panX, panY, zoom: cur } = s.viewport;
    const vs = s.viewportSize;
    const cx = panX + vs.width / 2 / cur;
    const cy = panY + vs.height / 2 / cur;
    s.setViewport({ zoom: z, panX: cx - vs.width / 2 / z, panY: cy - vs.height / 2 / z });
  };
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setMenuOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [menuOpen]);
  const run = (fn: () => void) => { setMenuOpen(false); fn(); };
  return (
    <div className="absolute bottom-4 right-4 flex items-center gap-1 rounded-xl border border-neutral-200 bg-surface px-1.5 py-1 shadow-md">
      <IconButton size="sm" aria-label="Zoom out" onClick={() => by(0.8)}><Minus size={16} /></IconButton>
      <div ref={ref} className="relative">
        <button
          onClick={() => setMenuOpen((v) => !v)}
          title="Zoom level"
          aria-label="Zoom level"
          className={`flex w-16 items-center justify-center gap-0.5 rounded-md py-1 text-xs font-semibold ${menuOpen ? "bg-neutral-100 text-neutral-800" : "text-neutral-600 hover:bg-neutral-100"}`}
        >
          {Math.round(zoom * 100)}%
          <ChevronDown size={12} className="text-neutral-400" />
        </button>
        {menuOpen && (
          <div className="absolute bottom-full right-0 z-50 mb-2 w-44 overflow-hidden rounded-xl border border-neutral-200 bg-surface py-1 shadow-lg">
            {ZOOM_PRESETS.map((z) => (
              <button
                key={z}
                onClick={() => run(() => setZoom(z))}
                className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm text-neutral-700 hover:bg-neutral-100"
              >
                {Math.round(z * 100)}%
                {Math.abs(zoom - z) < 0.005 && <Check size={14} className="text-brand-ink" />}
              </button>
            ))}
            <div className="my-1 h-px bg-neutral-100" />
            <button onClick={() => run(() => useEditor.getState().fitToScreen())} className="flex w-full items-center px-3 py-1.5 text-left text-sm text-neutral-700 hover:bg-neutral-100">
              Fit page
            </button>
            <button onClick={() => run(() => useEditor.getState().zoomToSelection())} className="flex w-full items-center px-3 py-1.5 text-left text-sm text-neutral-700 hover:bg-neutral-100">
              Zoom to selection
            </button>
          </div>
        )}
      </div>
      <IconButton size="sm" aria-label="Zoom in" onClick={() => by(1.25)}><Plus size={16} /></IconButton>
      <button onClick={() => useEditor.getState().fitToScreen()} className="ml-1 rounded-md px-2 py-1 text-xs font-medium text-neutral-500 hover:bg-neutral-100" title="Fit page (Shift+1)">
        Fit
      </button>
      <button onClick={() => useEditor.getState().zoomToSelection()} className="rounded-md px-2 py-1 text-xs font-medium text-neutral-500 hover:bg-neutral-100" title="Zoom to selection (Shift+2)">
        Selection
      </button>
    </div>
  );
}
