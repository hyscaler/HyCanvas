// Pages strip (Canva-style): live thumbnails you can switch, drag to reorder,
// add, duplicate, and delete.

import { Fragment, useState } from "react";
import { Plus, Copy, Trash2, Eye, EyeOff, ChevronDown, ChevronRight, Bookmark } from "lucide-react";
import { groupPagesBySection, type SectionGroup, type SlideSection } from "@hc/schema";
import { useEditor } from "@/store/editor";
import { SlideThumb } from "./SlideThumb";
import { PAGE_GAP } from "@/lib/pageLayout";

const THUMB_W = 80;
const THUMB_H = 52;

// Preset page sizes offered when adding a page (mirrors the Magic Resize presets).
const PAGE_SIZE_PRESETS: { label: string; w: number; h: number }[] = [
  { label: "Instagram Post", w: 1080, h: 1080 },
  { label: "Instagram Story", w: 1080, h: 1920 },
  { label: "Presentation 16:9", w: 1920, h: 1080 },
  { label: "Facebook Post", w: 1200, h: 630 },
  { label: "Poster", w: 1080, h: 1350 },
  { label: "A4 Portrait", w: 1240, h: 1754 },
  { label: "A4 Landscape", w: 1754, h: 1240 },
];


export function PagesBar() {
  useEditor((s) => s.rev);
  const active = useEditor((s) => s.activePage);
  const doc = useEditor.getState().doc;
  const pages = doc.pages;
  const st = useEditor.getState;
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [sizeMenu, setSizeMenu] = useState(false);

  // Section runs (doc 28 FR-5). The bar stays a flat strip; a divider chip is
  // injected at each group boundary, and a collapsed group hides its thumbs
  // (never its slides: collapse is a view preference, not a deletion).
  const groups = groupPagesBySection(doc);
  const groupStart = new Map<number, SectionGroup>();
  const collapsedPages = new Set<number>();
  for (const g of groups) {
    if (g.pageIndices.length) groupStart.set(g.pageIndices[0], g);
    if (g.section?.collapsed) for (const i of g.pageIndices) collapsedPages.add(i);
  }

  return (
    <div className="oc-scroll flex shrink-0 items-center gap-2 overflow-x-auto border-t border-neutral-200 bg-surface px-3 py-2">
      {pages.map((p, i) => {
        const hidden = !!(p as { hidden?: boolean }).hidden;
        const startsGroup = groupStart.get(i);
        const divider = startsGroup?.section ? (
          <SectionChip key={`sec-${startsGroup.section.id}`} section={startsGroup.section} count={startsGroup.pageIndices.length} />
        ) : null;
        if (collapsedPages.has(i)) return divider; // thumbs hidden while collapsed
        return (
        <Fragment key={`g${p.id}`}>
        {divider}
        <div className="group relative shrink-0">
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
              // viewport (uses the shared PAGE_GAP so it tracks the renderer).
              let off = 0;
              for (let k = 0; k < i; k++) off += (s.doc.pages[k]?.height ?? 0) + PAGE_GAP;
              s.setViewport({ panY: off - 40 / (s.viewport.zoom || 1) });
            }}
            title={`${p.name ?? `Page ${i + 1}`}${hidden ? " (hidden in present)" : ""}`}
            className={`relative grid place-items-center overflow-hidden rounded-md border bg-surface transition ${
              i === active ? "border-brand-500 ring-2 ring-brand-200" : "border-neutral-200 hover:border-neutral-300"
            } ${dragIdx === i ? "opacity-50" : ""} ${hidden ? "opacity-50" : ""}`}
            style={{ width: THUMB_W, height: THUMB_H }}
          >
            <SlideThumb index={i} width={THUMB_W} height={THUMB_H} />
            {hidden && (
              <span className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-0.5 bg-neutral-900/70 py-0.5 text-[9px] font-medium text-white">
                <EyeOff size={9} /> Hidden
              </span>
            )}
          </button>
          {renaming === i ? (
            <input
              autoFocus
              defaultValue={p.name ?? `Page ${i + 1}`}
              onBlur={(e) => { st().setPageName(i, e.target.value.trim() || `Page ${i + 1}`); setRenaming(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setRenaming(null); }}
              className="mt-0.5 block w-full rounded border border-brand-300 px-1 text-center text-[10px] text-neutral-700 outline-none"
              style={{ width: THUMB_W }}
            />
          ) : (
            <span
              onDoubleClick={() => setRenaming(i)}
              title="Double-click to rename"
              className="mt-0.5 block max-w-full truncate px-1 text-center text-[10px] text-neutral-400"
              style={{ maxWidth: THUMB_W }}
            >{p.name ?? i + 1}</span>
          )}
          <button
            onClick={() => st().setPageHidden(!hidden, i)}
            title={hidden ? "Show slide while presenting" : "Hide slide while presenting"}
            className="absolute -left-1.5 -top-1.5 hidden h-5 w-5 place-items-center rounded-full bg-surface text-neutral-400 shadow group-hover:grid hover:text-brand-ink"
          >
            {hidden ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
          {pages.length > 1 && (
            <button
              onClick={() => st().deletePage(i)}
              title="Delete page"
              className="absolute -right-1.5 -top-1.5 hidden h-5 w-5 place-items-center rounded-full bg-surface text-neutral-400 shadow group-hover:grid hover:text-red-600"
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
        </Fragment>
        );
      })}
      <button
        onClick={() => st().addSection(useEditor.getState().activePage)}
        title="Start a section at the current slide"
        data-testid="add-section"
        className="grid shrink-0 place-items-center rounded-md border border-neutral-200 text-neutral-500 hover:border-brand-300 hover:text-brand-ink"
        style={{ width: 40, height: THUMB_H }}
      >
        <Bookmark size={16} />
      </button>
      <button
        onClick={() => st().duplicatePage()}
        title="Duplicate current page"
        className="grid shrink-0 place-items-center rounded-md border border-neutral-200 text-neutral-500 hover:border-brand-300 hover:text-brand-ink"
        style={{ width: 40, height: THUMB_H }}
      >
        <Copy size={16} />
      </button>
      <div className="relative flex shrink-0 items-stretch">
        <button
          onClick={() => st().addPage()}
          title="Add page (same size)"
          className="grid place-items-center rounded-l-md border border-dashed border-neutral-300 text-neutral-500 hover:border-brand-400 hover:text-brand-ink"
          style={{ width: 34, height: THUMB_H }}
        >
          <Plus size={18} />
        </button>
        <button
          onClick={() => setSizeMenu((v) => !v)}
          title="Add page with a preset size"
          className="grid w-5 place-items-center rounded-r-md border border-l-0 border-dashed border-neutral-300 text-neutral-400 hover:border-brand-400 hover:text-brand-ink"
          style={{ height: THUMB_H }}
        >
          <ChevronDown size={12} />
        </button>
        {sizeMenu && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setSizeMenu(false)} />
            <div className="absolute bottom-full left-0 z-20 mb-1 w-44 overflow-hidden rounded-lg border border-neutral-200 bg-surface py-1 shadow-lg">
              {PAGE_SIZE_PRESETS.map((p) => (
                <button
                  key={p.label}
                  onClick={() => { st().addPage({ width: p.w, height: p.h }); setSizeMenu(false); }}
                  className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-neutral-700 hover:bg-brand-50 hover:text-brand-ink"
                >
                  <span>{p.label}</span>
                  <span className="text-[10px] text-neutral-400">{p.w}×{p.h}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      <span className="ml-1 shrink-0 text-xs text-neutral-400">Page {active + 1} of {pages.length}</span>
    </div>
  );
}

/** A section divider in the slide bar (doc 28 FR-5): name, slide count,
 *  collapse toggle, rename, and remove. Removing a section never removes its
 *  slides; they simply become unsectioned. */
function SectionChip({ section, count }: { section: SlideSection; count: number }) {
  const st = useEditor.getState;
  const [renaming, setRenaming] = useState(false);
  return (
    <div
      className="flex shrink-0 items-center gap-1 self-stretch rounded-md border border-neutral-200 bg-neutral-50 px-1.5"
      data-testid={`section-chip-${section.id}`}
    >
      <button
        onClick={() => st().toggleSectionCollapsed(section.id)}
        title={section.collapsed ? "Expand section" : "Collapse section"}
        data-testid={`section-toggle-${section.id}`}
        className="grid h-5 w-5 place-items-center rounded text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700"
      >
        {section.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
      </button>
      {renaming ? (
        <input
          autoFocus
          defaultValue={section.name}
          onBlur={(e) => { st().renameSection(section.id, e.target.value); setRenaming(false); }}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setRenaming(false); }}
          className="w-24 rounded border border-brand-300 px-1 text-[11px] outline-none"
        />
      ) : (
        <button
          onDoubleClick={() => setRenaming(true)}
          title="Double-click to rename"
          className="max-w-28 truncate text-[11px] font-medium text-neutral-600"
        >
          {section.name}
        </button>
      )}
      <span className="text-[10px] tabular-nums text-neutral-400">{count}</span>
      <button
        onClick={() => st().removeSection(section.id)}
        title="Remove section (slides are kept)"
        data-testid={`section-remove-${section.id}`}
        className="grid h-5 w-5 place-items-center rounded text-neutral-300 hover:bg-neutral-200 hover:text-red-600"
      >
        <Trash2 size={11} />
      </button>
    </div>
  );
}
