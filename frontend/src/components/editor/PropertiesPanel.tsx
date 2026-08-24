// Properties panel: numeric X/Y/W/H/rotation/opacity (with arithmetic-expression
// input) and blend mode for the selection. Single selection edits geometry; a
// multi-selection edits the shared fields (opacity, blend). Empty shows page info.

import type { ChangeEvent, ComponentType } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BlendMode, CharStyle, ChartNode, ChartStyle, Color, DataBinding, DesignFile, Easing, Effect, ElementLink, EmphasisPreset,
  EntrancePreset, ExitPreset, Fill, GradientFill, GradientStop, ImageFit, ImageMotion, ImageNode,
  Interaction, InteractionAction, Keyframe, KeyframeTrack, Node, NodeAnimation, Page, ParagraphStyle,
  TableConditionalRule, TableNode, TextEffect, Theme,
} from "@hc/schema";
import { themeFromPalette } from "@hc/schema";
import { deriveThemeSlots, extractLayoutSet, repairThemeSlots, themeSlotNames, type ExtractedLayoutSet, type ExtractPageLike } from "@hc/aistudio";
import { refineExtractedLayoutSet } from "@/lib/layoutVision";
import { colorHarmony, harmonySchemes, type HarmonyScheme, extractPalette, toHex } from "@hc/color";
import { evalExpression, locate, rotateAboutPoint } from "@hc/editor";
import { isLowResolution, computeEffectivePpi } from "@hc/engine";
import { fontCatalog, type FontCategory } from "@hc/text";
import {
  AlignStartVertical, AlignCenterVertical, AlignEndVertical,
  AlignStartHorizontal, AlignCenterHorizontal, AlignEndHorizontal,
  AlignHorizontalDistributeCenter, AlignVerticalDistributeCenter,
  FlipHorizontal2, FlipVertical2, BringToFront, SendToBack, ArrowUp, ArrowDown,
  Group as GroupIcon, Ungroup, Lock, Unlock, Eye, EyeOff, Sparkles,
  AlignLeft, AlignCenter, AlignRight, AlignJustify, ImagePlus,
} from "lucide-react";
import { fonts } from "@/lib/fontProvider";
import { promptText, alertText } from "@/lib/promptDialog";
import { filterPresets, resolvePresetOps, autoEnhanceOps, alphaMaskFromCutout, removeBackground, rasterizeToPng, type AdjOp } from "@/lib/imageFilters";
import { AddEffectRow, EffectStack } from "./EffectStack";
import { useEditor } from "@/store/editor";
import { BuildOrderSection } from "./BuildOrderSection";
import { usePresence } from "@/store/presence";
import { useBrand, colorsLockedFor, fontsLockedFor, brandHexColors, brandFontFamilies } from "@/store/brand";
import { lockSelection, unlockSelection } from "@/lib/useRealtime";
import { CollapsibleSection } from "./EditorPanels";
import { ColorField } from "./ColorField";
import { imageAssets } from "@/lib/assetProvider";
import { oc, resolveAssetUrl, uploadAssetWithProgress } from "@/lib/sdk";
import { MagicResizeButton } from "./MagicResizeDialog";
import { useToast } from "@/components/ui/Toast";
import { tr } from "@/lib/i18n";
import { CodedError, userMessage } from "@/lib/errors";

type IconType = ComponentType<{ size?: number | string; strokeWidth?: number; className?: string }>;

function pad2(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n * 255))).toString(16).padStart(2, "0");
}

// `fontStyle` values are file-format tokens, never localized: the engine
// parses weight/italic out of them by ENGLISH name and they persist into the
// design file, so a translated token corrupts the doc for every collaborator.
const regularFontStyle = "Regular";
const italicFontStyle = "Italic";

const FONT_CATEGORIES: FontCategory[] = ["sans-serif", "serif", "display", "handwriting", "monospace"];

// The font-family <option> list is derived purely from the static catalog (~2k
// families now that the full library is bundled), so build it ONCE at module
// scope. A stable element reference lets React skip re-reconciling the whole
// option list on every PropertiesPanel render (each style tweak/slider drag while
// a text node is selected), which otherwise janked text editing.
const FONT_FAMILY_OPTIONS = FONT_CATEGORIES.map((cat) => (
  <optgroup key={cat} label={cat} className="capitalize">
    {fontCatalog.filter((f) => f.category === cat && !f.system).map((f) => (
      <option key={f.family} value={f.family}>{f.family}</option>
    ))}
  </optgroup>
));
const weights = (): { v: number; label: string }[] => [
  { v: 300, label: tr("editor.light") },
  { v: 400, label: tr("editor.regular") },
  { v: 500, label: tr("editor.medium") },
  { v: 600, label: tr("editor.semibold") },
  { v: 700, label: tr("editor.bold") },
  { v: 800, label: tr("editor.extrabold") },
];

/** Style of the first run / first paragraph (the panel edits the whole node). */
function firstRunStyle(node: Node): CharStyle | null {
  const content = (node as unknown as { content?: { runs?: { style: CharStyle }[] }[] }).content;
  return content?.[0]?.runs?.[0]?.style ?? null;
}
function firstParaStyle(node: Node): ParagraphStyle | null {
  const content = (node as unknown as { content?: { style: ParagraphStyle }[] }).content;
  return content?.[0]?.style ?? null;
}
function colorFromHex(hex: string): Color {
  const n = parseInt(hex.replace("#", "").slice(0, 6), 16) || 0;
  return { srgb: { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 } };
}
function solidFromHex(hex: string): Fill {
  return { type: "solid", color: colorFromHex(hex) };
}
function colorHex(c: { srgb: { r: number; g: number; b: number } }): string {
  return `#${pad2(c.srgb.r)}${pad2(c.srgb.g)}${pad2(c.srgb.b)}`;
}
function firstFill(node: Node): Fill | undefined {
  return (node as unknown as { fills?: Fill[] }).fills?.[0];
}
function makeGradient(hex: string): Fill {
  return { type: "gradient", gradient: "linear", angle: 90, stops: [{ position: 0, color: colorFromHex(hex) }, { position: 1, color: { srgb: { r: 1, g: 1, b: 1, a: 1 } } }] };
}
const PALETTE = ["#111827", "#ffffff", "#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#6366f1", "#8b5cf6", "#ec4899", "#64748b"];

/** The active page's solid background color (default white), as a contrast
 *  reference for the color picker's WCAG badge. */
function pageBgOf(doc: DesignFile, activePage: number): Color {
  const pg = doc.pages[Math.min(activePage, doc.pages.length - 1)];
  const b = (pg as unknown as { background?: Fill }).background;
  return b?.type === "solid" ? b.color : { srgb: { r: 1, g: 1, b: 1, a: 1 } };
}

