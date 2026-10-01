// The kit's look: one style resolved for one deck, and everything a layout
// draws from it.
//
// A style (kit/looks.ts) is a complete visual system harvested from one of
// the presentation templates. A look is that style with the deck's own
// voice merged in (its organization, kicker and farewell, the page count)
// and the brand's palette and faces applied when the workspace has a kit.
// The rules every layout follows are here as functions: the type roles
// (display, body, strong, eyebrow, meta, numeral, kicker), the two grounds
// and the gradient of the deep one, the halo that lights a drawing, the
// sparkle scattered where no text sits, the look's ornament on each ground,
// the chrome of a reading page and the footer that makes the pages one deck.

import { fromHex, toHex, fixToAA, contrastRatio, rgbToHsl, hslToRgb } from "@hc/color";
import type { DeckLogo } from "../designSystem";
import { KIT_STYLES, kitStyleNames } from "./looks";
import { PACK_DRAWINGS, PACK_KEYWORDS, PACK_PEEPS } from "./packset";
import { decor, ellipse, logo, rect, text, type Prim, type ShapePrim, type TextPrim } from "./spec";

export const W = 1920;
export const H = 1080;
export const M = 96;
export const CW = W - 2 * M;

export type KitOrnament = "rules" | "glow" | "hairlines" | "blocks" | "blobs" | "crosshairs" | "watermark" | "sun" | "ridges" | "arcs" | "dots" | "stripes" | "orbs" | "corner";

/** Every colour a look needs on one of its two grounds. */
export interface KitPalette {
  bg: string;
  bg2?: string;
  ink: string;
  muted: string;
  line: string;
  panel: string;
  panel2: string;
  accent: string;
  accent2: string;
  /** The accent for text on this ground, when the accent itself is too
   *  bright to read small. */
  accentInk?: string;
  accent2Ink?: string;
  sun?: string;
  lime?: string;
}

export interface KitStyle {
  name: string;
  from: string;
  hint: string;
  display: string; dw: number;
  body: string; bw: number;
  mono: string | null;
  accentFace: string; accentWeight: number; accentSize: number;
  paper: KitPalette;
  deep: KitPalette;
  radius: number;
  ornament: KitOrnament;
  scale: { cover: number; title: number; section: number; statement: number; numeral: number; quote: number };
  art: { cover: string; section: string; picture: string; closing: string };
  peeps: string[];
  charWidth?: number;
  numeralFace?: string;
  numeralWeight?: number;
  strongWeight?: number;
  watermark?: string;
}

/** A style with the deck's voice merged in. */
export interface KitLook extends KitStyle {
  /** The organization the deck comes from: the mark and the footer. */
  company: string;
  /** The deck's short name for the footer. */
  deck: string;
  kicker: string;
  farewell: string;
  total: number;
  logo?: DeckLogo | null;
}

// --- colour --------------------------------------------------------------------

export function mixHex(a: string, b: string, t: number): string {
  const pa = a.replace("#", ""), pb = b.replace("#", "");
  const ch = (i: number) => Math.round(parseInt(pa.slice(i, i + 2), 16) * (1 - t) + parseInt(pb.slice(i, i + 2), 16) * t);
  return "#" + [0, 2, 4].map((i) => ch(i).toString(16).padStart(2, "0")).join("");
}

/** Relative luminance below a mid grey. */
export function isDark(hex: string): boolean {
  const h = hex.replace("#", "");
  const c = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return 0.2126 * c(0) + 0.7152 * c(2) + 0.0722 * c(4) < 0.4;
}

/** The ink that reads on a fill: the look's light ink on a dark fill, its
 *  dark ink on a light one. */
export const inkOn = (K: KitLook, fill: string): string => {
  const light = isDark(K.deep.ink) ? K.paper.ink : K.deep.ink;
  const dark = isDark(K.paper.ink) ? K.paper.ink : (K.deep.bg2 ?? K.deep.bg);
  return isDark(fill) ? light : dark;
};

/** A brand colour darkened until it can carry light copy across the deep
 *  gradient (its darker end included): a mid-tone primary is a fine accent
 *  and an unreadable ground. */
function toDeepGround(hex: string): string {
  const white = fromHex("#FFFFFF")!;
  let out = hex;
  for (let i = 0; i < 12; i++) {
    const c = fromHex(out);
    if (c && contrastRatio(white, c) >= 6) break;
    out = mixHex(out, "#000000", 0.12);
  }
  return out;
}

/** A hex pushed to a contrast against a ground, keeping its hue. */
function toContrast(hex: string, ground: string, target: number): string {
  const fg = fromHex(hex), bg = fromHex(ground);
  if (!fg || !bg) return hex;
  if (contrastRatio(fg, bg) >= target) return hex;
  return toHex(fixToAA(fg, bg, target)).toUpperCase();
}

