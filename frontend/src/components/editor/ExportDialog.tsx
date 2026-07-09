// Download panel, Canva-style. SVG export uses the pure @hc/export
// serializer; PNG/JPG render the engine scene to a real canvas and download via
// toBlob (the client-side fast path); PDF embeds rendered pages via jsPDF. The
// worker/skia path and animated formats remain deferred.

import { useEffect, useMemo, useRef, useState } from "react";
import { compileAttribution, attributionText } from "@hc/stock";
import { AlertTriangle, ShieldAlert, ChevronDown, Check, Image as ImageIcon, FileText, Shapes, Download } from "lucide-react";
import { toSvg, rasterDimensions, encodeApng, encodeGif, designPageToLottie } from "@hc/export";
import { zipFiles, type ZipEntry } from "@/lib/zip";
import type { BrandLintResult } from "@hc/sdk";
import {
  createScene,
  renderScene,
  poseDesignAt,
  pageAnimationDuration,
  planDeckFrames,
  renderTransition,
  morphPlan,
  morphDesignAt,
  type CanvasLike,
  type Viewport,
  type DeckFrame,
} from "@hc/engine";
import { useEditor } from "@/store/editor";
import { useBrand } from "@/store/brand";
import { imageAssets } from "@/lib/assetProvider";
import { oc } from "@/lib/sdk";
import { useToast } from "@/components/ui/Toast";

type Format = "png" | "jpg" | "pdf" | "svg" | "apng" | "gif" | "lottie";

const FORMATS: { value: Format; label: string; suffix: string; desc: string; icon: typeof ImageIcon; badge?: string }[] = [
  { value: "png", label: "PNG", suffix: "png", desc: "High quality, supports transparency", icon: ImageIcon, badge: "Recommended" },
  { value: "jpg", label: "JPG", suffix: "jpg", desc: "Small file size, best for photos", icon: ImageIcon },
  { value: "pdf", label: "PDF", suffix: "pdf", desc: "Best for documents and printing", icon: FileText },
  { value: "svg", label: "SVG", suffix: "svg", desc: "Editable vector graphic", icon: Shapes },
  { value: "apng", label: "Animated PNG", suffix: "apng", desc: "Plays the deck (or page) with transitions, lossless", icon: ImageIcon },
  { value: "gif", label: "Animated GIF", suffix: "gif", desc: "Plays the deck (or page) with transitions, widely supported", icon: ImageIcon },
  { value: "lottie", label: "Lottie", suffix: "json", desc: "Vector animation JSON (lottie-web, After Effects)", icon: Shapes },
];

/** Render one page to an offscreen canvas at `scale`. Fills white when opaque
 *  (jpg / PDF / non-transparent png); leaves alpha otherwise. */
