// Brand guide draft (#53, #54): the editable shape the Brands wizard and the
// brand edit page work on, and its conversion to and from a stored BrandKit.
//
// A draft edits the parts of a kit people set up by hand (name, the first
// palette, heading/body/accent fonts, logos with their variants and sizing,
// voice, and controls). Everything else on a kit stays exactly as stored:
// extra palettes, other font roles, a font's default style, a swatch's name
// and exact color value, and collections. draftToPatch only sends what the
// draft owns and rebuilds those arrays from the stored objects, so saving a
// kit edited here never drops data another surface wrote.

import type { BrandControls, BrandFont, BrandKit, BrandKitPatch, BrandLogo, BrandPalette, BrandSwatch } from "@hc/sdk";
import type { Color } from "@hc/schema";
import { contrastRatio, extractPalette, hslToRgb, rgbToHsl, toHex, type Bitmap } from "@hc/color";

export interface DraftColor {
  /** The stored swatch id, or a fresh one for a new color. */
  id: string;
  hex: string;
  role: string;
}

export interface BrandDraft {
  name: string;
  /** What the brand is, in a sentence or two. Grounds AI suggestions only;
   *  a kit has no description field, so it is never saved. */
  description: string;
  colors: DraftColor[];
  headingFont: string;
  bodyFont: string;
  accentFont: string;
  logos: BrandLogo[];
  voice: { tone: string[]; doSay: string[]; dontSay: string[]; sampleCopy: string };
  controls: BrandControls;
  isDefault: boolean;
}

/** The controls a fresh kit starts with on the server: nothing locked, and
 *  the pre-export check warns without blocking. */
export function defaultControls(): BrandControls {
  return { lockColors: false, lockFonts: false, restrictTemplates: false, lintPolicy: "warn" };
}

export const colorRoles = ["primary", "secondary", "accent", "neutral", "background", "text"] as const;

export function emptyDraft(): BrandDraft {
  return {
    name: "",
    description: "",
    colors: [],
    headingFont: "",
    bodyFont: "",
    accentFont: "",
    logos: [],
    voice: { tone: [], doSay: [], dontSay: [], sampleCopy: "" },
    controls: defaultControls(),
    isDefault: false,
  };
}

const newId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