// --- resolving a look ----------------------------------------------------------

/** The four house styles of the classic composer, as families of kit
 *  styles, so a dial set to "editorial" still lands in a serif system. */
const FAMILIES: Record<string, string[]> = {
  editorial: ["folio", "parchment", "wine", "burgundy", "linen", "casebook", "ledger", "opera", "gala"],
  bold: ["pulse", "coral", "ember", "marker", "acid", "graphite", "blush", "sunny"],
  technical: ["vanta", "terminal", "signal", "cobalt", "marigold", "violet", "mint"],
  classic: ["atlas", "slate", "terra", "sky", "copper", "brass", "harbor", "concrete", "campfire"],
};

export interface ResolveStyleOptions {
  /** The style the outline named. */
  style?: string;
  /** A dial or an API field naming one of the classic composer's looks. */
  look?: unknown;
  /** A seed for the fallback pick; the deck title hashed. */
  seed?: number;
  /** The deck's mood phrase and title, matched against the styles' hints
   *  when the outline named no style. */
  mood?: string;
}

const MOOD_STOP = new Set(["a", "an", "the", "and", "or", "for", "of", "to", "in", "on", "with", "one", "paper", "ink", "deep", "ground", "display", "sans", "serif", "face", "hand", "kicker", "corner", "dot", "grid", "decks", "deck", "dark", "light", "warm", "cool", "modern", "clean", "bold"]);

const tokens = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !MOOD_STOP.has(w));

/** The style whose hint shares the most words with the deck's mood and
 *  title, or null when none shares any: a brief about an offsite lands on
 *  the campfire, one about a launch on the ember, without the model having
 *  named either. */
export function styleForMood(mood: string, pool: string[] = kitStyleNames): KitStyle | null {
  const words = new Set(tokens(mood));
  if (!words.size) return null;
  let best: KitStyle | null = null;
  let bestScore = 0;
  for (const name of pool) {
    const style = KIT_STYLES[name];
    let score = 0;
    for (const w of new Set(tokens(style.hint))) if (words.has(w)) score += 1;
    if (score > bestScore) { bestScore = score; best = style; }
  }
  return best;
}

/** The style a deck is set in: the one the outline named when the
 *  vocabulary has it, else the one its mood and title point at within the
 *  family a dial named, else one by seed, so two decks with different
 *  titles never default to the same one. */
export function resolveKitStyle(opts: ResolveStyleOptions): KitStyle {
  const named = (opts.style ?? "").trim().toLowerCase();
  if (named && KIT_STYLES[named]) return KIT_STYLES[named];
  const seed = Math.abs(opts.seed ?? 0);
  const family = typeof opts.look === "string" ? FAMILIES[opts.look] : undefined;
  const pool = family ?? kitStyleNames;
  if (opts.mood) {
    const matched = styleForMood(opts.mood, pool);
    if (matched) return matched;
  }
  return KIT_STYLES[pool[seed % pool.length]];
}

/** The six slots (primary, accent, deep, tint, ink, paper) of a theme
 *  record, by swatch name where the record names them and by position when
 *  it carries at least six, else null: a template's theme repaints the kit
 *  the way a chosen catalog theme does. */
export function slotsFromThemeRecord(rec: { colors?: Array<{ name?: string; color?: { srgb: { r: number; g: number; b: number } } }> }): string[] | null {
  const colors = rec.colors ?? [];
  const hex = (c: { srgb: { r: number; g: number; b: number } }) => "#" + [c.srgb.r, c.srgb.g, c.srgb.b].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
  const names = ["primary", "accent", "deep", "tint", "ink", "paper"];
  const byName = names.map((n) => colors.find((c) => c.name === n)?.color);
  if (byName.every((c) => !!c)) return byName.map((c) => hex(c!));
  if (colors.length >= 6 && colors.slice(0, 6).every((c) => !!c.color)) return colors.slice(0, 6).map((c) => hex(c.color!));
  return null;
}

export interface BrandOptions {
  /** Brand colours: the first is the primary, the second (if any) the accent. */
  brandPalette?: string[];
  brandFonts?: { heading?: string; body?: string };
}

/** A style repainted in the brand: the primary becomes the deep ground and
 *  the second colour the accent on both grounds, each pushed to read where
 *  it is used. The faces become the brand's when the kit names them. The
 *  style's own reserved colours (a sun, a lime) do not survive a repaint. */
