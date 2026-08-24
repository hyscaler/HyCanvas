// Slide-out editor panels for the tool rail: Elements (shapes), Text, Uploads
// (F12), and Stock (F13). Each inserts nodes through the editor store so edits
// are undoable. Uploads/stock images are placed via the image asset provider.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type FormEvent } from "react";
import { Square, SquareRoundCorner, Circle, Triangle, Pentagon, Hexagon, Star, Diamond, Octagon, Frame, QrCode, Type, Upload, Search, Table as TableIcon, BarChart3, LineChart, AreaChart, PieChart, Donut, ScatterChart, Radar, Wand2, ImagePlus, Settings2, Trash2, Folder, FolderPlus, Pencil, X, Tag, ChevronLeft, Link as LinkIcon, Mic, Video, MonitorUp, CircleStop, Spline, Clock, LayoutGrid, Shapes, Sparkles, Stethoscope, AlignStartVertical, Play, ChevronDown, Send, Plus, RotateCcw, FileDown, FileText, Paperclip } from "lucide-react";
import { migrate, type ChartType, type Node, type Fill, type Color } from "@hc/schema";
import { searchFonts, type FontCatalogEntry } from "@hc/text";
import { toHex, fromHex, relativeLuminance } from "@hc/color";
import { formatBytes } from "@/lib/format";
import { qrModules } from "@/lib/qr";
import { stickers, stickerCategories, type Sticker } from "@/lib/stickers";
import { parseModelJson } from "@/lib/magicDesign";
import {
  normalizeOutline, deckThemes, layoutDeck, layoutDesign, groundImagePrompt, untrustedSourceRule,
  sanitizeEditedOutline, dialsClause, dialDensities, dialTones, dialAudiences, dialScenarios, maxOutlinePages,
  deriveLayoutContentSchema, layoutSelectionSchema, layoutSelectionSystemPrompt, layoutFillSystemPrompt, repairLayoutSelection,
  normalizeLayoutFill, fallbackLayoutFill, preferredLayoutFor, type LayoutFill,
  buildAgendaPages, pickAgendaLayout, extractTitleFromText, splitSlideSchema, splitSlideSystemPrompt,
  relayoutDecisionSchema, relayoutDecisionSystemPrompt, regenerateFillSystemPrompt, changedImagePrompts,
  type DesignOutline, type DesignType, type GenerationDials, type OutlineItem,
  toolCatalog, assistantSystemPrompt, parseAssistantReply, planMutates, summarizeDesign, type PlanStep,
} from "@hc/aistudio";
import { builtinMasterAndLayouts, type SlideLayout } from "@hc/schema";
import { promptText } from "@/lib/promptDialog";
import { downloadHycFile } from "@/lib/hycFile";
import { generateAltText } from "@/lib/altText";
import { fonts } from "@/lib/fontProvider";
import { locate } from "@hc/editor";
import {
  critiquePage,
  elementBoxesForPage,
  styleSamplesForPage,
  harmonizeProposal,
  hasHarmonizeChanges,
  autoLayoutSuggestions,
  autoAnimatePlan,
  animateBoxesForPage,
  categoryLabel,
  animateStyles,
  type CritiqueIssue,
  type HarmonizeProposal,
  type AutoLayoutSuggestion,
  type AnimateStyle,
} from "@/lib/assist";
import { ApiError, type AiConfigView, type AiProviderPreset, type AssetFolder, type MiniAppSummary, type StockAssetSummary, type StockCollectionSummary, type StockFacetValue, type StockFiltersSummary, type StorageUsageView, type TemplateSummary, type UploadedAsset } from "@hc/sdk";
import { DesignThumb } from "@/components/dashboard/DesignThumb";
import { checkAppAction, type AppAction } from "@hc/stock";
import { oc, resolveAssetUrl, stockProxyUrl, uploadAssetWithProgress } from "@/lib/sdk";
import { pdfFileToText } from "@/lib/pdfImport";
import { mermaidToDiagram, normalizeDiagramSpec, type DiagramSpec } from "@hc/whiteboard";
import type { BrandVoice, BrandLintViolation } from "@hc/sdk";
import { useEditor, type BrandFixTarget, type DeckTextEntry } from "@/store/editor";
import { useBrand } from "@/store/brand";
import { useComments } from "@/store/comments";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { mirrorInRtl } from "@/lib/locale";
import { tr, trOr } from "@/lib/i18n";
import { enqueueAiImages, retryFailedAiImages, subscribeAiImageQueue } from "@/lib/aiImageQueue";
import { stickerLabel, stickerCategoryLabel } from "@/lib/stickers";
import { documentDirection } from "@/lib/locale";
import { apiCodeMessage, CodedError, userMessage } from "@/lib/errors";

/**
 * Debounce a rapidly-changing value (search boxes, filters) so dependent work
 * (refetch, recompute) runs at most once per `delay` ms after typing stops. The
 * setState runs inside a setTimeout callback (never synchronously in the effect
 * body) and the timer is cleared on cleanup, so it is React-compiler-safe.
 */
function useDebouncedValue<T>(value: T, delay = 280): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

/**
 * Two-step confirm for an immediate, non-undoable action. Returns an `armed` id
 * and a `confirm(id, run)` callback: the first call arms that id (the caller
 * shows a "click again" affordance) and the second call within the window runs
 * the action. Auto-disarms after a few seconds. setState only fires from event
 * handlers / a cleaned-up timeout, so it stays React-compiler-safe.
 */
function useArmedConfirm(timeoutMs = 3500) {
  const [armed, setArmed] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const disarm = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setArmed(null);
  }, []);
  const confirm = useCallback((id: string, run: () => void) => {
    if (armed === id) { disarm(); run(); return; }
    if (timer.current) clearTimeout(timer.current);
    setArmed(id);
    timer.current = setTimeout(() => setArmed(null), timeoutMs);
  }, [armed, disarm, timeoutMs]);
  return { armed, confirm, disarm };
}

/** After an insert, just confirm with a subtle toast. The node is already placed
 *  at the current viewport center and selected by addNode, so it appears where
   *  the user is looking - we deliberately do NOT zoom (the view stays put
 *  stays put rather than jumping to frame the new element). */
/** Templates panel: suggests templates for the CURRENT page size (exact size
 *  first, then the same aspect ratio), with search over the full gallery.
 *  Clicking a template appends its pages to the design (never replacing
 *  existing pages) and jumps there; one undo removes them. */
export function TemplatesPanel() {
  const toast = useToast();
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query);
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // "Other sizes" is collapsed by default: the default view is templates that
  // fit this page. Searching expands it (hiding search hits would read as "no
  // results"), and so does having no matches at all (never an empty panel).
  const [showOther, setShowOther] = useState(false);
  // The active page's size drives the suggestions; re-read on page switches
  // and doc edits (a stage resize changes what "matching" means).
  const activePage = useEditor((s) => s.activePage);
  const rev = useEditor((s) => s.rev);
  const pageSize = useMemo(() => {
    const d = useEditor.getState().doc;
    const pg = d.pages[Math.min(activePage, d.pages.length - 1)];
    return pg ? { w: Math.round(pg.width), h: Math.round(pg.height) } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePage, rev]);

  useEffect(() => {
    let cancelled = false;
    // No workspace filter: the list endpoint's default scope is already
    // everything the caller may see (public + own private + all member
    // workspaces). Passing workspaceId NARROWS to that workspace only, which
    // would hide public and cross-workspace templates from the gallery.
    void oc
      .listTemplates({ q: debouncedQuery.trim() || undefined })
      .then((ts) => { if (!cancelled) setTemplates(ts); })
      .catch(() => { if (!cancelled) setTemplates([]); });
    return () => { cancelled = true; };
  }, [debouncedQuery]);

  // Rank: exact page-size matches, then same aspect ratio (within 2%), then the
  // rest of the gallery, keeping the server's order within each bucket.
  const { matched, rest } = useMemo(() => {
    const all = templates ?? [];
    if (!pageSize) return { matched: [] as TemplateSummary[], rest: all };
    const aspect = pageSize.w / Math.max(1, pageSize.h);
    const exact: TemplateSummary[] = [];
    const similar: TemplateSummary[] = [];
    const other: TemplateSummary[] = [];
    for (const t of all) {
      const tw = Math.round(t.format?.width ?? 0);
      const th = Math.round(t.format?.height ?? 0);
      if (tw === pageSize.w && th === pageSize.h) exact.push(t);
      else if (tw > 0 && th > 0 && Math.abs(tw / th - aspect) / aspect < 0.02) similar.push(t);
      else other.push(t);
    }
    return { matched: [...exact, ...similar], rest: other };
  }, [templates, pageSize]);

  const apply = async (t: TemplateSummary) => {
    if (busyId) return;
    setBusyId(t.id);
    try {
      // The template endpoint serves the stored file verbatim; a user-saved
      // template from an older build needs the forward migration before its
      // nodes may enter a current-schema document.
      const file = migrate(await oc.getTemplateFile(t.id));
      // The store refuses in read-only states (viewer/comment access, history
      // preview) and for empty templates; never claim success for a no-op.
      if (useEditor.getState().applyTemplateFile(file, t.title)) {
        // The store resizes differently-sized template pages to this design's
        // page size on insert; say so, so the size badge never reads as a
        // warning. A summary without format metadata (0x0) proves nothing, so
        // it gets the plain message rather than a false "resized" claim.
        const tw = Math.round(t.format?.width ?? 0);
        const th = Math.round(t.format?.height ?? 0);
        const resized = !!pageSize && tw > 0 && th > 0 && (tw !== pageSize.w || th !== pageSize.h);
        toast.success(
          resized
            ? tr("editor.template_added_as_a_new_page_resized_to_fit")
            : tr("editor.template_added_as_a_new_page_undo_removes_it"),
        );
      } else {
        toast.error(tr("editor.templates_cant_be_added_in_a_read_only_view"));
      }
    } catch {
      toast.error(tr("editor.could_not_apply_the_template"));
    } finally {
      setBusyId(null);
    }
  };

  const downloadHyc = async (t: TemplateSummary) => {
    try {
      downloadHycFile(await oc.getTemplateFile(t.id), t.title);
    } catch {
      toast.error(tr("editor.could_not_download_the_template"));
    }
  };

  // The apply button and the .hyc download live side by side (never nested:
  // a button inside a button is invalid markup), inside one hover group.
  const card = (t: TemplateSummary) => (
    <div key={t.id} className="group relative overflow-hidden rounded-xl border border-neutral-200 bg-surface shadow-sm transition hover:border-brand-300 hover:shadow-md">
      <button
        type="button"
        onClick={() => void apply(t)}
        disabled={!!busyId}
        title={`Add "${t.title}" (${Math.round(t.format?.width ?? 0)}x${Math.round(t.format?.height ?? 0)}) as a new page`}
        className="block w-full text-start disabled:opacity-60"
      >
        <div className="relative aspect-[4/3] bg-neutral-100">
          <DesignThumb templateId={t.id} />
          <span className="absolute bottom-1 end-1 rounded bg-black/55 px-1 py-0.5 font-mono text-[9px] tabular-nums text-white/90">
            {Math.round(t.format?.width ?? 0)}x{Math.round(t.format?.height ?? 0)}
          </span>
          {busyId === t.id && (
            <span className="absolute inset-0 grid place-items-center bg-white/60"><Spinner /></span>
          )}
        </div>
        <div className="truncate px-2 py-1.5 text-xs font-medium text-neutral-700">{t.title}</div>
      </button>
      <button
        type="button"
        onClick={() => void downloadHyc(t)}
        title={tr("editor.download_as_hyc_file")}
        aria-label={`Download "${t.title}" as .hyc file`}
        className="absolute end-1 top-1 rounded-md border border-neutral-200 bg-surface p-1 text-neutral-600 opacity-0 shadow-sm transition hover:text-brand-ink focus-visible:opacity-100 group-hover:opacity-100"
      >
        <FileDown size={12} />
      </button>
    </div>
  );

  const sectionCls = "mb-1.5 mt-3 text-xs font-semibold uppercase tracking-wide text-neutral-400";
  return (
    <PanelShell title={tr("editor.templates")}>
      <label className="flex items-center gap-2 rounded-xl border border-neutral-200 bg-surface px-2.5 py-1.5 focus-within:border-brand-400">
        <Search size={14} className="shrink-0 text-neutral-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tr("editor.search_templates")}
          aria-label={tr("editor.search_templates")}
          className="w-full min-w-0 bg-transparent text-sm text-neutral-800 outline-none placeholder:text-neutral-400"
        />
      </label>
      {templates === null ? (
        <div className="flex justify-center py-8"><Spinner /></div>
      ) : templates.length === 0 ? (
        <p className="py-6 text-center text-sm text-neutral-400">
          No templates{debouncedQuery.trim() ? " match this search" : " yet"}.
        </p>
      ) : (
        <>
          {matched.length > 0 && (
            <>
              <p className={sectionCls} data-testid="tpl-match-heading">
                For this page{pageSize ? ` (${pageSize.w}x${pageSize.h})` : ""}
              </p>
              <div className="grid grid-cols-2 gap-2">{matched.map(card)}</div>
            </>
          )}
          {rest.length > 0 && (() => {
            const searching = !!debouncedQuery.trim();
            const collapsible = matched.length > 0 && !searching;
            const open = !collapsible || showOther;
            return (
              <>
                {collapsible ? (
                  <button
                    type="button"
                    onClick={() => setShowOther((v) => !v)}
                    aria-expanded={open}
                    className={`${sectionCls} flex w-full items-center gap-1 text-start hover:text-neutral-600`}
                  >
                    <ChevronDown size={12} className={`shrink-0 transition-transform ${open ? "" : "-rotate-90"}`} />
                    Other sizes ({rest.length})
                  </button>
                ) : (
                  <p className={sectionCls}>{matched.length > 0 ? tr("editor.other_sizes") : tr("editor.all_templates")}</p>
                )}
                {open && <div className="grid grid-cols-2 gap-2">{rest.map(card)}</div>}
              </>
            );
          })()}
        </>
      )}
    </PanelShell>
  );
}

function afterInsert(toast: ReturnType<typeof useToast>, label: string) {
  toast.success(`Added ${label}`);
}

export function PanelShell({ title, children, fill }: { title: string; children: React.ReactNode; fill?: boolean }) {
  // Resizable width at lg+ (drag the right edge), clamped and persisted per-user
  // (default 288px, the former fixed w-72). Below lg the panel keeps a responsive
  // narrow width (60vw capped at 16rem) so it never dominates a small viewport or
  // the canvas overlay (see ToolRail), and the drag handle is hidden. `fill` makes
  // the body a non-scrolling flex column so a child (e.g. the AI chat) can pin its
  // own footer and scroll only its message area.
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === "undefined") return 288;
    const v = Number(window.localStorage.getItem("oc-left-panel-width"));
    return Number.isFinite(v) && v >= 220 && v <= 560 ? v : 288;
  });
  const resize = useRef<{ startX: number; startW: number } | null>(null);
  const onResizeDown = (e: React.PointerEvent) => {
    resize.current = { startX: e.clientX, startW: width };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onResizeMove = (e: React.PointerEvent) => {
    const r = resize.current;
    if (!r) return;
    // The panel sits at the INLINE START, so its drag edge faces the middle of
    // the screen: rightward widens it in a left-to-right interface and narrows
    // it in a mirrored one. Pointer coordinates are always physical, so the
    // sign has to be flipped by hand.
    const towardCentre = (e.clientX - r.startX) * (documentDirection() === "rtl" ? -1 : 1);
    setWidth(Math.min(560, Math.max(220, r.startW + towardCentre)));
  };
  const onResizeUp = (e: React.PointerEvent) => {
    if (!resize.current) return;
    resize.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    // Persist once on release, not on every pointermove.
    try { window.localStorage.setItem("oc-left-panel-width", String(width)); } catch { /* ignore */ }
  };
  return (
    <div
      className="flex h-full w-[min(16rem,60vw)] shrink-0 lg:w-[var(--oc-left-w)]"
      style={{ ["--oc-left-w"]: `${width}px` } as React.CSSProperties}
    >
      {/* Scroll area. Its right border shows below lg; at lg+ the drag handle to
          its right carries the border so the two never double up. */}
      <div className={`oc-scroll flex h-full min-w-0 flex-1 flex-col border-e border-neutral-200 bg-surface lg:border-e-0 ${fill ? "overflow-hidden" : "overflow-y-auto overflow-x-hidden"}`}>
        {/* h2: the page's h1 is the design title, so panel titles are the
            next level down and heading navigation stays ordered. */}
        <h2 className="px-4 pb-2 pt-4 text-sm font-bold text-neutral-800">{title}</h2>
        <div className={fill ? "flex min-h-0 flex-1 flex-col px-4 pb-4" : "flex-1 px-4 pb-4"}>{children}</div>
      </div>
      {/* Resize handle: a thin column to the RIGHT of the scroll area (so it never
          overlaps the vertical scrollbar), shown only at lg+ (inline layout). */}
      <div
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        role="separator"
        aria-orientation="vertical"
        aria-label={tr("editor.resize_panel")}
        title={tr("editor.drag_to_resize")}
        className="hidden w-1.5 shrink-0 cursor-col-resize touch-none border-e border-neutral-200 bg-transparent hover:bg-brand-300/50 lg:block"
      />
    </div>
  );
}

/**
 * A titled, collapsible group used to organize the dense side panels into
 * scannable sections (header row with an optional icon + title + optional badge
 * and right slot + a chevron; the body shows when open). Owns its open state.
 */