// Recently-used colors, persisted across the session in
// localStorage. Read at render; written when a color is applied. Not reactive,
// but the panel re-renders on each edit (rev bump), so the row stays current.
const RECENT_COLORS_KEY = "oc-recent-colors";
function recentColorList(): string[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(window.localStorage.getItem(RECENT_COLORS_KEY) || "[]"); } catch { return []; }
}
function rememberColor(hex: string) {
  if (typeof window === "undefined" || !/^#[0-9a-fA-F]{6}$/.test(hex)) return;
  const next = [hex, ...recentColorList().filter((c) => c.toLowerCase() !== hex.toLowerCase())].slice(0, 12);
  try { window.localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
}

/** A row of recently-used color swatches; hidden when there are none. */
function RecentColors({ onPick }: { onPick: (hex: string) => void }) {
  const recents = recentColorList();
  if (!recents.length) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-neutral-400">{tr("editor.recent")}</span>
      <div className="flex flex-wrap gap-1.5">
        {recents.map((c) => <Swatch key={c} color={c} onClick={() => onPick(c)} />)}
      </div>
    </div>
  );
}
// Color-harmony suggestions derived from the current fill (complementary,
// analogous, triadic, ...). Picking a swatch applies it. Pure @hc/color math.
function ColorHarmony({ baseHex, onPick }: { baseHex: string; onPick: (hex: string) => void }) {
  const [scheme, setScheme] = useState<HarmonyScheme>("complementary");
  const swatches = colorHarmony(colorFromHex(baseHex), scheme).map((c) => colorHex(c));
  return (
    <div className="flex flex-col gap-1">
      <select aria-label={tr("editor.color_harmony")} value={scheme} onChange={(e) => setScheme(e.target.value as HarmonyScheme)} className="self-start rounded-md border border-neutral-200 bg-surface px-1.5 py-0.5 text-[11px] text-neutral-500 outline-none">
        {harmonySchemes.map((s) => <option key={s} value={s}>{s.replace("-", " ")}</option>)}
      </select>
      <div className="flex flex-wrap gap-1.5">
        {swatches.map((c, i) => <Swatch key={`${c}-${i}`} color={c} title={`Apply ${c}`} onClick={() => onPick(c)} />)}
      </div>
    </div>
  );
}
// "Pick palette from this photo": samples the selected image's loaded bitmap and
// extracts its dominant colors (reuses @hc/color extractPalette, as the brand
// logo flow does). Picked swatches go to recents so they flow into every picker.
function ImagePalette({ assetId }: { assetId: string }) {
  const [colors, setColors] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const extract = () => {
    const img = imageAssets.image(assetId) as (CanvasImageSource & { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number }) | null;
    if (!img) return;
    setBusy(true);
    try {
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (!w || !h) { setBusy(false); return; }
      const SAMPLE = 128;
      const scale = Math.min(1, SAMPLE / Math.max(w, h));
      const sw = Math.max(1, Math.round(w * scale));
      const sh = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement("canvas");
      canvas.width = sw; canvas.height = sh;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(img, 0, 0, sw, sh);
        const bmp = ctx.getImageData(0, 0, sw, sh);
        setColors([...new Set(extractPalette(bmp, 6).map(toHex))]);
      }
    } catch { /* tainted canvas (cross-origin without CORS): leave colors null */ }
    setBusy(false);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <button onClick={extract} disabled={busy} className="self-start rounded-lg bg-neutral-100 px-2.5 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-200 disabled:opacity-40">
        {busy ? tr("editor.reading") : colors ? tr("editor.re_extract_palette") : tr("editor.extract_palette")}
      </button>
      {colors && colors.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {colors.map((c, i) => <Swatch key={`${c}-${i}`} color={c} title={`${c} (added to recent colors)`} onClick={() => rememberColor(c)} />)}
        </div>
      )}
      {colors && colors.length === 0 && <span className="text-[11px] text-neutral-400">{tr("editor.image_read_failed_cross_origin")}</span>}
    </div>
  );
}
// Editable chart data grid: rows are categories, columns are series. Edits commit
// the whole categories+series arrays back through setChart (undoable).
function ChartDataTable({ node }: { node: ChartNode }) {
  const id = node.id;
  const st = useEditor.getState();
  const cats = node.categories ?? [];
  const series = node.series ?? [];
  const commit = (categories: string[], next: { name: string; values: number[]; color?: Color }[]) =>
    st.setChart(id, { categories, series: next });
  const setCell = (row: number, col: number, v: number) => {
    const next = series.map((s, j) => j === col ? { ...s, values: cats.map((_, r) => r === row ? v : (s.values[r] ?? 0)) } : s);
    commit(cats, next);
  };
  const setCat = (row: number, label: string) => commit(cats.map((c, r) => r === row ? label : c), series);
  const setSeriesName = (col: number, name: string) => commit(cats, series.map((s, j) => j === col ? { ...s, name } : s));
  const addRow = () => commit([...cats, `Item ${cats.length + 1}`], series.map((s) => ({ ...s, values: [...s.values, 0] })));
  const removeRow = (row: number) => commit(cats.filter((_, r) => r !== row), series.map((s) => ({ ...s, values: s.values.filter((_, r) => r !== row) })));
  const addSeries = () => commit(cats, [...series, { name: `Series ${series.length + 1}`, values: cats.map(() => 0) }]);
  const removeSeries = (col: number) => commit(cats, series.filter((_, j) => j !== col));
  const cell = "rounded border border-neutral-200 px-1 py-0.5 text-[11px] outline-none focus:border-brand-400";
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] text-neutral-400">{tr("editor.data")}</span>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[11px]">
          <thead>
            <tr>
              <th className="p-0.5" />
              {series.map((s, j) => (
                <th key={`sh-${j}`} className="p-0.5">
                  <div className="flex items-center gap-0.5">
                    <input defaultValue={s.name} key={`sn-${id}-${j}-${s.name}`} aria-label={tr("editor.series_n_name", { n: j + 1 })} onBlur={(e) => setSeriesName(j, e.target.value.trim() || `Series ${j + 1}`)} className={`${cell} w-16`} />
                    {series.length > 1 && <button onClick={() => removeSeries(j)} className="text-neutral-300 hover:text-red-600" title={tr("editor.remove_series")}>×</button>}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cats.map((c, r) => (
              <tr key={`row-${r}`}>
                <td className="p-0.5">
                  <div className="flex items-center gap-0.5">
                    <input defaultValue={c} key={`cn-${id}-${r}-${c}`} aria-label={tr("editor.row_n_label", { n: r + 1 })} onBlur={(e) => setCat(r, e.target.value.trim() || `Item ${r + 1}`)} className={`${cell} w-16`} />
                    {cats.length > 1 && <button onClick={() => removeRow(r)} className="text-neutral-300 hover:text-red-600" title={tr("editor.remove_row")}>×</button>}
                  </div>
                </td>
                {series.map((s, j) => (
                  <td key={`c-${r}-${j}`} className="p-0.5">
                    <input type="number" defaultValue={s.values[r] ?? 0} key={`v-${id}-${r}-${j}-${s.values[r] ?? 0}`} aria-label={tr("editor.row_n_series_m_value", { n: r + 1, m: j + 1 })} onBlur={(e) => setCell(r, j, Number(e.target.value) || 0)} className={`${cell} w-14`} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex gap-2">
        <button onClick={addRow} className="text-[11px] text-brand-ink hover:underline">+ Row</button>
        <button onClick={addSeries} className="text-[11px] text-brand-ink hover:underline">+ Series</button>
      </div>
    </div>
  );
}
// Inline video controls on the design canvas: scrub, play/pause (repaints the
// canvas each frame via the store tick), trim in/out, mute, loop. The actual
// <video> element lives in the asset provider; the engine draws its current frame.
function VideoSection({ node }: { node: Node }) {
  const id = node.id;
  const v = node as unknown as { assetId: string; trimStartMs?: number; trimEndMs?: number; muted?: boolean; loop?: boolean };
  const st = useEditor.getState();
  const [time, setTime] = useState(0);
  const [, force] = useState(0); // re-render when metadata (duration) loads
  const [playing, setPlaying] = useState(false);
  const raf = useRef<number | null>(null);
  const el = () => imageAssets.videoEl(v.assetId);
  const dur = el()?.duration || 0; // derived live so no setState-in-effect
  useEffect(() => {
    const ve = el();
    if (!ve) return;
    const onMeta = () => force((x) => x + 1);
    ve.addEventListener("loadedmetadata", onMeta);
    return () => { ve.removeEventListener("loadedmetadata", onMeta); if (raf.current) cancelAnimationFrame(raf.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.assetId]);
  const trimEnd = (v.trimEndMs ?? 0) > 0 ? (v.trimEndMs as number) / 1000 : dur;
  const trimStart = (v.trimStartMs ?? 0) / 1000;
  const seek = (sec: number) => { const ve = el(); if (!ve) return; ve.currentTime = sec; setTime(sec); st.tick(); };
  const stop = () => { const ve = el(); if (ve) ve.pause(); if (raf.current) cancelAnimationFrame(raf.current); raf.current = null; setPlaying(false); };
  const loop = () => {
    const ve = el();
    if (!ve) return;
    setTime(ve.currentTime);
    st.tick();
    if (ve.currentTime >= trimEnd) {
      if (v.loop) { ve.currentTime = trimStart; } else { stop(); return; }
    }
    raf.current = requestAnimationFrame(loop);
  };
  const play = () => {
    const ve = el();
    if (!ve) return;
    if (playing) { stop(); return; }
    if (ve.currentTime < trimStart || ve.currentTime >= trimEnd) ve.currentTime = trimStart;
    ve.muted = v.muted ?? true;
    void ve.play();
    setPlaying(true);
    raf.current = requestAnimationFrame(loop);
  };
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  return (
    <Section title={tr("editor.video")} order={ORDER.type}>
      {!el() && <p className="text-[11px] text-neutral-400">{tr("editor.loading_video")}</p>}
      <div className="flex items-center gap-2">
        <button onClick={play} className="grid h-8 w-8 place-items-center rounded-lg bg-neutral-100 text-neutral-700 hover:bg-neutral-200" title={playing ? tr("editor.pause") : tr("editor.play")}>{playing ? "❚❚" : "▶"}</button>
        <input type="range" min={0} max={Math.max(0.1, dur)} step={0.05} value={time} aria-label={tr("editor.scrub_video")} onChange={(e) => seek(Number(e.target.value))} className="flex-1 accent-brand-600" />
        <span className="w-16 shrink-0 text-end text-[10px] tabular-nums text-neutral-400">{fmt(time)} / {fmt(dur)}</span>
      </div>
      <div className="flex items-center gap-2">
        <button onClick={() => st.setVideoProps(id, { trimStartMs: Math.round(time * 1000) })} className="flex-1 rounded-lg bg-neutral-100 px-2 py-1.5 text-[11px] text-neutral-600 hover:bg-neutral-200" title={tr("editor.trim_start_to_playhead")}>Set start ({fmt(trimStart)})</button>
        <button onClick={() => st.setVideoProps(id, { trimEndMs: Math.round(time * 1000) })} className="flex-1 rounded-lg bg-neutral-100 px-2 py-1.5 text-[11px] text-neutral-600 hover:bg-neutral-200" title={tr("editor.trim_end_to_playhead")}>Set end ({fmt(trimEnd)})</button>
        {((v.trimStartMs ?? 0) > 0 || (v.trimEndMs ?? 0) > 0) && (
          <button onClick={() => st.setVideoProps(id, { trimStartMs: 0, trimEndMs: 0 })} className="rounded-lg bg-neutral-100 px-2 py-1.5 text-[11px] text-neutral-500 hover:bg-neutral-200" title={tr("editor.clear_trim")}>↺</button>
        )}
      </div>
      <div className="flex items-center gap-4 text-[11px] text-neutral-600">
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={!!v.muted} onChange={(e) => st.setVideoProps(id, { muted: e.target.checked })} /> {tr("editor.mute")}</label>
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={!!v.loop} onChange={(e) => st.setVideoProps(id, { loop: e.target.checked })} /> {tr("editor.loop")}</label>
      </div>
    </Section>
  );
}
const chipCls = (active: boolean) => `rounded-md px-2.5 py-1 text-xs font-medium transition ${active ? "bg-surface text-brand-ink shadow-sm" : "text-neutral-500 hover:text-neutral-700"}`;
const selectCls = "w-full rounded-lg border border-neutral-200 bg-surface px-2 py-1.5 text-sm text-neutral-800 outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100";
const actionBtnCls = "w-full rounded-lg border border-neutral-200 bg-surface px-2 py-1.5 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50";
const inputCls = "w-full rounded-lg border border-neutral-200 bg-surface px-2 py-1.5 text-sm text-neutral-800 outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100";

function runColorHex(style: CharStyle): string {
  if (style.fill?.type === "solid") {
    const { r, g, b } = style.fill.color.srgb;
    return `#${pad2(r)}${pad2(g)}${pad2(b)}`;
  }
  return "#111827";
}

function hasFills(node: Node): boolean {
  return Array.isArray((node as unknown as { fills?: unknown[] }).fills);
}

function textOf(node: Node): string {
  const content = (node as unknown as { content?: { runs?: { text: string }[] }[] }).content;
  return content?.map((p) => (p.runs ?? []).map((r) => r.text).join("")).join("\n") ?? "";
}

const BLEND_MODES: BlendMode[] = [
  "normal", "multiply", "screen", "overlay", "darken", "lighten",
  "color-dodge", "color-burn", "hard-light", "soft-light",
  "difference", "exclusion", "hue", "saturation", "color", "luminosity",
];

// Uncontrolled: keyed by `value` at the call site so it resets when the value
// changes externally (commit/undo) but keeps local text while the user types.
function Field({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (n: number) => void;
}) {
  const initial = String(Math.round(value * 100) / 100);
  const commit = (el: HTMLInputElement) => {
    const n = evalExpression(el.value, value);
    if (n === null) el.value = initial;
    else onCommit(n);
  };
  return (
    <label className="flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-surface px-2 py-1.5 text-sm transition focus-within:border-brand-400 focus-within:ring-2 focus-within:ring-brand-100">
      <span className="shrink-0 text-xs font-medium text-neutral-400">{label}</span>
      <input
        defaultValue={initial}
        onBlur={(e) => commit(e.target)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="w-full min-w-0 bg-transparent text-neutral-800 outline-none"
      />
    </label>
  );
}

const PAGE_PRESETS: { label: string; w: number; h: number }[] = [
  { label: "Instagram Post (1080×1080)", w: 1080, h: 1080 },
  { label: "Instagram Story (1080×1920)", w: 1080, h: 1920 },
  { label: "Presentation 16:9 (1920×1080)", w: 1920, h: 1080 },
  { label: "Facebook Post (1200×630)", w: 1200, h: 630 },
  { label: "Poster (1080×1350)", w: 1080, h: 1350 },
  { label: "A4 Document (1240×1754)", w: 1240, h: 1754 },
  { label: "Logo (500×500)", w: 500, h: 500 },
  { label: "Business Card (1050×600)", w: 1050, h: 600 },
];

const GRADIENT_PRESETS: [string, string][] = [
  ["#f857a6", "#ff5858"],
  ["#4facfe", "#00f2fe"],
  ["#43e97b", "#38f9d7"],
  ["#fa709a", "#fee140"],
  ["#667eea", "#764ba2"],
  ["#30cfd0", "#330867"],
  ["#ff9a9e", "#fad0c4"],
  ["#a18cd1", "#fbc2eb"],
  ["#f6d365", "#fda085"],
  ["#84fab0", "#8fd3f4"],
  ["#0f2027", "#2c5364"],
  ["#ee9ca7", "#ffdde1"],
];

/** rgba() string for a color, including its alpha (gradient previews need it). */
function colorRgba(c: Color): string {
  const s = c.srgb;
  return `rgba(${Math.round(s.r * 255)}, ${Math.round(s.g * 255)}, ${Math.round(s.b * 255)}, ${s.a ?? 1})`;
}

/** CSS preview of a gradient (always shown as a left-to-right bar), with alpha. */
function gradientCss(g: GradientFill): string {
  const stops = [...g.stops].sort((a, b) => a.position - b.position);
  const parts = stops.map((s) => `${colorRgba(s.color)} ${Math.round(s.position * 100)}%`);
  return `linear-gradient(90deg, ${parts.join(", ")})`;
}

/** Multi-stop gradient editor: type (linear/radial/conic), stops, angle, presets. */
function GradientEditor({ g, onChange }: { g: GradientFill; onChange: (patch: Partial<GradientFill>) => void }) {
  // Render rows in the stops' own array order (stable) so dragging a stop's
  // position past a neighbor never reorders the rows and swaps the dragged
  // thumb. The preview bar sorts independently (gradientCss).
  const setStop = (i: number, patch: Partial<GradientStop>) => {
    onChange({ stops: g.stops.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  };
  const addStop = () => {
    // Insert a stop at the largest gap, colored from the nearest neighbor.
    const sorted = [...g.stops].sort((a, b) => a.position - b.position);
    let gap = -1, at = 0.5;
    for (let i = 0; i < sorted.length - 1; i++) {
      const d = sorted[i + 1].position - sorted[i].position;
      if (d > gap) { gap = d; at = (sorted[i].position + sorted[i + 1].position) / 2; }
    }
    const near = sorted.reduce((p, c) => (Math.abs(c.position - at) < Math.abs(p.position - at) ? c : p), sorted[0]);
    onChange({ stops: [...g.stops, { position: at, color: near.color }] });
  };
  const removeStop = (i: number) => {
    if (g.stops.length <= 2) return;
    onChange({ stops: g.stops.filter((_, j) => j !== i) });
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1 self-start rounded-lg bg-neutral-100 p-0.5">
        {(["linear", "radial", "conic"] as const).map((t) => (
          <button key={t} onClick={() => onChange({ gradient: t })} className={chipCls(g.gradient === t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <div className="h-5 w-full rounded border border-neutral-300" style={{ background: gradientCss(g) }} />
      <div className="flex flex-col gap-1">
        {g.stops.map((s, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <input type="color" value={colorHex(s.color)} onChange={(e) => setStop(i, { color: { srgb: { ...colorFromHex(e.target.value).srgb, a: s.color.srgb.a ?? 1 } } })} className="oc-color h-7 w-8 shrink-0" title={tr("editor.stop_color")} aria-label={tr("editor.stop_color")} />
            <input type="range" min={0} max={100} value={Math.round(s.position * 100)} aria-label={tr("editor.position")} onChange={(e) => setStop(i, { position: Number(e.target.value) / 100 })} className="flex-1" title={`Position ${Math.round(s.position * 100)}%`} />
            <input type="range" min={0} max={100} value={Math.round((s.color.srgb.a ?? 1) * 100)} aria-label={tr("editor.opacity")} onChange={(e) => setStop(i, { color: { srgb: { ...s.color.srgb, a: Number(e.target.value) / 100 } } })} className="w-12 shrink-0 accent-neutral-400" title={`Opacity ${Math.round((s.color.srgb.a ?? 1) * 100)}%`} />
            <button onClick={() => removeStop(i)} disabled={g.stops.length <= 2} className="text-neutral-300 hover:text-red-600 disabled:opacity-30" title={tr("editor.remove_stop")}>×</button>
          </div>
        ))}
      </div>
      <button onClick={addStop} className="self-start text-xs text-brand-ink hover:underline">+ Add stop</button>
      {g.gradient !== "radial" && (
        <Field key={`ga${g.angle ?? 90}`} label="∠" value={g.angle ?? 90} onCommit={(n) => onChange({ angle: n })} />
      )}
      {/* Center (radial/conic) and radius (radial): the engine reads center/radius
          to place and size the gradient within the node box. */}
      {(g.gradient === "radial" || g.gradient === "conic") && (() => {
        const c = g.center ?? { x: 0.5, y: 0.5 };
        const setCenter = (patch: Partial<{ x: number; y: number }>) => onChange({ center: { ...c, ...patch } });
        return (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <span className="w-12 shrink-0 text-[11px] text-neutral-400">{tr("editor.center_x")}</span>
              <input type="range" min={0} max={100} value={Math.round(c.x * 100)} aria-label={tr("editor.center_x")} onChange={(e) => setCenter({ x: Number(e.target.value) / 100 })} className="flex-1 accent-brand-600" />
            </div>
            <div className="flex items-center gap-2">
              <span className="w-12 shrink-0 text-[11px] text-neutral-400">{tr("editor.center_y")}</span>
              <input type="range" min={0} max={100} value={Math.round(c.y * 100)} aria-label={tr("editor.center_y")} onChange={(e) => setCenter({ y: Number(e.target.value) / 100 })} className="flex-1 accent-brand-600" />
            </div>
            {g.gradient === "radial" && (
              <div className="flex items-center gap-2">
                <span className="w-12 shrink-0 text-[11px] text-neutral-400">{tr("editor.radius")}</span>
                <input type="range" min={5} max={150} value={Math.round((g.radius ?? 0.5) * 100)} aria-label={tr("editor.radius")} onChange={(e) => onChange({ radius: Number(e.target.value) / 100 })} className="flex-1 accent-brand-600" />
              </div>
            )}
          </div>
        );
      })()}
      <div className="flex flex-wrap gap-1">
        {GRADIENT_PRESETS.map(([a, b], i) => (
          <button
            key={i}
            onClick={() => onChange({ stops: [{ position: 0, color: colorFromHex(a) }, { position: 1, color: colorFromHex(b) }] })}
            style={{ background: `linear-gradient(90deg, ${a}, ${b})` }}
            className="h-5 w-7 rounded border border-neutral-300"
            title={tr("editor.apply_preset")}
          />
        ))}
      </div>
    </div>
  );
}

/** QR center-logo control: upload a new image or pick an existing workspace
 *  upload. The picked/uploaded asset id is set as the QR's logoAssetId (a real
 *  workspace asset, so server exports can embed it); adding a logo raises error
 *  correction to keep the code scannable. */
function QrLogoControl({ id, logoAssetId, logoScale, workspaceId }: { id: string; logoAssetId?: string; logoScale?: number; workspaceId: string | null }) {
  type UpAsset = { id: string; url: string; filename?: string; thumbnail?: string; mimeType?: string };
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [assets, setAssets] = useState<UpAsset[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const loadAssets = useCallback(() => {
    if (!workspaceId) return;
    void oc.listAssets(workspaceId)
      .then((a) => setAssets((a as UpAsset[]).filter((x) => (x.mimeType ?? "").startsWith("image/"))))
      .catch(() => setAssets([]));
  }, [workspaceId]);
  useEffect(() => { if (open) loadAssets(); }, [open, loadAssets]);
  const pick = (assetId: string, url: string) => { useEditor.getState().setQrLogo(id, assetId, resolveAssetUrl(url)); setOpen(false); };
  const onUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = "";
    if (!file || !workspaceId) return;
    setBusy(true);
    try {
      const dataUrl = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result));
        r.onerror = () => rej(new CodedError("errors.file_read_failed", "Could not read the file."));
        r.readAsDataURL(file);
      });
      const asset = await uploadAssetWithProgress(workspaceId, { filename: file.name, dataBase64: dataUrl.split(",")[1] ?? "" });
      pick(asset.id, asset.url);
    } catch { /* upload failed; leave the QR unchanged */ } finally { setBusy(false); }
  };
  const logoUrl = logoAssetId ? useEditor.getState().doc.assets.find((a) => a.id === logoAssetId)?.url : undefined;
  const btn = "flex-1 rounded bg-neutral-100 px-2 py-1 text-[11px] text-neutral-700 hover:bg-neutral-200 disabled:opacity-50";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-[11px] text-neutral-400">
        <span>{tr("editor.center_logo")}</span>
        {logoAssetId && (
          <button onClick={() => useEditor.getState().setQrLogo(id, null)} className="text-[11px] text-neutral-500 hover:text-neutral-800">{tr("editor.remove")}</button>
        )}
      </div>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => void onUpload(e)} />
      {logoAssetId ? (
        <div className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {logoUrl && <img src={logoUrl} alt={tr("editor.qr_logo")} className="h-10 w-10 rounded border border-neutral-200 object-contain" />}
          <button onClick={() => fileRef.current?.click()} disabled={busy || !workspaceId} className={btn}>{busy ? tr("editor.uploading") : tr("editor.replace_2")}</button>
        </div>
      ) : (
        <div className="flex gap-1.5">
          <button onClick={() => fileRef.current?.click()} disabled={busy || !workspaceId} className={btn}>{busy ? tr("editor.uploading") : tr("editor.upload_logo")}</button>
          <button onClick={() => setOpen((v) => !v)} disabled={!workspaceId} className={btn}>{tr("editor.from_uploads")}</button>
        </div>
      )}
      {open && !logoAssetId && (
        <div className="grid grid-cols-4 gap-1.5">
          {assets.length === 0 && <span className="col-span-4 text-[11px] text-neutral-400">{tr("editor.no_image_uploads_yet")}</span>}
          {assets.map((a) => (
            <button
              key={a.id}
              onClick={() => pick(a.id, a.url)}
              title={a.filename ?? "asset"}
              className="flex aspect-square items-center justify-center overflow-hidden rounded border border-neutral-200 hover:border-brand-300"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={a.thumbnail ?? resolveAssetUrl(a.url)} alt={a.filename ?? ""} className="max-h-full max-w-full object-contain" />
            </button>
          ))}
        </div>
      )}
      {logoAssetId && (
        <label className="flex items-center gap-2 text-[11px] text-neutral-400">
          <span className="w-9 shrink-0">{tr("editor.size")}</span>
          <input
            type="range"
            min={8}
            max={40}
            step={1}
            value={Math.round((logoScale ?? 0.22) * 100)}
            onChange={(e) => useEditor.getState().setQrLogoScale(id, Number(e.target.value) / 100)}
            className="h-1 flex-1 cursor-pointer accent-brand-600"
          />
          <span className="w-8 shrink-0 text-end tabular-nums">{Math.round((logoScale ?? 0.22) * 100)}%</span>
        </label>
      )}
      <p className="text-[11px] text-neutral-400">{tr("editor.error_correction_is_raised_so_the_code_stays")}</p>
    </div>
  );
}

export function PropertiesPanel({ workspaceId }: { workspaceId?: string | null } = {}) {
  useEditor((s) => s.rev);
  const selection = useEditor((s) => s.selection);
  const activePage = useEditor((s) => s.activePage);
  // The table cell targeted by the cell-formatting controls (F27).
  const [tableCell, setTableCell] = useState<{ row: number; col: number }>({ row: 0, col: 0 });
  // Subscribe to collaborative locks + connection so the lock affordance and the
  // "Locked by X" read-only state track the realtime server.
  const locks = usePresence((s) => s.locks);
  const selfClientId = usePresence((s) => s.self?.clientId ?? null);
  const connected = usePresence((s) => s.connection) === "connected";
  const doc = useEditor.getState().doc;

  // Brand lock state: when the active kit locks colors/fonts
  // and the caller is NOT a brand admin, the pickers below offer only the kit's
  // approved values (swatch-only color picker, brand-font-only selector). Admins
  // (manage-brand) are unconstrained. Subscribe so toggles update live.
  const brand = useBrand((s) => s.kit);
  const brandCanManage = useBrand((s) => s.canManage);
  // Brand locked regions: subscribe so the panel goes
  // read-only when the single selected node is a locked region for a non-admin.
  const brandLockedRegions = useBrand((s) => s.lockedRegions);
  const brandState = { kit: brand, canManage: brandCanManage } as Parameters<typeof colorsLockedFor>[0];
  const lockColors = colorsLockedFor(brandState);
  const lockFonts = fontsLockedFor(brandState);
  const brandSwatches = lockColors ? brandHexColors(brand) : null;
  const brandFonts = lockFonts ? brandFontFamilies(brand) : null;

  if (selection.length === 0) {
    const page = doc.pages[Math.min(activePage, doc.pages.length - 1)];
    const st = useEditor.getState();
    const cur = `${Math.round(page.width)}x${Math.round(page.height)}`;
    return (
      <Wrap>
        <Section title={tr("editor.page_size")}>
          <select aria-label={tr("editor.page_size")}
            value={PAGE_PRESETS.some((p) => `${p.w}x${p.h}` === cur) ? cur : "custom"}
            onChange={(e) => {
              const p = PAGE_PRESETS.find((x) => `${x.w}x${x.h}` === e.target.value);
              if (p) st.setPageSize(p.w, p.h);
            }}
            className="w-full rounded-lg border border-neutral-200 bg-surface px-2 py-1.5 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
          >
            {!PAGE_PRESETS.some((p) => `${p.w}x${p.h}` === cur) && <option value="custom">Custom ({cur})</option>}
            {PAGE_PRESETS.map((p) => <option key={p.label} value={`${p.w}x${p.h}`}>{p.label}</option>)}
          </select>
          <div className="grid grid-cols-2 gap-2">
            <Field key={`pw${page.width}`} label="W" value={Math.round(page.width)} onCommit={(n) => st.setPageSize(n, page.height)} />
            <Field key={`ph${page.height}`} label="H" value={Math.round(page.height)} onCommit={(n) => st.setPageSize(page.width, n)} />
          </div>
          <p className="text-[11px] text-neutral-400">Resize the current page. Units: {doc.unit}.</p>
          <MagicResizeButton />
        </Section>
        {(() => {
          // Slide layouts (doc 28 FR-3/FR-4): link this page to a reusable
          // layout, capture the page AS a layout, push edits back, and sync
          // every linked page. Materialization model: applying copies the
          // background and creates missing placeholder text boxes.
          const st2 = useEditor.getState();
          const layouts = (doc as unknown as { layouts?: { id: string; name: string }[] }).layouts ?? [];
          const pageLayoutId = (page as unknown as { layoutId?: string }).layoutId ?? "";
          const saveAs = async () => {
            const name = await promptText({ title: tr("editor.save_page_as_layout"), label: tr("editor.layout_name"), placeholder: tr("editor.title_body"), confirmText: tr("editor.save_layout") });
            if (name) useEditor.getState().savePageAsLayout(name);
          };
          return (
            <Section title={tr("editor.slide_layout")}>
              <select
                value={pageLayoutId}
                onChange={(e) => useEditor.getState().applyLayoutToPage(e.target.value || null)}
                className={selectCls}
                aria-label={tr("editor.slide_layout")}
              >
                <option value="">{tr("editor.no_layout")}</option>
                {layouts.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
              <div className="flex gap-1.5">
                <button onClick={() => void saveAs()} className="flex-1 rounded-md border border-neutral-200 px-2 py-1 text-[11px] font-medium text-neutral-700 transition hover:bg-neutral-50">
                  {tr("editor.save_page_as_layout")}
                </button>
                {pageLayoutId && (
                  <>
                    <button
                      onClick={() => { if (st2.updateLayoutFromPage(pageLayoutId)) st2.syncLayoutPages(pageLayoutId); }}
                      title={tr("editor.re_capture_this_pages_background_and_text_sl")}
                      className="flex-1 rounded-md border border-neutral-200 px-2 py-1 text-[11px] font-medium text-brand-ink transition hover:bg-brand-50"
                    >
                      {tr("editor.update_sync")}
                    </button>
                  </>
                )}
              </div>
              <p className="text-[11px] text-neutral-400">{tr("editor.layouts_keep_repeated_slides_consistent_appl")}</p>
            </Section>
          );
        })()}
        {(() => {
          const bg = (page as unknown as { background?: Fill }).background;
          const bgHex = bg?.type === "solid" ? colorHex(bg.color) : "#ffffff";
          return (
            <Section title={tr("editor.background")}>
              {brandSwatches ? (
                <>
                  <BrandLockHint />
                  <div className="flex flex-wrap gap-1.5">
                    {brandSwatches.map((c) => (
                      <Swatch key={c} color={c} onClick={() => st.setPageBackground(solidFromHex(c))} />
                    ))}
                    <button onClick={() => st.setPageBackground(undefined)} title={tr("editor.no_background_transparent")} className="rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-500 transition hover:bg-neutral-100">{tr("editor.none")}</button>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <input type="color" value={bgHex} aria-label={tr("editor.background_color")} onChange={(e) => st.setPageBackground(solidFromHex(e.target.value))} className="oc-color h-8 flex-1" />
                    <button onClick={() => st.setPageBackground(undefined)} title={tr("editor.no_background_transparent")} className="rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-500 transition hover:bg-neutral-100">{tr("editor.none")}</button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {PALETTE.map((c) => (
                      <Swatch key={c} color={c} onClick={() => st.setPageBackground(solidFromHex(c))} />
                    ))}
                  </div>
                </>
              )}
            </Section>
          );
        })()}
        <PageLayoutSection page={page} workspaceId={workspaceId ?? null} />
        <DeckThemeSection />
        <PageTransitionSection page={page} />
        <Section title={tr("editor.build_order")} defaultOpen={false}>
          <BuildOrderSection />
        </Section>
        <PagePresentSection page={page} />
      </Wrap>
    );
  }

  const single = selection.length === 1 ? locate(doc, selection[0]) : null;

  const commitGeo = (patch: { x?: number; y?: number; w?: number; h?: number; rotation?: number }) => {
    if (!single || single.node.locked) return;
    const t = single.node.transform;
    const sz = single.node.size;
    let nextT = { ...t, x: patch.x ?? t.x, y: patch.y ?? t.y };
    const nextSz = { width: Math.max(1, patch.w ?? sz.width), height: Math.max(1, patch.h ?? sz.height) };
    // An angle edit pivots about the node's rotation origin (center by
    // default), matching the rotate handle; writing rotation raw would swing
    // the node around its top-left corner instead.
    if (patch.rotation !== undefined && patch.rotation !== t.rotation) {
      nextT = rotateAboutPoint(nextT, nextSz, patch.rotation - t.rotation, t.origin ?? { x: 0.5, y: 0.5 });
    }
    // Text lays out to node.box, so a panel W/H edit must reflow the box too
    // (mirrors the resize gizmo). The store commits transform + size + box as one step.
    if (single.node.type === "text") {
      useEditor.getState().applyTextGeometry(single.node.id, nextT, nextSz);
      return;
    }
    // A line draws from its points, so W/H edits must scale the polyline too.
    if (single.node.type === "line") {
      useEditor.getState().applyLineGeometry(single.node.id, nextT, nextSz);
      return;
    }
    // A photo grid lays its cells out from the grid box, so W/H edits re-lay them.
    if (single.node.type === "grid") {
      useEditor.getState().applyGridGeometry(single.node.id, nextT, nextSz);
      return;
    }
    // A frame's fill image is sized to the frame box, so W/H edits scale it too.
    if (single.node.type === "frame") {
      useEditor.getState().applyFrameGeometry(single.node.id, nextT, nextSz);
      return;
    }
    useEditor.getState().runCommand({
      kind: "transform",
      nodes: [single.node.id],
      before: [{ ...t }],
      after: [nextT],
      beforeSizes: [{ ...sz }],
      afterSizes: [nextSz],
    });
  };

  // Opacity/blend reflect the first selected node (accurate when uniform, and far
  // better than the old hardcoded 100%/normal for a multi-selection).
  const selNodes = selection.map((id) => locate(doc, id)?.node).filter(Boolean) as Node[];
  // Collaborative-lock state for the current selection. A holder is
  // another participant when its clientId !== ours; self-held means we placed it.
  const lockedByOtherHolder = (() => {
    for (const id of selection) {
      const h = locks[id];
      if (h && h.clientId !== selfClientId) return h;
    }
    return null;
  })();
  const selfHoldsAll = selection.length > 0 && selection.every((id) => locks[id]?.clientId === selfClientId);
  // The single selected node is a brand locked region this caller may not edit
  //: manage-brand users are unconstrained.
  const brandLocked = !brandCanManage && !!single && brandLockedRegions.includes(single.node.id);
  // While another user holds a lock on any selected node, or it is a brand locked
  // region, the panel is read-only.
  const locked = !!single?.node.locked || !!lockedByOtherHolder || brandLocked;
  const opacity = selNodes[0]?.opacity ?? 1;
  const blend = selNodes[0]?.blendMode ?? "normal";

  return (
    <Wrap>
      <div className="flex items-center justify-between gap-2">
        <Heading>{single ? (single.node.name ?? single.node.type) : `${selection.length} selected`}</Heading>
        {single && (() => {
          const st = useEditor.getState();
          const n = single.node;
          const hidden = !!n.hidden;
          const btn = "grid h-7 w-7 place-items-center rounded-lg border transition";
          return (
            <div className="flex gap-1">
              <button title={hidden ? tr("editor.show") : tr("editor.hide")} aria-label={hidden ? tr("editor.show") : tr("editor.hide")} onClick={() => st.setNodeHidden(n.id, !hidden)} className={`${btn} border-neutral-200 text-neutral-500 hover:bg-neutral-100`}>
                {hidden ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
              <button title={locked ? tr("editor.unlock") : tr("editor.lock")} aria-label={locked ? tr("editor.unlock") : tr("editor.lock")} onClick={() => st.setNodeLocked(n.id, !locked)} className={`${btn} ${locked ? "border-amber-200 bg-amber-50 text-amber-700" : "border-neutral-200 text-neutral-500 hover:bg-neutral-100"}`}>
                {locked ? <Lock size={14} /> : <Unlock size={14} />}
              </button>
            </div>
          );
        })()}
      </div>
      {single?.node.locked && (() => {
        // The page background image is locked by design; instead of the bare
        // "unlock to edit" hint it gets its two supported actions: adjust
        // (pan/zoom within the page via the crop overlay) and detach.
        const st = useEditor.getState();
        if (!st.isBackgroundImage(single.node.id)) {
          return <p className="rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-700">{tr("editor.this_object_is_locked_unlock_it_to_edit")}</p>;
        }
        const id = single.node.id;
        return (
          <>
            <p className="rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-700">{tr("editor.page_background_adjust_it_or_detach_it_to_ed")}</p>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => st.setCropping(id)}
                className="rounded-lg bg-neutral-100 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-200"
              >
                {tr("editor.adjust_background")}
              </button>
              <button
                onClick={() => st.detachImageBackground(id)}
                className="rounded-lg bg-neutral-100 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-200"
              >
                {tr("editor.detach")}
              </button>
            </div>
          </>
        );
      })()}
      {brandLocked && (
        <p className="flex items-center gap-1.5 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-700">
          <Lock size={12} /> {tr("editor.locked_by_brand_template_only_brand_admins_c")}
        </p>
      )}
      {/* Collaborative lock. Only meaningful while connected to a
          live session; on the local/offline doc there are no peers to lock against. */}
      {connected && (
        lockedByOtherHolder ? (
          <p
            className="flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium text-white"
            style={{ background: lockedByOtherHolder.color }}
            title={`Locked by ${lockedByOtherHolder.name}`}
          >
            <Lock size={12} /> Locked by {lockedByOtherHolder.name}
          </p>
        ) : (
          <button
            onClick={() => (selfHoldsAll ? unlockSelection() : lockSelection())}
            className={`flex w-full items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs font-medium transition ${selfHoldsAll ? "border-brand-200 bg-brand-50 text-brand-ink hover:bg-brand-100" : "border-neutral-200 text-neutral-600 hover:bg-neutral-100"}`}
            title={selfHoldsAll ? tr("editor.release_your_collaborative_lock") : tr("editor.lock_so_only_you_can_edit_this")}
          >
            {selfHoldsAll ? <><Unlock size={13} /> {tr("editor.unlock_for_others")}</> : <><Lock size={13} /> {tr("editor.lock_for_me")}</>}
          </button>
        )
      )}
      {single && (
        <div style={{ order: ORDER.position }} className={`grid grid-cols-2 gap-2 ${locked ? "pointer-events-none opacity-50" : ""}`}>
          <Field key={`x${single.node.transform.x}`} label="X" value={single.node.transform.x} onCommit={(n) => commitGeo({ x: n })} />
          <Field key={`y${single.node.transform.y}`} label="Y" value={single.node.transform.y} onCommit={(n) => commitGeo({ y: n })} />
          <Field key={`w${single.node.size.width}`} label="W" value={single.node.size.width} onCommit={(n) => commitGeo({ w: n })} />
          <Field key={`h${single.node.size.height}`} label="H" value={single.node.size.height} onCommit={(n) => commitGeo({ h: n })} />
          <Field key={`r${single.node.transform.rotation}`} label="∠" value={single.node.transform.rotation} onCommit={(n) => commitGeo({ rotation: n })} />
        </div>
      )}
      {single && !locked && (() => {
        // Rotation origin: a 3x3 pivot picker. Default (none) = center; the gizmo
        // rotates about the chosen point. Clicking the center cell clears it.
        const id = single.node.id;
        const og = single.node.transform.origin;
        const cur = og ?? { x: 0.5, y: 0.5 };
        return (
          <div style={{ order: ORDER.position }} className="flex items-center gap-2">
            <span className="text-[11px] text-neutral-400">{tr("editor.rotate_around")}</span>
            <div className="grid grid-cols-3 gap-0.5 rounded-md border border-neutral-200 p-0.5">
              {[0, 0.5, 1].flatMap((y) => [0, 0.5, 1].map((x) => {
                const active = Math.abs(cur.x - x) < 0.01 && Math.abs(cur.y - y) < 0.01;
                return (
                  <button
                    key={`${x},${y}`}
                    onClick={() => useEditor.getState().setRotationOrigin(id, x === 0.5 && y === 0.5 ? undefined : { x, y })}
                    className={`h-3.5 w-3.5 rounded-sm transition ${active ? "bg-brand-500" : "bg-neutral-200 hover:bg-neutral-300"}`}
                    title={`Pivot ${x},${y}`}
                  />
                );
              }))}
            </div>
            {og && <button onClick={() => useEditor.getState().setRotationOrigin(id, undefined)} className="text-[11px] text-neutral-400 hover:text-neutral-700" title={tr("editor.reset_to_center")}>↺</button>}
          </div>
        );
      })()}
      {(() => {
        const st = useEditor.getState();
        const multi = selection.length > 1;
        const canDistribute = selection.length > 2;
        return (
          <Section title={tr("editor.arrange")} order={ORDER.arrange} defaultOpen={false}>
            {/* Align (to page for one object, to selection for many). */}
            <div className="flex gap-1">
              <IconBtn icon={AlignStartVertical} title={tr("editor.align_left")} onClick={() => st.alignSelection("left")} />
              <IconBtn icon={AlignCenterVertical} title={tr("editor.align_center")} onClick={() => st.alignSelection("hcenter")} />
              <IconBtn icon={AlignEndVertical} title={tr("editor.align_right")} onClick={() => st.alignSelection("right")} />
              <IconBtn icon={AlignStartHorizontal} title={tr("editor.align_top")} onClick={() => st.alignSelection("top")} />
              <IconBtn icon={AlignCenterHorizontal} title={tr("editor.align_middle")} onClick={() => st.alignSelection("vmiddle")} />
              <IconBtn icon={AlignEndHorizontal} title={tr("editor.align_bottom")} onClick={() => st.alignSelection("bottom")} />
            </div>
            {/* Distribute (needs 3+) + tidy. */}
            <div className="flex gap-1">
              <IconBtn icon={AlignHorizontalDistributeCenter} title={tr("editor.distribute_horizontally")} onClick={() => st.distributeSelection("h", "gap")} disabled={!canDistribute} />
              <IconBtn icon={AlignVerticalDistributeCenter} title={tr("editor.distribute_vertically")} onClick={() => st.distributeSelection("v", "gap")} disabled={!canDistribute} />
              <IconBtn icon={FlipHorizontal2} title={tr("editor.flip_horizontal")} onClick={() => st.flipSelection("h")} />
              <IconBtn icon={FlipVertical2} title={tr("editor.flip_vertical")} onClick={() => st.flipSelection("v")} />
              <IconBtn icon={Sparkles} title={tr("editor.tidy_up_spacing")} onClick={() => st.tidySelection()} disabled={!multi} />
            </div>
            {/* Z-order. */}
            <div className="flex gap-1">
              <IconBtn icon={BringToFront} title={tr("editor.bring_to_front")} onClick={() => st.orderSelection("front")} />
              <IconBtn icon={ArrowUp} title={tr("editor.bring_forward")} onClick={() => st.orderSelection("forward")} />
              <IconBtn icon={ArrowDown} title={tr("editor.send_backward")} onClick={() => st.orderSelection("backward")} />
              <IconBtn icon={SendToBack} title={tr("editor.send_to_back")} onClick={() => st.orderSelection("back")} />
            </div>
            {(multi || single?.node.type === "group") && (
              <div className="flex gap-2">
                {multi && (
                  <button onClick={() => st.group()} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-neutral-100 py-1.5 text-xs font-medium text-neutral-600 transition hover:bg-neutral-200">
                    <GroupIcon size={14} /> {tr("editor.group")}
                  </button>
                )}
                {single?.node.type === "group" && (
                  <button onClick={() => st.ungroupSelection()} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-neutral-100 py-1.5 text-xs font-medium text-neutral-600 transition hover:bg-neutral-200">
                    <Ungroup size={14} /> {tr("editor.ungroup")}
                  </button>
                )}
              </div>
            )}
          </Section>
        );
      })()}
      {(() => {
        // Fill works for a single fill-bearing node or any multi-selection that
        // contains one. Edits route to the single setter or the batched *Sel
        // setters so a multi-selection recolors in one undo step.
        const fillNodes = selNodes.filter((n) => hasFills(n));
        const rep = single && hasFills(single.node) ? single.node : fillNodes[0];
        if (!rep) return null;
        const st = useEditor.getState();
        const id = rep.id;
        const fill = firstFill(rep);
        const isGradient = fill?.type === "gradient";
        const baseHex = fill?.type === "solid" ? colorHex(fill.color)
          : isGradient ? colorHex((fill as GradientFill).stops[0].color) : "#3b82f6";
        const applySolid = (hex: string) => { rememberColor(hex); return single ? st.setFillColor(id, hex) : st.setFillColorSel(hex); };
        const applyFills = (fills: Fill[]) => (single ? st.setFills(id, fills) : st.setFillsSel(fills));
        return (
          <Section title={tr("editor.fill")} order={ORDER.fill} badge={!single ? fillNodes.length : undefined} dim={locked}>
            <div className="flex items-center justify-end">
              {!brandSwatches && (
                <div className="flex gap-1 rounded-lg bg-neutral-100 p-0.5">
                  <button onClick={() => applySolid(baseHex)} className={chipCls(!isGradient && fill?.type !== "image")}>{tr("editor.solid")}</button>
                  <button onClick={() => applyFills([makeGradient(baseHex)])} className={chipCls(!!isGradient)}>{tr("editor.gradient")}</button>
                </div>
              )}
            </div>
            {/* Image fill (single shape): clip an image to the shape outline. */}
            {single && single.node.type === "shape" && !brandSwatches && (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={async () => { const u = await promptText({ title: tr("editor.image_fill"), label: tr("editor.image_url"), placeholder: "https://…", confirmText: tr("editor.apply") }); if (u) st.setImageFill(id, u); }}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-medium transition ${fill?.type === "image" ? "bg-brand-50 text-brand-ink" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"}`}
                >
                  <ImagePlus size={14} /> {fill?.type === "image" ? tr("editor.replace_image") : tr("editor.image_fill")}
                </button>
                {fill?.type === "image" && (
                  <button onClick={() => st.setImageFill(id, "")} className="rounded-lg bg-neutral-100 px-2.5 py-1.5 text-xs text-neutral-500 hover:bg-neutral-200" title={tr("editor.remove_image_fill")}>{tr("editor.clear")}</button>
                )}
              </div>
            )}
            {/* Pattern fill (single shape): tile an image across the shape. */}
            {single && single.node.type === "shape" && !brandSwatches && (() => {
              const pat = fill?.type === "pattern" ? (fill as unknown as { scale: number; rotation?: number; repeat: string }) : null;
              return (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={async () => { const u = await promptText({ title: tr("editor.pattern_fill"), label: tr("editor.image_url"), placeholder: "https://…", confirmText: tr("editor.apply") }); if (u) st.setPatternFill(id, u); }}
                      className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-medium transition ${pat ? "bg-brand-50 text-brand-ink" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"}`}
                    >
                      <ImagePlus size={14} /> {pat ? tr("editor.replace_pattern") : tr("editor.pattern_fill")}
                    </button>
                    {pat && (
                      <button onClick={() => st.setPatternFill(id, "")} className="rounded-lg bg-neutral-100 px-2.5 py-1.5 text-xs text-neutral-500 hover:bg-neutral-200" title={tr("editor.remove_pattern_fill")}>{tr("editor.clear")}</button>
                    )}
                  </div>
                  {pat && (
                    <div className="flex items-center gap-2">
                      <span className="w-12 shrink-0 text-[11px] text-neutral-400">{tr("editor.scale_2")}</span>
                      <input type="range" min={10} max={300} value={Math.round((pat.scale ?? 1) * 100)} aria-label={tr("editor.scale_2")} onChange={(e) => st.setPatternParams(id, { scale: Number(e.target.value) / 100 })} className="flex-1 accent-brand-600" />
                    </div>
                  )}
                </div>
              );
            })()}
            {brandSwatches ? (
              // Locked to the brand palette (FR-4): swatches only, no freeform.
              <>
                <BrandLockHint />
                <div className="flex flex-wrap gap-1.5">
                  {brandSwatches.map((c) => (
                    <Swatch key={c} color={c} onClick={() => applySolid(c)} />
                  ))}
                </div>
              </>
            ) : isGradient ? (
              <GradientEditor g={fill as GradientFill} onChange={(patch) => applyFills([{ ...(fill as GradientFill), ...patch }])} />
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <ColorField
                    value={fill?.type === "solid" ? fill.color : colorFromHex(baseHex)}
                    onChange={(c) => { rememberColor(colorHex(c)); applyFills([{ type: "solid", color: c }]); }}
                    bg={pageBgOf(doc, activePage)}
                    palette={PALETTE}
                    recents={recentColorList()}
                    title={tr("editor.fill_color")}
                  />
                  <span className="font-mono text-xs uppercase text-neutral-400">{baseHex}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {PALETTE.map((c) => (
                    <Swatch key={c} color={c} onClick={() => applySolid(c)} />
                  ))}
                </div>
                <RecentColors onPick={applySolid} />
                <ColorHarmony baseHex={baseHex} onPick={(hex) => { rememberColor(hex); applySolid(hex); }} />
              </>
            )}
          </Section>
        );
      })()}
      {single && single.node.type === "shape" && (() => {
        const cur = (single.node as unknown as { shape: string }).shape;
        const id = single.node.id;
        return (
          <div style={{ order: ORDER.type }} className="flex flex-col gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-neutral-400">{tr("editor.swap_shape")}</span>
            <div className="grid grid-cols-5 gap-1.5">
              {([
                { k: "rect", label: "▭" },
                { k: "ellipse", label: "◯" },
                { k: "triangle", label: "△" },
                { k: "polygon", label: "⬡" },
                { k: "star", label: "★" },
              ] as const).map(({ k, label }) => (
                <button
                  key={k}
                  onClick={() => useEditor.getState().setShapeKind(id, k)}
                  className={`grid h-8 place-items-center rounded-lg border text-sm transition ${cur === k ? "border-brand-300 bg-brand-50 text-brand-ink" : "border-transparent bg-neutral-100 text-neutral-600 hover:bg-neutral-200"}`}
                  title={`Make ${k}`}
                >{label}</button>
              ))}
            </div>
          </div>
        );
      })()}
      {single && (single.node.type === "shape" || single.node.type === "path") && (
        <button
          style={{ order: ORDER.type }}
          onClick={() => useEditor.getState().convertToFrame(single.node.id)}
          title={tr("editor.turn_this_shape_into_a_frame_you_can_drop_an")}
          className="flex items-center justify-center gap-1.5 rounded-lg border border-neutral-200 px-2 py-2 text-xs font-medium text-neutral-700 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-ink"
        >
          {tr("editor.use_as_image_frame")}
        </button>
      )}
      {/* Vector ops (F26): outline a stroke into a filled shape; recognize a
          freehand path as a clean shape. */}
      {single && (single.node.type === "shape" || single.node.type === "path") && (single.node as unknown as { stroke?: unknown }).stroke ? (
        <button
          style={{ order: ORDER.type }}
          onClick={() => useEditor.getState().strokeToOutlineSelection()}
          title={tr("editor.convert_the_stroke_into_a_filled_outline_sha")}
          className="flex items-center justify-center gap-1.5 rounded-lg border border-neutral-200 px-2 py-2 text-xs font-medium text-neutral-700 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-ink"
        >
          {tr("editor.outline_stroke")}
        </button>
      ) : null}
      {single && single.node.type === "path" && (
        <button
          style={{ order: ORDER.type }}
          onClick={() => useEditor.getState().recognizeSelectedPath()}
          title={tr("editor.snap_this_freehand_path_to_a_clean_shape_rec")}
          className="flex items-center justify-center gap-1.5 rounded-lg border border-neutral-200 px-2 py-2 text-xs font-medium text-neutral-700 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-ink"
        >
          {tr("editor.recognize_shape")}
        </button>
      )}
      {single && single.node.type === "image" && (
        <Section title={tr("editor.image")} order={ORDER.type}>
          <ImagePalette assetId={(single.node as unknown as { source: { assetId: string } }).source.assetId} />
          {isLowResolution(single.node as ImageNode, doc) && (
            <div className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] font-medium text-amber-700" title={tr("editor.image_resolution_low_hint")}>
              Low resolution (~{Math.round(computeEffectivePpi(single.node as ImageNode, doc))} PPI). Use a larger image or scale this down.
            </div>
          )}
          <label className="flex items-center justify-between text-sm text-neutral-600">
            <span>{tr("editor.fit")}</span>
            <select
              value={(single.node as unknown as { fit?: ImageFit }).fit ?? "cover"}
              onChange={(e) => useEditor.getState().setImageFit(single.node.id, e.target.value as ImageFit)}
              className="w-32 rounded-lg border border-neutral-200 bg-surface px-2 py-1.5 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
            >
              <option value="cover">{tr("editor.cover")}</option>
              <option value="contain">{tr("editor.contain")}</option>
              <option value="stretch">{tr("editor.stretch")}</option>
              <option value="none">{tr("editor.none")}</option>
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => useEditor.getState().setCropping(single.node.id)}
              disabled={single.node.transform.rotation !== 0 || Math.abs(single.node.transform.scaleX) !== 1 || Math.abs(single.node.transform.scaleY) !== 1}
              title={single.node.transform.rotation !== 0 ? tr("editor.reset_rotation_scale_to_crop") : tr("editor.crop_image")}
              className="rounded-lg bg-neutral-100 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-200 disabled:opacity-40"
            >
              {tr("editor.crop")}
            </button>
            {(single.node as unknown as { crop?: unknown }).crop != null && (
              <button
                onClick={() => useEditor.getState().setImageCrop(single.node.id, undefined)}
                className="rounded-lg bg-neutral-100 py-1.5 text-xs font-medium text-neutral-500 transition hover:bg-neutral-200"
              >
                {tr("editor.reset_crop")}
              </button>
            )}
            <button
              onClick={async () => {
                const t = await promptText({ title: tr("editor.replace_image"), label: tr("editor.image_url"), placeholder: "https://…", confirmText: tr("editor.replace") });
                if (!t) return;
                if (/^https?:\/\//i.test(t)) useEditor.getState().setImageSource(single.node.id, t);
                else await alertText(tr("editor.please_enter_an_http_s_image_url"));
              }}
              className="rounded-lg bg-neutral-100 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-200"
            >
              {tr("editor.replace_url")}
            </button>
            <label
              title={tr("editor.replace_from_a_file_on_your_device")}
              className="cursor-pointer rounded-lg bg-neutral-100 py-1.5 text-center text-xs font-medium text-neutral-700 transition hover:bg-neutral-200"
            >
              {tr("editor.upload")}
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  const reader = new FileReader();
                  reader.onload = () => {
                    if (typeof reader.result === "string") useEditor.getState().setImageSource(single.node.id, reader.result);
                  };
                  reader.readAsDataURL(f);
                }}
              />
            </label>
          </div>
        </Section>
      )}
      {single && single.node.type === "image" && (
        <ImageEffectsSection id={single.node.id} node={single.node} workspaceId={workspaceId ?? null} />
      )}
      {single && single.node.type === "shape" && (single.node as unknown as { fills?: Fill[] }).fills?.[0]?.type === "image" && (() => {
        const id = single.node.id;
        const fill = (single.node as unknown as { fills: Fill[] }).fills[0] as Extract<Fill, { type: "image" }>;
        const t = single.node.transform;
        const croppable = t.rotation === 0 && Math.abs(t.scaleX) === 1 && Math.abs(t.scaleY) === 1;
        return (
          <Section title={tr("editor.image_fill")} order={ORDER.type}>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => useEditor.getState().setCropping(id)}
                disabled={!croppable}
                title={croppable ? tr("editor.pan_and_zoom_the_image_inside_the_shape") : tr("editor.reset_rotation_scale_to_adjust")}
                className="rounded-lg bg-neutral-100 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-200 disabled:opacity-40"
              >
                {tr("editor.adjust")}
              </button>
              {fill.crop != null && (
                <button
                  onClick={() => useEditor.getState().setImageCrop(id, undefined)}
                  className="rounded-lg bg-neutral-100 py-1.5 text-xs font-medium text-neutral-500 transition hover:bg-neutral-200"
                >
                  {tr("editor.reset_crop")}
                </button>
              )}
              <button
                onClick={() => useEditor.getState().setImageFill(id, "")}
                title={tr("editor.remove_the_image_and_return_to_a_solid_fill")}
                className="rounded-lg bg-neutral-100 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-200"
              >
                {tr("editor.remove_image")}
              </button>
            </div>
            <p className="text-[11px] text-neutral-400">{tr("editor.double_click_the_shape_to_adjust_the_image")}</p>
          </Section>
        );
      })()}
      {(() => {
        type StrokeT = { fill: Fill; width: number; align: "inside" | "center" | "outside"; cap: "butt" | "round" | "square"; join: "miter" | "round" | "bevel"; dash?: number[] };
        const SKIP = new Set(["text", "image", "group"]);
        // Stroke/style works for a single node or a multi-selection of strokeable nodes.
        const strokeNodes = selNodes.filter((n) => !SKIP.has(n.type));
        const rep = single && !SKIP.has(single.node.type) ? single.node : strokeNodes[0];
        if (!rep) return null;
        const id = rep.id;
        const node = rep as unknown as {
          type: string; shape?: string;
          stroke?: StrokeT;
          cornerRadius?: { topLeft: number };
          effects?: { kind: string }[];
        };
        const st = useEditor.getState();
        const stroke = node.stroke;
        const hasShadow = (node.effects ?? []).some((e) => e.kind === "shadow");
        const isRectish =
          (node.type === "shape" && (node.shape === "rect" || node.shape === undefined)) || node.type === "frame";
        const applyStroke = (s?: StrokeT) => (single ? st.setStroke(id, s as never) : st.setStrokeSel(s as never));
        const dashed = !!stroke?.dash?.length;
        return (
          <Section title={tr("editor.style")} order={ORDER.style} badge={!single ? strokeNodes.length : undefined} dim={locked}>
            <label className="flex items-center justify-between text-sm text-neutral-600">
              <span>{tr("editor.border")}</span>
              <Toggle
                checked={!!stroke}
                onChange={(on) => applyStroke(on ? { fill: solidFromHex(brandSwatches?.[0] ?? "#111827"), width: 2, align: "center", cap: "butt", join: "miter" } : undefined)}
              />
            </label>
            {stroke && (
              <>
                {brandSwatches ? (
                  <>
                    <BrandLockHint />
                    <div className="flex flex-wrap gap-1.5">
                      {brandSwatches.map((c) => (
                        <Swatch key={c} color={c} onClick={() => applyStroke({ ...stroke, fill: solidFromHex(c) })} />
                      ))}
                    </div>
                    <Field key={`sw${stroke.width}`} label="W" value={stroke.width} onCommit={(n) => applyStroke({ ...stroke, width: Math.max(0, n) })} />
                  </>
                ) : (
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      {stroke.fill.type === "gradient" ? (
                        <div className="h-8 w-10 shrink-0 rounded border border-neutral-300" style={{ background: gradientCss(stroke.fill) }} />
                      ) : (
                        <div className="w-10 shrink-0">
                          <ColorField
                            value={stroke.fill.type === "solid" ? stroke.fill.color : colorFromHex("#111827")}
                            onChange={(c) => applyStroke({ ...stroke, fill: { type: "solid", color: c } })}
                            palette={PALETTE}
                            recents={recentColorList()}
                            title={tr("editor.stroke_color")}
                          />
                        </div>
                      )}
                      <div className="flex-1"><Field key={`sw${stroke.width}`} label="W" value={stroke.width} onCommit={(n) => applyStroke({ ...stroke, width: Math.max(0, n) })} /></div>
                    </div>
                    <label className="flex items-center justify-between text-xs text-neutral-500">
                      <span>{tr("editor.gradient_border")}</span>
                      <Toggle
                        checked={stroke.fill.type === "gradient"}
                        onChange={(on) => {
                          if (on) {
                            const base = stroke.fill.type === "solid" ? colorHex(stroke.fill.color) : "#111827";
                            applyStroke({ ...stroke, fill: { type: "gradient", gradient: "linear", angle: 90, stops: [{ position: 0, color: colorFromHex(base) }, { position: 1, color: colorFromHex("#6366f1") }] } as Fill });
                          } else {
                            const back = stroke.fill.type === "gradient" && stroke.fill.stops[0] ? colorHex(stroke.fill.stops[0].color) : "#111827";
                            applyStroke({ ...stroke, fill: solidFromHex(back) });
                          }
                        }}
                      />
                    </label>
                    {stroke.fill.type === "gradient" && (
                      <GradientEditor g={stroke.fill} onChange={(patch) => applyStroke({ ...stroke, fill: { ...(stroke.fill as GradientFill), ...patch } })} />
                    )}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex flex-col gap-1 text-[11px] text-neutral-400">
                    {tr("editor.align")}
                    <select value={stroke.align} onChange={(e) => applyStroke({ ...stroke, align: e.target.value as StrokeT["align"] })} className={selectCls}>
                      <option value="inside">{tr("editor.inside")}</option>
                      <option value="center">{tr("editor.center")}</option>
                      <option value="outside">{tr("editor.outside")}</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-[11px] text-neutral-400">
                    {tr("editor.cap")}
                    <select aria-label={tr("editor.line_cap")} value={stroke.cap} onChange={(e) => applyStroke({ ...stroke, cap: e.target.value as StrokeT["cap"] })} className={selectCls}>
                      <option value="butt">{tr("editor.butt")}</option>
                      <option value="round">{tr("editor.round")}</option>
                      <option value="square">{tr("editor.square")}</option>
                    </select>
                  </label>
                </div>
                <label className="flex items-center justify-between text-sm text-neutral-600">
                  <span>{tr("editor.dashed")}</span>
                  <Toggle checked={dashed} onChange={(on) => applyStroke({ ...stroke, dash: on ? [stroke.width * 2, stroke.width * 2] : undefined })} />
                </label>
              </>
            )}
            {(() => {
              // Corner radius for one rect-ish node or a multi-selection of them.
              const rectNodes = selNodes.filter((n) => {
                const x = n as unknown as { type: string; shape?: string };
                return (x.type === "shape" && (x.shape === "rect" || x.shape === undefined)) || x.type === "frame";
              });
              const crRep = single && isRectish ? single.node : rectNodes[0];
              if (!crRep) return null;
              const cur = (crRep as unknown as { cornerRadius?: { topLeft: number } }).cornerRadius?.topLeft ?? 0;
              return (
                <Field key={`cr${cur}`} label={tr("editor.radius")} value={cur} onCommit={(n) => (single ? st.setCornerRadius(crRep.id, n) : st.setCornerRadiusSel(n))} />
              );
            })()}
            {/* Single node: full effects control (presets + shadow/outline/glow,
                engine-rendered for shapes/lines/frames). Multi-select keeps a
                simple shadow toggle since per-node params can't be shown at once. */}
            {single ? (
              <NodeEffects id={id} effects={node.effects} />
            ) : (
              <label className="flex items-center justify-between text-sm text-neutral-600">
                <span>{tr("editor.shadow")}</span>
                <Toggle checked={hasShadow} onChange={(on) => st.setShadowSel(on)} />
              </label>
            )}
          </Section>
        );
      })()}
      {single && single.node.type === "text" && (() => {
        const id = single.node.id;
        const cs = firstRunStyle(single.node);
        const ps = firstParaStyle(single.node);
        const setChar = (char: Partial<CharStyle>) => useEditor.getState().setTextStyle(id, char);
        const setPara = (para: Partial<ParagraphStyle>) => useEditor.getState().setTextStyle(id, undefined, para);
        const curWeight = cs?.axes?.wght ?? 400;
        const isItalic = /italic|oblique/i.test(cs?.fontStyle ?? "");
        const lineHeight = typeof cs?.lineHeight === "number" ? cs.lineHeight : 1.2;
        return (
          <Section title={tr("editor.text")} order={ORDER.type}>
            <textarea
              key={`txt-${id}`}
              defaultValue={textOf(single.node)}
              onBlur={(e) => useEditor.getState().setText(id, e.target.value)}
              rows={2}
              className="w-full resize-none rounded-lg border border-neutral-200 bg-surface px-2 py-1.5 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
            />
            {/* Quick styles: apply a heading/subheading/body preset to the selection. */}
            <div className="flex gap-1.5">
              {([
                { label: tr("editor.heading"), size: 48, wght: 800 },
                { label: tr("editor.subheading"), size: 28, wght: 600 },
                { label: tr("editor.body"), size: 16, wght: 400 },
              ] as const).map((p) => (
                <button
                  key={p.label}
                  onClick={() => setChar({ fontSize: p.size, axes: { ...(cs?.axes ?? {}), wght: p.wght } })}
                  className="flex-1 rounded-lg border border-transparent bg-neutral-100 px-2 py-1.5 text-xs font-medium text-neutral-600 transition hover:bg-neutral-200"
                  title={`Apply ${p.label} style`}
                >{p.label}</button>
              ))}
            </div>
            {/* Font family. Locked to the brand fonts for a non-admin member
                when the kit locks fonts (FR-4, AC-3). */}
            {brandFonts ? (
              <>
                <BrandLockHint />
                <select aria-label={tr("editor.font_family")}
                  value={brandFonts.includes(cs?.fontFamily ?? "") ? cs?.fontFamily : brandFonts[0]}
                  onChange={(e) => { fonts.ensure(e.target.value); setChar({ fontFamily: e.target.value }); }}
                  className={selectCls}
                >
                  {brandFonts.map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
              </>
            ) : (
              <select aria-label={tr("editor.font_family")}
                value={cs?.fontFamily ?? "system"}
                onChange={(e) => { fonts.ensure(e.target.value); setChar({ fontFamily: e.target.value }); }}
                className={selectCls}
              >
                <option value="system">{tr("editor.system_default")}</option>
                {FONT_FAMILY_OPTIONS}
              </select>
            )}
            <div className="grid grid-cols-2 gap-2">
              {/* Weight */}
              <select aria-label={tr("editor.font_weight")}
                value={curWeight}
                onChange={(e) => setChar({ axes: { ...(cs?.axes ?? {}), wght: Number(e.target.value) } })}
                className={selectCls}
              >
                {weights().map((w) => <option key={w.v} value={w.v}>{w.label}</option>)}
              </select>
              {/* Size */}
              <Field key={`fs${cs?.fontSize}`} label={tr("editor.aa")} value={cs?.fontSize ?? 16} onCommit={(n) => setChar({ fontSize: Math.max(1, n) })} />
            </div>
            {/* Width axis (variable fonts): mapped to a CSS font-stretch keyword the
                canvas applies to the wdth axis. Static fonts ignore it. */}
            <div className="flex items-center gap-2">
              <span className="w-12 shrink-0 text-[11px] text-neutral-400">{tr("editor.width")}</span>
              <input type="range" min={50} max={200} step={12.5} value={cs?.axes?.wdth ?? 100} onChange={(e) => setChar({ axes: { ...(cs?.axes ?? {}), wdth: Number(e.target.value) } })} className="flex-1 accent-brand-600" title={tr("editor.variable_font_width_condensed_to_expanded")} aria-label={tr("editor.variable_font_width_condensed_to_expanded")} />
              {(cs?.axes?.wdth ?? 100) !== 100 && <button onClick={() => setChar({ axes: { ...(cs?.axes ?? {}), wdth: 100 } })} className="text-[11px] text-neutral-400 hover:text-neutral-700" title={tr("editor.reset_width")}>↺</button>}
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {/* Italic */}
              <button
                onClick={() => setChar({ fontStyle: isItalic ? regularFontStyle : italicFontStyle })}
                className={`grid h-8 w-9 place-items-center rounded-lg border text-sm italic transition ${isItalic ? "border-brand-300 bg-brand-50 text-brand-ink" : "border-transparent bg-neutral-100 text-neutral-600 hover:bg-neutral-200"}`}
                title={tr("editor.italic")}
              >I</button>
              {/* Underline / strikethrough (per-run decoration). */}
              {([
                { d: "underline", label: "U", deco: "underline" },
                { d: "strikethrough", label: "S", deco: "line-through" },
              ] as const).map(({ d, label, deco }) => {
                const on = (cs?.decoration ?? []).includes(d);
                return (
                  <button
                    key={d}
                    onClick={() => {
                      const cur = (cs?.decoration ?? []) as ("underline" | "strikethrough")[];
                      setChar({ decoration: on ? cur.filter((x) => x !== d) : [...cur, d] });
                    }}
                    style={{ textDecoration: deco }}
                    className={`grid h-8 w-9 place-items-center rounded-lg border text-sm transition ${on ? "border-brand-300 bg-brand-50 text-brand-ink" : "border-transparent bg-neutral-100 text-neutral-600 hover:bg-neutral-200"}`}
                    title={d === "underline" ? tr("editor.underline") : tr("editor.strikethrough")}
                  >{label}</button>
                );
              })}
              {/* Alignment */}
              {([
                { a: "left", I: AlignLeft },
                { a: "center", I: AlignCenter },
                { a: "right", I: AlignRight },
                { a: "justify", I: AlignJustify },
              ] as const).map(({ a, I }) => (
                <button
                  key={a}
                  onClick={() => setPara({ align: a })}
                  className={`grid h-8 w-9 place-items-center rounded-lg border transition ${ps?.align === a ? "border-brand-300 bg-brand-50 text-brand-ink" : "border-transparent bg-neutral-100 text-neutral-600 hover:bg-neutral-200"}`}
                  title={`Align ${a}`}
                ><I size={15} /></button>
              ))}
              {/* Direction: RTL toggle. Right-aligns by default when enabled; the
                  editor types/caret RTL. Mixed-bidi reordering on canvas is limited. */}
              <button
                onClick={() => { const rtl = ps?.direction === "rtl"; setPara({ direction: rtl ? "ltr" : "rtl", align: rtl ? "left" : "right" }); }}
                className={`grid h-8 w-9 place-items-center rounded-lg border text-xs font-semibold transition ${ps?.direction === "rtl" ? "border-brand-300 bg-brand-50 text-brand-ink" : "border-transparent bg-neutral-100 text-neutral-600 hover:bg-neutral-200"}`}
                title={tr("editor.right_to_left")}
              >RTL</button>
              {/* Color: freeform unless the brand locks colors for this member. */}
              {!brandSwatches && (
                <div className="ms-auto w-10">
                  <ColorField
                    value={cs?.fill?.type === "solid" ? cs.fill.color : colorFromHex(cs ? runColorHex(cs) : "#111827")}
                    onChange={(c) => { rememberColor(colorHex(c)); setChar({ fill: { type: "solid", color: c } }); }}
                    bg={pageBgOf(doc, activePage)}
                    palette={PALETTE}
                    recents={recentColorList()}
                    title={tr("editor.text_color")}
                  />
                </div>
              )}
            </div>
            {!brandSwatches && <RecentColors onPick={(hex) => { rememberColor(hex); setChar({ fill: solidFromHex(hex) }); }} />}
            {/* Gradient text fill (engine renders the gradient across the text box). */}
            {!brandSwatches && (() => {
              const f = cs?.fill;
              const isGrad = f?.type === "gradient";
              return (
                <div className="flex flex-col gap-1.5">
                  <label className="flex items-center justify-between text-xs text-neutral-500">
                    <span>{tr("editor.gradient_text")}</span>
                    <Toggle
                      checked={!!isGrad}
                      onChange={(on) => {
                        if (on) {
                          const base = f?.type === "solid" ? colorHex(f.color) : "#6366f1";
                          setChar({ fill: { type: "gradient", gradient: "linear", angle: 90, stops: [{ position: 0, color: colorFromHex(base) }, { position: 1, color: colorFromHex("#ec4899") }] } as Fill });
                        } else {
                          const back = isGrad && (f as GradientFill).stops[0] ? colorHex((f as GradientFill).stops[0].color) : "#111827";
                          setChar({ fill: solidFromHex(back) });
                        }
                      }}
                    />
                  </label>
                  {isGrad && <GradientEditor g={f as GradientFill} onChange={(patch) => setChar({ fill: { ...(f as GradientFill), ...patch } })} />}
                </div>
              );
            })()}
            {brandSwatches && (
              <>
                <BrandLockHint />
                <div className="flex flex-wrap gap-1.5">
                  {brandSwatches.map((c) => (
                    <Swatch key={c} color={c} title={tr("editor.text_color")} onClick={() => setChar({ fill: solidFromHex(c) })} />
                  ))}
                </div>
              </>
            )}
            <div className="grid grid-cols-2 gap-2">
              <Field key={`lh${lineHeight}`} label={tr("editor.line")} value={lineHeight} onCommit={(n) => setChar({ lineHeight: Math.max(0.5, n) })} />
              <Field key={`ls${cs?.letterSpacing ?? 0}`} label={tr("editor.letter")} value={cs?.letterSpacing ?? 0} onCommit={(n) => setChar({ letterSpacing: n })} />
            </div>
            {/* Underline / strikethrough (applies to the selection when the
                inline editor is open, else the whole box). */}
            <div className="flex items-center gap-1">
              {([["underline", "U", "underline"], ["strikethrough", "S", "line-through"]] as const).map(([deco, label, cls]) => {
                const active = cs?.decoration?.includes(deco) ?? false;
                return (
                  <button
                    key={deco}
                    onClick={() => {
                      const rest = (cs?.decoration ?? []).filter((x) => x !== deco);
                      setChar({ decoration: active ? (rest.length ? rest : undefined) : [...rest, deco] });
                    }}
                    className={`h-8 min-w-[32px] rounded-lg border px-2 text-sm ${cls === "underline" ? "underline" : "line-through"} transition ${active ? "border-brand-300 bg-brand-50 text-brand-ink" : "border-transparent bg-neutral-100 text-neutral-600 hover:bg-neutral-200"}`}
                    title={deco === "underline" ? tr("editor.underline_cmd_ctrl_u") : tr("editor.strikethrough_cmd_ctrl_shift_x")}
                  >{label}</button>
                );
              })}
            </div>
            {/* Paragraph spacing and indents (engine lays these out per paragraph). */}
            <div className="grid grid-cols-2 gap-2">
              <Field key={`sb${ps?.spaceBefore ?? 0}`} label={tr("editor.before")} value={ps?.spaceBefore ?? 0} onCommit={(n) => setPara({ spaceBefore: Math.max(0, n) || undefined })} />
              <Field key={`sa${ps?.spaceAfter ?? 0}`} label={tr("editor.after")} value={ps?.spaceAfter ?? 0} onCommit={(n) => setPara({ spaceAfter: Math.max(0, n) || undefined })} />
              <Field key={`in${ps?.indentStart ?? 0}`} label={tr("editor.indent")} value={ps?.indentStart ?? 0} onCommit={(n) => setPara({ indentStart: Math.max(0, n) || undefined })} />
              <Field key={`fi${ps?.firstLineIndent ?? 0}`} label={tr("editor.1st_line")} value={ps?.firstLineIndent ?? 0} onCommit={(n) => setPara({ firstLineIndent: n || undefined })} />
            </div>
            <select aria-label={tr("editor.indent")}
              value={cs?.case ?? "none"}
              onChange={(e) => setChar({ case: e.target.value as CharStyle["case"] })}
              className={selectCls}
            >
              <option value="none">{tr("editor.case_as_typed")}</option>
              <option value="upper">UPPERCASE</option>
              <option value="lower">{tr("editor.lowercase")}</option>
              <option value="title">{tr("editor.title_case")}</option>
              <option value="smallcaps">{tr("editor.small_caps")}</option>
            </select>
            {/* Ligatures: OpenType ligatures on/off (canvas applies default vs none). */}
            <label className="flex items-center justify-between text-sm text-neutral-600">
              <span>{tr("editor.ligatures")}</span>
              <Toggle
                checked={(cs?.features?.liga ?? 1) !== 0}
                onChange={(on) => setChar({ features: { ...(cs?.features ?? {}), liga: on ? 1 : 0 } })}
              />
            </label>
            {/* Per-run hyperlink: applies to the selected text range (clickable in
                present/preview; the first linked run also makes the node clickable). */}
            <label className="flex flex-col gap-1 text-[11px] text-neutral-400">
              {tr("editor.link")}
              <input
                key={`lnk-${id}-${cs?.link ?? ""}`}
                defaultValue={cs?.link ?? ""}
                onBlur={(e) => { const v = e.target.value.trim(); setChar({ link: v || undefined }); }}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                placeholder="https://… (select text first)"
                className={inputCls}
              />
            </label>
            {/* Language tag (BCP-47): drives locale-aware browser spellcheck. */}
            <label className="flex flex-col gap-1 text-[11px] text-neutral-400">
              {tr("editor.language_2")}
              <input
                key={`lang-${id}`}
                defaultValue={((single.node as unknown as { data?: { lang?: string } }).data?.lang) ?? ""}
                onBlur={(e) => useEditor.getState().setTextLang(id, e.target.value)}
                placeholder={tr("editor.e_g_en_es_fr_ca")}
                className={inputCls}
              />
            </label>
            {/* Lists */}
            <div className="flex flex-wrap items-center gap-1">
              <span className="me-1 text-xs text-neutral-400">{tr("editor.list")}</span>
              {([
                { key: undefined, label: tr("editor.none") },
                { key: "bullet", label: "•" },
                { key: "number", label: "1." },
                { key: "checklist", label: "☐" },
              ] as const).map((opt) => {
                const active = (ps?.list?.type ?? undefined) === opt.key;
                return (
                  <button
                    key={opt.label}
                    onClick={() => setPara({ list: opt.key ? { type: opt.key, level: ps?.list?.level ?? 0 } : undefined })}
                    className={`h-8 min-w-[32px] rounded-lg border px-1.5 text-xs transition ${active ? "border-brand-300 bg-brand-50 text-brand-ink" : "border-transparent bg-neutral-100 text-neutral-600 hover:bg-neutral-200"}`}
                    title={opt.key ? `${opt.key} list` : tr("editor.no_list")}
                  >{opt.label}</button>
                );
              })}
              {/* Indent / outdent the current list (renders as level-based indent). */}
              {ps?.list && (
                <>
                  <button
                    onClick={() => setPara({ list: { type: ps.list!.type, level: Math.max(0, (ps.list!.level ?? 0) - 1) } })}
                    disabled={(ps.list.level ?? 0) <= 0}
                    className="h-8 min-w-[32px] rounded-lg border border-transparent bg-neutral-100 px-1.5 text-sm text-neutral-600 transition hover:bg-neutral-200 disabled:opacity-40"
                    title={tr("editor.outdent")}
                  >⇤</button>
                  <button
                    onClick={() => setPara({ list: { type: ps.list!.type, level: Math.min(5, (ps.list!.level ?? 0) + 1) } })}
                    disabled={(ps.list.level ?? 0) >= 5}
                    className="h-8 min-w-[32px] rounded-lg border border-transparent bg-neutral-100 px-1.5 text-sm text-neutral-600 transition hover:bg-neutral-200 disabled:opacity-40"
                    title={tr("editor.indent")}
                  >⇥</button>
                </>
              )}
            </div>
            {/* Bullet marker style: pick a custom glyph for an unordered list. */}
            {ps?.list && ps.list.type === "bullet" && (
              <div className="flex flex-wrap items-center gap-1">
                <span className="me-1 text-xs text-neutral-400">{tr("editor.bullet")}</span>
                {["•", "◦", "▪", "–", "➤", "✓"].map((m) => {
                  const on = (ps.list!.marker ?? "•") === m;
                  return (
                    <button
                      key={m}
                      onClick={() => setPara({ list: { type: "bullet", level: ps.list!.level ?? 0, marker: m } })}
                      className={`h-8 min-w-[32px] rounded-lg border px-1.5 text-sm transition ${on ? "border-brand-300 bg-brand-50 text-brand-ink" : "border-transparent bg-neutral-100 text-neutral-600 hover:bg-neutral-200"}`}
                      title={`Bullet ${m}`}
                    >{m}</button>
                  );
                })}
              </div>
            )}
            {/* Paragraph spacing */}
            <div className="grid grid-cols-2 gap-2">
              <Field key={`sb${ps?.spaceBefore ?? 0}`} label="⤒" value={ps?.spaceBefore ?? 0} onCommit={(n) => setPara({ spaceBefore: Math.max(0, n) })} />
              <Field key={`sa${ps?.spaceAfter ?? 0}`} label="⤓" value={ps?.spaceAfter ?? 0} onCommit={(n) => setPara({ spaceAfter: Math.max(0, n) })} />
            </div>
              {/* Text uses the named text-effect system below (glyph-aware),
                  not the generic node.effects control that shapes
                and images use, so it is intentionally omitted here to avoid a
                duplicate, unreliable "Effects" section on text. */}
            {/* Text background highlight a padded rounded rect behind the text. */}
            {(() => {
              const tn = single.node as unknown as { textEffects?: { kind: string; color?: { type: string; color?: Color }; radius?: number; padding?: number }[] };
              const hl = (tn.textEffects ?? []).find((e) => e.kind === "highlight");
              const hlColor = hl?.color?.color;
              const radius = hl?.radius ?? 8;
              const setBg = (color: Color | null) => useEditor.getState().setTextBackground(id, color, hl?.padding ?? 8, radius);
              return (
                <div className="flex flex-col gap-2">
                  <label className="flex items-center justify-between text-sm text-neutral-600">
                    <span>{tr("editor.background")}</span>
                    <Toggle checked={!!hl} onChange={(on) => setBg(on ? (colorFromHex("#fde047")) : null)} />
                  </label>
                  {hl && (
                    <>
                      <div className="flex items-center gap-2">
                        <span className="w-12 shrink-0 text-[11px] text-neutral-400">{tr("editor.color")}</span>
                        <input type="color" value={hlColor ? colorHex(hlColor) : "#fde047"} onChange={(e) => setBg(colorFromHex(e.target.value))} className="oc-color h-8 w-9 shrink-0" aria-label={tr("editor.background_color")} title={tr("editor.background_color")} />
                      </div>
                      <TextHighlightLevels id={id} hl={hl} />
                    </>
                  )}
                </div>
              );
            })()}
            {/* Named text effects, engine-rendered. Mutually exclusive. */}
            {(() => {
              const tn = single.node as unknown as { textEffects?: { kind: string }[]; box?: { verticalAlign?: "top" | "middle" | "bottom" }; flow?: { kind: string; curvature?: number } };
              const fx = (single.node as unknown as { textEffects?: TextEffect[] }).textEffects?.find((e) => e.kind !== "highlight");
              const active = fx?.kind ?? "none";
              const set = (effect: TextEffect | null) => useEditor.getState().setTextEffect(id, effect);
              const black = solidFromHex("#000000");
              const PRESETS: { key: string; label: string; make: () => TextEffect | null }[] = [
                { key: "none", label: tr("editor.none"), make: () => null },
                { key: "shadow", label: tr("editor.shadow"), make: () => ({ kind: "shadow", dx: 4, dy: 4, blur: 6, color: black, opacity: 0.4 }) },
                { key: "lift", label: tr("editor.lift"), make: () => ({ kind: "lift", intensity: 0.5 }) },
                { key: "hollow", label: tr("editor.hollow"), make: () => ({ kind: "hollow", thickness: 2 }) },
                { key: "splice", label: tr("editor.splice"), make: () => ({ kind: "splice", thickness: 2, offset: 4, color: black }) },
                { key: "echo", label: tr("editor.echo"), make: () => ({ kind: "echo", offset: 6, count: 3, color: solidFromHex("#9ca3af") }) },
                { key: "glow", label: tr("editor.glow"), make: () => ({ kind: "glow", radius: 12, color: solidFromHex("#22d3ee"), intensity: 1 }) },
                { key: "neon", label: tr("editor.neon"), make: () => ({ kind: "neon", color: solidFromHex("#22d3ee"), intensity: 1 }) },
                { key: "outline", label: tr("editor.outline"), make: () => ({ kind: "outline", width: 2, color: black, join: "round" }) },
              ];
              const curve = tn.flow?.kind === "arc" ? Math.round(((tn.flow.curvature ?? 0) / 2.5) * 100) : 0;
              const vAlign = tn.box?.verticalAlign ?? "top";
              const script = cs?.script ?? "normal";
              const ebtn = (a: boolean) => `rounded-lg border px-1.5 py-1.5 text-[11px] font-medium transition ${a ? "border-brand-300 bg-brand-50 text-brand-ink" : "border-transparent bg-neutral-100 text-neutral-600 hover:bg-neutral-200"}`;
              return (
                <div className="flex flex-col gap-2">
                  {/* "Text effects", not "Effects". A text node renders BOTH
                      this section and the generic NodeEffects one below, and
                      they were headed identically while driving two different
                      arrays: `TextNode.textEffects` here (glyph treatments,
                      drawn per run) and `NodeBase.effects` there (applied to
                      the whole box). Two identical headings offering Shadow and
                      Glow, writing to different fields and rendering through
                      different code paths, is not a distinction anyone can be
                      expected to infer. The two stacks are stored apart on
                      purpose and must stay that way, so the surfaces have to
                      say which is which. */}
                  <span className="text-[10px] uppercase tracking-wide text-neutral-400">{tr("editor.text_effects")}</span>
                  <div className="grid grid-cols-3 gap-1.5">
                    {PRESETS.map((p) => (
                      <button key={p.key} onClick={() => set(p.make())} className={ebtn(active === p.key)} title={p.label}>{p.label}</button>
                    ))}
                  </div>
                  {/* Per-effect levels: every preset is tunable, not take-it-or-leave-it. */}
                  {fx && <TextEffectControls id={id} fx={fx} />}
                  {/* Curve */}
                  <div className="flex items-center gap-2">
                    <span className="w-12 shrink-0 text-[11px] text-neutral-400">{tr("editor.curve")}</span>
                    <input type="range" min={-100} max={100} value={curve} aria-label={tr("editor.curve")} onChange={(e) => useEditor.getState().setCurve(id, (Number(e.target.value) / 100) * 2.5)} className="flex-1 accent-brand-600" />
                    {curve !== 0 && <button onClick={() => useEditor.getState().setCurve(id, 0)} className="text-[11px] text-neutral-400 hover:text-neutral-700" title={tr("editor.straighten")}>↺</button>}
                  </div>
                  {/* Box sizing mode: fixed / grow height / grow width. */}
                  {(() => {
                    const mode = (single.node as unknown as { box?: { mode?: "fixed" | "autoHeight" | "autoWidth" } }).box?.mode ?? "fixed";
                    return (
                      <div className="flex items-center gap-1.5">
                        <span className="w-12 shrink-0 text-[11px] text-neutral-400">{tr("editor.box")}</span>
                        {([
                          { m: "fixed", label: tr("editor.fixed_3") },
                          { m: "autoHeight", label: tr("editor.auto_h") },
                          { m: "autoWidth", label: tr("editor.auto_w") },
                        ] as const).map(({ m, label }) => (
                          <button key={m} onClick={() => useEditor.getState().setTextBoxMode(id, m)} className={`flex-1 ${ebtn(mode === m)}`} title={m === "fixed" ? tr("editor.fixed_size_box") : m === "autoHeight" ? tr("editor.grow_height_to_fit_text") : tr("editor.grow_width_to_fit_text")}>{label}</button>
                        ))}
                      </div>
                    );
                  })()}
                  {/* Shrink-to-fit: a fixed box scales its text down instead of
                      overflowing when the content outgrows the box. */}
                  {(() => {
                    const box = (single.node as unknown as { box?: { mode?: string; autoFit?: { enabled: boolean } } }).box;
                    if ((box?.mode ?? "fixed") !== "fixed") return null;
                    return (
                      <label className="flex items-center justify-between text-sm text-neutral-600">
                        <span title={tr("editor.scale_text_down_so_it_never_overflows_the_bo")}>{tr("editor.shrink_to_fit")}</span>
                        <Toggle
                          checked={box?.autoFit?.enabled ?? false}
                          onChange={(on) => useEditor.getState().setTextAutoFit(id, on)}
                        />
                      </label>
                    );
                  })()}
                  {/* Columns: flow the text into N columns (engine multi-column). */}
                  {(() => {
                    const cols = (single.node as unknown as { box?: { columns?: { count: number } } }).box?.columns?.count ?? 1;
                    return (
                      <div className="flex items-center gap-1.5">
                        <span className="w-12 shrink-0 text-[11px] text-neutral-400">{tr("editor.columns")}</span>
                        {[1, 2, 3].map((n) => (
                          <button key={n} onClick={() => useEditor.getState().setTextColumns(id, n)} className={`flex-1 ${ebtn(cols === n)}`} title={`${n} column${n > 1 ? "s" : ""}`}>{n}</button>
                        ))}
                      </div>
                    );
                  })()}
                  {/* Vertical align + sub/superscript */}
                  <div className="flex items-center gap-1.5">
                    <span className="w-12 shrink-0 text-[11px] text-neutral-400">{tr("editor.align")}</span>
                    {(["top", "middle", "bottom"] as const).map((v) => (
                      <button key={v} onClick={() => useEditor.getState().setVerticalAlign(id, v)} className={`flex-1 ${ebtn(vAlign === v)}`} title={`Vertical: ${v}`}>{v[0].toUpperCase()}</button>
                    ))}
                    <span className="mx-0.5 h-5 w-px bg-neutral-200" />
                    <button onClick={() => setChar({ script: script === "super" ? "normal" : "super" })} className={ebtn(script === "super")} title={tr("editor.superscript")}>x²</button>
                    <button onClick={() => setChar({ script: script === "sub" ? "normal" : "sub" })} className={ebtn(script === "sub")} title={tr("editor.subscript")}>x₂</button>
                  </div>
                </div>
              );
            })()}
          </Section>
        );
      })()}
      {single && single.node.type === "video" && <VideoSection node={single.node} />}
      {single && single.node.type === "grid" && (() => {
        const id = single.node.id;
        const g = single.node as unknown as { rows: number; cols: number; gap: number };
        const set = (patch: { rows?: number; cols?: number; gap?: number }) => useEditor.getState().setGridLayout(id, patch);
        return (
          <Section title={tr("editor.photo_grid")} order={ORDER.type}>
            <div className="grid grid-cols-3 gap-2">
              <Field key={`gr-${g.rows}`} label={tr("editor.rows")} value={g.rows} onCommit={(n) => set({ rows: Math.max(1, Math.min(6, Math.round(n))) })} />
              <Field key={`gc-${g.cols}`} label={tr("editor.cols")} value={g.cols} onCommit={(n) => set({ cols: Math.max(1, Math.min(6, Math.round(n))) })} />
              <Field key={`gg-${g.gap}`} label={tr("editor.gap")} value={g.gap} onCommit={(n) => set({ gap: Math.max(0, n) })} />
            </div>
            <p className="text-[11px] text-neutral-400">{tr("editor.drag_a_photo_onto_a_cell_to_fill_it")}</p>
          </Section>
        );
      })()}
      {single && single.node.type === "qr" && (() => {
        const id = single.node.id;
        const qr = single.node as unknown as { value: string; logoAssetId?: string; logoScale?: number };
        return (
          <Section title={tr("editor.qr_code")} order={ORDER.type}>
            <label className="flex flex-col gap-1 text-[11px] text-neutral-400">
              {tr("editor.links_to")}
              <input
                key={`qr-${id}`}
                defaultValue={qr.value}
                onBlur={(e) => useEditor.getState().setQrValue(id, e.target.value.trim())}
                placeholder="https://…"
                className={inputCls}
              />
            </label>
            <p className="text-[11px] text-neutral-400">{tr("editor.the_code_regenerates_when_you_change_the_val")}</p>
            <QrLogoControl id={id} logoAssetId={qr.logoAssetId} logoScale={qr.logoScale} workspaceId={workspaceId ?? null} />
          </Section>
        );
      })()}
      {single && single.node.type === "frame" && (() => {
        const id = single.node.id;
        const st = useEditor.getState();
        const fr = single.node as unknown as { maskShape?: string; cornerRadius?: { topLeft: number } };
        const isEllipse = fr.maskShape === "ellipse";
        const isRounded = !isEllipse && (fr.cornerRadius?.topLeft ?? 0) > 0;
        const chip = (active: boolean) => `flex-1 rounded-lg border py-1.5 text-xs font-medium transition ${active ? "border-brand-300 bg-brand-50 text-brand-ink" : "border-transparent bg-neutral-100 text-neutral-600 hover:bg-neutral-200"}`;
        return (
          <Section title={tr("editor.frame")} order={ORDER.type}>
            <div className="flex gap-1">
              <button onClick={() => st.setFrameShape(id, "rect", 0)} className={chip(!isEllipse && !isRounded)}>{tr("editor.rectangle")}</button>
              <button onClick={() => st.setFrameShape(id, "rect", 28)} className={chip(isRounded)}>{tr("editor.rounded")}</button>
              <button onClick={() => st.setFrameShape(id, "ellipse", 0)} className={chip(isEllipse)}>{tr("editor.circle")}</button>
            </div>
            <p className="text-[11px] text-neutral-400">{tr("editor.click_an_image_in_uploads_to_drop_it_into_th")}</p>
          </Section>
        );
      })()}
      {single && single.node.type === "chart" && (() => {
        const id = single.node.id;
        const st = useEditor.getState();
        const ch = single.node as unknown as ChartNode;
        const style: ChartStyle = ch.style ?? {};
        const TYPES: ChartNode["chartType"][] = ["bar", "barGrouped", "barStacked", "line", "area", "pie", "donut", "scatter", "radar"];
        const LABELS: Record<string, string> = { bar: tr("editor.bar_2"), barGrouped: tr("editor.bar_grouped"), barStacked: tr("editor.bar_stacked"), line: tr("editor.line"), area: tr("editor.area"), pie: tr("editor.pie"), donut: tr("editor.donut"), scatter: tr("editor.scatter"), radar: tr("editor.radar") };
        const legend = style.legend ?? { show: false, position: "bottom" as const };
        return (
          <Section title={tr("editor.chart")} order={ORDER.type}>
            <select aria-label={tr("editor.chart_type")} value={ch.chartType} onChange={(e) => st.setChart(id, { chartType: e.target.value as never })} className={selectCls}>
              {TYPES.map((tp) => <option key={tp} value={tp}>{LABELS[tp] ?? tp}</option>)}
            </select>
            <label className="flex flex-col gap-1 text-[11px] text-neutral-400">{tr("editor.title")}
              <input key={`title-${id}`} defaultValue={style.title ?? ""} placeholder={tr("editor.chart_title")} onBlur={(e) => st.setChart(id, { style: { ...style, title: e.target.value.trim() || undefined } })} className={inputCls} />
            </label>
            <ChartDataTable node={ch} />
            <DataBindingControls node={single.node} />
            <div className="flex items-center justify-between text-[11px] text-neutral-500">
              <span>{tr("editor.legend")}</span>
              <Toggle checked={legend.show} ariaLabel={tr("editor.legend")} onChange={(v) => st.setChart(id, { style: { ...style, legend: { ...legend, show: v } } })} />
            </div>
            {legend.show && (
              <select aria-label={tr("editor.legend_position")} value={legend.position} onChange={(e) => st.setChart(id, { style: { ...style, legend: { show: true, position: e.target.value as never } } })} className={selectCls}>
                {["top", "right", "bottom", "left"].map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            )}
            <div className="flex items-center justify-between text-[11px] text-neutral-500">
              <span>{tr("editor.show_values")}</span>
              <Toggle checked={style.valueLabels === true} ariaLabel={tr("editor.show_values")} onChange={(v) => st.setChart(id, { style: { ...style, valueLabels: v } })} />
            </div>
            {/* Base size for all chart text; title, legend, axis and value
                labels scale proportionally from it (11 is the built-in base). */}
            <Field
              key={`cfs-${id}-${style.fontSize ?? 11}`}
              label={tr("editor.text_size")}
              value={style.fontSize ?? 11}
              onCommit={(n) => st.setChart(id, { style: { ...style, fontSize: Math.max(6, Math.min(44, Math.round(n))) } })}
            />
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] text-neutral-400">{tr("editor.series_colors")}</span>
              {(ch.series ?? []).map((s, i) => (
                <div key={`scol-${id}-${i}`} className="flex items-center gap-2">
                  <input type="color" value={s.color ? colorHex(s.color) : "#6366f1"} aria-label={tr("editor.series_n_color", { n: i + 1 })} onChange={(e) => st.setChartSeriesColor(id, i, colorFromHex(e.target.value))} className="oc-color h-7 w-8 shrink-0" />
                  <span className="truncate text-xs text-neutral-600">{s.name || `Series ${i + 1}`}</span>
                </div>
              ))}
            </div>
          </Section>
        );
      })()}
      {single && single.node.type === "table" && (() => {
        const id = single.node.id;
        const st = useEditor.getState();
        const tb = single.node as unknown as TableNode;
        const grid: string[][] = Array.from({ length: tb.rows }, () => Array(tb.cols).fill(""));
        for (const cell of tb.cells) if (grid[cell.row]) grid[cell.row][cell.col] = cell.content?.[0]?.text ?? "";
        const header = tb.headerStyle ?? { enabled: false };
        const border = tb.borderStyle ?? { show: true };
        const sel = tableCell;
        const selCell = tb.cells.find((c) => c.row === sel.row && c.col === sel.col);
        const btnCls = "flex-1 rounded-md border border-neutral-200 bg-surface px-2 py-1 text-[11px] text-neutral-700 transition hover:bg-neutral-50 disabled:opacity-40";
        return (
          <Section title={tr("editor.table_data")} order={ORDER.type}>
            <p className="text-[11px] text-neutral-400">{tr("editor.one_row_per_line_cells_comma_separated")}</p>
            <textarea
              key={`tb-${id}-${tb.rows}x${tb.cols}`}
              defaultValue={grid.map((r) => r.join(", ")).join("\n")}
              rows={4}
              onBlur={(e) => st.setTableData(id, e.target.value.split("\n").map((line) => line.split(",").map((s) => s.trim())))}
              className={`${inputCls} resize-none`}
            />
            <span className="text-[11px] text-neutral-400">{tr("editor.rows")}</span>
            <div className="flex gap-1.5">
              <button type="button" className={btnCls} onClick={() => st.addTableRow(id)}>+ Row</button>
              <button type="button" className={btnCls} disabled={tb.rows <= 1} onClick={() => st.removeTableRow(id, tb.rows - 1)}>{tr("editor.row_2")}</button>
            </div>
            <span className="text-[11px] text-neutral-400">{tr("editor.columns")}</span>
            <div className="flex gap-1.5">
              <button type="button" className={btnCls} onClick={() => st.addTableColumn(id)}>+ Column</button>
              <button type="button" className={btnCls} disabled={tb.cols <= 1} onClick={() => st.removeTableColumn(id, tb.cols - 1)}>{tr("editor.column_2")}</button>
            </div>

            <Heading>{tr("editor.header_row")}</Heading>
            <div className="flex items-center justify-between text-[11px] text-neutral-500">
              <span>{tr("editor.styled_header")}</span>
              <Toggle checked={header.enabled} ariaLabel={tr("editor.styled_header")} onChange={(v) => st.setTableStyle(id, { headerStyle: { ...header, enabled: v, fill: header.fill ?? solidFromHex("#f4f4f5"), bold: header.bold ?? true } })} />
            </div>
            {header.enabled && (
              <div className="flex items-center gap-2 text-[11px] text-neutral-500">
                <span>{tr("editor.fill")}</span>
                <input type="color" value={header.fill && header.fill.type === "solid" ? colorHex(header.fill.color) : "#f4f4f5"} aria-label={tr("editor.header_fill_color")} onChange={(e) => st.setTableStyle(id, { headerStyle: { ...header, enabled: true, fill: solidFromHex(e.target.value) } })} className="oc-color h-7 w-8 shrink-0" />
                <span>{tr("editor.text")}</span>
                <input type="color" value={header.textColor ? colorHex(header.textColor) : "#18181b"} aria-label={tr("editor.header_text_color")} onChange={(e) => st.setTableStyle(id, { headerStyle: { ...header, enabled: true, textColor: colorFromHex(e.target.value) } })} className="oc-color h-7 w-8 shrink-0" />
              </div>
            )}

            <Heading>{tr("editor.borders")}</Heading>
            <div className="flex items-center justify-between text-[11px] text-neutral-500">
              <span>{tr("editor.show_borders")}</span>
              <Toggle checked={border.show} ariaLabel={tr("editor.show_borders")} onChange={(v) => st.setTableStyle(id, { borderStyle: { ...border, show: v } })} />
            </div>
            {border.show && (
              <div className="flex items-center gap-2 text-[11px] text-neutral-500">
                <span>{tr("editor.color")}</span>
                <input type="color" value={border.color ? colorHex(border.color) : "#d4d4d8"} aria-label={tr("editor.border_color")} onChange={(e) => st.setTableStyle(id, { borderStyle: { ...border, show: true, color: colorFromHex(e.target.value) } })} className="oc-color h-7 w-8 shrink-0" />
                <span>{tr("editor.width")}</span>
                <input type="number" min={0} max={8} step={0.5} value={border.width ?? 1} onChange={(e) => st.setTableStyle(id, { borderStyle: { ...border, show: true, width: Math.max(0, Number(e.target.value)) } })} className={`${inputCls} w-16`} />
              </div>
            )}

            <Heading>{tr("editor.cell_formatting")}</Heading>
            <div className="flex items-center gap-2 text-[11px] text-neutral-500">
              <span>{tr("editor.cell")}</span>
              <span>r</span>
              <input type="number" min={0} max={tb.rows - 1} value={sel.row} onChange={(e) => setTableCell({ row: Math.max(0, Math.min(tb.rows - 1, Number(e.target.value))), col: sel.col })} className={`${inputCls} w-14`} />
              <span>c</span>
              <input type="number" min={0} max={tb.cols - 1} value={sel.col} onChange={(e) => setTableCell({ row: sel.row, col: Math.max(0, Math.min(tb.cols - 1, Number(e.target.value))) })} className={`${inputCls} w-14`} />
            </div>
            <div className="flex gap-1.5">
              {(["left", "center", "right"] as const).map((a) => (
                <button key={a} type="button" className={`${btnCls} capitalize ${selCell?.align === a ? "border-brand-400 bg-brand-50 text-brand-ink" : ""}`} onClick={() => st.setTableCellStyle(id, sel.row, sel.col, { align: a })}>{a}</button>
              ))}
            </div>
            <div className="flex items-center gap-2 text-[11px] text-neutral-500">
              <span>{tr("editor.fill")}</span>
              <input type="color" value={selCell?.fill && selCell.fill.type === "solid" ? colorHex(selCell.fill.color) : "#ffffff"} aria-label={tr("editor.cell_fill")} onChange={(e) => st.setTableCellStyle(id, sel.row, sel.col, { fill: solidFromHex(e.target.value) })} className="oc-color h-7 w-8 shrink-0" />
              <span>{tr("editor.text")}</span>
              <input type="color" value={selCell?.textColor ? colorHex(selCell.textColor) : "#18181b"} aria-label={tr("editor.cell_text_color")} onChange={(e) => st.setTableCellStyle(id, sel.row, sel.col, { textColor: colorFromHex(e.target.value) })} className="oc-color h-7 w-8 shrink-0" />
            </div>
            {/* Merge / split the selected cell (engine renders row/col spans). */}
            <div className="flex flex-wrap gap-1.5">
              <button type="button" className={btnCls} onClick={() => st.mergeTableCell(id, sel.row, sel.col, "right")}>{tr("editor.merge")}</button>
              <button type="button" className={btnCls} onClick={() => st.mergeTableCell(id, sel.row, sel.col, "down")}>{tr("editor.merge_2")}</button>
              {selCell && ((selCell.rowSpan ?? 1) > 1 || (selCell.colSpan ?? 1) > 1) && (
                <button type="button" className={btnCls} onClick={() => st.splitTableCell(id, sel.row, sel.col)}>{tr("editor.split")}</button>
              )}
            </div>

            <TableConditional id={id} table={tb} />
            <DataBindingControls node={single.node} />
          </Section>
        );
      })()}
      <Section title={tr("editor.appearance")} order={ORDER.appearance}>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-sm text-neutral-600">
            <span>{tr("editor.opacity")}</span>
            <span className="font-mono text-xs text-neutral-400">{Math.round(opacity * 100)}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(opacity * 100)}
            aria-label={tr("editor.opacity")}
            onChange={(e) => useEditor.getState().setOpacitySel(Math.max(0, Math.min(1, Number(e.target.value) / 100)))}
            className="w-full accent-brand-600"
          />
        </div>
        <label className="flex flex-col gap-1 text-[11px] text-neutral-400">
          {tr("editor.blend_mode")}
          <select
            value={blend}
            onChange={(e) => useEditor.getState().setBlendSel(e.target.value as BlendMode)}
            className={`${selectCls} capitalize`}
          >
            {BLEND_MODES.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>
      </Section>
      {single && <AnimateSection node={single.node} />}
      {single && single.node.type === "image" && <ImageMotionSection node={single.node} />}
      {single && <InteractionSection node={single.node} doc={doc} />}
      {single && <NodeAccessibilitySection node={single.node} />}
    </Wrap>
  );
}

// --- F25 animation / interactivity / motion / page-transition controls ------

const easings = (): { v: Easing; label: string }[] => [
  { v: "linear", label: tr("editor.linear") },
  { v: "ease-in", label: tr("editor.ease_in") },
  { v: "ease-out", label: tr("editor.ease_out") },
  { v: "ease-in-out", label: tr("editor.ease_in_out") },
  { v: "spring", label: tr("editor.spring") },
  { v: "ease-in-cubic", label: tr("editor.ease_in_cubic") },
  { v: "ease-out-cubic", label: tr("editor.ease_out_cubic") },
  { v: "ease-out-back", label: tr("editor.back") },
  { v: "bounce", label: tr("editor.bounce") },
];
const entrancePresets = (): { v: EntrancePreset; label: string }[] => [
  { v: "fade", label: tr("editor.fade") }, { v: "rise", label: tr("editor.rise") }, { v: "pan", label: tr("editor.pan") },
  { v: "pop", label: tr("editor.pop") }, { v: "drift", label: tr("editor.drift") }, { v: "breathe-in", label: tr("editor.breathe_in") },
  { v: "tumble", label: tr("editor.tumble") }, { v: "stomp", label: tr("editor.stomp") }, { v: "zoom-in", label: tr("editor.zoom") },
];
const exitPresets = (): { v: ExitPreset; label: string }[] => [
  { v: "fade-out", label: tr("editor.fade_out") }, { v: "sink", label: tr("editor.sink") },
  { v: "pop-out", label: tr("editor.pop_out") }, { v: "drift-out", label: tr("editor.drift_out") },
  { v: "tumble-out", label: tr("editor.tumble_out") }, { v: "zoom-out", label: tr("editor.zoom_out") },
];
const emphasisPresets = (): { v: EmphasisPreset; label: string }[] => [
  { v: "pulse", label: tr("editor.pulse") }, { v: "wiggle", label: tr("editor.wiggle") }, { v: "spin", label: tr("editor.spin") },
  { v: "breathe", label: tr("editor.breathe") }, { v: "tada", label: tr("editor.tada") },
  { v: "flicker", label: tr("editor.flicker") }, { v: "jiggle", label: tr("editor.jiggle") }, { v: "bob", label: tr("editor.bob") },
];

type AnimTab = "entrance" | "exit" | "emphasis";

/** Custom keyframe timeline editor (F25): a track bar of keyframe dots plus
 *  per-keyframe channel editing (t, dx/dy, scale, rotate, opacity, easing).
 *  Plays in present mode (and the in-editor preview). */
function KeyframeEditor({ node }: { node: Node }) {
  const id = node.id;
  const anim = (node as { animation?: NodeAnimation }).animation ?? {};
  const track = anim.custom;
  const [sel, setSel] = useState(0);
  const set = (t: KeyframeTrack | undefined) => useEditor.getState().setNodeKeyframes(id, t);
  if (!track) {
    return (
      <button
        onClick={() => set({ durationMs: 1000, loop: true, keyframes: [{ t: 0 }, { t: 1000, dy: -30 }] })}
        className="rounded-md border border-neutral-200 px-2 py-1 text-[11px] font-medium text-neutral-700 transition hover:bg-neutral-50"
      >+ Keyframe timeline</button>
    );
  }
  const kfs = track.keyframes;
  const curIdx = Math.min(sel, kfs.length - 1);
  const cur = kfs[curIdx] ?? kfs[0];
  const upd = (patch: Partial<Keyframe>) => set({ ...track, keyframes: kfs.map((k, i) => (i === curIdx ? { ...k, ...patch } : k)) });
  const addKf = () => {
    const t = Math.round(track.durationMs / 2);
    const next = [...kfs, { t } as Keyframe].sort((a, b) => a.t - b.t);
    set({ ...track, keyframes: next });
    setSel(next.findIndex((k) => k.t === t));
  };
  const delKf = () => {
    if (kfs.length <= 1) { set(undefined); return; }
    set({ ...track, keyframes: kfs.filter((_, i) => i !== curIdx) });
    setSel(0);
  };
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-neutral-600">{tr("editor.keyframes")}</span>
        <label className="flex items-center gap-1 text-[10px] text-neutral-500">
          <input type="checkbox" checked={!!track.loop} onChange={(e) => set({ ...track, loop: e.target.checked })} className="h-3 w-3 accent-brand-600" />{tr("editor.loop_2")}
        </label>
      </div>
      <div className="relative h-6 rounded bg-neutral-100">
        {kfs.map((k, i) => (
          <button
            key={i} onClick={() => setSel(i)} title={`${k.t}ms`}
            className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border ${i === curIdx ? "border-brand-600 bg-brand-500" : "border-neutral-300 bg-surface"}`}
            style={{ left: `${Math.max(0, Math.min(1, k.t / Math.max(1, track.durationMs))) * 100}%` }}
          />
        ))}
      </div>
      <div className="flex gap-1.5">
        <button onClick={addKf} className="flex-1 rounded-md border border-neutral-200 px-2 py-1 text-[11px] hover:bg-neutral-50">+ Keyframe</button>
        <button onClick={delKf} className="rounded-md border border-neutral-200 px-2 py-1 text-[11px] text-rose-600 hover:bg-rose-50">{tr("editor.delete")}</button>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <Field key={`dur${track.durationMs}`} label={tr("editor.dur")} value={track.durationMs} onCommit={(n) => set({ ...track, durationMs: Math.max(1, n) })} />
        <Field key={`t${curIdx}-${cur.t}`} label={tr("editor.t_ms")} value={cur.t} onCommit={(n) => upd({ t: Math.max(0, Math.min(track.durationMs, n)) })} />
        <Field key={`dx${curIdx}-${cur.dx}`} label={tr("editor.dx")} value={cur.dx ?? 0} onCommit={(n) => upd({ dx: n })} />
        <Field key={`dy${curIdx}-${cur.dy}`} label={tr("editor.dy")} value={cur.dy ?? 0} onCommit={(n) => upd({ dy: n })} />
        <Field key={`sc${curIdx}-${cur.scale}`} label={tr("editor.scale")} value={cur.scale ?? 1} onCommit={(n) => upd({ scale: n })} />
        <Field key={`rot${curIdx}-${cur.rotate}`} label={tr("editor.rotate")} value={cur.rotate ?? 0} onCommit={(n) => upd({ rotate: n })} />
        <Field key={`op${curIdx}-${cur.opacity}`} label={tr("editor.opacity_2")} value={cur.opacity ?? 1} onCommit={(n) => upd({ opacity: Math.max(0, Math.min(1, n)) })} />
      </div>
      <select aria-label={tr("editor.easing")} value={cur.easing ?? "linear"} onChange={(e) => upd({ easing: e.target.value as Easing })} className={selectCls}>
        {easings().map((es) => <option key={es.v} value={es.v}>{es.label}</option>)}
      </select>
    </div>
  );
}

/** Animate section: tabbed Entrance / Exit / Emphasis controls (preset, duration,
 *  delay, easing) plus a per-element Preview button. Writes the typed
 *  `NodeAnimation` through the store as one undoable step per change. */
function AnimateSection({ node }: { node: Node }) {
  const [tab, setTab] = useState<AnimTab>("entrance");
  const st = useEditor.getState();
  const id = node.id;
  const anim = (node as { animation?: NodeAnimation }).animation ?? {};
  // Typewriter reveal only makes sense for text, so offer it only there.
  const entranceOptions = node.type === "text" ? [...entrancePresets(), { v: "typewriter" as EntrancePreset, label: tr("editor.typewriter") }, { v: "word-wipe" as EntrancePreset, label: tr("editor.word_wipe") }] : entrancePresets();
  const presets = tab === "entrance" ? entranceOptions : tab === "exit" ? exitPresets() : emphasisPresets();
  const clip = anim[tab];
  const set = (next: NonNullable<NodeAnimation[AnimTab]> | undefined) => {
    st.setNodeAnimation(id, { ...anim, [tab]: next } as NodeAnimation);
  };
  return (
    <Section title={tr("editor.animate")} order={ORDER.interactivity} defaultOpen={false}>
      <div className="flex items-center justify-end">
        <button
          onClick={() => st.previewNodeAnimation(id)}
          className="rounded-md border border-neutral-200 px-2 py-0.5 text-[11px] font-medium text-neutral-600 transition hover:bg-neutral-100"
        >{tr("editor.preview")}</button>
      </div>
      {/* Magic Animate: one click animates every element on the page with a
          staggered build-in (no AI; tasteful defaults by element kind). */}
      <div className="flex gap-1.5">
        <button onClick={() => st.magicAnimatePage()} className="flex-1 rounded-lg bg-brand-50 px-2 py-1.5 text-[11px] font-medium text-brand-ink transition hover:bg-brand-100">{tr("editor.animate_all")}</button>
        <button onClick={() => st.magicAnimatePage(true)} className="rounded-lg bg-neutral-100 px-2 py-1.5 text-[11px] text-neutral-500 transition hover:bg-neutral-200" title={tr("editor.remove_animations_from_all_elements_on_this")}>{tr("editor.clear_all")}</button>
      </div>
      <div className="flex rounded-lg bg-neutral-100 p-0.5 text-xs">
        {(["entrance", "exit", "emphasis"] as AnimTab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 rounded-md py-1 capitalize transition ${tab === t ? "bg-surface text-neutral-800 shadow-sm" : "text-neutral-500 hover:text-neutral-700"}`}
          >{t}</button>
        ))}
      </div>
      <select aria-label={tr("editor.animation_preset")}
        value={clip?.preset ?? "none"}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "none") set(undefined);
          else set({ preset: v, durationMs: clip?.durationMs ?? (tab === "emphasis" ? 1200 : 500), delayMs: clip?.delayMs ?? 0, easing: clip?.easing ?? (tab === "exit" ? "ease-in" : "ease-out") } as NonNullable<NodeAnimation[AnimTab]>);
        }}
        className={selectCls}
      >
        <option value="none">{tr("editor.none")}</option>
        {presets.map((p) => <option key={p.v} value={p.v}>{p.label}</option>)}
      </select>
      {clip && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Field key={`${tab}d${clip.durationMs}`} label={tr("editor.dur")} value={clip.durationMs} onCommit={(n) => set({ ...clip, durationMs: Math.max(0, n) })} />
            <Field key={`${tab}l${clip.delayMs}`} label={tr("editor.delay")} value={clip.delayMs} onCommit={(n) => set({ ...clip, delayMs: Math.max(0, n) })} />
          </div>
          {/* Custom cubic-bezier curve: when enabled it overrides the named easing
              (4 control values, CSS-style). Picking a named easing clears it. */}
          {(() => {
            const bz = (clip as { bezier?: [number, number, number, number] }).bezier;
            return (
              <div className="flex flex-col gap-1.5">
                <label className="flex items-center justify-between text-[11px] text-neutral-500">
                  <span>{tr("editor.custom_curve")}</span>
                  <Toggle checked={!!bz} onChange={(on) => set({ ...clip, bezier: on ? [0.42, 0, 0.58, 1] : undefined })} />
                </label>
                {bz && (
                  <div className="grid grid-cols-4 gap-1">
                    {(["x1", "y1", "x2", "y2"] as const).map((lbl, i) => (
                      <input key={lbl} type="number" step={0.05} value={bz[i]} title={lbl} aria-label={lbl}
                        onChange={(e) => { const n = [...bz] as [number, number, number, number]; n[i] = Number(e.target.value); set({ ...clip, bezier: n }); }}
                        className="rounded border border-neutral-200 px-1 py-0.5 text-[11px] outline-none focus:border-brand-400" />
                    ))}
                  </div>
                )}
              </div>
            );
          })()}
          <select aria-label={tr("editor.easing")} value={clip.easing} disabled={!!(clip as { bezier?: unknown }).bezier} onChange={(e) => set({ ...clip, easing: e.target.value as Easing, bezier: undefined })} className={`${selectCls} disabled:opacity-40`}>
            {easings().map((es) => <option key={es.v} value={es.v}>{es.label}</option>)}
          </select>
          {/* Entrance sequencing across siblings: start with/after the previous
              animated element ("with/after previous" timing). */}
          {tab === "entrance" && (
            <label className="flex flex-col gap-1 text-[11px] text-neutral-400">{tr("editor.start")}
              <select value={(clip as { startMode?: string }).startMode ?? "delay"} onChange={(e) => set({ ...clip, startMode: e.target.value as "delay" | "with-previous" | "after-previous" })} className={selectCls}>
                <option value="delay">{tr("editor.on_delay")}</option>
                <option value="with-previous">{tr("editor.with_previous")}</option>
                <option value="after-previous">{tr("editor.after_previous")}</option>
              </select>
            </label>
          )}
          {tab === "emphasis" && <p className="text-[11px] text-neutral-400">{tr("editor.loops_while_the_slide_is_shown")}</p>}
        </>
      )}
      <KeyframeEditor node={node} />
    </Section>
  );
}

/** Image photo-motion control (Ken Burns / parallax) with an intensity slider. */
function ImageMotionSection({ node }: { node: Node }) {
  const st = useEditor.getState();
  const id = node.id;
  const motion = (node as { motion?: ImageMotion }).motion;
  return (
    <Section title={tr("editor.motion")} order={ORDER.interactivity}>
      <select aria-label={tr("editor.motion")}
        value={motion?.kind ?? "none"}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "none") st.setImageMotion(id, undefined);
          else st.setImageMotion(id, { kind: v as ImageMotion["kind"], intensity: motion?.intensity ?? 0.5 });
        }}
        className={selectCls}
      >
        <option value="none">{tr("editor.none")}</option>
        <option value="kenburns">{tr("editor.ken_burns_zoom_pan")}</option>
        <option value="parallax">{tr("editor.parallax_pan")}</option>
      </select>
      {motion && (
        <label className="flex flex-col gap-1 text-[11px] text-neutral-400">
          {tr("editor.intensity")}
          <input
            type="range" min={0} max={100} value={Math.round(motion.intensity * 100)}
            onChange={(e) => st.setImageMotion(id, { ...motion, intensity: Number(e.target.value) / 100 })}
            className="w-full accent-brand-600"
          />
        </label>
      )}
      <p className="text-[11px] text-neutral-400">{tr("editor.plays_during_present_mode")}</p>
    </Section>
  );
}

/** Interaction control: trigger (click/hover) + action (navigate / open link). */
function InteractionSection({ node, doc }: { node: Node; doc: DesignFile }) {
  const st = useEditor.getState();
  const id = node.id;
  const interaction = (node as { interaction?: Interaction }).interaction;
  const action = interaction?.action ?? { kind: "none" as const };
  const setAction = (next: InteractionAction) => {
    if (next.kind === "none") { st.setInteraction(id, undefined); return; }
    st.setInteraction(id, { trigger: interaction?.trigger ?? "click", action: next });
  };
  return (
    <Section title={tr("editor.interaction")} order={ORDER.interactivity} defaultOpen={false}>
      <div className="grid grid-cols-2 gap-2">
        <select aria-label={tr("editor.interaction")}
          value={interaction?.trigger ?? "click"}
          onChange={(e) => interaction && st.setInteraction(id, { ...interaction, trigger: e.target.value as Interaction["trigger"] })}
          disabled={!interaction}
          className={`${selectCls} disabled:opacity-50`}
        >
          <option value="click">{tr("editor.on_click")}</option>
          <option value="hover">{tr("editor.on_hover")}</option>
        </select>
        <select aria-label={tr("editor.on_hover")}
          value={action.kind}
          onChange={(e) => {
            const k = e.target.value;
            if (k === "none") setAction({ kind: "none" });
            else if (k === "navigate") setAction({ kind: "navigate", to: "next" });
            else setAction({ kind: "open-link", link: { kind: "url", target: "" } });
          }}
          className={selectCls}
        >
          <option value="none">{tr("editor.none")}</option>
          <option value="navigate">{tr("editor.go_to_page")}</option>
          <option value="open-link">{tr("editor.open_link")}</option>
        </select>
      </div>
      {action.kind === "navigate" && (
        <select aria-label={tr("editor.go_to_page")}
          value={action.to === "page" ? `page:${action.pageId ?? ""}` : action.to}
          onChange={(e) => {
            const v = e.target.value;
            if (v.startsWith("page:")) setAction({ kind: "navigate", to: "page", pageId: v.slice(5) });
            else setAction({ kind: "navigate", to: v as "next" | "prev" | "first" | "last" });
          }}
          className={selectCls}
        >
          <option value="next">{tr("editor.next_page")}</option>
          <option value="prev">{tr("editor.previous_page")}</option>
          <option value="first">{tr("editor.first_page")}</option>
          <option value="last">{tr("editor.last_page")}</option>
          {doc.pages.map((p, i) => <option key={p.id} value={`page:${p.id}`}>{p.name ?? `Page ${i + 1}`}</option>)}
        </select>
      )}
      {action.kind === "open-link" && (
        <input
          key={`ix-${id}`}
          defaultValue={action.link.target}
          placeholder="https://…"
          onBlur={(e) => {
            const v = e.target.value.trim();
            const link: ElementLink = { kind: v.startsWith("mailto:") || v.includes("@") ? "email" : "url", target: v };
            setAction(v ? { kind: "open-link", link } : { kind: "none" });
          }}
          className="w-full rounded-lg border border-neutral-200 bg-surface px-2 py-1.5 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
        />
      )}
    </Section>
  );
}

/** Slide layout picker (doc 28 FR-3). Assigning a layout gives the page a
 *  placeholder cascade, including the title placeholder that makes its name a
 *  real, screen-reader-navigable slide title. Installing the built-in layouts
 *  is itself one undoable action, so a deck opts in explicitly. */
function PageLayoutSection({ page, workspaceId }: { page: Page; workspaceId: string | null }) {
  const st = useEditor.getState();
  const rev = useEditor((s) => s.rev);
  const toast = useToast();
  const [extracting, setExtracting] = useState(false);
  const doc = useEditor.getState().doc as unknown as {
    layouts?: { id: string; name: string }[];
    pages: unknown[];
  };
  const layouts = doc.layouts ?? [];
  const current = (page as { layoutId?: string }).layoutId;
  // Resolve against the live doc so a deleted layout shows as "None".
  const known = layouts.some((l) => l.id === current);
  void rev; // re-render when the deck's layouts change

  // T20: turn an imported or hand-built deck into a reusable layout set - one
  // undoable action; near-identical slides collapse to one layout. Stage 2:
  // when the provider can see, each unique layout gets a vision correction
  // pass over the rendered page before installing; any failure keeps the
  // heuristic result, so the pass can only improve the set.
  const extract = async () => {
    const live = useEditor.getState().doc;
    const set = extractLayoutSet(live.pages as unknown as ExtractPageLike[]);
    if (!set.layouts.length) {
      toast.toast(tr("editor.no_layouts_could_be_extracted"), "info");
      return;
    }
    let install: ExtractedLayoutSet = set;
    if (workspaceId) {
      setExtracting(true);
      try {
        const idsAt = live.pages.map((p) => p.id);
        const { layouts: corrected } = await refineExtractedLayoutSet(workspaceId, live, set);
        // Pages may have been added, removed, or moved while the vision pass
        // ran: re-anchor the page links by page id before installing.
        const now = useEditor.getState().doc;
        install = {
          layouts: corrected,
          assignments: now.pages.map((p) => {
            const i = idsAt.indexOf(p.id);
            return i >= 0 ? set.assignments[i] : null;
          }),
        };
      } finally {
        setExtracting(false);
      }
    }
    const result = useEditor.getState().extractLayoutsFromDeck(install);
    if (!result) {
      toast.toast(tr("editor.no_layouts_could_be_extracted"), "info");
      return;
    }
    toast.success(tr("editor.extracted_layouts_count", { count: result.created }));
  };
  const extractButton = doc.pages.length > 1 && (
    <button type="button" onClick={() => void extract()} disabled={extracting} className={`${actionBtnCls} mt-1.5 disabled:opacity-50`} data-testid="extract-layouts">
      {extracting ? tr("editor.analyzing_slides") : tr("editor.extract_layouts_from_this_deck")}
    </button>
  );

  if (!layouts.length) {
    return (
      <Section title={tr("editor.layout")}>
        <p className="mb-2 text-[11px] leading-relaxed text-neutral-500">
          Slide layouts give each slide a title and content placeholders, and make slide titles readable by screen
          readers.
        </p>
        <button type="button" onClick={() => st.ensureSlideLayouts()} className={actionBtnCls} data-testid="add-layouts">
          {tr("editor.add_slide_layouts")}
        </button>
        {extractButton}
      </Section>
    );
  }
  return (
    <Section title={tr("editor.layout")}>
      <select
        value={known ? current : "none"}
        onChange={(e) => st.setPageLayout(e.target.value === "none" ? undefined : e.target.value)}
        className={selectCls}
        data-testid="layout-select"
        aria-label={tr("editor.slide_layout")}
      >
        <option value="none">{tr("editor.none")}</option>
        {layouts.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
      <p className="mt-1.5 text-[11px] text-neutral-500">
        {tr("editor.layout_supplies_regions")}
      </p>
      {extractButton}
    </Section>
  );
}

/** Deck theme swap (doc 28 FR-4, F28 T19). Adopting a theme swaps the deck's
 *  palette and font pair in one undoable action; content painted with the
 *  PREVIOUS theme's slot colors and fonts follows the swap (exact matches
 *  only), so a themed deck restyles while a user's own choices never move.
 *  The seed palettes adapt an MIT-licensed catalog (see THIRD_PARTY.md) into
 *  the 6-slot convention: primary, accent, deep, tint, ink, paper. */
const builtinThemes = (): { id: string; name: string; colors: string[]; fontHeading: string; fontBody: string }[] => [
  { id: "theme-plum", name: tr("editor.plum"), colors: ["#9B2C72", "#C84B9A", "#3E1030", "#FBEFF7", "#18181b", "#ffffff"], fontHeading: "Plus Jakarta Sans", fontBody: "Plus Jakarta Sans" },
  { id: "theme-slate", name: tr("editor.slate"), colors: ["#0f172a", "#334155", "#64748b", "#e2e8f0", "#020617", "#ffffff"], fontHeading: "Inter", fontBody: "Inter" },
  { id: "theme-forest", name: tr("editor.forest"), colors: ["#14532d", "#16a34a", "#4ade80", "#dcfce7", "#052e16", "#ffffff"], fontHeading: "Inter", fontBody: "Inter" },
  { id: "theme-azure", name: tr("editor.azure"), colors: ["#3b82f6", "#60a5fa", "#1e40af", "#f3f4f6", "#1f2937", "#ffffff"], fontHeading: "Inter", fontBody: "Inter" },
  { id: "theme-sunset", name: tr("editor.sunset"), colors: ["#ea580c", "#fb923c", "#9a3412", "#ffffff", "#292524", "#fffbeb"], fontHeading: "DM Serif Display", fontBody: "DM Sans" },
  { id: "theme-ocean", name: tr("editor.ocean"), colors: ["#0284c7", "#38bdf8", "#0369a1", "#ffffff", "#0c4a6e", "#f0f9ff"], fontHeading: "Outfit", fontBody: "Work Sans" },
  { id: "theme-sakura", name: tr("editor.sakura"), colors: ["#ec4899", "#f472b6", "#be185d", "#ffffff", "#831843", "#fdf2f8"], fontHeading: "Cormorant Garamond", fontBody: "Lato" },
  { id: "theme-sand", name: tr("editor.sand"), colors: ["#a16207", "#ca8a04", "#713f12", "#ffffff", "#422006", "#fefce8"], fontHeading: "Fraunces", fontBody: "Nunito" },
  { id: "theme-mint", name: tr("editor.mint"), colors: ["#10b981", "#34d399", "#047857", "#ffffff", "#064e3b", "#ecfdf5"], fontHeading: "Plus Jakarta Sans", fontBody: "Inter" },
  { id: "theme-lavender", name: tr("editor.lavender"), colors: ["#9333ea", "#a855f7", "#7e22ce", "#ffffff", "#3b0764", "#faf5ff"], fontHeading: "Sora", fontBody: "Rubik" },
  { id: "theme-noir", name: tr("editor.noir"), colors: ["#60a5fa", "#93c5fd", "#1d4ed8", "#1f2937", "#e5e7eb", "#111827"], fontHeading: "Inter", fontBody: "Inter" },
  { id: "theme-indigo", name: tr("editor.indigo"), colors: ["#818cf8", "#a5b4fc", "#4338ca", "#312e81", "#e2e8f0", "#1e1b4b"], fontHeading: "Poppins", fontBody: "Source Sans 3" },
  { id: "theme-gilded", name: tr("editor.gilded"), colors: ["#d2ac47", "#f4e883", "#ae8625", "#1b1c1d", "#cfcbbf", "#0a0a0a"], fontHeading: "Prata", fontBody: "Raleway" },
];

/** One selectable theme row: four palette chips + the name. */
function ThemeRow({ active, colors, name, testId, onClick }: { active: boolean; colors: string[]; name: string; testId: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      data-testid={testId}
      onClick={onClick}
      className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-start text-sm transition ${
        active ? "border-brand-500 bg-brand-50 text-brand-ink" : "border-neutral-200 hover:bg-neutral-50"
      }`}
    >
      <span className="flex shrink-0 gap-0.5">
        {colors.slice(0, 4).map((c, i) => (
          <span key={`${c}-${i}`} style={{ background: c }} className="h-4 w-2.5 rounded-sm ring-1 ring-black/10" />
        ))}
      </span>
      <span className="min-w-0 flex-1 truncate">{name}</span>
    </button>
  );
}

function DeckThemeSection() {
  const st = useEditor.getState();
  const rev = useEditor((s) => s.rev);
  const brandKit = useBrand((s) => s.kit);
  const doc = useEditor.getState().doc as unknown as { theme?: Theme };
  const current = doc.theme?.id;
  void rev;
  const seeds = builtinThemes();
  // A theme this list doesn't know (AI-generated, brand-derived, or stamped by
  // deck generation) still shows as the active choice instead of vanishing.
  const custom = doc.theme && !seeds.some((t) => t.id === current) ? doc.theme : null;

  // T19 (b): the brand kit -> theme bridge. The kit's leading colors seed the
  // 6-slot palette (missing slots derived, contrast repaired) and the kit's
  // fonts become the pair; applying is the same undoable swap as any theme.
  const brandColors = brandHexColors(brandKit);
  const applyBrandTheme = () => {
    if (!brandKit || !brandColors.length) return;
    const mode = (() => {
      const c = colorFromHex(brandColors[0]);
      return 0.2126 * c.srgb.r + 0.7152 * c.srgb.g + 0.0722 * c.srgb.b < 0.35 ? "dark" : "light";
    })();
    const slots = repairThemeSlots(
      deriveThemeSlots({ primary: brandColors[0], accent: brandColors[1], deep: brandColors[2] }, mode),
      mode,
    );
    const fonts = brandFontFamilies(brandKit);
    const id = `theme-brand-${brandKit.id}`;
    st.setDeckTheme(
      themeFromPalette(id, themeSlotNames.map((slot) => ({ id: `${id}-${slot}`, name: slot, color: colorFromHex(slots[slot]) })), {
        name: brandKit.name,
        fontHeading: fonts[0],
        fontBody: fonts[1] ?? fonts[0],
      }),
    );
  };

  return (
    <Section title={tr("editor.deck_theme")}>
      <div className="flex flex-col gap-1.5" role="radiogroup" aria-label={tr("editor.deck_theme")}>
        {custom && (
          <ThemeRow
            active
            testId="theme-current-custom"
            name={custom.name ?? tr("editor.custom_theme")}
            colors={custom.colors.map((c) => colorHex(c.color))}
          />
        )}
        {seeds.map((t) => (
          <ThemeRow
            key={t.id}
            active={current === t.id}
            testId={`theme-${t.id}`}
            name={t.name}
            colors={t.colors}
            onClick={() =>
              st.setDeckTheme({
                id: t.id,
                name: t.name,
                colors: t.colors.map((hex, i) => ({ id: `${t.id}-${i}`, name: themeSlotNames[i], color: colorFromHex(hex) })),
                fontHeading: t.fontHeading,
                fontBody: t.fontBody,
              })
            }
          />
        ))}
        {brandKit && brandColors.length > 0 && (
          <button type="button" onClick={applyBrandTheme} className={actionBtnCls} data-testid="theme-from-brand">
            {tr("editor.create_theme_from_brand_kit")}
          </button>
        )}
        {current && (
          <button type="button" onClick={() => st.setDeckTheme(undefined)} className="mt-0.5 text-start text-[11px] text-neutral-500 hover:underline" data-testid="clear-theme">
            {tr("editor.clear_theme")}
          </button>
        )}
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-neutral-500">
        {tr("editor.theme_palette_scope_hint")}
      </p>
    </Section>
  );
}

/** Per-node accessibility (doc 28 FR-29): a description for assistive
 *  technology, or a decorative flag that exempts the node from needing one.
 *  Shown for every node type, because meaning is not the preserve of images. */
function NodeAccessibilitySection({ node }: { node: Node }) {
  const st = useEditor.getState();
  const rev = useEditor((s) => s.rev);
  void rev;
  const rec = node as unknown as { altText?: string; alt?: string; decorative?: boolean };
  const decorative = rec.decorative === true;
  // The generic field wins; the legacy image-only `alt` still shows so an older
  // file's description is visible rather than appearing to have vanished.
  const value = rec.altText ?? (node.type === "image" ? rec.alt : undefined) ?? "";
  return (
    <Section title={tr("editor.accessibility")} order={ORDER.accessibility}>
      <label className="mb-1 block text-[11px] font-medium text-neutral-500" htmlFor="a11y-alt">
        {tr("editor.description_alt_text")}
      </label>
      <textarea
        id="a11y-alt"
        data-testid="alt-text-input"
        rows={2}
        disabled={decorative}
        value={value}
        placeholder={decorative ? tr("editor.not_needed_for_decorative_elements") : tr("editor.describe_this_element_for_screen_readers")}
        onChange={(e) => st.setNodeAltText(node.id, e.target.value)}
        className="w-full resize-y rounded-lg border border-neutral-200 bg-surface px-2 py-1.5 text-sm text-neutral-800 outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100 disabled:opacity-50"
      />
      <label className="mt-2 flex items-center gap-2 text-sm text-neutral-700">
        <input
          type="checkbox"
          data-testid="decorative-toggle"
          checked={decorative}
          onChange={(e) => st.setNodeDecorative(node.id, e.target.checked)}
          className="h-4 w-4 rounded border-neutral-300 accent-brand-600"
        />
        {tr("editor.decorative_skip_for_screen_readers")}
      </label>
    </Section>
  );
}

/** Per-page transition control shown in the empty-selection page panel. */
function PageTransitionSection({ page }: { page: Page }) {
  const st = useEditor.getState();
  const t = (page as { transition?: import("@hc/schema").PageTransition }).transition;
  type TransitionType = import("@hc/schema").PageTransition["type"];
  return (
    <Section title={tr("editor.transition")}>
      <select aria-label={tr("editor.transition")}
        value={t?.type ?? "none"}
        onChange={(e) => {
          const v = e.target.value as TransitionType;
          if (v === "none") st.setPageTransition(undefined);
          else st.setPageTransition({ type: v, direction: t?.direction ?? "left", durationMs: t?.durationMs ?? 400 });
        }}
        className={selectCls}
      >
        <option value="none">{tr("editor.none")}</option>
        <option value="fade">{tr("editor.fade")}</option>
        <option value="slide">{tr("editor.slide")}</option>
        <option value="push">{tr("editor.push")}</option>
        <option value="dissolve">{tr("editor.dissolve")}</option>
        <option value="morph-lite">{tr("editor.morph_lite")}</option>
        <option value="morph">{tr("editor.morph_magic_move")}</option>
        <option value="wipe">{tr("editor.wipe")}</option>
        <option value="flip">{tr("editor.flip")}</option>
        <option value="zoom">{tr("editor.zoom")}</option>
      </select>
      {t && t.type !== "none" && (
        <div className="grid grid-cols-2 gap-2">
          {(t.type === "slide" || t.type === "push" || t.type === "wipe") && (
            <select aria-label={tr("editor.direction")}
              value={t.direction ?? "left"}
              onChange={(e) => st.setPageTransition({ ...t, direction: e.target.value as NonNullable<typeof t.direction> })}
              className={selectCls}
            >
              <option value="left">{tr("editor.left")}</option>
              <option value="right">{tr("editor.right")}</option>
              <option value="up">{tr("editor.up")}</option>
              <option value="down">{tr("editor.down")}</option>
            </select>
          )}
          <Field key={`pt${t.durationMs}`} label={tr("editor.dur")} value={t.durationMs} onCommit={(n) => st.setPageTransition({ ...t, durationMs: Math.max(0, n) })} />
        </div>
      )}
      <p className="text-[11px] text-neutral-400">{tr("editor.plays_when_advancing_to_this_page_in_present")}</p>
      {/* Apply-to-all (doc 28 FR-10): PowerPoint's "Apply To All", one undo step. */}
      <button
        type="button"
        data-testid="apply-transition-all"
        onClick={() => st.applyTransitionToAllPages()}
        className="mt-2 w-full rounded-lg border border-neutral-200 bg-surface px-2 py-1.5 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50"
      >
        {tr("editor.apply_to_all_slides")}
      </button>
    </Section>
  );
}

/** Per-slide present settings shown in the empty-selection page panel:
 *  speaker notes (FR-4), autopilot dwell (FR-14), and hide/skip (FR-1). All edits
 *  are undoable via the store. The active page in present mode reads these. */
function PagePresentSection({ page }: { page: Page }) {
  const st = useEditor.getState();
  const notes = (page as { notes?: string }).notes ?? "";
  const autoMs = (page as { autoAdvanceMs?: number }).autoAdvanceMs;
  const hidden = !!(page as { hidden?: boolean }).hidden;
  const autoSec = typeof autoMs === "number" ? Math.round(autoMs / 100) / 10 : "";
  return (
    <Section title={tr("editor.present")}>
      <label className="flex items-center justify-between gap-2 text-sm text-neutral-700">
        <span>{tr("editor.hide_slide_while_presenting")}</span>
        <input
          type="checkbox"
          checked={hidden}
          onChange={(e) => st.setPageHidden(e.target.checked)}
          className="h-4 w-4 accent-brand-500"
        />
      </label>
      <div>
        <div className="mb-1 text-[11px] font-medium text-neutral-400">{tr("editor.speaker_notes")}</div>
        <textarea
          key={`notes-${page.id}`}
          defaultValue={notes}
          onBlur={(e) => st.setPageNotes(e.target.value)}
          placeholder={tr("editor.notes_for_the_presenter_view_not_shown_to_th")}
          rows={4}
          className="w-full resize-y rounded-lg border border-neutral-200 bg-surface px-2 py-1.5 text-sm leading-relaxed outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
        />
      </div>
      <label className="flex items-center justify-between gap-2 text-sm text-neutral-700">
        <span>{tr("editor.auto_advance_after")}</span>
        <span className="flex items-center gap-1">
          <input
            key={`adv-${page.id}-${String(autoSec)}`}
            type="number"
            min={0}
            step={0.5}
            defaultValue={autoSec}
            placeholder={tr("editor.off")}
            onBlur={(e) => {
              const v = e.target.value.trim();
              st.setPageAutoAdvance(v === "" ? null : Math.max(0, Number(v) || 0) * 1000);
            }}
            className="w-16 rounded-lg border border-neutral-200 bg-surface px-2 py-1 text-end text-sm tabular-nums outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
          />
          <span className="text-xs text-neutral-400">s</span>
        </span>
      </label>
      <p className="text-[11px] text-neutral-400">{tr("editor.autopilot_dwell_hint")}</p>
    </Section>
  );
}

function Wrap({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-2.5 p-4">{children}</div>;
}

// --- F24 image effects: Filters / Adjust / Effects-stack + AI tools ----------

type AdjEffect = { kind: "adjustment"; ops: AdjOp[] };
type DuotoneEffect = { kind: "duotone"; shadows: Color; highlights: Color; intensity: number };

const adjustGroups = (): { group: string; sliders: { name: string; label: string; min: number; max: number; def: number; step?: number }[] }[] => [
  { group: tr("editor.light"), sliders: [
    { name: "brightness", label: tr("editor.brightness"), min: 0, max: 2, def: 1 },
    { name: "exposure", label: tr("editor.exposure"), min: -1, max: 1, def: 0 },
    { name: "contrast", label: tr("editor.contrast"), min: 0, max: 2, def: 1 },
    { name: "highlights", label: tr("editor.highlights"), min: -1, max: 1, def: 0 },
    { name: "shadows", label: tr("editor.shadows"), min: -1, max: 1, def: 0 },
  ] },
  { group: tr("editor.color"), sliders: [
    { name: "saturate", label: tr("editor.saturation"), min: 0, max: 2, def: 1 },
    { name: "vibrance", label: tr("editor.vibrance"), min: -1, max: 1, def: 0 },
    { name: "warmth", label: tr("editor.warmth"), min: -1, max: 1, def: 0 },
    { name: "tint", label: tr("editor.tint"), min: -1, max: 1, def: 0 },
    { name: "hue-rotate", label: tr("editor.hue"), min: -180, max: 180, def: 0, step: 1 },
  ] },
  { group: tr("editor.detail"), sliders: [
    { name: "grayscale", label: tr("editor.grayscale"), min: 0, max: 1, def: 0 },
    { name: "sepia", label: tr("editor.sepia"), min: 0, max: 1, def: 0 },
    { name: "blur", label: tr("editor.blur"), min: 0, max: 20, def: 0, step: 0.5 },
  ] },
];

/** Human label for an effect entry in the stack list. */
function effectLabel(e: Effect): string {
  switch (e.kind) {
    case "adjustment": return tr("editor.adjustments");
    case "duotone": return tr("editor.duotone");
    case "blur": return tr("editor.blur");
    case "shadow": return (e.type ?? "drop") === "drop" ? tr("editor.drop_shadow") : tr("editor.inner_shadow");
    case "glow": return tr("editor.glow");
    case "outline": return tr("editor.outline");
    default: return (e as { kind: string }).kind;
  }
}

function ImageEffectsSection({ id, node, workspaceId }: { id: string; node: Node; workspaceId: string | null }) {
  const [tab, setTab] = useState<"filters" | "adjust" | "effects">("adjust");
  const [intensity, setIntensity] = useState(1);
  const [activePreset, setActivePreset] = useState("original");
  const [bgState, setBgState] = useState<"idle" | "working" | "error">("idle");
  const [bgProgress, setBgProgress] = useState(0);
  const [bgError, setBgError] = useState<string | null>(null);
  // Both the remover and the brush write the same alphaMask field, and the
  // brush's working buffer is seeded ONCE per session: a removal committed
  // mid-refine would be silently overwritten by the very next stroke.
  const refining = useEditor((s) => s.maskRefining === id);
  const draggingRef = useRef(false);
  const beforeRef = useRef<unknown>(null);

  const effects = (node.effects ?? []) as Effect[];
  const adj = (effects.find((e) => e.kind === "adjustment") as AdjEffect | undefined)?.ops ?? [];
  const duo = effects.find((e) => e.kind === "duotone") as DuotoneEffect | undefined;
  const val = (name: string, def: number) => adj.find((o) => o.name === name)?.value ?? def;

  const setOp = (name: string, value: number) => {
    const others = adj.filter((o) => o.name !== name);
    useEditor.getState().previewAdjustments(id, [...others, { name, value }]);
  };
  const beginDrag = () => {
    draggingRef.current = true;
    beforeRef.current = structuredClone(locate(useEditor.getState().doc, id)?.node.effects ?? null);
  };
  const endDrag = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    useEditor.getState().commitEffects(id, beforeRef.current);
  };

  // Apply a fresh adjustment set as a single undo step (presets / auto-enhance).
  const applyAdjustments = (ops: AdjOp[]) => {
    const rest = effects.filter((e) => e.kind !== "adjustment");
    const next = ops.length ? [...rest, { kind: "adjustment", ops } as Effect] : rest;
    useEditor.getState().setEffects(id, (next.length ? next : undefined) as never);
  };
  const applyPreset = (presetId: string, k: number) => {
    const preset = filterPresets.find((p) => p.id === presetId);
    if (!preset) return;
    setActivePreset(presetId);
    applyAdjustments(resolvePresetOps(preset, k));
  };

  const setEffects = (next: Effect[]) =>
    useEditor.getState().setEffects(id, (next.length ? next : undefined) as never);
  const removeEffect = (idx: number) => setEffects(effects.filter((_, i) => i !== idx));

  // Duotone control: brand-aware color pickers, intensity, toggle.
  const setDuotone = (patch: Partial<DuotoneEffect>) => {
    const rest = effects.filter((e) => e.kind !== "duotone");
    const base: DuotoneEffect = duo ?? {
      kind: "duotone",
      shadows: { srgb: { r: 0.04, g: 0.05, b: 0.2, a: 1 } },
      highlights: { srgb: { r: 1, g: 0.86, b: 0.3, a: 1 } },
      intensity: 1,
    };
    setEffects([...rest, { ...base, ...patch }]);
  };
  const removeDuotone = () => setEffects(effects.filter((e) => e.kind !== "duotone"));

  const runBgRemoval = async () => {
    const doc = useEditor.getState().doc;
    const src = (node as unknown as { source: { assetId: string; naturalWidth?: number; naturalHeight?: number } }).source;
    const url = doc.assets.find((a) => a.id === src.assetId)?.url;
    if (!url) {
      setBgState("error");
      setBgError(tr("editor.this_image_has_no_resolvable_source_url"));
      return;
    }
    setBgState("working");
    setBgProgress(0);
    setBgError(null);
    try {
      // Fetch the image through the app's own path (absolute URL + credentials)
      // and hand the bytes to the remover as a Blob, so it never has to fetch a
      // relative/cross-origin URL itself (the main reason removal used to fail).
      const resp = await fetch(resolveAssetUrl(url), { credentials: "include" });
      if (!resp.ok) throw new CodedError("errors.image_load_failed", `Couldn't load the image (${resp.status}).`, { status: resp.status });
      let blob = await resp.blob();
      // The model only accepts raster images; rasterize a vector (SVG) or any
      // non-raster to a PNG first (otherwise it throws "Invalid format").
      if (!/^image\/(png|jpeg|webp)$/.test(blob.type)) {
        blob = await rasterizeToPng(blob, src.naturalWidth ?? 0, src.naturalHeight ?? 0);
      }
      const { dataUrl } = await removeBackground(blob, (f) => setBgProgress(f));
      // Non-destructive (v20): the ORIGINAL stays in `source` and only the
      // alpha travels, as a mask beside it. Overwriting the source, which this
      // used to do, discarded the user's pixels and made the result impossible
      // to undo meaningfully or refine afterwards.
      //
      // Only the MASK is uploaded now. The flattened cutout used to be uploaded
      // too and is no longer stored anywhere, which halves what this costs: a
      // grayscale mask also compresses far smaller than a colour cutout.
      const mask = await alphaMaskFromCutout(dataUrl);
      // A real uploaded asset, never a data URL: the document carries its
      // assets inline, so embedding megabytes of base64 pushes them into the
      // CRDT, every snapshot, and IndexedDB, and re-sends them to every
      // collaborator on load. Falling back to the data URL keeps the feature
      // working offline or without a workspace, which is the lesser evil.
      let maskUrl = mask.dataUrl;
      if (workspaceId) {
        try {
          const asset = await uploadAssetWithProgress(workspaceId, {
            filename: `mask-${Date.now()}.png`,
            dataBase64: mask.dataUrl.split(",")[1] ?? "",
          });
          // The upload response's url is server-RELATIVE (the backend prefixes
          // publicURL only when configured). Stored raw, the mask would load
          // against the frontend origin and 404 in dev, and the engine then
          // draws the image unmasked - removal "succeeds" with no visible
          // effect. Resolve it like every other insertion flow does.
          maskUrl = resolveAssetUrl(asset.url);
        } catch {
          // Upload failed: keep the inline mask rather than losing the work.
        }
      }
      useEditor.getState().setImageAlphaMask(id, maskUrl, mask.width, mask.height);
      setBgState("idle");
    } catch (err) {
      setBgState("error");
      setBgError(userMessage(err, tr("editor.background_removal_failed")));
    }
  };

  const tabCls = (on: boolean) =>
    `flex-1 rounded-md py-1 text-xs font-medium transition ${on ? "bg-surface text-neutral-800 shadow-sm" : "text-neutral-500 hover:text-neutral-700"}`;

  return (
    <Section title={tr("editor.image_effects")} order={ORDER.type}>
      <div className="flex gap-0.5 rounded-lg bg-neutral-100 p-0.5">
        <button onClick={() => setTab("filters")} aria-pressed={tab === "filters"} className={tabCls(tab === "filters")}>{tr("editor.filters")}</button>
        <button onClick={() => setTab("adjust")} aria-pressed={tab === "adjust"} className={tabCls(tab === "adjust")}>{tr("editor.adjust")}</button>
        <button onClick={() => setTab("effects")} aria-pressed={tab === "effects"} className={tabCls(tab === "effects")}>{tr("editor.effects")}</button>
      </div>

      {tab === "filters" && (
        <div className="flex flex-col gap-2.5">
          <div className="grid grid-cols-3 gap-1.5">
            {filterPresets.map((p) => (
              <button
                key={p.id}
                onClick={() => applyPreset(p.id, intensity)}
                className={`rounded-lg border py-2 text-[11px] font-medium transition ${activePreset === p.id ? "border-brand-300 bg-brand-50 text-brand-ink" : "border-neutral-200 bg-surface text-neutral-600 hover:bg-neutral-50"}`}
              >
                {p.name}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-xs">
            <span className="w-16 shrink-0 text-neutral-500">{tr("editor.intensity")}</span>
            <input
              type="range" min={0} max={1} step={0.01} value={intensity}
              onChange={(e) => { const k = Number(e.target.value); setIntensity(k); applyPreset(activePreset, k); }}
              className="flex-1"
            />
          </label>
          <button
            onClick={() => useEditor.getState().setEffects(id, autoEnhanceWith(effects) as never)}
            className="rounded-lg bg-brand-600 py-1.5 text-xs font-semibold text-white transition hover:bg-brand-700"
          >
            {tr("editor.auto_enhance")}
          </button>
        </div>
      )}

      {tab === "adjust" && (
        <div className="flex flex-col gap-3">
          {adjustGroups().map((g) => (
            <div key={g.group} className="flex flex-col gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">{g.group}</span>
              {g.sliders.map((s) => (
                <label key={s.name} className="flex items-center gap-2 text-xs">
                  <span className="w-16 shrink-0 text-neutral-500">{s.label}</span>
                  <input
                    type="range" min={s.min} max={s.max} step={s.step ?? 0.01} value={val(s.name, s.def)}
                    onPointerDown={beginDrag}
                    onChange={(e) => setOp(s.name, Number(e.target.value))}
                    onPointerUp={endDrag}
                    onDoubleClick={() => { beginDrag(); setOp(s.name, s.def); endDrag(); }}
                    title={tr("editor.double_click_to_reset")} aria-label={tr("editor.double_click_to_reset")}
                    className="flex-1"
                  />
                </label>
              ))}
            </div>
          ))}
        </div>
      )}

      {tab === "effects" && (
        <div className="flex flex-col gap-3">
          {/* Duotone control */}
          <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-neutral-700">{tr("editor.duotone")}</span>
              <Toggle checked={!!duo} ariaLabel={tr("editor.duotone")} onChange={(on) => (on ? setDuotone({}) : removeDuotone())} />
            </div>
            {duo && (
              <>
                <div className="flex items-center gap-2 text-xs">
                  <span className="w-16 shrink-0 text-neutral-500">{tr("editor.shadows")}</span>
                  <input type="color" value={colorHex(duo.shadows)} aria-label={tr("editor.shadows")} onChange={(e) => setDuotone({ shadows: colorFromHex(e.target.value) })} className="oc-color h-8 w-9 shrink-0" />
                  <span className="w-16 shrink-0 text-neutral-500">{tr("editor.lights")}</span>
                  <input type="color" value={colorHex(duo.highlights)} aria-label={tr("editor.lights")} onChange={(e) => setDuotone({ highlights: colorFromHex(e.target.value) })} className="oc-color h-8 w-9 shrink-0" />
                </div>
                <label className="flex items-center gap-2 text-xs">
                  <span className="w-16 shrink-0 text-neutral-500">{tr("editor.intensity")}</span>
                  <input type="range" min={0} max={1} step={0.01} value={duo.intensity} onChange={(e) => setDuotone({ intensity: Number(e.target.value) })} className="flex-1" />
                </label>
              </>
            )}
          </div>

          {/* Background remover (free, in-browser) */}
          <div className="flex flex-col gap-1.5 rounded-lg border border-neutral-200 p-2.5">
            <span className="text-xs font-medium text-neutral-700">{tr("editor.remove_background")}</span>
            <button
              onClick={runBgRemoval}
              disabled={bgState === "working" || refining}
              className="rounded-lg bg-neutral-100 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-200 disabled:opacity-50"
            >
              {bgState === "working" ? `Processing ${Math.round(bgProgress * 100)}%` : tr("editor.remove_background")}
            </button>
            <p className="text-[10px] leading-snug text-neutral-400">
              {tr("editor.runs_in_your_browser_the_model_downloads_on")}
            </p>
            {bgState === "error" && bgError && <p className="text-[11px] text-red-600">{bgError}</p>}
            {/* Brush refinement of the result (or of a mask painted from
                scratch): a canvas overlay tool, since it needs pointer events
                on the design surface, not a panel control. Locked images are
                refused at entry; the brush's commits would silently no-op on
                them, which reads as strokes vanishing on exit. */}
            <button
              onClick={() => useEditor.getState().setMaskRefining(refining ? null : id)}
              disabled={bgState === "working" || !!node.locked}
              className="rounded-lg bg-neutral-100 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-200 disabled:opacity-50"
            >
              {refining ? tr("editor.done") : tr("editor.refine_edges")}
            </button>
          </div>

          {/* Active effects stack: toggle/remove each entry */}
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">{tr("editor.active_effects")}</span>
            {effects.length === 0 ? (
              <p className="text-[11px] text-neutral-400">{tr("editor.no_effects_yet")}</p>
            ) : (
              effects.map((e, i) => (
                <div key={`${e.kind}-${i}`} className="flex items-center justify-between rounded-lg bg-neutral-50 px-2.5 py-1.5">
                  <span className="text-xs text-neutral-700">{effectLabel(e)}</span>
                  <button
                    onClick={() => removeEffect(i)}
                    title={tr("editor.remove")}
                    className="rounded px-1.5 text-xs font-medium text-neutral-400 transition hover:bg-neutral-200 hover:text-neutral-700"
                  >
                    {tr("editor.remove")}
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </Section>
  );
}

/** Auto-enhance: merge a sensible adjustment bundle into the effects stack. */
function autoEnhanceWith(effects: Effect[]): Effect[] | undefined {
  const rest = effects.filter((e) => e.kind !== "adjustment");
  const next: Effect[] = [...rest, { kind: "adjustment", ops: autoEnhanceOps() }];
  return next.length ? next : undefined;
}
// Live data binding for a chart or table (F27 FR): bind to pasted CSV/TSV or a
// remote CSV URL, then refresh on demand to re-apply the parsed data.
function DataBindingControls({ node }: { node: Node }) {
  const id = node.id;
  const toast = useToast();
  const binding = (node as { binding?: DataBinding }).binding;
  const [open, setOpen] = useState(!!binding);
  const [csv, setCsv] = useState(binding?.kind === "inline" ? binding.csv ?? "" : "");
  const [url, setUrl] = useState(binding?.kind === "url" ? binding.url ?? "" : "");
  const [busy, setBusy] = useState(false);
  const store = () => useEditor.getState();
  const applyResult = (label: string) => (ok: boolean) => { setBusy(false); if (ok) toast.success(label); else toast.error(tr("editor.could_not_load_the_data")); };
  const useCsv = () => {
    if (!csv.trim()) return;
    store().setDataBinding(id, { kind: "inline", csv, hasHeaderRow: true });
    setBusy(true);
    void store().refreshBinding(id).then(applyResult(tr("editor.data_applied")));
  };
  const fetchUrl = () => {
    if (!url.trim()) return;
    store().setDataBinding(id, { kind: "url", url: url.trim(), hasHeaderRow: true });
    setBusy(true);
    void store().refreshBinding(id).then(applyResult(tr("editor.data_fetched")));
  };
  const refresh = () => { setBusy(true); void store().refreshBinding(id).then(applyResult(tr("editor.refreshed"))); };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="rounded-md border border-neutral-200 px-2 py-1 text-[11px] font-medium text-neutral-700 transition hover:bg-neutral-50">
        {tr("editor.bind_live_data")}
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-neutral-200 p-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-neutral-600">{tr("editor.data_source")}</span>
        {binding ? <button onClick={() => store().setDataBinding(id, undefined)} className="text-[10px] text-neutral-400 hover:text-rose-600">{tr("editor.unbind")}</button> : <button onClick={() => setOpen(false)} className="text-[10px] text-neutral-400 hover:text-neutral-700">{tr("editor.cancel")}</button>}
      </div>
      <textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={3} placeholder={tr("editor.paste_csv_or_tsv_placeholder")} className="w-full resize-y rounded-md border border-neutral-200 px-2 py-1 font-mono text-[11px] outline-none focus:border-brand-400" />
      <button onClick={useCsv} disabled={!csv.trim() || busy} className="rounded-md border border-neutral-200 px-2 py-1 text-[11px] font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-40">{tr("editor.use_csv")}</button>
      <div className="text-center text-[10px] text-neutral-400">{tr("editor.or_a_remote_csv_url")}</div>
      <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/data.csv" className={`${inputCls} text-[11px]`} />
      <div className="flex gap-1.5">
        <button onClick={fetchUrl} disabled={!url.trim() || busy} className="flex-1 rounded-md border border-neutral-200 px-2 py-1 text-[11px] font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-40">{tr("editor.fetch_url")}</button>
        {binding?.kind === "url" && <button onClick={refresh} disabled={busy} className="rounded-md border border-neutral-200 px-2 py-1 text-[11px] font-medium text-brand-ink hover:bg-brand-50 disabled:opacity-40">{tr("editor.refresh")}</button>}
      </div>
    </div>
  );
}

// Conditional-formatting editor for a table (F27): highlight rules, color
// scales, and data bars, each scoped to a column or the whole data area. The
// engine derives per-cell styling from the rule + the cell's numeric value.
function TableConditional({ id, table }: { id: string; table: TableNode }) {
  const rules = table.conditional ?? [];
  const apply = (next: TableConditionalRule[]) => useEditor.getState().setTableConditional(id, next);
  const setRule = (i: number, r: TableConditionalRule) => apply(rules.map((x, j) => (j === i ? r : x)));
  const colOptions = [tr("editor.all_columns"), ...Array.from({ length: table.cols }, (_, c) => `Col ${c + 1}`)];
  const add = (kind: TableConditionalRule["kind"]) => {
    const r: TableConditionalRule =
      kind === "highlight" ? { kind: "highlight", op: ">", value: 0, fill: solidFromHex("#fee2e2"), textColor: colorFromHex("#b91c1c") }
        : kind === "colorScale" ? { kind: "colorScale", min: colorFromHex("#fee2e2"), max: colorFromHex("#bbf7d0") }
          : { kind: "dataBar", color: colorFromHex("#93c5fd") };
    apply([...rules, r]);
  };
  const cls = "flex-1 rounded-md border border-neutral-200 px-2 py-1 text-[11px] text-neutral-700 transition hover:bg-neutral-50";
  return (
    <div className="flex flex-col gap-2 border-t border-neutral-100 pt-3.5">
      <Heading>{tr("editor.conditional_formatting")}</Heading>
      {rules.map((r, i) => (
        <div key={i} className="flex flex-col gap-1.5 rounded-lg border border-neutral-200 p-2">
          <div className="flex items-center gap-1.5">
            <span className="flex-1 text-[11px] font-medium text-neutral-600">{r.kind === "colorScale" ? tr("editor.color_scale") : r.kind === "dataBar" ? tr("editor.data_bar") : tr("editor.highlight")}</span>
            <select aria-label={tr("editor.column")} value={r.column ?? -1} onChange={(e) => { const v = Number(e.target.value); setRule(i, { ...r, column: v < 0 ? undefined : v }); }} className={`${selectCls} w-24 py-1 text-[11px]`}>
              {colOptions.map((label, idx) => <option key={idx} value={idx === 0 ? -1 : idx - 1}>{label}</option>)}
            </select>
            <button onClick={() => apply(rules.filter((_, j) => j !== i))} className="grid h-6 w-6 place-items-center rounded text-neutral-400 transition hover:bg-neutral-100 hover:text-rose-600" title={tr("editor.remove_rule")}>×</button>
          </div>
          {r.kind === "highlight" && (
            <div className="flex items-center gap-1.5">
              <select aria-label={tr("editor.comparison_operator")} value={r.op} onChange={(e) => setRule(i, { ...r, op: e.target.value as typeof r.op })} className={`${selectCls} w-14 py-1 text-[11px]`}>
                {([">", "<", ">=", "<=", "==", "!="] as const).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
              <input type="number" value={r.value} onChange={(e) => setRule(i, { ...r, value: Number(e.target.value) })} className={`${inputCls} w-16 py-1 text-[11px]`} />
              <div className="w-7"><ColorField value={r.fill?.type === "solid" ? r.fill.color : colorFromHex("#fee2e2")} onChange={(c) => setRule(i, { ...r, fill: { type: "solid", color: c } })} title={tr("editor.cell_fill")} /></div>
              <div className="w-7"><ColorField value={r.textColor ?? colorFromHex("#b91c1c")} onChange={(c) => setRule(i, { ...r, textColor: c })} title={tr("editor.text_color")} /></div>
            </div>
          )}
          {r.kind === "colorScale" && (
            <div className="flex items-center gap-1.5 text-[11px] text-neutral-500">
              <span>{tr("editor.min")}</span><div className="w-7"><ColorField value={r.min} onChange={(c) => setRule(i, { ...r, min: c })} title={tr("editor.min_color")} /></div>
              <span>{tr("editor.max")}</span><div className="w-7"><ColorField value={r.max} onChange={(c) => setRule(i, { ...r, max: c })} title={tr("editor.max_color")} /></div>
            </div>
          )}
          {r.kind === "dataBar" && (
            <div className="flex items-center gap-1.5 text-[11px] text-neutral-500">
              <span>{tr("editor.bar")}</span><div className="w-7"><ColorField value={r.color} onChange={(c) => setRule(i, { ...r, color: c })} title={tr("editor.bar_color")} /></div>
            </div>
          )}
        </div>
      ))}
      <div className="flex gap-1.5">
        <button onClick={() => add("highlight")} className={cls}>+ Highlight</button>
        <button onClick={() => add("colorScale")} className={cls}>+ Scale</button>
        <button onClick={() => add("dataBar")} className={cls}>+ Bar</button>
      </div>
    </div>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">{children}</div>
  );
}

/** A titled property group. Delegates to the shared collapsible card so every
 *  property group looks and behaves like the other editor panels. Property
 *  groups default open since users expect to see properties immediately.
 *
 *  `order` floats the most relevant groups to the top for the current selection
 *  (the panel is a flex column): type-specific groups get a low order so a text
 *  element shows its text controls first, an image its image controls, etc.,
 *  with the shared groups (fill, position, arrange, appearance, ...) below. */
function Section({ title, badge, order, dim, defaultOpen = true, children }: { title: string; badge?: string | number; order?: number; dim?: boolean; defaultOpen?: boolean; children: React.ReactNode }) {
  return (
    <CollapsibleSection title={title} badge={badge} order={order} dim={dim} defaultOpen={defaultOpen}>
      {children}
    </CollapsibleSection>
  );
}

// Flex `order` buckets for the property groups. Lower = higher in the panel.
// The selection's type-specific group leads; shared groups follow.
const ORDER = {
  type: 1, // type-specific group (text / image / shape / chart / table / ...)
  fill: 2,
  style: 3,
  position: 4,
  arrange: 5,
  appearance: 6,
  interactivity: 7, // animate / motion / interaction
  accessibility: 8, // alt text / decorative (doc 28 FR-29)
} as const;

/** A small "locked by brand" hint shown above a constrained picker (FR-4). */
function BrandLockHint() {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-700">
      <Lock size={11} /> {tr("editor.locked_to_brand")}
    </span>
  );
}

/** A pill switch, replacing native checkboxes. `ariaLabel` names the switch for
 *  assistive technology when the adjacent row text is not programmatically
 *  associated (the common layout here is a sibling span, not a label). */
function Toggle({ checked, onChange, disabled, ariaLabel }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; ariaLabel?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-40 ${checked ? "bg-brand-600" : "bg-neutral-300"}`}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-surface shadow-sm transition-all ${checked ? "start-[18px]" : "start-0.5"}`} />
    </button>
  );
}

/** Square icon button used in the align/order/flip clusters. */
function IconBtn({ icon: Icon, title, onClick, active = false, disabled = false }: { icon: IconType; title: string; onClick: () => void; active?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={`grid h-8 flex-1 place-items-center rounded-lg border transition disabled:opacity-30 ${
        active ? "border-brand-300 bg-brand-50 text-brand-ink" : "border-transparent bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
      }`}
    >
      <Icon size={15} strokeWidth={2} />
    </button>
  );
}

/** A color swatch button (palette / preset). */
function Swatch({ color, onClick, title }: { color: string; onClick: () => void; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? color}
      style={{ background: color }}
      className="h-6 w-6 rounded-md border border-black/10 transition hover:scale-110"
    />
  );
}

type EffectItem = { kind: string; type?: "drop" | "inner"; color?: Color; offsetX?: number; offsetY?: number; blur?: number; width?: number; radius?: number; spread?: number };

/** Per-effect level controls for the active named text effect. Slider drags
 *  live-preview via previewTextEffects and land as ONE undo step on release
 *  (commitTextEffects); switching presets stays setTextEffect's job, so a mere
 *  parameter tweak never strips a legacy node.effects stack. */
function TextEffectControls({ id, fx }: { id: string; fx: TextEffect }) {
  const before = useRef<unknown>(null);
  const st = () => useEditor.getState();
  const liveList = () => ((locate(st().doc, id)?.node as unknown as { textEffects?: TextEffect[] })?.textEffects ?? []);
  const snapshot = () => { before.current = structuredClone(liveList().length ? liveList() : null); };
  const preview = (patch: object) => st().previewTextEffects(id, liveList().map((e) => (e.kind === fx.kind ? ({ ...e, ...patch } as TextEffect) : e)));
  const commit = () => st().commitTextEffects(id, before.current);
  // Discrete color pick = one undo step: snapshot, apply, commit in one go.
  const pickColor = (hex: string) => { snapshot(); preview({ color: solidFromHex(hex) }); commit(); };
  const fxHex = (f?: { type: string; color?: Color }) => (f?.type === "solid" && f.color ? colorHex(f.color) : "#000000");
  const colorRow = (color?: { type: string; color?: Color }) => (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-[11px] text-neutral-400">{tr("editor.color")}</span>
      <input type="color" value={fxHex(color)} aria-label={tr("editor.color")} onChange={(e) => pickColor(e.target.value)} className="oc-color h-8 w-9 shrink-0" />
    </div>
  );
  const slider = (label: string, min: number, max: number, value: number, patch: (n: number) => object, opts: { step?: number; fmt?: (n: number) => string } = {}) => (
    <FxSlider label={label} min={min} max={max} step={opts.step} value={value} fmt={opts.fmt} onStart={snapshot} onCommit={commit} onChange={(n) => preview(patch(n))} />
  );
  const pct = (n: number) => `${n}%`;
  switch (fx.kind) {
    case "shadow": return (<>
      {slider("X", -50, 50, Math.round(fx.dx), (n) => ({ dx: n }))}
      {slider("Y", -50, 50, Math.round(fx.dy), (n) => ({ dy: n }))}
      {slider(tr("editor.blur"), 0, 40, Math.round(fx.blur), (n) => ({ blur: n }))}
      {slider(tr("editor.opacity"), 0, 100, Math.round(fx.opacity * 100), (n) => ({ opacity: n / 100 }), { fmt: pct })}
      {colorRow(fx.color)}
    </>);
    case "lift": return slider(tr("editor.intensity"), 10, 100, Math.round(fx.intensity * 100), (n) => ({ intensity: n / 100 }), { fmt: pct });
    case "hollow": return slider(tr("editor.thickness"), 0.5, 8, fx.thickness, (n) => ({ thickness: n }), { step: 0.5 });
    case "splice": return (<>
      {slider(tr("editor.thickness"), 0.5, 8, fx.thickness, (n) => ({ thickness: n }), { step: 0.5 })}
      {slider(tr("editor.offset"), 0, 30, Math.round(fx.offset), (n) => ({ offset: n }))}
      {colorRow(fx.color)}
    </>);
    case "echo": return (<>
      {slider(tr("editor.offset"), 1, 30, Math.round(fx.offset), (n) => ({ offset: n }))}
      {slider(tr("editor.copies"), 2, 6, Math.round(fx.count), (n) => ({ count: n }))}
      {colorRow(fx.color)}
    </>);
    case "glow": return (<>
      {slider(tr("editor.size"), 0, 60, Math.round(fx.radius), (n) => ({ radius: n }))}
      {slider(tr("editor.intensity"), 20, 200, Math.round(fx.intensity * 100), (n) => ({ intensity: n / 100 }), { fmt: pct })}
      {colorRow(fx.color)}
    </>);
    case "neon": return (<>
      {slider(tr("editor.intensity"), 20, 200, Math.round(fx.intensity * 100), (n) => ({ intensity: n / 100 }), { fmt: pct })}
      {colorRow(fx.color)}
    </>);
    case "outline": return (<>
      {slider(tr("editor.width"), 0.5, 12, fx.width, (n) => ({ width: n }), { step: 0.5 })}
      {colorRow(fx.color)}
    </>);
    default: return null;
  }
}

/** Round/Padding levels for the text background highlight, previewed live and
 *  committed as one undo step per gesture. */
function TextHighlightLevels({ id, hl }: { id: string; hl: { padding?: number; radius?: number } }) {
  const before = useRef<unknown>(null);
  const st = () => useEditor.getState();
  const liveList = () => ((locate(st().doc, id)?.node as unknown as { textEffects?: TextEffect[] })?.textEffects ?? []);
  const snapshot = () => { before.current = structuredClone(liveList().length ? liveList() : null); };
  const preview = (patch: object) => st().previewTextEffects(id, liveList().map((e) => (e.kind === "highlight" ? ({ ...e, ...patch } as TextEffect) : e)));
  const commit = () => st().commitTextEffects(id, before.current);
  return (<>
    <FxSlider label={tr("editor.round")} min={0} max={40} value={Math.round(hl.radius ?? 8)} onStart={snapshot} onCommit={commit} onChange={(n) => preview({ radius: n })} />
    <FxSlider label={tr("editor.padding")} min={0} max={40} value={Math.round(hl.padding ?? 8)} onStart={snapshot} onCommit={commit} onChange={(n) => preview({ padding: n })} />
  </>);
}

/** Labeled slider row for effect parameters: the drag-to-feel control every
 *  effect level needs. onChange fires per tick for a live no-undo preview;
 *  onStart/onCommit bracket the gesture so one drag lands as one undo step
 *  (same contract as the image adjust sliders' beginDrag/commitEffects). */
function FxSlider({ label, min, max, step = 1, value, onChange, onStart, onCommit, fmt }: { label: string; min: number; max: number; step?: number; value: number; onChange: (n: number) => void; onStart?: () => void; onCommit?: () => void; fmt?: (n: number) => string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-[11px] text-neutral-400">{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerDown={onStart} onPointerUp={onCommit}
        onKeyDown={(e) => { if (!e.repeat) onStart?.(); }} onKeyUp={onCommit} onBlur={onCommit}
        className="flex-1 accent-brand-600"
      />
      <span className="w-9 shrink-0 text-end text-[11px] tabular-nums text-neutral-500">{fmt ? fmt(value) : value}</span>
    </div>
  );
}

/**
 * Reusable Effects control: one-click presets (shadow/lift/hollow/splice/glow/
 * neon) plus manual shadow/outline/glow toggles with parameter fields. Writes to
 * the node's `effects` array, which the engine renders for text, shapes, lines,
 * frames, and images alike (render2d effects filter + outline specs).
 */
/**
 * Object-level effects: the `NodeBase.effects` stack.
 *
 * Note this never renders for a TEXT node. The enclosing section derives its
 * node from `rep`, and `rep` falls back to the stroke selection when the type
 * is in `SKIP` (which lists text, image, and group); for a lone text node that
 * is empty, so the section returns null before reaching here. Text gets its
 * own effects surface instead. Worth knowing before adding a text-specific
 * branch to this component: it would be unreachable.
 */
function NodeEffects({ id, effects }: { id: string; effects?: readonly { kind: string }[] }) {
  const eff = (effects ?? []) as EffectItem[];
  const find = (k: string) => eff.find((e) => e.kind === k);
  const setAll = (next: EffectItem[]) => useEditor.getState().setEffects(id, (next.length ? next : undefined) as never);
  // First match only. These controls patch "the" effect of a kind, which was
  // unambiguous while the panel capped a node at one of each. The stack allows
  // two blurs, and a kind-wide patch would then drive both from one slider.
  const patchFirst = (list: EffectItem[], k: string, patch: Partial<EffectItem>) => {
    const at = list.findIndex((e) => e.kind === k);
    if (at < 0) return list;
    const next = [...list];
    next[at] = { ...next[at], ...patch };
    return next;
  };
  const update = (k: string, patch: Partial<EffectItem>) => setAll(patchFirst(eff, k, patch));
  // Slider gestures: live no-undo preview per tick, one undo step on release
  // (same contract as the image adjust sliders).
  const dragBefore = useRef<unknown>(null);
  const snapshot = () => { dragBefore.current = structuredClone(locate(useEditor.getState().doc, id)?.node.effects ?? null); };
  const commit = () => useEditor.getState().commitEffects(id, dragBefore.current);
  const previewUpdate = (k: string, patch: Partial<EffectItem>) => {
    const live = ((locate(useEditor.getState().doc, id)?.node as unknown as { effects?: EffectItem[] })?.effects ?? []);
    useEditor.getState().previewEffects(id, patchFirst(live, k, patch) as never);
  };
  // Recoloring keeps the color's alpha: the Opacity slider owns it, and a
  // swatch change must not silently reset a 35% shadow to full strength.
  const colorLabels: Record<string, string> = {
    shadow: tr("editor.shadow_color"),
    outline: tr("editor.outline_color"),
    glow: tr("editor.glow_color"),
  };
  const colorInput = (k: string, c?: Color) => (
    <input type="color" value={c ? colorHex(c) : "#000000"} aria-label={colorLabels[k] ?? tr("editor.color")} onChange={(e) => update(k, { color: { srgb: { ...colorFromHex(e.target.value).srgb, a: c?.srgb.a ?? 1 } } })} className="oc-color h-8 w-9 shrink-0" />
  );
  const sh = find("shadow");
  const ol = find("outline");
  const gl = find("glow");
  const bl = find("blur");
  const presets: { id: string; label: string; build: () => EffectItem[] }[] = [
    { id: "none", label: tr("editor.none"), build: () => [] },
    { id: "shadow", label: tr("editor.shadow"), build: () => [{ kind: "shadow", type: "drop", color: { srgb: { r: 0, g: 0, b: 0, a: 0.35 } }, offsetX: 0, offsetY: 4, blur: 6, spread: 0 }] },
    { id: "lift", label: tr("editor.lift"), build: () => [{ kind: "shadow", type: "drop", color: { srgb: { r: 0, g: 0, b: 0, a: 0.28 } }, offsetX: 0, offsetY: 10, blur: 24, spread: 0 }] },
    { id: "hollow", label: tr("editor.hollow"), build: () => [{ kind: "outline", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } }, width: 2 }] },
    { id: "splice", label: tr("editor.splice"), build: () => [{ kind: "outline", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } }, width: 2 }, { kind: "shadow", type: "drop", color: { srgb: { r: 0, g: 0, b: 0, a: 0.4 } }, offsetX: 4, offsetY: 4, blur: 0, spread: 0 }] },
    { id: "glow", label: tr("editor.glow"), build: () => [{ kind: "glow", color: { srgb: { r: 0.45, g: 0.5, b: 1, a: 0.9 } }, radius: 12 }] },
    { id: "neon", label: tr("editor.neon"), build: () => [{ kind: "glow", color: { srgb: { r: 0.2, g: 0.9, b: 1, a: 0.95 } }, radius: 16 }, { kind: "outline", color: { srgb: { r: 0.2, g: 0.9, b: 1, a: 1 } }, width: 1.5 }] },
  ];
  const kindsOf = (es: { kind: string }[]) => es.map((e) => e.kind).sort().join(",");
  const activePreset = presets.find((p) => kindsOf(p.build()) === kindsOf(eff))?.id;
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">{tr("editor.effects")}</span>
      <div className="grid grid-cols-4 gap-1">
        {presets.map((p) => (
          <button
            key={p.id}
            onClick={() => setAll(p.build())}
            className={`rounded-lg py-1.5 text-[11px] font-medium transition ${activePreset === p.id ? "bg-brand-600 text-white" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"}`}
          >{p.label}</button>
        ))}
      </div>
      {/* One group, not three. The presets above are whole looks; this is the
          stack those looks are made of, so what is applied and how you add to
          it belong under a single heading.

          The per-kind toggle row that used to sit here (Shadow / Outline /
          Glow / Blur) is gone. It was a relic of the panel capping a node at
          one effect per kind, and once the stack lists what is applied with a
          visibility toggle and a delete, the row was a third control doing the
          same job as the two above it: "Shadow" appeared three times on screen,
          twice meaning subtly different things. */}
      <span className="mt-1 text-[10px] uppercase tracking-wide text-neutral-400">{tr("editor.fine_tune")}</span>
      {eff.length > 0 && (
        <>
          <EffectStack id={id} effects={eff as unknown as Effect[]} />
          <p className="text-[10px] leading-snug text-neutral-500">{tr("editor.effect_stack_order_hint")}</p>
        </>
      )}
      <AddEffectRow id={id} />
      {sh && (
        <>
          <div className="flex items-center gap-2">
            {colorInput("shadow", sh.color)}
            <Field key={`shx${sh.offsetX}`} label="X" value={sh.offsetX ?? 0} onCommit={(n) => update("shadow", { offsetX: n })} />
            <Field key={`shy${sh.offsetY}`} label="Y" value={sh.offsetY ?? 0} onCommit={(n) => update("shadow", { offsetY: n })} />
          </div>
          <FxSlider label={tr("editor.blur")} min={0} max={60} value={Math.round(sh.blur ?? 0)} onStart={snapshot} onCommit={commit} onChange={(n) => previewUpdate("shadow", { blur: n })} />
          <FxSlider label={tr("editor.opacity")} min={0} max={100} value={Math.round(((sh.color?.srgb.a ?? 1) as number) * 100)} fmt={(n) => `${n}%`} onStart={snapshot} onCommit={commit}
            onChange={(n) => sh.color && previewUpdate("shadow", { color: { ...sh.color, srgb: { ...sh.color.srgb, a: n / 100 } } })} />
        </>
      )}
      {ol && (
        <div className="flex items-center gap-2">
          {colorInput("outline", ol.color)}
          <Field key={`olw${ol.width}`} label="W" value={ol.width ?? 1} onCommit={(n) => update("outline", { width: Math.max(0.5, n) })} />
        </div>
      )}
      {gl && (
        <>
          <div className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-[11px] text-neutral-400">{tr("editor.color")}</span>
            {colorInput("glow", gl.color)}
          </div>
          <FxSlider label={tr("editor.size")} min={0} max={60} value={Math.round(gl.radius ?? 0)} onStart={snapshot} onCommit={commit} onChange={(n) => previewUpdate("glow", { radius: n })} />
          <FxSlider label={tr("editor.opacity")} min={0} max={100} value={Math.round(((gl.color?.srgb.a ?? 1) as number) * 100)} fmt={(n) => `${n}%`} onStart={snapshot} onCommit={commit}
            onChange={(n) => gl.color && previewUpdate("glow", { color: { ...gl.color, srgb: { ...gl.color.srgb, a: n / 100 } } })} />
        </>
      )}
      {bl && (
        <FxSlider label={tr("editor.amount")} min={0} max={40} value={Math.round(bl.radius ?? 0)} onStart={snapshot} onCommit={commit} onChange={(n) => previewUpdate("blur", { radius: n })} />
      )}
    </div>
  );
}