export function applyBrand(style: KitStyle, opts: BrandOptions): KitStyle {
  const palette = (opts.brandPalette ?? []).map((h) => fromHex(h)).filter((c): c is NonNullable<typeof c> => !!c).map((c) => toHex(c).toUpperCase());
  let out: KitStyle = { ...style, paper: { ...style.paper }, deep: { ...style.deep } };
  if (palette.length) {
    const primary = palette[0];
    const accent = palette[1] ?? palette[0];
    const deepBg = toDeepGround(primary);
    const deepBg2 = mixHex(deepBg, "#000000", 0.45);
    const deepInk = isDark(style.deep.ink) ? "#FFFFFF" : style.deep.ink;
    const deep: KitPalette = {
      bg: deepBg, bg2: deepBg2, ink: deepInk,
      muted: mixHex(deepInk, deepBg, 0.3), line: mixHex(deepBg, deepInk, 0.18), panel: mixHex(deepBg, deepInk, 0.08), panel2: mixHex(deepBg, deepInk, 0.14),
      accent: toContrast(accent, deepBg, 3), accent2: toContrast(palette[1] ? primary : mixHex(accent, "#FFFFFF", 0.4), deepBg, 3),
    };
    deep.accentInk = toContrast(deep.accent, deepBg, 4.5);
    deep.accent2Ink = toContrast(deep.accent2, deepBg, 4.5);
    const paperBg = style.paper.bg;
    const paper: KitPalette = {
      ...style.paper,
      accent: toContrast(accent, paperBg, 3),
      accent2: toContrast(palette[1] ? primary : style.paper.accent2, paperBg, 3),
    };
    paper.accentInk = toContrast(paper.accent, paperBg, 4.5);
    paper.accent2Ink = toContrast(paper.accent2, paperBg, 4.5);
    delete paper.sun; delete paper.lime;
    out = { ...out, paper, deep };
  }
  if (opts.brandFonts?.heading) out = { ...out, display: opts.brandFonts.heading, numeralFace: undefined };
  if (opts.brandFonts?.body) out = { ...out, body: opts.brandFonts.body, mono: null };
  return out;
}

/** A style repainted in a chosen theme's six slots (primary, accent, deep,
 *  tint, ink, paper): the user picked these colours, so the kit wears them
 *  the way a brand's. The kit's own faces and ornament stay. */
export function applyThemeSlots(style: KitStyle, slots: string[]): KitStyle {
  const hexes = slots.map((h) => fromHex(h)).map((c) => (c ? toHex(c).toUpperCase() : null));
  if (hexes.length < 6 || hexes.some((h) => !h)) return style;
  const [primary, accent, deep, tint, ink, paper] = hexes as string[];
  const deepInk = isDark(deep) ? (isDark(style.deep.ink) ? "#FFFFFF" : style.deep.ink) : ink;
  const paperInk = isDark(paper) ? "#FFFFFF" : ink;
  const paperP: KitPalette = {
    bg: paper, ink: paperInk, muted: mixHex(paperInk, paper, 0.3), line: mixHex(paper, paperInk, 0.14), panel: tint, panel2: mixHex(tint, paperInk, 0.06),
    accent: toContrast(accent, paper, 3), accent2: toContrast(primary, paper, 3),
  };
  paperP.accentInk = toContrast(paperP.accent, paper, 4.5);
  paperP.accent2Ink = toContrast(paperP.accent2, paper, 4.5);
  const deepP: KitPalette = {
    bg: deep, bg2: mixHex(deep, isDark(deep) ? "#000000" : "#FFFFFF", 0.35), ink: deepInk, muted: mixHex(deepInk, deep, 0.3), line: mixHex(deep, deepInk, 0.18), panel: mixHex(deep, deepInk, 0.08), panel2: mixHex(deep, deepInk, 0.14),
    accent: toContrast(accent, deep, 3), accent2: toContrast(mixHex(primary, deepInk, 0.35), deep, 3),
  };
  deepP.accentInk = toContrast(deepP.accent, deep, 4.5);
  deepP.accent2Ink = toContrast(deepP.accent2, deep, 4.5);
  return { ...style, paper: paperP, deep: deepP };
}

/** A hex walked in lightness, one way only, until it clears 4.5:1 against
 *  every ground it is set on, keeping its hue: lighter on a dark palette,
 *  darker on a light one. Fixing against one ground at a time flipped a
 *  light ink to black when a mid-tone tint sat among the grounds; walking
 *  toward the palette's own ink side never does. */
function holdInk(hex: string, grounds: string[], lighten: boolean): string {
  const refs = grounds.map((g) => fromHex(g)).filter((c): c is NonNullable<typeof c> => !!c);
  const start = fromHex(hex);
  if (!start || !refs.length) return hex;
  const clears = (c: NonNullable<typeof start>) => refs.every((r) => contrastRatio(c, r) >= 4.5);
  if (clears(start)) return hex;
  const hsl = rgbToHsl(start);
  for (let i = 1; i <= 100; i++) {
    const l = lighten ? hsl.l + (1 - hsl.l) * (i / 100) : hsl.l * (1 - i / 100);
    const candidate = hslToRgb({ ...hsl, l: Math.max(0, Math.min(1, l)) });
    if (clears(candidate)) return toHex(candidate).toUpperCase();
  }
  return lighten ? "#FFFFFF" : "#000000";
}

