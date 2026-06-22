// Slide-out editor panels for the tool rail: Elements (shapes), Text, Uploads
// (F12), and Stock (F13). Each inserts nodes through the editor store so edits
// are undoable. Uploads/stock images are placed via the image asset provider.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type FormEvent } from "react";
import { Square, SquareRoundCorner, Circle, Triangle, Pentagon, Hexagon, Star, Diamond, Octagon, Minus, MoveUpRight, Frame, QrCode, Type, Upload, Search, Table as TableIcon, BarChart3, LineChart, AreaChart, PieChart, Donut, ScatterChart, Radar, Wand2, ImagePlus, Settings2, Trash2, Folder, FolderPlus, Pencil, X, Tag, ChevronLeft, Link as LinkIcon, Mic, Video, CircleStop, Spline, Clock, LayoutGrid, Shapes, Sparkles, Stethoscope, AlignStartVertical, Play, ChevronDown } from "lucide-react";
import { type ChartType, type Node } from "@hc/schema";
import { searchFonts, type FontCatalogEntry } from "@hc/text";
import { toHex } from "@hc/color";
import { qrModules } from "@/lib/qr";
import { STICKERS } from "@/lib/stickers";
import {
  MagicParseError,
  parseModelJson,
  normalizeMagicDesign,
  type MagicDesignSpec,
} from "@/lib/magicDesign";
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
import { ApiError, type AiConfigView, type AssetFolder, type MiniAppSummary, type StockAssetSummary, type StockCollectionSummary, type StorageUsageView, type UploadedAsset } from "@hc/sdk";
import { checkAppAction, type AppAction } from "@hc/stock";
import { oc, resolveAssetUrl, stockProxyUrl } from "@/lib/sdk";
import type { BrandVoice } from "@hc/sdk";
import { useEditor } from "@/store/editor";
import { useBrand } from "@/store/brand";
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
 *  the user is looking - we deliberately do NOT zoom (Canva-style: the view
 *  stays put rather than jumping to frame the new element). */
function afterInsert(toast: ReturnType<typeof useToast>, label: string) {
  toast.success(`Added ${label}`);
}

export function PanelShell({ title, children }: { title: string; children: React.ReactNode }) {
  // Width degrades gracefully on narrow screens (60vw, capped at 16rem) so the
  // slide-out panel does not dominate a small viewport; at lg+ it is the full
  // 18rem (w-72) it has always been. When overlaid on the canvas (below lg, see
  // ToolRail) the narrower width keeps more of the canvas visible behind it.
  return (
    <div className="oc-scroll flex h-full w-[min(16rem,60vw)] flex-col overflow-y-auto border-r border-neutral-200 bg-white lg:w-72">
      <h3 className="px-4 pb-2 pt-4 text-sm font-bold text-neutral-800">{title}</h3>
      <div className="flex-1 px-4 pb-4">{children}</div>
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
  children,
}: {
  title: string;
  icon?: typeof Square;
  defaultOpen?: boolean;
  badge?: string | number;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-neutral-100 pb-2 last:border-b-0 last:pb-0">
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
      {open && <div className="flex flex-col gap-2 px-1 pt-1.5">{children}</div>}
    </div>
  );
}

const BRAND = { type: "solid", color: { srgb: { r: 0.38, g: 0.22, b: 0.86, a: 1 } } };
const DARK = { type: "solid", color: { srgb: { r: 0.1, g: 0.12, b: 0.16, a: 1 } } };
const FRAME_FILL = { type: "solid", color: { srgb: { r: 0.9, g: 0.91, b: 0.93, a: 1 } } };
const CENTER = { x: 320, y: 320, scaleX: 1, scaleY: 1, rotation: 0 };
const lineStroke = (cap: "round" | "butt") => ({ fill: DARK, width: 4, align: "center", cap, join: "round" });

type ElementTile = { label: string; icon: typeof Square; run: () => void };

