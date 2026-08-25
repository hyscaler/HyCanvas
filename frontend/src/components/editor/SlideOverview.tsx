// Grid/outline overview (doc 28 FR-5): the whole deck at a glance, grouped by
// section, so an author can reorder the narrative rather than the slide.
//
// Two views of the same deck:
//   grid    - thumbnails, drag to reorder, section headers between runs.
//   outline - slide titles and speaker notes, the narrative read as prose.
//
// Reordering here calls `movePage`, the same undoable op the slide bar uses, so
// the deck has exactly one notion of order. Sections come from the pure
// `groupPagesBySection`, which guarantees every page appears exactly once: a
// slide can never be hidden by a section it does not belong to.

import { useEffect, useRef, useState } from "react";
import { Kanban, LayoutGrid, List, X } from "lucide-react";
import { groupPagesBySection, sectionTitle, slideTitle } from "@hc/schema";
import type { WorkspaceMemberView } from "@hc/sdk";
import { oc } from "@/lib/sdk";
import { useEditor } from "@/store/editor";
import { useBrand } from "@/store/brand";
import { usePresence } from "@/store/presence";
import { SlideThumb } from "./SlideThumb";
import { pageAssigneeOf, pageStatusColor, pageStatusLabel, pageStatusOf, pageStatusValues } from "@/lib/pageStatus";
import { tr } from "@/lib/i18n";

const GRID_W = 200;
const GRID_H = 130;