/** Every small ink of a palette held to AA against the grounds it is set
 *  on (the page, its cards, and the tints the layouts mix for badges and
 *  pills), keeping its hue. The palettes were drawn by eye for the
 *  templates; a generated deck sets copy the designer never saw, so the
 *  floor is held here rather than repaired after the fact. */
function holdAA(g: KitPalette): KitPalette {
  const dark = isDark(g.bg);
  const grounds = [g.bg, g.panel, g.panel2, mixHex(g.bg, g.accent, 0.22), mixHex(g.panel, g.accent, 0.22), mixHex(g.panel, g.accent2, 0.22)];
  if (g.bg2) grounds.push(g.bg2);
  return {
    ...g,
    muted: holdInk(g.muted, grounds, dark),
    accentInk: holdInk(g.accentInk ?? g.accent, grounds, dark),
    accent2Ink: holdInk(g.accent2Ink ?? g.accent2, grounds, dark),
  };
}

export interface VoiceOptions {
  organization?: string;
  deckName?: string;
  kicker?: string;
  farewell?: string;
  total: number;
  logo?: DeckLogo | null;
}

/** A look: the style plus the deck's own words. */
export function makeLook(style: KitStyle, v: VoiceOptions): KitLook {
  return {
    ...style,
    paper: holdAA(style.paper),
    deep: holdAA(style.deep),
    company: (v.organization ?? "").trim(),
    deck: (v.deckName ?? "").trim(),
    kicker: (v.kicker ?? "").trim(),
    farewell: (v.farewell ?? "").trim() || "Thank you",
    total: v.total,
    logo: v.logo ?? null,
  };
}

/** The drawing an asset id or a keyword names, when the pack has it. */
export function packDrawing(name: string | undefined): string | null {
  if (!name) return null;
  const k = name.trim().toLowerCase();
  if (!k) return null;
  if (PACK_DRAWINGS[k]) return k;
  if (PACK_KEYWORDS[k]) return PACK_KEYWORDS[k];
  for (const w of k.split(/[^a-z0-9]+/)) if (w && PACK_KEYWORDS[w]) return PACK_KEYWORDS[w];
  return null;
}

/** A drawing for a slot: the page's own when it named one, else the
 *  style's for that slot, else one picked by seed from the pack. */
export function drawingFor(K: KitLook, slot: keyof KitStyle["art"], named: string | undefined, seed: number): string {
  const own = packDrawing(named);
  if (own) return own;
  const styled = packDrawing(K.art[slot]);
  if (styled) return styled;
  const pool = Object.keys(PACK_DRAWINGS).filter((id) => !id.startsWith("op-"));
  return pool[Math.abs(seed) % pool.length];
}

/** The portrait for a slot, cycling the style's own when the pack has
 *  them, else the pack's. */
export function peepFor(K: KitLook, k: number): string {
  const own = K.peeps.filter((id) => PACK_DRAWINGS[id]);
  const pool = own.length ? own : PACK_PEEPS;
  return pool[k % pool.length];
}

// --- type roles ------------------------------------------------------------------

type TextRole = Omit<TextPrim, "kind" | "x" | "y" | "w" | "h" | "text">;
type RoleOpts = Partial<TextRole>;

/** Type roles for a look on a ground. Each returns the text options only;
 *  the caller supplies the box. `cw` is the average advance the fit
 *  estimate uses: a display face by the style's measure, body faces
 *  narrower, a mono face wider. */
export function type(K: KitLook, g: KitPalette) {
  const cw = K.charWidth ?? 0.56;
  return {
    display: (size: number, o: RoleOpts = {}): TextRole => ({ family: K.display, size, weight: K.dw, color: g.ink, lineHeight: 1.06, cw, ...o }),
    body: (size: number, o: RoleOpts = {}): TextRole => ({ family: K.body, size, weight: K.bw, color: g.muted, lineHeight: 1.4, cw: 0.54, ...o }),
    strong: (size: number, o: RoleOpts = {}): TextRole => ({ family: K.body, size, weight: K.strongWeight ?? 600, color: g.ink, lineHeight: 1.3, cw: 0.56, ...o }),
    eyebrow: (o: RoleOpts = {}): TextRole => ({ family: K.mono ?? K.body, size: 20, weight: 600, color: g.accentInk ?? g.accent, letterSpacing: 4, upper: true, lineHeight: 1.2, cw: 0.72, name: "Eyebrow", ...o }),
    meta: (o: RoleOpts = {}): TextRole => ({ family: K.mono ?? K.body, size: 18, weight: 500, color: g.muted, lineHeight: 1.3, cw: K.mono ? 0.6 : 0.5, ...o }),
    numeral: (size: number, o: RoleOpts = {}): TextRole => ({ family: K.numeralFace ?? K.display, size, weight: K.numeralWeight ?? K.dw, color: g.accentInk ?? g.accent, lineHeight: 1, cw: 0.62, name: "Figure", ...o }),
    /** The kicker line in the look's accent face: the one voice that is
     *  neither the display nor the body. */
    kicker: (o: RoleOpts = {}): TextRole => ({ family: K.accentFace, size: K.accentSize, weight: K.accentWeight, color: g.accentInk ?? g.accent, lineHeight: 1.2, cw: 0.5, name: "Kicker", ...o }),
  };
}

