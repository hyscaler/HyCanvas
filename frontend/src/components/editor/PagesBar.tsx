// Pages strip live thumbnails you can switch, drag to reorder,
// add, duplicate, and delete.

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Plus, Copy, Trash2, Eye, EyeOff, ChevronDown, ChevronRight, Bookmark } from "lucide-react";
import { groupPagesBySection, type SectionGroup, type SlideSection } from "@hc/schema";
import { useEditor } from "@/store/editor";
import { SlideThumb } from "./SlideThumb";
import { mirrorInRtl } from "@/lib/locale";
import { tr } from "@/lib/i18n";

const THUMB_W = 80;
const THUMB_H = 52;

// Preset page sizes offered when adding a page (mirrors the Magic Resize presets).
const pageSizePresets = (): { label: string; w: number; h: number }[] => [
  { label: tr("editor.instagram_post"), w: 1080, h: 1080 },
  { label: tr("editor.instagram_story"), w: 1080, h: 1920 },
  { label: tr("editor.presentation_16_9"), w: 1920, h: 1080 },
  { label: tr("editor.facebook_post"), w: 1200, h: 630 },
  { label: tr("editor.poster"), w: 1080, h: 1350 },
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

  // The size-preset menu is fixed-positioned and clamped to the viewport: an
  // absolute popover anchored inside the bar is clipped by the bar's
  // overflow-x scroll container and stacked beneath the panels above it
  // (same fix as the color picker's popover). Placed imperatively in the
  // layout pass so it never jumps.
  const addWrapRef = useRef<HTMLDivElement>(null);
  const sizeMenuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!sizeMenu) return;
    const place = () => {
      const r = addWrapRef.current?.getBoundingClientRect();
      const el = sizeMenuRef.current;
      if (!r || !el) return;
      const pw = el.offsetWidth || 176;
      const ph = el.offsetHeight || 260;
      const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - pw - 8));
      el.style.left = `${left}px`;
      el.style.top = `${Math.max(8, r.top - ph - 6)}px`;
      el.style.visibility = "visible";
    };
    place();
    // Track bar scrolls (capture) and resizes so the menu stays glued to the
    // add-page button.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [sizeMenu]);

  // Escape dismisses the size-preset menu. Bound on the window so it works
  // wherever focus sits (the menu items are plain buttons).
  useEffect(() => {
    if (!sizeMenu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSizeMenu(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sizeMenu]);

  // Only the thumbnail strip scrolls; the controls (section, duplicate, add
  // page, counter) stay pinned at the bar's right edge, so adding many pages
  // never pushes the add-page button off screen. Keep the active page's thumb
  // in view as pages are added or navigation moves the active page.
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Smooth, so the strip visibly glides to the thumb instead of jumping.
    stripRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }, [active, pages.length]);

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
    // A navigation landmark: this strip is how a user moves between pages.
    <nav aria-label={tr("editor.pages")} className="flex shrink-0 items-center gap-2 border-t border-neutral-200 bg-surface px-3">
      {/* Vertical padding lives INSIDE the scroll strip: the thumbs' hover
          buttons overhang the tile tops, and top overflow in a scroll
          container is clipped, not scrollable. */}
      <div
        ref={stripRef}
        // A vertical mouse wheel scrolls the strip horizontally; trackpads
        // already pan sideways natively.
        onWheel={(e) => {
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
        }}
        className="oc-scroll-none flex min-w-0 items-center gap-2 overflow-x-auto py-2"
      >
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
        <div className="group relative shrink-0" data-active={i === active ? "true" : undefined}>
          <button
            draggable
            onDragStart={() => setDragIdx(i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => { if (dragIdx !== null && dragIdx !== i) st().movePage(dragIdx, i); setDragIdx(null); }}
            onDragEnd={() => setDragIdx(null)}
            onClick={() => st().goToPage(i)}
            aria-current={i === active ? "page" : undefined}
            aria-label={p.name ? tr("editor.page_n_name", { n: i + 1, name: p.name }) : tr("editor.page_n", { n: i + 1 })}
            title={`${p.name ?? `Page ${i + 1}`}${hidden ? " (hidden in present)" : ""}`}
            className={`relative grid place-items-center overflow-hidden rounded-md border bg-surface transition ${
              i === active ? "border-brand-500 ring-2 ring-brand-200" : "border-neutral-200 hover:border-neutral-300"
            } ${dragIdx === i ? "opacity-50" : ""} ${hidden ? "opacity-50" : ""}`}
            style={{ width: THUMB_W, height: THUMB_H }}
          >
            <SlideThumb index={i} width={THUMB_W} height={THUMB_H} />
            {hidden && (
              <span className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-0.5 bg-neutral-900/70 py-0.5 text-[9px] font-medium text-white">
                <EyeOff size={9} /> {tr("editor.hidden")}
              </span>
            )}
          </button>
          {renaming === i ? (
            <input
              autoFocus
              aria-label={tr("editor.rename_page")}
              defaultValue={p.name ?? `Page ${i + 1}`}
              onBlur={(e) => { st().setPageName(i, e.target.value.trim() || `Page ${i + 1}`); setRenaming(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setRenaming(null); }}
              className="mt-0.5 block w-full rounded border border-brand-300 px-1 text-center text-[10px] text-neutral-700 outline-none"
              style={{ width: THUMB_W }}
            />
          ) : (
            <span
              onDoubleClick={() => setRenaming(i)}
              title={tr("editor.double_click_to_rename")}
              className="mt-0.5 block max-w-full truncate px-1 text-center text-[10px] text-neutral-400"
              style={{ maxWidth: THUMB_W }}
            >{p.name ?? i + 1}</span>
          )}
          {/* Visible-but-transparent (not display:none) so the action stays
              Tab-reachable and reappears on keyboard focus. */}
          <button
            onClick={() => st().setPageHidden(!hidden, i)}
            title={hidden ? tr("editor.show_slide_while_presenting") : tr("editor.hide_slide_while_presenting")}
            className="absolute -start-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-surface text-neutral-400 opacity-0 shadow focus-visible:opacity-100 group-hover:opacity-100 hover:text-brand-ink"
          >
            {hidden ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
          {pages.length > 1 && (
            <button
              onClick={() => st().deletePage(i)}
              title={tr("editor.delete_page")}
              className="absolute -end-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-surface text-neutral-400 opacity-0 shadow focus-visible:opacity-100 group-hover:opacity-100 hover:text-red-600"
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
        </Fragment>
        );
      })}
      </div>
      <div className="flex shrink-0 items-center gap-2 py-2">
      <button
        onClick={() => st().addSection(useEditor.getState().activePage)}
        title={tr("editor.start_a_section_at_the_current_slide")}
        data-testid="add-section"
        className="grid shrink-0 place-items-center rounded-md border border-neutral-200 text-neutral-500 hover:border-brand-300 hover:text-brand-ink"
        style={{ width: 40, height: THUMB_H }}
      >
        <Bookmark size={16} />
      </button>
      <button
        onClick={() => st().duplicatePage()}
        title={tr("editor.duplicate_current_page")}
        className="grid shrink-0 place-items-center rounded-md border border-neutral-200 text-neutral-500 hover:border-brand-300 hover:text-brand-ink"
        style={{ width: 40, height: THUMB_H }}
      >
        <Copy size={16} />
      </button>
      <div ref={addWrapRef} className="relative flex shrink-0 items-stretch">
        <button
          onClick={() => st().addPage()}
          title={tr("editor.add_page_same_size")}
          className="grid place-items-center rounded-s-md border border-dashed border-neutral-300 text-neutral-500 hover:border-brand-400 hover:text-brand-ink"
          style={{ width: 34, height: THUMB_H }}
        >
          <Plus size={18} />
        </button>
        <button
          onClick={() => setSizeMenu((v) => !v)}
          title={tr("editor.add_page_with_a_preset_size")}
          aria-haspopup="menu"
          aria-expanded={sizeMenu}
          className="grid w-5 place-items-center rounded-e-md border border-s-0 border-dashed border-neutral-300 text-neutral-400 hover:border-brand-400 hover:text-brand-ink"
          style={{ height: THUMB_H }}
        >
          <ChevronDown size={12} />
        </button>
        {sizeMenu && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setSizeMenu(false)} />
            <div ref={sizeMenuRef} role="menu" aria-label={tr("editor.add_page_with_a_preset_size")} style={{ visibility: "hidden" }} className="fixed z-50 w-44 overflow-hidden rounded-lg border border-neutral-200 bg-surface py-1 shadow-lg">
              {pageSizePresets().map((p) => (
                <button
                  key={p.label}
                  role="menuitem"
                  onClick={() => { st().addPage({ width: p.w, height: p.h }); setSizeMenu(false); }}
                  className="flex w-full items-center justify-between px-3 py-1.5 text-start text-xs text-neutral-700 hover:bg-brand-50 hover:text-brand-ink"
                >
                  <span>{p.label}</span>
                  <span className="text-[10px] text-neutral-400">{p.w}×{p.h}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      <span className="ms-1 shrink-0 text-xs text-neutral-400">{tr("editor.page_n_of_total", { n: active + 1, total: pages.length })}</span>
      </div>
    </nav>
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
        title={section.collapsed ? tr("editor.expand_section") : tr("editor.collapse_section")}
        data-testid={`section-toggle-${section.id}`}
        className="grid h-5 w-5 place-items-center rounded text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700"
      >
        {section.collapsed ? <ChevronRight size={13} className={mirrorInRtl} /> : <ChevronDown size={13} />}
      </button>
      {renaming ? (
        <input
          autoFocus
          aria-label={tr("editor.rename_section")}
          defaultValue={section.name}
          onBlur={(e) => { st().renameSection(section.id, e.target.value); setRenaming(false); }}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setRenaming(false); }}
          className="w-24 rounded border border-brand-300 px-1 text-[11px] outline-none"
        />
      ) : (
        <button
          onDoubleClick={() => setRenaming(true)}
          title={tr("editor.double_click_to_rename")}
          className="max-w-28 truncate text-[11px] font-medium text-neutral-600"
        >
          {section.name}
        </button>
      )}
      <span className="text-[10px] tabular-nums text-neutral-400">{count}</span>
      <button
        onClick={() => st().removeSection(section.id)}
        title={tr("editor.remove_section_slides_are_kept")}
        data-testid={`section-remove-${section.id}`}
        className="grid h-5 w-5 place-items-center rounded text-neutral-300 hover:bg-neutral-200 hover:text-red-600"
      >
        <Trash2 size={11} />
      </button>
    </div>
  );
}