export function SlideOverview({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEditor((s) => s.rev);
  const activePage = useEditor((s) => s.activePage);
  const doc = useEditor.getState().doc;
  const [view, setView] = useState<"grid" | "outline" | "board">("grid");
  // The dragged slide lives in a ref as well as state: `drop` must read it
  // synchronously in the same event turn, and React has not necessarily
  // re-rendered with the `dragstart` state update yet. State only drives the
  // drop indicator. (Same contract as BuildOrderSection.)
  const dragFrom = useRef<number | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  // Escape closes, matching every other full-surface overlay in the editor.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const groups = groupPagesBySection(doc);

  const openSlide = (i: number) => {
    // Activate AND scroll to the slide, or the canvas would still show the
    // previously viewed page after the overview closes.
    useEditor.getState().goToPage(i);
    onClose();
  };

  const drop = (to: number) => {
    const from = dragFrom.current;
    dragFrom.current = null;
    setDragging(null);
    setOverIndex(null);
    if (from === null || from === to) return;
    useEditor.getState().movePage(from, to);
  };

  return (
    <div className="fixed inset-0 z-[90] flex flex-col bg-neutral-900/95 backdrop-blur" data-testid="slide-overview">
      <header className="flex shrink-0 items-center gap-3 border-b border-white/10 px-4 py-2.5 text-white">
        <span className="text-sm font-semibold">{tr("editor.overview")}</span>
        <span className="text-xs text-white/40">
          {doc.pages.length} slide{doc.pages.length === 1 ? "" : "s"}
        </span>
        <div className="ms-4 flex items-center gap-1 rounded-lg bg-white/10 p-0.5">
          <ViewTab active={view === "grid"} onClick={() => setView("grid")} icon={LayoutGrid} label={tr("editor.grid")} testId="overview-tab-grid" />
          <ViewTab active={view === "outline"} onClick={() => setView("outline")} icon={List} label={tr("editor.outline")} testId="overview-tab-outline" />
          <ViewTab active={view === "board"} onClick={() => setView("board")} icon={Kanban} label={tr("editor.board")} testId="overview-tab-board" />
        </div>
        <button
          onClick={onClose}
          data-testid="overview-close"
          aria-label={tr("editor.close_overview")}
          className="ms-auto grid h-8 w-8 place-items-center rounded-full bg-white/10 hover:bg-white/20"
        >
          <X size={16} />
        </button>
      </header>

      <div className="oc-scroll min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {view === "board" ? (
          <StatusBoard onOpen={openSlide} />
        ) : (
        groups.map((group, gi) => (
          <section key={group.section?.id ?? `unsectioned-${gi}`} className="mb-6">
            {/* An unsectioned run needs no header unless the deck has sections
                at all; otherwise every deck would grow a meaningless label. */}
            {(group.section || groups.length > 1) && (
              <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-white/50">
                {group.section ? sectionTitle(group.section, gi) : tr("editor.no_section")}
                <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-white/40">
                  {group.pageIndices.length}
                </span>
              </h2>
            )}

            {view === "grid" ? (
              <div className="flex flex-wrap gap-4">
                {group.pageIndices.map((i) => (
                  <div
                    key={doc.pages[i].id}
                    draggable
                    data-testid={`overview-slide-${i}`}
                    onDragStart={() => {
                      dragFrom.current = i;
                      setDragging(i);
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (overIndex !== i) setOverIndex(i);
                    }}
                    onDrop={() => drop(i)}
                    onDragEnd={() => {
                      dragFrom.current = null;
                      setDragging(null);
                      setOverIndex(null);
                    }}
                    onClick={() => openSlide(i)}
                    className={`group cursor-pointer rounded-lg border-2 p-1 transition ${
                      overIndex === i && dragging !== null && dragging !== i
                        ? "border-brand-400"
                        : i === activePage
                          ? "border-brand-500"
                          : "border-transparent hover:border-white/30"
                    }`}
                  >
                    <div
                      className="grid place-items-center overflow-hidden rounded bg-white"
                      style={{ width: GRID_W, height: GRID_H }}
                    >
                      <SlideThumb index={i} width={GRID_W} height={GRID_H} />
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 px-0.5">
                      <span className="text-[11px] tabular-nums text-white/40">{i + 1}</span>
                      <span className="min-w-0 flex-1 truncate text-[11px] text-white/70">{slideTitle(doc.pages[i], i)}</span>
                      {doc.pages[i].hidden && (
                        <span className="rounded bg-white/10 px-1 text-[9px] text-white/40">{tr("editor.hidden")}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <ol className="flex flex-col gap-1">
                {group.pageIndices.map((i) => (
                  <li key={doc.pages[i].id}>
                    <button
                      onClick={() => openSlide(i)}
                      data-testid={`overview-outline-${i}`}
                      className={`flex w-full items-start gap-3 rounded-lg px-3 py-2 text-start transition ${
                        i === activePage ? "bg-white/15" : "hover:bg-white/5"
                      }`}
                    >
                      <span className="w-6 shrink-0 pt-0.5 text-end text-[11px] tabular-nums text-white/40">{i + 1}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-white/90">{slideTitle(doc.pages[i], i)}</span>
                        {doc.pages[i].notes?.trim() && (
                          <span className="mt-0.5 line-clamp-2 block text-xs text-white/40">{doc.pages[i].notes}</span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </section>
        ))
        )}
      </div>
    </div>
  );
}

/** Board view (F28 completion C35): slides grouped into status columns, with a
 *  status select and an assignee select per card. Drag a card onto a column to
 *  restatus it - the same store action the selects use, one undo step each. */
function StatusBoard({ onOpen }: { onOpen: (i: number) => void }) {
  useEditor((s) => s.rev);
  const doc = useEditor.getState().doc;
  const canEdit = usePresence((s) => s.canEdit()) && !useEditor.getState().readonlyPreview();
  const workspaceId = useBrand((s) => s.workspaceId);
  // Workspace members for the assignee picker; a viewer without the member
  // API (or a personal workspace) degrades to showing existing assignees only.
  const [members, setMembers] = useState<WorkspaceMemberView[]>([]);
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    oc.workspaceMembers(workspaceId)
      .then((m) => { if (!cancelled) setMembers(m.filter((mm) => mm.status === "active")); })
      .catch(() => { /* picker degrades to existing assignees */ });
    return () => { cancelled = true; };
  }, [workspaceId]);

  // The dragged card index lives in a ref as well as state: drop reads it
  // synchronously in the same event turn (same contract as the grid view's
  // dragFrom); state only drives the highlight.
  const dragRef = useRef<number | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);

  // "No status" first, then the offered pipeline; any UNKNOWN status a newer
  // client wrote gets its own column at the end, so no slide ever vanishes.
  const known = new Set<string>(pageStatusValues);
  const extra = [...new Set(doc.pages.map((p) => pageStatusOf(p)).filter((s): s is string => !!s && !known.has(s)))];
  const columns: { key: string | null; title: string }[] = [
    { key: null, title: tr("editor.no_status") },
    ...pageStatusValues.map((s) => ({ key: s as string, title: pageStatusLabel(s) })),
    ...extra.map((s) => ({ key: s, title: s })),
  ];

  const dropOn = (col: string | null) => {
    const from = dragRef.current;
    dragRef.current = null;
    setDragIdx(null);
    setOverCol(null);
    if (from === null || !canEdit) return;
    useEditor.getState().setPageWorkStatus(from, col);
  };

  return (
    <div className="flex items-start gap-4 overflow-x-auto pb-4">
      {columns.map((col) => {
        const indices = doc.pages.map((_, i) => i).filter((i) => (pageStatusOf(doc.pages[i]) ?? null) === col.key);
        const colorFor = col.key ? pageStatusColor(col.key) : { dot: "bg-white/30", pill: "" };
        const over = overCol === (col.key ?? "");
        return (
          <div
            key={col.key ?? "none"}
            data-testid={`board-col-${col.key ?? "none"}`}
            onDragOver={(e) => { e.preventDefault(); if (!over) setOverCol(col.key ?? ""); }}
            onDragLeave={() => { if (over) setOverCol(null); }}
            onDrop={() => dropOn(col.key)}
            className={`w-60 shrink-0 rounded-xl border p-2 transition ${over && dragIdx !== null ? "border-brand-400 bg-white/10" : "border-white/10 bg-white/5"}`}
          >
            <div className="mb-2 flex items-center gap-1.5 px-1">
              <span className={`h-2 w-2 rounded-full ${colorFor.dot}`} />
              <span className="text-xs font-semibold text-white/80">{col.title}</span>
              <span className="ms-auto rounded bg-white/10 px-1.5 py-0.5 text-[10px] tabular-nums text-white/40">{indices.length}</span>
            </div>
            <div className="flex min-h-10 flex-col gap-2">
              {indices.map((i) => {
                const page = doc.pages[i];
                const assignee = pageAssigneeOf(page);
                return (
                  <div key={page.id} data-testid={`board-card-${i}`} className="rounded-lg bg-white/10 p-1.5">
                    {/* Only the thumbnail is the drag handle: a draggable
                        wrapper would steal mousedown from the selects below
                        on some browsers. */}
                    <button
                      draggable={canEdit}
                      onDragStart={() => { dragRef.current = i; setDragIdx(i); }}
                      onDragEnd={() => { dragRef.current = null; setDragIdx(null); setOverCol(null); }}
                      onClick={() => onOpen(i)}
                      className="block w-full overflow-hidden rounded bg-white"
                      title={slideTitle(page, i)}
                    >
                      <SlideThumb index={i} width={216} height={122} />
                    </button>
                    <div className="mt-1 flex items-center gap-1 px-0.5">
                      <span className="text-[10px] tabular-nums text-white/40">{i + 1}</span>
                      <span className="min-w-0 flex-1 truncate text-[11px] text-white/80">{slideTitle(page, i)}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-1">
                      <select
                        value={pageStatusOf(page) ?? ""}
                        disabled={!canEdit}
                        aria-label={tr("editor.slide_status")}
                        onChange={(e) => useEditor.getState().setPageWorkStatus(i, e.target.value || null)}
                        className="h-6 min-w-0 flex-1 rounded border-0 bg-white/10 px-1 text-[10px] text-white/80 outline-none disabled:opacity-50"
                      >
                        <option value="" className="text-neutral-900">{tr("editor.no_status")}</option>
                        {pageStatusValues.map((s) => (
                          <option key={s} value={s} className="text-neutral-900">{pageStatusLabel(s)}</option>
                        ))}
                        {extra.includes(pageStatusOf(page) ?? "") && (
                          <option value={pageStatusOf(page)} className="text-neutral-900">{pageStatusOf(page)}</option>
                        )}
                      </select>
                      <select
                        value={assignee?.id ?? ""}
                        disabled={!canEdit}
                        aria-label={tr("editor.assignee")}
                        onChange={(e) => {
                          const m = members.find((mm) => mm.userId === e.target.value);
                          useEditor.getState().setPageAssignee(i, m ? { id: m.userId, name: m.name || m.email } : null);
                        }}
                        className="h-6 min-w-0 flex-1 rounded border-0 bg-white/10 px-1 text-[10px] text-white/80 outline-none disabled:opacity-50"
                      >
                        <option value="" className="text-neutral-900">{tr("editor.unassigned")}</option>
                        {/* An assignee not in the member list (left the workspace,
                            or members failed to load) still shows by name. */}
                        {assignee && !members.some((m) => m.userId === assignee.id) && (
                          <option value={assignee.id ?? ""} className="text-neutral-900">{assignee.name}</option>
                        )}
                        {members.map((m) => (
                          <option key={m.userId} value={m.userId} className="text-neutral-900">{m.name || m.email}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ViewTab({
  active,
  onClick,
  icon: Icon,
  label,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof LayoutGrid;
  label: string;
  testId: string;
}) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      aria-pressed={active}
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition ${
        active ? "bg-white/90 text-neutral-900" : "text-white/60 hover:text-white"
      }`}
    >
      <Icon size={13} /> {label}
    </button>
  );
}
