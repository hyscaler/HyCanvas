// Color picker field (picker, eyedropper, contrast, CVD, CMYK). A
// swatch-button trigger that opens an HSV popover: saturation/value square, hue
// + alpha sliders, hex/RGB inputs, a CMYK readout with an out-of-gamut badge, a
// color-vision (CVD) simulation preview, an optional WCAG contrast badge (when a
// background color is supplied), plus brand-palette/recent swatches and the
// screen eyedropper. Pure client React; all color math comes from @hc/color.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Color } from "@hc/schema";
import {
  toHex, fromHex, rgbToCmyk, gamutCheck, simulateCvd, wcag, type CvdType,
} from "@hc/color";
import { Pipette } from "lucide-react";
import { tr } from "@/lib/i18n";

type HSV = { h: number; s: number; v: number };

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function rgbToHsv(c: Color): HSV {
  const { r, g, b } = c.srgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

function hsvToColor(h: number, s: number, v: number, a: number): Color {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { srgb: { r: r + m, g: g + m, b: b + m, a } };
}

function rgba(c: Color): string {
  const { r, g, b, a } = c.srgb;
  return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a ?? 1})`;
}

const cvdLabels = (): { v: "" | CvdType; label: string }[] => [
  { v: "", label: "Normal vision" },
  { v: "protanopia", label: tr("editor.protanopia_red_blind") },
  { v: "deuteranopia", label: tr("editor.deuteranopia_green_blind") },
  { v: "tritanopia", label: tr("editor.tritanopia_blue_blind") },
  { v: "achromatopsia", label: tr("editor.achromatopsia_mono") },
];

export interface ColorFieldProps {
  value: Color;
  onChange: (c: Color) => void;
  /** Background color to grade contrast against (shows a WCAG badge). */
  bg?: Color;
  /** Allow editing the alpha channel (default true). */
  allowAlpha?: boolean;
  /** Brand/preset swatches shown as quick picks. */
  palette?: string[];
  /** Recently-used hex swatches. */
  recents?: string[];
  /** Called with the chosen hex so the host can persist a recents list. */
  onRemember?: (hex: string) => void;
  title?: string;
  /** Stretch the trigger to fill its row (default true). */
  block?: boolean;
}

export function ColorField({
  value, onChange, bg, allowAlpha = true, palette, recents, onRemember, title, block = true,
}: ColorFieldProps) {
  const [open, setOpen] = useState(false);
  const [cvd, setCvd] = useState<"" | CvdType>("");
  const wrapRef = useRef<HTMLDivElement>(null);

  // localHue preserves the chosen hue while dragging through grayscale (where
  // the value's hue is undefined). It is updated only in event handlers; when
  // the value is chromatic the hue comes straight from it.
  const { h: valueHue, s, v } = rgbToHsv(value);
  const [localHue, setLocalHue] = useState(valueHue);
  const hue = s > 0.001 && v > 0 ? valueHue : localHue;
  const alpha = value.srgb.a ?? 1;
  const hex = toHex(value).toUpperCase();

  // The popover is fixed-positioned and clamped to the viewport: an absolute
  // popover anchored to the trigger gets clipped by the properties panel's
  // scroll container whenever the trigger sits left of the panel's right edge
  // (the panel is barely wider than the 240px picker). Fixed positioning
  // escapes ancestor overflow clipping for every trigger position.
  const popRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    // Position written imperatively (no state): measuring and placing in the
    // same layout pass avoids a visible jump and re-render loops.
    const place = () => {
      const r = wrapRef.current?.getBoundingClientRect();
      const el = popRef.current;
      if (!r || !el) return;
      const pw = el.offsetWidth || 240;
      const ph = el.offsetHeight || 420;
      const left = Math.min(Math.max(8, r.right - pw), Math.max(8, window.innerWidth - pw - 8));
      let top = r.bottom + 6;
      if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.style.visibility = "visible";
    };
    place();
    // Track ancestor scrolls (capture) and resizes so the popover stays glued
    // to its trigger while the panel scrolls.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const emit = (c: Color) => {
    onChange(c);
    onRemember?.(toHex(c));
  };
  const setHSV = (h: number, ss: number, vv: number) => {
    setLocalHue(h);
    emit(hsvToColor(h, ss, vv, alpha));
  };
  const setAlpha = (a: number) => emit({ srgb: { ...value.srgb, a } });
  const setHex = (raw: string) => {
    const c = fromHex(raw);
    if (c) emit({ srgb: { ...c.srgb, a: allowAlpha ? alpha : 1 } });
  };
  const setChannel = (k: "r" | "g" | "b", n: number) =>
    emit({ srgb: { ...value.srgb, [k]: clamp01(n / 255) } });

  // SV square pointer dragging.
  const svRef = useRef<HTMLDivElement>(null);
  const onSvPointer = (e: React.PointerEvent) => {
    const el = svRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    const move = (clientX: number, clientY: number) => {
      const r = el.getBoundingClientRect();
      const ns = clamp01((clientX - r.left) / r.width);
      const nv = clamp01(1 - (clientY - r.top) / r.height);
      setHSV(hue, ns, nv);
    };
    move(e.clientX, e.clientY);
    const onMove = (ev: PointerEvent) => move(ev.clientX, ev.clientY);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const cmyk = rgbToCmyk(value);
  const inGamut = gamutCheck(value).inGamut;
  const contrast = bg ? wcag(value, bg) : null;
  const preview = cvd ? simulateCvd(value, cvd) : value;

  return (
    <div ref={wrapRef} className={`relative ${block ? "flex-1" : ""}`}>
      <button
        type="button"
        title={title ?? tr("editor.edit_color")}
        onClick={() => setOpen((o) => !o)}
        className={`oc-color-trigger h-8 ${block ? "w-full" : "w-9"} rounded-lg border border-neutral-200`}
        style={{
          backgroundImage:
            `linear-gradient(${rgba(value)}, ${rgba(value)}), ` +
            "linear-gradient(45deg,#ccc 25%,transparent 25%,transparent 75%,#ccc 75%)," +
            "linear-gradient(45deg,#ccc 25%,#fff 25%,#fff 75%,#ccc 75%)",
          backgroundSize: "100% 100%, 10px 10px, 10px 10px",
          backgroundPosition: "0 0, 0 0, 5px 5px",
        }}
      />
      {open && (
        <div
          ref={popRef}
          className="fixed z-50 w-60 max-w-[calc(100vw-2rem)] rounded-xl border border-neutral-200 bg-surface p-3 shadow-xl"
          style={{ left: -9999, top: -9999, visibility: "hidden" }}
        >
          {/* SV square */}
          <div
            ref={svRef}
            onPointerDown={onSvPointer}
            className="relative h-32 w-full cursor-crosshair rounded-lg"
            style={{
              backgroundColor: rgba(hsvToColor(hue, 1, 1, 1)),
              backgroundImage: "linear-gradient(to right,#fff,transparent),linear-gradient(to top,#000,transparent)",
            }}
          >
            <span
              className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
              style={{ left: `${s * 100}%`, top: `${(1 - v) * 100}%` }}
            />
          </div>

          {/* Hue + alpha sliders */}
          <div className="mt-3 flex items-center gap-2">
            <Pipette size={14} className="shrink-0 text-neutral-400" />
            <input
              type="range" min={0} max={360} value={Math.round(hue)} aria-label={tr("editor.hue")}
              onChange={(e) => setHSV(Number(e.target.value), Math.max(s, 0.0001), Math.max(v, 0.0001))}
              className="oc-hue h-3 w-full appearance-none rounded-full"
              style={{ background: "linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)" }}
            />
          </div>
          {allowAlpha && (
            <div className="mt-2 flex items-center gap-2">
              <span className="w-3.5 text-center text-[10px] text-neutral-400">A</span>
              <input
                type="range" min={0} max={100} value={Math.round(alpha * 100)} aria-label={tr("editor.alpha")}
                onChange={(e) => setAlpha(Number(e.target.value) / 100)}
                className="h-3 w-full accent-neutral-500"
              />
              <span className="w-8 text-end font-mono text-[10px] text-neutral-400">{Math.round(alpha * 100)}%</span>
            </div>
          )}

          {/* Hex + RGB + eyedropper */}
          <div className="mt-3 flex items-center gap-1.5">
            <input
              value={hex}
              onChange={(e) => setHex(e.target.value)}
              spellCheck={false}
              className="w-20 rounded-md border border-neutral-200 px-1.5 py-1 font-mono text-[11px] uppercase outline-none focus:border-brand-400"
              aria-label={tr("editor.hex")}
            />
            {(["r", "g", "b"] as const).map((k) => (
              <input
                key={k} type="number" min={0} max={255}
                value={Math.round(value.srgb[k] * 255)}
                onChange={(e) => setChannel(k, Number(e.target.value))}
                className="w-12 rounded-md border border-neutral-200 px-1 py-1 text-center text-[11px] outline-none focus:border-brand-400"
                aria-label={k.toUpperCase()}
              />
            ))}
            <EyeDropperButton onPick={(h) => setHex(h)} />
          </div>

          {/* CMYK soft-proof readout + out-of-gamut badge */}
          <div className="mt-2 flex items-center justify-between text-[10px] text-neutral-500">
            <span className="font-mono">
              CMYK {Math.round(cmyk.c * 100)} {Math.round(cmyk.m * 100)} {Math.round(cmyk.y * 100)} {Math.round(cmyk.k * 100)}
            </span>
            {!inGamut && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-700" title="Outside the CMYK print gamut; will shift in print">
                {tr("editor.out_of_gamut")}
              </span>
            )}
          </div>

          {/* WCAG contrast badge (vs supplied background) */}
          {contrast && (
            <div className="mt-2 flex items-center gap-2 text-[10px]">
              <span className="inline-grid h-5 w-5 place-items-center rounded" style={{ background: rgba(bg!) }}>
                <span style={{ color: rgba(value) }} className="font-bold">A</span>
              </span>
              <span className="font-mono text-neutral-500">{contrast.ratio.toFixed(2)}:1</span>
              <span className={`rounded px-1.5 py-0.5 font-medium ${contrast.aaNormal ? "bg-emerald-100 text-emerald-700" : contrast.aaLarge ? "bg-amber-100 text-amber-700" : "bg-rose-100 text-rose-700"}`}>
                {contrast.aaNormal ? "AA" : contrast.aaLarge ? tr("editor.aa_large") : "fails AA"}
              </span>
            </div>
          )}

          {/* Color-vision (CVD) simulation */}
          <div className="mt-2 flex items-center gap-2">
            <select
              value={cvd}
              onChange={(e) => setCvd(e.target.value as "" | CvdType)}
              className="flex-1 rounded-md border border-neutral-200 px-1.5 py-1 text-[10px] text-neutral-600 outline-none focus:border-brand-400"
              aria-label={tr("editor.color_vision_simulation")}
            >
              {cvdLabels().map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
            </select>
            {cvd && (
              <span className="h-5 w-8 rounded border border-neutral-200" style={{ background: rgba(preview) }} title={tr("editor.how_this_color_appears_with_the_selected_col")} />
            )}
          </div>

          {/* Brand / preset + recent swatches */}
          {(palette?.length || recents?.length) ? (
            <div className="mt-2.5 border-t border-neutral-100 pt-2">
              {palette?.length ? (
                <div className="mb-1 flex flex-wrap gap-1">
                  {palette.map((c) => (
                    <button key={c} title={c} onClick={() => setHex(c)} className="h-5 w-5 rounded border border-neutral-200" style={{ background: c }} />
                  ))}
                </div>
              ) : null}
              {recents?.length ? (
                <div className="flex flex-wrap gap-1">
                  {recents.map((c) => (
                    <button key={c} title={c} onClick={() => setHex(c)} className="h-5 w-5 rounded border border-neutral-200" style={{ background: c }} />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function EyeDropperButton({ onPick }: { onPick: (hex: string) => void }) {
  if (typeof window === "undefined" || !(tr("editor.eyedropper") in window)) return null;
  return (
    <button
      type="button"
      title={tr("editor.pick_a_color_from_the_screen")}
      onClick={async () => {
        try {
          const ed = new (window as unknown as { EyeDropper: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper();
          onPick((await ed.open()).sRGBHex);
        } catch { /* cancelled */ }
      }}
      className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-neutral-200 text-neutral-500 transition hover:bg-neutral-100"
    ><Pipette size={13} /></button>
  );
}