export function CollapsibleSection({
  title,
  icon: Icon,
  defaultOpen = false,
  badge,
  right,
  order,
  dim = false,
  children,
}: {
  title: string;
  icon?: typeof Square;
  defaultOpen?: boolean;
  badge?: string | number;
  right?: React.ReactNode;
  /** Flex `order` for the section, so the parent panel can float the most
   *  relevant groups to the top without reordering the JSX. */
  order?: number;
  /** Dim + disable the body (e.g. a locked / brand-constrained group). */
  dim?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-neutral-100 pb-2 last:border-b-0 last:pb-0" style={order != null ? { order } : undefined}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="group flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-start hover:bg-neutral-50"
      >
        {Icon && <Icon size={14} className="shrink-0 text-neutral-400 group-hover:text-brand-500" />}
        <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">{title}</span>
        {badge != null && (
          <span className="rounded-full bg-neutral-100 px-1.5 text-[10px] font-semibold text-neutral-500">{badge}</span>
        )}
        <span className="flex-1" />
        {right}
        <ChevronDown size={15} className={`shrink-0 text-neutral-300 transition-transform group-hover:text-neutral-400 ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && <div className={`flex flex-col gap-2 px-1 pt-1.5 ${dim ? "pointer-events-none opacity-50" : ""}`}>{children}</div>}
    </div>
  );
}

const BRAND = { type: "solid", color: { srgb: { r: 0.38, g: 0.22, b: 0.86, a: 1 } } };
const FRAME_FILL = { type: "solid", color: { srgb: { r: 0.9, g: 0.91, b: 0.93, a: 1 } } };
const CENTER = { x: 320, y: 320, scaleX: 1, scaleY: 1, rotation: 0 };

type ElementTile = { label: string; icon: typeof Square; run: () => void };

// One photo-grid cell slot (mirrors the store's GridSpan).
type GridSpan = { row: number; col: number; rowSpan: number; colSpan: number };

const uniformSpans = (rows: number, cols: number): GridSpan[] =>
  Array.from({ length: rows * cols }, (_, i) => ({ row: Math.floor(i / cols), col: i % cols, rowSpan: 1, colSpan: 1 }));

/** Tile icon for a grid layout preset: a miniature of the actual cell layout,
 *  so the tiles read like the layouts they insert rather than a generic glyph. */
function gridPreviewIcon(rows: number, cols: number, spans?: GridSpan[]): typeof Square {
  const cells = spans ?? uniformSpans(rows, cols);
  const G = 2; // preview gap
  const Preview = ({ size = 26 }: { size?: number | string }) => {
    const s = typeof size === "number" ? size : 26;
    const cw = (s - G * (cols - 1)) / cols;
    const ch = (s - G * (rows - 1)) / rows;
    return (
      <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} aria-hidden="true">
        {cells.map((c, i) => (
          <rect
            key={i}
            x={c.col * (cw + G)}
            y={c.row * (ch + G)}
            width={cw * c.colSpan + G * (c.colSpan - 1)}
            height={ch * c.rowSpan + G * (c.rowSpan - 1)}
            rx={1.5}
            fill="currentColor"
            opacity={0.55}
          />
        ))}
      </svg>
    );
  };
  return Preview as unknown as typeof Square;
}

export function ElementsPanel() {
  const toast = useToast();
  const addNode = useEditor((s) => s.addNode);
  const insertTable = useEditor((s) => s.insertTable);
  const insertChart = useEditor((s) => s.insertChart);
  // Insert helpers: the store already centers the new node in the current
  // viewport and selects it, so afterInsert only confirms with a subtle toast
  // (no zoom - the view stays put).
  const insertShape = (label: string, init: Partial<Node>) => { addNode("shape", init); afterInsert(toast, label.toLowerCase()); };
  const insertFrame = (init: Partial<Node>) => { addNode("frame", init); afterInsert(toast, "frame"); };
  const insertTableEl = (rows: number, cols: number) => { insertTable(rows, cols); afterInsert(toast, "table"); };
  const insertChartEl = (type: ChartType, label: string) => { insertChart(type); afterInsert(toast, `${label} chart`); };
  const insertGridEl = (rows: number, cols: number, spans?: GridSpan[]) => { useEditor.getState().insertPhotoGrid(rows, cols, spans); afterInsert(toast, "photo grid"); };
  // Feature layouts: one large cell with smaller companions.
  const FEATURE_LEFT: GridSpan[] = [{ row: 0, col: 0, rowSpan: 2, colSpan: 1 }, { row: 0, col: 1, rowSpan: 1, colSpan: 1 }, { row: 1, col: 1, rowSpan: 1, colSpan: 1 }];
  const FEATURE_RIGHT: GridSpan[] = [{ row: 0, col: 0, rowSpan: 1, colSpan: 1 }, { row: 1, col: 0, rowSpan: 1, colSpan: 1 }, { row: 0, col: 1, rowSpan: 2, colSpan: 1 }];
  const FEATURE_TOP: GridSpan[] = [{ row: 0, col: 0, rowSpan: 1, colSpan: 2 }, { row: 1, col: 0, rowSpan: 1, colSpan: 1 }, { row: 1, col: 1, rowSpan: 1, colSpan: 1 }];
  const FEATURE_HERO: GridSpan[] = [{ row: 0, col: 0, rowSpan: 2, colSpan: 2 }, { row: 0, col: 2, rowSpan: 1, colSpan: 1 }, { row: 1, col: 2, rowSpan: 1, colSpan: 1 }, { row: 2, col: 0, rowSpan: 1, colSpan: 1 }, { row: 2, col: 1, rowSpan: 1, colSpan: 1 }, { row: 2, col: 2, rowSpan: 1, colSpan: 1 }];
  // Tiles grouped into collapsible categories so the panel scans cleanly.
  const groups: { title: string; icon: typeof Square; defaultOpen?: boolean; tiles: ElementTile[] }[] = [
    {
      title: tr("editor.shapes"),
      icon: Shapes,
      defaultOpen: true,
      tiles: [
        { label: tr("editor.rectangle"), icon: Square, run: () => insertShape(tr("editor.rectangle"), { name: tr("editor.rectangle"), shape: "rect", transform: CENTER, size: { width: 240, height: 160 }, fills: [BRAND] } as Partial<Node>) },
        { label: tr("editor.rounded"), icon: SquareRoundCorner, run: () => insertShape(tr("editor.rounded_rectangle"), { name: tr("editor.rounded_rectangle"), shape: "rect", cornerRadius: { topLeft: 28, topRight: 28, bottomRight: 28, bottomLeft: 28 }, transform: CENTER, size: { width: 240, height: 160 }, fills: [BRAND] } as Partial<Node>) },
        { label: tr("editor.ellipse"), icon: Circle, run: () => insertShape(tr("editor.ellipse"), { name: tr("editor.ellipse"), shape: "ellipse", transform: CENTER, size: { width: 200, height: 200 }, fills: [BRAND] } as Partial<Node>) },
        { label: tr("editor.triangle"), icon: Triangle, run: () => insertShape(tr("editor.triangle"), { name: tr("editor.triangle"), shape: "triangle", sides: 3, transform: CENTER, size: { width: 200, height: 200 }, fills: [BRAND] } as Partial<Node>) },
        { label: tr("editor.pentagon"), icon: Pentagon, run: () => insertShape(tr("editor.pentagon"), { name: tr("editor.pentagon"), shape: "polygon", sides: 5, transform: CENTER, size: { width: 200, height: 200 }, fills: [BRAND] } as Partial<Node>) },
        { label: tr("editor.hexagon"), icon: Hexagon, run: () => insertShape(tr("editor.hexagon"), { name: tr("editor.hexagon"), shape: "polygon", sides: 6, transform: CENTER, size: { width: 200, height: 200 }, fills: [BRAND] } as Partial<Node>) },
        { label: tr("editor.star"), icon: Star, run: () => insertShape(tr("editor.star"), { name: tr("editor.star"), shape: "star", sides: 5, innerRadius: 0.5, transform: CENTER, size: { width: 200, height: 200 }, fills: [BRAND] } as Partial<Node>) },
        { label: tr("editor.diamond"), icon: Diamond, run: () => insertShape(tr("editor.diamond"), { name: tr("editor.diamond"), shape: "polygon", sides: 4, transform: CENTER, size: { width: 200, height: 200 }, fills: [BRAND] } as Partial<Node>) },
        { label: tr("editor.octagon"), icon: Octagon, run: () => insertShape(tr("editor.octagon"), { name: tr("editor.octagon"), shape: "polygon", sides: 8, transform: CENTER, size: { width: 200, height: 200 }, fills: [BRAND] } as Partial<Node>) },
        { label: tr("editor.burst"), icon: Sparkles, run: () => insertShape(tr("editor.burst"), { name: tr("editor.burst"), shape: "star", sides: 12, innerRadius: 0.62, transform: CENTER, size: { width: 200, height: 200 }, fills: [BRAND] } as Partial<Node>) },
        { label: tr("editor.pill"), icon: SquareRoundCorner, run: () => insertShape(tr("editor.pill"), { name: tr("editor.pill"), shape: "rect", cornerRadius: { topLeft: 999, topRight: 999, bottomRight: 999, bottomLeft: 999 }, transform: CENTER, size: { width: 260, height: 120 }, fills: [BRAND] } as Partial<Node>) },
      ],
    },
    {
      // Image placeholders: single frames and photo-grid layouts. Drop or click
      // a photo to fill a cell; it auto-covers the cell.
      title: tr("editor.frames_grids"),
      icon: LayoutGrid,
      defaultOpen: true,
      tiles: [
        { label: tr("editor.frame"), icon: Frame, run: () => insertFrame({ name: tr("editor.frame"), clip: true, transform: CENTER, size: { width: 260, height: 200 }, fills: [FRAME_FILL] } as Partial<Node>) },
        { label: tr("editor.circle_frame"), icon: Circle, run: () => insertFrame({ name: tr("editor.circle_frame"), clip: true, maskShape: "ellipse", transform: CENTER, size: { width: 240, height: 240 }, fills: [FRAME_FILL] } as Partial<Node>) },
        { label: tr("editor.rounded_frame"), icon: SquareRoundCorner, run: () => insertFrame({ name: tr("editor.rounded_frame"), clip: true, cornerRadius: { topLeft: 32, topRight: 32, bottomRight: 32, bottomLeft: 32 }, transform: CENTER, size: { width: 260, height: 200 }, fills: [FRAME_FILL] } as Partial<Node>) },
        { label: "2 photos", icon: gridPreviewIcon(1, 2), run: () => insertGridEl(1, 2) },
        { label: "3 photos", icon: gridPreviewIcon(1, 3), run: () => insertGridEl(1, 3) },
        { label: "4 photos", icon: gridPreviewIcon(2, 2), run: () => insertGridEl(2, 2) },
        { label: "6 photos", icon: gridPreviewIcon(2, 3), run: () => insertGridEl(2, 3) },
        { label: "9 photos", icon: gridPreviewIcon(3, 3), run: () => insertGridEl(3, 3) },
        { label: tr("editor.feature_left"), icon: gridPreviewIcon(2, 2, FEATURE_LEFT), run: () => insertGridEl(2, 2, FEATURE_LEFT) },
        { label: tr("editor.feature_right"), icon: gridPreviewIcon(2, 2, FEATURE_RIGHT), run: () => insertGridEl(2, 2, FEATURE_RIGHT) },
        { label: tr("editor.feature_top"), icon: gridPreviewIcon(2, 2, FEATURE_TOP), run: () => insertGridEl(2, 2, FEATURE_TOP) },
        { label: tr("editor.hero_mosaic"), icon: gridPreviewIcon(3, 3, FEATURE_HERO), run: () => insertGridEl(3, 3, FEATURE_HERO) },
      ],
    },
    {
      title: tr("editor.data_codes"),
      icon: BarChart3,
      tiles: [
        { label: tr("editor.table"), icon: TableIcon, run: () => insertTableEl(3, 3) },
        { label: tr("editor.bar_chart"), icon: BarChart3, run: () => insertChartEl("bar", "bar") },
        { label: tr("editor.grouped_bar"), icon: BarChart3, run: () => insertChartEl("barGrouped", "grouped bar") },
        { label: tr("editor.stacked_bar"), icon: BarChart3, run: () => insertChartEl("barStacked", "stacked bar") },
        { label: tr("editor.line_chart"), icon: LineChart, run: () => insertChartEl("line", "line") },
        { label: tr("editor.area_chart"), icon: AreaChart, run: () => insertChartEl("area", "area") },
        { label: tr("editor.pie_chart"), icon: PieChart, run: () => insertChartEl("pie", "pie") },
        { label: tr("editor.donut_chart"), icon: Donut, run: () => insertChartEl("donut", "donut") },
        { label: tr("editor.scatter"), icon: ScatterChart, run: () => insertChartEl("scatter", "scatter") },
        { label: tr("editor.radar"), icon: Radar, run: () => insertChartEl("radar", "radar") },
        { label: tr("editor.qr_code"), icon: QrCode, run: async () => {
          const t = await promptText({ title: tr("editor.add_qr_code"), label: tr("editor.links_to_url_or_text"), placeholder: "https://", defaultValue: "https://", confirmText: tr("editor.add") });
          if (!t) return;
          addNode("qr", { name: tr("editor.qr_code"), value: t, ecLevel: "M", foreground: { srgb: { r: 0, g: 0, b: 0, a: 1 } }, background: { srgb: { r: 1, g: 1, b: 1, a: 1 } }, modules: qrModules(t, "M"), transform: CENTER, size: { width: 220, height: 220 } } as Partial<Node>);
          afterInsert(toast, tr("editor.qr_code"));
        } },
      ],
    },
  ];
  // Recently-used elements: remember the last few inserted tiles (by label) so
  // they resurface at the top for one-click re-insertion. Tiles are static, so a
  // label round-trips to its run() via this flat lookup.
  const tileByLabel = new Map(groups.flatMap((g) => g.tiles.map((t) => [t.label, t] as const)));
  const [recent, setRecent] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try { return JSON.parse(localStorage.getItem("oc:recentElements") || "[]"); } catch { return []; }
  });
  const recordRecent = (label: string) => {
    setRecent((prev) => {
      const next = [label, ...prev.filter((l) => l !== label)].slice(0, 6);
      try { localStorage.setItem("oc:recentElements", JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };
  const runTile = (t: ElementTile) => { recordRecent(t.label); void t.run(); };
  const recentTiles = recent.map((l) => tileByLabel.get(l)).filter((t): t is ElementTile => !!t);
  // Graphics browser state: search across the bundled sticker library and
  // per-category expansion (collapsed categories render only their first rows).
  const [stickerQuery, setStickerQuery] = useState("");
  const [expandedStickerCats, setExpandedStickerCats] = useState<Set<string>>(new Set());
  const stickerTile = (s: Sticker) => (
    <button
      key={s.id}
      onClick={() => { useEditor.getState().addIconSvg(s.svg); afterInsert(toast, stickerLabel(s).toLowerCase()); }}
      title={stickerLabel(s)}
      aria-label={stickerLabel(s)}
      className="grid aspect-square place-items-center rounded-lg bg-neutral-50 p-1.5 transition hover:bg-brand-50 [&>span>svg]:h-full [&>span>svg]:w-full"
    >
      <span className="block h-full w-full" dangerouslySetInnerHTML={{ __html: s.svg }} />
    </button>
  );
  return (
    <PanelShell title={tr("editor.elements")}>
      <div className="flex flex-col gap-2.5">
        {recentTiles.length > 0 && (
          <CollapsibleSection title={tr("editor.recently_used")} icon={Clock} defaultOpen>
            <div className="grid grid-cols-2 gap-2">
              {recentTiles.map((t) => (
                <button key={`recent-${t.label}`} onClick={() => runTile(t)} className="flex aspect-square flex-col items-center justify-center gap-2 rounded-xl bg-neutral-50 text-neutral-600 transition hover:bg-brand-50 hover:text-brand-ink">
                  <t.icon size={26} />
                  <span className="text-xs font-medium">{t.label}</span>
                </button>
              ))}
            </div>
          </CollapsibleSection>
        )}
        {groups.map((g) => (
          <CollapsibleSection key={g.title} title={g.title} icon={g.icon} defaultOpen={g.defaultOpen}>
            <div className="grid grid-cols-2 gap-2">
              {g.tiles.map((t) => (
                <button key={t.label} onClick={() => runTile(t)} className="flex aspect-square flex-col items-center justify-center gap-2 rounded-xl bg-neutral-50 text-neutral-600 transition hover:bg-brand-50 hover:text-brand-ink">
                  <t.icon size={26} />
                  <span className="text-xs font-medium">{t.label}</span>
                </button>
              ))}
            </div>
          </CollapsibleSection>
        ))}
        {/* Graphics: bundled, free, editable-vector stickers (insert via addIconSvg).
            Searchable across label/category/keywords; browsable by category with
            a per-category "Show all" so the DOM stays small at 400+ assets. */}
        <CollapsibleSection title={tr("editor.graphics")} icon={Sparkles} defaultOpen badge={String(stickers.length)}>
          <div className="mb-2">
            <input
              value={stickerQuery}
              onChange={(e) => setStickerQuery(e.target.value)}
              placeholder={tr("editor.search_graphics")}
              className="w-full rounded-lg border border-neutral-200 px-2.5 py-1.5 text-sm outline-none focus:border-brand-400"
            />
          </div>
          {stickerQuery.trim() ? (
            (() => {
              const q = stickerQuery.trim().toLowerCase();
              const matches = stickers.filter(
                (s) =>
                  // Match the TRANSLATED label and category as well as the
                  // English ones, so search works in the user's language and
                  // still finds a row whose translation is missing.
                  stickerLabel(s).toLowerCase().includes(q) ||
                  s.label.toLowerCase().includes(q) ||
                  stickerCategoryLabel(s.category).toLowerCase().includes(q) ||
                  s.category.toLowerCase().includes(q) ||
                  (s.keywords ?? []).some((k) => k.includes(q)),
              );
              const shown = matches.slice(0, 48);
              return (
                <>
                  <div className="grid grid-cols-4 gap-2">
                    {shown.map((s) => stickerTile(s))}
                  </div>
                  {matches.length === 0 && <p className="py-2 text-xs text-neutral-400">No graphics match &quot;{stickerQuery}&quot;.</p>}
                  {matches.length > shown.length && (
                    <p className="pt-2 text-[11px] text-neutral-400">+{matches.length - shown.length} more, refine your search</p>
                  )}
                </>
              );
            })()
          ) : (
            <div className="flex flex-col gap-2.5">
              {stickerCategories.map((cat) => {
                const items = stickers.filter((s) => s.category === cat);
                const expanded = expandedStickerCats.has(cat);
                const shown = expanded ? items : items.slice(0, 8);
                return (
                  <div key={cat}>
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                        {cat} <span className="font-normal">({items.length})</span>
                      </span>
                      {items.length > 8 && (
                        <button
                          onClick={() =>
                            setExpandedStickerCats((prev) => {
                              const next = new Set(prev);
                              if (next.has(cat)) next.delete(cat);
                              else next.add(cat);
                              return next;
                            })
                          }
                          className="text-[11px] font-medium text-brand-ink hover:text-brand-ink"
                        >
                          {expanded ? tr("editor.show_less") : tr("editor.show_all")}
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-4 gap-2">{shown.map((s) => stickerTile(s))}</div>
                  </div>
                );
              })}
            </div>
          )}
        </CollapsibleSection>
        {/* Animated stickers: editable vectors that insert with a looping emphasis
            animation already applied (play/present to see them move). */}
        <CollapsibleSection title={tr("editor.animated")} icon={Play} defaultOpen={false}>
          <div className="grid grid-cols-4 gap-2">
            {animatedStickers().map((s) => (
              <button
                key={s.id}
                onClick={() => {
                  const st = useEditor.getState();
                  st.addIconSvg(s.svg);
                  const id = st.selection[0];
                  if (id) st.setNodeAnimation(id, { emphasis: { preset: s.preset, durationMs: 1400, delayMs: 0, easing: "ease-in-out" } });
                  afterInsert(toast, tr("editor.name_animated", { name: stickerLabel(s) }));
                }}
                title={tr("editor.name_animated", { name: stickerLabel(s) })}
                aria-label={stickerLabel(s)}
                className="grid aspect-square place-items-center rounded-lg bg-neutral-50 p-1.5 transition hover:bg-brand-50 [&>span>svg]:h-full [&>span>svg]:w-full"
              >
                <span className="block h-full w-full" dangerouslySetInnerHTML={{ __html: s.svg }} />
              </button>
            ))}
          </div>
        </CollapsibleSection>
      </div>
    </PanelShell>
  );
}

const INK = { type: "solid", color: { srgb: { r: 0.1, g: 0.12, b: 0.16, a: 1 } } };
const RECENT_FONTS_KEY = "oc-recent-fonts";

function recentFonts(): string[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(window.localStorage.getItem(RECENT_FONTS_KEY) || "[]"); } catch { return []; }
}
function pushRecentFont(family: string) {
  if (typeof window === "undefined") return;
  const next = [family, ...recentFonts().filter((f) => f !== family)].slice(0, 6);
  try { window.localStorage.setItem(RECENT_FONTS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
}

const cssStack = (e: { family: string; category: string; system?: boolean }) =>
  e.system ? "system-ui, sans-serif" : `'${e.family}', ${e.category === "serif" ? "serif" : e.category === "monospace" ? "monospace" : "sans-serif"}`;

// Curated heading + subheading font pairings (inserted as one two-paragraph box).
const pairings = (): { name: string; head: string; headFont: string; sub: string; subFont: string }[] => [
  { name: tr("editor.bold_clean"), head: tr("editor.heading"), headFont: "Montserrat", sub: tr("editor.your_subheading_here"), subFont: "Open Sans" },
  { name: tr("editor.elegant_serif"), head: tr("editor.heading"), headFont: "Playfair Display", sub: tr("editor.your_subheading_here"), subFont: "Lato" },
  { name: tr("editor.modern"), head: tr("editor.heading"), headFont: "Poppins", sub: tr("editor.your_subheading_here"), subFont: "Inter" },
  { name: tr("editor.editorial"), head: tr("editor.heading"), headFont: "Lora", sub: tr("editor.your_subheading_here"), subFont: "Work Sans" },
  { name: tr("editor.impact"), head: "HEADING", headFont: "Anton", sub: tr("editor.your_subheading_here"), subFont: "Roboto" },
  { name: tr("editor.statement"), head: "HEADING", headFont: "Oswald", sub: tr("editor.your_subheading_here"), subFont: "Merriweather" },
  { name: tr("editor.friendly"), head: tr("editor.heading"), headFont: "Nunito", sub: tr("editor.your_subheading_here"), subFont: "Lora" },
  { name: tr("editor.display"), head: "HEADING", headFont: "Bebas Neue", sub: tr("editor.your_subheading_here"), subFont: "Work Sans" },
  { name: tr("editor.classic"), head: tr("editor.heading"), headFont: "Merriweather", sub: tr("editor.your_subheading_here"), subFont: "Montserrat" },
  { name: tr("editor.minimal"), head: tr("editor.heading"), headFont: "Manrope", sub: tr("editor.your_subheading_here"), subFont: "Manrope" },
  { name: tr("editor.playful"), head: tr("editor.heading"), headFont: "Pacifico", sub: tr("editor.your_subheading_here"), subFont: "Nunito" },
  { name: tr("editor.refined"), head: tr("editor.heading"), headFont: "PT Serif", sub: tr("editor.your_subheading_here"), subFont: "Raleway" },
];

/** A font row that lazy-loads its web font and previews the name in that font. */
function FontRow({ entry, onPick }: { entry: FontCatalogEntry; onPick: (family: string) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  // Lazy-load the preview font only when the row scrolls into view: the catalog
  // is the full ~2k-family library, so eagerly loading every result would fire
  // thousands of stylesheet + face requests. The IntersectionObserver root is
  // the panel's own scroll container (.oc-scroll from PanelShell).
  useEffect(() => {
    if (entry.system) return;
    const el = ref.current;
    if (!el) return;
    const root = el.closest(".oc-scroll");
    const io = new IntersectionObserver(
      (es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); fonts.ensure(entry.family); } },
      { root, rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [entry.family, entry.system]);
  return (
    <button
      ref={ref}
      onClick={() => onPick(entry.family)}
      className="flex w-full items-center justify-between rounded-lg bg-neutral-50 px-3 py-2 text-start text-[15px] text-neutral-800 hover:bg-brand-50"
      style={{ fontFamily: cssStack(entry) }}
      title={`Use ${entry.family}`}
    >
      <span className="truncate">{entry.system ? tr("editor.system_default") : entry.family}</span>
      <span className="ms-2 shrink-0 text-[10px] uppercase tracking-wide text-neutral-300">{entry.category}</span>
    </button>
  );
}

/** Bottom sentinel: grows the rendered font list as it scrolls into view, so the
 *  full library pages in on scroll instead of rendering ~2k rows at once. */
function FontListSentinel({ onMore }: { onMore: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = el.closest(".oc-scroll");
    const io = new IntersectionObserver(
      (es) => { if (es.some((e) => e.isIntersecting)) onMore(); },
      { root, rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [onMore]);
  return <div ref={ref} aria-hidden className="h-2" />;
}

export function TextPanel() {
  const toast = useToast();
  const addNode = useEditor((s) => s.addNode);
  const [query, setQuery] = useState("");
  // Debounce the filter so the catalog search only recomputes after typing stops.
  const debouncedQuery = useDebouncedValue(query);
  const [, force] = useReducer((x: number) => x + 1, 0);
  // Re-render previews as web fonts finish loading.
  useEffect(() => fonts.onChange(() => force()), []);
  // Pairing preview cards render in their target fonts; eagerly load that small
  // fixed set. The scrollable font list below lazy-loads per row, but the pairing
  // cards sit above it and never enter that observer's range.
  useEffect(() => { for (const p of pairings()) { fonts.ensure(p.headFont); fonts.ensure(p.subFont); } }, []);
  // Page the (full-library) results in on scroll; reset when the search changes.
  // Resetting during render (comparing the previous query) rather than in an
  // effect avoids an extra render pass.
  const FONT_PAGE = 60;
  const [fontLimit, setFontLimit] = useState(FONT_PAGE);
  const [fontQuerySeen, setFontQuerySeen] = useState(debouncedQuery);
  if (fontQuerySeen !== debouncedQuery) { setFontQuerySeen(debouncedQuery); setFontLimit(FONT_PAGE); }
  const showMoreFonts = useCallback(() => setFontLimit((n) => n + FONT_PAGE), []);
  const fontFileRef = useRef<HTMLInputElement>(null);

  // Upload a custom font (FR-6): read the file, register it into document.fonts
  // (so the canvas can draw it) and persist it for next session, then apply it.
  async function onFontFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (fontFileRef.current) fontFileRef.current.value = "";
    if (!file) return;
    const family = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "Custom font";
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      void fonts.registerCustomFont(family, dataUrl).then((ok) => {
        if (ok) {
          // Embed the font in the design (data URL) so it loads cross-device when
          // the design is opened elsewhere, not just in this browser's localStorage.
          useEditor.getState().addDocFont({ id: `font-${crypto.randomUUID()}`, family, url: dataUrl });
          applyFont(family); force(); toast.success(`Added font “${family}”.`);
        } else toast.error(tr("editor.couldnt_load_that_font_file"));
      });
    };
    reader.readAsDataURL(file);
  }

  const addText = (text: string, fontSize: number, weight: number, family = "system") => {
    fonts.ensure(family);
    addNode("text", {
      name: text.slice(0, 24),
      transform: { x: 300, y: 320, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 460, height: Math.round(fontSize * 1.5) },
      box: { mode: "fixed", width: 460, height: Math.round(fontSize * 1.5), autoFit: { enabled: false, min: 8, max: 512 }, verticalAlign: "top" },
      content: [{ runs: [{ text, style: { fontFamily: family, fontStyle: "Regular", fontSize, axes: { wght: weight }, fill: INK } }], style: { align: "left", direction: "auto" } }],
    } as Partial<Node>);
    afterInsert(toast, "text");
  };

  const selectedTextId = (): string | null => {
    const st = useEditor.getState();
    if (st.selection.length === 1) {
      const loc = locate(st.doc, st.selection[0]);
      if (loc?.node.type === "text") return loc.node.id;
    }
    return null;
  };

  // Apply a font to the selected text, or add a new text box in that font.
  const applyFont = (family: string) => {
    fonts.ensure(family);
    pushRecentFont(family);
    force();
    const id = selectedTextId();
    if (id) { useEditor.getState().setTextStyle(id, { fontFamily: family }); toast.success(`Applied ${family}`); }
    else addText(tr("editor.your_text"), 32, 400, family); // addText toasts + frames the new box
  };

  const addPairing = (p: (ReturnType<typeof pairings>)[number]) => {
    fonts.ensure(p.headFont);
    fonts.ensure(p.subFont);
    addNode("text", {
      name: p.name,
      transform: { x: 300, y: 320, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 480, height: 120 },
      box: { mode: "fixed", width: 480, height: 120, autoFit: { enabled: false, min: 8, max: 512 }, verticalAlign: "top" },
      content: [
        { runs: [{ text: p.head, style: { fontFamily: p.headFont, fontStyle: "Regular", fontSize: 48, axes: { wght: 700 }, fill: INK } }], style: { align: "left", direction: "auto" } },
        { runs: [{ text: p.sub, style: { fontFamily: p.subFont, fontStyle: "Regular", fontSize: 22, axes: { wght: 400 }, fill: INK } }], style: { align: "left", direction: "auto" } },
      ],
    } as Partial<Node>);
    afterInsert(toast, "font pairing");
  };

  const results = searchFonts(debouncedQuery);
  const recents = recentFonts().map((f) => searchFonts(f).find((e) => e.family === f)).filter(Boolean) as FontCatalogEntry[];
  const customFams = fonts.customFamilies().filter((f) => !debouncedQuery || f.toLowerCase().includes(debouncedQuery.toLowerCase()));

  return (
    <PanelShell title={tr("editor.text")}>
      <div className="flex flex-col gap-2.5">
        <CollapsibleSection title={tr("editor.add_text")} icon={Type} defaultOpen>
          <button onClick={() => addText(tr("editor.your_text_here"), 28, 400)} className="flex items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-3 text-sm font-semibold text-white hover:bg-brand-700">
            <Type size={16} /> {tr("editor.add_a_text_box")}
          </button>
          <button onClick={() => addText(tr("editor.add_a_heading"), 56, 800)} className="rounded-xl bg-neutral-50 px-4 py-3 text-start text-2xl font-extrabold text-neutral-800 hover:border-brand-300 hover:bg-brand-50">{tr("editor.add_a_heading")}</button>
          <button onClick={() => addText(tr("editor.add_a_subheading"), 36, 600)} className="rounded-xl bg-neutral-50 px-4 py-3 text-start text-lg font-semibold text-neutral-800 hover:border-brand-300 hover:bg-brand-50">{tr("editor.add_a_subheading")}</button>
          <button onClick={() => addText(tr("editor.add_body_text"), 20, 400)} className="rounded-xl bg-neutral-50 px-4 py-3 text-start text-sm text-neutral-800 hover:border-brand-300 hover:bg-brand-50">{tr("editor.add_body_text")}</button>
        </CollapsibleSection>

        <CollapsibleSection title={tr("editor.font_pairings")} icon={Sparkles} defaultOpen>
          {pairings().map((p) => (
            <button key={p.name} onClick={() => addPairing(p)} className="rounded-xl bg-neutral-50 px-4 py-2.5 text-start hover:bg-brand-50">
              <span className="block text-lg font-bold text-neutral-800" style={{ fontFamily: `'${p.headFont}', sans-serif` }}>{p.head}</span>
              <span className="block text-xs text-neutral-500" style={{ fontFamily: `'${p.subFont}', sans-serif` }}>{p.sub}</span>
            </button>
          ))}
        </CollapsibleSection>

        <CollapsibleSection title={tr("editor.fonts")} icon={Search} defaultOpen>
          <div className="relative">
            <Search size={14} className="absolute start-3 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tr("editor.search_fonts")} className="w-full rounded-lg border border-neutral-200 py-2 ps-8 pe-8 text-sm outline-none focus:border-brand-400" />
            {query && (
              <button onClick={() => setQuery("")} title={tr("editor.clear_search")} className="absolute end-2 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded text-neutral-400 hover:text-neutral-700">
                <X size={13} />
              </button>
            )}
          </div>
          <input ref={fontFileRef} type="file" accept=".ttf,.otf,.woff,.woff2,font/*" hidden onChange={(e) => void onFontFile(e)} />
          <button onClick={() => fontFileRef.current?.click()} className="flex items-center justify-center gap-1.5 rounded-lg border border-neutral-200 py-2 text-xs font-medium text-neutral-600 hover:border-brand-300 hover:text-brand-ink">
            <Upload size={13} /> {tr("editor.upload_a_font")}
          </button>
          {customFams.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="px-1 text-[10px] uppercase tracking-wide text-neutral-300">{tr("editor.your_fonts")}</span>
              {customFams.map((f) => (
                <button key={`c-${f}`} onClick={() => applyFont(f)} style={{ fontFamily: `'${f}', sans-serif` }} className="flex w-full items-center justify-between rounded-lg bg-neutral-50 px-3 py-2 text-start text-[15px] text-neutral-800 hover:bg-brand-50" title={`Use ${f}`}>
                  <span className="truncate">{f}</span>
                  <span className="ms-2 shrink-0 text-[10px] uppercase tracking-wide text-neutral-300">{tr("editor.custom")}</span>
                </button>
              ))}
            </div>
          )}
          {!query && recents.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="px-1 text-[10px] uppercase tracking-wide text-neutral-300">{tr("editor.recent")}</span>
              {recents.map((e) => <FontRow key={`r-${e.family}`} entry={e} onPick={applyFont} />)}
            </div>
          )}
          <div className="flex flex-col gap-1">
            {results.slice(0, fontLimit).map((e) => <FontRow key={e.family} entry={e} onPick={applyFont} />)}
            {results.length === 0 && <p className="px-1 py-2 text-xs text-neutral-400">No fonts match “{debouncedQuery}”.</p>}
            {fontLimit < results.length && <FontListSentinel onMore={showMoreFonts} />}
          </div>
        </CollapsibleSection>
      </div>
    </PanelShell>
  );
}

/** Place an image: into the selected frame if one is selected, else as a new node. */
function placeImage(url: string, provenance?: Record<string, unknown>) {
  const st = useEditor.getState();
  const sel = st.selection;
  if (sel.length === 1) {
    const loc = locate(st.doc, sel[0]);
    if (loc?.node.type === "frame") { st.setFrameImage(sel[0], url, provenance); return; }
    // A selected photo grid receives the image in its first empty cell, so
    // clicking photos with the grid selected fills it cell by cell.
    if (loc?.node.type === "grid") {
      const empty = (loc.node as unknown as { children: Node[] }).children.find(
        (n) => n.type === "frame" && !(n as unknown as { children?: Node[] }).children?.length,
      );
      if (empty) { st.setFrameImage(empty.id, url, provenance); return; }
    }
  }
  st.addImage(url, undefined, provenance);
}

/** True if an asset is an SVG, by content-type or filename. */
function isSvgAsset(a: UploadedAsset): boolean {
  return (a.mimeType ?? "").includes("svg") || /\.svg$/i.test(a.filename ?? "");
}

/** Read a File/Blob to a data URL (the base64 payload is the part after the comma). */
function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

/**
 * Generate a small downscaled thumbnail (data URL) from a raster image file for
 * the uploads grid. Longest side ~256px; JPEG for opaque, PNG for types that
 * carry transparency. Returns undefined if the browser can't decode the image
 * (e.g. SVG, or no canvas) so the caller falls back to the content URL.
 */
const THUMB_MAX = 256;
async function makeThumbnail(file: File): Promise<string | undefined> {
  if (typeof document === "undefined") return undefined;
  if (file.type === "image/svg+xml") return undefined; // vectors scale losslessly
  try {
    const dataUrl = await readAsDataUrl(file);
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const el = new Image();
      el.onload = () => res(el);
      el.onerror = () => rej(new CodedError("errors.image_decode_failed", "Couldn't decode the image."));
      el.src = dataUrl;
    });
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return undefined;
    const scale = Math.min(1, THUMB_MAX / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement("canvas");
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.drawImage(img, 0, 0, tw, th);
    const png = file.type === "image/png" || file.type === "image/gif" || file.type === "image/webp";
    return canvas.toDataURL(png ? "image/png" : "image/jpeg", 0.8);
  } catch {
    return undefined;
  }
}

export function UploadsPanel({ workspaceId }: { workspaceId: string | null }) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const svgRef = useRef<HTMLInputElement>(null);
  const pdfRef = useRef<HTMLInputElement>(null);
  const [assets, setAssets] = useState<UploadedAsset[]>([]);
  // In-flight uploads shown as placeholder tiles with a live progress percentage
  //, replaced by the real asset when each finishes.
  const [uploading, setUploading] = useState<{ id: string; name: string; preview: string; progress: number; error: boolean }[]>([]);
  const [folders, setFolders] = useState<AssetFolder[]>([]);
  const [usage, setUsage] = useState<StorageUsageView | null>(null);
  const [folderId, setFolderId] = useState<string | null>(null); // null = all assets
  const [query, setQuery] = useState("");
  // Debounce the search so we refetch after typing stops, not per keystroke.
  const debouncedQuery = useDebouncedValue(query);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false); // subtle in-flight on re-search
  const [dragOver, setDragOver] = useState(false);
  const [editing, setEditing] = useState<string | null>(null); // asset id whose tags are open
  const confirmDelete = useArmedConfirm();

  // Fetch the visible asset list + usage (honoring the selected folder + the
  // debounced search box). Returns the data; callers decide whether to apply it.
  const fetchAssets = useCallback(async () => {
    if (!workspaceId) return { assets: [] as UploadedAsset[], usage: null as StorageUsageView | null };
    const filter: { folderId?: string | null; q?: string } = {};
    if (folderId !== null) filter.folderId = folderId;
    if (debouncedQuery.trim()) filter.q = debouncedQuery.trim();
    const [a, u] = await Promise.all([
      oc.listAssets(workspaceId, filter).catch(() => [] as UploadedAsset[]),
      oc.assetUsage(workspaceId).catch(() => null),
    ]);
    return { assets: a, usage: u };
  }, [workspaceId, folderId, debouncedQuery]);

  const refresh = useCallback(async () => {
    const { assets: a, usage: u } = await fetchAssets();
    setAssets(a);
    setUsage(u);
    setLoading(false);
  }, [fetchAssets]);

  const refreshFolders = useCallback(async () => {
    if (!workspaceId) return;
    setFolders(await oc.listAssetFolders(workspaceId).catch(() => []));
  }, [workspaceId]);

  // quotaErrorKind tells the 413 causes apart: the per-workspace quota and the
  // global per-user account limit carry a problem+json detail saying which;
  // anything else (the server's URL-import size cap, or a reverse proxy's
  // request-body limit, which never sends problem+json) means this one
  // file/request was too big, NOT that storage is full, so it must not tell
  // the user to delete uploads.
  function quotaErrorKind(e: unknown): false | "workspace" | "account" | "size" {
    const status = e instanceof ApiError ? e.status : (e as { status?: number } | null)?.status;
    if (status !== 413) return false;
    // Prefer the stable problem code; the English-detail sniff stays as the
    // fallback so a newer client still words errors from an older binary.
    const code = (e instanceof ApiError
      ? (e.body as { code?: string } | undefined)?.code
      : (e as { code?: string } | null)?.code?.replace(/^errors\.api_/, "")) ?? "";
    if (code === "account_storage_full") return "account";
    if (code === "workspace_storage_full") return "workspace";
    if (code === "import_too_large") return "size";
    const detail =
      e instanceof ApiError
        ? ((e.body as { detail?: string } | undefined)?.detail ?? "")
        : ((e as { detail?: string } | null)?.detail ?? "");
    if (detail.includes("account storage")) return "account";
    if (detail.includes("storage quota")) return "workspace";
    return "size";
  }

  // Upload one or many image files (drag-drop or picker) into the open folder.
  const uploadFiles = useCallback(async (files: File[]) => {
    if (!workspaceId) return;
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) { if (files.length) toast.error(tr("editor.only_image_files_can_be_uploaded")); return; }
    // Show a placeholder tile per file immediately, with a live progress %.
    const items = imgs.map((file) => ({ id: `up-${crypto.randomUUID()}`, name: file.name, preview: URL.createObjectURL(file), progress: 0, error: false, file }));
    setUploading((cur) => [...items.map((it) => ({ id: it.id, name: it.name, preview: it.preview, progress: it.progress, error: it.error })), ...cur]);
    const setPct = (id: string, progress: number) => setUploading((cur) => cur.map((u) => (u.id === id ? { ...u, progress } : u)));
    const remove = (id: string) => setUploading((cur) => {
      const u = cur.find((x) => x.id === id);
      if (u) URL.revokeObjectURL(u.preview);
      return cur.filter((x) => x.id !== id);
    });
    let ok = 0;
    let limit: false | "workspace" | "account" | "size" = false;
    for (const it of items) {
      try {
        const dataUrl = await readAsDataUrl(it.file);
        // Client-side thumbnail for the grid (perf): keeps full bytes server-side
        // but serves a tiny preview. Optional, so a decode failure is non-fatal.
        const thumbnail = await makeThumbnail(it.file);
        const asset = await uploadAssetWithProgress(
          workspaceId,
          { filename: it.file.name, dataBase64: dataUrl.split(",")[1] ?? "", folderId, thumbnail },
          (pct) => setPct(it.id, pct),
        );
        ok++;
        // Drop the placeholder and show the real asset in its place (no flicker).
        setAssets((cur) => (cur.some((a) => a.id === asset.id) ? cur : [asset, ...cur]));
        remove(it.id);
      } catch (e) {
        const kind = quotaErrorKind(e);
        if (kind) limit = kind;
        // Mark the tile failed, then clear it after a moment so the grid recovers.
        setUploading((cur) => cur.map((u) => (u.id === it.id ? { ...u, error: true } : u)));
        setTimeout(() => remove(it.id), 4000);
      }
    }
    if (ok) { toast.success(ok === 1 ? tr("editor.uploaded") : tr("editor.uploaded_n_images", { count: ok })); await refresh(); }
    if (limit === "account") toast.error(tr("editor.your_account_storage_limit_is_reached_delete"));
    else if (limit === "workspace") toast.error(tr("editor.storage_quota_reached_delete_some_uploads_to"));
    else if (limit === "size") toast.error(tr("editor.file_too_large_the_server_or_its_reverse_pro"));
    else if (ok < imgs.length) toast.error(tr("editor.n_uploads_failed_unsupported", { count: imgs.length - ok }));
  }, [workspaceId, folderId, refresh, toast]);

  // Upload an arbitrary recorded Blob (audio/video) as an asset.
  const uploadBlob = useCallback(async (blob: Blob, filename: string) => {
    if (!workspaceId) return;
    try {
      const dataUrl = await readAsDataUrl(blob);
      await oc.uploadAsset(workspaceId, { filename, dataBase64: dataUrl.split(",")[1] ?? "", folderId });
      toast.success(tr("editor.recording_saved"));
      await refresh();
    } catch (e) {
      const kind = quotaErrorKind(e);
      if (kind === "account") toast.error(tr("editor.your_account_storage_limit_is_reached"));
      else if (kind === "workspace") toast.error(tr("editor.storage_quota_reached"));
      else if (kind === "size") toast.error(tr("editor.recording_too_large_the_server_or_its_revers"));
      else toast.error(tr("editor.couldnt_save_the_recording"));
    }
  }, [workspaceId, folderId, refresh, toast]);

  // Import an image from a remote URL (server-side, SSRF-guarded).
  const importUrl = useCallback(async () => {
    if (!workspaceId) return;
    const url = await promptText({ title: tr("editor.import_from_url"), label: tr("editor.image_url"), placeholder: "https://…/image.png", confirmText: tr("editor.import") });
    if (!url) return;
    try {
      await oc.importAssetFromUrl(workspaceId, url.trim(), folderId);
      toast.success(tr("editor.imported"));
      await refresh();
    } catch (e) {
      const kind = quotaErrorKind(e);
      if (kind === "account") toast.error(tr("editor.your_account_storage_limit_is_reached"));
      else if (kind === "workspace") toast.error(tr("editor.storage_quota_reached_delete_some_uploads_to"));
      else if (kind === "size") toast.error(tr("editor.that_image_is_too_large_to_import"));
      else if (e instanceof ApiError) toast.error(tr("editor.couldnt_import_that_url_not_an_image_blocked"));
      else toast.error(tr("editor.couldnt_import_that_url"));
    }
  }, [workspaceId, folderId, refresh, toast]);

  // Insert an uploaded SVG as an editable vector group (in addition to placing
  // it as an image). Fetches the SVG text and routes through the store.
  const insertSvgEditable = useCallback(async (a: UploadedAsset) => {
    try {
      const res = await fetch(resolveAssetUrl(a.url), { credentials: "include" });
      const svg = await res.text();
      if (!svg.includes("<svg")) { toast.error(tr("editor.that_file_isnt_a_valid_svg")); return; }
      useEditor.getState().addIconSvg(svg);
      toast.success(tr("editor.inserted_as_editable_vectors"));
    } catch {
      toast.error(tr("editor.couldnt_load_that_svg"));
    }
  }, [toast]);

  const removeAsset = useCallback(async (id: string) => {
    try {
      await oc.deleteAsset(id);
      setAssets((a) => a.filter((x) => x.id !== id));
      if (workspaceId) setUsage(await oc.assetUsage(workspaceId).catch(() => null));
    } catch {
      toast.error(tr("editor.couldnt_delete_that_upload"));
    }
  }, [toast, workspaceId]);

  const renameAsset = useCallback(async (a: UploadedAsset) => {
    const name = await promptText({ title: tr("editor.rename_upload"), label: tr("editor.name"), defaultValue: a.filename ?? "", confirmText: "Rename" });
    if (!name || name === a.filename) return;
    try {
      const updated = await oc.updateAsset(a.id, { filename: name });
      setAssets((list) => list.map((x) => (x.id === a.id ? updated : x)));
    } catch { toast.error(tr("editor.couldnt_rename_that_upload")); }
  }, [toast]);

  const setTags = useCallback(async (id: string, tags: string[]) => {
    try {
      const updated = await oc.updateAsset(id, { tags });
      setAssets((list) => list.map((x) => (x.id === id ? updated : x)));
    } catch { toast.error(tr("editor.couldnt_update_tags")); }
  }, [toast]);

  const createFolder = useCallback(async () => {
    if (!workspaceId) return;
    const name = await promptText({ title: tr("editor.new_folder"), label: tr("editor.folder_name"), placeholder: "e.g. Logos", confirmText: tr("editor.create") });
    if (!name) return;
    try {
      const f = await oc.createAssetFolder(workspaceId, { name });
      await refreshFolders();
      setFolderId(f.id);
    } catch { toast.error(tr("editor.couldnt_create_that_folder")); }
  }, [workspaceId, refreshFolders, toast]);

  const renameFolder = useCallback(async (f: AssetFolder) => {
    const name = await promptText({ title: tr("editor.rename_folder"), label: tr("editor.folder_name"), defaultValue: f.name, confirmText: tr("editor.rename") });
    if (!name || name === f.name) return;
    try { await oc.renameAssetFolder(f.id, name); await refreshFolders(); }
    catch { toast.error(tr("editor.couldnt_rename_that_folder")); }
  }, [refreshFolders, toast]);

  const deleteFolder = useCallback(async (f: AssetFolder) => {
    try {
      await oc.deleteAssetFolder(f.id);
      if (folderId === f.id) setFolderId(null);
      await refreshFolders();
      await refresh();
      toast.success(tr("editor.folder_deleted_its_uploads_moved_to_all_uplo"));
    } catch { toast.error(tr("editor.couldnt_delete_that_folder")); }
  }, [folderId, refreshFolders, refresh, toast]);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void (async () => {
      const f = await oc.listAssetFolders(workspaceId).catch(() => []);
      if (!cancelled) setFolders(f);
    })();
    return () => { cancelled = true; };
  }, [workspaceId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setSearching(true);
      try {
        const { assets: a, usage: u } = await fetchAssets();
        if (cancelled) return;
        setAssets(a);
        setUsage(u);
        setLoading(false);
      } finally {
        if (!cancelled) setSearching(false);
      }
    })();
    return () => { cancelled = true; };
  }, [fetchAssets]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    await uploadFiles(Array.from(e.target.files ?? []));
    if (fileRef.current) fileRef.current.value = "";
  }

  // Import an SVG file (e.g. an SVG export from another design tool) as editable elements, fit to the
  // page. Reads the file locally; no upload needed.
  async function onSvgFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (svgRef.current) svgRef.current.value = "";
    if (!file) return;
    const text = await file.text();
    if (!text.includes("<svg")) { toast.error(tr("editor.that_file_isnt_a_valid_svg")); return; }
    useEditor.getState().importSvg(text);
    toast.success(tr("editor.imported_svg_as_editable_elements"));
  }

  // Import a PDF (e.g. a PDF export from another design tool) as editable pages (text). pdf.js loads
  // on demand. Vectors/images from the PDF are not extracted (text only).
  async function onPdfFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (pdfRef.current) pdfRef.current.value = "";
    if (!file) return;
    try {
      const { pdfToPages } = await import("@/lib/pdfImport");
      const pages = await pdfToPages(await file.arrayBuffer());
      if (!pages.length) { toast.error(tr("editor.couldnt_read_any_pages_from_that_pdf")); return; }
      const elements = pages.reduce((n, p) => n + p.nodes.length, 0);
      useEditor.getState().importPdfPages(pages);
      toast.success(`Imported ${pages.length} page${pages.length > 1 ? "s" : ""} (${elements} text elements).`);
    } catch {
      toast.error(tr("editor.couldnt_import_that_pdf"));
    }
  }

  const selectedFolder = folders.find((f) => f.id === folderId) ?? null;
  const usePct = usage && usage.quotaBytes > 0 ? Math.min(100, (usage.usedBytes / usage.quotaBytes) * 100) : 0;
  // Global account usage (all workspaces); shown only when the instance sets
  // a per-user limit (USER_STORAGE_QUOTA_BYTES).
  const userPct = usage && usage.userQuotaBytes > 0 ? Math.min(100, (usage.userUsedBytes / usage.userQuotaBytes) * 100) : 0;

  return (
    <PanelShell title={tr("editor.uploads")}>
      <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => void onFile(e)} />
      <input ref={svgRef} type="file" accept=".svg,image/svg+xml" hidden onChange={(e) => void onSvgFile(e)} />
      <input ref={pdfRef} type="file" accept=".pdf,application/pdf" hidden onChange={(e) => void onPdfFile(e)} />

      <div className="flex flex-col gap-2.5">
        <CollapsibleSection title={tr("editor.upload")} icon={Upload} defaultOpen>
          <div
            onDragOver={(e) => { e.preventDefault(); if (!dragOver) setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); void uploadFiles(Array.from(e.dataTransfer.files)); }}
            className={`rounded-xl border-2 border-dashed p-3 text-center transition ${dragOver ? "border-brand-400 bg-brand-50" : "border-neutral-200"}`}
          >
            <Button block onClick={() => fileRef.current?.click()} disabled={!workspaceId}>
              <Upload size={16} /> {selectedFolder ? `Upload to ${selectedFolder.name}` : tr("editor.upload_images")}
            </Button>
            <p className="mt-2 text-[11px] text-neutral-400">{tr("editor.or_drop_images_here")}</p>
            {/* Compact one-word labels so the three cells hold one line at
                every panel width and font metric (the previous nowrap labels
                overflowed their neighbors on narrow panels / wider fonts);
                the icons and tooltips carry the full meaning. Wrap-safe as a
                fallback: no nowrap, min-w-0, centered. */}
            <div className="mt-2.5 grid grid-cols-3 gap-1.5">
              <button onClick={() => void importUrl()} disabled={!workspaceId} title={tr("editor.import_an_image_from_a_url")} className="flex min-w-0 flex-col items-center justify-center gap-1 rounded-lg border border-neutral-200 px-1 py-2 text-[11px] font-medium leading-tight text-neutral-600 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-ink disabled:opacity-40">
                <LinkIcon size={15} className="shrink-0" /> <span className="text-center">{tr("editor.from_url")}</span>
              </button>
              <button onClick={() => svgRef.current?.click()} title={tr("editor.import_an_svg_e_g_an_svg_export_from_another")} className="flex min-w-0 flex-col items-center justify-center gap-1 rounded-lg border border-neutral-200 px-1 py-2 text-[11px] font-medium leading-tight text-neutral-600 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-ink">
                <Upload size={15} className="shrink-0" /> <span className="text-center">SVG</span>
              </button>
              <button onClick={() => pdfRef.current?.click()} title={tr("editor.import_a_pdf_e_g_a_pdf_export_from_another_d")} className="flex min-w-0 flex-col items-center justify-center gap-1 rounded-lg border border-neutral-200 px-1 py-2 text-[11px] font-medium leading-tight text-neutral-600 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-ink">
                <Upload size={15} className="shrink-0" /> <span className="text-center">PDF</span>
              </button>
            </div>
          </div>

          {/* Voice + webcam recorders (record a clip, then upload it as an asset). */}
          {workspaceId && (
            <Recorder
              mode="audio"
              disabled={!workspaceId}
              onCapture={(blob, name) => void uploadBlob(blob, name)}
            />
          )}
          {workspaceId && (
            <Recorder
              mode="video"
              disabled={!workspaceId}
              onCapture={(blob, name) => void uploadBlob(blob, name)}
            />
          )}
          {workspaceId && (
            <Recorder
              mode="screen"
              disabled={!workspaceId}
              onCapture={(blob, name) => void uploadBlob(blob, name)}
            />
          )}
        </CollapsibleSection>

        {/* Folders: All uploads + per-folder chips, with create/rename/delete. */}
        <CollapsibleSection title={tr("editor.folders")} icon={Folder} defaultOpen>
          <button onClick={() => void createFolder()} disabled={!workspaceId} className="flex items-center gap-1.5 self-start rounded-md px-2 py-1 text-xs font-medium text-neutral-500 hover:bg-neutral-100 hover:text-brand-ink disabled:opacity-40">
            <FolderPlus size={14} /> {tr("editor.new_folder")}
          </button>
          <div className="flex flex-col gap-0.5">
            <button onClick={() => setFolderId(null)} className={`flex items-center gap-2 rounded-md px-2 py-1 text-start text-sm ${folderId === null ? "bg-brand-50 font-medium text-brand-ink" : "text-neutral-600 hover:bg-neutral-100"}`}>
              <Folder size={14} /> {tr("editor.all_uploads")}
            </button>
            {folders.map((f) => (
              <div key={f.id} className={`group flex items-center gap-1 rounded-md px-2 py-1 text-sm ${folderId === f.id ? "bg-brand-50 text-brand-ink" : "text-neutral-600 hover:bg-neutral-100"}`}>
                <button onClick={() => setFolderId(f.id)} className="flex flex-1 items-center gap-2 text-start">
                  <Folder size={14} /> <span className="truncate">{f.name}</span>
                </button>
                {/* Visible-but-transparent (not display:none) so the actions stay
                    Tab-reachable and reappear on keyboard focus. */}
                <button onClick={() => void renameFolder(f)} title={tr("editor.rename_folder")} className="grid h-5 w-5 place-items-center rounded text-neutral-400 opacity-0 hover:text-brand-ink focus-visible:opacity-100 group-hover:opacity-100"><Pencil size={12} /></button>
                <button
                  onClick={() => confirmDelete.confirm(`folder:${f.id}`, () => void deleteFolder(f))}
                  title={confirmDelete.armed === `folder:${f.id}` ? tr("editor.click_again_to_delete") : tr("editor.delete_folder")}
                  className={`grid h-5 w-5 place-items-center rounded ${confirmDelete.armed === `folder:${f.id}` ? "bg-red-600 text-white" : "text-neutral-400 opacity-0 hover:text-red-600 focus-visible:opacity-100 group-hover:opacity-100"}`}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        </CollapsibleSection>

        <CollapsibleSection title={tr("editor.your_media")} icon={ImagePlus} defaultOpen>
          {/* Search by name or tag (debounced). */}
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tr("editor.search_uploads")}
              className="w-full rounded-lg border border-neutral-200 py-1.5 ps-8 pe-8 text-sm outline-none focus:border-brand-400"
            />
            <div className="absolute end-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
              {searching && !loading && <Spinner className="text-[13px] text-neutral-400" />}
              {query && (
                <button onClick={() => setQuery("")} title={tr("editor.clear_search")} className="grid h-5 w-5 place-items-center rounded text-neutral-400 hover:text-neutral-700">
                  <X size={13} />
                </button>
              )}
            </div>
          </div>

          {loading && workspaceId && uploading.length === 0 ? (
            <div className="grid place-items-center py-8 text-neutral-400"><Spinner /></div>
          ) : assets.length === 0 && uploading.length === 0 ? (
            <p className="py-6 text-center text-xs text-neutral-400">{debouncedQuery.trim() ? tr("editor.no_matching_uploads") : tr("editor.no_uploads_yet")}</p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {uploading.map((u) => (
                <div key={u.id} className="relative overflow-hidden rounded-lg border border-neutral-200" title={u.error ? `${u.name} failed to upload` : `Uploading ${u.name}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={u.preview} alt="" className="aspect-square w-full object-cover opacity-40" />
                  <div className="absolute inset-0 grid place-items-center">
                    {u.error
                      ? <span className="text-[11px] font-semibold text-red-600">{tr("editor.failed")}</span>
                      : <span className="text-sm font-semibold tabular-nums text-neutral-700">{u.progress}%</span>}
                  </div>
                  {!u.error && (
                    <div className="absolute inset-x-0 bottom-0 h-1 bg-neutral-200">
                      <div className="h-full bg-brand-600 transition-[width] duration-150 ease-out" style={{ width: `${u.progress}%` }} />
                    </div>
                  )}
                </div>
              ))}
              {assets.map((a) => (
            <div key={a.id} className="group relative overflow-hidden rounded-lg border border-neutral-200 hover:border-brand-300">
              <button
                onClick={() => placeImage(resolveAssetUrl(a.url))}
                draggable
                onDragStart={(e) => e.dataTransfer.setData("application/x-oc-image", resolveAssetUrl(a.url))}
                title={tr("editor.click_to_place_or_drag_onto_the_canvas")}
                className="block w-full"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={a.thumbnail ?? resolveAssetUrl(a.url)} alt={a.filename ?? "upload"} className="aspect-square w-full object-cover" />
              </button>
              {/* Visible-but-transparent (not display:none) so the actions stay
                  Tab-reachable; focus-within reveals them for keyboard users. */}
              <div className="absolute end-1 top-1 flex gap-1 opacity-0 focus-within:opacity-100 group-hover:opacity-100">
                {isSvgAsset(a) && (
                  <button onClick={() => void insertSvgEditable(a)} title={tr("editor.insert_as_editable_vectors")} className="grid h-6 w-6 place-items-center rounded-full bg-surface/90 text-neutral-500 shadow hover:text-brand-ink"><Spline size={12} /></button>
                )}
                <button onClick={() => setEditing((id) => (id === a.id ? null : a.id))} title={tr("editor.edit_tags")} className="grid h-6 w-6 place-items-center rounded-full bg-surface/90 text-neutral-500 shadow hover:text-brand-ink"><Tag size={12} /></button>
                <button onClick={() => void renameAsset(a)} title={tr("editor.rename")} className="grid h-6 w-6 place-items-center rounded-full bg-surface/90 text-neutral-500 shadow hover:text-brand-ink"><Pencil size={12} /></button>
                <button
                  onClick={() => confirmDelete.confirm(`asset:${a.id}`, () => void removeAsset(a.id))}
                  title={confirmDelete.armed === `asset:${a.id}` ? tr("editor.click_again_to_delete") : tr("editor.delete_upload")}
                  className={`grid h-6 w-6 place-items-center rounded-full shadow ${confirmDelete.armed === `asset:${a.id}` ? "bg-red-600 text-white" : "bg-surface/90 text-neutral-500 hover:text-red-600"}`}
                >
                  <Trash2 size={13} />
                </button>
              </div>
              {a.tags.length > 0 && (
                <div className="pointer-events-none absolute inset-x-1 bottom-1 flex flex-wrap gap-0.5">
                  {a.tags.slice(0, 3).map((t) => (
                    <span key={t} className="rounded bg-black/55 px-1 text-[9px] leading-4 text-white">{t}</span>
                  ))}
                </div>
              )}
                  {editing === a.id && <TagEditor asset={a} folders={folders} onClose={() => setEditing(null)} onSetTags={(tags) => void setTags(a.id, tags)} onMove={async (fid) => { try { const u = await oc.updateAsset(a.id, { folderId: fid }); setAssets((list) => folderId !== null && u.folderId !== folderId ? list.filter((x) => x.id !== a.id) : list.map((x) => (x.id === a.id ? u : x))); } catch { toast.error(tr("editor.couldnt_move_that_upload")); } }} />}
                </div>
              ))}
            </div>
          )}

          {/* Storage usage meter (used / cap). */}
          {usage && (
            <div className="mt-2 border-t border-neutral-100 pt-3">
              <div className="mb-1 flex items-center justify-between text-[11px] text-neutral-500">
                <span>{tr("editor.storage")}</span>
                <span>{formatBytes(usage.usedBytes)} {usage.quotaBytes > 0 ? `of ${formatBytes(usage.quotaBytes)}` : "used"}</span>
              </div>
              {usage.quotaBytes > 0 && (
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-100">
                  <div className={`h-full rounded-full ${usePct >= 90 ? "bg-red-500" : "oc-gradient"}`} style={{ width: `${usePct}%` }} />
                </div>
              )}
              {/* Global account usage, shown only on instances with a per-user limit. */}
              {usage.userQuotaBytes > 0 && (
                <>
                  <div className="mb-1 mt-2 flex items-center justify-between text-[11px] text-neutral-500">
                    <span>{tr("editor.your_storage_all_workspaces")}</span>
                    <span>{formatBytes(usage.userUsedBytes)} of {formatBytes(usage.userQuotaBytes)}</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-100">
                    <div className={`h-full rounded-full ${userPct >= 90 ? "bg-red-500" : "oc-gradient"}`} style={{ width: `${userPct}%` }} />
                  </div>
                </>
              )}
            </div>
          )}
        </CollapsibleSection>
      </div>
    </PanelShell>
  );
}