export const pageNo = (i: number, total: number): string => `${String(i + 1).padStart(2, "0")} / ${total}`;

/** The deep pages' ground: a gradient from bg to bg2, darker toward the
 *  bottom right. */
export const deepGround = (g: KitPalette) => ({ angle: 160, stops: [[g.bg, 0], [g.bg2 ?? mixHex(g.bg, "#000000", 0.4), 1]] as [string, number][] });

const sunOf = (g: KitPalette) => g.sun ?? g.accent2;
const limeOf = (g: KitPalette) => g.lime ?? g.accent2;

// --- ornaments -------------------------------------------------------------------

/** Two concentric discs of the accent behind a hero drawing, the way a
 *  flyer lights its subject. */
export function halo(cx: number, cy: number, size: number, color: string): Prim[] {
  return decor([
    ellipse(cx - size / 2, cy - size / 2, size, size, color, { opacity: 0.12 }),
    ellipse(cx - size * 0.4, cy - size * 0.4, size * 0.8, size * 0.8, color, { opacity: 0.16 }),
  ]);
}

/** A scatter of small dots at varied opacity, deterministic per seed. */
export function sparkles(color: string, seed: number, n = 7, box = { x: 1180, y: 0, w: W - 1180, h: H - 120 }): Prim[] {
  let s = seed * 9301 + 49297;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const out: ShapePrim[] = [];
  for (let k = 0; k < n; k++) {
    const d = 4 + Math.round(rnd() * 5);
    out.push(ellipse(Math.round(box.x + rnd() * (box.w - d)), Math.round(box.y + rnd() * (box.h - d)), d, d, color, { opacity: 0.35 + Math.round(rnd() * 45) / 100 }));
  }
  return decor(out);
}

/** Small rotated strips in the look's second colours, the confetti a bold
 *  look throws around its hero. */
export function confetti(colors: string[], seed: number, n = 6, box = { x: 0, y: 0, w: W, h: H }): Prim[] {
  let s = seed * 7919 + 104729;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const out: ShapePrim[] = [];
  for (let k = 0; k < n; k++) {
    const w = 22 + Math.round(rnd() * 26), h = 8 + Math.round(rnd() * 6);
    out.push(rect(Math.round(box.x + rnd() * (box.w - w)), Math.round(box.y + rnd() * (box.h - h)), w, h, colors[k % colors.length], { rotation: Math.round(-40 + rnd() * 80), radius: 3 }));
  }
  return decor(out);
}

/** A square rotated 45 degrees about its top-left corner and placed off the
 *  page so that exactly one edge crosses the top right corner. */
function cornerTriangle(color: string, t: number, opacity: number): ShapePrim {
  const e = Math.round(t * 0.4);
  const side = Math.round((t + 2 * e) * Math.SQRT2);
  return rect(W + e, -t - 3 * e, side, side, color, { rotation: 45, opacity });
}

function crosshairs(color: string, opacity: number): ShapePrim[] {
  const out: ShapePrim[] = [];
  for (const [cx, cy] of [[48, 48], [W - 48, 48], [48, H - 48], [W - 48, H - 48]]) {
    out.push(rect(cx - 12, cy - 1, 24, 2, color, { opacity }), rect(cx - 1, cy - 12, 2, 24, color, { opacity }));
  }
  return out;
}

const watermarkText = (K: KitLook, g: KitPalette, t: number): TextPrim =>
  text(1160, 420, 760, 700, K.watermark ?? "&", { family: K.display, size: 620, weight: 500, color: mixHex(g.bg, g.ink, t), align: "right", lineHeight: 1, fixed: true, decor: true });

