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
import { LayoutGrid, List, X } from "lucide-react";
import { groupPagesBySection, sectionTitle, slideTitle } from "@hc/schema";
import { useEditor } from "@/store/editor";
import { SlideThumb } from "./SlideThumb";

const GRID_W = 200;
const GRID_H = 130;

export function SlideOverview({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEditor((s) => s.rev);
  const activePage = useEditor((s) => s.activePage);
  const doc = useEditor.getState().doc;
  const [view, setView] = useState<"grid" | "outline">("grid");
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
        <span className="text-sm font-semibold">Overview</span>
        <span className="text-xs text-white/40">
          {doc.pages.length} slide{doc.pages.length === 1 ? "" : "s"}
        </span>
        <div className="ml-4 flex items-center gap-1 rounded-lg bg-white/10 p-0.5">
          <ViewTab active={view === "grid"} onClick={() => setView("grid")} icon={LayoutGrid} label="Grid" testId="overview-tab-grid" />
          <ViewTab active={view === "outline"} onClick={() => setView("outline")} icon={List} label="Outline" testId="overview-tab-outline" />
        </div>
        <button
          onClick={onClose}
          data-testid="overview-close"
          aria-label="Close overview"
          className="ml-auto grid h-8 w-8 place-items-center rounded-full bg-white/10 hover:bg-white/20"
        >
          <X size={16} />
        </button>
      </header>

      <div className="oc-scroll min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {groups.map((group, gi) => (
          <section key={group.section?.id ?? `unsectioned-${gi}`} className="mb-6">
            {/* An unsectioned run needs no header unless the deck has sections
                at all; otherwise every deck would grow a meaningless label. */}
            {(group.section || groups.length > 1) && (
              <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-white/50">
                {group.section ? sectionTitle(group.section, gi) : "No section"}
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
                        <span className="rounded bg-white/10 px-1 text-[9px] text-white/40">Hidden</span>
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
                      className={`flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left transition ${
                        i === activePage ? "bg-white/15" : "hover:bg-white/5"
                      }`}
                    >
                      <span className="w-6 shrink-0 pt-0.5 text-right text-[11px] tabular-nums text-white/40">{i + 1}</span>
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
        ))}
      </div>
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
