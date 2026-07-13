// Slide-out editor panels for the tool rail: Elements (shapes), Text, Uploads
// (F12), and Stock (F13). Each inserts nodes through the editor store so edits
// are undoable. Uploads/stock images are placed via the image asset provider.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type FormEvent } from "react";
import { Square, SquareRoundCorner, Circle, Triangle, Pentagon, Hexagon, Star, Diamond, Octagon, Minus, MoveUpRight, Frame, QrCode, Type, Upload, Search, Table as TableIcon, BarChart3, LineChart, AreaChart, PieChart, Donut, ScatterChart, Radar, Wand2, ImagePlus, Settings2, Trash2, Folder, FolderPlus, Pencil, X, Tag, ChevronLeft, Link as LinkIcon, Mic, Video, CircleStop, Spline, Clock, LayoutGrid, Shapes, Sparkles, Stethoscope, AlignStartVertical, Play, ChevronDown, Send, Plus, RotateCcw } from "lucide-react";
import { type ChartType, type Node, type Fill, type Color } from "@hc/schema";
import { searchFonts, type FontCatalogEntry } from "@hc/text";
import { toHex, fromHex, relativeLuminance } from "@hc/color";
import { formatBytes } from "@/lib/format";
import { qrModules } from "@/lib/qr";
import { STICKERS, STICKER_CATEGORIES, type Sticker } from "@/lib/stickers";
import { parseModelJson } from "@/lib/magicDesign";
import {
  normalizeOutline, deckThemes, layoutDeck, groundImagePrompt,
  type DesignOutline, type DesignType,
  toolCatalog, assistantSystemPrompt, parseAssistantReply, planMutates, summarizeDesign, type PlanStep,
} from "@hc/aistudio";
import { promptText } from "@/lib/promptDialog";
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
  CATEGORY_LABEL,
  ANIMATE_STYLES,
  type CritiqueIssue,
  type HarmonizeProposal,
  type AutoLayoutSuggestion,
  type AnimateStyle,
} from "@/lib/assist";
import { ApiError, type AiConfigView, type AssetFolder, type MiniAppSummary, type StockAssetSummary, type StockCollectionSummary, type StockFacetValue, type StockFiltersSummary, type StorageUsageView, type UploadedAsset } from "@hc/sdk";
import { checkAppAction, type AppAction } from "@hc/stock";
import { oc, resolveAssetUrl, stockProxyUrl, uploadAssetWithProgress } from "@/lib/sdk";
import type { BrandVoice, BrandLintViolation } from "@hc/sdk";
import { useEditor, type BrandFixTarget } from "@/store/editor";
import { useBrand } from "@/store/brand";
import { useComments } from "@/store/comments";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";

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
function afterInsert(toast: ReturnType<typeof useToast>, label: string) {
  toast.success(`Added ${label}`);
}