/** The look's signature marks on a deep page (cover, section, closing). */
export function ornamentDeep(K: KitLook, g: KitPalette, opts: { mark?: boolean } = {}): Prim[] {
  switch (K.ornament) {
    case "rules":
      return decor([rect(40, 40, W - 80, H - 80, undefined, { stroke: g.accent, strokeWidth: 1.5, opacity: 0.7 }), ...sparkles(g.accent, 3, 8, { x: 1100, y: 60, w: 760, h: 860 })]);
    case "glow":
      return decor([
        ellipse(1380, -420, 1100, 1100, { angle: 135, stops: [[g.accent2, 0], [g.bg2 ?? g.bg, 1]], radial: true }, { opacity: 0.6 }),
        ellipse(-380, 620, 900, 900, { angle: 135, stops: [[g.accent, 0], [g.bg2 ?? g.bg, 1]], radial: true }, { opacity: 0.26 }),
        ...[320, 640, 960, 1280, 1600].map((x) => rect(x, 0, 1, H, g.ink, { opacity: 0.06 })),
        ...[270, 540, 810].map((y) => rect(0, y, W, 1, g.ink, { opacity: 0.06 })),
        ...sparkles(g.accent, 5, 6),
        ...sparkles(g.accent2, 6, 5),
      ]);
    case "hairlines":
      return decor([
        ellipse(1560, -180, 520, 520, sunOf(g), { opacity: 0.9 }),
        rect(M, 64, CW, 2, g.ink), rect(M, H - 66, CW, 2, g.ink),
        ...(opts.mark ? [] : [rect(M, 84, 14, 14, g.accent)]),
      ]);
    case "blocks":
      return [];
    case "blobs":
      return decor([
        ellipse(1480, -260, 760, 760, g.accent2, { opacity: 0.4 }),
        ellipse(-200, 720, 560, 560, g.accent, { opacity: 0.35 }),
        ellipse(1720, 720, 300, 300, sunOf(g), { opacity: 0.6 }),
        ...sparkles(g.ink, 9, 7),
      ]);
    case "crosshairs":
      return decor([
        ellipse(1180, -300, 1200, 1200, { angle: 135, stops: [[g.accent, 0], [g.bg2 ?? g.bg, 1]], radial: true }, { opacity: 0.35 }),
        ...crosshairs(g.ink, 0.7),
      ]);
    case "watermark":
      return decor([watermarkText(K, g, 0.08), rect(M, 64, CW, 2, g.line)]);
    case "sun":
      return decor([ellipse(1620, -120, 300, 300, sunOf(g), { opacity: 0.95 }), ...sparkles(sunOf(g), 13, 7, { x: 1100, y: 0, w: 820, h: 700 })]);
    case "ridges":
      return decor([
        ellipse(-300, 860, 1100, 700, mixHex(g.bg, g.bg2 ?? g.bg, 0.6)),
        ellipse(500, 900, 1300, 700, mixHex(g.bg, g.ink, 0.06)),
        ellipse(1400, 880, 1100, 700, mixHex(g.bg, g.bg2 ?? g.bg, 0.6)),
        ellipse(1500, 80, 120, 120, g.accent, { opacity: 0.9 }), ellipse(1470, 60, 120, 120, g.bg, { opacity: 0.85 }),
        ...sparkles(g.accent, 7, 10, { x: 1100, y: 0, w: 820, h: 620 }), ...sparkles(g.ink, 11, 8, { x: 1100, y: 0, w: 820, h: 620 }),
      ]);
    case "arcs":
      return decor([1400, 1100, 800, 500].map((d, k) => ellipse(1920 - d / 2 - 120, -d / 2 + 80, d, d, undefined, { stroke: g.accent, strokeWidth: 2, opacity: 0.22 + k * 0.08 })));
    case "dots": {
      const out: ShapePrim[] = [];
      for (let r = 0; r < 9; r++) for (let c = 0; c < 7; c++) out.push(ellipse(1320 + c * 88, 96 + r * 88, 6, 6, g.ink, { opacity: 0.16 }));
      return decor([...out, ...sparkles(g.accent, 17, 5, { x: 1180, y: 60, w: 680, h: 820 })]);
    }
    case "stripes":
      return decor([0, 1, 2].map((k) => rect(1180 + k * 190, -300, 90, 1700, g.accent, { rotation: 24, opacity: 0.1 + k * 0.05 })));
    case "orbs":
      return decor([
        ellipse(1500, 120, 260, 260, g.accent, { opacity: 0.9 }), ellipse(1700, 420, 140, 140, g.accent2, { opacity: 0.9 }),
        ellipse(1380, 760, 90, 90, g.accent2, { opacity: 0.7 }), ellipse(1040, 40, 110, 110, g.accent, { opacity: 0.35 }),
        ...sparkles(g.ink, 19, 6),
      ]);
    case "corner":
      return decor([cornerTriangle(g.accent, 460, 0.92), ...sparkles(g.ink, 23, 6, { x: 1150, y: 540, w: 700, h: 330 })]);
    default:
      return [];
  }
}