/** sRGB Color -> #rrggbb (alpha dropped). */
export function colorToHex(c: Color): string {
  const ch = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${ch(c.srgb.r)}${ch(c.srgb.g)}${ch(c.srgb.b)}`;
}

/** #rgb / #rrggbb -> an opaque sRGB Color. */
export function hexToColor(hex: string): Color {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6), 16);
  const v = Number.isNaN(n) ? 0 : n;
  return { srgb: { r: ((v >> 16) & 255) / 255, g: ((v >> 8) & 255) / 255, b: (v & 255) / 255, a: 1 } };
}

export function isHex(s: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(s.trim());
}

/** Default roles for colors in rank order: the first two lead, the rest accent. */
export function rankedRole(i: number): string {
  return i === 0 ? "primary" : i === 1 ? "secondary" : "accent";
}

/** Draft colors from ranked hexes, de-duplicated, keeping any already there. */
export function colorsFromHexes(hexes: string[], existing: DraftColor[] = []): DraftColor[] {
  const have = new Set(existing.map((c) => c.hex.toLowerCase()));
  const out = [...existing];
  for (const raw of hexes) {
    const hex = raw.trim().toLowerCase();
    if (!isHex(hex) || have.has(hex)) continue;
    have.add(hex);
    out.push({ id: newId("s"), hex, role: rankedRole(out.length) });
  }
  return out;
}

const WHITE: Color = { srgb: { r: 1, g: 1, b: 1, a: 1 } };
const BLACK: Color = { srgb: { r: 0, g: 0, b: 0, a: 1 } };

/** Round out colors drafted from a logo or a website with the neutrals a
 *  brand needs for text: a dark text color and a light background. A color
 *  already in the list that is dark (or light) enough takes the role when it
 *  only had the generic accent role; otherwise a neutral tinted toward the
 *  primary color's hue is added. Both meet WCAG AAA (7:1) against white or
 *  black respectively. Roles the user set are never changed. */
export function withNeutrals(colors: DraftColor[]): DraftColor[] {
  const valid = colors.filter((c) => isHex(c.hex));
  const out = colors.map((c) => ({ ...c }));
  const hue = valid.length ? rgbToHsl(hexToColor(valid[0].hex)).h : 0;
  const ensure = (role: "text" | "background", fits: (c: Color) => boolean, make: () => Color) => {
    if (out.some((c) => c.role === role)) return;
    const found = out.find((c) => isHex(c.hex) && c.role === "accent" && fits(hexToColor(c.hex)));
    if (found) { found.role = role; return; }
    const hex = toHex(make()).toLowerCase();
    if (!out.some((c) => c.hex.toLowerCase() === hex)) out.push({ id: newId("s"), hex, role });
  };
  ensure("text", (c) => contrastRatio(c, WHITE) >= 12, () => hslToRgb({ h: hue, s: 0.25, l: 0.11, a: 1 }));
  ensure("background", (c) => contrastRatio(c, BLACK) >= 18, () => hslToRgb({ h: hue, s: 0.3, l: 0.97, a: 1 }));
  return out;
}

export interface ContrastPair {
  fg: DraftColor;
  bg: DraftColor;
  ratio: number;
}

/** The kit's color pairs that are readable as body text (WCAG AA, 4.5:1),
 *  best first, the lighter color of each pair taken as the background. */
export function contrastPairs(colors: DraftColor[], max = 6): ContrastPair[] {
  const valid = colors.filter((c) => isHex(c.hex));
  const pairs: ContrastPair[] = [];
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const a = hexToColor(valid[i].hex);
      const b = hexToColor(valid[j].hex);
      if (valid[i].hex.toLowerCase() === valid[j].hex.toLowerCase()) continue;
      const ratio = contrastRatio(a, b);
      if (ratio < 4.5) continue;
      const aLighter = contrastRatio(a, BLACK) >= contrastRatio(b, BLACK);
      pairs.push({ fg: aLighter ? valid[j] : valid[i], bg: aLighter ? valid[i] : valid[j], ratio });
    }
  }
  return pairs.sort((x, y) => y.ratio - x.ratio).slice(0, max);
}

const fontOf = (kit: BrandKit, role: string) => kit.fonts.find((f) => f.role === role)?.fontFamily ?? "";

export function kitToDraft(kit: BrandKit): BrandDraft {
  const first = kit.palettes[0];
  return {
    name: kit.name,
    description: "",
    colors: (first?.colors ?? []).map((s) => ({ id: s.id, hex: colorToHex(s.value), role: s.role })),
    headingFont: fontOf(kit, "heading"),
    bodyFont: fontOf(kit, "body"),
    accentFont: fontOf(kit, "accent"),
    logos: kit.logos.map((l) => ({ ...l })),
    voice: {
      tone: [...(kit.voice?.tone ?? [])],
      doSay: [...(kit.voice?.doSay ?? [])],
      dontSay: [...(kit.voice?.dontSay ?? [])],
      sampleCopy: kit.voice?.sampleCopy ?? "",
    },
    controls: { ...defaultControls(), ...kit.controls },
    isDefault: kit.isDefault,
  };
}

/** The draft's first palette, reusing each stored swatch (its name and exact
 *  value) wherever the color itself is unchanged. */
function draftPalette(d: BrandDraft, base: BrandKit | null, paletteName: string): BrandPalette {
  const stored = base?.palettes[0];
  const byId = new Map<string, BrandSwatch>((stored?.colors ?? []).map((s) => [s.id, s]));
  const colors: BrandSwatch[] = d.colors.map((c) => {
    const prev = byId.get(c.id);
    if (prev && colorToHex(prev.value).toLowerCase() === c.hex.toLowerCase()) return { ...prev, role: c.role };
    return { ...(prev ?? {}), id: c.id, role: c.role, value: hexToColor(c.hex) };
  });
  return stored ? { ...stored, colors } : { id: newId("p"), name: paletteName, colors };
}

/** Upsert the three draft roles into the stored fonts: an existing role keeps
 *  its id and default style, an emptied role is removed, other roles stay. */
function draftFonts(d: BrandDraft, base: BrandKit | null): BrandFont[] {
  const want: Record<string, string> = { heading: d.headingFont.trim(), body: d.bodyFont.trim(), accent: d.accentFont.trim() };
  const out: BrandFont[] = [];
  const seen = new Set<string>();
  for (const f of base?.fonts ?? []) {
    if (!(f.role in want)) { out.push(f); continue; }
    if (seen.has(f.role)) continue;
    seen.add(f.role);
    const fam = want[f.role];
    if (!fam) continue;
    out.push(fam === f.fontFamily ? f : { ...f, fontFamily: fam, fontAssetId: null });
  }
  for (const role of ["heading", "body", "accent"]) {
    if (!seen.has(role) && want[role]) out.push({ id: newId("f"), role, fontFamily: want[role] });
  }
  return out;
}

/** The patch that writes a draft onto `base` (or onto a fresh kit when null).
 *  `paletteName` names a palette the kit did not have yet. */
export function draftToPatch(d: BrandDraft, base: BrandKit | null, paletteName: string): BrandKitPatch {
  const palettes = d.colors.length || base?.palettes.length
    ? [draftPalette(d, base, paletteName), ...(base?.palettes.slice(1) ?? [])]
    : [];
  const v = d.voice;
  const hasVoice = v.tone.length + v.doSay.length + v.dontSay.length > 0 || !!v.sampleCopy.trim();
  const voice = hasVoice || base?.voice
    ? { ...(base?.voice ?? {}), tone: v.tone, doSay: v.doSay, dontSay: v.dontSay, sampleCopy: v.sampleCopy.trim() || undefined }
    : null;
  return {
    name: d.name.trim().slice(0, 80) || base?.name,
    palettes,
    fonts: draftFonts(d, base),
    logos: d.logos,
    voice: hasVoice || base?.voice ? voice : null,
    controls: { ...d.controls },
  };
}

/** A copy of a kit's contents for "Duplicate": every array the kit carries,
 *  with nothing shared by reference. */
export function duplicatePatch(kit: BrandKit): BrandKitPatch {
  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  return {
    palettes: clone(kit.palettes),
    fonts: clone(kit.fonts),
    logos: clone(kit.logos),
    voice: kit.voice ? clone(kit.voice) : null,
    collections: clone(kit.collections),
    controls: clone(kit.controls),
  };
}

/** Whether a draft has enough to save: a name. Everything else is optional. */
export function draftIsSavable(d: BrandDraft): boolean {
  return d.name.trim().length > 0;
}

// --- logo image helpers (browser only) --------------------------------------

export async function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const el = new Image();
    el.crossOrigin = "anonymous";
    el.onload = () => res(el);
    el.onerror = () => rej(new Error("image decode failed"));
    el.src = src;
  });
}

export function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
}

function drawScaled(img: HTMLImageElement, maxSide: number): CanvasRenderingContext2D | null {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) return null;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return ctx;
}

/** The logo's dominant colors, most dominant first (deterministic, no AI). */
export function logoPalette(img: HTMLImageElement, count = 6): string[] {
  const ctx = drawScaled(img, 128);
  if (!ctx) return [];
  const bmp: Bitmap = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
  return [...new Set(extractPalette(bmp, count).map(toHex).map((h) => h.toLowerCase()))];
}

/** A small PNG data URL of the logo for a provider that can read images. */
export function logoPreviewDataUrl(img: HTMLImageElement, maxSide = 512): string | null {
  const ctx = drawScaled(img, maxSide);
  return ctx ? ctx.canvas.toDataURL("image/png") : null;
}

/** A one-color version of a logo with a transparent background (white, for
 *  dark grounds). Null when the logo has no real transparency, since filling
 *  an opaque rectangle would just produce a solid box. */
export async function monochromeLogo(img: HTMLImageElement, color = "#ffffff"): Promise<Blob | null> {
  const ctx = drawScaled(img, 1024);
  if (!ctx) return null;
  const { width, height } = ctx.canvas;
  const data = ctx.getImageData(0, 0, width, height);
  let clear = 0;
  for (let i = 3; i < data.data.length; i += 4) if (data.data[i] < 16) clear++;
  if (clear / (width * height) < 0.1) return null;
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  return new Promise((res) => ctx.canvas.toBlob((b) => res(b), "image/png"));
}