export function PanelShell({ title, children, fill }: { title: string; children: React.ReactNode; fill?: boolean }) {
  // Width degrades gracefully on narrow screens (60vw, capped at 16rem) so the
  // slide-out panel does not dominate a small viewport; at lg+ it is the full
  // 18rem (w-72) it has always been. When overlaid on the canvas (below lg, see
  // ToolRail) the narrower width keeps more of the canvas visible behind it.
  // `fill` makes the panel a non-scrolling flex column so a child (e.g. the AI
  // chat) can pin its own footer and scroll only its message area.
  return (
    <div className={`oc-scroll flex h-full w-[min(16rem,60vw)] flex-col border-r border-neutral-200 bg-surface lg:w-72 ${fill ? "overflow-hidden" : "overflow-y-auto overflow-x-hidden"}`}>
      <h3 className="px-4 pb-2 pt-4 text-sm font-bold text-neutral-800">{title}</h3>
      <div className={fill ? "flex min-h-0 flex-1 flex-col px-4 pb-4" : "flex-1 px-4 pb-4"}>{children}</div>
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
        className="group flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left hover:bg-neutral-50"
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
const DARK = { type: "solid", color: { srgb: { r: 0.1, g: 0.12, b: 0.16, a: 1 } } };
const FRAME_FILL = { type: "solid", color: { srgb: { r: 0.9, g: 0.91, b: 0.93, a: 1 } } };
const CENTER = { x: 320, y: 320, scaleX: 1, scaleY: 1, rotation: 0 };
const lineStroke = (cap: "round" | "butt") => ({ fill: DARK, width: 4, align: "center", cap, join: "round" });

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
  const insertLineNode = (label: string, init: Partial<Node>) => { addNode("line", init); afterInsert(toast, label.toLowerCase()); };
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
      title: "Shapes",
      icon: Shapes,
      defaultOpen: true,
      tiles: [
        { label: "Rectangle", icon: Square, run: () => insertShape("Rectangle", { name: "Rectangle", shape: "rect", transform: CENTER, size: { width: 240, height: 160 }, fills: [BRAND] } as Partial<Node>) },
        { label: "Rounded", icon: SquareRoundCorner, run: () => insertShape("Rounded rectangle", { name: "Rounded rectangle", shape: "rect", cornerRadius: { topLeft: 28, topRight: 28, bottomRight: 28, bottomLeft: 28 }, transform: CENTER, size: { width: 240, height: 160 }, fills: [BRAND] } as Partial<Node>) },
        { label: "Ellipse", icon: Circle, run: () => insertShape("Ellipse", { name: "Ellipse", shape: "ellipse", transform: CENTER, size: { width: 200, height: 200 }, fills: [BRAND] } as Partial<Node>) },
        { label: "Triangle", icon: Triangle, run: () => insertShape("Triangle", { name: "Triangle", shape: "triangle", sides: 3, transform: CENTER, size: { width: 200, height: 200 }, fills: [BRAND] } as Partial<Node>) },
        { label: "Pentagon", icon: Pentagon, run: () => insertShape("Pentagon", { name: "Pentagon", shape: "polygon", sides: 5, transform: CENTER, size: { width: 200, height: 200 }, fills: [BRAND] } as Partial<Node>) },
        { label: "Hexagon", icon: Hexagon, run: () => insertShape("Hexagon", { name: "Hexagon", shape: "polygon", sides: 6, transform: CENTER, size: { width: 200, height: 200 }, fills: [BRAND] } as Partial<Node>) },
        { label: "Star", icon: Star, run: () => insertShape("Star", { name: "Star", shape: "star", sides: 5, innerRadius: 0.5, transform: CENTER, size: { width: 200, height: 200 }, fills: [BRAND] } as Partial<Node>) },
        { label: "Diamond", icon: Diamond, run: () => insertShape("Diamond", { name: "Diamond", shape: "polygon", sides: 4, transform: CENTER, size: { width: 200, height: 200 }, fills: [BRAND] } as Partial<Node>) },
        { label: "Octagon", icon: Octagon, run: () => insertShape("Octagon", { name: "Octagon", shape: "polygon", sides: 8, transform: CENTER, size: { width: 200, height: 200 }, fills: [BRAND] } as Partial<Node>) },
        { label: "Burst", icon: Sparkles, run: () => insertShape("Burst", { name: "Burst", shape: "star", sides: 12, innerRadius: 0.62, transform: CENTER, size: { width: 200, height: 200 }, fills: [BRAND] } as Partial<Node>) },
        { label: "Pill", icon: SquareRoundCorner, run: () => insertShape("Pill", { name: "Pill", shape: "rect", cornerRadius: { topLeft: 999, topRight: 999, bottomRight: 999, bottomLeft: 999 }, transform: CENTER, size: { width: 260, height: 120 }, fills: [BRAND] } as Partial<Node>) },
      ],
    },
    {
      // Image placeholders: single frames and photo-grid layouts. Drop or click
      // a photo to fill a cell; it auto-covers the cell.
      title: "Frames & grids",
      icon: LayoutGrid,
      defaultOpen: true,
      tiles: [
        { label: "Frame", icon: Frame, run: () => insertFrame({ name: "Frame", clip: true, transform: CENTER, size: { width: 260, height: 200 }, fills: [FRAME_FILL] } as Partial<Node>) },
        { label: "Circle frame", icon: Circle, run: () => insertFrame({ name: "Circle frame", clip: true, maskShape: "ellipse", transform: CENTER, size: { width: 240, height: 240 }, fills: [FRAME_FILL] } as Partial<Node>) },
        { label: "Rounded frame", icon: SquareRoundCorner, run: () => insertFrame({ name: "Rounded frame", clip: true, cornerRadius: { topLeft: 32, topRight: 32, bottomRight: 32, bottomLeft: 32 }, transform: CENTER, size: { width: 260, height: 200 }, fills: [FRAME_FILL] } as Partial<Node>) },
        { label: "2 photos", icon: gridPreviewIcon(1, 2), run: () => insertGridEl(1, 2) },
        { label: "3 photos", icon: gridPreviewIcon(1, 3), run: () => insertGridEl(1, 3) },
        { label: "4 photos", icon: gridPreviewIcon(2, 2), run: () => insertGridEl(2, 2) },
        { label: "6 photos", icon: gridPreviewIcon(2, 3), run: () => insertGridEl(2, 3) },
        { label: "9 photos", icon: gridPreviewIcon(3, 3), run: () => insertGridEl(3, 3) },
        { label: "Feature left", icon: gridPreviewIcon(2, 2, FEATURE_LEFT), run: () => insertGridEl(2, 2, FEATURE_LEFT) },
        { label: "Feature right", icon: gridPreviewIcon(2, 2, FEATURE_RIGHT), run: () => insertGridEl(2, 2, FEATURE_RIGHT) },
        { label: "Feature top", icon: gridPreviewIcon(2, 2, FEATURE_TOP), run: () => insertGridEl(2, 2, FEATURE_TOP) },
        { label: "Hero mosaic", icon: gridPreviewIcon(3, 3, FEATURE_HERO), run: () => insertGridEl(3, 3, FEATURE_HERO) },
      ],
    },
    {
      title: "Lines & arrows",
      icon: Minus,
      defaultOpen: true,
      tiles: [
        { label: "Line", icon: Minus, run: () => insertLineNode("Line", { name: "Line", points: [{ x: 0, y: 0 }, { x: 240, y: 0 }], transform: CENTER, size: { width: 240, height: 4 }, stroke: lineStroke("round"), startCap: "none", endCap: "none" } as Partial<Node>) },
        { label: "Arrow", icon: MoveUpRight, run: () => insertLineNode("Arrow", { name: "Arrow", points: [{ x: 0, y: 0 }, { x: 240, y: 0 }], transform: CENTER, size: { width: 240, height: 4 }, stroke: lineStroke("butt"), startCap: "none", endCap: "arrow" } as Partial<Node>) },
      ],
    },
    {
      title: "Data & codes",
      icon: BarChart3,
      tiles: [
        { label: "Table", icon: TableIcon, run: () => insertTableEl(3, 3) },
        { label: "Bar chart", icon: BarChart3, run: () => insertChartEl("bar", "bar") },
        { label: "Grouped bar", icon: BarChart3, run: () => insertChartEl("barGrouped", "grouped bar") },
        { label: "Stacked bar", icon: BarChart3, run: () => insertChartEl("barStacked", "stacked bar") },
        { label: "Line chart", icon: LineChart, run: () => insertChartEl("line", "line") },
        { label: "Area chart", icon: AreaChart, run: () => insertChartEl("area", "area") },
        { label: "Pie chart", icon: PieChart, run: () => insertChartEl("pie", "pie") },
        { label: "Donut chart", icon: Donut, run: () => insertChartEl("donut", "donut") },
        { label: "Scatter", icon: ScatterChart, run: () => insertChartEl("scatter", "scatter") },
        { label: "Radar", icon: Radar, run: () => insertChartEl("radar", "radar") },
        { label: "QR code", icon: QrCode, run: async () => {
          const t = await promptText({ title: "Add QR code", label: "Links to (URL or text)", placeholder: "https://", defaultValue: "https://", confirmText: "Add" });
          if (!t) return;
          addNode("qr", { name: "QR code", value: t, ecLevel: "M", foreground: { srgb: { r: 0, g: 0, b: 0, a: 1 } }, background: { srgb: { r: 1, g: 1, b: 1, a: 1 } }, modules: qrModules(t, "M"), transform: CENTER, size: { width: 220, height: 220 } } as Partial<Node>);
          afterInsert(toast, "QR code");
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
      onClick={() => { useEditor.getState().addIconSvg(s.svg); afterInsert(toast, s.label.toLowerCase()); }}
      title={s.label}
      aria-label={s.label}
      className="grid aspect-square place-items-center rounded-lg bg-neutral-50 p-1.5 transition hover:bg-brand-50 [&>span>svg]:h-full [&>span>svg]:w-full"
    >
      <span className="block h-full w-full" dangerouslySetInnerHTML={{ __html: s.svg }} />
    </button>
  );
  return (
    <PanelShell title="Elements">
      <div className="flex flex-col gap-2.5">
        {recentTiles.length > 0 && (
          <CollapsibleSection title="Recently used" icon={Clock} defaultOpen>
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
        <CollapsibleSection title="Graphics" icon={Sparkles} defaultOpen badge={String(STICKERS.length)}>
          <div className="mb-2">
            <input
              value={stickerQuery}
              onChange={(e) => setStickerQuery(e.target.value)}
              placeholder="Search graphics"
              className="w-full rounded-lg border border-neutral-200 px-2.5 py-1.5 text-sm outline-none focus:border-brand-400"
            />
          </div>
          {stickerQuery.trim() ? (
            (() => {
              const q = stickerQuery.trim().toLowerCase();
              const matches = STICKERS.filter(
                (s) =>
                  s.label.toLowerCase().includes(q) ||
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
              {STICKER_CATEGORIES.map((cat) => {
                const items = STICKERS.filter((s) => s.category === cat);
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
                          {expanded ? "Show less" : "Show all"}
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
        <CollapsibleSection title="Animated" icon={Play} defaultOpen={false}>
          <div className="grid grid-cols-4 gap-2">
            {ANIMATED_STICKERS.map((s) => (
              <button
                key={s.id}
                onClick={() => {
                  const st = useEditor.getState();
                  st.addIconSvg(s.svg);
                  const id = st.selection[0];
                  if (id) st.setNodeAnimation(id, { emphasis: { preset: s.preset, durationMs: 1400, delayMs: 0, easing: "ease-in-out" } });
                  afterInsert(toast, `${s.label} (animated)`);
                }}
                title={`${s.label} (animated)`}
                aria-label={s.label}
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
const PAIRINGS: { name: string; head: string; headFont: string; sub: string; subFont: string }[] = [
  { name: "Bold & clean", head: "Heading", headFont: "Montserrat", sub: "Your subheading here", subFont: "Open Sans" },
  { name: "Elegant serif", head: "Heading", headFont: "Playfair Display", sub: "Your subheading here", subFont: "Lato" },
  { name: "Modern", head: "Heading", headFont: "Poppins", sub: "Your subheading here", subFont: "Inter" },
  { name: "Editorial", head: "Heading", headFont: "Lora", sub: "Your subheading here", subFont: "Work Sans" },
  { name: "Impact", head: "HEADING", headFont: "Anton", sub: "Your subheading here", subFont: "Roboto" },
  { name: "Statement", head: "HEADING", headFont: "Oswald", sub: "Your subheading here", subFont: "Merriweather" },
  { name: "Friendly", head: "Heading", headFont: "Nunito", sub: "Your subheading here", subFont: "Lora" },
  { name: "Display", head: "HEADING", headFont: "Bebas Neue", sub: "Your subheading here", subFont: "Work Sans" },
  { name: "Classic", head: "Heading", headFont: "Merriweather", sub: "Your subheading here", subFont: "Montserrat" },
  { name: "Minimal", head: "Heading", headFont: "Manrope", sub: "Your subheading here", subFont: "Manrope" },
  { name: "Playful", head: "Heading", headFont: "Pacifico", sub: "Your subheading here", subFont: "Nunito" },
  { name: "Refined", head: "Heading", headFont: "PT Serif", sub: "Your subheading here", subFont: "Raleway" },
];

/** A font row that lazy-loads its web font and previews the name in that font. */
function FontRow({ entry, onPick }: { entry: FontCatalogEntry; onPick: (family: string) => void }) {
  useEffect(() => { fonts.ensure(entry.family); }, [entry.family]);
  return (
    <button
      onClick={() => onPick(entry.family)}
      className="flex w-full items-center justify-between rounded-lg bg-neutral-50 px-3 py-2 text-left text-[15px] text-neutral-800 hover:bg-brand-50"
      style={{ fontFamily: cssStack(entry) }}
      title={`Use ${entry.family}`}
    >
      <span className="truncate">{entry.system ? "System default" : entry.family}</span>
      <span className="ml-2 shrink-0 text-[10px] uppercase tracking-wide text-neutral-300">{entry.category}</span>
    </button>
  );
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
        } else toast.error("Couldn't load that font file.");
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
    else addText("Your text", 32, 400, family); // addText toasts + frames the new box
  };

  const addPairing = (p: (typeof PAIRINGS)[number]) => {
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
    <PanelShell title="Text">
      <div className="flex flex-col gap-2.5">
        <CollapsibleSection title="Add text" icon={Type} defaultOpen>
          <button onClick={() => addText("Your text here", 28, 400)} className="flex items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-3 text-sm font-semibold text-white hover:bg-brand-700">
            <Type size={16} /> Add a text box
          </button>
          <button onClick={() => addText("Add a heading", 56, 800)} className="rounded-xl bg-neutral-50 px-4 py-3 text-left text-2xl font-extrabold text-neutral-800 hover:border-brand-300 hover:bg-brand-50">Add a heading</button>
          <button onClick={() => addText("Add a subheading", 36, 600)} className="rounded-xl bg-neutral-50 px-4 py-3 text-left text-lg font-semibold text-neutral-800 hover:border-brand-300 hover:bg-brand-50">Add a subheading</button>
          <button onClick={() => addText("Add body text", 20, 400)} className="rounded-xl bg-neutral-50 px-4 py-3 text-left text-sm text-neutral-800 hover:border-brand-300 hover:bg-brand-50">Add body text</button>
        </CollapsibleSection>

        <CollapsibleSection title="Font pairings" icon={Sparkles} defaultOpen>
          {PAIRINGS.map((p) => (
            <button key={p.name} onClick={() => addPairing(p)} className="rounded-xl bg-neutral-50 px-4 py-2.5 text-left hover:bg-brand-50">
              <span className="block text-lg font-bold text-neutral-800" style={{ fontFamily: `'${p.headFont}', sans-serif` }}>{p.head}</span>
              <span className="block text-xs text-neutral-500" style={{ fontFamily: `'${p.subFont}', sans-serif` }}>{p.sub}</span>
            </button>
          ))}
        </CollapsibleSection>

        <CollapsibleSection title="Fonts" icon={Search} defaultOpen>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search fonts" className="w-full rounded-lg border border-neutral-200 py-2 pl-8 pr-8 text-sm outline-none focus:border-brand-400" />
            {query && (
              <button onClick={() => setQuery("")} title="Clear search" className="absolute right-2 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded text-neutral-400 hover:text-neutral-700">
                <X size={13} />
              </button>
            )}
          </div>
          <input ref={fontFileRef} type="file" accept=".ttf,.otf,.woff,.woff2,font/*" hidden onChange={(e) => void onFontFile(e)} />
          <button onClick={() => fontFileRef.current?.click()} className="flex items-center justify-center gap-1.5 rounded-lg border border-neutral-200 py-2 text-xs font-medium text-neutral-600 hover:border-brand-300 hover:text-brand-ink">
            <Upload size={13} /> Upload a font
          </button>
          {customFams.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="px-1 text-[10px] uppercase tracking-wide text-neutral-300">Your fonts</span>
              {customFams.map((f) => (
                <button key={`c-${f}`} onClick={() => applyFont(f)} style={{ fontFamily: `'${f}', sans-serif` }} className="flex w-full items-center justify-between rounded-lg bg-neutral-50 px-3 py-2 text-left text-[15px] text-neutral-800 hover:bg-brand-50" title={`Use ${f}`}>
                  <span className="truncate">{f}</span>
                  <span className="ml-2 shrink-0 text-[10px] uppercase tracking-wide text-neutral-300">custom</span>
                </button>
              ))}
            </div>
          )}
          {!query && recents.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="px-1 text-[10px] uppercase tracking-wide text-neutral-300">Recent</span>
              {recents.map((e) => <FontRow key={`r-${e.family}`} entry={e} onPick={applyFont} />)}
            </div>
          )}
          <div className="flex flex-col gap-1">
            {results.map((e) => <FontRow key={e.family} entry={e} onPick={applyFont} />)}
            {results.length === 0 && <p className="px-1 py-2 text-xs text-neutral-400">No fonts match “{debouncedQuery}”.</p>}
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
      el.onerror = () => rej(new Error("decode failed"));
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

  // quotaErrorKind tells the two 413 causes apart: the per-workspace quota vs
  // the global per-user account limit (problem+json detail carries which).
  function quotaErrorKind(e: unknown): false | "workspace" | "account" {
    const status = e instanceof ApiError ? e.status : (e as { status?: number } | null)?.status;
    if (status !== 413) return false;
    const detail =
      e instanceof ApiError
        ? ((e.body as { detail?: string } | undefined)?.detail ?? "")
        : ((e as { detail?: string } | null)?.detail ?? "");
    return detail.includes("account storage") ? "account" : "workspace";
  }

  // Upload one or many image files (drag-drop or picker) into the open folder.
  const uploadFiles = useCallback(async (files: File[]) => {
    if (!workspaceId) return;
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) { if (files.length) toast.error("Only image files can be uploaded."); return; }
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
    let overQuota: false | "workspace" | "account" = false;
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
        if (kind) overQuota = kind;
        // Mark the tile failed, then clear it after a moment so the grid recovers.
        setUploading((cur) => cur.map((u) => (u.id === it.id ? { ...u, error: true } : u)));
        setTimeout(() => remove(it.id), 4000);
      }
    }
    if (ok) { toast.success(ok === 1 ? "Uploaded." : `Uploaded ${ok} images.`); await refresh(); }
    if (overQuota === "account") toast.error("Your account storage limit is reached. Delete some uploads to free space.");
    else if (overQuota) toast.error("Storage quota reached. Delete some uploads to free space.");
    else if (ok < imgs.length) toast.error(`${imgs.length - ok} upload(s) failed (unsupported type or too large?).`);
  }, [workspaceId, folderId, refresh, toast]);

  // Upload an arbitrary recorded Blob (audio/video) as an asset.
  const uploadBlob = useCallback(async (blob: Blob, filename: string) => {
    if (!workspaceId) return;
    try {
      const dataUrl = await readAsDataUrl(blob);
      await oc.uploadAsset(workspaceId, { filename, dataBase64: dataUrl.split(",")[1] ?? "", folderId });
      toast.success("Recording saved.");
      await refresh();
    } catch (e) {
      const kind = quotaErrorKind(e);
      if (kind === "account") toast.error("Your account storage limit is reached.");
      else if (kind) toast.error("Storage quota reached.");
      else toast.error("Couldn't save the recording.");
    }
  }, [workspaceId, folderId, refresh, toast]);

  // Import an image from a remote URL (server-side, SSRF-guarded).
  const importUrl = useCallback(async () => {
    if (!workspaceId) return;
    const url = await promptText({ title: "Import from URL", label: "Image URL", placeholder: "https://…/image.png", confirmText: "Import" });
    if (!url) return;
    try {
      await oc.importAssetFromUrl(workspaceId, url.trim(), folderId);
      toast.success("Imported.");
      await refresh();
    } catch (e) {
      const kind = quotaErrorKind(e);
      if (kind === "account") toast.error("Your account storage limit is reached.");
      else if (kind) toast.error("That image is too large or exceeds your storage quota.");
      else if (e instanceof ApiError) toast.error("Couldn't import that URL (not an image, blocked host, or unreachable).");
      else toast.error("Couldn't import that URL.");
    }
  }, [workspaceId, folderId, refresh, toast]);

  // Insert an uploaded SVG as an editable vector group (in addition to placing
  // it as an image). Fetches the SVG text and routes through the store.
  const insertSvgEditable = useCallback(async (a: UploadedAsset) => {
    try {
      const res = await fetch(resolveAssetUrl(a.url), { credentials: "include" });
      const svg = await res.text();
      if (!svg.includes("<svg")) { toast.error("That file isn't a valid SVG."); return; }
      useEditor.getState().addIconSvg(svg);
      toast.success("Inserted as editable vectors.");
    } catch {
      toast.error("Couldn't load that SVG.");
    }
  }, [toast]);

  const removeAsset = useCallback(async (id: string) => {
    try {
      await oc.deleteAsset(id);
      setAssets((a) => a.filter((x) => x.id !== id));
      if (workspaceId) setUsage(await oc.assetUsage(workspaceId).catch(() => null));
    } catch {
      toast.error("Couldn't delete that upload.");
    }
  }, [toast, workspaceId]);

  const renameAsset = useCallback(async (a: UploadedAsset) => {
    const name = await promptText({ title: "Rename upload", label: "Name", defaultValue: a.filename ?? "", confirmText: "Rename" });
    if (!name || name === a.filename) return;
    try {
      const updated = await oc.updateAsset(a.id, { filename: name });
      setAssets((list) => list.map((x) => (x.id === a.id ? updated : x)));
    } catch { toast.error("Couldn't rename that upload."); }
  }, [toast]);

  const setTags = useCallback(async (id: string, tags: string[]) => {
    try {
      const updated = await oc.updateAsset(id, { tags });
      setAssets((list) => list.map((x) => (x.id === id ? updated : x)));
    } catch { toast.error("Couldn't update tags."); }
  }, [toast]);

  const createFolder = useCallback(async () => {
    if (!workspaceId) return;
    const name = await promptText({ title: "New folder", label: "Folder name", placeholder: "e.g. Logos", confirmText: "Create" });
    if (!name) return;
    try {
      const f = await oc.createAssetFolder(workspaceId, { name });
      await refreshFolders();
      setFolderId(f.id);
    } catch { toast.error("Couldn't create that folder."); }
  }, [workspaceId, refreshFolders, toast]);

  const renameFolder = useCallback(async (f: AssetFolder) => {
    const name = await promptText({ title: "Rename folder", label: "Folder name", defaultValue: f.name, confirmText: "Rename" });
    if (!name || name === f.name) return;
    try { await oc.renameAssetFolder(f.id, name); await refreshFolders(); }
    catch { toast.error("Couldn't rename that folder."); }
  }, [refreshFolders, toast]);

  const deleteFolder = useCallback(async (f: AssetFolder) => {
    try {
      await oc.deleteAssetFolder(f.id);
      if (folderId === f.id) setFolderId(null);
      await refreshFolders();
      await refresh();
      toast.success("Folder deleted. Its uploads moved to All uploads.");
    } catch { toast.error("Couldn't delete that folder."); }
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
    if (!text.includes("<svg")) { toast.error("That file isn't a valid SVG."); return; }
    useEditor.getState().importSvg(text);
    toast.success("Imported SVG as editable elements.");
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
      if (!pages.length) { toast.error("Couldn't read any pages from that PDF."); return; }
      const elements = pages.reduce((n, p) => n + p.nodes.length, 0);
      useEditor.getState().importPdfPages(pages);
      toast.success(`Imported ${pages.length} page${pages.length > 1 ? "s" : ""} (${elements} text elements).`);
    } catch {
      toast.error("Couldn't import that PDF.");
    }
  }

  const selectedFolder = folders.find((f) => f.id === folderId) ?? null;
  const usePct = usage && usage.quotaBytes > 0 ? Math.min(100, (usage.usedBytes / usage.quotaBytes) * 100) : 0;
  // Global account usage (all workspaces); shown only when the instance sets
  // a per-user limit (USER_STORAGE_QUOTA_BYTES).
  const userPct = usage && usage.userQuotaBytes > 0 ? Math.min(100, (usage.userUsedBytes / usage.userQuotaBytes) * 100) : 0;

  return (
    <PanelShell title="Uploads">
      <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => void onFile(e)} />
      <input ref={svgRef} type="file" accept=".svg,image/svg+xml" hidden onChange={(e) => void onSvgFile(e)} />
      <input ref={pdfRef} type="file" accept=".pdf,application/pdf" hidden onChange={(e) => void onPdfFile(e)} />

      <div className="flex flex-col gap-2.5">
        <CollapsibleSection title="Upload" icon={Upload} defaultOpen>
          <div
            onDragOver={(e) => { e.preventDefault(); if (!dragOver) setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); void uploadFiles(Array.from(e.dataTransfer.files)); }}
            className={`rounded-xl border-2 border-dashed p-3 text-center transition ${dragOver ? "border-brand-400 bg-brand-50" : "border-neutral-200"}`}
          >
            <Button block onClick={() => fileRef.current?.click()} disabled={!workspaceId}>
              <Upload size={16} /> {selectedFolder ? `Upload to ${selectedFolder.name}` : "Upload images"}
            </Button>
            <p className="mt-2 text-[11px] text-neutral-400">or drop images here</p>
            {/* Compact one-word labels so the three cells hold one line at
                every panel width and font metric (the previous nowrap labels
                overflowed their neighbors on narrow panels / wider fonts);
                the icons and tooltips carry the full meaning. Wrap-safe as a
                fallback: no nowrap, min-w-0, centered. */}
            <div className="mt-2.5 grid grid-cols-3 gap-1.5">
              <button onClick={() => void importUrl()} disabled={!workspaceId} title="Import an image from a URL" className="flex min-w-0 flex-col items-center justify-center gap-1 rounded-lg border border-neutral-200 px-1 py-2 text-[11px] font-medium leading-tight text-neutral-600 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-ink disabled:opacity-40">
                <LinkIcon size={15} className="shrink-0" /> <span className="text-center">From URL</span>
              </button>
              <button onClick={() => svgRef.current?.click()} title="Import an SVG (e.g. an SVG export from another design tool) as editable elements" className="flex min-w-0 flex-col items-center justify-center gap-1 rounded-lg border border-neutral-200 px-1 py-2 text-[11px] font-medium leading-tight text-neutral-600 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-ink">
                <Upload size={15} className="shrink-0" /> <span className="text-center">SVG</span>
              </button>
              <button onClick={() => pdfRef.current?.click()} title="Import a PDF (e.g. a PDF export from another design tool) as editable pages (text)" className="flex min-w-0 flex-col items-center justify-center gap-1 rounded-lg border border-neutral-200 px-1 py-2 text-[11px] font-medium leading-tight text-neutral-600 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-ink">
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
        </CollapsibleSection>

        {/* Folders: All uploads + per-folder chips, with create/rename/delete. */}
        <CollapsibleSection title="Folders" icon={Folder} defaultOpen>
          <button onClick={() => void createFolder()} disabled={!workspaceId} className="flex items-center gap-1.5 self-start rounded-md px-2 py-1 text-xs font-medium text-neutral-500 hover:bg-neutral-100 hover:text-brand-ink disabled:opacity-40">
            <FolderPlus size={14} /> New folder
          </button>
          <div className="flex flex-col gap-0.5">
            <button onClick={() => setFolderId(null)} className={`flex items-center gap-2 rounded-md px-2 py-1 text-left text-sm ${folderId === null ? "bg-brand-50 font-medium text-brand-ink" : "text-neutral-600 hover:bg-neutral-100"}`}>
              <Folder size={14} /> All uploads
            </button>
            {folders.map((f) => (
              <div key={f.id} className={`group flex items-center gap-1 rounded-md px-2 py-1 text-sm ${folderId === f.id ? "bg-brand-50 text-brand-ink" : "text-neutral-600 hover:bg-neutral-100"}`}>
                <button onClick={() => setFolderId(f.id)} className="flex flex-1 items-center gap-2 text-left">
                  <Folder size={14} /> <span className="truncate">{f.name}</span>
                </button>
                <button onClick={() => void renameFolder(f)} title="Rename folder" className="hidden h-5 w-5 place-items-center rounded text-neutral-400 hover:text-brand-ink group-hover:grid"><Pencil size={12} /></button>
                <button
                  onClick={() => confirmDelete.confirm(`folder:${f.id}`, () => void deleteFolder(f))}
                  title={confirmDelete.armed === `folder:${f.id}` ? "Click again to delete" : "Delete folder"}
                  className={`h-5 w-5 place-items-center rounded ${confirmDelete.armed === `folder:${f.id}` ? "grid bg-red-600 text-white" : "hidden text-neutral-400 hover:text-red-600 group-hover:grid"}`}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="Your media" icon={ImagePlus} defaultOpen>
          {/* Search by name or tag (debounced). */}
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search uploads"
              className="w-full rounded-lg border border-neutral-200 py-1.5 pl-8 pr-8 text-sm outline-none focus:border-brand-400"
            />
            <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
              {searching && !loading && <Spinner className="text-[13px] text-neutral-400" />}
              {query && (
                <button onClick={() => setQuery("")} title="Clear search" className="grid h-5 w-5 place-items-center rounded text-neutral-400 hover:text-neutral-700">
                  <X size={13} />
                </button>
              )}
            </div>
          </div>

          {loading && workspaceId && uploading.length === 0 ? (
            <div className="grid place-items-center py-8 text-neutral-400"><Spinner /></div>
          ) : assets.length === 0 && uploading.length === 0 ? (
            <p className="py-6 text-center text-xs text-neutral-400">{debouncedQuery.trim() ? "No matching uploads." : "No uploads yet."}</p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {uploading.map((u) => (
                <div key={u.id} className="relative overflow-hidden rounded-lg border border-neutral-200" title={u.error ? `${u.name} failed to upload` : `Uploading ${u.name}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={u.preview} alt="" className="aspect-square w-full object-cover opacity-40" />
                  <div className="absolute inset-0 grid place-items-center">
                    {u.error
                      ? <span className="text-[11px] font-semibold text-red-600">Failed</span>
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
                title="Click to place, or drag onto the canvas"
                className="block w-full"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={a.thumbnail ?? resolveAssetUrl(a.url)} alt={a.filename ?? "upload"} className="aspect-square w-full object-cover" />
              </button>
              <div className="absolute right-1 top-1 hidden gap-1 group-hover:flex">
                {isSvgAsset(a) && (
                  <button onClick={() => void insertSvgEditable(a)} title="Insert as editable vectors" className="grid h-6 w-6 place-items-center rounded-full bg-surface/90 text-neutral-500 shadow hover:text-brand-ink"><Spline size={12} /></button>
                )}
                <button onClick={() => setEditing((id) => (id === a.id ? null : a.id))} title="Edit tags" className="grid h-6 w-6 place-items-center rounded-full bg-surface/90 text-neutral-500 shadow hover:text-brand-ink"><Tag size={12} /></button>
                <button onClick={() => void renameAsset(a)} title="Rename" className="grid h-6 w-6 place-items-center rounded-full bg-surface/90 text-neutral-500 shadow hover:text-brand-ink"><Pencil size={12} /></button>
                <button
                  onClick={() => confirmDelete.confirm(`asset:${a.id}`, () => void removeAsset(a.id))}
                  title={confirmDelete.armed === `asset:${a.id}` ? "Click again to delete" : "Delete upload"}
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
                  {editing === a.id && <TagEditor asset={a} folders={folders} onClose={() => setEditing(null)} onSetTags={(tags) => void setTags(a.id, tags)} onMove={async (fid) => { try { const u = await oc.updateAsset(a.id, { folderId: fid }); setAssets((list) => folderId !== null && u.folderId !== folderId ? list.filter((x) => x.id !== a.id) : list.map((x) => (x.id === a.id ? u : x))); } catch { toast.error("Couldn't move that upload."); } }} />}
                </div>
              ))}
            </div>
          )}

          {/* Storage usage meter (used / cap). */}
          {usage && (
            <div className="mt-2 border-t border-neutral-100 pt-3">
              <div className="mb-1 flex items-center justify-between text-[11px] text-neutral-500">
                <span>Storage</span>
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
                    <span>Your storage (all workspaces)</span>
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
  mode: "audio" | "video";
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

  const supported = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";

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
    if (!supported) { setError("Recording isn't supported in this browser."); return; }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(mode === "audio" ? { audio: true } : { audio: true, video: true });
    } catch {
      setError("Couldn't access your microphone/camera. Check the browser permission and try again.");
      return;
    }
    streamRef.current = stream;
    if (mode === "video" && videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.muted = true;
      void videoRef.current.play().catch(() => {});
    }
    const mimeType = pickMimeType(mode);
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch {
      setError("Couldn't start recording in this browser.");
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
      if (blob.size > 0) onCapture(blob, `${mode === "audio" ? "voice" : "webcam"}-${stamp}.${ext}`);
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

  const Icon = mode === "audio" ? Mic : Video;
  const label = mode === "audio" ? "Record voice" : "Record webcam";

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
          {mode === "video" && (
            <video ref={videoRef} playsInline muted className="mb-2 aspect-video w-full rounded bg-neutral-900 object-cover" />
          )}
          {recording ? (
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1 text-xs tabular-nums text-red-600">
                <span className="h-2 w-2 animate-pulse rounded-full bg-red-600" />
                {String(Math.floor(seconds / 60)).padStart(2, "0")}:{String(seconds % 60).padStart(2, "0")}
              </span>
              <button onClick={stop} className="ml-auto flex items-center gap-1 rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700">
                <CircleStop size={14} /> Stop &amp; save
              </button>
            </div>
          ) : (
            <Button block onClick={() => void start()} disabled={!supported}>
              <Icon size={14} /> Start recording
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
        <span className="font-semibold text-neutral-700">Tags</span>
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
        placeholder="Add tag, Enter"
        className="w-full rounded border border-neutral-200 px-1.5 py-1 text-[11px] outline-none focus:border-brand-400"
      />
      <label className="mt-auto flex items-center gap-1 text-[10px] text-neutral-500">
        <ChevronLeft size={11} className="rotate-180" />
        <select
          value={asset.folderId ?? ""}
          onChange={(e) => onMove(e.target.value === "" ? null : e.target.value)}
          className="min-w-0 flex-1 rounded border border-neutral-200 px-1 py-0.5 text-[10px] outline-none"
        >
          <option value="">No folder</option>
          {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      </label>
    </div>
  );
}

function aiErr(e: unknown): string {
  if (e instanceof ApiError) {
    const detail = (e.body as { detail?: string } | undefined)?.detail;
    return detail ?? `Request failed (${e.status}).`;
  }
  if (e instanceof Error && e.message) return e.message;
  return "AI request failed.";
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
    img.onerror = () => rej(new Error("Couldn't read this image (it may block cross-origin access)."));
    img.src = url;
  });
  const w = img.naturalWidth || 1;
  const h = img.naturalHeight || 1;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable in this browser.");
  ctx.drawImage(img, 0, 0);
  try {
    return canvas.toDataURL("image/png");
  } catch {
    throw new Error("This image can't be edited because it's loaded cross-origin.");
  }
}

/** Extract a small dominant-color palette (hex) from an image URL for F39
 *  reference-image style transfer (FR-18). Samples at ~128px for speed; returns
 *  [] if the image can't be read (e.g. cross-origin). */
async function pollJob<R>(jobId: string, tries = 12): Promise<R> {
  for (let i = 0; i < tries; i++) {
    const job = await oc.getJob<R>(jobId);
    if (job.status === "completed") {
      if (job.result === undefined) throw new Error("job completed without a result");
      return job.result;
    }
    if (job.status === "failed") throw new Error(job.error || "generation failed");
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("generation timed out");
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
const DESIGN_TYPES: { label: string; prompt: string }[] = [
  { label: "Poster", prompt: "Create a professional poster about " },
  { label: "Presentation", prompt: "Create a presentation deck about " },
  { label: "Social post", prompt: "Create a social media post about " },
  { label: "Document", prompt: "Create a document about " },
];

// Secondary one-tap actions (edits on the current design), shown smaller.
const ASSISTANT_SUGGESTIONS = [
  "Write a punchy headline",
  "Add a background image",
  "Turn this into a bar chart",
  "Critique this page",
];

// Contextual follow-ups offered right after a design is generated, so the user
// can art-direct without retyping the brief.
const DESIGN_FOLLOWUPS = ["Try another style", "Make it bolder", "Make it more minimal", "Add a matching image"];

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
  | { kind: "outline"; outline: DesignOutline; size: { width: number; height: number }; brandPalette: string[]; brandFonts: { heading?: string; body?: string }; heroImages: { pageIndex: number; url: string }[]; append: boolean };

interface AssistantDeps {
  workspaceId: string;
  voiceClause: string;
  brandPalette: string[];
  brandFonts: { heading?: string; body?: string };
  imageCapable: boolean;
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
      if (!deps.imageCapable) return { error: "this provider can't edit images - connect an image-capable provider (e.g. OpenAI)" };
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
    case "generateDesign": {
      // The explicit designType wins when the model supplies one; otherwise infer
      // it from the brief so "make a poster" still maps to a single-page poster
      // even when the model omits designType (it often does), instead of silently
      // defaulting to a multi-page deck.
      const dt = a.designType != null && String(a.designType).trim()
        ? normalizeDesignType(a.designType)
        : normalizeDesignType(a.prompt);
      const page = st.doc.pages[st.activePage];
      const size = { width: page?.width ?? 1280, height: page?.height ?? 720 };
      const brandClause = [deps.voiceClause, deps.brandPalette.length ? `Use this brand palette: ${deps.brandPalette.join(", ")}.` : ""].filter(Boolean).join(" ").trim();
      const pageCount = typeof a.pageCount === "number" ? a.pageCount : dt === "poster" ? 1 : undefined;
      const append = String(a.mode ?? "").toLowerCase() === "append";
      const outline = await fetchAssistantOutline(deps.workspaceId, dt, String(a.prompt), brandClause, pageCount);
      if (!outline) return { error: "couldn't plan that design" };
      // Defensive page cap (the server caps too, but the sync-fallback outline
      // and a non-compliant model can still over-produce): a poster is exactly
      // one page, and an explicit pageCount is a hard ceiling. This also bounds
      // the hero-image pass below so a single poster gets at most one image.
      if (dt === "poster" && outline.pages.length > 1) {
        const cover = outline.pages.find((p) => p.visualRole === "cover");
        outline.pages = [cover ?? outline.pages[0]];
      } else if (typeof pageCount === "number" && pageCount > 0 && outline.pages.length > pageCount) {
        outline.pages = outline.pages.slice(0, pageCount);
      }
      // Generate a soft hero background image for the high-impact pages so the
      // result ships WITH imagery (only when the provider supports images).
      let heroImages: { pageIndex: number; url: string }[] = [];
      if (deps.imageCapable) {
        const aspect = size.width >= size.height * 1.2 ? "landscape" : size.height >= size.width * 1.2 ? "portrait" : "square";
        const sizeStr = aspect === "landscape" ? "1792x1024" : aspect === "portrait" ? "1024x1792" : "1024x1024";
        const targets = outline.pages
          .map((p, i) => ({ p, i }))
          .filter(({ p }) => HERO_ROLES.has(p.visualRole))
          .slice(0, MAX_HERO_IMAGES);
        const results = await Promise.all(
          targets.map(async ({ p, i }) => {
            try {
              const prompt = groundImagePrompt(
                `${outline.title}${p.title ? ` - ${p.title}` : ""}. ${outline.theme ?? ""}. A soft, uncluttered, low-contrast background with generous empty space so overlaid text stays readable. No text, no words, no logos in the image.`,
                { palette: deps.brandPalette, aspect },
              );
              const { image } = await oc.aiImage({ workspaceId: deps.workspaceId, prompt, size: sizeStr });
              return image ? { pageIndex: i, url: image } : null;
            } catch {
              return null;
            }
          }),
        );
        heroImages = results.filter((x): x is { pageIndex: number; url: string } => !!x);
      }
      return { payload: { kind: "outline", outline, size, brandPalette: deps.brandPalette, brandFonts: deps.brandFonts, heroImages, append } };
    }
    default:
      return {};
  }
}

// Execute one validated plan step against the editor store. Returns true if it
// changed (or read) the document successfully. Runs inside runAsTurn so all
// steps collapse into a single undo entry. Generative steps consume the payload
// pre-resolved by resolvePlanStep.
function runPlanStep(step: PlanStep, ctx?: { brandTargets?: BrandFixTarget[]; payload?: ResolvedPayload }): boolean {
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
        name: "AI text",
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
    case "generateDesign": {
      if (ctx?.payload?.kind !== "outline") return false;
      const { outline, size, brandPalette, brandFonts, heroImages, append } = ctx.payload;
      const clean: DesignOutline = { ...outline, pages: outline.pages.map((p) => ({ ...p, points: p.points.map((s) => s.trim()).filter(Boolean) })) };
      // Seed the default hue from the title so different briefs don't all fall
      // back to the same first curated color (a brand palette overrides this).
      const seed = Array.from(clean.title).reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7);
      const themes = deckThemes({ brandPalette, kicker: clean.title, count: 1, fontHeading: brandFonts.heading, fontBody: brandFonts.body, seed });
      const deck = layoutDeck(clean, themes[0], size);
      const base = append ? st.doc.pages.length : 0;
      const ids = append ? st.appendDeckPages(deck, size) : st.buildDeckFromOutline(deck, size);
      if (!ids.length) return false;
      // Drop a generated hero image behind the impact pages (full-bleed, at the
      // back of the z-order). Applied here inside the one-undo turn.
      for (const h of heroImages) {
        st.setActivePage(base + h.pageIndex);
        st.addPageBackgroundImage(h.url);
      }
      st.setActivePage(base); // land on the first new page
      return true;
    }
    case "critique":
      return true; // read-only; handled by the caller for messaging
    default:
      return false;
  }
}

function AssistantPanel({ workspaceId, aiReady, voiceClause, brandPalette, brandFonts, imageCapable }: {
  workspaceId: string | null;
  aiReady: boolean;
  voiceClause: string;
  brandPalette: string[];
  brandFonts: { heading?: string; body?: string };
  imageCapable: boolean;
}) {
  const toast = useToast();
  const runAsTurn = useEditor((s) => s.runAsTurn);
  const undo = useEditor((s) => s.undo);
  const designId = useComments((s) => s.designId); // current design (for persisted history)
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [busy, setBusy] = useState(false);
  // FR-8: a plan awaiting confirmation before it mutates the document.
  const [pending, setPending] = useState<{ plan: PlanStep[]; reply: string } | null>(null);
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
  async function execute(plan: PlanStep[], reply: string) {
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
      const deps: AssistantDeps = { workspaceId, voiceClause, brandPalette, brandFonts, imageCapable };
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
            ok = runPlanStep(step, { brandTargets, payload: payloads[i] });
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
      const text = (reply || "Done.") + extra + (done === 0 && skipNote ? ` (${skipNote})` : "");
      setTurns((t) => [...t, { role: "assistant", text, steps: results }]);
      void persistTurn("assistant", text, plan);
      if (done) toast.success(`Applied ${done} step${done === 1 ? "" : "s"} (one undo reverts the turn).`);
      else if (!extra) toast.error(skipNote ? `Nothing applied: ${skipNote}.` : "Nothing was applied. Try selecting an element or rephrasing.");
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
      let res;
      try {
        const r = await oc.aiAssistant({ workspaceId, designSummary: summary, history, message: userText });
        res = parseAssistantReply(r, ASSISTANT_CATALOG);
      } catch (e) {
        if (e instanceof ApiError && !endpointUnavailable(e)) throw e; // surface provider/policy errors
        try {
          const system = assistantSystemPrompt(ASSISTANT_CATALOG, summary);
          const { text } = await oc.aiText({ workspaceId, prompt: history ? `${history}\nuser: ${userText}` : userText, system });
          res = parseAssistantReply(parseModelJson(text), ASSISTANT_CATALOG);
        } catch (e2) {
          if (e2 instanceof ApiError) throw e2; // a provider/policy error surfaces via the outer catch
          setTurns((t) => [...t, { role: "assistant", text: "Sorry, I couldn't understand that. Try rephrasing." }]);
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
        const reply = res.reply || "I couldn't map that to an action.";
        setTurns((t) => [...t, { role: "assistant", text: reply }]);
        void persistTurn("assistant", reply);
        return;
      }

      // FR-8: a large/destructive plan is previewed and confirmed before it runs;
      // a single small edit applies immediately. Confirm when the plan is multi-step
      // and mutating, OR contains a heavy whole-design action (generateDesign
      // replaces every page).
      const heavy = res.plan.some((s) => s.action === "generateDesign");
      if (heavy || (res.plan.length >= 2 && planMutates(res.plan, ASSISTANT_CATALOG))) {
        setPending({ plan: res.plan, reply: res.reply });
        setTurns((t) => [...t, { role: "assistant", text: res.reply || "Here's my plan - confirm to apply.", steps: res.plan.map((s) => ({ action: s.action, ok: true })) }]);
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
    setInput("");
    sessionRef.current = null; // a fresh session is created on the next send
  }
  function startFromType(prompt: string) {
    setInput(prompt);
    const el = inputRef.current;
    if (el) { el.focus(); el.setSelectionRange(prompt.length, prompt.length); }
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
          <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Assistant</span>
          <div className="flex items-center gap-1">
            {hasApplied && (
              <button onClick={() => { undo(); toast.success("Reverted last turn."); }} disabled={busy} title="Undo the last applied turn" className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-40"><RotateCcw size={12} /> Undo</button>
            )}
            <button onClick={startNewChat} disabled={busy} title="Start a new chat" className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-40"><Plus size={12} /> New</button>
          </div>
        </div>
      )}

      {/* Message thread (the only scrolling region). */}
      <div ref={scrollRef} className="oc-scroll -mx-1 flex-1 space-y-3 overflow-y-auto px-1 py-1">
        {turns.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 px-2 text-center">
            <div className="grid h-11 w-11 place-items-center rounded-full bg-brand-600 text-white shadow-sm"><Sparkles size={20} /></div>
            <div>
              <p className="text-sm font-semibold text-neutral-800">Create a design with AI</p>
              <p className="mx-auto mt-1 max-w-[16rem] text-xs text-neutral-500">Describe what you want and I&apos;ll design it, or pick a type to start.</p>
            </div>
            {/* Primary: design-creation starters. */}
            <div className="grid w-full max-w-[16rem] grid-cols-2 gap-1.5">
              {DESIGN_TYPES.map((t) => (
                <button key={t.label} onClick={() => startFromType(t.prompt)} disabled={!aiReady} className="rounded-lg border border-neutral-200 bg-surface px-2 py-2 text-xs font-medium text-neutral-700 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-ink disabled:opacity-50">{t.label}</button>
              ))}
            </div>
            {/* Secondary: quick edits on the current design. */}
            <div className="flex flex-wrap justify-center gap-1.5">
              {ASSISTANT_SUGGESTIONS.map((s) => (
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

      {/* FR-8: confirm a large/destructive plan before it mutates the document. */}
      {pending && (
        <div className="mt-2 flex shrink-0 items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800">
          <span>Apply {pending.plan.length} step{pending.plan.length === 1 ? "" : "s"}?</span>
          <span className="flex gap-1">
            <button onClick={() => { const p = pending; setPending(null); void execute(p.plan, p.reply); }} className="rounded bg-amber-600 px-2 py-0.5 font-medium text-white hover:bg-amber-700">Confirm</button>
            <button onClick={() => { setPending(null); setTurns((t) => [...t, { role: "assistant", text: "Cancelled." }]); }} className="rounded border border-amber-300 px-2 py-0.5 hover:bg-amber-100">Cancel</button>
          </span>
        </div>
      )}

      {/* Art-direction follow-ups, shown right after a design was generated. */}
      {lastWasDesign && !pending && !busy && (
        <div className="mt-2 flex shrink-0 flex-wrap gap-1.5">
          {DESIGN_FOLLOWUPS.map((f) => (
            <button key={f} onClick={() => void send(f)} className="rounded-full border border-neutral-200 bg-surface px-2.5 py-1 text-[11px] text-neutral-600 hover:border-brand-300 hover:text-brand-ink">{f}</button>
          ))}
        </div>
      )}

      {/* Composer, pinned to the bottom. */}
      <div className="mt-2 shrink-0">
        <div className="flex items-end gap-1.5 rounded-2xl border border-neutral-300 bg-surface px-2 py-1.5 focus-within:border-brand-400">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => { setInput(e.target.value); autosize(e.currentTarget); }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
            rows={1}
            placeholder="Ask anything…"
            disabled={!aiReady}
            className="max-h-[140px] flex-1 resize-none bg-transparent py-1 text-sm outline-none placeholder:text-neutral-400 disabled:opacity-50"
          />
          <button onClick={() => void send()} disabled={!canSend} title="Send (Enter)" className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-600 text-white transition hover:bg-brand-700 disabled:opacity-40">
            <Send size={15} />
          </button>
        </div>
        <p className="mt-1 px-1 text-[10px] text-neutral-400">Enter to send · Shift+Enter for a new line</p>
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
    toast.success("Fixed.");
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
          <Stethoscope size={14} /> Design critique
        </span>
        <button onClick={run} className="rounded-md bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-brand-50 hover:text-brand-ink">
          {issues === null ? "Analyze" : "Re-analyze"}
        </button>
      </div>
      {issues === null && <p className="text-xs text-neutral-400">Analyze this page for contrast, off-canvas, alignment, spacing, and readability issues.</p>}
      {clean && <p className="flex items-center gap-1.5 rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-700"><Sparkles size={13} /> Looks good. No issues found.</p>}
      {issues !== null && issues.length > 0 && (
        <div className="flex flex-col gap-3">
          {groups.map(([cat, items]) => (
            <div key={cat}>
              <div className="mb-1 text-[11px] font-semibold text-neutral-500">{CATEGORY_LABEL[cat]} ({items.length})</div>
              <ul className="flex flex-col gap-1">
                {items.map((i) => (
                  <li key={i.id} className="rounded-lg border border-neutral-100 bg-neutral-50 px-2 py-1.5 text-xs">
                    <button onClick={() => i.nodeId && highlightNode(i.nodeId)} disabled={!i.nodeId} className="flex w-full items-start gap-1.5 text-left text-neutral-600 hover:text-brand-ink disabled:cursor-default disabled:hover:text-neutral-600" title={i.nodeId ? "Show on canvas" : undefined}>
                      <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${ISSUE_DOT[i.severity]}`} />
                      <span>{i.message}</span>
                    </button>
                    {i.fix && (
                      <button onClick={() => applyFix(i)} className="mt-1 pl-3 text-[11px] font-medium text-brand-ink hover:underline">Fix</button>
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
          <Sparkles size={14} /> Harmonize styles
        </span>
        <button onClick={preview} className="rounded-md bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-brand-50 hover:text-brand-ink">Preview</button>
      </div>
      {proposal === null && <p className="text-xs text-neutral-400">Collapse fonts, snap colors to a few roles, and unify corner radii across the page.</p>}
      {proposal !== null && !hasHarmonizeChanges(proposal) && (
        <p className="flex items-center gap-1.5 rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-700"><Sparkles size={13} /> Styles already consistent.</p>
      )}
      {proposal !== null && hasHarmonizeChanges(proposal) && (
        <div className="flex flex-col gap-2 text-xs text-neutral-600">
          {proposal.fonts.length > 0 && (
            <div>
              <div className="mb-0.5 font-medium text-neutral-500">Fonts ({proposal.fonts.length})</div>
              <ul className="flex flex-col gap-0.5">
                {proposal.fonts.map((c, i) => <li key={i}>{c.from} <span className="text-neutral-400">to</span> {c.to}</li>)}
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
                    <span className="text-neutral-400">to</span>
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
                {proposal.radii.map((c, i) => <li key={i}>{Math.round(c.from)} <span className="text-neutral-400">to</span> {Math.round(c.to)}</li>)}
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
          <AlignStartVertical size={14} /> Auto-layout
        </span>
        <button onClick={run} className="rounded-md bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-brand-50 hover:text-brand-ink">Suggest</button>
      </div>
      {suggestions === null && <p className="text-xs text-neutral-400">Detect misaligned, unevenly spaced, or stray elements and fix them with one click.</p>}
      {suggestions !== null && suggestions.length === 0 && (
        <p className="flex items-center gap-1.5 rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-700"><Sparkles size={13} /> Layout looks tidy.</p>
      )}
      {suggestions !== null && suggestions.length > 0 && (
        <ul className="flex flex-col gap-1">
          {suggestions.map((s) => (
            <li key={s.op} className="flex items-center justify-between gap-2 rounded-lg border border-neutral-100 bg-neutral-50 px-2 py-1.5 text-xs text-neutral-600">
              <span>{s.label}</span>
              <button onClick={() => apply(s)} className="shrink-0 rounded-md border border-neutral-200 px-2 py-0.5 text-[11px] font-medium text-brand-ink hover:bg-surface">Apply</button>
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
      toast.toast("No elements to animate.", "info");
    }
  }, [style, toast]);

  const clear = useCallback(() => {
    const n = useEditor.getState().clearPageAnimations();
    toast.success(n > 0 ? "Animations cleared." : "No animations to clear.");
  }, [toast]);

  return (
    <section className="border-b border-neutral-100 pb-3 last:border-b-0 last:pb-0">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
        <Play size={14} /> Auto-animate
      </div>
      <p className="mb-2 text-xs text-neutral-400">Add a coherent, staggered entrance to every element in reading order.</p>
      <div className="mb-2 grid grid-cols-3 gap-1">
        {ANIMATE_STYLES.map((s) => (
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
        <Button className="flex-1" onClick={apply}><Play size={15} /> Animate</Button>
        <Button variant="secondary" onClick={clear}>Clear</Button>
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

// Default model per built-in provider, shown as a placeholder hint so the user
// knows what runs when the model field is left blank. The server registry is
// the source of truth; this only mirrors it for the UI hint.
const DEFAULT_MODEL_HINT: Record<string, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-opus-4-8",
  deepseek: "deepseek-chat",
};

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
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void (async () => {
      const c = await oc.getAiConfig(workspaceId).catch(() => null);
      if (cancelled) return;
      setConfig(c);
      setShowConfig(!c?.hasKey);
      if (c) { setProvider(c.provider); setModel(c.model ?? ""); setBaseUrl(c.baseUrl ?? ""); }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [workspaceId]);

  async function saveConfig() {
    if (!workspaceId) return;
    try {
      // Only a custom endpoint carries a user-supplied base URL; built-in
      // providers route via the server-side registry, so never persist a stale
      // base URL left over from a prior "custom" selection.
      const c = await oc.setAiConfig(workspaceId, { provider, model: model || undefined, baseUrl: provider === "custom" ? (baseUrl || undefined) : undefined, apiKey: apiKey || undefined });
      setConfig(c);
      setApiKey("");
      setShowConfig(false);
      toast.success("AI provider saved.");
    } catch {
      toast.error("Could not save AI settings.");
    }
  }

  // The chat view fills the panel height (input pinned, messages scroll); the
  // setup/connect view scrolls normally.
  const chatView = !!workspaceId && !loading && !showConfig && !!config?.hasKey;
  // Whether the configured provider can generate images (gates AI imagery in
  // generated designs). DeepSeek/Anthropic are text-only; OpenAI/custom can.
  const imageCapable = !!config?.capabilities?.image;

  return (
    <PanelShell title="AI" fill={chatView}>
      {!workspaceId ? (
        <p className="mt-4 text-center text-xs text-neutral-400">Open a saved design to use AI.</p>
      ) : loading ? (
        <div className="grid place-items-center py-8 text-neutral-400"><Spinner /></div>
      ) : showConfig || !config?.hasKey ? (
        <div className="flex flex-col gap-3">
          <div>
            <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-neutral-700">
              <Settings2 size={14} className="text-brand-500" /> Connect an AI provider
            </div>
            <p className="mb-2.5 text-[11px] text-neutral-500">Bring your own key. It is stored encrypted and never leaves the server.</p>
            <p className="mb-2.5 flex items-start gap-1.5 rounded-md bg-brand-50 px-2 py-1.5 text-[11px] text-brand-ink">
              <Wand2 size={12} className="mt-px shrink-0" />
              <span>Connect a provider to unlock <span className="font-medium">Magic Design</span> (text to a finished page) and image generation. The tools below work without AI.</span>
            </p>
            <div className="flex flex-col gap-2">
              <select value={provider} onChange={(e) => setProvider(e.target.value)} className="rounded border border-neutral-300 px-2 py-1.5 text-sm">
                <option value="openai">OpenAI (or compatible)</option>
                <option value="anthropic">Anthropic</option>
                <option value="deepseek">DeepSeek</option>
                <option value="custom">Custom endpoint</option>
              </select>
              <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={DEFAULT_MODEL_HINT[provider] ? `Model (optional, default ${DEFAULT_MODEL_HINT[provider]})` : "Model (optional)"} className="rounded border border-neutral-300 px-2 py-1.5 text-sm" />
              {provider === "custom" && (
                <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="Base URL (https://…/v1)" className="rounded border border-neutral-300 px-2 py-1.5 text-sm" />
              )}
              <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={config?.hasKey ? "API key (leave blank to keep)" : "API key"} className="rounded border border-neutral-300 px-2 py-1.5 text-sm" />
              <Button block onClick={() => void saveConfig()} disabled={!workspaceId}>Save provider</Button>
              {config?.hasKey && (
                <button onClick={() => setShowConfig(false)} className="text-xs text-neutral-500 hover:underline">Cancel</button>
              )}
            </div>
          </div>
          {/* Deterministic polish tools that work with no provider connected. */}
          <CollapsibleSection title="Assist (no AI needed)" icon={Stethoscope}>
            <PolishPanel />
          </CollapsibleSection>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          {/* Provider status bar with quick access to settings. */}
          <div className="flex shrink-0 items-center justify-between rounded-lg bg-neutral-50 px-2.5 py-1.5 text-xs">
            <span className="flex items-center gap-1.5 text-neutral-500">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Provider <span className="font-medium text-neutral-700">{config.provider}</span>
            </span>
            <button onClick={() => setShowConfig(true)} title="AI settings" className="text-neutral-400 hover:text-neutral-700"><Settings2 size={15} /></button>
          </div>
          {/* Capability nudge: this provider can't generate images, so designs
              come out text + color only. Point the user at an image-capable one. */}
          {!imageCapable && (
            <div className="flex shrink-0 items-start gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-700">
              <ImagePlus size={12} className="mt-px shrink-0" />
              <span>This provider is text-only, generated designs won&apos;t include images. Connect an image-capable provider (e.g. OpenAI) for designs with imagery.</span>
            </div>
          )}
          {/* Brand-voice grounding indicator (F21 FR-6/FR-7). Shows when the
              design has a voice; lets the user ignore it for the next action. */}
          {brandVoice && brandVoiceClause(brandVoice) && (
            <div className="flex shrink-0 items-center justify-between gap-2 rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1.5 text-[11px] text-brand-ink">
              <span className="flex items-center gap-1.5">
                <Wand2 size={12} />
                {ignoreVoice ? "Brand voice off" : `Using brand voice: ${brandVoiceLabel(brandVoice)}`}
              </span>
              <button
                onClick={() => setIgnoreVoice((v) => !v)}
                title={ignoreVoice ? "Use the brand voice in AI writing again" : "Stop grounding AI writing in the brand voice"}
                className="shrink-0 rounded px-1 font-medium underline-offset-2 hover:underline"
              >
                {ignoreVoice ? "Turn on" : "Turn off"}
              </button>
            </div>
          )}

          {/* Single conversational surface: one thread plans and applies every
              capability (write, image, whole-design, restyle, chart, critique).
              The model routes the intent to the right tool from the catalog. */}
          <AssistantPanel workspaceId={workspaceId} aiReady voiceClause={voiceClause} brandPalette={brandPalette} brandFonts={brandFonts} imageCapable={imageCapable} />
        </div>
      )}
    </PanelShell>
  );
}

const STOCK_KINDS: { label: string; kind: string }[] = [
  { label: "All", kind: "" },
  { label: "Photos", kind: "photo" },
  { label: "Illustrations", kind: "illustration" },
  { label: "Icons", kind: "icon" },
  { label: "Emoji", kind: "sticker" },
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
        <button onClick={() => onPick("")} className={stockChipCls(active === "")}>All</button>
        {values.map((v) => (
          <button key={v.id} onClick={() => onPick(v.id)} title={`${v.count} asset${v.count === 1 ? "" : "s"}`} className={stockChipCls(active === v.id)}>{facetLabel(v.id)}</button>
        ))}
      </div>
    </div>
  );
}

type StockTab = "browse" | "favorites" | "recents";

// Live-provider assets (Openverse photos) are not in the bundled catalog:
// favorites/recents don't apply and placement imports the file first.
const isProviderAsset = (a: StockAssetSummary) => a.pack === "openverse";

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
      toast.toast("Open a workspace design to place photos.", "info");
      return;
    }
    try {
      const up = await oc.importAssetFromUrl(workspaceId, a.sourceUrl);
      // resolveAssetUrl: the backend returns a relative content path; in dev the
      // frontend origin differs from the API's, same as the Uploads grid.
      placeImage(resolveAssetUrl(up.url), provenance);
    } catch {
      toast.toast("Couldn't add this photo. Try another one.", "error");
    }
    return; // provider assets have no recents entry in the bundled catalog
  } else if (a.sourceUrl) {
    // data/blob URLs load directly; remote photos go through our proxy so the
    // export canvas stays untainted (CORS-clean). Fills a selected frame if any.
    placeImage(/^(data:|blob:)/.test(a.sourceUrl) ? a.sourceUrl : stockProxyUrl(a.sourceUrl), provenance);
  } else {
    toast.toast("This asset isn't placeable.", "info");
    return;
  }
  // Fire-and-forget: recording a recent should never block insertion.
  void oc.recordStockRecent(a.id).catch(() => {});
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
        title={draggable ? "Click to place, or drag onto the canvas" : a.sourceUrl ? "Click to place" : a.title}
        className="grid aspect-square w-full place-items-center overflow-hidden rounded-lg border border-neutral-200 hover:border-brand-300"
      >
        {a.previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={a.previewUrl} alt={a.title} className="h-full w-full object-cover" />
        ) : a.svg ? (
          // Bundled-library vectors carry inline SVG; render it directly so the
          // preview is crisp with no data-URL blowup or extra request.
          <span aria-hidden className="block h-full w-full p-2 [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: a.svg }} />
        ) : (
          <span className="px-1 text-center text-[11px] text-neutral-500">{a.title}</span>
        )}
      </button>
      {!isProviderAsset(a) && (
        <button
          onClick={(e) => { e.stopPropagation(); onToggleStar(a); }}
          title={a.favorited ? "Remove from favorites" : "Add to favorites"}
          aria-pressed={!!a.favorited}
          className={`absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-surface/90 shadow transition ${a.favorited ? "text-amber-500" : "text-neutral-400 opacity-0 group-hover:opacity-100 hover:text-amber-500"}`}
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
const ANIMATED_STICKERS: { id: string; label: string; preset: "pulse" | "spin" | "wiggle" | "bob" | "flicker"; svg: string }[] = [
  { id: "a-star", label: "Spinning star", preset: "spin", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2 L15 9 L22 9 L16 14 L18 21 L12 17 L6 21 L8 14 L2 9 L9 9 Z" fill="#f5b301"/></svg>' },
  { id: "a-heart", label: "Pulsing heart", preset: "pulse", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 21 C 4 14 4 6 9 6 C 11 6 12 8 12 8 C 12 8 13 6 15 6 C 20 6 20 14 12 21 Z" fill="#e0245e"/></svg>' },
  { id: "a-bell", label: "Wiggling bell", preset: "wiggle", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 3 C 8 3 7 6 7 10 C 7 14 5 16 5 16 L 19 16 C 19 16 17 14 17 10 C 17 6 16 3 12 3 Z M 10 19 a 2 2 0 0 0 4 0 Z" fill="#6366f1"/></svg>' },
  { id: "a-dot", label: "Bouncing dot", preset: "bob", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="#22c55e"/></svg>' },
  { id: "a-spark", label: "Flickering spark", preset: "flicker", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2 L13.5 10.5 L22 12 L13.5 13.5 L12 22 L10.5 13.5 L2 12 L10.5 10.5 Z" fill="#f59e0b"/></svg>' },
];

export function StockPanel({ workspaceId }: { workspaceId: string | null }) {
  const toast = useToast();
  const [tab, setTab] = useState<StockTab>("browse");
  const [query, setQuery] = useState("");
  // Debounce the live search so a refetch fires after typing stops, not per key.
  const debouncedQuery = useDebouncedValue(query);
  const [kind, setKind] = useState("");
  // Facet filters (category/style/orientation), kind-scoped; "" means all.
  const [category, setCategory] = useState("");
  const [style, setStyle] = useState("");
  const [orientation, setOrientation] = useState("");
  const [filters, setFilters] = useState<StockFiltersSummary | null>(null);
  const [collection, setCollection] = useState<StockCollectionSummary | null>(null);
  const [collections, setCollections] = useState<StockCollectionSummary[]>([]);
  const [results, setResults] = useState<StockAssetSummary[]>([]);
  const [loading, setLoading] = useState(true);
  // Track a fetch ERROR separately from an empty catalog so an unreachable
  // provider shows a retry affordance rather than the "no results" message.
  const [error, setError] = useState(false);
  // Bump to force a retry of the active tab's fetch effect.
  const [retryNonce, setRetryNonce] = useState(0);

  // Load collections and filter facets; the browse landing state shows
  // collections as a row, facets appear per kind. Keyed on retryNonce so the
  // results-area Retry button also heals a failed load here (a miss would
  // otherwise hide collections and facets for the panel's lifetime), keeping
  // whatever already loaded when a refetch fails.
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
        else r = await oc.stockSearch(intentQuery(debouncedQuery) || undefined, kind || undefined, { category: category || undefined, style: style || undefined, orientation: orientation || undefined, collection: collection?.id, limit: STOCK_PAGE });
        if (!cancelled) { setResults(r); setHasMore(tab === "browse" && r.length === STOCK_PAGE); }
      } catch {
        if (!cancelled) { setResults([]); setError(true); setHasMore(false); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // Re-run when the tab, filters, debounced query, or active collection change.
  }, [tab, collection, debouncedQuery, kind, category, style, orientation, retryNonce]);

  async function loadMore() {
    if (loadingMore) return;
    setLoadingMore(true);
    const gen = fetchGen.current;
    try {
      const next = await oc.stockSearch(intentQuery(debouncedQuery) || undefined, kind || undefined, {
        category: category || undefined, style: style || undefined, orientation: orientation || undefined,
        collection: collection?.id, limit: STOCK_PAGE, offset: results.length,
      });
      if (gen !== fetchGen.current) return; // filters changed mid-flight; the grid was replaced
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
    setCategory(""); setStyle(""); setOrientation("");
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
    { id: "browse", label: "Browse", icon: LayoutGrid },
    { id: "favorites", label: "Favorites", icon: Star },
    { id: "recents", label: "Recent", icon: Clock },
  ];

  const emptyMessage =
    tab === "favorites" ? "No favorites yet. Tap the star on any asset." :
    tab === "recents" ? "Nothing placed yet." :
    collection ? `Nothing in ${collection.title}.` :
    // Name the facet as a cause alongside the query: with both active, the
    // facet is often the real constraint (and on photos it also switches the
    // search from the live provider to the bundled library).
    debouncedQuery && (category || style || orientation) ? `No results for “${debouncedQuery}” with these filters. Try clearing a filter.` :
    debouncedQuery ? `No results for “${debouncedQuery}”.` :
    category || style || orientation ? "Nothing matches these filters." :
    "No stock assets available.";

  return (
    <PanelShell title="Stock">
      <div className="mb-3 flex gap-1">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => { setTab(t.id); setCollection(null); }} className={`flex flex-1 items-center justify-center gap-1 rounded-lg border px-2 py-1.5 text-xs font-medium ${tab === t.id ? "border-brand-500 bg-brand-50 text-brand-ink" : "border-neutral-200 text-neutral-600 hover:bg-neutral-100"}`}>
            <t.icon size={13} />{t.label}
          </button>
        ))}
      </div>

      {tab === "browse" && (
        <>
          <form onSubmit={onSubmit} className="relative mb-2">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search photos & icons" className="h-9 w-full rounded-lg border border-neutral-200 pl-9 pr-9 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100" />
            {query && (
              <button type="button" onClick={() => setQuery("")} title="Clear search" className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded text-neutral-400 hover:text-neutral-700">
                <X size={14} />
              </button>
            )}
          </form>
          {/* Chips size to their labels and wrap: flex-1 in a no-wrap row made the
              five kinds overflow the panel sideways (flex items can't shrink
              below their text), which read as the whole panel sliding. */}
          <div className="mb-3 flex flex-wrap gap-1">
            {STOCK_KINDS.map((f) => (
              <button key={f.label} onClick={() => setFilter(f.kind)} className={stockChipCls(kind === f.kind)}>{f.label}</button>
            ))}
          </div>
          {/* Kind-scoped facet rows; a selected collection is already a narrower
              container, so facets stay hidden until it's cleared. */}
          {kind && !collection && filters && (
            <>
              <FacetChips label="Category" values={filters.categories.filter((v) => v.kind === kind)} active={category} onPick={setCategory} />
              <FacetChips label="Style" values={filters.styles.filter((v) => v.kind === kind)} active={style} onPick={setStyle} />
              <FacetChips label="Orientation" values={filters.orientations.filter((v) => v.kind === kind)} active={orientation} onPick={setOrientation} />
              {/* Faceted photo search is bundled-only (the live provider can't
                  apply facets), so say so instead of results silently shrinking. */}
              {kind === "photo" && (category || style || orientation) && (
                <p className="mb-2 text-[11px] text-neutral-500">Filters search the built-in library. Clear them to search live photos.</p>
              )}
            </>
          )}
          {collection ? (
            <button onClick={() => setCollection(null)} className="mb-2 flex items-center gap-1 text-xs font-medium text-brand-ink hover:underline">
              <ChevronLeft size={13} />Back to collections
            </button>
          ) : !query && !kind && collections.length > 0 ? (
            <div className="mb-3">
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Collections</p>
              <div className="flex flex-wrap gap-1.5">
                {collections.map((c) => (
                  <button key={c.id} onClick={() => setCollection(c)} title={c.description} className="rounded-full bg-neutral-100 px-2.5 py-1 text-xs text-neutral-600 hover:bg-brand-50 hover:text-brand-ink">{c.title}</button>
                ))}
              </div>
            </div>
          ) : null}
          {collection && <p className="mb-2 text-[11px] text-neutral-500">{collection.description}</p>}
        </>
      )}

      {loading ? (
        <div className="grid place-items-center py-8 text-neutral-400"><Spinner /></div>
      ) : error ? (
        <div className="mt-6 flex flex-col items-center gap-2 text-center">
          <p className="text-xs text-neutral-500">Couldn&apos;t reach the stock library.</p>
          <button onClick={() => setRetryNonce((n) => n + 1)} className="rounded-lg border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-ink">
            Retry
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
              {loadingMore ? "Loading…" : "Load more"}
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
        return [{ label: "Add QR code", icon: QrCode, action: "insert-node", run: async () => {
          const t = await promptText({ title: "Add QR code", label: "Links to (URL or text)", placeholder: "https://", defaultValue: "https://", confirmText: "Add" });
          if (!t) return;
          addNode("qr", { name: "QR code", value: t, ecLevel: "M", foreground: { srgb: { r: 0, g: 0, b: 0, a: 1 } }, background: { srgb: { r: 1, g: 1, b: 1, a: 1 } }, modules: qrModules(t, "M"), transform: CENTER, size: { width: 220, height: 220 } } as Partial<Node>);
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
          { label: "Rectangle", icon: Square, action: "insert-node", run: () => addNode("shape", { name: "Rectangle", shape: "rect", transform: CENTER, size: { width: 240, height: 160 }, fills: [BRAND] } as Partial<Node>) },
          { label: "Ellipse", icon: Circle, action: "insert-node", run: () => addNode("shape", { name: "Ellipse", shape: "ellipse", transform: CENTER, size: { width: 200, height: 200 }, fills: [BRAND] } as Partial<Node>) },
          { label: "Star", icon: Star, action: "insert-node", run: () => addNode("shape", { name: "Star", shape: "star", sides: 5, innerRadius: 0.5, transform: CENTER, size: { width: 200, height: 200 }, fills: [BRAND] } as Partial<Node>) },
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
      toast.toast(decision.reason ?? "This app can't do that.", "error");
      return;
    }
    void a.run();
  }

  if (open) {
    const actions = actionsFor(open);
    const Icon = APP_ICONS[open.id] ?? Shapes;
    return (
      <PanelShell title="Apps">
        <button onClick={() => setOpen(null)} className="mb-3 flex items-center gap-1 text-xs font-medium text-brand-ink hover:underline"><ChevronLeft size={13} />All apps</button>
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
    <PanelShell title="Apps">
      <p className="mb-3 text-[11px] text-neutral-400">Mini apps insert content onto your design.</p>
      {loading ? (
        <div className="grid place-items-center py-8 text-neutral-400"><Spinner /></div>
      ) : error ? (
        <div className="mt-6 flex flex-col items-center gap-2 text-center">
          <p className="text-xs text-neutral-500">Couldn&apos;t load apps.</p>
          <button onClick={() => setRetryNonce((n) => n + 1)} className="rounded-lg border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-ink">
            Retry
          </button>
        </div>
      ) : apps.length === 0 ? (
        <p className="mt-6 text-center text-xs text-neutral-400">No apps available.</p>
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
