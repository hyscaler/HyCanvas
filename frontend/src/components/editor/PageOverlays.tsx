// Per-page headers for continuous-scroll mode above each stacked
// page, a row with "Page N - <title>" and quick tools (move up/down, hide, lock,
// duplicate, delete), plus an "Add page" button below the last page. Rendered in
// screen space over the canvas; positions track scroll/zoom via the base viewport.

import { ChevronUp, ChevronDown, Eye, EyeOff, Lock, LockOpen, CopyPlus, Trash2, Plus, Sparkles } from "lucide-react";
import { pageToScreen } from "@hc/engine";
import { useEditor } from "@/store/editor";
import { promptText } from "@/lib/promptDialog";
import { requestAi } from "@/lib/aiRequests";
import type { CanvasApi } from "@/lib/useEditorCanvas";
import { pageGap } from "@/lib/pageLayout";
import { tr } from "@/lib/i18n";

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
  const maskRefining = useEditor((s) => s.maskRefining);
  const presenting = useEditor((s) => s.presenting);
  const doc = useEditor.getState().doc;
  const st = useEditor.getState();

  if (cropping || maskRefining || presenting) return null;

  const base = api.viewport();
  const z = base.zoom;
  const n = doc.pages.length;

  // Stacked offset (page-space Y) of page i.
  const offsetOf = (i: number) => doc.pages.slice(0, i).reduce((a, q) => a + q.height + pageGap, 0);
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
              onClick={async () => { const t = await promptText({ title: `Page ${i + 1} title`, label: tr("editor.title"), placeholder: tr("editor.add_page_title"), defaultValue: p.name ?? "", confirmText: "Save" }); if (t !== null) st.setPageName(i, t); }}
              className="min-w-0 truncate text-neutral-400 hover:text-neutral-700"
              title={tr("editor.rename_page")}
            >{p.name ? `- ${p.name}` : "- Add page title"}</button>
            <span className="flex-1" />
            <div className={`flex shrink-0 items-center gap-0.5 rounded-lg bg-surface/90 px-0.5 shadow-sm ring-1 ring-black/5 transition-opacity ${isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
              <HdrBtn icon={ChevronUp} title={tr("editor.move_up")} disabled={i === 0} onClick={() => st.movePage(i, i - 1)} />
              <HdrBtn icon={ChevronDown} title={tr("editor.move_down")} disabled={i === n - 1} onClick={() => st.movePage(i, i + 1)} />
              <HdrBtn icon={hidden ? EyeOff : Eye} title={hidden ? tr("editor.unhide_while_presenting") : tr("editor.hide_while_presenting")} onClick={() => st.setPageHidden(!hidden, i)} />
              <HdrBtn icon={allLocked ? Lock : LockOpen} title={allLocked ? tr("editor.unlock_all_on_page") : tr("editor.lock_all_on_page")} onClick={() => st.setPageLocked(i, !allLocked)} />
              {/* Per-slide regeneration is a full tool - it keeps the layout,
                  the slide's identity and any images whose prompts did not
                  change - but it had no button anywhere, so it could only be
                  reached by typing "redo slide 3" and hoping the planner
                  routed it. The assistant panel performs the request. */}
              <HdrBtn
                icon={Sparkles}
                title={tr("editor.regenerate_this_slide_with_ai")}
                onClick={async () => {
                  const instruction = await promptText({
                    title: tr("editor.regenerate_slide_n", { n: i + 1 }),
                    label: tr("editor.what_should_change"),
                    placeholder: tr("editor.eg_more_data_driven_shorter"),
                    defaultValue: "",
                    confirmText: tr("editor.regenerate"),
                  });
                  if (instruction === null) return;
                  st.setActivePage(i);
                  requestAi({ kind: "action", action: "regenerateSlide", pageIndex: i, instruction: instruction.trim() || tr("editor.improve_this_slide") }, Date.now());
                }}
              />
              <HdrBtn icon={CopyPlus} title={tr("editor.duplicate_page")} onClick={() => st.duplicatePage(i)} />
              <HdrBtn icon={Trash2} title={tr("editor.delete_page")} danger disabled={n <= 1} onClick={() => st.deletePage(i)} />
            </div>
          </div>
        );
      })}
      <div className="pointer-events-auto absolute" style={{ left: addLeft, top: lastBottom + 18, width: addWidth }}>
        <button
          onClick={() => st.addPage()}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-neutral-300 bg-surface py-2.5 text-sm font-medium text-neutral-600 shadow-sm transition hover:border-brand-400 hover:text-brand-ink"
        >
          <Plus size={16} /> {tr("editor.add_page")}
        </button>
      </div>
    </div>
  );
}