function renderPageCanvas(doc: import("@hc/schema").DesignFile, index: number, scale: number, opaque: boolean): HTMLCanvasElement | null {
  const pg = doc.pages[index];
  if (!pg) return null;
  const w = Math.max(1, Math.round(pg.width * scale));
  const h = Math.max(1, Math.round(pg.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  if (opaque) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
  }
  const vp: Viewport = { zoom: scale, panX: 0, panY: 0, dpr: 1, width: w, height: h };
  // For a transparent export the page's own background fill must be skipped too,
  // not just the white canvas prefill, or the PNG comes out opaque.
  renderScene(createScene(doc, index), ctx as unknown as CanvasLike, vp, { assets: imageAssets, skipBackground: !opaque });
  return canvas;
}

/**
 * Render one planned deck frame (doc 28 FR-19): either a posed slide or a
 * transition composite between two slides, drawn through the same pure
 * `@hc/engine` compositor present mode and the web player use, so an exported
 * deck animates exactly as it presents.
 */
function renderDeckFrame(
  doc: import("@hc/schema").DesignFile,
  frame: DeckFrame,
  scale: number,
  opaque: boolean,
): HTMLCanvasElement | null {
  if (frame.kind === "slide") {
    return renderPageCanvas(poseDesignAt(doc, frame.pageIndex, frame.tMs), frame.pageIndex, scale, opaque);
  }
  // A transition composite: pose both slides, then blend them.
  const { fromIndex, toIndex, transition, progress, toTMs } = frame;
  const pg = doc.pages[toIndex];
  if (!pg) return null;
  const w = Math.max(1, Math.round(pg.width * scale));
  const h = Math.max(1, Math.round(pg.height * scale));
  const dest = document.createElement("canvas");
  dest.width = w;
  dest.height = h;
  const ctx = dest.getContext("2d");
  if (!ctx) return null;

  // Magic Move: hide the shared elements in both buffers so the compositor
  // cross-fades only the non-shared content; the tweened layer is drawn on top.
  const fromPosed = poseDesignAt(doc, fromIndex, Number.MAX_SAFE_INTEGER); // leaving slide, settled
  const toPosed = poseDesignAt(doc, toIndex, toTMs); // arriving slide, entering
  const morph = transition.type === "morph" ? morphPlan(fromPosed, fromIndex, toPosed, toIndex) : null;
  if (morph) {
    for (const n of morph.fromNodes.values()) (n as { hidden?: boolean }).hidden = true;
    for (const n of morph.toNodes.values()) (n as { hidden?: boolean }).hidden = true;
  }
  const bufA = renderPageCanvas(fromPosed, fromIndex, scale, opaque);
  const bufB = renderPageCanvas(toPosed, toIndex, scale, opaque);
  if (!bufA || !bufB) return null;

  renderTransition(ctx as unknown as CanvasLike, transition, {
    from: bufA,
    to: bufB,
    width: w,
    height: h,
    progress,
    background: opaque ? "#ffffff" : "transparent",
  });

  if (morph && morph.ids.length) {
    // `morphDesignAt` reads the (hidden) shared nodes it planned, so unhiding
    // first would not change the tween; render the tweened layer as planned.
    const tweened = morphDesignAt(morph, toPosed, toIndex, progress);
    for (const n of tweened.pages[toIndex].children) (n as { hidden?: boolean }).hidden = false;
    const vp: Viewport = { zoom: scale, panX: 0, panY: 0, dpr: 1, width: w, height: h };
    try {
      renderScene(createScene(tweened, toIndex), ctx as unknown as CanvasLike, vp, {
        assets: imageAssets,
        skipBackground: true,
      });
    } catch {
      /* a cross-origin image can throw; keep the composited frame */
    }
  }
  return dest;
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SIZE_STEPS = [0.5, 1, 2, 3] as const;

export function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const activePage = useEditor((s) => s.activePage);
  // Editor rev drives a debounced gate re-fetch so fixing violations in the
  // Brand panel while this dialog is open keeps the block/warn state current.
  const rev = useEditor((s) => s.rev);
  const designId = useBrand((s) => s.designId);
  // Credits compiled from node provenance (attribution-required stock assets,
  // e.g. CC-BY emoji): shown with a copy button so publishing stays compliant.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const credits = useMemo(() => (open ? compileAttribution(useEditor.getState().doc) : []), [open, rev]);
  const [format, setFormat] = useState<Format>("png");
  const [scale, setScale] = useState(1);
  const [transparent, setTransparent] = useState(true);
  const [quality, setQuality] = useState(92); // jpg quality 0..100
  const [zipBatch, setZipBatch] = useState(true); // bundle multi-page non-PDF exports into one .zip
  const [selected, setSelected] = useState<number[]>([]); // page indices to export
  const [formatOpen, setFormatOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Brand pre-export gate. 'block' policy with violations refuses
  // the export; 'warn' shows a dismissible warning; 'off' is invisible.
  const [gate, setGate] = useState<BrandLintResult | null>(null);
  const [warnDismissed, setWarnDismissed] = useState(false);
  const formatRef = useRef<HTMLDivElement>(null);

  const doc = useEditor.getState().doc;
  const pageCount = doc.pages.length;

  // Default the page selection when the panel opens or the format changes.
  // Animated formats on a multi-page deck default to the WHOLE deck, so the
  // export plays the presentation through with its transitions (doc 28 FR-19);
  // everything else defaults to the current page. Narrowing to one page is
  // still a deliberate click. Deferred out of the effect body (Promise
  // microtask) to avoid a synchronous setState-in-effect, matching the gate
  // effects below.
  const animatedDeck = (format === "apng" || format === "gif") && pageCount > 1;
  // Keyed on `open` + whether the animated-deck default applies, so choosing a
  // format re-defaults the selection but a later manual narrow (Current / a
  // page toggle) sticks: this effect does not re-run on `selected`.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setSelected(animatedDeck ? Array.from({ length: pageCount }, (_, i) => i) : [Math.min(activePage, pageCount - 1)]);
    });
    return () => { cancelled = true; };
  }, [open, activePage, pageCount, animatedDeck]);

  // Close the format dropdown on outside click / Escape.
  useEffect(() => {
    if (!formatOpen) return;
    const onDown = (e: MouseEvent) => { if (formatRef.current && !formatRef.current.contains(e.target as Node)) setFormatOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFormatOpen(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [formatOpen]);

  // Run the gate when the panel opens for a saved design. All state updates run
  // inside the async flow (Promise callbacks) so the effect body stays clean.
  useEffect(() => {
    let cancelled = false;
    if (!open || !designId) {
      void Promise.resolve().then(() => { if (!cancelled) setGate(null); });
      return () => { cancelled = true; };
    }
    void Promise.resolve()
      .then(() => { if (!cancelled) setWarnDismissed(false); })
      .then(() => oc.brandLintGate(designId))
      .then((r) => { if (!cancelled) setGate(r); })
      .catch(() => { if (!cancelled) setGate(null); });
    return () => { cancelled = true; };
  }, [open, designId]);

  // Re-fetch the gate (debounced) when the design changes while the panel is
  // open, so resolving violations in the Brand panel updates block/warn here.
  useEffect(() => {
    let cancelled = false;
    if (!open || !designId) return;
    const t = setTimeout(() => {
      void oc.brandLintGate(designId)
        .then((r) => { if (!cancelled) setGate(r); })
        .catch(() => {});
    }, 600);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev]);

  if (!open) return null;

  const gateActive = !!gate && gate.policy !== "off" && gate.violations.length > 0;
  const blocked = !!gate && gate.blocked; // policy 'block' with violations
  const showWarn = gateActive && gate!.policy === "warn" && !warnDismissed;

  const fmt = FORMATS.find((f) => f.value === format)!;
  const isRaster = format === "png" || format === "jpg";
  // Animated/vector-anim formats export a single file of the active page only.
  const isSingleAnimated = format === "apng" || format === "gif" || format === "lottie";
  const sizable = format !== "svg" && format !== "lottie"; // resolution-independent
  // The page(s) that will actually be exported, sorted; PDF always uses all
  // selected, raster/svg emit one file per selected page.
  const pages = selected.length ? [...selected].sort((a, b) => a - b) : [Math.min(activePage, pageCount - 1)];
  // Live pixel dimensions for the first exported page (Canva shows this).
  const refPage = doc.pages[pages[0]] ?? doc.pages[0];
  const dim = rasterDimensions(refPage, { scale }, doc.dpi ?? 96);
  const fileCount = format === "pdf" || isSingleAnimated ? 1 : pages.length;

  function togglePage(i: number) {
    setSelected((prev) => (prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i]));
  }

  /**
   * Frames for an animated export (doc 28 FR-19). A multi-page deck with no
   * narrowed page selection exports its whole playthrough, transitions
   * included, through the pure `@hc/engine` planner; otherwise it stays a
   * single page's own animation timeline (the shipped behavior). Reduced
   * motion drops transitions, matching the reduced-motion present path.
   */
  function deckPlan(): DeckFrame[] {
    const fps = 15;
    // More than one page in play means "play the deck through"; exactly one
    // selected page means "export just that page's own animation".
    const wholeDeck = pageCount > 1 && pages.length > 1;
    if (wholeDeck) {
      const reducedMotion =
        typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
      return planDeckFrames(doc, { fps, reducedMotion, maxFrames: 900, pageIndices: pages });
    }
    const idx = pages[0] ?? Math.min(activePage, pageCount - 1);
    const dur = pageAnimationDuration(doc, idx) || 3000;
    const frameCount = Math.max(2, Math.min(150, Math.round((dur / 1000) * fps) + 1));
    const delayMs = Math.round(1000 / fps);
    return Array.from({ length: frameCount }, (_, i) => ({
      kind: "slide" as const,
      pageIndex: idx,
      tMs: (i / (frameCount - 1)) * dur,
      delayMs,
    }));
  }

  async function run() {
    // Re-check the gate at the moment of download so a stale block never lets an
    // off-brand export through.
    if (designId) {
      try {
        const fresh = await oc.brandLintGate(designId);
        setGate(fresh);
        if (fresh.blocked) { toast.error("Resolve the brand violations before downloading."); return; }
      } catch { /* best effort; fall through to local gate */ }
    }
    if (blocked) return;
    setBusy(true);
    try {
      const safeBase = (doc.title || "design").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "design";
      const nameFor = (i: number, suffix: string) => (fileCount > 1 ? `${safeBase}-${i + 1}.${suffix}` : `${safeBase}.${suffix}`);

      if (format === "pdf") {
        const { jsPDF } = await import("jspdf");
        let pdf: import("jspdf").jsPDF | undefined;
        for (const i of pages) {
          const canvas = renderPageCanvas(doc, i, scale, true);
          const pg = doc.pages[i];
          if (!canvas || !pg) continue;
          const w = Math.round(pg.width);
          const h = Math.round(pg.height);
          const orient = w >= h ? "landscape" : "portrait";
          if (!pdf) pdf = new jsPDF({ unit: "pt", format: [w, h], orientation: orient });
          else pdf.addPage([w, h], orient);
          pdf.addImage(canvas.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, w, h);
        }
        if (pdf) pdf.save(`${safeBase}.pdf`);
        toast.success(`Downloaded ${safeBase}.pdf`);
      } else if (format === "apng") {
        // Animated PNG. A multi-page deck exports its whole playthrough,
        // transitions included, via the pure deck planner + compositor (doc 28
        // FR-19); a single page exports its own animation timeline as before.
        const plan = deckPlan();
        const frames: { png: Uint8Array; delayMs: number }[] = [];
        for (const f of plan) {
          const canvas = renderDeckFrame(doc, f, scale, !transparent);
          if (!canvas) continue;
          const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, "image/png"));
          if (blob) frames.push({ png: new Uint8Array(await blob.arrayBuffer()), delayMs: f.delayMs });
        }
        if (frames.length < 2) {
          toast.error("Nothing to animate. Add an animation or a slide transition, or add a page.");
        } else {
          download(new Blob([encodeApng(frames, { loops: 0 }) as BlobPart], { type: "image/apng" }), `${safeBase}.apng`);
          toast.success(`Downloaded ${safeBase}.apng (${frames.length} frames)`);
        }
      } else if (format === "gif") {
        // Animated GIF: same deck plan as APNG (whole playthrough with
        // transitions for a deck, one page's timeline otherwise), but we grab
        // raw RGBA per frame and quantize to a shared palette in @hc/export.
        const plan = deckPlan();
        let gw = 0;
        let gh = 0;
        const frames: { rgba: Uint8Array; delayMs: number }[] = [];
        for (const f of plan) {
          const canvas = renderDeckFrame(doc, f, scale, !transparent);
          if (!canvas) continue;
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          gw = canvas.width;
          gh = canvas.height;
          const img = ctx.getImageData(0, 0, gw, gh);
          frames.push({ rgba: new Uint8Array(img.data.buffer.slice(0)), delayMs: f.delayMs });
        }
        if (frames.length < 2 || !gw || !gh) {
          toast.error("Nothing to animate. Add an animation or a slide transition, or add a page.");
        } else {
          const gif = encodeGif(frames, { width: gw, height: gh, loops: 0, transparentAlpha: transparent ? 128 : 0 });
          download(new Blob([gif as BlobPart], { type: "image/gif" }), `${safeBase}.gif`);
          toast.success(`Downloaded ${safeBase}.gif (${frames.length} frames)`);
        }
      } else if (format === "lottie") {
        // Vector Lottie JSON of the active page (transforms baked to keyframes).
        const idx = pages[0] ?? Math.min(activePage, pageCount - 1);
        const lottie = designPageToLottie(doc, idx, { fps: 30 });
        download(new Blob([JSON.stringify(lottie)], { type: "application/json" }), `${safeBase}.json`);
        toast.success(`Downloaded ${safeBase}.json (Lottie)`);
      } else {
        // svg / png / jpg: one rendered file per page. With >1 page and the zip
        // option on, bundle them into a single .zip (batch export, FR); otherwise
        // download each file separately.
        const opaque = format === "jpg" || !transparent;
        const useZip = pages.length > 1 && zipBatch;
        const entries: ZipEntry[] = [];
        const renderBlob = async (i: number): Promise<Blob | null> => {
          if (format === "svg") return new Blob([toSvg(doc, i)], { type: "image/svg+xml" });
          const canvas = renderPageCanvas(doc, i, scale, opaque);
          if (!canvas) return null;
          const type = format === "png" ? "image/png" : "image/jpeg";
          return new Promise((res) => canvas.toBlob(res, type, format === "jpg" ? quality / 100 : undefined));
        };
        for (let k = 0; k < pages.length; k++) {
          const blob = await renderBlob(pages[k]);
          if (!blob) continue;
          if (useZip) {
            entries.push({ name: `${safeBase}-${pages[k] + 1}.${fmt.suffix}`, data: new Uint8Array(await blob.arrayBuffer()) });
          } else {
            download(blob, nameFor(pages[k], fmt.suffix));
            if (k < pages.length - 1) await sleep(250);
          }
        }
        if (useZip) {
          download(zipFiles(entries), `${safeBase}.zip`);
          toast.success(`Downloaded ${safeBase}.zip (${entries.length} ${fmt.label} pages)`);
        } else {
          toast.success(fileCount > 1 ? `Downloaded ${fileCount} ${fmt.label} files` : `Downloaded ${safeBase}.${fmt.suffix}`);
        }
      }
      onClose();
    } catch {
      toast.error("Download failed - an image from another site may have blocked it. Try uploading that image, or download as SVG.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* Click-away backdrop (transparent; the panel is anchored top-right like Canva). */}
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        role="dialog"
        aria-label="Download"
        className="fixed right-3 top-14 z-50 max-h-[calc(100vh-5rem)] w-[22rem] overflow-y-auto rounded-2xl border border-neutral-200 bg-surface p-4 shadow-2xl ring-1 ring-black/5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-base font-semibold text-neutral-900">Download</h2>

        {/* File type: rich dropdown (icon + name + description + recommended badge). */}
        <div className="relative mb-3" ref={formatRef}>
          <label className="mb-1 block text-xs font-medium text-neutral-500">File type</label>
          <button
            type="button"
            aria-haspopup="listbox"
            aria-expanded={formatOpen}
            onClick={() => setFormatOpen((v) => !v)}
            className="flex w-full items-center gap-2.5 rounded-xl border border-neutral-300 px-3 py-2.5 text-left hover:border-neutral-400"
          >
            <fmt.icon size={18} className="shrink-0 text-neutral-500" />
            <span className="flex-1">
              <span className="block text-sm font-medium text-neutral-800">{fmt.label}</span>
              <span className="block text-[11px] text-neutral-400">{fmt.desc}</span>
            </span>
            <ChevronDown size={16} className={`shrink-0 text-neutral-400 transition-transform ${formatOpen ? "rotate-180" : ""}`} />
          </button>
          {formatOpen && (
            <ul role="listbox" className="absolute z-10 mt-1 w-full overflow-hidden rounded-xl border border-neutral-200 bg-surface p-1 shadow-xl ring-1 ring-black/5">
              {FORMATS.map((f) => (
                <li key={f.value} role="option" aria-selected={f.value === format}>
                  <button
                    type="button"
                    onClick={() => { setFormat(f.value); setFormatOpen(false); }}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-neutral-50 ${f.value === format ? "bg-brand-50" : ""}`}
                  >
                    <f.icon size={18} className="shrink-0 text-neutral-500" />
                    <span className="flex-1">
                      <span className="flex items-center gap-1.5 text-sm font-medium text-neutral-800">
                        {f.label}
                        {f.badge && <span className="rounded-full bg-brand-100 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-brand-ink">{f.badge}</span>}
                      </span>
                      <span className="block text-[11px] text-neutral-400">{f.desc}</span>
                    </span>
                    {f.value === format && <Check size={15} className="shrink-0 text-brand-ink" />}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Size multiplier with live pixel dimensions (raster + pdf). */}
        {sizable && (
          <div className="mb-3">
            <div className="mb-1 flex items-center justify-between">
              <label className="text-xs font-medium text-neutral-500">Size</label>
              <span className="text-[11px] tabular-nums text-neutral-400">{dim.width} × {dim.height} px</span>
            </div>
            <div className="flex gap-1">
              {SIZE_STEPS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setScale(s)}
                  className={`flex-1 rounded-lg py-1.5 text-xs font-medium transition ${scale === s ? "bg-brand-600 text-white" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"}`}
                >
                  {s}×
                </button>
              ))}
            </div>
          </div>
        )}

        {/* JPG quality. */}
        {format === "jpg" && (
          <div className="mb-3">
            <div className="mb-1 flex items-center justify-between">
              <label className="text-xs font-medium text-neutral-500">Quality</label>
              <span className="text-[11px] tabular-nums text-neutral-400">{quality}%</span>
            </div>
            <input type="range" min={40} max={100} step={1} value={quality} onChange={(e) => setQuality(Number(e.target.value))} className="w-full accent-brand-600" />
          </div>
        )}

        {/* PNG transparency. */}
        {format === "png" && (
          <label className="mb-3 flex cursor-pointer items-center justify-between text-sm">
            <span className="text-neutral-600">Transparent background</span>
            <input type="checkbox" checked={transparent} onChange={(e) => setTransparent(e.target.checked)} className="h-4 w-4 accent-brand-600" />
          </label>
        )}

        {/* Batch: bundle multiple pages into one .zip (non-PDF formats). */}
        {format !== "pdf" && pages.length > 1 && (
          <label className="mb-3 flex cursor-pointer items-center justify-between text-sm">
            <span className="text-neutral-600">Combine pages into a .zip</span>
            <input type="checkbox" checked={zipBatch} onChange={(e) => setZipBatch(e.target.checked)} className="h-4 w-4 accent-brand-600" />
          </label>
        )}

        {/* Page selection (multi-page docs only). */}
        {pageCount > 1 && (
          <div className="mb-3">
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-xs font-medium text-neutral-500">Pages ({pages.length}/{pageCount})</label>
              <div className="flex gap-2 text-[11px] font-medium">
                <button type="button" onClick={() => setSelected(doc.pages.map((_, i) => i))} className="text-brand-ink hover:underline">All</button>
                <button type="button" onClick={() => setSelected([Math.min(activePage, pageCount - 1)])} className="text-neutral-500 hover:underline">Current</button>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {doc.pages.map((_, i) => {
                const on = selected.includes(i);
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => togglePage(i)}
                    aria-pressed={on}
                    title={`Page ${i + 1}`}
                    className={`h-7 min-w-7 rounded-md px-2 text-xs font-medium transition ${on ? "bg-brand-600 text-white" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"}`}
                  >
                    {i + 1}
                  </button>
                );
              })}
            </div>
            {!isRaster && format === "pdf" && <p className="mt-1.5 text-[11px] text-neutral-400">Exported as one PDF.</p>}
            {(isRaster || format === "svg") && pages.length > 1 && <p className="mt-1.5 text-[11px] text-neutral-400">{pages.length} separate files.</p>}
          </div>
        )}

        {/* Brand gate. Blocked refuses; warn is dismissible. */}
        {blocked && (
          <div className="mb-3 rounded-xl bg-red-50 p-2.5 text-xs text-red-700">
            <div className="mb-1 flex items-center gap-1.5 font-semibold">
              <ShieldAlert size={14} /> Off-brand: download blocked
            </div>
            <p className="mb-1">{gate!.violations.length} brand violation{gate!.violations.length === 1 ? "" : "s"} must be resolved first.</p>
            <ul className="mb-1 max-h-24 list-disc overflow-y-auto pl-4 text-[11px]">
              {gate!.violations.slice(0, 5).map((v) => (<li key={v.id}>{v.message}</li>))}
            </ul>
            <span className="text-[11px] text-red-600">Review them in the Brand panel.</span>
          </div>
        )}
        {showWarn && (
          <div className="mb-3 rounded-xl bg-amber-50 p-2.5 text-xs text-amber-800">
            <div className="mb-1 flex items-center justify-between">
              <span className="flex items-center gap-1.5 font-semibold"><AlertTriangle size={14} /> Off-brand warning</span>
              <button onClick={() => setWarnDismissed(true)} className="text-[11px] font-medium text-amber-700 hover:underline">Dismiss</button>
            </div>
            <p>{gate!.violations.length} brand violation{gate!.violations.length === 1 ? "" : "s"} found. You can still download.</p>
          </div>
        )}

        {credits.length > 0 && (
          <div className="mb-3 rounded-xl bg-neutral-50 p-2.5 text-xs text-neutral-600">
            <div className="mb-1 flex items-center justify-between">
              <span className="font-semibold">Credits</span>
              <button
                onClick={() => { void navigator.clipboard.writeText(attributionText(credits)); toast.success("Credits copied"); }}
                className="text-[11px] font-medium text-brand-ink hover:underline"
              >
                Copy
              </button>
            </div>
            <ul className="max-h-20 overflow-y-auto">
              {credits.map((c) => (<li key={c.assetId}>{c.attributionText}</li>))}
            </ul>
            <p className="mt-1 text-[11px] text-neutral-400">This design uses assets that require attribution when published.</p>
          </div>
        )}

        <button
          onClick={() => void run()}
          disabled={busy || blocked}
          title={blocked ? "Resolve brand violations to download" : undefined}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-3 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-50"
        >
          <Download size={16} />
          {busy ? "Preparing…" : fileCount > 1 ? `Download ${fileCount} files` : "Download"}
        </button>
      </div>
    </>
  );
}