/** Pick a supported MediaRecorder mime type for a kind, or "" to let the UA decide. */
function pickMimeType(kind: "audio" | "video"): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = kind === "audio"
    ? ["audio/webm", "audio/ogg", "audio/mp4"]
    : ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
}

/**
 * Voice/webcam recorder. Uses the browser MediaRecorder API to capture
 * a mic-only ("audio") or webcam ("video") clip with start/stop and a live
 * preview (video element for webcam, an elapsed timer for audio), then hands the
 * resulting Blob to the parent to upload as an asset. Degrades with a friendly
 * message when getUserMedia is unavailable or permission is denied. (In-canvas
 * video rendering stays deferred; the clip is stored as a media asset.)
 */
function Recorder({ mode, disabled, onCapture }: {
  mode: "audio" | "video" | "screen";
  disabled?: boolean;
  onCapture: (blob: Blob, filename: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const supported =
    typeof navigator !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    (mode === "screen" ? !!navigator.mediaDevices?.getDisplayMedia : !!navigator.mediaDevices?.getUserMedia);

  const cleanup = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const start = useCallback(async () => {
    setError(null);
    if (!supported) { setError(tr("editor.recording_isnt_supported_in_this_browser")); return; }
    let stream: MediaStream;
    try {
      if (mode === "screen") {
        // Screen capture; system/tab audio comes along where the browser
        // offers it (the user picks in the share dialog).
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      } else {
        stream = await navigator.mediaDevices.getUserMedia(mode === "audio" ? { audio: true } : { audio: true, video: true });
      }
    } catch {
      setError(
        mode === "screen"
          ? tr("editor.screen_sharing_was_cancelled_or_blocked")
          : tr("editor.couldnt_access_your_microphone_camera_check"),
      );
      return;
    }
    streamRef.current = stream;
    // Stopping the share from the browser's own UI must also stop the recorder.
    if (mode === "screen") {
      stream.getVideoTracks()[0]?.addEventListener("ended", () => recorderRef.current?.stop());
    }
    if ((mode === "video" || mode === "screen") && videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.muted = true;
      void videoRef.current.play().catch(() => {});
    }
    const mimeType = pickMimeType(mode === "audio" ? "audio" : "video");
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch {
      setError(tr("editor.couldnt_start_recording_in_this_browser"));
      cleanup();
      return;
    }
    chunksRef.current = [];
    rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    rec.onstop = () => {
      const type = rec.mimeType || mimeType || (mode === "audio" ? "audio/webm" : "video/webm");
      const blob = new Blob(chunksRef.current, { type });
      const ext = type.includes("mp4") ? "mp4" : type.includes("ogg") ? "ogg" : "webm";
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      if (blob.size > 0) onCapture(blob, `${mode === "audio" ? "voice" : mode === "screen" ? "screen" : "webcam"}-${stamp}.${ext}`);
      cleanup();
      setRecording(false);
      setSeconds(0);
      setOpen(false);
    };
    recorderRef.current = rec;
    rec.start();
    setRecording(true);
    setSeconds(0);
    timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
  }, [supported, mode, cleanup, onCapture]);

  const stop = useCallback(() => {
    recorderRef.current?.stop();
  }, []);

  const Icon = mode === "audio" ? Mic : mode === "screen" ? MonitorUp : Video;
  const label = mode === "audio" ? tr("editor.record_voice") : mode === "screen" ? tr("editor.record_screen") : tr("editor.record_webcam");

  return (
    <div className="mt-2">
      {!open ? (
        <button onClick={() => setOpen(true)} disabled={disabled} className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-neutral-200 py-1.5 text-xs font-medium text-neutral-600 hover:border-brand-300 hover:text-brand-ink disabled:opacity-40">
          <Icon size={14} /> {label}
        </button>
      ) : (
        <div className="rounded-lg border border-neutral-200 p-2">
          <div className="mb-1.5 flex items-center justify-between text-xs font-medium text-neutral-700">
            <span className="flex items-center gap-1.5"><Icon size={14} /> {label}</span>
            {!recording && <button onClick={() => { cleanup(); setOpen(false); setError(null); }} className="text-neutral-400 hover:text-neutral-700"><X size={13} /></button>}
          </div>
          {(mode === "video" || mode === "screen") && (
            <video ref={videoRef} playsInline muted className="mb-2 aspect-video w-full rounded bg-neutral-900 object-cover" />
          )}
          {recording ? (
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1 text-xs tabular-nums text-red-600">
                <span className="h-2 w-2 animate-pulse rounded-full bg-red-600" />
                {String(Math.floor(seconds / 60)).padStart(2, "0")}:{String(seconds % 60).padStart(2, "0")}
              </span>
              <button onClick={stop} className="ms-auto flex items-center gap-1 rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700">
                <CircleStop size={14} /> {tr("editor.stop_and_save")}
              </button>
            </div>
          ) : (
            <Button block onClick={() => void start()} disabled={!supported}>
              <Icon size={14} /> {tr("editor.start_recording")}
            </Button>
          )}
          {error && <p className="mt-1.5 text-[11px] text-red-600">{error}</p>}
        </div>
      )}
    </div>
  );
}

// Inline tag editor + move-to-folder popover for a single upload.
function TagEditor({ asset, folders, onClose, onSetTags, onMove }: {
  asset: UploadedAsset;
  folders: AssetFolder[];
  onClose: () => void;
  onSetTags: (tags: string[]) => void;
  onMove: (folderId: string | null) => void;
}) {
  const [draft, setDraft] = useState("");
  function addTag() {
    const v = draft.trim();
    if (!v || asset.tags.some((t) => t.toLowerCase() === v.toLowerCase())) { setDraft(""); return; }
    onSetTags([...asset.tags, v]);
    setDraft("");
  }
  return (
    <div className="absolute inset-0 flex flex-col gap-1.5 bg-surface/97 p-2 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-neutral-700">{tr("editor.tags")}</span>
        <button onClick={onClose} className="grid h-5 w-5 place-items-center rounded text-neutral-400 hover:text-neutral-700"><X size={13} /></button>
      </div>
      <div className="flex flex-wrap gap-1">
        {asset.tags.map((t) => (
          <span key={t} className="flex items-center gap-0.5 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-700">
            {t}
            <button onClick={() => onSetTags(asset.tags.filter((x) => x !== t))} className="text-neutral-400 hover:text-red-600"><X size={10} /></button>
          </span>
        ))}
      </div>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }}
        placeholder={tr("editor.add_tag_enter")}
        className="w-full rounded border border-neutral-200 px-1.5 py-1 text-[11px] outline-none focus:border-brand-400"
      />
      <label className="mt-auto flex items-center gap-1 text-[10px] text-neutral-500">
        <ChevronLeft size={11} className={`rotate-180 ${mirrorInRtl}`} />
        <select
          value={asset.folderId ?? ""}
          onChange={(e) => onMove(e.target.value === "" ? null : e.target.value)}
          className="min-w-0 flex-1 rounded border border-neutral-200 px-1 py-0.5 text-[10px] outline-none"
        >
          <option value="">{tr("editor.no_folder")}</option>
          {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      </label>
    </div>
  );
}

function aiErr(e: unknown): string {
  if (e instanceof ApiError) {
    const coded = apiCodeMessage(e.body);
    if (coded) return coded;
    const detail = (e.body as { detail?: string } | undefined)?.detail;
    return detail ?? tr("editor.request_failed_status", { status: e.status });
  }
  // Translates a CodedError's code at this display boundary; a plain Error's
  // message passes through unchanged.
  return userMessage(e, tr("editor.ai_request_failed"));
}

// --- AI brand-voice grounding (F21 FR-6, FR-7) ----------------------------

/**
 * Build a brand-voice clause for an AI writing system prompt from the active
 * design's brand kit voice. Returns "" when there is no voice or it
 * carries no usable signal, so callers behave exactly as before when no brand
 * is assigned. Grounds generate + Magic Write so output matches the brand
 * (FR-6/FR-7, AC-5/AC-6). The voice shape is { tone[], doSay[], dontSay[] }.
 */
function brandVoiceClause(voice: BrandVoice | null | undefined): string {
  if (!voice) return "";
  const parts: string[] = [];
  const tone = voice.tone.filter((t) => t.trim());
  const dos = voice.doSay.filter((t) => t.trim());
  const donts = voice.dontSay.filter((t) => t.trim());
  if (tone.length) parts.push(`Tone: ${tone.join(", ")}.`);
  if (dos.length) parts.push(`Do: ${dos.join("; ")}.`);
  if (donts.length) parts.push(`Don't: ${donts.join("; ")}.`);
  if (!parts.length) return "";
  return `Write in this brand voice. ${parts.join(" ")}`;
}

/** The active brand voice's display tone label (for the "Using brand voice" hint). */
function brandVoiceLabel(voice: BrandVoice | null | undefined): string {
  const tone = voice?.tone.filter((t) => t.trim()) ?? [];
  return tone.length ? tone.join(", ") : "your brand";
}

/** Prefix a system prompt with the brand-voice clause when one is active. */
function withBrandVoice(system: string, clause: string): string {
  return clause ? `${clause} ${system}` : system;
}

/**
 * Quick tone presets (F21 FR-3): each rewrites the selected text node in that
 * tone via transform(), combined with the brand-voice clause when active so the
 * tone shift still respects the brand. Labels stay short for the 2-col grid.
 */
async function imageUrlToPngDataUrl(url: string): Promise<string> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new CodedError("errors.image_unreadable_cross_origin", "Couldn't read this image (it may block cross-origin access)."));
    img.src = url;
  });
  const w = img.naturalWidth || 1;
  const h = img.naturalHeight || 1;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new CodedError("errors.canvas_unavailable", "Canvas is unavailable in this browser.");
  ctx.drawImage(img, 0, 0);
  try {
    return canvas.toDataURL("image/png");
  } catch {
    throw new CodedError("errors.image_edit_cross_origin", "This image can't be edited because it's loaded cross-origin.");
  }
}

/** Extract a small dominant-color palette (hex) from an image URL for F39
 *  reference-image style transfer (FR-18). Samples at ~128px for speed; returns
 *  [] if the image can't be read (e.g. cross-origin). */
async function pollJob<R>(jobId: string, tries = 12): Promise<R> {
  for (let i = 0; i < tries; i++) {
    const job = await oc.getJob<R>(jobId);
    if (job.status === "completed") {
      if (job.result === undefined) throw new CodedError("errors.generation_failed", "job completed without a result");
      return job.result;
    }
    // A server-provided failure detail is shown as-is; only the generic
    // fallback carries a code for translation.
    if (job.status === "failed") throw job.error ? new Error(job.error) : new CodedError("errors.generation_failed", "generation failed");
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new CodedError("errors.generation_timed_out", "generation timed out");
}

// True only when the backend orchestration endpoint is genuinely absent (older
// server / not deployed), so callers fall back to the client free-text path
// ONLY then - and surface real provider/policy errors (403/502/...) instead of
// masking them behind a silent retry.
function endpointUnavailable(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 404 || e.status === 405 || e.status === 501);
}