export function ElementsPanel() {
  const toast = useToast();
  const addNode = useEditor((s) => s.addNode);
  const insertTable = useEditor((s) => s.insertTable);
  const insertChart = useEditor((s) => s.insertChart);
  // Insert helpers: the store already centers the new node in the current
  // viewport and selects it, so afterInsert only confirms with a subtle toast
  // (no zoom - the view stays put, Canva-style).
  const insertShape = (label: string, init: Partial<Node>) => { addNode("shape", init); afterInsert(toast, label.toLowerCase()); };
  const insertLineNode = (label: string, init: Partial<Node>) => { addNode("line", init); afterInsert(toast, label.toLowerCase()); };
  const insertFrame = (init: Partial<Node>) => { addNode("frame", init); afterInsert(toast, "frame"); };
  const insertTableEl = (rows: number, cols: number) => { insertTable(rows, cols); afterInsert(toast, "table"); };
  const insertChartEl = (type: ChartType, label: string) => { insertChart(type); afterInsert(toast, `${label} chart`); };
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
      title: "Lines & arrows",
      icon: Minus,
      defaultOpen: true,
      tiles: [
        { label: "Line", icon: Minus, run: () => insertLineNode("Line", { name: "Line", points: [{ x: 0, y: 0 }, { x: 240, y: 0 }], transform: CENTER, size: { width: 240, height: 4 }, stroke: lineStroke("round"), startCap: "none", endCap: "none" } as Partial<Node>) },
        { label: "Arrow", icon: MoveUpRight, run: () => insertLineNode("Arrow", { name: "Arrow", points: [{ x: 0, y: 0 }, { x: 240, y: 0 }], transform: CENTER, size: { width: 240, height: 4 }, stroke: lineStroke("butt"), startCap: "none", endCap: "arrow" } as Partial<Node>) },
        { label: "Frame", icon: Frame, run: () => insertFrame({ name: "Frame", clip: true, transform: CENTER, size: { width: 260, height: 200 }, fills: [FRAME_FILL] } as Partial<Node>) },
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
  return (
    <PanelShell title="Elements">
      <div className="flex flex-col gap-2.5">
        {groups.map((g) => (
          <CollapsibleSection key={g.title} title={g.title} icon={g.icon} defaultOpen={g.defaultOpen}>
            <div className="grid grid-cols-2 gap-2">
              {g.tiles.map((t) => (
                <button key={t.label} onClick={() => void t.run()} className="flex aspect-square flex-col items-center justify-center gap-2 rounded-xl bg-neutral-50 text-neutral-600 transition hover:bg-brand-50 hover:text-brand-700">
                  <t.icon size={26} />
                  <span className="text-xs font-medium">{t.label}</span>
                </button>
              ))}
            </div>
          </CollapsibleSection>
        ))}
        {/* Graphics: bundled, free, editable-vector stickers (insert via addIconSvg). */}
        <CollapsibleSection title="Graphics" icon={Sparkles} defaultOpen>
          <div className="grid grid-cols-4 gap-2">
            {STICKERS.map((s) => (
              <button
                key={s.id}
                onClick={() => { useEditor.getState().addIconSvg(s.svg); afterInsert(toast, s.label.toLowerCase()); }}
                title={s.label}
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
      void fonts.registerCustomFont(family, String(reader.result)).then((ok) => {
        if (ok) { applyFont(family); force(); toast.success(`Added font “${family}”.`); }
        else toast.error("Couldn't load that font file.");
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
          <button onClick={() => fontFileRef.current?.click()} className="flex items-center justify-center gap-1.5 rounded-lg border border-neutral-200 py-2 text-xs font-medium text-neutral-600 hover:border-brand-300 hover:text-brand-700">
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
function placeImage(url: string) {
  const st = useEditor.getState();
  const sel = st.selection;
  if (sel.length === 1) {
    const loc = locate(st.doc, sel[0]);
    if (loc?.node.type === "frame") { st.setFrameImage(sel[0], url); return; }
  }
  st.addImage(url);
}

function formatBytes(n: number): string {
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
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

  // Upload one or many image files (drag-drop or picker) into the open folder.
  const uploadFiles = useCallback(async (files: File[]) => {
    if (!workspaceId) return;
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) { if (files.length) toast.error("Only image files can be uploaded."); return; }
    let ok = 0;
    let overQuota = false;
    for (const file of imgs) {
      try {
        const dataUrl = await readAsDataUrl(file);
        // Client-side thumbnail for the grid (perf): keeps full bytes server-side
        // but serves a tiny preview. Optional, so a decode failure is non-fatal.
        const thumbnail = await makeThumbnail(file);
        await oc.uploadAsset(workspaceId, { filename: file.name, dataBase64: dataUrl.split(",")[1] ?? "", folderId, thumbnail });
        ok++;
      } catch (e) {
        if (e instanceof ApiError && e.status === 413) overQuota = true;
      }
    }
    if (ok) { toast.success(ok === 1 ? "Uploaded." : `Uploaded ${ok} images.`); await refresh(); }
    if (overQuota) toast.error("Storage quota reached. Delete some uploads to free space.");
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
      if (e instanceof ApiError && e.status === 413) toast.error("Storage quota reached.");
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
      if (e instanceof ApiError) {
        if (e.status === 413) toast.error("That image is too large or exceeds your storage quota.");
        else toast.error("Couldn't import that URL (not an image, blocked host, or unreachable).");
      } else toast.error("Couldn't import that URL.");
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

  // Import an SVG file (e.g. a Canva SVG export) as editable elements, fit to the
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

  // Import a PDF (e.g. a Canva PDF export) as editable pages (text). pdf.js loads
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
            <div className="mt-2 flex gap-1">
              <button onClick={() => void importUrl()} disabled={!workspaceId} title="Import an image from a URL" className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-neutral-200 py-1.5 text-xs font-medium text-neutral-600 hover:border-brand-300 hover:text-brand-700 disabled:opacity-40">
                <LinkIcon size={13} /> From URL
              </button>
              <button onClick={() => svgRef.current?.click()} title="Import an SVG (e.g. a Canva SVG export) as editable elements" className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-neutral-200 py-1.5 text-xs font-medium text-neutral-600 hover:border-brand-300 hover:text-brand-700">
                <Upload size={13} /> Import SVG
              </button>
              <button onClick={() => pdfRef.current?.click()} title="Import a PDF (e.g. a Canva PDF export) as editable pages (text)" className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-neutral-200 py-1.5 text-xs font-medium text-neutral-600 hover:border-brand-300 hover:text-brand-700">
                <Upload size={13} /> Import PDF
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
          <button onClick={() => void createFolder()} disabled={!workspaceId} className="flex items-center gap-1.5 self-start rounded-md px-2 py-1 text-xs font-medium text-neutral-500 hover:bg-neutral-100 hover:text-brand-600 disabled:opacity-40">
            <FolderPlus size={14} /> New folder
          </button>
          <div className="flex flex-col gap-0.5">
            <button onClick={() => setFolderId(null)} className={`flex items-center gap-2 rounded-md px-2 py-1 text-left text-sm ${folderId === null ? "bg-brand-50 font-medium text-brand-700" : "text-neutral-600 hover:bg-neutral-100"}`}>
              <Folder size={14} /> All uploads
            </button>
            {folders.map((f) => (
              <div key={f.id} className={`group flex items-center gap-1 rounded-md px-2 py-1 text-sm ${folderId === f.id ? "bg-brand-50 text-brand-700" : "text-neutral-600 hover:bg-neutral-100"}`}>
                <button onClick={() => setFolderId(f.id)} className="flex flex-1 items-center gap-2 text-left">
                  <Folder size={14} /> <span className="truncate">{f.name}</span>
                </button>
                <button onClick={() => void renameFolder(f)} title="Rename folder" className="hidden h-5 w-5 place-items-center rounded text-neutral-400 hover:text-brand-600 group-hover:grid"><Pencil size={12} /></button>
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

          {loading && workspaceId ? (
            <div className="grid place-items-center py-8 text-neutral-400"><Spinner /></div>
          ) : assets.length === 0 ? (
            <p className="py-6 text-center text-xs text-neutral-400">{debouncedQuery.trim() ? "No matching uploads." : "No uploads yet."}</p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
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
                  <button onClick={() => void insertSvgEditable(a)} title="Insert as editable vectors" className="grid h-6 w-6 place-items-center rounded-full bg-white/90 text-neutral-500 shadow hover:text-brand-600"><Spline size={12} /></button>
                )}
                <button onClick={() => setEditing((id) => (id === a.id ? null : a.id))} title="Edit tags" className="grid h-6 w-6 place-items-center rounded-full bg-white/90 text-neutral-500 shadow hover:text-brand-600"><Tag size={12} /></button>
                <button onClick={() => void renameAsset(a)} title="Rename" className="grid h-6 w-6 place-items-center rounded-full bg-white/90 text-neutral-500 shadow hover:text-brand-600"><Pencil size={12} /></button>
                <button
                  onClick={() => confirmDelete.confirm(`asset:${a.id}`, () => void removeAsset(a.id))}
                  title={confirmDelete.armed === `asset:${a.id}` ? "Click again to delete" : "Delete upload"}
                  className={`grid h-6 w-6 place-items-center rounded-full shadow ${confirmDelete.armed === `asset:${a.id}` ? "bg-red-600 text-white" : "bg-white/90 text-neutral-500 hover:text-red-600"}`}
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
        <button onClick={() => setOpen(true)} disabled={disabled} className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-neutral-200 py-1.5 text-xs font-medium text-neutral-600 hover:border-brand-300 hover:text-brand-700 disabled:opacity-40">
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
    <div className="absolute inset-0 flex flex-col gap-1.5 bg-white/97 p-2 text-xs">
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
const TONE_PRESETS: { label: string; system: string }[] = [
  { label: "Professional", system: "Rewrite the following text in a professional, polished tone." },
  { label: "Friendly", system: "Rewrite the following text in a warm, friendly tone." },
  { label: "Bold", system: "Rewrite the following text in a bold, confident tone." },
  { label: "Playful", system: "Rewrite the following text in a playful, lighthearted tone." },
  { label: "Concise", system: "Rewrite the following text to be as concise and punchy as possible." },
  { label: "Persuasive", system: "Rewrite the following text in a persuasive, compelling tone." },
];

// --- AI image-edit helpers (F20) -----------------------------------------

/** The single selected image node (with its resolved source URL), or null.
 *  Reads the live store state. */
function selectedImageNode(): { id: string; url: string | null } | null {
  const st = useEditor.getState();
  if (st.selection.length !== 1) return null;
  const loc = locate(st.doc, st.selection[0]);
  if (!loc || loc.node.type !== "image") return null;
  const n = loc.node as unknown as { source: { assetId: string } };
  const ref = st.doc.assets.find((a) => a.id === n.source.assetId);
  const url = ref?.url ? resolveAssetUrl(ref.url) : null;
  return { id: st.selection[0], url };
}

/** Read a (CORS-clean) image URL to a base64 PNG data URL. Fetches the bytes and
 *  re-encodes via a canvas so the payload is always PNG. Throws a friendly error
 *  on CORS / decode failure (the caller surfaces it). */
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

type ExpandDir = "all" | "left" | "right" | "top" | "bottom";

/**
 * Magic Expand mask builder. Loads the source image, then draws it onto a larger
 * canvas with transparent padding on the chosen side(s). The padded canvas IS
 * the mask the model paints into: the original pixels stay opaque, the new
 * transparent border is what gets generated. Returns the padded image as a PNG
 * data URL plus its dimensions (so the node box can grow to match). `amount` is
 * the fraction of the relevant dimension to add per padded side (0..1).
 */
async function buildExpandedImage(
  url: string,
  dir: ExpandDir,
  amount: number,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error("Couldn't read this image (it may block cross-origin access)."));
    img.src = url;
  });
  const sw = img.naturalWidth || 1;
  const sh = img.naturalHeight || 1;
  const padX = Math.round(sw * amount);
  const padY = Math.round(sh * amount);
  const left = dir === "all" || dir === "left" ? padX : 0;
  const right = dir === "all" || dir === "right" ? padX : 0;
  const top = dir === "all" || dir === "top" ? padY : 0;
  const bottom = dir === "all" || dir === "bottom" ? padY : 0;
  const width = sw + left + right;
  const height = sh + top + bottom;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable in this browser.");
  // Leave the canvas transparent; draw the original at the inset offset so the
  // padded border stays transparent (the mask the model fills).
  ctx.drawImage(img, left, top);
  let dataUrl: string;
  try {
    dataUrl = canvas.toDataURL("image/png");
  } catch {
    throw new Error("This image can't be expanded because it's loaded cross-origin.");
  }
  return { dataUrl, width, height };
}

// --- Magic Design (F22 FR-4) ----------------------------------------------
// Reasons about intent and emits fully editable native nodes (no rasters). The
// platform exposes only a free-text AI primitive (oc.aiText), so the model is
// prompted to return STRICT JSON which we parse robustly on the client (strip
// fences, validate shape, friendly error).

// Flat target-size presets for Magic Design (reuses the Resize preset sizes).
const DESIGN_SIZE_PRESETS: { label: string; w: number; h: number }[] = [
  { label: "Instagram Post (1080×1080)", w: 1080, h: 1080 },
  { label: "Instagram Story (1080×1920)", w: 1080, h: 1920 },
  { label: "Facebook Post (1200×630)", w: 1200, h: 630 },
  { label: "Presentation 16:9 (1920×1080)", w: 1920, h: 1080 },
  { label: "Poster (1080×1350)", w: 1080, h: 1350 },
  { label: "A4 Document (1240×1754)", w: 1240, h: 1754 },
];

// The Magic Design system prompt: instructs the model to return a strict JSON
// design spec with a background and fraction-positioned elements. Kept here so
// the contract lives next to the parser that validates it.
function magicDesignSystem(brandClause: string): string {
  return [
    "You are an expert graphic designer. Given a design brief and a target canvas, produce one finished, well-balanced layout.",
    "Output ONLY a single JSON object and nothing else: no prose, no explanation, no markdown, and no code fences.",
    "Schema: { \"background\": { \"kind\": \"solid\"|\"gradient\", \"color\": \"#rrggbb\", \"color2\"?: \"#rrggbb\", \"angle\"?: number },",
    "\"elements\": [ { \"kind\": \"heading\"|\"subheading\"|\"body\"|\"accent\", \"text\"?: string, \"color\"?: \"#rrggbb\", \"x\": number, \"y\": number, \"w\": number, \"h\": number, \"fontSize\"?: number } ] }.",
    "EVERY x, y, w, h is a FRACTION of the page between 0 and 1 (x,y = top-left corner, w,h = size). Never output pixels or values above 1.",
    "Write real, final copy tailored to the brief - never placeholders like 'Heading here'. Give exactly one heading, an optional subheading, 0-2 short body lines, and 0-3 accent rectangles (solid color blocks) that frame or balance the composition.",
    "Layout: keep at least a 0.05 margin from every edge; do NOT overlap text elements; align them to a shared left edge or center; place the heading in the upper or central area; size each box so its text fits.",
    "Color: choose an on-theme palette with strong, legible contrast between text and its background. Omit an element's color to let the app pick a readable one automatically. Keep the total under 10 elements.",
    brandClause,
  ].filter(Boolean).join(" ");
}

function MagicDesignPanel({ workspaceId, aiReady, voiceClause, brandPalette }: {
  workspaceId: string | null;
  aiReady: boolean;
  voiceClause: string;
  brandPalette: string[];
}) {
  const toast = useToast();
  const buildMagicDesign = useEditor((s) => s.buildMagicDesign);
  const [prompt, setPrompt] = useState("");
  const [sizeKey, setSizeKey] = useState(DESIGN_SIZE_PRESETS[0].label);
  const [busy, setBusy] = useState(false);

  async function run() {
    if (!workspaceId || !prompt.trim() || !aiReady) return;
    const preset = DESIGN_SIZE_PRESETS.find((p) => p.label === sizeKey) ?? DESIGN_SIZE_PRESETS[0];
    setBusy(true);
    try {
      // Ground the prompt with the target size and (when present) the brand
      // palette + voice so output is on-brand (FR-4).
      const brandClause = brandPalette.length
        ? `Prefer this brand palette where it fits: ${brandPalette.join(", ")}. ${voiceClause}`
        : voiceClause;
      const system = magicDesignSystem(brandClause);
      const userPrompt = `Design brief: ${prompt.trim()}\nTarget canvas: ${preset.w}x${preset.h} px (aspect ${(preset.w / preset.h).toFixed(2)}).`;
      const { text } = await oc.aiText({ workspaceId, prompt: userPrompt, system });
      let spec: MagicDesignSpec;
      try {
        spec = normalizeMagicDesign(parseModelJson(text));
      } catch (e) {
        toast.error(e instanceof MagicParseError ? e.message : "Couldn't read the AI's design. Try again.");
        return;
      }
      const ids = buildMagicDesign(spec, { width: preset.w, height: preset.h });
      toast.success(`Generated a design with ${ids.length} element${ids.length === 1 ? "" : "s"}.`);
    } catch (e) {
      toast.error(aiErr(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] text-neutral-400">Auto-design an entire page from your prompt. Replaces the current page (undoable).</p>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
        placeholder="e.g. a bold sale poster for a coffee shop"
        className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
      />
      <select value={sizeKey} onChange={(e) => setSizeKey(e.target.value)} className="rounded border border-neutral-300 px-2 py-1.5 text-xs">
        {DESIGN_SIZE_PRESETS.map((p) => <option key={p.label} value={p.label}>{p.label}</option>)}
      </select>
      <Button block onClick={() => void run()} disabled={busy || !prompt.trim() || !aiReady}>
        <Wand2 size={15} /> {busy ? "Designing…" : "Generate design"}
      </Button>
      {brandPalette.length > 0 && <p className="text-[10px] text-neutral-400">Using your brand palette.</p>}
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
        <button onClick={run} className="rounded-md bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-brand-50 hover:text-brand-700">
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
                    <button onClick={() => i.nodeId && highlightNode(i.nodeId)} disabled={!i.nodeId} className="flex w-full items-start gap-1.5 text-left text-neutral-600 hover:text-brand-700 disabled:cursor-default disabled:hover:text-neutral-600" title={i.nodeId ? "Show on canvas" : undefined}>
                      <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${ISSUE_DOT[i.severity]}`} />
                      <span>{i.message}</span>
                    </button>
                    {i.fix && (
                      <button onClick={() => applyFix(i)} className="mt-1 pl-3 text-[11px] font-medium text-brand-600 hover:underline">Fix</button>
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
        <button onClick={preview} className="rounded-md bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-brand-50 hover:text-brand-700">Preview</button>
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
        <button onClick={run} className="rounded-md bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-brand-50 hover:text-brand-700">Suggest</button>
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
              <button onClick={() => apply(s)} className="shrink-0 rounded-md border border-neutral-200 px-2 py-0.5 text-[11px] font-medium text-brand-600 hover:bg-white">Apply</button>
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
            className={`rounded-md border px-2 py-1 text-xs font-medium ${style === s.id ? "border-brand-300 bg-brand-50 text-brand-700" : "border-neutral-200 text-neutral-600 hover:bg-neutral-100"}`}
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

export function AiPanel({ workspaceId }: { workspaceId: string | null }) {
  const toast = useToast();
  const addNode = useEditor((s) => s.addNode);
  // Re-render when selection (or the doc) changes so the image-edit UI shows/hides.
  const selection = useEditor((s) => s.selection);
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
  // Let the user bypass brand-voice grounding for the very next action.
  const [ignoreVoice, setIgnoreVoice] = useState(false);
  const voiceClause = !ignoreVoice ? brandVoiceClause(brandVoice) : "";
  const [config, setConfig] = useState<AiConfigView | null>(null);
  const [loading, setLoading] = useState(true);
  const [showConfig, setShowConfig] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<"text" | "image" | "edit" | "expand" | "alt" | null>(null);
  const [provider, setProvider] = useState("openai");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [imgSize, setImgSize] = useState("1024x1024");
  const [logoMode, setLogoMode] = useState(false);
  // Image-edit state (shown when a single image node is selected).
  const [editPrompt, setEditPrompt] = useState("");
  const [expandDir, setExpandDir] = useState<ExpandDir>("all");
  const [variants, setVariants] = useState<string[]>([]); // Magic Write alternatives (F21 FR)
  const [expandPct, setExpandPct] = useState(25);

  const imageNode = selection.length === 1 ? selectedImageNode() : null;
  // Whether a single text box is selected, so the "Edit selected text" tools can
  // show a hint instead of silently no-op-ing. `rev` is already subscribed, so
  // reading the live doc here stays current.
  const textSelected =
    selection.length === 1 && locate(useEditor.getState().doc, selection[0])?.node.type === "text";

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
      const c = await oc.setAiConfig(workspaceId, { provider, model: model || undefined, baseUrl: baseUrl || undefined, apiKey: apiKey || undefined });
      setConfig(c);
      setApiKey("");
      setShowConfig(false);
      toast.success("AI provider saved.");
    } catch {
      toast.error("Could not save AI settings.");
    }
  }

  async function write() {
    if (!workspaceId || !prompt.trim()) return;
    setBusy("text");
    try {
      // Constrain the model to clean, display-ready copy: no chat preamble,
      // markdown, quotes, or lists - that text goes straight into a text box.
      const system = [
        "You write copy that goes directly into a single design text box.",
        "Return ONLY the final text, ready to display: no preamble, no explanation, no markdown, no surrounding quotes, and no list of alternatives - pick the single best option.",
        "Match the length to the request: a headline or tagline is a few words; a label is 1-3 words; body copy is one to three short sentences.",
        voiceClause,
      ].filter(Boolean).join(" ");
      const { text } = await oc.aiText({ workspaceId, prompt, system });
      const ed = useEditor.getState();
      const sel = ed.selection[0];
      const node = sel ? locate(ed.doc, sel)?.node : null;
      if (node?.type === "text") {
        ed.setText(sel, text);
      } else {
        addNode("text", {
          name: "AI text",
          transform: { x: 300, y: 320, scaleX: 1, scaleY: 1, rotation: 0 },
          size: { width: 480, height: 120 },
          box: { mode: "fixed", width: 480, height: 120, autoFit: { enabled: false, min: 8, max: 512 }, verticalAlign: "top" },
          content: [{ runs: [{ text, style: { fontFamily: "system", fontStyle: "Regular", fontSize: 28, axes: { wght: 400 }, fill: { type: "solid", color: { srgb: { r: 0.1, g: 0.12, b: 0.16, a: 1 } } } } }], style: { align: "left", direction: "auto" } }],
        } as Partial<Node>);
      }
      toast.success("Text generated.");
    } catch (e) {
      toast.error(aiErr(e));
    } finally {
      setBusy(null);
      setIgnoreVoice(false); // one-shot bypass resets after the action
    }
  }

  async function generate() {
    if (!workspaceId || !prompt.trim()) return;
    setBusy("image");
    try {
      // Logo mode wraps the prompt in a logo-oriented template; otherwise the
      // prompt is sent verbatim. Both go through the existing text-to-image.
      const finalPrompt = logoMode
        ? `A clean, modern, flat vector-style logo for: ${prompt.trim()}. Centered, simple, bold shapes, solid background, no text or lettering unless explicitly requested.`
        : `${prompt.trim()}. Well-composed, high detail, professional quality.`;
      const { image } = await oc.aiImage({ workspaceId, prompt: finalPrompt, size: imgSize });
      if (image) { placeImage(image); toast.success(logoMode ? "Logo added." : "Image added."); }
      else toast.error("No image returned.");
    } catch (e) {
      toast.error(aiErr(e));
    } finally {
      setBusy(null);
    }
  }

  // Edit the selected image node by prompt: send its current bytes + the edit
  // prompt, then replace the source with the result (undoable via setImageSource).
  async function editImagePrompt() {
    if (!workspaceId || !imageNode || !editPrompt.trim()) return;
    if (!imageNode.url) { toast.error("This image has no source to edit."); return; }
    setBusy("edit");
    try {
      const imageBase64 = await imageUrlToPngDataUrl(imageNode.url);
      const { image } = await oc.aiEditImage({ workspaceId, imageBase64, prompt: editPrompt.trim() });
      if (!image) { toast.error("No image returned."); return; }
      useEditor.getState().setImageSource(imageNode.id, image);
      toast.success("Image edited.");
    } catch (e) {
      toast.error(aiErr(e));
    } finally {
      setBusy(null);
    }
  }

  // Magic Expand (outpaint): pad the image onto a larger transparent canvas (the
  // transparent border is the mask), send image + that padded image as the mask,
  // then replace the source AND grow the node to the new aspect in one undo step.
  async function magicExpand() {
    if (!workspaceId || !imageNode) return;
    if (!imageNode.url) { toast.error("This image has no source to expand."); return; }
    setBusy("expand");
    try {
      const amount = Math.min(0.9, Math.max(0.05, expandPct / 100));
      const imageBase64 = await imageUrlToPngDataUrl(imageNode.url);
      const padded = await buildExpandedImage(imageNode.url, expandDir, amount);
      const { image } = await oc.aiEditImage({
        workspaceId,
        imageBase64,
        maskBase64: padded.dataUrl,
        prompt: editPrompt.trim() || "extend the image naturally",
      });
      if (!image) { toast.error("No image returned."); return; }
      useEditor.getState().outpaintImage(imageNode.id, image, padded.width, padded.height);
      toast.success("Image expanded.");
    } catch (e) {
      toast.error(aiErr(e));
    } finally {
      setBusy(null);
    }
  }

  // AI alt text (F22 FR-12): describe the selected image and write the result to
  // its accessibility `alt` field (one undo step via setImageAlt).
  async function altTextSelected() {
    if (!workspaceId) return;
    setBusy("alt");
    try {
      const ok = await generateAltText(workspaceId);
      if (ok) toast.success("Alt text written.");
      else toast.error("Select a single image first.");
    } catch (e) {
      toast.error(aiErr(e));
    } finally {
      setBusy(null);
    }
  }
  // Bulk: describe every image in the design and write each node's alt field.

  // Magic Write variants: rewrite the SELECTED text node with an instruction.
  async function transform(label: string, system: string) {
    if (!workspaceId) return;
    const ed = useEditor.getState();
    const sel = ed.selection[0];
    const node = sel ? locate(ed.doc, sel)?.node : null;
    if (!node || node.type !== "text") { toast.error("Select a text box first."); return; }
    const current = (node as unknown as { content: { runs: { text: string }[] }[] }).content
      .map((p) => p.runs.map((r) => r.text).join("")).join("\n").trim();
    if (!current) { toast.error("That text box is empty."); return; }
    setBusy("text");
    try {
      const grounded = withBrandVoice(system, voiceClause);
      const { text } = await oc.aiText({ workspaceId, prompt: current, system: `${grounded} Return only the resulting text, with no preamble or quotes.` });
      ed.setText(sel, text);
      toast.success(`${label} done.`);
    } catch (e) {
      toast.error(aiErr(e));
    } finally {
      setBusy(null);
      setIgnoreVoice(false); // one-shot bypass resets after the action
    }
  }
  async function translate() {
    const lang = await promptText({ title: "Translate text", label: "Translate to (language)", placeholder: "e.g. Spanish", confirmText: "Translate" });
    if (!lang) return;
    await transform("Translate", `Translate the following text to ${lang}.`);
  }
  // Multi-variant (F21 FR): generate several distinct rewrites of the selected
  // text and let the user pick one. Each variant is an independent grounded call.
  async function makeVariants() {
    if (!workspaceId) return;
    const ed = useEditor.getState();
    const sel = ed.selection[0];
    const node = sel ? locate(ed.doc, sel)?.node : null;
    if (!node || node.type !== "text") { toast.error("Select a text box first."); return; }
    const current = (node as unknown as { content: { runs: { text: string }[] }[] }).content
      .map((p) => p.runs.map((r) => r.text).join("")).join("\n").trim();
    if (!current) { toast.error("That text box is empty."); return; }
    setBusy("text");
    setVariants([]);
    try {
      const grounded = withBrandVoice("Rewrite the text as a fresh alternative that keeps the same meaning.", voiceClause);
      const results = await Promise.all(
        Array.from({ length: 3 }, (_, i) =>
          oc.aiText({ workspaceId, prompt: current, system: `${grounded} This is variation ${i + 1} of 3; make it clearly distinct from the others. Return only the text, no preamble or quotes.` })
            .then((r) => r.text.trim())
            .catch(() => ""),
        ),
      );
      const opts = Array.from(new Set(results.filter(Boolean)));
      if (!opts.length) { toast.error("Couldn't generate variants."); return; }
      setVariants(opts);
    } catch (e) {
      toast.error(aiErr(e));
    } finally {
      setBusy(null);
      setIgnoreVoice(false);
    }
  }
  function applyVariant(text: string) {
    const ed = useEditor.getState();
    const sel = ed.selection[0];
    if (sel) { ed.setText(sel, text); toast.success("Applied"); }
    setVariants([]);
  }

  return (
    <PanelShell title="AI">
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
            <p className="mb-2.5 flex items-start gap-1.5 rounded-md bg-brand-50 px-2 py-1.5 text-[11px] text-brand-700">
              <Wand2 size={12} className="mt-px shrink-0" />
              <span>Connect a provider to unlock <span className="font-medium">Magic Design</span> (text to a finished page) and image generation. The tools below work without AI.</span>
            </p>
            <div className="flex flex-col gap-2">
              <select value={provider} onChange={(e) => setProvider(e.target.value)} className="rounded border border-neutral-300 px-2 py-1.5 text-sm">
                <option value="openai">OpenAI (or compatible)</option>
                <option value="anthropic">Anthropic</option>
                <option value="custom">Custom endpoint</option>
              </select>
              <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Model (optional)" className="rounded border border-neutral-300 px-2 py-1.5 text-sm" />
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
        <div className="flex flex-col gap-2.5">
          {/* Provider status bar with quick access to settings. */}
          <div className="flex items-center justify-between rounded-lg bg-neutral-50 px-2.5 py-1.5 text-xs">
            <span className="flex items-center gap-1.5 text-neutral-500">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Provider <span className="font-medium text-neutral-700">{config.provider}</span>
            </span>
            <button onClick={() => setShowConfig(true)} title="AI settings" className="text-neutral-400 hover:text-neutral-700"><Settings2 size={15} /></button>
          </div>
          {/* Brand-voice grounding indicator (F21 FR-6/FR-7). Shows when the
              design has a voice; lets the user ignore it for the next action. */}
          {brandVoice && brandVoiceClause(brandVoice) && (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1.5 text-[11px] text-brand-700">
              <span className="flex items-center gap-1.5">
                <Wand2 size={12} />
                {ignoreVoice ? "Brand voice off for next action" : `Using brand voice: ${brandVoiceLabel(brandVoice)}`}
              </span>
              <button
                onClick={() => setIgnoreVoice((v) => !v)}
                title={ignoreVoice ? "Use the brand voice again" : "Ignore the brand voice for the next writing action"}
                className="shrink-0 rounded px-1 font-medium underline-offset-2 hover:underline"
              >
                {ignoreVoice ? "Use" : "Ignore once"}
              </button>
            </div>
          )}

          {/* Generate from a prompt: the primary entry point. */}
          <CollapsibleSection title="Magic Write & Media" icon={Wand2} defaultOpen>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} placeholder="Describe what you want…" className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm" />
            <Button block onClick={() => void write()} disabled={!!busy || !prompt.trim()}>
              <Wand2 size={16} /> {busy === "text" ? "Writing…" : "Magic Write"}
            </Button>
            <div className="flex items-center gap-2">
              <Button className="flex-1" variant="secondary" onClick={() => void generate()} disabled={!!busy || !prompt.trim()}>
                <ImagePlus size={16} /> {busy === "image" ? "Generating…" : logoMode ? "Generate logo" : "Generate image"}
              </Button>
              <select value={imgSize} onChange={(e) => setImgSize(e.target.value)} title="Image size" className="rounded border border-neutral-300 px-1.5 py-2 text-xs">
                <option value="1024x1024">Square</option>
                <option value="1024x1792">Portrait</option>
                <option value="1792x1024">Landscape</option>
              </select>
            </div>
            <label className="flex items-center gap-2 text-xs text-neutral-600">
              <input type="checkbox" checked={logoMode} onChange={(e) => setLogoMode(e.target.checked)} />
              Logo mode (vector-style logo)
            </label>
            <p className="text-[11px] text-neutral-400">Generate a text box or an image for this page.</p>
          </CollapsibleSection>

          {/* Edit the selected image (only meaningful when one is selected). */}
          {imageNode && (
            <CollapsibleSection title="Edit selected image" icon={ImagePlus} defaultOpen>
              <textarea value={editPrompt} onChange={(e) => setEditPrompt(e.target.value)} rows={2} placeholder="Describe the edit (or what to add when expanding)…" className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm" />
              <Button block variant="secondary" onClick={() => void editImagePrompt()} disabled={!!busy || !editPrompt.trim()}>
                <Wand2 size={16} /> {busy === "edit" ? "Editing…" : "Edit with a prompt"}
              </Button>
              {/* AI alt text (F22 FR-12): describe the image for accessibility. */}
              <Button block variant="secondary" onClick={() => void altTextSelected()} disabled={!!busy}>
                <Sparkles size={16} /> {busy === "alt" ? "Describing…" : "Generate alt text"}
              </Button>
              <div className="flex flex-col gap-1">
                <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">Magic Expand</span>
                <div className="flex items-center gap-2">
                  <select value={expandDir} onChange={(e) => setExpandDir(e.target.value as ExpandDir)} title="Direction" className="flex-1 rounded border border-neutral-300 px-1.5 py-1.5 text-xs">
                    <option value="all">All sides</option>
                    <option value="left">Left</option>
                    <option value="right">Right</option>
                    <option value="top">Top</option>
                    <option value="bottom">Bottom</option>
                  </select>
                  <select value={expandPct} onChange={(e) => setExpandPct(Number(e.target.value))} title="Amount" className="rounded border border-neutral-300 px-1.5 py-1.5 text-xs">
                    <option value={15}>15%</option>
                    <option value={25}>25%</option>
                    <option value={50}>50%</option>
                  </select>
                </div>
                <Button block variant="secondary" onClick={() => void magicExpand()} disabled={!!busy}>
                  <ImagePlus size={16} /> {busy === "expand" ? "Expanding…" : "Magic Expand"}
                </Button>
              </div>
            </CollapsibleSection>
          )}

          {/* Rewrite / tone tools that act on the selected text box. */}
          <CollapsibleSection title="Edit selected text" icon={Type} defaultOpen>
            {!textSelected && <p className="text-[11px] text-amber-600">Select a text box on the canvas to use these.</p>}
            <div className="grid grid-cols-2 gap-1">
              <button disabled={!!busy} onClick={() => void transform("Rewrite", "Rewrite the following text to improve clarity and flow.")} className="rounded bg-neutral-100 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-200 disabled:opacity-50">Rewrite</button>
              <button disabled={!!busy} onClick={() => void transform("Shorten", "Make the following text shorter and more concise.")} className="rounded bg-neutral-100 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-200 disabled:opacity-50">Shorten</button>
              <button disabled={!!busy} onClick={() => void transform("Expand", "Expand the following text with more detail.")} className="rounded bg-neutral-100 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-200 disabled:opacity-50">Expand</button>
              <button disabled={!!busy} onClick={() => void transform("Fix", "Fix the spelling and grammar of the following text.")} className="rounded bg-neutral-100 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-200 disabled:opacity-50">Fix grammar</button>
              <button disabled={!!busy} onClick={() => void transform("Formal", "Rewrite the following text in a more formal, professional tone.")} className="rounded bg-neutral-100 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-200 disabled:opacity-50">More formal</button>
              <button disabled={!!busy} onClick={() => void transform("Casual", "Rewrite the following text in a friendlier, more casual tone.")} className="rounded bg-neutral-100 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-200 disabled:opacity-50">More casual</button>
              <button disabled={!!busy} onClick={() => void translate()} className="col-span-2 rounded bg-neutral-100 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-200 disabled:opacity-50">Translate…</button>
            </div>
            {/* Quick tone presets (FR-3). Each rewrites the selected text in that
                tone, grounded by the brand voice when active. */}
            <span className="mt-1 text-[11px] uppercase tracking-wide text-neutral-400">Change tone</span>
            <div className="grid grid-cols-2 gap-1">
              {TONE_PRESETS.map((t) => (
                <button key={t.label} disabled={!!busy} onClick={() => void transform(t.label, t.system)} className="rounded bg-neutral-100 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-200 disabled:opacity-50">{t.label}</button>
              ))}
            </div>
            {/* Multi-variant (F21): generate 3 alternatives of the selected text. */}
            <button disabled={!!busy} onClick={() => void makeVariants()} className="mt-1 rounded bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-200 disabled:opacity-50">
              {busy === "text" ? "Writing…" : "Suggest variants"}
            </button>
            {variants.length > 0 && (
              <div className="flex flex-col gap-1">
                <span className="text-[11px] uppercase tracking-wide text-neutral-400">Pick a variant</span>
                {variants.map((v, i) => (
                  <button key={i} onClick={() => applyVariant(v)} title={v} className="rounded border border-neutral-200 px-2 py-1 text-left text-xs text-neutral-700 hover:border-brand-300 hover:bg-brand-50">
                    {v.length > 90 ? `${v.slice(0, 90)}…` : v}
                  </button>
                ))}
                <button onClick={() => setVariants([])} className="self-start text-[10px] text-neutral-400 hover:text-neutral-700">Dismiss</button>
              </div>
            )}
          </CollapsibleSection>

          {/* Whole-design generators and tools (collapsed by default). */}
          <CollapsibleSection title="Magic Design" icon={Sparkles}>
            <MagicDesignPanel workspaceId={workspaceId} aiReady voiceClause={voiceClause} brandPalette={brandPalette} />
          </CollapsibleSection>
          {/* Assist: deterministic polish tools (FR-8/9/11/14), no AI provider. */}
          <CollapsibleSection title="Assist (no AI needed)" icon={Stethoscope}>
            <PolishPanel />
          </CollapsibleSection>
        </div>
      )}
    </PanelShell>
  );
}

const STOCK_KINDS: { label: string; kind: string }[] = [
  { label: "All", kind: "" },
  { label: "Photos", kind: "photo" },
  { label: "Icons", kind: "icon" },
];

type StockTab = "browse" | "favorites" | "recents";

// Place a stock asset onto the canvas and record it as recently used. Icons
// carry inline SVG and insert as editable vectors; photos go through the proxy.
function placeStock(a: StockAssetSummary, toast: ReturnType<typeof useToast>) {
  if (a.svg) {
    useEditor.getState().addIconSvg(a.svg);
  } else if (a.sourceUrl) {
    // data/blob URLs load directly; remote photos go through our proxy so the
    // export canvas stays untainted (CORS-clean). Fills a selected frame if any.
    placeImage(/^(data:|blob:)/.test(a.sourceUrl) ? a.sourceUrl : stockProxyUrl(a.sourceUrl));
  } else {
    toast.toast("This asset isn't placeable.", "info");
    return;
  }
  // Fire-and-forget: recording a recent should never block insertion.
  void oc.recordStockRecent(a.id).catch(() => {});
}

function StockTile({ a, onPlace, onToggleStar }: { a: StockAssetSummary; onPlace: (a: StockAssetSummary) => void; onToggleStar: (a: StockAssetSummary) => void }) {
  return (
    <div className="group relative">
      <button
        onClick={() => onPlace(a)}
        draggable={!!a.sourceUrl}
        onDragStart={(e) => { if (a.sourceUrl) e.dataTransfer.setData("application/x-oc-image", /^(data:|blob:)/.test(a.sourceUrl) ? a.sourceUrl : stockProxyUrl(a.sourceUrl)); }}
        title={a.sourceUrl ? "Click to place, or drag onto the canvas" : a.title}
        className="grid aspect-square w-full place-items-center overflow-hidden rounded-lg border border-neutral-200 hover:border-brand-300"
      >
        {a.previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={a.previewUrl} alt={a.title} className="h-full w-full object-cover" />
        ) : (
          <span className="px-1 text-center text-[11px] text-neutral-500">{a.title}</span>
        )}
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onToggleStar(a); }}
        title={a.favorited ? "Remove from favorites" : "Add to favorites"}
        aria-pressed={!!a.favorited}
        className={`absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-white/90 shadow transition ${a.favorited ? "text-amber-500" : "text-neutral-400 opacity-0 group-hover:opacity-100 hover:text-amber-500"}`}
      >
        <Star size={13} fill={a.favorited ? "currentColor" : "none"} />
      </button>
    </div>
  );
}

export function StockPanel() {
  const toast = useToast();
  const [tab, setTab] = useState<StockTab>("browse");
  const [query, setQuery] = useState("");
  // Debounce the live search so a refetch fires after typing stops, not per key.
  const debouncedQuery = useDebouncedValue(query);
  const [kind, setKind] = useState("");
  const [collection, setCollection] = useState<StockCollectionSummary | null>(null);
  const [collections, setCollections] = useState<StockCollectionSummary[]>([]);
  const [results, setResults] = useState<StockAssetSummary[]>([]);
  const [loading, setLoading] = useState(true);
  // Track a fetch ERROR separately from an empty catalog so an unreachable
  // provider shows a retry affordance rather than the "no results" message.
  const [error, setError] = useState(false);
  // Bump to force a retry of the active tab's fetch effect.
  const [retryNonce, setRetryNonce] = useState(0);

  // Load collections once; the browse landing state shows them as a row.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const c = await oc.stockCollections().catch(() => []);
      if (!cancelled) setCollections(c);
    })();
    return () => { cancelled = true; };
  }, []);

  // Load the active tab's contents. Distinguishes a failed fetch (error banner +
  // retry) from a genuinely empty result (the "no results" message).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(false);
      try {
        let r: StockAssetSummary[];
        if (tab === "favorites") r = await oc.stockFavorites();
        else if (tab === "recents") r = await oc.stockRecent();
        else r = await oc.stockSearch(debouncedQuery || undefined, kind || undefined, { collection: collection?.id });
        if (!cancelled) setResults(r);
      } catch {
        if (!cancelled) { setResults([]); setError(true); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // Re-run when the tab, filters, debounced query, or active collection change.
  }, [tab, collection, debouncedQuery, kind, retryNonce]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setTab("browse");
    // Submitting from a non-browse tab routes back to browse; the effect refetches.
  }
  function setFilter(k: string) {
    setKind(k);
    setTab("browse");
  }

  function place(a: StockAssetSummary) {
    placeStock(a, toast);
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
    debouncedQuery ? `No results for “${debouncedQuery}”.` : "No stock assets available.";

  return (
    <PanelShell title="Stock">
      <div className="mb-3 flex gap-1">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => { setTab(t.id); setCollection(null); }} className={`flex flex-1 items-center justify-center gap-1 rounded-lg border px-2 py-1.5 text-xs font-medium ${tab === t.id ? "border-brand-500 bg-brand-50 text-brand-700" : "border-neutral-200 text-neutral-600 hover:bg-neutral-100"}`}>
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
          <div className="mb-3 flex gap-1">
            {STOCK_KINDS.map((f) => (
              <button key={f.label} onClick={() => setFilter(f.kind)} className={`flex-1 rounded-full border px-2 py-1 text-xs ${kind === f.kind ? "border-brand-500 bg-brand-50 text-brand-700" : "border-neutral-200 text-neutral-600 hover:bg-neutral-100"}`}>{f.label}</button>
            ))}
          </div>
          {collection ? (
            <button onClick={() => setCollection(null)} className="mb-2 flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline">
              <ChevronLeft size={13} />Back to collections
            </button>
          ) : !query && !kind && collections.length > 0 ? (
            <div className="mb-3">
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Collections</p>
              <div className="flex flex-wrap gap-1.5">
                {collections.map((c) => (
                  <button key={c.id} onClick={() => setCollection(c)} title={c.description} className="rounded-full bg-neutral-100 px-2.5 py-1 text-xs text-neutral-600 hover:bg-brand-50 hover:text-brand-700">{c.title}</button>
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
          <button onClick={() => setRetryNonce((n) => n + 1)} className="rounded-lg border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700">
            Retry
          </button>
        </div>
      ) : results.length === 0 ? (
        <p className="mt-6 text-center text-xs text-neutral-400">{emptyMessage}</p>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {results.map((a) => (
            <StockTile key={a.id} a={a} onPlace={place} onToggleStar={(x) => void toggleStar(x)} />
          ))}
        </div>
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
        <button onClick={() => setOpen(null)} className="mb-3 flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline"><ChevronLeft size={13} />All apps</button>
        <div className="mb-3 flex items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand-50 text-brand-700"><Icon size={18} /></span>
          <div>
            <p className="text-sm font-semibold text-neutral-800">{open.name}</p>
            <p className="text-[11px] text-neutral-400">Scopes: {open.scopes.join(", ")}</p>
          </div>
        </div>
        <div className="grid gap-2">
          {actions.map((a) => (
            <button key={a.label} onClick={() => runAction(open, a)} className="flex items-center gap-2 rounded-lg bg-neutral-50 px-3 py-2 text-sm text-neutral-700 hover:bg-brand-50 hover:text-brand-700">
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
          <button onClick={() => setRetryNonce((n) => n + 1)} className="rounded-lg border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700">
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
              <button key={app.id} onClick={() => setOpen(app)} className="flex aspect-square flex-col items-center justify-center gap-2 rounded-xl bg-neutral-50 text-neutral-600 transition hover:bg-brand-50 hover:text-brand-700">
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