/** The look's quieter marks on a reading page. */
export function ornamentPaper(K: KitLook, g: KitPalette): Prim[] {
  switch (K.ornament) {
    case "glow":
      return decor([
        ellipse(1500, -520, 1000, 1000, { angle: 135, stops: [[g.accent2, 0], [g.bg2 ?? g.bg, 1]], radial: true }, { opacity: 0.3 }),
        ...[320, 640, 960, 1280, 1600].map((x) => rect(x, 0, 1, H, g.ink, { opacity: 0.045 })),
      ]);
    case "hairlines":
      return decor([rect(M, 64, CW, 2, g.ink), ellipse(1770, -110, 220, 220, sunOf(g))]);
    case "crosshairs":
      return decor(crosshairs(g.line, 1));
    case "blobs":
      return decor([ellipse(1700, -180, 380, 380, g.accent2, { opacity: 0.22 })]);
    case "blocks":
      return decor([rect(W - 14, 0, 14, H, g.accent2)]);
    case "rules":
      return decor([rect(M, 76, 56, 3, g.accent)]);
    case "watermark":
      return decor([watermarkText(K, g, 0.05), rect(M, 64, CW, 2, g.line)]);
    case "sun":
      return decor([ellipse(1740, -140, 260, 260, sunOf(g), { opacity: 0.9 })]);
    case "ridges":
      return decor([ellipse(1720, -160, 340, 340, mixHex(g.bg, g.accent, 0.18))]);
    case "arcs":
      return decor([760, 520].map((d, k) => ellipse(1920 - d / 2 - 120, -d / 2 + 60, d, d, undefined, { stroke: g.accent, strokeWidth: 2, opacity: 0.18 + k * 0.08 })));
    case "dots": {
      const out: ShapePrim[] = [];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 6; c++) out.push(ellipse(1360 + c * 80, 40 + r * 80, 5, 5, g.ink, { opacity: 0.14 }));
      return decor(out);
    }
    case "stripes":
      return decor([rect(1700, -300, 60, 1700, g.accent, { rotation: 24, opacity: 0.08 })]);
    case "orbs":
      return decor([ellipse(1760, -80, 200, 200, g.accent, { opacity: 0.85 }), ellipse(1660, 140, 60, 60, g.accent2, { opacity: 0.8 })]);
    case "corner":
      return decor([cornerTriangle(g.accent, 300, 0.9)]);
    default:
      return [];
  }
}

/** The lime a bold look throws as confetti: its own, else the second accent. */
export const confettiColors = (g: KitPalette): string[] => [limeOf(g), g.ink, g.bg];

// --- chrome ----------------------------------------------------------------------

export interface ChromeOptions { titleWidth?: number; titleSize?: number; titleLines?: number }

/** Eyebrow, title and footer of a reading page; returns the primitives and
 *  the y the body starts at. A title that does not fit one line steps down
 *  to four fifths; one that still does not fit wraps to two lines at that
 *  size, and the body starts lower. */
export function chrome(K: KitLook, g: KitPalette, i: number, eyebrow: string, title: string, opts: ChromeOptions = {}): { nodes: Prim[]; bodyTop: number } {
  const t = type(K, g);
  const width = opts.titleWidth ?? 1240;
  const asked = opts.titleSize ?? K.scale.title;
  const cw = K.charWidth ?? 0.56;
  let size = fitSize(title, asked, width, 0.8, cw);
  let lines = opts.titleLines ?? 1;
  if (lines === 1 && estWidth(title, size, cw) > width) { size = Math.round(asked * 0.82); lines = 2; }
  const titleY = K.ornament === "hairlines" ? 132 : 124;
  const nodes: Prim[] = [
    ...ornamentPaper(K, g),
    ...(eyebrow ? [text(M, titleY - 36, 1200, 28, eyebrow, t.eyebrow())] : []),
    text(M, titleY, width, Math.round(size * 1.1 * lines) + 8, title, t.display(size, { name: "Title" })),
    ...footer(K, g, i),
  ];
  return { nodes, bodyTop: titleY + Math.round(size * 1.1 * lines) + 52 };
}

/** The brand's logo for a ground, fitted to a height: the dark variant on
 *  a deep ground when the kit has one. Nothing when the deck has no logo. */
export function brandLogo(K: KitLook, g: KitPalette, x: number, y: number, h: number): { nodes: Prim[]; width: number } {
  const lg = K.logo;
  if (!lg) return { nodes: [], width: 0 };
  const chosen = isDark(g.bg) && lg.dark ? lg.dark : lg;
  const aspect = chosen.aspect && chosen.aspect > 0 ? chosen.aspect : 3;
  const width = Math.round(Math.min(320, Math.max(lg.minSizePx ?? 0, h * aspect)));
  const height = Math.round(width / aspect);
  return { nodes: [logo(chosen.assetId, x, y + Math.round((h - height) / 2), width, height)], width };
}

