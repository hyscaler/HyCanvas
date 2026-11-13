// Floating zoom control (bottom-right): zoom in/out, a percentage menu with
// presets, fit-page, and zoom-to-selection. Shared by the design canvas and the
// whiteboard surface so both editors have identical zoom affordances. Renders
// absolutely, so it needs a positioned ancestor. It stacks above the canvas
// overlays (z-20) so page chrome can never cover its buttons.

import { useEffect, useRef, useState } from "react";
import { Minus, Plus, ChevronDown, Check } from "lucide-react";
import { IconButton } from "@/components/ui/IconButton";
import { useEditor } from "@/store/editor";
import { tr } from "@/lib/i18n";
import { useIsPhone } from "@/lib/useIsPhone";

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
  // On a phone, pinch zooms and the bottom edge belongs to the page pill, so
  // the control shrinks to the percentage menu (presets, fit, selection) in
  // the top corner.
  const { isPhone } = useIsPhone();
  const item = "flex w-full items-center px-3 py-1.5 pointer-coarse:py-3 text-start text-sm text-neutral-700 hover:bg-neutral-100";
  return (
    <div data-zoom-control className={`absolute z-30 flex items-center gap-1 rounded-xl border border-neutral-200 bg-surface shadow-md ${isPhone ? "end-3 top-3 p-0.5" : "bottom-4 end-4 px-1.5 py-1"}`}>
      {!isPhone && <IconButton size="sm" aria-label={tr("editor.zoom_out")} onClick={() => by(0.8)}><Minus size={16} /></IconButton>}
      <div ref={ref} className="relative">
        <button
          onClick={() => setMenuOpen((v) => !v)}
          title={tr("editor.zoom_level")}
          aria-label={tr("editor.zoom_level")}
          aria-expanded={menuOpen}
          className={`flex w-16 items-center justify-center gap-0.5 rounded-md text-xs font-semibold ${isPhone ? "h-10" : "py-1"} ${menuOpen ? "bg-neutral-100 text-neutral-800" : "text-neutral-600 hover:bg-neutral-100"}`}
        >
          {Math.round(zoom * 100)}%
          <ChevronDown size={12} className="text-neutral-400" />
        </button>
        {menuOpen && (
          <div className={`absolute end-0 z-50 w-44 overflow-hidden rounded-xl border border-neutral-200 bg-surface py-1 shadow-lg ${isPhone ? "top-full mt-2" : "bottom-full mb-2"}`}>
            {ZOOM_PRESETS.map((z) => (
              <button
                key={z}
                onClick={() => run(() => setZoom(z))}
                className={`${item} justify-between`}
              >
                {Math.round(z * 100)}%
                {Math.abs(zoom - z) < 0.005 && <Check size={14} className="text-brand-ink" />}
              </button>
            ))}
            <div className="my-1 h-px bg-neutral-100" />
            <button onClick={() => run(() => useEditor.getState().fitToScreen())} className={item}>
              {tr("editor.fit_page")}
            </button>
            <button onClick={() => run(() => useEditor.getState().zoomToSelection())} className={item}>
              {tr("editor.zoom_to_selection")}
            </button>
          </div>
        )}
      </div>
      {!isPhone && (
        <>
          <IconButton size="sm" aria-label={tr("editor.zoom_in")} onClick={() => by(1.25)}><Plus size={16} /></IconButton>
          <button onClick={() => useEditor.getState().fitToScreen()} className="ms-1 rounded-md px-2 py-1 pointer-coarse:py-2.5 text-xs font-medium text-neutral-500 hover:bg-neutral-100" title={tr("editor.fit_page_shift_1")}>
            {tr("editor.fit")}
          </button>
          <button onClick={() => useEditor.getState().zoomToSelection()} className="rounded-md px-2 py-1 pointer-coarse:py-2.5 text-xs font-medium text-neutral-500 hover:bg-neutral-100" title={tr("editor.zoom_to_selection_shift_2")}>
            {tr("editor.selection")}
          </button>
        </>
      )}
    </div>
  );
}
