// Per-page headers for continuous-scroll mode (Canva-style): above each stacked
// page, a row with "Page N - <title>" and quick tools (move up/down, hide, lock,
// duplicate, delete), plus an "Add page" button below the last page. Rendered in
// screen space over the canvas; positions track scroll/zoom via the base viewport.

import { ChevronUp, ChevronDown, Eye, EyeOff, Lock, LockOpen, CopyPlus, Trash2, Plus } from "lucide-react";
import { pageToScreen } from "@hc/engine";
import { useEditor } from "@/store/editor";
import { promptText } from "@/lib/promptDialog";
import type { CanvasApi } from "@/lib/useEditorCanvas";
import { PAGE_GAP } from "@/lib/pageLayout";

function HdrBtn({ icon: Icon, title, onClick, disabled, danger }: { icon: typeof ChevronUp; title: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={`grid h-7 w-7 place-items-center rounded-md transition disabled:opacity-30 ${danger ? "text-neutral-500 hover:bg-red-50 hover:text-red-600" : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"}`}
    >
      <Icon size={15} />
    </button>
  );
}

export function PageOverlays({ api }: { api: CanvasApi }) {
  useEditor((s) => s.rev);
  useEditor((s) => s.viewport);
  const activePage = useEditor((s) => s.activePage);
  const cropping = useEditor((s) => s.cropping);
  const presenting = useEditor((s) => s.presenting);
  const doc = useEditor.getState().doc;
  const st = useEditor.getState();

  if (cropping || presenting) return null;

  const base = api.viewport();
  const z = base.zoom;
  const n = doc.pages.length;

  // Stacked offset (page-space Y) of page i.
  const offsetOf = (i: number) => doc.pages.slice(0, i).reduce((a, q) => a + q.height + PAGE_GAP, 0);
  // Viewport culling: only render headers for pages near the visible area, so a
  // 100+ page document doesn't mount a DOM row per page.
  const viewTop = base.panY;
  const viewBottom = base.panY + (base.height || 0) / (z || 1);
  const buf = ((base.height || 0) / (z || 1)) * 0.5;
  const rows = doc.pages
    .map((p, i) => ({ i, p, top: offsetOf(i) }))
    .filter(({ p, top }) => top + p.height >= viewTop - buf && top <= viewBottom + buf)
    .map(({ i, p, top }) => {
      const tl = pageToScreen(base, { x: 0, y: top });
      return { i, p, x: tl.x, top: tl.y, width: Math.max(220, p.width * z) };
    });
  // "Add page" button sits below the last page (computed independently of culling).
  const lastIdx = n - 1;
  const lastBottom = pageToScreen(base, { x: 0, y: offsetOf(lastIdx) }).y + doc.pages[lastIdx].height * z;
  const addLeft = pageToScreen(base, { x: 0, y: 0 }).x;
  const addWidth = Math.max(220, doc.pages[lastIdx].width * z);

  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      {rows.map(({ i, p, x, top, width }) => {
        const hidden = !!(p as { hidden?: boolean }).hidden;
        const isActive = i === activePage;
        const allLocked = p.children.length > 0 && p.children.every((c) => (c as { locked?: boolean }).locked);
        return (
          <div
            key={p.id}
            className="group pointer-events-auto absolute flex items-center gap-1.5 text-xs"
            style={{ left: x, top: top - 32, width }}
          >
            <button onClick={() => st.setActivePage(i)} className={`shrink-0 font-semibold ${isActive ? "text-neutral-800" : "text-neutral-400 hover:text-neutral-700"}`}>Page {i + 1}</button>
            <button
              onClick={async () => { const t = await promptText({ title: `Page ${i + 1} title`, label: "Title", placeholder: "Add page title", defaultValue: p.name ?? "", confirmText: "Save" }); if (t !== null) st.setPageName(i, t); }}
              className="min-w-0 truncate text-neutral-400 hover:text-neutral-700"
              title="Rename page"
            >{p.name ? `- ${p.name}` : "- Add page title"}</button>
            <span className="flex-1" />
            <div className={`flex shrink-0 items-center gap-0.5 rounded-lg bg-surface/90 px-0.5 shadow-sm ring-1 ring-black/5 transition-opacity ${isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
              <HdrBtn icon={ChevronUp} title="Move up" disabled={i === 0} onClick={() => st.movePage(i, i - 1)} />
              <HdrBtn icon={ChevronDown} title="Move down" disabled={i === n - 1} onClick={() => st.movePage(i, i + 1)} />
              <HdrBtn icon={hidden ? EyeOff : Eye} title={hidden ? "Unhide while presenting" : "Hide while presenting"} onClick={() => st.setPageHidden(!hidden, i)} />
              <HdrBtn icon={allLocked ? Lock : LockOpen} title={allLocked ? "Unlock all on page" : "Lock all on page"} onClick={() => st.setPageLocked(i, !allLocked)} />
              <HdrBtn icon={CopyPlus} title="Duplicate page" onClick={() => st.duplicatePage(i)} />
              <HdrBtn icon={Trash2} title="Delete page" danger disabled={n <= 1} onClick={() => st.deletePage(i)} />
            </div>
          </div>
        );
      })}
      <div className="pointer-events-auto absolute" style={{ left: addLeft, top: lastBottom + 18, width: addWidth }}>
        <button
          onClick={() => st.addPage()}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-neutral-300 bg-surface py-2.5 text-sm font-medium text-neutral-600 shadow-sm transition hover:border-brand-400 hover:text-brand-ink"
        >
          <Plus size={16} /> Add page
        </button>
      </div>
    </div>
  );
}