// FR-33: cache validated outlines by request signature so re-planning the same
// brief (or regenerating around it) does not re-pay the model token cost. A
// "force fresh" re-plan bypasses it. Module-level so it survives panel remounts.

// --- Agentic assistant (F39 Phase 3) ---------------------------------------
// A conversational surface that decomposes a request into a validated plan of
// editor actions (the @hc/aistudio tool catalog) and executes them as ONE
// undoable turn. Tools map onto existing store mutators + @/lib/assist analyzers
// so every step is a normal, collaborative-safe edit (never raw scene JSON).

const ASSISTANT_CATALOG = toolCatalog();

// Design-creation is the primary intent: one-tap starters that prefill a brief
// the user completes (the assistant routes these to generateDesign).
const designTypes = (): { label: string; prompt: string }[] => [
  { label: tr("editor.poster"), prompt: "Create a professional poster about " },
  { label: tr("editor.presentation"), prompt: "Create a presentation deck about " },
  { label: tr("editor.social_post"), prompt: "Create a social media post about " },
  { label: tr("editor.document"), prompt: "Create a document about " },
];

// Secondary one-tap actions (edits on the current design), shown smaller.
const assistantSuggestions = () => [
  tr("editor.write_a_punchy_headline"),
  tr("editor.add_a_background_image"),
  tr("editor.turn_this_into_a_bar_chart"),
  tr("editor.critique_this_page"),
];

// Contextual follow-ups offered right after a design is generated, so the user
// can art-direct without retyping the brief.
const designFollowups = () => [tr("editor.try_another_style"), tr("editor.make_it_bolder"), tr("editor.make_it_more_minimal"), tr("editor.add_a_matching_image")];

interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  steps?: { action: string; ok: boolean }[];
}

// A generative step's pre-resolved result (text/image/outline), produced by the
// async resolve pass and consumed by the synchronous apply pass so the whole
// plan still collapses into one undo turn.
type ResolvedPayload =
  | { kind: "text"; text: string; targetId?: string }
  | { kind: "image"; image: string; targetId?: string }
  | { kind: "bgimage"; image: string }
  | { kind: "decktexts"; entries: DeckTextEntry[] }
  | { kind: "notes"; notes: string[] }
  | { kind: "diagram"; spec: DiagramSpec }
  | { kind: "clusters"; clusters: { title: string; ids: string[] }[] }
  | { kind: "summary"; text: string }
  | { kind: "outline"; outline: DesignOutline; size: { width: number; height: number }; brandPalette: string[]; brandFonts: { heading?: string; body?: string }; heroPlans: { pageIndex: number; prompt: string; subject: string; size: string }[]; workspaceId: string; designId: string | null; append: boolean }
  | { kind: "layoutDeck"; deckTitle: string; pages: { layoutId: string; name: string; note?: string; fill: LayoutFill }[]; background: unknown; imageSize: string; size: { width: number; height: number }; brandPalette: string[]; brandFonts: { heading?: string; body?: string }; heroPlans: { pageIndex: number; prompt: string; subject: string }[]; generateAllowed: boolean; workspaceId: string; designId: string | null; append: boolean }
  | { kind: "splitSlide"; pageIndex: number; pageId: string; halves: { layoutId: string; name: string; fill: LayoutFill }[] }
  | { kind: "insertComparison"; layoutId: string; name: string; fill: LayoutFill; afterIndex: number; afterPageId: string }
  | { kind: "regenerateSlide"; pageIndex: number; pageId: string; layoutId: string; layoutChanged: boolean; hadLayout: boolean; fill: LayoutFill; imageTasks: { placeholderId: string; prompt: string; subject: string }[]; imageSize: string; generateAllowed: boolean; workspaceId: string; designId: string | null };

/** Parse a model reply that must be a JSON array of exactly `n` strings.
 *  Tolerates markdown fences; anything else (wrong shape, wrong length,
 *  non-string entries) returns null so the caller surfaces a clean error
 *  instead of applying garbage to the document. */
function parseStringArray(reply: string, n: number): string[] | null {
  const cleaned = reply.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (!Array.isArray(parsed) || parsed.length !== n) return null;
    if (!parsed.every((s) => typeof s === "string")) return null;
    return parsed as string[];
  } catch {
    return null;
  }
}

interface AssistantDeps {
  workspaceId: string;
  voiceClause: string;
  brandPalette: string[];
  brandFonts: { heading?: string; body?: string };
  imageCapable: boolean;
  /** Whether the provider supports image EDITING (some generate but cannot edit). */
  editImageCapable: boolean;
  /** A user-reviewed outline for the pending generateDesign step: when set, the
   *  resolve uses it directly instead of fetching one (T09 review flow). */
  reviewedOutline?: DesignOutline;
  /** Generation dials chosen in the review UI, woven into the outline brief. */
  dials?: GenerationDials;
  /** The open design's id, stamped onto queued image resolutions (T10). */
  designId?: string | null;
  /** Attached source content (doc 28 FR-23 doc/URL/file-to-deck ingestion):
   *  generateDesign grounds its outline strictly in this text when present. */
  sourceText?: string;
  sourceName?: string;
}

// Outline roles that get a generated hero background image (the high-impact
// pages). Content/agenda/data pages stay on clean themed backgrounds so dense
// text never sits on a busy photo.
const HERO_ROLES = new Set(["cover", "quote", "closing"]);
const MAX_HERO_IMAGES = 6;

/** Flatten a text node's runs into a plain string. */
function textContentOf(node: unknown): string {
  return ((node as { content?: { runs: { text: string }[] }[] }).content ?? [])
    .map((p) => p.runs.map((r) => r.text).join("")).join("\n").trim();
}

/** The representative solid color of a page background fill (gradient -> first
 *  stop), or null when it isn't a color fill we can reason about. */
function bgSolidColor(bg: unknown): Color | null {
  const f = bg as { type?: string; color?: Color; stops?: { color: Color }[] } | undefined;
  if (!f) return null;
  if (f.type === "solid" && f.color) return f.color;
  if (f.type === "gradient" && f.stops?.length) return f.stops[0].color;
  return null;
}

/** Whether a page's background reads as dark, so AI-added text should be light
 *  to stay legible. Judged from the background fill's luminance (gradient -> its
 *  first stop). Near-black default text is invisible on the dark posters the
 *  generator makes (a saturated theme color such as deep blue), which is why AI
 *  titles seemed to "not appear"; on those we switch to white. We only flip on
 *  positive evidence of a dark background (never a guess about an image), so a
 *  page over a light photo keeps the readable near-black default. */
function pageIsDark(page: unknown): boolean {
  const c = bgSolidColor((page as { background?: unknown } | undefined)?.background);
  return c ? relativeLuminance(c) < 0.4 : false;
}

/** Map a free-form design-type hint to a known DesignType (defaults to deck). */
function normalizeDesignType(v: unknown): DesignType {
  const s = String(v ?? "").toLowerCase();
  if (/poster|flyer/.test(s)) return "poster";
  if (/doc|document|report|article|paper/.test(s)) return "doc";
  if (/social|post|instagram|story|reel|feed/.test(s)) return "social-set";
  return "deck";
}

/** Resolve a design outline for generateDesign: prefer the server job (per-page
 *  copy polish), fall back to the sync outline endpoint; real provider/policy
 *  errors surface, a missing endpoint degrades to null. */
async function fetchAssistantOutline(workspaceId: string, dt: DesignType, prompt: string, brandClause: string, pageCount?: number): Promise<DesignOutline | null> {
  try {
    const { jobId } = await oc.aiGenerateDesign({ workspaceId, designType: dt, prompt, brandClause, pageCount });
    return normalizeOutline(await pollJob<unknown>(jobId));
  } catch (e) {
    // pollJob throws plain Errors on a failed / empty / timed-out job - real
    // failures that must surface, not be silently re-run on the sync path. Only a
    // genuinely missing endpoint degrades to the synchronous outline fallback.
    if (!endpointUnavailable(e)) throw e;
    try {
      return normalizeOutline(await oc.aiOutline({ workspaceId, designType: dt, prompt, brandClause, pageCount }));
    } catch (e2) {
      if (e2 instanceof ApiError && !endpointUnavailable(e2)) throw e2;
      return null;
    }
  }
}

/** Derive the generateDesign request pieces (type, size, brief with source
 *  grounding and dials, brand clause, page count) so the review fetch and the
 *  resolve path build IDENTICAL outline requests. */
function prepareGenerateBrief(a: Record<string, unknown>, deps: AssistantDeps): {
  dt: DesignType; size: { width: number; height: number }; brief: string; brandClause: string; pageCount?: number;
} {
  const st = useEditor.getState();
  const dt = a.designType != null && String(a.designType).trim()
    ? normalizeDesignType(a.designType)
    : normalizeDesignType(a.prompt);
  const page = st.doc.pages[st.activePage];
  const size = { width: page?.width ?? 1280, height: page?.height ?? 720 };
  const brandClause = [deps.voiceClause, deps.brandPalette.length ? `Use this brand palette: ${deps.brandPalette.join(", ")}.` : ""].filter(Boolean).join(" ").trim();
  const pageCount = typeof a.pageCount === "number" ? a.pageCount : dt === "poster" ? 1 : undefined;
  let brief = String(a.prompt);
  const dials = dialsClause(deps.dials);
  if (dials) brief = `${brief}\n\n${dials}`;
  if (deps.sourceText) {
    brief = `${brief}\n\nGround every page STRICTLY in this source content ("${deps.sourceName ?? "attached document"}"): keep its structure, facts, and key points, and do not invent material that is not in it. ${untrustedSourceRule("the source content")}\n--- SOURCE START ---\n${deps.sourceText.slice(0, 24000)}\n--- SOURCE END ---`;
  }
  return { dt, size, brief, brandClause, pageCount };
}

/** A page's display title for narrative ops: the title-placeholder box's text
 *  first, else the longest text node's first line/sentence, else the page
 *  name (the reference fallback chain, adapted to the scene graph). */
function pageTitleOf(page: { name?: string; children: unknown[] }): string {
  type Textish = { type: string; data?: { placeholderId?: string }; content?: { runs: { text: string }[] }[] };
  const texts = (page.children as Textish[]).filter((n) => n.type === "text" && n.content?.length);
  const flat = (n: Textish) => (n.content ?? []).map((p) => p.runs.map((r) => r.text).join("")).join("\n");
  const titleBox = texts.find((n) => n.data?.placeholderId?.includes("title"));
  const candidate = titleBox ? flat(titleBox) : texts.map(flat).sort((a, b) => b.length - a.length)[0] ?? "";
  const extracted = extractTitleFromText(candidate);
  return extracted !== "Slide" ? extracted : (page.name || tr("editor.slide"));
}

/** Whether the deck opens on a title slide (drives agenda insertion position).
 *  A linked layout decides by its slot signature (title-ish = no content
 *  slot); otherwise a heuristic: few text nodes and nothing data-heavy - a
 *  freeform cover is typically a hero background plus 2-3 text blocks. */
function hasTitleSlide(doc: { layouts?: SlideLayout[]; pages: { layoutId?: string; children: unknown[] }[] }): boolean {
  const first = doc.pages[0];
  if (!first) return false;
  if (first.layoutId) {
    const layout = doc.layouts?.find((l) => l.id === first.layoutId);
    // Cover-ish = a title slot and NO substantive slots (a picture-with-caption
    // or content layout is a real slide, not a cover).
    if (layout) {
      const roles = new Set((layout.placeholders ?? []).map((ph) => ph.role));
      return roles.has("title") && !roles.has("content") && !roles.has("picture") && !roles.has("chart");
    }
  }
  type Typed = { type: string };
  const texts = (first.children as Typed[]).filter((n) => n.type === "text").length;
  const heavy = (first.children as Typed[]).some((n) => n.type === "chart" || n.type === "table");
  // A freeform cover is a hero image plus a few text blocks, or (hand-built /
  // imported) an image-only splash: both count.
  return !heavy && texts <= 3 && (texts > 0 || first.children.length <= 2);
}

/** The frame aspect and matching provider size string for a page: ONE ladder
 *  (1.2 threshold) shared by every image-planning site, so a tuning change
 *  cannot leave a drifted copy behind. */
function aspectAndImageSize(size: { width: number; height: number }): { aspect: "landscape" | "portrait" | "square"; imageSize: string } {
  const aspect = size.width >= size.height * 1.2 ? "landscape" : size.height >= size.width * 1.2 ? "portrait" : "square";
  return { aspect, imageSize: aspect === "landscape" ? "1792x1024" : aspect === "portrait" ? "1024x1792" : "1024x1024" };
}

/** Per-slot style overrides for a layout's text slots: the brand fonts by
 *  role, and an ink readable against the EFFECTIVE background (the layout's,
 *  else its master's, else the page's) - the materialized defaults are dark
 *  and would vanish on a dark theme. */
function slotStylesFor(
  layout: SlideLayout | undefined,
  brandFonts: { heading?: string; body?: string } | undefined,
  background: unknown,
): Record<string, { fontFamily?: string; fill?: Fill }> {
  // One darkness judgment for the whole file: pageIsDark's threshold and
  // bgSolidColor's fill handling (a drifted local copy split light/dark at a
  // different luminance than writeText and friends).
  const dark = pageIsDark({ background });
  const ink: Fill = { type: "solid", color: dark ? { srgb: { r: 0.97, g: 0.97, b: 0.97, a: 1 } } : { srgb: { r: 0.12, g: 0.14, b: 0.18, a: 1 } } };
  const out: Record<string, { fontFamily?: string; fill?: Fill }> = {};
  for (const ph of layout?.placeholders ?? []) {
    if (ph.role !== "title" && ph.role !== "body" && ph.role !== "content") continue;
    const fontFamily = ph.role === "title" ? brandFonts?.heading : brandFonts?.body;
    out[ph.id] = { ...(fontFamily ? { fontFamily } : {}), fill: ink };
  }
  return out;
}

/** True when the document already holds work worth protecting: more than one
 *  page, or any page with content on it. */
function docHasContent(doc: { pages: { children: unknown[] }[] }): boolean {
  return doc.pages.length > 1 || doc.pages.some((p) => p.children.length > 0);
}

/** How many existing pages a pending plan would destroy: non-zero only when a
 *  generateDesign step explicitly carries mode:"replace" on a document with
 *  content (the executor never replaces otherwise). Drives the confirmation
 *  gate's "replaces all N pages" warning. */
function planReplacePageCount(plan: PlanStep[], doc: { pages: { children: unknown[] }[] }): number {
  if (!docHasContent(doc)) return 0;
  const replaces = plan.some((s) => s.action === "generateDesign" && String(s.args?.mode ?? "").toLowerCase() === "replace");
  return replaces ? doc.pages.length : 0;
}

// Async resolve pass for one plan step: performs any AI/network work BEFORE the
// synchronous undo turn (mirrors the applyBrand brand-lint prefetch). Pure-sync
// actions return {} and are applied directly by runPlanStep. A precondition that
// can't be met (no selection, empty text) returns {error} so the step is skipped
// with a reason; genuine provider/policy errors throw and surface to the caller.
async function resolvePlanStep(step: PlanStep, deps: AssistantDeps): Promise<{ payload?: ResolvedPayload; error?: string }> {
  const a = step.args;
  const st = useEditor.getState();
  switch (step.action) {
    case "writeText": {
      // i18n-ignore: model system prompt, never translated.
      const system = [
        "You write copy that goes directly into a single design text box.",
        "Return ONLY the final text, ready to display: no preamble, no explanation, no markdown, no surrounding quotes, and no list of alternatives - pick the single best option.",
        "Match the length to the request: a headline or tagline is a few words; a label is 1-3 words; body copy is one to three short sentences.",
        deps.voiceClause,
      ].filter(Boolean).join(" ");
      const { text } = await oc.aiText({ workspaceId: deps.workspaceId, prompt: String(a.prompt), system });
      if (!text.trim()) return { error: "no text returned" };
      const sel = st.selection[0];
      const node = sel ? locate(st.doc, sel)?.node : null;
      return { payload: { kind: "text", text: text.trim(), targetId: node?.type === "text" ? sel : undefined } };
    }
    case "rewriteSelectedText": {
      const sel = st.selection[0];
      const node = sel ? locate(st.doc, sel)?.node : null;
      if (!node || node.type !== "text") return { error: "select a text box first" };
      const current = textContentOf(node);
      if (!current) return { error: "that text box is empty" };
      const system = `${withBrandVoice(String(a.instruction), deps.voiceClause)} Return only the resulting text, with no preamble or quotes.`;
      const { text } = await oc.aiText({ workspaceId: deps.workspaceId, prompt: current, system });
      if (!text.trim()) return { error: "no text returned" };
      return { payload: { kind: "text", text: text.trim(), targetId: sel } };
    }
    case "translateDeck": {
      const language = String(a.language ?? "").trim();
      if (!language) return { error: "which language?" };
      const entries = st.collectDeckTexts();
      if (!entries.length) return { error: "there's no text to translate" };
      // Translate as ordered JSON string arrays in bounded batches: order and
      // length are the contract, so each string maps back to its collected
      // address (text run / sticky / notes) and styling is untouched.
      const translated: string[] = [];
      const BATCH = 60;
      for (let i = 0; i < entries.length; i += BATCH) {
        const batch = entries.slice(i, i + BATCH).map((e) => e.text);
        // i18n-ignore: model system prompt, never translated.
      const system = [
          `You are a professional translator. Translate every string in the user's JSON array into ${language}.`,
          "The strings are labels and copy on a designed layout: keep meaning and tone, and keep each translation close to the original's length.",
          "Preserve numbers, URLs, emails, emoji, and proper nouns. Never merge, split, reorder, drop, or add entries.",
          "Return ONLY a JSON array of strings with exactly the same length and order as the input. No prose, no markdown fences.",
        ].join(" ");
        const { text } = await oc.aiText({ workspaceId: deps.workspaceId, prompt: JSON.stringify(batch), system });
        const parsed = parseStringArray(text, batch.length);
        if (!parsed) return { error: "the translation came back malformed - try again" };
        translated.push(...parsed);
      }
      return { payload: { kind: "decktexts", entries: entries.map((e, i) => ({ ref: e.ref, text: translated[i] })) } };
    }
    case "generateSpeakerNotes": {
      const pages = st.doc.pages;
      if (!pages.length) return { error: "there are no slides yet" };
      // One compact text summary per slide (what's visibly on it), capped so a
      // dense deck stays inside a single prompt.
      const entries = st.collectDeckTexts();
      const perPage = new Map<number, string[]>();
      const pageIndexByNode = new Map<string, number>();
      pages.forEach((pg, i) => {
        const walk = (ns: { id?: string; children?: unknown[] }[]) => {
          for (const n of ns) {
            if (typeof n.id === "string") pageIndexByNode.set(n.id, i);
            if (Array.isArray(n.children) && n.children.length) walk(n.children as { id?: string; children?: unknown[] }[]);
          }
        };
        walk(pg.children as { id?: string; children?: unknown[] }[]);
      });
      for (const e of entries) {
        if (e.ref.kind === "notes") continue; // existing notes are being replaced
        const idx = e.ref.kind === "run" || e.ref.kind === "sticky" ? (pageIndexByNode.get(e.ref.nodeId) ?? -1) : -1;
        if (idx < 0) continue;
        const list = perPage.get(idx) ?? [];
        if (list.join(" ").length < 800) list.push(e.text);
        perPage.set(idx, list);
      }
      const summaries = pages.map((_, i) => (perPage.get(i) ?? []).join(" · ") || "(a visual slide with no text)");
      const guidance = String(a.instruction ?? "").trim();
      const notes: string[] = [];
      const BATCH = 20;
      for (let i = 0; i < summaries.length; i += BATCH) {
        const batch = summaries.slice(i, i + BATCH);
        // i18n-ignore: model system prompt, never translated.
      const system = [
          "You write speaker notes a presenter reads while showing each slide.",
          "For each slide summary in the user's JSON array, write natural spoken-style notes: 2-4 short sentences that add context and delivery cues beyond what the slide already says. Do not simply restate the slide text.",
          guidance ? `Extra guidance from the presenter: ${guidance}.` : "",
          deps.voiceClause,
          "Return ONLY a JSON array of strings with exactly the same length and order as the input. No prose, no markdown fences.",
        ].filter(Boolean).join(" ");
        const { text } = await oc.aiText({ workspaceId: deps.workspaceId, prompt: JSON.stringify(batch), system });
        const parsed = parseStringArray(text, batch.length);
        if (!parsed) return { error: "the notes came back malformed - try again" };
        notes.push(...parsed);
      }
      return { payload: { kind: "notes", notes } };
    }
    case "generateDiagram": {
      const prompt = String(a.prompt ?? "").trim();
      if (!prompt) return { error: "what should the diagram show?" };
      // Pasted Mermaid source imports directly - no AI round-trip (doc 30
      // diagram-as-code). Anything else asks the model for a spec.
      const direct = mermaidToDiagram(prompt);
      if (direct) return { payload: { kind: "diagram", spec: direct } };
      const kind = String(a.kind ?? "").toLowerCase() === "mindmap" ? "mindmap" : "flowchart";
      // i18n-ignore: model system prompt, never translated.
      const system = [
        `You design ${kind === "mindmap" ? "mind maps" : "flowcharts"}. From the user's description, return ONLY a JSON object:`,
        `{"kind":"${kind}","nodes":[{"id":"a","label":tr("editor.short_label")}],"edges":[{"from":"a","to":"b","label":"optional"}]}`,
        kind === "mindmap"
          ? "The FIRST node is the central topic; edges go parent to child, forming a tree."
          : "Order nodes roughly in flow order; edges follow the process direction; label branch edges (yes/no, pass/fail).",
        "6-25 nodes, short labels (2-6 words). No prose, no markdown fences.",
      ].join(" ");
      const { text } = await oc.aiText({ workspaceId: deps.workspaceId, prompt, system });
      const spec = normalizeDiagramSpec(parseModelJson(text));
      if (!spec) return { error: "the diagram came back malformed - try again" };
      spec.kind = kind;
      return { payload: { kind: "diagram", spec } };
    }
    case "clusterStickies": {
      const stickies = st.collectBoardStickies();
      if (stickies.length < 3) return { error: "add at least 3 sticky notes to cluster" };
      const guidance = String(a.instruction ?? "").trim();
      // i18n-ignore: model system prompt, never translated.
      const system = [
        "You run affinity clustering on brainstorm sticky notes. Group the user's JSON array of {id,text} into 2-8 coherent themes.",
        guidance ? `Clustering guidance: ${guidance}.` : "",
        'Return ONLY a JSON array like [{"title":tr("editor.theme_name"),"ids":["id1","id2"]}]. Every sticky id appears in exactly one theme. Short, specific titles. No prose, no markdown fences.',
      ].filter(Boolean).join(" ");
      const { text } = await oc.aiText({ workspaceId: deps.workspaceId, prompt: JSON.stringify(stickies), system });
      const parsed = parseModelJson(text);
      if (!Array.isArray(parsed)) return { error: "the clustering came back malformed - try again" };
      const known = new Set(stickies.map((sk) => sk.id));
      const clusters = parsed
        .map((c) => {
          const o = c as { title?: unknown; ids?: unknown };
          const ids = Array.isArray(o.ids) ? o.ids.filter((i): i is string => typeof i === "string" && known.has(i)) : [];
          return { title: typeof o.title === "string" ? o.title : tr("editor.theme"), ids };
        })
        .filter((c) => c.ids.length > 0);
      if (!clusters.length) return { error: "no usable clusters came back - try again" };
      return { payload: { kind: "clusters", clusters } };
    }
    case "summarizeStickies": {
      const stickies = st.collectBoardStickies();
      if (!stickies.length) return { error: "there are no sticky notes to summarize" };
      // i18n-ignore: model system prompt, never translated.
      const system = [
        "You summarize a brainstorm board's sticky notes.",
        "Write a concise summary: 2-4 key themes as short lines, then decisions and action items if any are implied.",
        "Plain text with line breaks; no markdown syntax.",
        deps.voiceClause,
      ].filter(Boolean).join(" ");
      const { text } = await oc.aiText({ workspaceId: deps.workspaceId, prompt: stickies.map((sk) => `- ${sk.text}`).join("\n"), system });
      if (!text.trim()) return { error: "no summary returned" };
      return { payload: { kind: "summary", text: text.trim() } };
    }
    case "generateImage": {
      if (!deps.imageCapable) return { error: "this provider can't generate images - connect an image-capable provider (e.g. OpenAI)" };
      const logo = String(a.style ?? "").toLowerCase().includes("logo");
      const prompt = logo
        ? `A clean, modern, flat vector-style logo for: ${String(a.prompt)}. Centered, simple, bold shapes, solid background, no text or lettering unless explicitly requested.`
        : groundImagePrompt(`${String(a.prompt)}. Well-composed, high detail, professional quality.`, { palette: deps.brandPalette, aspect: "square" });
      const { image } = await oc.aiImage({ workspaceId: deps.workspaceId, prompt, size: "1024x1024" });
      if (!image) return { error: "no image returned" };
      return { payload: { kind: "image", image } };
    }
    case "generateBackgroundImage": {
      if (!deps.imageCapable) return { error: "this provider can't generate images - connect an image-capable provider (e.g. OpenAI)" };
      const prompt = groundImagePrompt(`${String(a.prompt)}. A full-bleed background image, subtle and uncluttered so text stays readable on top.`, { palette: deps.brandPalette, aspect: "landscape" });
      const { image } = await oc.aiImage({ workspaceId: deps.workspaceId, prompt, size: "1792x1024" });
      if (!image) return { error: "no image returned" };
      return { payload: { kind: "bgimage", image } };
    }
    case "editSelectedImage": {
      if (!deps.editImageCapable) return { error: "this provider can't edit images - connect a provider with image editing (e.g. OpenAI)" };
      const sel = st.selection[0];
      const node = sel ? locate(st.doc, sel)?.node : null;
      if (!node || node.type !== "image") return { error: "select an image first" };
      // An ImageNode carries source.assetId; the actual URL lives on the asset table.
      const assetId = (node as { source?: { assetId?: string } }).source?.assetId;
      const ref = assetId ? st.doc.assets.find((aRef) => aRef.id === assetId) : undefined;
      const url = ref?.url ? resolveAssetUrl(ref.url) : null;
      if (!url) return { error: "that image has no source" };
      const imageBase64 = await imageUrlToPngDataUrl(url);
      const { image } = await oc.aiEditImage({ workspaceId: deps.workspaceId, imageBase64, prompt: String(a.instruction) });
      if (!image) return { error: "no image returned" };
      return { payload: { kind: "image", image, targetId: sel } };
    }
    case "regenerateSlide": {
      // T14: slide-scoped context in, one optional relayout decision, one fill
      // against the (possibly new) layout's schema, and an image diff so only
      // CHANGED prompts regenerate. Node ids stay put: the fill mutates the
      // existing placeholder boxes and a relayout only adds missing slots.
      const idx = Math.round(Number(a.pageIndex)) - 1; // the tool speaks 1-based
      const page = st.doc.pages[idx] as unknown as { id: string; name?: string; layoutId?: string; width: number; height: number; children: unknown[] } | undefined;
      if (!page) return { error: "that page doesn't exist" };
      const instruction = String(a.instruction ?? "").trim();
      if (!instruction) return { error: "an instruction is needed" };
      // Read-only planning: the resolve phase must not mutate the document
      // (ensureSlideLayouts runs inside the APPLY turn); built-ins here only
      // shape the schemas, and their ids match what the apply installs.
      const docLayouts = (st.doc as unknown as { layouts?: SlideLayout[] }).layouts;
      const layouts = docLayouts?.length ? docLayouts : builtinMasterAndLayouts({ width: page.width, height: page.height }).layouts;
      type Slotted = { type: string; data?: { placeholderId?: string; aiImagePrompt?: string }; content?: { runs: { text: string }[] }[] };
      const slotted = (page.children as Slotted[]).filter((n) => n.data?.placeholderId);
      // A slide with no placeholder boxes (freeform/pre-layout generation) has
      // nothing this tool can rewrite in place: refuse cleanly instead of
      // stacking new boxes over the existing content.
      if (!slotted.length) return { error: "this slide isn't layout-linked - regenerate the deck to enable per-slide regeneration" };
      const currentTexts = slotted
        .filter((n) => n.type === "text" && n.content?.length)
        .map((n) => `${n.data!.placeholderId}: ${(n.content ?? []).map((par) => par.runs.map((r) => r.text).join("")).join(" / ")}`)
        .join("\n");
      const currentImagePrompts: Record<string, string> = {};
      for (const n of slotted) {
        if (n.type === "image" && n.data?.aiImagePrompt && n.data.placeholderId) currentImagePrompts[n.data.placeholderId] = n.data.aiImagePrompt;
      }
      // Relayout only when the instruction warrants it; keep on any failure.
      let layoutId = page.layoutId && layouts.some((l) => l.id === page.layoutId) ? page.layoutId : preferredLayoutFor("content", layouts);
      try {
        const { text } = await oc.aiTextStructured({
          workspaceId: deps.workspaceId,
          system: relayoutDecisionSystemPrompt(layouts),
          prompt: `Current layout: ${layoutId}\nInstruction: ${instruction}\nSlide content:\n${currentTexts.slice(0, 2000)}`,
          schema: relayoutDecisionSchema(layouts.map((l) => l.id)),
        });
        const decision = parseModelJson(text) as { relayout?: boolean; layoutId?: string } | null;
        if (decision?.relayout && typeof decision.layoutId === "string" && layouts.some((l) => l.id === decision.layoutId)) {
          layoutId = decision.layoutId;
        }
      } catch {
        // keep the current layout
      }
      const layout = layouts.find((l) => l.id === layoutId)!;
      const schema = deriveLayoutContentSchema(layout);
      let fill: LayoutFill | null = null;
      try {
        const { text } = await oc.aiTextStructured({
          workspaceId: deps.workspaceId,
          system: regenerateFillSystemPrompt(schema, deps.voiceClause),
          prompt: `Slide ${idx + 1} (${pageTitleOf(page)})\nInstruction: ${instruction}\nCurrent content by slot:\n${currentTexts.slice(0, 4000) || "(empty)"}`,
          schema,
        });
        const norm = normalizeLayoutFill(layout, parseModelJson(text));
        if (Object.keys(norm.texts).length + Object.keys(norm.lists).length > 0) fill = norm;
      } catch {
        fill = null;
      }
      if (!fill) return { error: "couldn't regenerate that slide" };
      // Image diff: only changed prompts regenerate; unchanged images stay.
      // (Text-only providers keep their tasks: the queue's reuse and stock
      // steps need no image provider, and a miss skips quietly.)
      const changed = changedImagePrompts(currentImagePrompts, fill.imagePrompts);
      const { aspect, imageSize } = aspectAndImageSize(page);
      return {
        payload: {
          kind: "regenerateSlide",
          pageIndex: idx,
          pageId: page.id,
          layoutId,
          layoutChanged: layoutId !== page.layoutId,
          hadLayout: !!page.layoutId,
          fill,
          imageTasks: Object.entries(changed).map(([placeholderId, prompt]) => ({ placeholderId, prompt: groundImagePrompt(prompt, { palette: deps.brandPalette, aspect }), subject: prompt })),
          imageSize,
          generateAllowed: deps.imageCapable,
          workspaceId: deps.workspaceId,
          designId: deps.designId ?? null,
        },
      };
    }
    case "splitSlide": {
      // One structured call splits the page's content into two outline items;
      // the two replacement pages fill deterministically from those items.
      const idx = Math.round(Number(a.pageIndex)) - 1; // the tool speaks 1-based
      const page = st.doc.pages[idx] as unknown as { id: string; name?: string; width: number; height: number; children: unknown[] } | undefined;
      if (!page) return { error: "that page doesn't exist" };
      // Read-only planning: layouts are only consulted here; the apply turn
      // installs the built-ins when the document has none (same ids).
      const docLayouts = (st.doc as unknown as { layouts?: SlideLayout[] }).layouts;
      const layouts = docLayouts?.length ? docLayouts : builtinMasterAndLayouts({ width: page.width, height: page.height }).layouts;
      type Textish = { type: string; content?: { runs: { text: string }[] }[] };
      const pageText = (page.children as Textish[])
        .filter((n) => n.type === "text" && n.content?.length)
        .map((n) => (n.content ?? []).map((p) => p.runs.map((r) => r.text).join("")).join("\n"))
        .join("\n");
      type SplitHalf = { title?: string; points?: string[] };
      let parsed: { a?: SplitHalf; b?: SplitHalf } | null = null;
      try {
        const { text } = await oc.aiTextStructured({
          workspaceId: deps.workspaceId,
          system: splitSlideSystemPrompt(),
          prompt: `Slide title: ${pageTitleOf(page)}\nSlide text:\n${pageText.slice(0, 4000)}`,
          schema: splitSlideSchema(),
        });
        parsed = parseModelJson(text) as { a?: SplitHalf; b?: SplitHalf } | null;
      } catch {
        parsed = null;
      }
      if (!parsed?.a?.title || !parsed?.b?.title) return { error: "couldn't split that slide" };
      const halves = [parsed.a, parsed.b].map((half) => {
        const item: OutlineItem = { id: "split", title: String(half.title), points: (half.points ?? []).map(String).filter(Boolean), visualRole: "content" };
        const layoutId = preferredLayoutFor("content", layouts);
        const layout = layouts.find((l) => l.id === layoutId)!;
        return { layoutId, name: item.title, fill: fallbackLayoutFill(layout, item) };
      });
      return { payload: { kind: "splitSlide", pageIndex: idx, pageId: page.id, halves } };
    }
    case "insertComparison": {
      // Read-only planning: the apply turn installs built-ins when needed.
      const activePage = st.doc.pages[st.activePage] as unknown as { width: number; height: number } | undefined;
      const docLayouts = (st.doc as unknown as { layouts?: SlideLayout[] }).layouts;
      const layouts = docLayouts?.length ? docLayouts : builtinMasterAndLayouts(activePage ?? { width: 1920, height: 1080 }).layouts;
      const layout = layouts.find((l) => l.id === "layout-comparison")
        ?? layouts.find((l) => (l.placeholders ?? []).filter((p) => p.role === "content").length >= 2);
      if (!layout) return { error: "no comparison layout available" };
      const topicA = String(a.topicA ?? "").trim();
      const topicB = String(a.topicB ?? "").trim();
      if (!topicA || !topicB) return { error: "both topics are needed" };
      const schema = deriveLayoutContentSchema(layout);
      let fill: LayoutFill | null = null;
      try {
        const { text } = await oc.aiTextStructured({
          workspaceId: deps.workspaceId,
          system: layoutFillSystemPrompt(schema, deps.voiceClause),
          prompt: `Write a side-by-side comparison slide of "${topicA}" versus "${topicB}": a heading naming both, one column of concrete points per topic (left = ${topicA}, right = ${topicB}).`,
          schema,
        });
        const norm = normalizeLayoutFill(layout, parseModelJson(text));
        if (Object.keys(norm.texts).length + Object.keys(norm.lists).length > 0) fill = norm;
      } catch {
        fill = null;
      }
      if (!fill) {
        fill = fallbackLayoutFill(layout, { id: "cmp", title: `${topicA} vs ${topicB}`, points: [topicA, topicB], visualRole: "comparison" });
      }
      const after = typeof a.afterPageIndex === "number" ? Math.round(a.afterPageIndex) - 1 : st.activePage;
      const afterIndex = Math.max(0, Math.min(after, st.doc.pages.length - 1));
      const afterPageId = (st.doc.pages[afterIndex] as unknown as { id: string }).id;
      return { payload: { kind: "insertComparison", layoutId: layout.id, name: `${topicA} vs ${topicB}`, fill, afterIndex, afterPageId } };
    }
    case "generateDesign": {
      // The explicit designType wins when the model supplies one; otherwise the
      // brief infers it ("make a poster" maps to a single-page poster even when
      // the model omits designType). The brief builder is shared with the T09
      // review fetch so both paths request the identical outline.
      const { dt, size, brief, brandClause, pageCount } = prepareGenerateBrief(a, deps);
      // Replacement is destructive and never the silent default: on a document
      // that already has content (more than one page, or any non-empty page) the
      // generated pages APPEND unless the plan step explicitly carries
      // mode:"replace" - which the confirmation gate has warned about ("replaces
      // all N pages"). A fresh empty document keeps the replace default so
      // generation fills it in place.
      const requestedMode = String(a.mode ?? "").toLowerCase();
      const append = docHasContent(st.doc) ? requestedMode !== "replace" : requestedMode === "append";
      // A user-reviewed outline (T09) is final: use it directly instead of a
      // second model call. Otherwise fetch one as before.
      const reviewed = deps.reviewedOutline;
      if (reviewed) deps.reviewedOutline = undefined; // consumed once: later steps fetch their own
      const outline = reviewed
        ? structuredClone(reviewed)
        : await fetchAssistantOutline(deps.workspaceId, dt, brief, brandClause, pageCount);
      if (!outline || !outline.pages.length) return { error: "couldn't plan that design" };
      // Defensive page cap (the server caps too, but the sync-fallback outline
      // and a non-compliant model can still over-produce): a poster is exactly
      // one page, and an explicit pageCount is a hard ceiling. This also bounds
      // the hero-image pass below so a single poster gets at most one image.
      // A REVIEWED outline is exempt: it guards against model over-production,
      // and pages the user explicitly added in the review card are intentional
      // (the review path already caps at maxOutlinePages via sanitize).
      if (!reviewed) {
        if (dt === "poster" && outline.pages.length > 1) {
          const cover = outline.pages.find((p) => p.visualRole === "cover");
          outline.pages = [cover ?? outline.pages[0]];
        } else if (typeof pageCount === "number" && pageCount > 0 && outline.pages.length > pageCount) {
          outline.pages = outline.pages.slice(0, pageCount);
        }
      }
      // T12 layout-grounded generation: when the document has slide layouts
      // (built-ins are installed on first use), one structured call assigns a
      // layout per page (repaired deterministically) and one per page fills the
      // layout's derived content schema; picture slots route through the T10
      // image queue. A per-page failure degrades to the deterministic fill from
      // the outline item, never an aborted deck. Falls through to the freeform
      // engine only when layout grounding is impossible.
      {
        const docLayouts = (st.doc as unknown as { layouts?: SlideLayout[] }).layouts;
        const layouts = docLayouts?.length ? docLayouts : builtinMasterAndLayouts(size).layouts;
        // Picture slots stay available on text-only providers: the image queue
        // still resolves them via asset reuse and stock (no image provider
        // needed) and quietly skips a miss (generateAllowed=false).
        if (layouts.length && (dt === "deck" || dt === "doc")) {
          const items = outline.pages;
          const ids = layouts.map((l) => l.id);
          let selection: string[];
          try {
            const { text } = await oc.aiTextStructured({
              workspaceId: deps.workspaceId,
              system: layoutSelectionSystemPrompt(items.length, layouts),
              prompt: items.map((p, i) => `${i + 1}. [${p.visualRole}] ${p.title}${p.points.length ? ` (${p.points.length} points)` : ""}`).join("\n"),
              schema: layoutSelectionSchema(items.length, ids),
            });
            const parsed = parseModelJson(text) as { layouts?: unknown } | null;
            selection = repairLayoutSelection(parsed?.layouts, items, layouts);
          } catch {
            selection = repairLayoutSelection(null, items, layouts); // deterministic role preference
          }
          const byId = new Map(layouts.map((l) => [l.id, l] as const));
          // Generation dials and the brand voice shape the FILL text too, not
          // just the outline (the second pass would otherwise drift neutral).
          const styleClause = [dialsClause(deps.dials), deps.voiceClause].filter(Boolean).join(" ");

          const fills: LayoutFill[] = new Array(items.length);
          const pool = 4;
          let next = 0;
          const worker = async () => {
            while (next < items.length) {
              const i = next++;
              const layout = byId.get(selection[i])!;
              const item = items[i];
              const schema = deriveLayoutContentSchema(layout);
              try {
                const { text } = await oc.aiTextStructured({
                  workspaceId: deps.workspaceId,
                  system: layoutFillSystemPrompt(schema, styleClause),
                  prompt: `Deck: ${outline.title}${outline.theme ? ` (${outline.theme})` : ""}\nSlide ${i + 1} of ${items.length}: ${item.title}\nKey points:\n${item.points.map((x) => `- ${x}`).join("\n") || "(none)"}${item.note ? `\nSpeaker note (context, not slide text): ${item.note}` : ""}`,
                  schema,
                });
                const fill = normalizeLayoutFill(layout, parseModelJson(text));
                const usable = Object.keys(fill.texts).length + Object.keys(fill.lists).length > 0;
                fills[i] = usable ? fill : fallbackLayoutFill(layout, item);
              } catch {
                fills[i] = fallbackLayoutFill(layout, item);
              }
            }
          };
          await Promise.all(Array.from({ length: Math.min(pool, items.length) }, worker));
          const { aspect, imageSize } = aspectAndImageSize(size);
          // Hero backgrounds for the impact pages (the T10 behavior): layout
          // grounding fills picture SLOTS, but most layouts have none, so the
          // cover/quote/closing pages keep their streamed hero backgrounds.
          const heroPlans = deps.imageCapable
            ? items
                .map((p, i) => ({ p, i }))
                .filter(({ p, i }) => HERO_ROLES.has(p.visualRole) && !Object.keys(fills[i]?.imagePrompts ?? {}).length)
                .slice(0, MAX_HERO_IMAGES)
                .map(({ p, i }) => ({
                  pageIndex: i,
                  subject: p.title,
                  prompt: groundImagePrompt(
                    `${outline.title}${p.title ? ` - ${p.title}` : ""}. ${outline.theme ?? ""}. A soft, uncluttered, low-contrast background with generous empty space so overlaid text stays readable. No text, no words, no logos in the image.`,
                    { palette: deps.brandPalette, aspect },
                  ),
                }))
            : [];
          // The theme's page background, converted exactly as the freeform
          // engine converts it (an empty layout pass yields just the Fill).
          const seed = Array.from(outline.title).reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7);
          const theme = deckThemes({ brandPalette: deps.brandPalette, kicker: outline.title, count: 1, fontHeading: deps.brandFonts.heading, fontBody: deps.brandFonts.body, seed })[0];
          const background = layoutDesign({ layout: "centered", background: theme.background, blocks: [], dir: "ltr" }, size).background;
          return {
            payload: {
              kind: "layoutDeck",
              deckTitle: outline.title,
              pages: items.map((item, i) => ({ layoutId: selection[i], name: item.title || `Page ${i + 1}`, note: item.note, fill: fills[i] })),
              background,
              imageSize,
              size,
              brandPalette: deps.brandPalette,
              brandFonts: deps.brandFonts,
              heroPlans,
              generateAllowed: deps.imageCapable,
              workspaceId: deps.workspaceId,
              designId: deps.designId ?? null,
              append,
            },
          };
        }
      }
      // T10 placeholder-first: the pages land INSTANTLY and the hero images for
      // high-impact pages stream in behind through the resolution queue
      // (reuse -> stock -> generate). Only the prompts are planned here; nothing
      // blocks on the image provider, and a failure never touches the deck.
      let heroPlans: { pageIndex: number; prompt: string; subject: string; size: string }[] = [];
      if (deps.imageCapable) {
        const { aspect, imageSize: sizeStr } = aspectAndImageSize(size);
        heroPlans = outline.pages
          .map((p, i) => ({ p, i }))
          .filter(({ p }) => HERO_ROLES.has(p.visualRole))
          .slice(0, MAX_HERO_IMAGES)
          .map(({ p, i }) => ({
            pageIndex: i,
            size: sizeStr,
            subject: p.title,
            prompt: groundImagePrompt(
              `${outline.title}${p.title ? ` - ${p.title}` : ""}. ${outline.theme ?? ""}. A soft, uncluttered, low-contrast background with generous empty space so overlaid text stays readable. No text, no words, no logos in the image.`,
              { palette: deps.brandPalette, aspect },
            ),
          }));
      }
      return { payload: { kind: "outline", outline, size, brandPalette: deps.brandPalette, brandFonts: deps.brandFonts, heroPlans, workspaceId: deps.workspaceId, designId: deps.designId ?? null, append } };
    }
    default:
      return {};
  }
}