/** Whether the logo drawn on a ground is wide enough to be a lockup with the
 *  organization's name in it (width over height of 2.5 or more). */
export function logoCarriesName(K: KitLook, g: KitPalette): boolean {
  const lg = K.logo;
  if (!lg) return false;
  const chosen = isDark(g.bg) && lg.dark ? lg.dark : lg;
  return (chosen.aspect ?? 0) >= 2.5;
}

/** The footer: a rule, the logo, the organization and the deck, the page number. */
export function footer(K: KitLook, g: KitPalette, i: number): Prim[] {
  const t = type(K, g);
  const y = K.ornament === "hairlines" ? H - 50 : 992;
  const line = [K.company, K.deck].filter(Boolean).join("  ·  ");
  const lg = brandLogo(K, g, M, y - 4, 34);
  const tx = M + (lg.width ? lg.width + 20 : 0);
  return [
    ...(K.ornament === "hairlines" ? [] : decor([rect(M, 968, CW, 1, g.line)])),
    ...lg.nodes,
    ...(line ? [text(tx, y, 900 - (tx - M), 26, line, t.meta({ name: "Footer", fixed: true }))] : []),
    ...(K.total > 1 ? [text(W - M - 240, y, 240, 26, pageNo(i, K.total), t.meta({ align: "right", name: "Page number", fixed: true }))] : []),
  ];
}

/** A slide's hand note in the accent face: bottom right on a reading page
 *  (above the footer rule), under the picture on a deep page. */
export function note(K: KitLook, g: KitPalette, str: string | undefined, deep = false, at: { x: number; y: number; w?: number; size?: number; align?: "left" | "center" | "right" } | null = null): Prim[] {
  if (!str) return [];
  const t = type(K, g);
  const sz = Math.round(K.accentSize * (deep ? 0.85 : 0.8));
  if (at) {
    const aw = at.w ?? 720;
    const al = Math.min(2, linesFor(str, at.size ?? sz, aw, 0.5));
    return [text(at.x, at.y, aw, Math.round((at.size ?? sz) * 1.25 * al), str, t.kicker({ align: at.align ?? "center", size: at.size ?? sz, name: "Note" }))];
  }
  const w = deep ? 720 : 760;
  const lines = Math.min(2, linesFor(str, sz, w, 0.5));
  const h = Math.round(sz * 1.25 * lines);
  return deep
    ? [text(1140, 872 + 52 - h, w, h, str, t.kicker({ align: "center", size: sz, name: "Note" }))]
    : [text(W - M - w, 908 + 48 - h, w, h, str, t.kicker({ align: "right", size: sz, name: "Note" }))];
}

/** A card: the look's panel with a hairline stroke, in the look's radius. */
export const card = (K: KitLook, g: KitPalette, x: number, y: number, w: number, h: number, o: { fill?: string; stroke?: string; strokeWidth?: number; opacity?: number } = {}): ShapePrim =>
  rect(x, y, w, h, o.fill ?? g.panel, { radius: K.radius, stroke: o.stroke ?? g.line, strokeWidth: o.strokeWidth ?? 1.5, panel: true, ...(o.opacity ? { opacity: o.opacity } : {}) });

/** A panel on the deep ground, in the look's radius. */
export const deepCard = (K: KitLook, x: number, y: number, w: number, h: number): ShapePrim => rect(x, y, w, h, deepGround(K.deep), { radius: K.radius, panel: true });

/** The organization's mark, top-left of an impact page: a square of the
 *  accent and the name. Nothing when the deck names no organization. */
export function mark(K: KitLook, g: KitPalette, y = M): Prim[] {
  const t = type(K, g);
  const lg = brandLogo(K, g, M, y - 12, 48);
  // A wide logo is a lockup that already carries the name, so the organization
  // is not set beside it a second time; a compact mark still gets the name.
  if (lg.width) return [...lg.nodes, ...(K.company && !logoCarriesName(K, g) ? [text(M + lg.width + 24, y - 3, 700, 30, K.company, t.strong(22, { name: "Mark", fixed: true }))] : [])];
  if (!K.company) return [];
  return [...decor([rect(M, y, 22, 22, g.accent, { radius: K.radius ? 6 : 0 })]), text(M + 36, y - 3, 700, 30, K.company, t.strong(22, { name: "Mark", fixed: true }))];
}

export { estWidth, fitSize, linesFor } from "./spec";
import { estWidth, fitSize, linesFor } from "./spec";