// Execute one validated plan step against the editor store. Returns true if it
// changed (or read) the document successfully. Runs inside runAsTurn so all
// steps collapse into a single undo entry. Generative steps consume the payload
// pre-resolved by resolvePlanStep.
function runPlanStep(step: PlanStep, ctx?: { brandTargets?: BrandFixTarget[]; payload?: ResolvedPayload; brandFonts?: { heading?: string; body?: string } }): boolean {
  const st = useEditor.getState();
  const a = step.args;
  switch (step.action) {
    case "addPage":
      st.addPage();
      return true;
    case "applyBrand": {
      // Brand-lint targets are fetched async by the caller (execute) and passed
      // in, so this stays synchronous inside the one-undo turn.
      const targets = ctx?.brandTargets ?? [];
      if (!targets.length) return false;
      return st.applyBrandFixes(targets) > 0;
    }
    case "duplicatePage":
      st.duplicatePage();
      return true;
    case "setPageBackground": {
      const c = fromHex(String(a.color));
      if (!c) return false;
      const c2 = a.color2 ? fromHex(String(a.color2)) : null;
      if (c2) {
        const angle = typeof a.angle === "number" ? a.angle : 135;
        st.setPageBackground({ type: "gradient", gradient: "linear", angle, stops: [{ position: 0, color: c }, { position: 1, color: c2 }] } as Fill);
      } else {
        st.setPageBackground({ type: "solid", color: c });
      }
      return true;
    }
    case "setSelectedText": {
      const ids = st.selection.filter((id) => locate(st.doc, id)?.node.type === "text");
      if (!ids.length) return false;
      ids.forEach((id) => st.setText(id, String(a.text)));
      return true;
    }
    case "recolorSelection": {
      const c = fromHex(String(a.color));
      if (!c || !st.selection.length) return false;
      st.selection.forEach((id) => st.setFills(id, [{ type: "solid", color: c }]));
      return true;
    }
    case "harmonize": {
      const p = harmonizeProposal(styleSamplesForPage(st.doc, st.activePage));
      const changes = [...p.fonts, ...p.colors, ...p.radii];
      return st.applyHarmonize(changes) > 0;
    }
    case "tidyLayout": {
      const page = st.doc.pages[st.activePage];
      const ids = (page?.children ?? []).map((n) => (n as { id: string }).id);
      if (ids.length < 2) return false;
      st.select(ids);
      st.tidySelection();
      return true;
    }
    case "animatePage":
      st.magicAnimatePage();
      return true;
    case "insertChart": {
      const series = (a.series as { name: string; values: number[] }[]) ?? [];
      const categories = (a.categories as string[]) ?? [];
      if (!series.length || !categories.length) return false;
      const known = ["bar", "line", "area", "pie", "donut", "scatter", "radar"];
      const chartType = (known.includes(String(a.chartType)) ? String(a.chartType) : "bar") as ChartType;
      st.insertChartData({ chartType, categories, series });
      return true;
    }
    case "resizePage":
      st.setPageSize(Number(a.width), Number(a.height));
      return true;
    case "writeText": {
      if (ctx?.payload?.kind !== "text") return false;
      const { text, targetId } = ctx.payload;
      if (targetId) { st.setText(targetId, text); return true; }
      // Contrast the text against the current page so AI-added copy is legible on
      // the dark/imagery posters the generator makes (a near-black default is
      // invisible there). White on dark, near-black on light.
      const textColor: Color = pageIsDark(st.doc.pages[st.activePage])
        ? { srgb: { r: 1, g: 1, b: 1, a: 1 } }
        : { srgb: { r: 0.1, g: 0.12, b: 0.16, a: 1 } };
      st.addNode("text", {
        name: tr("editor.ai_text"),
        transform: { x: 300, y: 320, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 480, height: 120 },
        box: { mode: "fixed", width: 480, height: 120, autoFit: { enabled: false, min: 8, max: 512 }, verticalAlign: "top" },
        content: [{ runs: [{ text, style: { fontFamily: "system", fontStyle: "Regular", fontSize: 28, axes: { wght: 400 }, fill: { type: "solid", color: textColor } } }], style: { align: "left", direction: "auto" } }],
      } as Partial<Node>);
      return true;
    }
    case "rewriteSelectedText": {
      if (ctx?.payload?.kind !== "text" || !ctx.payload.targetId) return false;
      st.setText(ctx.payload.targetId, ctx.payload.text);
      return true;
    }
    case "translateDeck": {
      // Whole-deck translation (doc 28 FR-23): the resolve pass translated every
      // collected string; write each back to its exact address (text run /
      // sticky / notes) in one undo step, styling untouched.
      if (ctx?.payload?.kind !== "decktexts") return false;
      st.applyDeckTexts(ctx.payload.entries);
      return true;
    }
    case "generateSpeakerNotes": {
      // AI speaker notes (doc 28 FR-23): one note per slide into Page.notes,
      // surfaced in presenter view and the notes panel.
      if (ctx?.payload?.kind !== "notes") return false;
      ctx.payload.notes.forEach((n, i) => {
        if (typeof n === "string" && n.trim()) st.setPageNotes(n.trim(), i);
      });
      return true;
    }
    case "generateDiagram": {
      if (ctx?.payload?.kind !== "diagram") return false;
      return st.insertDiagramSpec(ctx.payload.spec);
    }
    case "clusterStickies": {
      if (ctx?.payload?.kind !== "clusters") return false;
      return st.applyStickyClusters(ctx.payload.clusters);
    }
    case "summarizeStickies": {
      if (ctx?.payload?.kind !== "summary") return false;
      return st.insertSummaryNote(ctx.payload.text);
    }
    case "generateImage": {
      if (ctx?.payload?.kind !== "image") return false;
      placeImage(ctx.payload.image);
      return true;
    }
    case "generateBackgroundImage": {
      if (ctx?.payload?.kind !== "bgimage") return false;
      st.addPageBackgroundImage(ctx.payload.image);
      return true;
    }
    case "editSelectedImage": {
      if (ctx?.payload?.kind !== "image" || !ctx.payload.targetId) return false;
      st.setImageSource(ctx.payload.targetId, ctx.payload.image);
      return true;
    }
    case "insertAgenda": {
      // Fully algorithmic (T13): titles from the live pages, entry math and
      // numbering from the pure core, the layout via the priority picker; a
      // deck with no list-capable layout skips silently.
      const docPages = st.doc.pages as unknown as { name?: string; layoutId?: string; children: unknown[]; background?: unknown; width: number; height: number }[];
      const titles = docPages.map((p) => pageTitleOf(p));
      const withTitle = hasTitleSlide(st.doc as unknown as { layouts?: SlideLayout[]; pages: { layoutId?: string; children: unknown[] }[] });
      const plans = buildAgendaPages(titles, withTitle);
      if (!plans.length) return false;
      const insertAt = withTitle ? 1 : 0;
      const refPage = docPages[insertAt] ?? docPages[0];
      const size = { width: refPage.width, height: refPage.height };
      st.ensureSlideLayouts(size); // inside the turn, sized to the agenda's page
      const layouts = (st.doc as unknown as { layouts: SlideLayout[] }).layouts;
      const agendaLayout = pickAgendaLayout(layouts);
      if (!agendaLayout) return false;
      const deckLike = {
        title: tr("editor.agenda"),
        pages: plans.map(() => ({ name: tr("editor.agenda"), background: structuredClone(refPage.background), nodes: [] })),
      } as unknown as Parameters<typeof st.buildDeckFromOutline>[0];
      const ids = st.appendDeckPages(deckLike, size);
      if (!ids.length) return false;
      const firstAppended = st.doc.pages.length - ids.length;
      const titleSlot = (agendaLayout.placeholders ?? []).find((p) => p.role === "title");
      const contentSlot = (agendaLayout.placeholders ?? []).find((p) => p.role === "content");
      plans.forEach((plan, j) => {
        st.movePage(firstAppended + j, insertAt + j);
        st.applyLayoutToPage(agendaLayout.id, insertAt + j);
        const liveBg = (st.doc.pages[insertAt + j] as unknown as { background?: unknown }).background;
        st.fillPlaceholderContent(insertAt + j, {
          texts: titleSlot ? { [titleSlot.id]: tr("editor.agenda") } : {},
          lists: contentSlot ? { [contentSlot.id]: plan.entries.map((e) => `${e.pageNumber}. ${e.title}`) } : {},
        }, { styles: slotStylesFor(agendaLayout, ctx?.brandFonts, liveBg) });
      });
      st.goToPage(insertAt);
      return true;
    }
    case "regenerateSlide": {
      if (ctx?.payload?.kind !== "regenerateSlide") return false;
      const { pageIndex, pageId, layoutId, layoutChanged, hadLayout, fill, imageTasks, imageSize, generateAllowed, workspaceId, designId } = ctx.payload;
      // The page must still be the one that was resolved (identity guard).
      const live = st.doc.pages[pageIndex] as unknown as { id: string; width: number; height: number } | undefined;
      if (!live || live.id !== pageId) return false;
      if (layoutChanged) {
        st.ensureSlideLayouts({ width: live.width, height: live.height }); // inside the turn; no-op when layouts exist
        // Prune the OLD layout's boxes for slots absent from the new layout, or
        // they would keep their stale content overlapping the new slots. Slots
        // present in both layouts keep their node ids (Magic Move contract).
        // An UNLINKED page (the user deliberately detached it) is never pruned:
        // its tagged boxes are the user's arrangement, so the new layout only
        // adds what is missing.
        st.applyLayoutToPage(layoutId, pageIndex, { pruneObsolete: hadLayout });
      }
      const regenLayouts = (st.doc as unknown as { layouts?: SlideLayout[] }).layouts ?? [];
      const regenBg = (st.doc.pages[pageIndex] as unknown as { background?: unknown }).background;
      st.fillPlaceholderContent(pageIndex, { texts: fill.texts, lists: fill.lists },
        { styles: slotStylesFor(regenLayouts.find((l) => l.id === layoutId), ctx?.brandFonts, regenBg) });
      enqueueAiImages(imageTasks.map((t) => ({
        workspaceId,
        designId: designId ?? "",
        pageId,
        placeholderId: t.placeholderId,
        prompt: t.prompt,
        subject: t.subject,
        size: imageSize,
        generateAllowed,
      })));
      st.goToPage(pageIndex);
      return true;
    }
    case "splitSlide": {
      if (ctx?.payload?.kind !== "splitSlide") return false;
      const { pageIndex, pageId, halves } = ctx.payload;
      const orig = st.doc.pages[pageIndex] as unknown as { id: string; width: number; height: number; background?: unknown; children: unknown[] } | undefined;
      // Identity guard: the resolve step is async, so the page at this index
      // must still be the one that was split, or the wrong page gets deleted.
      if (!orig || orig.id !== pageId || halves.length !== 2) return false;
      st.ensureSlideLayouts({ width: orig.width, height: orig.height }); // inside the turn
      // The halves' layouts must exist NOW (the async resolve may be stale):
      // bail before anything is created or destroyed, or a failed layout link
      // would leave two empty pages where the original's text used to be.
      const available = new Set(((st.doc as unknown as { layouts?: SlideLayout[] }).layouts ?? []).map((l) => l.id));
      if (!halves.every((h) => available.has(h.layoutId))) return false;
      const size = { width: orig.width, height: orig.height };
      // The split redistributes TEXT; everything else on the original slide
      // (charts, images, shapes) carries onto the first half instead of being
      // silently discarded with the deleted page. Carried nodes take FRESH ids
      // (the original page exists alongside the halves until deletePage runs,
      // and duplicated ids must never be observable, e.g. by a CRDT broadcast
      // mid-turn) and DROP their placeholder tags: the tags belonged to the
      // original page's layout, and a stale tag would both block the new
      // layout's slot materialization and misdirect later slot-scoped fills.
      const keepNodes = structuredClone((orig.children as { id: string; type: string; data?: { placeholderId?: string; aiImagePrompt?: string } }[]).filter((n) => n.type !== "text"));
      for (const n of keepNodes) {
        n.id = `node-${crypto.randomUUID()}`;
        // The slot tag belonged to the ORIGINAL page's layout, and a prompt
        // stamp on an untagged image would make applyGeneratedBackground
        // mistake the carried image for a replaceable generated background.
        if (n.data?.placeholderId) delete n.data.placeholderId;
        if (n.data?.aiImagePrompt) delete n.data.aiImagePrompt;
      }
      const deckLike = {
        title: "",
        pages: halves.map((h, j) => ({ name: h.name, background: structuredClone(orig.background), nodes: j === 0 ? keepNodes : [] })),
      } as unknown as Parameters<typeof st.buildDeckFromOutline>[0];
      const ids = st.appendDeckPages(deckLike, size);
      if (ids.length !== 2) return false;
      st.deletePage(pageIndex); // the two halves REPLACE the original
      const firstAppended = st.doc.pages.length - 2;
      const layoutsNow = (st.doc as unknown as { layouts?: SlideLayout[] }).layouts ?? [];
      halves.forEach((h, j) => {
        st.movePage(firstAppended + j, pageIndex + j);
        st.applyLayoutToPage(h.layoutId, pageIndex + j);
        const liveBg = (st.doc.pages[pageIndex + j] as unknown as { background?: unknown }).background;
        st.fillPlaceholderContent(pageIndex + j, { texts: h.fill.texts, lists: h.fill.lists },
          { styles: slotStylesFor(layoutsNow.find((l) => l.id === h.layoutId), ctx?.brandFonts, liveBg) });
      });
      st.goToPage(pageIndex);
      return true;
    }
    case "insertComparison": {
      if (ctx?.payload?.kind !== "insertComparison") return false;
      const { layoutId, name, fill, afterIndex, afterPageId } = ctx.payload;
      // Re-anchor by id, failing CLOSED like the sibling ops: the anchor page
      // vanishing means the document changed under the async resolve (deleted
      // page, or another design opened), and inserting anywhere else would
      // mutate a document the user never aimed at.
      void afterIndex; // superseded by the id anchor
      const anchor = st.doc.pages.findIndex((p) => (p as unknown as { id: string }).id === afterPageId);
      if (anchor < 0) return false;
      const ref = st.doc.pages[anchor] as unknown as { width: number; height: number; background?: unknown } | undefined;
      if (!ref) return false;
      st.ensureSlideLayouts({ width: ref.width, height: ref.height }); // inside the turn
      // The layout must exist NOW (the async resolve may be stale): bail before
      // the page appears, or a failed link would insert a silently blank slide.
      const availableCmp = new Set(((st.doc as unknown as { layouts?: SlideLayout[] }).layouts ?? []).map((l) => l.id));
      if (!availableCmp.has(layoutId)) return false;
      const deckLike = {
        title: "",
        pages: [{ name, background: structuredClone(ref.background), nodes: [] }],
      } as unknown as Parameters<typeof st.buildDeckFromOutline>[0];
      const ids = st.appendDeckPages(deckLike, { width: ref.width, height: ref.height });
      if (!ids.length) return false;
      const to = anchor + 1;
      st.movePage(st.doc.pages.length - 1, to);
      st.applyLayoutToPage(layoutId, to);
      const cmpLayouts = (st.doc as unknown as { layouts?: SlideLayout[] }).layouts ?? [];
      const liveBg = (st.doc.pages[to] as unknown as { background?: unknown }).background;
      st.fillPlaceholderContent(to, { texts: fill.texts, lists: fill.lists },
        { styles: slotStylesFor(cmpLayouts.find((l) => l.id === layoutId), ctx?.brandFonts, liveBg) });
      st.goToPage(to);
      return true;
    }
    case "generateDesign": {
      // T12 layout-grounded apply: create the pages empty (theme background),
      // link + materialize each page's layout, write the filled content into
      // the placeholder boxes, and queue the picture-slot images. All inside
      // the caller's one-undo turn.
      if (ctx?.payload?.kind === "layoutDeck") {
        const { deckTitle, pages, background, imageSize, size, brandPalette, brandFonts, heroPlans, generateAllowed, workspaceId, designId, append } = ctx.payload;
        st.ensureSlideLayouts(size); // sized to the generated pages, no-op when layouts exist
        const installed = (st.doc as unknown as { layouts?: SlideLayout[] }).layouts ?? [];
        const masters = (st.doc as unknown as { masters?: { id: string; background?: Fill }[] }).masters ?? [];
        // Brand fonts + a background-readable ink per slot role, decided
        // against the layout's EFFECTIVE background (applyLayoutToPage will
        // overwrite the theme background when the layout or master carries
        // one, so the ink must follow that, not the theme's).
        const stylesFor = (layoutId: string): Record<string, { fontFamily?: string; fill?: Fill }> => {
          const layout = installed.find((l) => l.id === layoutId);
          const effectiveBg = (layout as { background?: Fill } | undefined)?.background
            ?? masters.find((m) => m.id === layout?.masterId)?.background
            ?? background;
          return slotStylesFor(layout, brandFonts, effectiveBg);
        };
        const { aspect } = aspectAndImageSize(size);
        const deckLike = {
          title: deckTitle,
          pages: pages.map((p) => ({ name: p.name, note: p.note, background, nodes: [] })),
        } as unknown as Parameters<typeof st.buildDeckFromOutline>[0];
        const base = append ? st.doc.pages.length : 0;
        const ids = append ? st.appendDeckPages(deckLike, size) : st.buildDeckFromOutline(deckLike, size);
        if (!ids.length) return false;
        const imageTasks: Parameters<typeof enqueueAiImages>[0] = [];
        const availableIds = new Set(installed.map((l) => l.id));
        pages.forEach((p, i) => {
          // The selection came from the async resolve; a since-removed layout
          // falls back to any installed one rather than leaving a blank page.
          const layoutId = availableIds.has(p.layoutId) ? p.layoutId : installed[0]?.id;
          if (!layoutId) return;
          st.applyLayoutToPage(layoutId, base + i);
          st.fillPlaceholderContent(base + i, { texts: p.fill.texts, lists: p.fill.lists }, { styles: stylesFor(layoutId) });
          for (const [placeholderId, prompt] of Object.entries(p.fill.imagePrompts)) {
            imageTasks.push({
              workspaceId,
              designId: designId ?? "",
              pageId: ids[i],
              placeholderId,
              prompt: groundImagePrompt(prompt, { palette: brandPalette, aspect }),
              subject: prompt,
              size: imageSize,
              generateAllowed,
            });
          }
        });
        // Hero backgrounds for the impact pages (already grounded in resolve).
        for (const h of heroPlans) {
          if (ids[h.pageIndex]) imageTasks.push({ workspaceId, designId: designId ?? "", pageId: ids[h.pageIndex], prompt: h.prompt, subject: h.subject, size: imageSize });
        }
        enqueueAiImages(imageTasks);
        st.goToPage(base);
        return true;
      }
      if (ctx?.payload?.kind !== "outline") return false;
      const { outline, size, brandPalette, brandFonts, heroPlans, workspaceId, designId, append } = ctx.payload;
      const clean: DesignOutline = { ...outline, pages: outline.pages.map((p) => ({ ...p, points: p.points.map((s) => s.trim()).filter(Boolean) })) };
      // Seed the default hue from the title so different briefs don't all fall
      // back to the same first curated color (a brand palette overrides this).
      const seed = Array.from(clean.title).reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7);
      const themes = deckThemes({ brandPalette, kicker: clean.title, count: 1, fontHeading: brandFonts.heading, fontBody: brandFonts.body, seed });
      const deck = layoutDeck(clean, themes[0], size);
      const base = append ? st.doc.pages.length : 0;
      const ids = append ? st.appendDeckPages(deck, size) : st.buildDeckFromOutline(deck, size);
      if (!ids.length) return false;
      // T10 placeholder-first: the deck is fully laid out NOW; hero images for
      // the impact pages resolve in the background (reuse -> stock -> generate)
      // and land by page id, so a failure or a design switch never breaks the
      // deck. Enqueueing only schedules async work - the one-undo turn stays
      // synchronous, and each resolution is its own small undoable mutation.
      enqueueAiImages(heroPlans.map((h) => ({
        workspaceId,
        designId: designId ?? "",
        pageId: ids[h.pageIndex],
        prompt: h.prompt,
        subject: h.subject,
        size: h.size,
      })).filter((t) => !!t.pageId));
      st.goToPage(base); // land on the first new page (and scroll it into view)
      return true;
    }
    case "critique":
      return true; // read-only; handled by the caller for messaging
    default:
      return false;
  }
}

function AssistantPanel({ workspaceId, aiReady, voiceClause, brandPalette, brandFonts, imageCapable, editImageCapable }: {
  workspaceId: string | null;
  aiReady: boolean;
  voiceClause: string;
  brandPalette: string[];
  brandFonts: { heading?: string; body?: string };
  imageCapable: boolean;
  editImageCapable: boolean;
}) {
  const toast = useToast();
  const runAsTurn = useEditor((s) => s.runAsTurn);
  const undo = useEditor((s) => s.undo);
  const designId = useComments((s) => s.designId); // current design (for persisted history)
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  // T10: image resolutions settle in the background; surface failures with a
  // retry chip (never a failed deck - the pages are already placed).
  const [failedImages, setFailedImages] = useState(0);
  useEffect(() => {
    // Unsaved designs are queued under the empty-string key; subscribe and
    // retry under the same key so their failures still surface.
    const key = designId ?? "";
    return subscribeAiImageQueue((ev) => {
      if (ev.designId !== key) return;
      if (ev.failed > 0) {
        setFailedImages(ev.failed);
        setTurns((t) => [...t, { role: "assistant", text: tr("editor.n_images_couldnt_be_added", { count: ev.failed }) }]);
      } else if (ev.resolved > 0) {
        setFailedImages(0);
      }
    });
    // setTurns is stable (useState setter); re-subscribe only per design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [designId]);
  const [busy, setBusy] = useState(false);
  // Attached source content for create-from-document/URL/file (FR-23).
  const [source, setSource] = useState<{ name: string; text: string } | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachUrl, setAttachUrl] = useState("");
  const [attachBusy, setAttachBusy] = useState(false);
  // FR-8: a plan awaiting confirmation before it mutates the document.
  const [pending, setPending] = useState<{ plan: PlanStep[]; reply: string } | null>(null);
  // T09 outline review: for a gated generateDesign plan, the outline is fetched
  // up front and shown as an editable list with generation dials; Generate
  // proceeds with the EDITED outline (no second model call). null = no review
  // (non-design plans); loading = outline still being fetched.
  const [review, setReview] = useState<{ outline: DesignOutline | null; loading: boolean; dials: GenerationDials } | null>(null);
  const reviewSeq = useRef(0);
  // Monotonic id source for review-added outline items: a length-derived id
  // collides after add-remove-add (same length twice) and duplicates React keys.
  const reviewAddSeq = useRef(0);
  // FR-9/FR-27: persisted session id for this design (created lazily).
  const sessionRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Restore the most recent persisted session's turns on mount/design change so
  // the conversation survives reloads (FR-9).
  useEffect(() => {
    sessionRef.current = null;
    if (!designId) return;
    let cancelled = false;
    void (async () => {
      let restored: ChatTurn[] = [];
      try {
        const { sessions } = await oc.listAiSessions(designId);
        if (sessions.length) {
          const latest = sessions[0];
          const { turns: persisted } = await oc.listAiTurns(designId, latest.id);
          if (!cancelled) {
            sessionRef.current = latest.id;
            restored = persisted.map((t) => ({ role: t.role, text: t.text }));
          }
        }
      } catch {
        // history is best-effort; a fresh chat is fine
      }
      if (!cancelled) setTurns(restored); // setState after await: allowed by the lint rule
    })();
    return () => { cancelled = true; };
  }, [designId]);

  // Lazily create (and cache) a session, then append a turn. Best-effort: a
  // persistence failure never blocks the chat.
  async function ensureSession(): Promise<string | null> {
    if (!designId) return null;
    if (sessionRef.current) return sessionRef.current;
    try {
      const s = await oc.createAiSession(designId);
      sessionRef.current = s.id;
      return s.id;
    } catch {
      return null;
    }
  }
  async function persistTurn(role: "user" | "assistant", text: string, plan?: unknown) {
    if (!designId) return;
    const sid = await ensureSession();
    if (!sid) return;
    try {
      await oc.appendAiTurn(designId, sid, { role, text, plan, provenance: { feature: "assistant", at: new Date().toISOString() } });
    } catch {
      // best-effort
    }
  }

  // Execute a validated plan as ONE undo turn, then report per-step status.
  // Fetch the outline for the pending generateDesign step so the user can
  // review and edit it before anything is generated (T09). Re-invoked by the
  // dials row's Regenerate; a sequence guard drops stale responses.
  async function startOutlineReview(plan: PlanStep[], dials: GenerationDials) {
    const step = plan.find((s) => s.action === "generateDesign");
    if (!step || !workspaceId) return;
    const seq = ++reviewSeq.current;
    setReview({ outline: null, loading: true, dials });
    try {
      const deps: AssistantDeps = { workspaceId, voiceClause, brandPalette, brandFonts, imageCapable, editImageCapable, sourceText: source?.text, sourceName: source?.name, dials, designId };
      const { dt, brief, brandClause, pageCount } = prepareGenerateBrief(step.args, deps);
      const outline = await fetchAssistantOutline(workspaceId, dt, brief, brandClause, pageCount);
      if (seq !== reviewSeq.current) return; // superseded by a newer fetch or cancel
      setReview({ outline, loading: false, dials });
    } catch {
      if (seq === reviewSeq.current) setReview({ outline: null, loading: false, dials });
    }
  }

  // Immutable outline-edit helpers for the review card.
  function editReviewOutline(fn: (pages: OutlineItem[]) => OutlineItem[]) {
    setReview((r) => (r?.outline ? { ...r, outline: { ...r.outline, pages: fn(r.outline.pages) } } : r));
  }
  function clearReview() {
    reviewSeq.current++; // invalidate any in-flight fetch
    setReview(null);
  }

  async function execute(plan: PlanStep[], reply: string, reviewedOutline?: DesignOutline, dials?: GenerationDials) {
    if (!workspaceId) return;
    setBusy(true);
    try {
      // Resolve every async prerequisite BEFORE the synchronous undo turn so the
      // whole plan still collapses into one undo entry: applyBrand needs brand-lint
      // fix targets (FR-7/FR-16), and the generative tools (writeText, generateImage,
      // generateDesign, ...) need their AI results pre-fetched.
      let brandTargets: BrandFixTarget[] = [];
      if (plan.some((s) => s.action === "applyBrand") && designId) {
        try {
          const violations = await oc.brandLint(designId);
          brandTargets = violations
            .filter((v: BrandLintViolation) => v.fix && v.nodeId && v.fix.kind !== "restore_logo")
            .map((v: BrandLintViolation) => ({ nodeId: v.nodeId!, fix: v.fix! }));
        } catch {
          // best-effort; the applyBrand step will simply report nothing to fix
        }
      }
      const deps: AssistantDeps = { workspaceId, voiceClause, brandPalette, brandFonts, imageCapable, editImageCapable, sourceText: source?.text, sourceName: source?.name, reviewedOutline, dials, designId };
      const payloads: (ResolvedPayload | undefined)[] = [];
      const skips: (string | undefined)[] = [];
      for (let i = 0; i < plan.length; i++) {
        const r = await resolvePlanStep(plan[i], deps);
        payloads[i] = r.payload;
        skips[i] = r.error;
      }

      const results: { action: string; ok: boolean }[] = [];
      runAsTurn(() => {
        plan.forEach((step, i) => {
          if (skips[i]) { results.push({ action: step.action, ok: false }); return; }
          let ok = false;
          try {
            ok = runPlanStep(step, { brandTargets, payload: payloads[i], brandFonts });
          } catch {
            ok = false;
          }
          results.push({ action: step.action, ok });
        });
      });
      // FR-31: auto-describe AI-placed images for accessibility (best-effort,
      // post-turn so it doesn't add to the one-undo apply; the just-placed image
      // is the current selection). Only the single-image tools - generateDesign's
      // hero backgrounds never carried alt text.
      if (results.some((r, i) => r.ok && (plan[i].action === "generateImage" || plan[i].action === "generateBackgroundImage"))) {
        void generateAltText(workspaceId).catch(() => {});
      }
      // A planned critique step is read-only; surface its actual findings instead
      // of just a "done" chip.
      let extra = "";
      if (plan.some((s) => s.action === "critique")) {
        const st = useEditor.getState();
        const issues = critiquePage(st.doc, st.activePage);
        extra = issues.length ? ` Critique: ${issues.slice(0, 4).map((i) => i.message).join("; ")}${issues.length > 4 ? "…" : ""}` : " Critique: this page looks clean.";
      }
      const skipNote = skips.find(Boolean);
      const done = results.filter((r) => r.ok).length;
      const text = (reply || tr("editor.done_2")) + extra + (done === 0 && skipNote ? ` (${skipNote})` : "");
      setTurns((t) => [...t, { role: "assistant", text, steps: results }]);
      void persistTurn("assistant", text, plan);
      if (done) toast.success(`Applied ${done} step${done === 1 ? "" : "s"} (one undo reverts the turn).`);
      else if (!extra) toast.error(skipNote ? `Nothing applied: ${skipNote}.` : tr("editor.nothing_was_applied_try_selecting_an_element"));
    } catch (e) {
      toast.error(aiErr(e));
    } finally {
      setBusy(false);
    }
  }

  async function send(textArg?: string) {
    const userText = (textArg ?? input).trim();
    if (!workspaceId || !userText || !aiReady || busy) return;
    if (!textArg) setInput("");
    setPending(null);
    clearReview();
    setTurns((t) => [...t, { role: "user", text: userText }]);
    void persistTurn("user", userText);
    setBusy(true);
    try {
      const st = useEditor.getState();
      const summaryDoc = {
        title: st.doc.title,
        pages: st.doc.pages.map((p) => ({
          name: p.name,
          width: p.width,
          height: p.height,
          children: (p.children ?? []).map((n) => ({ type: (n as { type: string }).type, name: (n as { name?: string }).name })),
        })),
      };
      const summary = summarizeDesign(summaryDoc, st.activePage, st.selection.length);
      // Compact history: the last few turns keep refinement context (FR-9).
      const history = turns.slice(-6).map((t) => `${t.role}: ${t.text}`).join("\n");

      // Prefer the backend orchestrator (server-side validation/retry, FR-12);
      // fall back to the free-text path. Either way the client re-validates arg
      // types via parseAssistantReply before anything executes.
      // With a source attached, tell the planner it exists (the executor does
      // the grounding); the user's words alone often don't mention it.
      const plannerText = source
        ? `${userText}\n[Note: the user attached source content "${source.name}" (${source.text.length} chars). To create a deck/design from it, plan generateDesign - the executor grounds the outline in the attachment automatically.]`
        : userText;
      let res;
      try {
        const r = await oc.aiAssistant({ workspaceId, designSummary: summary, history, message: plannerText });
        res = parseAssistantReply(r, ASSISTANT_CATALOG);
      } catch (e) {
        if (e instanceof ApiError && !endpointUnavailable(e)) throw e; // surface provider/policy errors
        try {
          const system = assistantSystemPrompt(ASSISTANT_CATALOG, summary);
          const { text } = await oc.aiText({ workspaceId, prompt: history ? `${history}\nuser: ${plannerText}` : plannerText, system });
          res = parseAssistantReply(parseModelJson(text), ASSISTANT_CATALOG);
        } catch (e2) {
          if (e2 instanceof ApiError) throw e2; // a provider/policy error surfaces via the outer catch
          setTurns((t) => [...t, { role: "assistant", text: tr("editor.sorry_i_couldnt_understand_that_try_rephrasi") }]);
          return;
        }
      }

      if (res.clarify) {
        setTurns((t) => [...t, { role: "assistant", text: res.clarify! }]);
        void persistTurn("assistant", res.clarify);
        return;
      }
      if (!res.plan.length) {
        // A read-only critique request: surface the page critique.
        if (/\b(critique|review|feedback|improve|issues?)\b/i.test(userText)) {
          const issues = critiquePage(st.doc, st.activePage);
          const msg = issues.length ? `${issues.length} issue${issues.length === 1 ? "" : "s"}: ${issues.slice(0, 4).map((i) => i.message).join("; ")}${issues.length > 4 ? "…" : ""}` : "No issues found - this page looks clean.";
          setTurns((t) => [...t, { role: "assistant", text: msg }]);
          void persistTurn("assistant", msg);
          return;
        }
        const reply = res.reply || tr("editor.i_couldnt_map_that_to_an_action");
        setTurns((t) => [...t, { role: "assistant", text: reply }]);
        void persistTurn("assistant", reply);
        return;
      }

      // FR-8: a large/destructive plan is previewed and confirmed before it runs;
      // a single small edit applies immediately. Confirm when the plan is multi-step
      // and mutating, OR contains a heavy whole-design action (generateDesign
      // composes whole pages, and with explicit mode:"replace" destroys every
      // existing one - the pending banner warns with the page count).
      const heavy = res.plan.some((s) => s.action === "generateDesign");
      if (heavy || (res.plan.length >= 2 && planMutates(res.plan, ASSISTANT_CATALOG))) {
        setPending({ plan: res.plan, reply: res.reply });
        if (heavy) void startOutlineReview(res.plan, {});
        setTurns((t) => [...t, { role: "assistant", text: res.reply || tr("editor.heres_my_plan_confirm_to_apply"), steps: res.plan.map((s) => ({ action: s.action, ok: true })) }]);
        return;
      }
      await execute(res.plan, res.reply);
    } catch (e) {
      toast.error(aiErr(e));
    } finally {
      setBusy(false);
    }
  }

  // Keep the latest message in view as the thread grows / while thinking.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, busy, pending]);

  // Grow the composer with its content, like a chat app (capped).
  function autosize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }
  function startNewChat() {
    setTurns([]);
    setPending(null);
    clearReview();
    setInput("");
    sessionRef.current = null; // a fresh session is created on the next send
  }
  function startFromType(prompt: string) {
    setInput(prompt);
    const el = inputRef.current;
    if (el) { el.focus(); el.setSelectionRange(prompt.length, prompt.length); }
  }
  // Vector path (beta): the model draws the whole design as one editable SVG at
  // the current page size; we flatten it onto this page as one undo turn. Unlike
  // the outline flow this needs no image model, so it works with text-only
  // providers (e.g. DeepSeek).
  async function genVector(text?: string) {
    const brief = (text ?? input).trim();
    if (!brief || busy || !aiReady || !workspaceId) return;
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "auto";
    setTurns((t) => [...t, { role: "user", text: brief }]);
    setBusy(true);
    try {
      const st = useEditor.getState();
      const pg = st.doc.pages[st.activePage] ?? st.doc.pages[0];
      const { svg, width, height } = await oc.aiDesignSvg({ workspaceId, designType: "design", prompt: brief, width: pg.width, height: pg.height });
      let ids: string[] = [];
      runAsTurn(() => { ids = useEditor.getState().buildSvgDesign(svg, { width, height }); });
      if (!ids.length) throw new Error("no nodes");
      setTurns((t) => [...t, { role: "assistant", text: tr("editor.drew_an_editable_vector_design_on_this_page"), steps: [{ action: "generateVector", ok: true }] }]);
    } catch {
      setTurns((t) => [...t, { role: "assistant", text: tr("editor.couldnt_generate_a_vector_design_make_sure_a") }]);
      toast.error(tr("editor.vector_generation_failed"));
    } finally {
      setBusy(false);
    }
  }
  const canSend = !!input.trim() && !busy && aiReady;
  const hasApplied = turns.some((t) => t.steps?.some((s) => s.ok));
  // Show art-direction follow-ups right after a design was generated.
  const lastTurn = turns[turns.length - 1];
  const lastWasDesign = lastTurn?.role === "assistant" && !!lastTurn.steps?.some((s) => s.action === "generateDesign" && s.ok);
  const AssistantAvatar = (
    <div className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand-100 text-brand-ink"><Sparkles size={13} /></div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Thread toolbar: undo the last applied turn + start a new chat. */}
      {turns.length > 0 && (
        <div className="flex shrink-0 items-center justify-between pb-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">{tr("editor.assistant")}</span>
          <div className="flex items-center gap-1">
            {hasApplied && (
              <button onClick={() => { undo(); toast.success(tr("editor.reverted_last_turn")); }} disabled={busy} title={tr("editor.undo_the_last_applied_turn")} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-40"><RotateCcw size={12} /> {tr("editor.undo")}</button>
            )}
            <button onClick={startNewChat} disabled={busy} title={tr("editor.start_a_new_chat")} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-40"><Plus size={12} /> {tr("editor.new")}</button>
          </div>
        </div>
      )}

      {/* Message thread (the only scrolling region). */}
      <div ref={scrollRef} className="oc-scroll -mx-1 flex-1 space-y-3 overflow-y-auto px-1 py-1">
        {turns.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 px-2 text-center">
            <div className="grid h-11 w-11 place-items-center rounded-full bg-brand-600 text-white shadow-sm"><Sparkles size={20} /></div>
            <div>
              <p className="text-sm font-semibold text-neutral-800">{tr("editor.create_a_design_with_ai")}</p>
              <p className="mx-auto mt-1 max-w-[16rem] text-xs text-neutral-500">{tr("editor.assistant_start_hint")}</p>
            </div>
            {/* Primary: design-creation starters. */}
            <div className="grid w-full max-w-[16rem] grid-cols-2 gap-1.5">
              {designTypes().map((t) => (
                <button key={t.label} onClick={() => startFromType(t.prompt)} disabled={!aiReady} className="rounded-lg border border-neutral-200 bg-surface px-2 py-2 text-xs font-medium text-neutral-700 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-ink disabled:opacity-50">{t.label}</button>
              ))}
            </div>
            {/* Secondary: quick edits on the current design. */}
            <div className="flex flex-wrap justify-center gap-1.5">
              {assistantSuggestions().map((s) => (
                <button key={s} onClick={() => { setInput(s); inputRef.current?.focus(); }} disabled={!aiReady} className="rounded-full border border-neutral-200 bg-surface px-2.5 py-1 text-[11px] text-neutral-500 hover:border-brand-300 hover:text-brand-ink disabled:opacity-50">{s}</button>
              ))}
            </div>
          </div>
        ) : (
          turns.map((t, i) =>
            t.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-brand-600 px-3 py-2 text-sm text-white">{t.text}</div>
              </div>
            ) : (
              <div key={i} className="flex items-start gap-2">
                {AssistantAvatar}
                <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-neutral-100 px-3 py-2 text-sm text-neutral-800">
                  <span className="whitespace-pre-wrap">{t.text}</span>
                  {t.steps && t.steps.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {t.steps.map((s, j) => (
                        <span key={j} className={`rounded px-1.5 py-0.5 text-[10px] ${s.ok ? "bg-emerald-100 text-emerald-700" : "bg-neutral-200 text-neutral-500 line-through"}`}>{s.action}</span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ),
          )
        )}
        {busy && (
          <div className="flex items-start gap-2">
            {AssistantAvatar}
            <div className="flex items-center gap-1 rounded-2xl rounded-bl-sm bg-neutral-100 px-3 py-2.5">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-400 [animation-delay:-0.3s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-400 [animation-delay:-0.15s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-400" />
            </div>
          </div>
        )}
      </div>

      {/* FR-8: confirm a large/destructive plan before it mutates the document.
          For generateDesign plans the confirmation carries the T09 outline
          review: an editable outline plus generation dials; Generate proceeds
          with the EDITED outline, while "Generate now" skips the review. */}
      {pending && (
        <div className="mt-2 flex max-h-[50%] shrink-0 flex-col gap-2 overflow-y-auto rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800">
          <div className="flex items-center justify-between gap-2">
            <span>
              Apply {pending.plan.length} step{pending.plan.length === 1 ? "" : "s"}?
              {(() => {
                const n = planReplacePageCount(pending.plan, useEditor.getState().doc);
                return n > 0 ? <strong className="ms-1">{tr("editor.replaces_all_n_pages", { count: n })}</strong> : null;
              })()}
            </span>
            <span className="flex gap-1">
              <button onClick={() => { const p = pending; setPending(null); clearReview(); void execute(p.plan, p.reply); }} className="rounded bg-amber-600 px-2 py-0.5 font-medium text-white hover:bg-amber-700">{review ? tr("editor.generate_now") : tr("editor.confirm")}</button>
              <button onClick={() => { setPending(null); clearReview(); setTurns((t) => [...t, { role: "assistant", text: tr("editor.cancelled") }]); }} className="rounded border border-amber-300 px-2 py-0.5 hover:bg-amber-100">{tr("editor.cancel")}</button>
            </span>
          </div>
          {review && (
            <div className="flex flex-col gap-2 rounded-md border border-amber-200 bg-surface p-2 text-neutral-700">
              <div className="grid grid-cols-2 gap-1.5">
                {([
                  ["density", dialDensities],
                  ["tone", dialTones],
                  ["audience", dialAudiences],
                  ["scenario", dialScenarios],
                ] as const).map(([key, options]) => (
                  <label key={key} className="flex flex-col gap-0.5 text-[10px] text-neutral-500">
                    {trOr(`editor.dial_${key}`, key)}
                    <select
                      value={(review.dials[key] as string | undefined) ?? "auto"}
                      onChange={(e) => setReview((r) => (r ? { ...r, dials: { ...r.dials, [key]: e.target.value } } : r))}
                      className="rounded border border-neutral-300 px-1 py-0.5 text-[11px] text-neutral-700"
                    >
                      {options.map((v) => (
                        <option key={v} value={v}>{trOr(`editor.dial_${v.replace(/-/g, "_")}`, v.replace(/-/g, " "))}</option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              {review.loading ? (
                <div className="flex items-center gap-2 py-2 text-neutral-500"><Spinner /> {tr("editor.preparing_outline")}</div>
              ) : !review.outline ? (
                <div className="flex items-center justify-between gap-2 py-1 text-neutral-500">
                  <span>{tr("editor.couldnt_prepare_the_outline")}</span>
                  <button onClick={() => pending && void startOutlineReview(pending.plan, review.dials)} className="rounded border border-neutral-300 px-2 py-0.5 hover:border-brand-300 hover:text-brand-ink">{tr("editor.retry")}</button>
                </div>
              ) : (
                <>
                  {review.outline.pages.map((item, i) => (
                    <div key={item.id} className="flex flex-col gap-1 rounded border border-neutral-200 p-1.5">
                      <div className="flex items-center gap-1">
                        <span className="w-4 shrink-0 text-[10px] text-neutral-400">{i + 1}</span>
                        <input
                          value={item.title}
                          onChange={(e) => editReviewOutline((pages) => pages.map((p, j) => (j === i ? { ...p, title: e.target.value } : p)))}
                          className="min-w-0 flex-1 rounded border border-neutral-200 px-1 py-0.5 text-[11px] font-medium"
                        />
                        <button title={tr("editor.move_up")} disabled={i === 0} onClick={() => editReviewOutline((pages) => { const c = [...pages]; [c[i - 1], c[i]] = [c[i], c[i - 1]]; return c; })} className="rounded px-1 text-neutral-400 hover:text-brand-ink disabled:opacity-30">↑</button>
                        <button title={tr("editor.move_down")} disabled={i === review.outline!.pages.length - 1} onClick={() => editReviewOutline((pages) => { const c = [...pages]; [c[i], c[i + 1]] = [c[i + 1], c[i]]; return c; })} className="rounded px-1 text-neutral-400 hover:text-brand-ink disabled:opacity-30">↓</button>
                        <button title={tr("editor.remove")} onClick={() => editReviewOutline((pages) => pages.filter((_, j) => j !== i))} className="rounded px-1 text-neutral-400 hover:text-red-600"><X size={11} /></button>
                      </div>
                      <textarea
                        value={item.points.join("\n")}
                        rows={Math.max(1, Math.min(4, item.points.length))}
                        placeholder={tr("editor.one_point_per_line")}
                        onChange={(e) => editReviewOutline((pages) => pages.map((p, j) => (j === i ? { ...p, points: e.target.value.split("\n") } : p)))}
                        className="ms-5 resize-y rounded border border-neutral-200 px-1 py-0.5 text-[11px]"
                      />
                    </div>
                  ))}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      onClick={() => editReviewOutline((pages) => pages.length >= maxOutlinePages ? pages : [...pages, { id: `edit-${++reviewAddSeq.current}`, title: "", points: [], visualRole: "content" }])}
                      className="rounded border border-neutral-300 px-2 py-0.5 hover:border-brand-300 hover:text-brand-ink"
                    >
                      <Plus size={10} className="inline" /> {tr("editor.add_page")}
                    </button>
                    <button onClick={() => pending && void startOutlineReview(pending.plan, review.dials)} className="rounded border border-neutral-300 px-2 py-0.5 hover:border-brand-300 hover:text-brand-ink">{tr("editor.regenerate_outline")}</button>
                    <button
                      onClick={() => {
                        const p = pending;
                        const clean = sanitizeEditedOutline(review.outline!);
                        setPending(null);
                        const dials = review.dials;
                        clearReview();
                        if (p && clean.pages.length) void execute(p.plan, p.reply, clean, dials);
                        else toast.error(tr("editor.the_outline_needs_at_least_one_page"));
                      }}
                      className="ms-auto rounded bg-brand-600 px-2.5 py-0.5 font-medium text-white hover:bg-brand-700"
                    >
                      {tr("editor.generate_with_this_outline")}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* T10: failed image resolutions offer a one-click retry. */}
      {failedImages > 0 && !busy && (
        <div className="mt-2 flex shrink-0 items-center gap-1.5">
          <button
            onClick={() => { setFailedImages(0); retryFailedAiImages(designId ?? ""); }}
            className="rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] text-amber-800 hover:border-amber-400"
          >
            {tr("editor.retry_images", { count: failedImages })}
          </button>
        </div>
      )}
      {/* Art-direction follow-ups, shown right after a design was generated. */}
      {lastWasDesign && !pending && !busy && (
        <div className="mt-2 flex shrink-0 flex-wrap gap-1.5">
          {designFollowups().map((f) => (
            <button key={f} onClick={() => void send(f)} className="rounded-full border border-neutral-200 bg-surface px-2.5 py-1 text-[11px] text-neutral-600 hover:border-brand-300 hover:text-brand-ink">{f}</button>
          ))}
        </div>
      )}

      {/* Source attachment (FR-23): paste text, fetch a URL, or pick a file;
          the next "create a deck from this" grounds its outline in it. */}
      {source && (
        <div className="mt-2 flex shrink-0 items-center gap-2 rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1.5 text-[11px] text-brand-ink">
          <FileText size={12} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={source.name}>{source.name} · {Math.round(source.text.length / 1000)}k chars</span>
          <button onClick={() => setSource(null)} aria-label={tr("editor.remove_attached_content")} className="rounded p-0.5 hover:bg-brand-100"><X size={12} /></button>
        </div>
      )}
      {attachOpen && !source && (
        <div className="mt-2 flex shrink-0 flex-col gap-1.5 rounded-lg border border-neutral-200 bg-neutral-50 p-2">
          <textarea
            placeholder={tr("editor.paste_text_or_notes_to_build_from")}
            rows={3}
            className="w-full resize-none rounded-md border border-neutral-200 bg-surface px-2 py-1.5 text-xs outline-none focus:border-brand-400"
            onBlur={(e) => {
              const t = e.target.value.trim();
              if (t) { setSource({ name: tr("editor.pasted_text"), text: t }); setAttachOpen(false); }
            }}
          />
          <div className="flex items-center gap-1.5">
            <input
              value={attachUrl}
              onChange={(e) => setAttachUrl(e.target.value)}
              placeholder="https://a-page-to-import…"
              className="min-w-0 flex-1 rounded-md border border-neutral-200 bg-surface px-2 py-1.5 text-xs outline-none focus:border-brand-400"
            />
            <button
              disabled={attachBusy || !/^https?:\/\//i.test(attachUrl.trim())}
              onClick={() => {
                const url = attachUrl.trim();
                setAttachBusy(true);
                void oc.aiExtractUrl({ url })
                  .then((r) => { setSource({ name: r.title || url, text: r.text }); setAttachOpen(false); setAttachUrl(""); })
                  .catch(() => toast.error(tr("editor.couldnt_read_that_page")))
                  .finally(() => setAttachBusy(false));
              }}
              className="rounded-md bg-neutral-900 px-2.5 py-1.5 text-xs font-medium text-surface disabled:opacity-40"
            >
              {attachBusy ? tr("editor.fetching") : tr("editor.fetch")}
            </button>
            <label className="cursor-pointer rounded-md border border-neutral-200 bg-surface px-2.5 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100">
              {tr("editor.file")}
              <input
                type="file"
                accept=".txt,.md,.markdown,.pdf,text/plain,text/markdown,application/pdf"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  setAttachBusy(true);
                  const finish = (text: string) => {
                    const t = text.trim();
                    if (t) { setSource({ name: f.name, text: t.slice(0, 60000) }); setAttachOpen(false); }
                    else toast.error(tr("editor.no_readable_text_in_that_file"));
                    setAttachBusy(false);
                  };
                  if (/\.pdf$/i.test(f.name) || f.type === "application/pdf") {
                    void pdfFileToText(f).then(finish).catch(() => { toast.error(tr("editor.couldnt_read_that_pdf")); setAttachBusy(false); });
                  } else {
                    void f.text().then(finish).catch(() => { toast.error(tr("editor.couldnt_read_that_file")); setAttachBusy(false); });
                  }
                }}
              />
            </label>
          </div>
        </div>
      )}

      {/* Composer, pinned to the bottom. */}
      <div className="mt-2 shrink-0">
        <div className="flex items-end gap-1.5 rounded-2xl border border-neutral-300 bg-surface px-2 py-1.5 focus-within:border-brand-400">
          <button
            onClick={() => setAttachOpen((v) => !v)}
            title={tr("editor.attach_content_to_build_from_paste_url_or_fi")}
            aria-label={tr("editor.attach_content")}
            className={`mb-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg ${attachOpen || source ? "bg-brand-50 text-brand-ink" : "text-neutral-400 hover:bg-neutral-100"}`}
          >
            <Paperclip size={15} />
          </button>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => { setInput(e.target.value); autosize(e.currentTarget); }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
            rows={1}
            placeholder={tr("editor.ask_anything")}
            disabled={!aiReady}
            className="max-h-[140px] flex-1 resize-none bg-transparent py-1 text-sm outline-none placeholder:text-neutral-400 disabled:opacity-50"
          />
          <button onClick={() => void send()} disabled={!canSend} title={tr("editor.send_enter")} className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-600 text-white transition hover:bg-brand-700 disabled:opacity-40">
            <Send size={15} />
          </button>
        </div>
        <div className="mt-1 flex items-center justify-between px-1">
          <p className="text-[10px] text-neutral-400">{tr("editor.enter_to_send_shift_enter_for_a_new_line")}</p>
          <button
            onClick={() => void genVector()}
            disabled={!canSend}
            title={tr("editor.draw_the_whole_design_as_an_editable_vector")}
            className="flex items-center gap-1 rounded-full border border-neutral-200 bg-surface px-2 py-0.5 text-[10px] text-neutral-500 hover:border-brand-300 hover:text-brand-ink disabled:opacity-40"
          >
            <Spline size={11} /> {tr("editor.vector_design")}
            <span className="rounded bg-brand-100 px-1 text-[9px] font-medium text-brand-ink">{tr("editor.beta")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Assist (F22 FR-8/FR-9/FR-11/FR-14): deterministic, AI-free polish tools --
// Critique, style harmonization, auto-layout, and auto-animate. Everything here
// reuses the pure analyzers in @/lib/assist plus the editor store's batched
// (one-undo-step) setters; no AI provider is needed.

const ISSUE_DOT: Record<CritiqueIssue["severity"], string> = {
  high: "bg-red-500",
  med: "bg-amber-500",
  low: "bg-neutral-400",
};

// Select a node and scroll/zoom to it on the canvas (mirrors the brand-lint UX).
function highlightNode(id: string): void {
  const st = useEditor.getState();
  if (!locate(st.doc, id)) return;
  st.select([id]);
  st.zoomToSelection();
}

function CritiqueSection() {
  const toast = useToast();
  // Re-derive on every doc mutation / page switch so fixes update the list live
  // (mirrors brand-lint), without a setState-in-effect. `active` gates the first
  // analysis to a user click.
  const rev = useEditor((s) => s.rev);
  const activePage = useEditor((s) => s.activePage);
  const [active, setActive] = useState(false);

  const run = useCallback(() => setActive(true), []);

  const issues = useMemo<CritiqueIssue[] | null>(() => {
    if (!active) return null;
    const st = useEditor.getState();
    return critiquePage(st.doc, st.activePage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, rev, activePage]);

  const applyFix = useCallback((issue: CritiqueIssue) => {
    if (!issue.fix) return;
    const st = useEditor.getState();
    const f = issue.fix;
    if (f.kind === "set_text_color") st.setTextColor(f.nodeId, f.hex);
    else if (f.kind === "move_into_bounds") st.moveNodeBy(f.nodeId, f.dx, f.dy);
    else if (f.kind === "align_nudge") st.moveNodeBy(f.nodeId, f.dx, f.dy);
    toast.success(tr("editor.fixed_2"));
  }, [toast]);

  const groups = (() => {
    const map = new Map<CritiqueIssue["category"], CritiqueIssue[]>();
    for (const i of issues ?? []) {
      const arr = map.get(i.category) ?? [];
      arr.push(i);
      map.set(i.category, arr);
    }
    return [...map.entries()];
  })();
  const clean = issues !== null && issues.length === 0;

  return (
    <section className="border-b border-neutral-100 pb-3 last:border-b-0 last:pb-0">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
          <Stethoscope size={14} /> {tr("editor.design_critique")}
        </span>
        <button onClick={run} className="rounded-md bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-brand-50 hover:text-brand-ink">
          {issues === null ? tr("editor.analyze") : tr("editor.re_analyze")}
        </button>
      </div>
      {issues === null && <p className="text-xs text-neutral-400">{tr("editor.analyze_this_page_for_contrast_off_canvas_al")}</p>}
      {clean && <p className="flex items-center gap-1.5 rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-700"><Sparkles size={13} /> {tr("editor.looks_good_no_issues_found")}</p>}
      {issues !== null && issues.length > 0 && (
        <div className="flex flex-col gap-3">
          {groups.map(([cat, items]) => (
            <div key={cat}>
              <div className="mb-1 text-[11px] font-semibold text-neutral-500">{categoryLabel[cat]} ({items.length})</div>
              <ul className="flex flex-col gap-1">
                {items.map((i) => (
                  <li key={i.id} className="rounded-lg border border-neutral-100 bg-neutral-50 px-2 py-1.5 text-xs">
                    <button onClick={() => i.nodeId && highlightNode(i.nodeId)} disabled={!i.nodeId} className="flex w-full items-start gap-1.5 text-start text-neutral-600 hover:text-brand-ink disabled:cursor-default disabled:hover:text-neutral-600" title={i.nodeId ? tr("editor.show_on_canvas") : undefined}>
                      <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${ISSUE_DOT[i.severity]}`} />
                      <span>{i.message}</span>
                    </button>
                    {i.fix && (
                      <button onClick={() => applyFix(i)} className="mt-1 ps-3 text-[11px] font-medium text-brand-ink hover:underline">{tr("editor.fix")}</button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function HarmonizeSection() {
  const toast = useToast();
  useEditor((s) => s.rev);
  const [proposal, setProposal] = useState<HarmonizeProposal | null>(null);

  const preview = useCallback(() => {
    const st = useEditor.getState();
    setProposal(harmonizeProposal(styleSamplesForPage(st.doc, st.activePage)));
  }, []);

  const apply = useCallback(() => {
    if (!proposal) return;
    const changes = [...proposal.fonts, ...proposal.colors, ...proposal.radii];
    const n = useEditor.getState().applyHarmonize(changes);
    setProposal(null);
    toast.success(n > 0 ? `Harmonized ${n} element${n === 1 ? "" : "s"}.` : "Nothing to harmonize.");
  }, [proposal, toast]);

  const changeCount = proposal ? proposal.fonts.length + proposal.colors.length + proposal.radii.length : 0;

  return (
    <section className="border-b border-neutral-100 pb-3 last:border-b-0 last:pb-0">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
          <Sparkles size={14} /> {tr("editor.harmonize_styles")}
        </span>
        <button onClick={preview} className="rounded-md bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-brand-50 hover:text-brand-ink">{tr("editor.preview")}</button>
      </div>
      {proposal === null && <p className="text-xs text-neutral-400">{tr("editor.collapse_fonts_snap_colors_to_a_few_roles_an")}</p>}
      {proposal !== null && !hasHarmonizeChanges(proposal) && (
        <p className="flex items-center gap-1.5 rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-700"><Sparkles size={13} /> {tr("editor.styles_already_consistent")}</p>
      )}
      {proposal !== null && hasHarmonizeChanges(proposal) && (
        <div className="flex flex-col gap-2 text-xs text-neutral-600">
          {proposal.fonts.length > 0 && (
            <div>
              <div className="mb-0.5 font-medium text-neutral-500">Fonts ({proposal.fonts.length})</div>
              <ul className="flex flex-col gap-0.5">
                {proposal.fonts.map((c, i) => <li key={i}>{c.from} <span className="text-neutral-400">{tr("editor.to")}</span> {c.to}</li>)}
              </ul>
            </div>
          )}
          {proposal.colors.length > 0 && (
            <div>
              <div className="mb-0.5 font-medium text-neutral-500">Colors ({proposal.colors.length})</div>
              <ul className="flex flex-col gap-0.5">
                {proposal.colors.map((c, i) => (
                  <li key={i} className="flex items-center gap-1.5">
                    <span className="h-3 w-3 rounded-sm border border-neutral-300" style={{ background: c.from }} />
                    <span className="text-neutral-400">{tr("editor.to")}</span>
                    <span className="h-3 w-3 rounded-sm border border-neutral-300" style={{ background: c.to }} />
                    <span className="text-neutral-400">({c.count})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {proposal.radii.length > 0 && (
            <div>
              <div className="mb-0.5 font-medium text-neutral-500">Corner radius ({proposal.radii.length})</div>
              <ul className="flex flex-col gap-0.5">
                {proposal.radii.map((c, i) => <li key={i}>{Math.round(c.from)} <span className="text-neutral-400">{tr("editor.to")}</span> {Math.round(c.to)}</li>)}
              </ul>
            </div>
          )}
          <Button block onClick={apply}><Wand2 size={15} /> Apply {changeCount} change{changeCount === 1 ? "" : "s"}</Button>
        </div>
      )}
    </section>
  );
}

function AutoLayoutSection() {
  const toast = useToast();
  const rev = useEditor((s) => s.rev);
  const activePage = useEditor((s) => s.activePage);
  const [active, setActive] = useState(false);

  const run = useCallback(() => setActive(true), []);

  const suggestions = useMemo<AutoLayoutSuggestion[] | null>(() => {
    if (!active) return null;
    const st = useEditor.getState();
    const { page, boxes } = elementBoxesForPage(st.doc, st.activePage);
    return page?.width ? autoLayoutSuggestions(boxes, page) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, rev, activePage]);

  const apply = useCallback((s: AutoLayoutSuggestion) => {
    const st = useEditor.getState();
    st.select(s.nodeIds);
    if (s.op === "align-left") st.alignSelection("left");
    else if (s.op === "align-top") st.alignSelection("top");
    else if (s.op === "distribute-h") st.distributeSelection("h", "gap");
    else if (s.op === "distribute-v") st.distributeSelection("v", "gap");
    else if (s.op === "tidy" || s.op === "fit") st.tidySelection();
    toast.success(`${s.label}.`);
  }, [toast]);

  return (
    <section className="border-b border-neutral-100 pb-3 last:border-b-0 last:pb-0">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
          <AlignStartVertical size={14} /> {tr("editor.auto_layout")}
        </span>
        <button onClick={run} className="rounded-md bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-brand-50 hover:text-brand-ink">{tr("editor.suggest")}</button>
      </div>
      {suggestions === null && <p className="text-xs text-neutral-400">{tr("editor.detect_misaligned_unevenly_spaced_or_stray_e")}</p>}
      {suggestions !== null && suggestions.length === 0 && (
        <p className="flex items-center gap-1.5 rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-700"><Sparkles size={13} /> {tr("editor.layout_looks_tidy")}</p>
      )}
      {suggestions !== null && suggestions.length > 0 && (
        <ul className="flex flex-col gap-1">
          {suggestions.map((s) => (
            <li key={s.op} className="flex items-center justify-between gap-2 rounded-lg border border-neutral-100 bg-neutral-50 px-2 py-1.5 text-xs text-neutral-600">
              <span>{s.label}</span>
              <button onClick={() => apply(s)} className="shrink-0 rounded-md border border-neutral-200 px-2 py-0.5 text-[11px] font-medium text-brand-ink hover:bg-surface">{tr("editor.apply")}</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AutoAnimateSection() {
  const toast = useToast();
  useEditor((s) => s.rev);
  const [style, setStyle] = useState<AnimateStyle>("fade");

  const apply = useCallback(() => {
    const st = useEditor.getState();
    const plan = autoAnimatePlan(animateBoxesForPage(st.doc, st.activePage), style);
    const n = st.autoAnimate(plan);
    if (n > 0) {
      toast.success(`Animated ${n} element${n === 1 ? "" : "s"}.`);
      st.playAnimations();
    } else {
      toast.toast(tr("editor.no_elements_to_animate"), "info");
    }
  }, [style, toast]);

  const clear = useCallback(() => {
    const n = useEditor.getState().clearPageAnimations();
    toast.success(n > 0 ? tr("editor.animations_cleared") : tr("editor.no_animations_to_clear"));
  }, [toast]);

  return (
    <section className="border-b border-neutral-100 pb-3 last:border-b-0 last:pb-0">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
        <Play size={14} /> {tr("editor.auto_animate")}
      </div>
      <p className="mb-2 text-xs text-neutral-400">{tr("editor.add_a_coherent_staggered_entrance_to_every_e")}</p>
      <div className="mb-2 grid grid-cols-3 gap-1">
        {animateStyles.map((s) => (
          <button
            key={s.id}
            onClick={() => setStyle(s.id)}
            className={`rounded-md border px-2 py-1 text-xs font-medium ${style === s.id ? "border-brand-300 bg-brand-50 text-brand-ink" : "border-neutral-200 text-neutral-600 hover:bg-neutral-100"}`}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <Button className="flex-1" onClick={apply}><Play size={15} /> {tr("editor.animate")}</Button>
        <Button variant="secondary" onClick={clear}>{tr("editor.clear")}</Button>
      </div>
    </section>
  );
}

/** The Assist section (F22 FR-8/9/11/14): deterministic polish tools that work
 *  without an AI provider. Shown inside the AI panel. */
export function PolishPanel() {
  return (
    <div className="flex flex-col gap-3">
      <CritiqueSection />
      <HarmonizeSection />
      <AutoLayoutSection />
      <AutoAnimateSection />
    </div>
  );
}

// Offline fallback shown if GET /ai/providers is unreachable; the server
// registry drives the dropdown (and the model placeholder hints) whenever it
// loads, so these only need the ids, URL flags, and defaults to stay usable.
const FALLBACK_PRESETS: AiProviderPreset[] = [
  { id: "openai", label: "OpenAI", baseUrl: "", defaultModel: "gpt-4o-mini", defaultImageModel: "dall-e-3", capabilities: { text: true, image: true, describeImage: true, editImage: true } },
  { id: "anthropic", label: "Anthropic (Claude)", baseUrl: "", defaultModel: "claude-opus-4-8", capabilities: { text: true, image: false, describeImage: true, editImage: false } },
  { id: "deepseek", label: "DeepSeek", baseUrl: "", defaultModel: "deepseek-chat", capabilities: { text: true, image: false, describeImage: false, editImage: false } },
  { id: "zhipu", label: "Zhipu AI (GLM)", baseUrl: "", defaultModel: "glm-4.6", defaultImageModel: "cogview-4-250304", capabilities: { text: true, image: true, describeImage: false, editImage: false } },
  { id: "google", label: "Google (Gemini)", baseUrl: "", defaultModel: "gemini-1.5-flash", capabilities: { text: true, image: false, describeImage: true, editImage: false } },
  { id: "mistral", label: "Mistral", baseUrl: "", defaultModel: "mistral-large-latest", capabilities: { text: true, image: false, describeImage: false, editImage: false } },
  { id: "groq", label: "Groq", baseUrl: "", defaultModel: "llama-3.3-70b-versatile", capabilities: { text: true, image: false, describeImage: false, editImage: false } },
  { id: "together", label: "Together AI", baseUrl: "", defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo", defaultImageModel: "black-forest-labs/FLUX.1-schnell", capabilities: { text: true, image: true, describeImage: false, editImage: false } },
  { id: "openrouter", label: "OpenRouter", baseUrl: "", defaultModel: "openai/gpt-4o-mini", capabilities: { text: true, image: false, describeImage: false, editImage: false } },
  { id: "azure-openai", label: "Azure OpenAI", baseUrl: "", defaultModel: "gpt-4o-mini", defaultImageModel: "dall-e-3", capabilities: { text: true, image: true, describeImage: true, editImage: false }, needsBaseUrl: true },
  { id: "custom", label: "Custom (OpenAI-compatible)", baseUrl: "", defaultModel: "", capabilities: { text: true, image: true, describeImage: true, editImage: true }, needsBaseUrl: true },
];

// Last known server provider catalog, shared by every AiPanel mount: seeds
// the dropdown instantly, while each mount still revalidates in the
// background (stale-while-revalidate) so a long-lived tab converges after a
// self-host binary swap.
let providerCatalogCache: AiProviderPreset[] | null = null;

export function AiPanel({ workspaceId }: { workspaceId: string | null }) {
  const toast = useToast();
  // Re-render when the doc changes so the brand-voice indicator stays current.
  useEditor((s) => s.rev);
  // The active design's brand voice, already loaded by EditorApp via
  // useBrand.setDesign, so reading it here needs no extra fetch (FR-7).
  const brandVoice = useBrand((s) => s.kit?.voice ?? null);
  // The active brand kit's approved colors as hex, passed to Magic Design so
  // generated layouts can stay on-brand (FR-4). Flattened across palettes.
  // Select the STABLE palettes reference from the store and derive the hex list
  // in useMemo; deriving a fresh array inside the selector returns a new
  // snapshot every render and makes useSyncExternalStore loop forever.
  const palettes = useBrand((s) => s.kit?.palettes ?? null);
  const brandPalette = useMemo(
    () => (palettes ?? []).flatMap((p) => p.colors.map((c) => toHex(c.value))),
    [palettes],
  );
  // Brand fonts by role, passed to studio generation so decks use the brand
  // type, not the system default (F39 FR-17).
  const brandFontList = useBrand((s) => s.kit?.fonts ?? null);
  const brandFonts = useMemo<{ heading?: string; body?: string }>(() => {
    const fonts = brandFontList ?? [];
    const byRole = (m: string) => fonts.find((f) => f.role?.toLowerCase().includes(m))?.fontFamily;
    const heading = byRole("head") ?? byRole("title") ?? fonts[0]?.fontFamily;
    const body = byRole("body") ?? byRole("text") ?? byRole("para") ?? fonts[fonts.length - 1]?.fontFamily;
    return { heading, body };
  }, [brandFontList]);
  // Let the user bypass brand-voice grounding for the very next action.
  const [ignoreVoice, setIgnoreVoice] = useState(false);
  const voiceClause = !ignoreVoice ? brandVoiceClause(brandVoice) : "";
  const [config, setConfig] = useState<AiConfigView | null>(null);
  const [loading, setLoading] = useState(true);
  const [showConfig, setShowConfig] = useState(false);
  const [provider, setProvider] = useState("openai");
  const [model, setModel] = useState("");
  const [imageModel, setImageModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  // The server's preset catalog drives the dropdown (11 providers, defaults,
  // capabilities); the hardcoded fallback only covers the never-fetched case.
  // Seeded from the shared cache, revalidated by the load effect below.
  const [presets, setPresets] = useState<AiProviderPreset[]>(providerCatalogCache ?? FALLBACK_PRESETS);

  // A failed settings load is NOT "no config yet": showing the setup form on
  // a transient error invites a save the server would reject as a keyless
  // provider change. Track failure separately and offer a retry instead.
  // loadNonce re-arms the effect for that retry.
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadNonce, setLoadNonce] = useState(0);

  // Re-arm the panel when the workspace changes (render-time state adjustment,
  // the React pattern for prop-driven resets): never show the previous
  // workspace's form state while the new fetch is in flight.
  const [armedFor, setArmedFor] = useState(workspaceId);
  if (workspaceId !== armedFor) {
    setArmedFor(workspaceId);
    setLoading(true);
    setLoadFailed(false);
  }

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void (async () => {
      const loaded = await oc.getAiConfig(workspaceId).then(
        (c) => ({ ok: true as const, c }),
        () => ({ ok: false as const, c: null }),
      );
      if (cancelled) return;
      setLoadFailed(!loaded.ok);
      const c = loaded.c;
      setConfig(c);
      setShowConfig(loaded.ok && !c?.hasKey);
      setProvider(c?.provider ?? "openai");
      setModel(c?.model ?? "");
      setImageModel(c?.imageModel ?? "");
      setBaseUrl(c?.baseUrl ?? "");
      setApiKey("");
      setLoading(false);
    })();
    // Revalidate the provider catalog WITHOUT gating panel readiness on it
    // (a hung catalog request must not hold the spinner): the cache/fallback
    // already seeded the dropdown, and a fresh fetch converges a long-lived
    // tab after a self-host binary swap.
    void oc.aiProviders().then(
      (list) => {
        if (!cancelled && list?.length) { providerCatalogCache = list; setPresets(list); }
      },
      () => {},
    );
    return () => { cancelled = true; };
  }, [workspaceId, loadNonce]);

  // The selected provider's preset drives the field set and hints. Three
  // distinct base-URL concerns, deliberately decoupled:
  // - requiresBaseUrl: the preset demands one (Azure/custom); gates the save.
  // - showBaseUrl: the field also renders whenever the SAME provider already
  //   stores a URL (an API-configured proxy on e.g. openai, or a legacy id),
  //   so a stored URL is always visible, auditable, and clearable. Latched on
  //   the loaded config, never the live input, so emptying it cannot unmount
  //   the field. Hidden again the moment another provider is selected - a
  //   stale URL (or stale field state) must never follow a provider switch.
  const selPreset = presets.find((p) => p.id === provider);
  const requiresBaseUrl = !!selPreset?.needsBaseUrl;
  const sameProvider = provider === config?.provider;
  const showBaseUrl = requiresBaseUrl || (sameProvider && !!config?.baseUrl);
  const modelHint = selPreset?.defaultModel ?? "";

  async function saveConfig() {
    if (!workspaceId) return;
    const url = baseUrl.trim();
    // Endpoint-routed providers are unusable without their URL; the server
    // rejects the save too (ai_base_url_required), but catching it here points
    // at the field without a round trip.
    if (requiresBaseUrl && !url) {
      toast.error(tr("errors.api_ai_base_url_required"));
      return;
    }
    // A provider change must bring the new provider's key (the server rejects
    // it as ai_key_required_for_provider_change); say so before the round trip.
    if (!sameProvider && config?.hasKey && !apiKey.trim()) {
      toast.error(tr("errors.api_ai_key_required_for_provider_change"));
      return;
    }
    try {
      // baseUrl uses PATCH semantics server-side: omitted (undefined) keeps
      // the stored URL - and the server itself clears it on a provider change
      // - while a rendered field sends its exact value, so emptying a visible
      // field is an explicit clear. Stale client state can no longer leak a
      // URL across providers or silently wipe one.
      const c = await oc.setAiConfig(workspaceId, {
        provider,
        model: model || undefined,
        imageModel: imageModel || undefined,
        baseUrl: showBaseUrl ? url : undefined,
        apiKey: apiKey || undefined,
      });
      setConfig(c);
      setApiKey("");
      setShowConfig(false);
      toast.success(tr("editor.ai_provider_saved"));
    } catch (e) {
      // Show the server's coded reason when it sent one (e.g. a rejected base
      // URL); the generic save error stays the fallback.
      const coded = e instanceof ApiError ? apiCodeMessage(e.body) : null;
      toast.error(coded ?? tr("editor.could_not_save_ai_settings"));
    }
  }

  // The chat view fills the panel height (input pinned, messages scroll); the
  // setup/connect view scrolls normally.
  const chatView = !!workspaceId && !loading && !showConfig && !!config?.hasKey;
  // Whether the configured provider can generate images (gates AI imagery in
  // generated designs). DeepSeek/Anthropic are text-only; OpenAI/custom can.
  const imageCapable = !!config?.capabilities?.image;
  const editImageCapable = !!config?.capabilities?.editImage;

  return (
    <PanelShell title="AI" fill={chatView}>
      {!workspaceId ? (
        <p className="mt-4 text-center text-xs text-neutral-400">{tr("editor.open_a_saved_design_to_use_ai")}</p>
      ) : loading ? (
        <div className="grid place-items-center py-8 text-neutral-400"><Spinner /></div>
      ) : loadFailed ? (
        // A transient load failure must NOT render the setup form: it starts
        // blank on the default provider, and one Save from there is a rejected
        // (key-required) provider change. Offer a retry - announced to
        // assistive tech - and keep the no-AI tools reachable: they never
        // depended on this fetch.
        <div className="flex flex-col gap-3">
          <div role="alert" className="flex flex-col items-center gap-2 py-8 text-center">
            <p className="text-xs text-neutral-500">{tr("editor.couldnt_load_ai_settings")}</p>
            <button
              onClick={() => { setLoading(true); setLoadFailed(false); setLoadNonce((n) => n + 1); }}
              className="rounded border border-neutral-300 px-2.5 py-1 text-xs text-neutral-600 hover:border-brand-300 hover:text-brand-ink"
            >
              {tr("editor.retry")}
            </button>
          </div>
          <CollapsibleSection title={tr("editor.assist_no_ai_needed")} icon={Stethoscope}>
            <PolishPanel />
          </CollapsibleSection>
        </div>
      ) : showConfig || !config?.hasKey ? (
        <div className="flex flex-col gap-3">
          <div>
            <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-neutral-700">
              <Settings2 size={14} className="text-brand-500" /> {tr("editor.connect_an_ai_provider")}
            </div>
            <p className="mb-2.5 text-[11px] text-neutral-500">{tr("editor.bring_your_own_key_it_is_stored_encrypted_an")}</p>
            <p className="mb-2.5 flex items-start gap-1.5 rounded-md bg-brand-50 px-2 py-1.5 text-[11px] text-brand-ink">
              <Wand2 size={12} className="mt-px shrink-0" />
              <span>{tr("editor.connect_a_provider_to_unlock")} <span className="font-medium">{tr("editor.magic_design")}</span> (text to a finished page) and image generation. The tools below work without AI.</span>
            </p>
            <div className="flex flex-col gap-2">
              <select value={provider} onChange={(e) => setProvider(e.target.value)} className="rounded border border-neutral-300 px-2 py-1.5 text-sm">
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
                {/* A stored provider missing from the catalog (legacy row) stays selectable. */}
                {!selPreset && <option value={provider}>{provider}</option>}
              </select>
              <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={modelHint ? `Model (optional, default ${modelHint})` : tr("editor.model_optional")} className="rounded border border-neutral-300 px-2 py-1.5 text-sm" />
              {(selPreset?.capabilities.image ?? true) && (
                <input value={imageModel} onChange={(e) => setImageModel(e.target.value)} placeholder={selPreset?.defaultImageModel ? `Image model (optional, default ${selPreset.defaultImageModel})` : tr("editor.image_model_optional")} className="rounded border border-neutral-300 px-2 py-1.5 text-sm" />
              )}
              {showBaseUrl && (
                <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={tr("editor.base_url_https_v1")} className="rounded border border-neutral-300 px-2 py-1.5 text-sm" />
              )}
              <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={config?.hasKey ? tr("editor.api_key_leave_blank_to_keep") : tr("editor.api_key")} className="rounded border border-neutral-300 px-2 py-1.5 text-sm" />
              <Button block onClick={() => void saveConfig()} disabled={!workspaceId}>{tr("editor.save_provider")}</Button>
              {config?.hasKey && (
                <button onClick={() => setShowConfig(false)} className="text-xs text-neutral-500 hover:underline">{tr("editor.cancel")}</button>
              )}
            </div>
          </div>
          {/* Deterministic polish tools that work with no provider connected. */}
          <CollapsibleSection title={tr("editor.assist_no_ai_needed")} icon={Stethoscope}>
            <PolishPanel />
          </CollapsibleSection>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          {/* Provider status bar with quick access to settings. */}
          <div className="flex shrink-0 items-center justify-between rounded-lg bg-neutral-50 px-2.5 py-1.5 text-xs">
            <span className="flex items-center gap-1.5 text-neutral-500">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              {tr("editor.provider")} <span className="font-medium text-neutral-700">{config.provider}</span>
            </span>
            <button onClick={() => setShowConfig(true)} title={tr("editor.ai_settings")} className="text-neutral-400 hover:text-neutral-700"><Settings2 size={15} /></button>
          </div>
          {/* Capability nudge: this provider can't generate images, so designs
              come out text + color only. Point the user at an image-capable one. */}
          {!imageCapable && (
            <div className="flex shrink-0 items-start gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-700">
              <ImagePlus size={12} className="mt-px shrink-0" />
              <span>{tr("editor.provider_text_only_hint")}</span>
            </div>
          )}
          {/* Brand-voice grounding indicator (F21 FR-6/FR-7). Shows when the
              design has a voice; lets the user ignore it for the next action. */}
          {brandVoice && brandVoiceClause(brandVoice) && (
            <div className="flex shrink-0 items-center justify-between gap-2 rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1.5 text-[11px] text-brand-ink">
              <span className="flex items-center gap-1.5">
                <Wand2 size={12} />
                {ignoreVoice ? tr("editor.brand_voice_off") : `Using brand voice: ${brandVoiceLabel(brandVoice)}`}
              </span>
              <button
                onClick={() => setIgnoreVoice((v) => !v)}
                title={ignoreVoice ? tr("editor.use_the_brand_voice_in_ai_writing_again") : tr("editor.stop_grounding_ai_writing_in_the_brand_voice")}
                className="shrink-0 rounded px-1 font-medium underline-offset-2 hover:underline"
              >
                {ignoreVoice ? tr("editor.turn_on") : tr("editor.turn_off")}
              </button>
            </div>
          )}

          {/* Single conversational surface: one thread plans and applies every
              capability (write, image, whole-design, restyle, chart, critique).
              The model routes the intent to the right tool from the catalog. */}
          <AssistantPanel workspaceId={workspaceId} aiReady voiceClause={voiceClause} brandPalette={brandPalette} brandFonts={brandFonts} imageCapable={imageCapable} editImageCapable={editImageCapable} />
        </div>
      )}
    </PanelShell>
  );
}

const stockKinds = (): { label: string; kind: string }[] => [
  { label: tr("editor.all"), kind: "" },
  { label: tr("editor.photos"), kind: "photo" },
  { label: tr("editor.illustrations"), kind: "illustration" },
  { label: tr("editor.icons"), kind: "icon" },
  { label: tr("editor.emoji"), kind: "sticker" },
];

const stockChipCls = (active: boolean) =>
  `whitespace-nowrap rounded-full border px-2.5 py-1 text-xs ${active ? "border-brand-500 bg-brand-50 text-brand-ink" : "border-neutral-200 text-neutral-600 hover:bg-neutral-100"}`;

// Facet ids are catalog slugs; render them as words ("health" -> "Health").
const FACET_LABELS: Record<string, string> = { ui: "UI" };
const facetLabel = (id: string) => FACET_LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);

// One facet row (category/style/orientation) below the kind chips. Values come
// from /stock/filters aggregated per kind server-side, so new packs or
// orientations surface automatically with no frontend change. Hidden unless
// the active kind has at least two values to choose between.
function FacetChips({ label, values, active, onPick }: { label: string; values: StockFacetValue[]; active: string; onPick: (id: string) => void }) {
  if (values.length < 2) return null;
  return (
    <div className="mb-2">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">{label}</p>
      <div className="flex flex-wrap gap-1">
        <button onClick={() => onPick("")} className={stockChipCls(active === "")}>{tr("editor.all")}</button>
        {values.map((v) => (
          <button key={v.id} onClick={() => onPick(v.id)} title={`${v.count} asset${v.count === 1 ? "" : "s"}`} className={stockChipCls(active === v.id)}>{facetLabel(v.id)}</button>
        ))}
      </div>
    </div>
  );
}

type StockTab = "browse" | "favorites" | "recents";

// Live-provider assets (Openverse photos, Iconify icons) are not in the bundled
// catalog: favorites/recents don't apply, drag-to-canvas is disabled, and
// placement imports/inlines the asset rather than proxying a URL. The `live`
// flag is the source of truth; the pack check keeps older cached photos working.
const isProviderAsset = (a: StockAssetSummary) => a.live === true || a.pack === "openverse";

// Provenance stamped on every stock insert (asset id + license) so
// attribution-required assets compile into the design's credits.
const stockProvenance = (a: StockAssetSummary): Record<string, unknown> =>
  ({ origin: "stock", stockAssetId: a.id, ...(a.license ? { license: a.license } : {}) });

// Place a stock asset onto the canvas and record it as recently used. Icons
// carry inline SVG and insert as editable vectors; bundled photos go through
// the proxy; provider photos are imported into the workspace's uploads first so
// the design never depends on an external host.
async function placeStock(a: StockAssetSummary, toast: ReturnType<typeof useToast>, workspaceId: string | null) {
  const provenance = stockProvenance(a);
  if (a.svg) {
    // Editable-vector insert, with provenance (asset id + license) stamped in the
    // same undo step so CC-BY packs compile into the design's attribution.
    useEditor.getState().addIconSvg(a.svg, provenance);
  } else if (isProviderAsset(a) && a.sourceUrl) {
    if (!workspaceId) {
      toast.toast(tr("editor.open_a_workspace_design_to_place_photos"), "info");
      return;
    }
    try {
      const up = await oc.importAssetFromUrl(workspaceId, a.sourceUrl);
      // resolveAssetUrl: the backend returns a relative content path; in dev the
      // frontend origin differs from the API's, same as the Uploads grid.
      placeImage(resolveAssetUrl(up.url), provenance);
    } catch {
      toast.toast(tr("editor.couldnt_add_this_photo_try_another_one"), "error");
    }
    return; // provider assets have no recents entry in the bundled catalog
  } else if (a.sourceUrl) {
    // data/blob URLs load directly; remote photos go through our proxy so the
    // export canvas stays untainted (CORS-clean). Fills a selected frame if any.
    placeImage(/^(data:|blob:)/.test(a.sourceUrl) ? a.sourceUrl : stockProxyUrl(a.sourceUrl), provenance);
  } else {
    toast.toast(tr("editor.this_asset_isnt_placeable"), "info");
    return;
  }
  // Fire-and-forget: recording a recent should never block insertion. Live
  // provider assets aren't in the bundled catalog, so recents don't apply (the
  // backend would 404 on their id); only record bundled assets.
  if (!isProviderAsset(a)) void oc.recordStockRecent(a.id).catch(() => {});
}

function StockTile({ a, onPlace, onToggleStar }: { a: StockAssetSummary; onPlace: (a: StockAssetSummary) => void; onToggleStar: (a: StockAssetSummary) => void }) {
  // Provider photos import on click (an async step the drop handler can't do),
  // so drag-to-canvas is bundled-catalog only.
  const draggable = !!a.sourceUrl && !isProviderAsset(a);
  return (
    <div className="group relative">
      <button
        onClick={() => onPlace(a)}
        draggable={draggable}
        onDragStart={(e) => {
          if (!draggable || !a.sourceUrl) return;
          e.dataTransfer.setData("application/x-oc-image", /^(data:|blob:)/.test(a.sourceUrl) ? a.sourceUrl : stockProxyUrl(a.sourceUrl));
          // The drop handler stamps this on the created node so drag-placed
          // stock keeps its attribution credit, same as click-to-place.
          e.dataTransfer.setData("application/x-oc-provenance", JSON.stringify(stockProvenance(a)));
        }}
        title={draggable ? tr("editor.click_to_place_or_drag_onto_the_canvas") : a.sourceUrl ? tr("editor.click_to_place") : a.title}
        className="grid aspect-square w-full place-items-center overflow-hidden rounded-lg border border-neutral-200 hover:border-brand-300"
      >
        {a.svg ? (
          // Vector assets (bundled packs AND live Iconify icons) carry inline
          // SVG; render it directly. Preferring it over previewUrl keeps the
          // preview crisp and recolorable, avoids a remote request per tile, and
          // never leaks the viewer's IP to a provider host for a live icon.
          <span aria-hidden className="block h-full w-full p-2 [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: a.svg }} />
        ) : a.previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={a.previewUrl} alt={a.title} className="h-full w-full object-cover" />
        ) : (
          <span className="px-1 text-center text-[11px] text-neutral-500">{a.title}</span>
        )}
      </button>
      {!isProviderAsset(a) && (
        <button
          onClick={(e) => { e.stopPropagation(); onToggleStar(a); }}
          title={a.favorited ? tr("editor.remove_from_favorites") : tr("editor.add_to_favorites")}
          aria-pressed={!!a.favorited}
          className={`absolute end-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-surface/90 shadow transition ${a.favorited ? "text-amber-500" : "text-neutral-400 opacity-0 group-hover:opacity-100 hover:text-amber-500"}`}
        >
          <Star size={13} fill={a.favorited ? "currentColor" : "none"} />
        </button>
      )}
    </div>
  );
}

// Intent search: map a plain-language phrase to a catalog-friendly term before
// searching (the catalog matches the query as one substring, so this maps
// "something for a party" -> "celebration"). Deterministic, no AI; the AI studio
// (F39) is where true semantic search lands. Unknown queries pass through.
const INTENT_SYNONYMS: { match: RegExp; term: string }[] = [
  { match: /\b(party|celebrat|birthday|festive)\w*/i, term: "celebration" },
  { match: /\b(happy|joy|smile|fun)\w*/i, term: "happy" },
  { match: /\b(love|romance|valentine|heart)\w*/i, term: "heart" },
  { match: /\b(nature|outdoor|landscape|scenery)\w*/i, term: "nature" },
  { match: /\b(work|office|business|corporate|meeting)\w*/i, term: "business" },
  { match: /\b(food|eat|meal|restaurant|cuisine)\w*/i, term: "food" },
  { match: /\b(tech|computer|digital|device|gadget)\w*/i, term: "technology" },
  { match: /\b(money|finance|cash|payment|shopping|buy)\w*/i, term: "shopping" },
  { match: /\b(travel|trip|vacation|holiday|journey)\w*/i, term: "travel" },
  { match: /\b(arrow|pointer|direction)\w*/i, term: "arrow" },
];
function intentQuery(q: string): string {
  const trimmed = q.trim();
  if (!trimmed) return "";
  // Only remap multi-word, intent-like phrases; leave a precise single keyword alone.
  if (!/\s/.test(trimmed)) return trimmed;
  for (const { match, term } of INTENT_SYNONYMS) if (match.test(trimmed)) return term;
  return trimmed;
}

// Animated stickers: editable-vector graphics paired with a looping emphasis
// preset, applied to the inserted node so it moves in play/present.
const animatedStickers = (): { id: string; label: string; preset: "pulse" | "spin" | "wiggle" | "bob" | "flicker"; svg: string }[] => [
  { id: "a-star", label: tr("editor.spinning_star"), preset: "spin", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2 L15 9 L22 9 L16 14 L18 21 L12 17 L6 21 L8 14 L2 9 L9 9 Z" fill="#f5b301"/></svg>' },
  { id: "a-heart", label: tr("editor.pulsing_heart"), preset: "pulse", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 21 C 4 14 4 6 9 6 C 11 6 12 8 12 8 C 12 8 13 6 15 6 C 20 6 20 14 12 21 Z" fill="#e0245e"/></svg>' },
  { id: "a-bell", label: tr("editor.wiggling_bell"), preset: "wiggle", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 3 C 8 3 7 6 7 10 C 7 14 5 16 5 16 L 19 16 C 19 16 17 14 17 10 C 17 6 16 3 12 3 Z M 10 19 a 2 2 0 0 0 4 0 Z" fill="#6366f1"/></svg>' },
  { id: "a-dot", label: tr("editor.bouncing_dot"), preset: "bob", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="#22c55e"/></svg>' },
  { id: "a-spark", label: tr("editor.flickering_spark"), preset: "flicker", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2 L13.5 10.5 L22 12 L13.5 13.5 L12 22 L10.5 13.5 L2 12 L10.5 10.5 Z" fill="#f59e0b"/></svg>' },
];

export function StockPanel({ workspaceId }: { workspaceId: string | null }) {
  const toast = useToast();
  const [tab, setTab] = useState<StockTab>("browse");
  const [query, setQuery] = useState("");
  // Debounce the live search so a refetch fires after typing stops, not per key.
  const debouncedQuery = useDebouncedValue(query);
  const [kind, setKind] = useState("");
  // Facet filters (category/style/orientation/source), kind-scoped; "" means all.
  const [category, setCategory] = useState("");
  const [style, setStyle] = useState("");
  const [orientation, setOrientation] = useState("");
  // Source is a bundled-pack filter (ManyPixels, Open Doodles, Tabler, ...),
  // offered as a facet once a kind is picked. Pack assets carry the pack id in
  // collectionIds, so it rides the same collection query param.
  const [source, setSource] = useState("");
  const [filters, setFilters] = useState<StockFiltersSummary | null>(null);
  // Loaded only to derive the per-kind Source facet (bundled packs); there is no
  // curated-collections row.
  const [collections, setCollections] = useState<StockCollectionSummary[]>([]);
  const [results, setResults] = useState<StockAssetSummary[]>([]);
  const [loading, setLoading] = useState(true);
  // Track a fetch ERROR separately from an empty catalog so an unreachable
  // provider shows a retry affordance rather than the "no results" message.
  const [error, setError] = useState(false);
  // Bump to force a retry of the active tab's fetch effect.
  const [retryNonce, setRetryNonce] = useState(0);

  // Load the pack list (for the per-kind Source facet) and filter facets. Keyed
  // on retryNonce so the results-area Retry button also heals a failed load here
  // (a miss would otherwise hide the Source facet and facets for the panel's
  // lifetime), keeping whatever already loaded when a refetch fails.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [c, f] = await Promise.all([
        oc.stockCollections().catch(() => []),
        oc.stockFilters().catch(() => null),
      ]);
      if (!cancelled) {
        setCollections((cur) => (c.length ? c : cur));
        setFilters((cur) => f ?? cur);
      }
    })();
    return () => { cancelled = true; };
  }, [retryNonce]);

  // Load the active tab's contents. Distinguishes a failed fetch (error banner +
  // retry) from a genuinely empty result (the "no results" message). Browse
  // results are paged (the bundled library holds ~10k assets): a full page means
  // more may follow, surfaced as a "Load more" button.
  const STOCK_PAGE = 60;
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Generation guard: the SDK has no request cancellation, so an in-flight
  // "Load more" must drop its append when a filter/query change has already
  // replaced the grid (a stale page would violate the active filters).
  const fetchGen = useRef(0);
  // Next page's offset, advanced by a fixed page size rather than results.length.
  // The merged "All" search can return a page that id-dedups against what's
  // already shown (a live provider flapping between pages); paging by
  // results.length would then drift below the true backend offset and compound
  // skips, so track the offset explicitly instead.
  const nextOffset = useRef(STOCK_PAGE);
  useEffect(() => {
    let cancelled = false;
    fetchGen.current += 1;
    void (async () => {
      setLoading(true);
      setError(false);
      try {
        let r: StockAssetSummary[];
        if (tab === "favorites") r = await oc.stockFavorites();
        else if (tab === "recents") r = await oc.stockRecent();
        else r = await oc.stockSearch(intentQuery(debouncedQuery) || undefined, kind || undefined, { category: category || undefined, style: style || undefined, orientation: orientation || undefined, collection: source || undefined, limit: STOCK_PAGE });
        if (!cancelled) { setResults(r); setHasMore(tab === "browse" && r.length === STOCK_PAGE); nextOffset.current = STOCK_PAGE; }
      } catch {
        if (!cancelled) { setResults([]); setError(true); setHasMore(false); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // Re-run when the tab, filters, debounced query, kind, or source change.
  }, [tab, debouncedQuery, kind, category, style, orientation, source, retryNonce]);

  async function loadMore() {
    if (loadingMore) return;
    setLoadingMore(true);
    const gen = fetchGen.current;
    const offset = nextOffset.current;
    try {
      const next = await oc.stockSearch(intentQuery(debouncedQuery) || undefined, kind || undefined, {
        category: category || undefined, style: style || undefined, orientation: orientation || undefined,
        collection: source || undefined, limit: STOCK_PAGE, offset,
      });
      if (gen !== fetchGen.current) return; // filters changed mid-flight; the grid was replaced
      nextOffset.current = offset + STOCK_PAGE;
      setResults((cur) => [...cur, ...next.filter((n) => !cur.some((c) => c.id === n.id))]);
      setHasMore(next.length === STOCK_PAGE);
    } catch {
      if (gen === fetchGen.current) setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setTab("browse");
    // Submitting from a non-browse tab routes back to browse; the effect refetches.
  }
  function setFilter(k: string) {
    setKind(k);
    // Facets are kind-scoped; switching kind resets them.
    setCategory(""); setStyle(""); setOrientation(""); setSource("");
    setTab("browse");
  }

  function place(a: StockAssetSummary) {
    void placeStock(a, toast, workspaceId);
  }

  // Toggle a favorite and reflect it optimistically in the current list. On the
  // Favorites tab an un-star removes the tile.
  async function toggleStar(a: StockAssetSummary) {
    const { favorited } = await oc.toggleStockFavorite(a.id).catch(() => ({ favorited: a.favorited ?? false }));
    setResults((cur) =>
      tab === "favorites" && !favorited
        ? cur.filter((x) => x.id !== a.id)
        : cur.map((x) => (x.id === a.id ? { ...x, favorited } : x)),
    );
  }

  const TABS: { id: StockTab; label: string; icon: typeof Star }[] = [
    { id: "browse", label: tr("editor.browse"), icon: LayoutGrid },
    { id: "favorites", label: tr("editor.favorites"), icon: Star },
    { id: "recents", label: tr("editor.recent"), icon: Clock },
  ];

  // Bundled packs surface as a per-kind Source facet (e.g. illustration packs
  // under the Illustrations kind); there is no curated-collections section.
  const packSources = collections.filter((c) => c.source === "pack" && c.kind === kind);

  const emptyMessage =
    tab === "favorites" ? tr("editor.no_favorites_yet_tap_the_star_on_any_asset") :
    tab === "recents" ? tr("editor.nothing_placed_yet") :
    // Name the facet as a cause alongside the query: with both active, the
    // facet is often the real constraint (and on photos it also switches the
    // search from the live provider to the bundled library).
    debouncedQuery && (category || style || orientation) ? `No results for “${debouncedQuery}” with these filters. Try clearing a filter.` :
    debouncedQuery ? `No results for “${debouncedQuery}”.` :
    category || style || orientation ? tr("editor.nothing_matches_these_filters") :
    tr("editor.no_stock_assets_available");

  return (
    <PanelShell title={tr("editor.stock")}>
      <div className="mb-3 flex gap-1">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} aria-pressed={tab === t.id} className={`flex flex-1 items-center justify-center gap-1 rounded-lg border px-2 py-1.5 text-xs font-medium ${tab === t.id ? "border-brand-500 bg-brand-50 text-brand-ink" : "border-neutral-200 text-neutral-600 hover:bg-neutral-100"}`}>
            <t.icon size={13} />{t.label}
          </button>
        ))}
      </div>

      {tab === "browse" && (
        <>
          <form onSubmit={onSubmit} className="relative mb-2">
            <Search size={15} className="absolute start-3 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tr("editor.search_photos_icons")} className="h-9 w-full rounded-lg border border-neutral-200 ps-9 pe-9 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100" />
            {query && (
              <button type="button" onClick={() => setQuery("")} title={tr("editor.clear_search")} className="absolute end-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded text-neutral-400 hover:text-neutral-700">
                <X size={14} />
              </button>
            )}
          </form>
          {/* Chips size to their labels and wrap: flex-1 in a no-wrap row made the
              five kinds overflow the panel sideways (flex items can't shrink
              below their text), which read as the whole panel sliding. */}
          <div className="mb-3 flex flex-wrap gap-1">
            {stockKinds().map((f) => (
              <button key={f.label} onClick={() => setFilter(f.kind)} className={stockChipCls(kind === f.kind)}>{f.label}</button>
            ))}
          </div>
          {/* Source: the bundled packs for this kind (illustrations -> Open
              Doodles / ManyPixels / Open Peeps / Lukasz Adam; icons -> Tabler /
              Health). Shown under the active kind; there is no separate
              Collections section. */}
          {kind && packSources.length >= 2 && (
            <div className="mb-2">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">{tr("editor.source")}</p>
              <div className="flex flex-wrap gap-1">
                <button onClick={() => setSource("")} className={stockChipCls(source === "")}>{tr("editor.all")}</button>
                {packSources.map((c) => (
                  <button key={c.id} onClick={() => setSource(source === c.id ? "" : c.id)} title={c.description} className={stockChipCls(source === c.id)}>{c.title}</button>
                ))}
              </div>
            </div>
          )}
          {kind && filters && (
            <>
              <FacetChips label={tr("editor.category")} values={filters.categories.filter((v) => v.kind === kind)} active={category} onPick={setCategory} />
              <FacetChips label={tr("editor.style")} values={filters.styles.filter((v) => v.kind === kind)} active={style} onPick={setStyle} />
              <FacetChips label={tr("editor.orientation")} values={filters.orientations.filter((v) => v.kind === kind)} active={orientation} onPick={setOrientation} />
              {/* Faceted photo search is bundled-only (the live provider can't
                  apply facets), so say so instead of results silently shrinking. */}
              {kind === "photo" && (category || style || orientation) && (
                <p className="mb-2 text-[11px] text-neutral-500">{tr("editor.filters_search_the_built_in_library_clear_th")}</p>
              )}
            </>
          )}
        </>
      )}

      {loading ? (
        <div className="grid place-items-center py-8 text-neutral-400"><Spinner /></div>
      ) : error ? (
        <div className="mt-6 flex flex-col items-center gap-2 text-center">
          <p className="text-xs text-neutral-500">{tr("editor.stock_library_unreachable")}</p>
          <button onClick={() => setRetryNonce((n) => n + 1)} className="rounded-lg border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-ink">
            {tr("editor.retry")}
          </button>
        </div>
      ) : results.length === 0 ? (
        <p className="mt-6 text-center text-xs text-neutral-400">{emptyMessage}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            {results.map((a) => (
              <StockTile key={a.id} a={a} onPlace={place} onToggleStar={(x) => void toggleStar(x)} />
            ))}
          </div>
          {tab === "browse" && hasMore && (
            <button
              onClick={() => void loadMore()}
              disabled={loadingMore}
              className="mt-2 w-full rounded-lg border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-ink disabled:opacity-50"
            >
              {loadingMore ? tr("editor.loading") : tr("editor.load_more")}
            </button>
          )}
        </>
      )}
    </PanelShell>
  );
}

// --- Apps panel ----------------------------------------------
// Lists the built-in mini apps (QR, charts, tables, shapes). Opening an app
// drives the editor's EXISTING insert actions, gated by the @hc/stock scope-
// decision logic against the scopes the backend grants the app. This is the
// LISTING + launch-into-existing-insert flow; the sandboxed iframe/worker
// runtime + postMessage bridge stays deferred.

// A concrete action an opened app can run, plus the scope it requires.
interface AppAction_ { label: string; icon: typeof QrCode; action: AppAction; run: () => void | Promise<void> }

const APP_ICONS: Record<string, typeof QrCode> = {
  qr: QrCode,
  charts: BarChart3,
  tables: TableIcon,
  shapes: Shapes,
};

export function AppsPanel() {
  const toast = useToast();
  const addNode = useEditor((s) => s.addNode);
  const insertTable = useEditor((s) => s.insertTable);
  const insertChart = useEditor((s) => s.insertChart);
  const [apps, setApps] = useState<MiniAppSummary[]>([]);
  const [open, setOpen] = useState<MiniAppSummary | null>(null);
  const [loading, setLoading] = useState(true);
  // Distinguish a failed fetch (retry) from a genuinely empty app catalog.
  const [error, setError] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(false);
      try {
        const a = await oc.listApps();
        if (!cancelled) setApps(a);
      } catch {
        if (!cancelled) { setApps([]); setError(true); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [retryNonce]);

  // The insert actions each app offers. Every action is checked against the
  // app's granted scopes via @hc/stock before it runs; a denied action surfaces
  // the reason rather than failing silently (FR-8/AC-8).
  function actionsFor(app: MiniAppSummary): AppAction_[] {
    switch (app.id) {
      case "qr":
        return [{ label: tr("editor.add_qr_code"), icon: QrCode, action: "insert-node", run: async () => {
          const t = await promptText({ title: tr("editor.add_qr_code"), label: tr("editor.links_to_url_or_text"), placeholder: "https://", defaultValue: "https://", confirmText: tr("editor.add") });
          if (!t) return;
          addNode("qr", { name: tr("editor.qr_code"), value: t, ecLevel: "M", foreground: { srgb: { r: 0, g: 0, b: 0, a: 1 } }, background: { srgb: { r: 1, g: 1, b: 1, a: 1 } }, modules: qrModules(t, "M"), transform: CENTER, size: { width: 220, height: 220 } } as Partial<Node>);
        } }];
      case "charts":
        return ([["bar", BarChart3], ["line", LineChart], ["area", AreaChart], ["pie", PieChart], ["donut", Donut]] as const).map(([type, icon]) => ({
          label: `${type[0].toUpperCase()}${type.slice(1)} chart`, icon, action: "insert-node" as AppAction, run: () => insertChart(type),
        }));
      case "tables":
        return [
          { label: "2 x 2 table", icon: TableIcon, action: "insert-node", run: () => insertTable(2, 2) },
          { label: "3 x 3 table", icon: TableIcon, action: "insert-node", run: () => insertTable(3, 3) },
          { label: "4 x 3 table", icon: TableIcon, action: "insert-node", run: () => insertTable(3, 4) },
        ];
      case "shapes":
        return [
          { label: tr("editor.rectangle"), icon: Square, action: "insert-node", run: () => addNode("shape", { name: tr("editor.rectangle"), shape: "rect", transform: CENTER, size: { width: 240, height: 160 }, fills: [BRAND] } as Partial<Node>) },
          { label: tr("editor.ellipse"), icon: Circle, action: "insert-node", run: () => addNode("shape", { name: tr("editor.ellipse"), shape: "ellipse", transform: CENTER, size: { width: 200, height: 200 }, fills: [BRAND] } as Partial<Node>) },
          { label: tr("editor.star"), icon: Star, action: "insert-node", run: () => addNode("shape", { name: tr("editor.star"), shape: "star", sides: 5, innerRadius: 0.5, transform: CENTER, size: { width: 200, height: 200 }, fills: [BRAND] } as Partial<Node>) },
        ];
      default:
        return [];
    }
  }

  function runAction(app: MiniAppSummary, a: AppAction_) {
    // Gate the action against the app's granted scopes (FR-8). The seed grants
    // every built-in app insert-node; this keeps the same surface third-party
    // apps will use, so an out-of-scope action is denied, not silently dropped.
    const decision = checkAppAction({ scopes: app.scopes as never }, a.action);
    if (!decision.allowed) {
      toast.toast(decision.reason ?? tr("editor.this_app_cant_do_that"), "error");
      return;
    }
    void a.run();
  }

  if (open) {
    const actions = actionsFor(open);
    const Icon = APP_ICONS[open.id] ?? Shapes;
    return (
      <PanelShell title={tr("editor.apps")}>
        <button onClick={() => setOpen(null)} className="mb-3 flex items-center gap-1 text-xs font-medium text-brand-ink hover:underline"><ChevronLeft size={13} />{tr("editor.all_apps")}</button>
        <div className="mb-3 flex items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand-50 text-brand-ink"><Icon size={18} /></span>
          <div>
            <p className="text-sm font-semibold text-neutral-800">{open.name}</p>
            <p className="text-[11px] text-neutral-400">Scopes: {open.scopes.join(", ")}</p>
          </div>
        </div>
        <div className="grid gap-2">
          {actions.map((a) => (
            <button key={a.label} onClick={() => runAction(open, a)} className="flex items-center gap-2 rounded-lg bg-neutral-50 px-3 py-2 text-sm text-neutral-700 hover:bg-brand-50 hover:text-brand-ink">
              <a.icon size={16} />{a.label}
            </button>
          ))}
        </div>
      </PanelShell>
    );
  }

  return (
    <PanelShell title={tr("editor.apps")}>
      <p className="mb-3 text-[11px] text-neutral-400">{tr("editor.mini_apps_insert_content_onto_your_design")}</p>
      {loading ? (
        <div className="grid place-items-center py-8 text-neutral-400"><Spinner /></div>
      ) : error ? (
        <div className="mt-6 flex flex-col items-center gap-2 text-center">
          <p className="text-xs text-neutral-500">{tr("editor.apps_load_failed")}</p>
          <button onClick={() => setRetryNonce((n) => n + 1)} className="rounded-lg border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-ink">
            {tr("editor.retry")}
          </button>
        </div>
      ) : apps.length === 0 ? (
        <p className="mt-6 text-center text-xs text-neutral-400">{tr("editor.no_apps_available")}</p>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {apps.map((app) => {
            const Icon = APP_ICONS[app.id] ?? Shapes;
            return (
              <button key={app.id} onClick={() => setOpen(app)} className="flex aspect-square flex-col items-center justify-center gap-2 rounded-xl bg-neutral-50 text-neutral-600 transition hover:bg-brand-50 hover:text-brand-ink">
                <Icon size={28} />
                <span className="text-xs font-medium">{app.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </PanelShell>
  );
}
