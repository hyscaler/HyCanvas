// Per-slide regeneration for a composed deck: one page set again through
// the composer that set its siblings.
//
// The archetype and kit composers draw freeform pages: named nodes on a
// background, no layout link and no placeholder boxes. The layout-grounded
// regeneration cannot touch them, so a "fix slide 2" on such a deck used to
// be refused. Here the page's outline item (kept on the page since the
// recipe existed, else the model's reading of the page's text) is revised
// per the instruction, the deck's look is rebuilt from what the file keeps
// (the theme record, the title, the recipe stamped at generation) and the
// workspace brand, and the item is set again at the page's index, so the
// page comes back in the deck's own system with the deck's own furniture.
// Pure: the caller replaces the page's content.

import type { Fill, Node, Theme } from "@hc/schema";
import { fromHex } from "@hc/color";
import { deckThemeFromRecord } from "./compose";
import { deckThemes } from "./theme";
import { deriveDesignSystem, type DeckLogo, type DesignSystem } from "./designSystem";
import { composeArchetypePage, type ComposedPage } from "./archetypes";
import { composeKitPage, kitFits, type KitContext } from "./kit/render";
import { applyBrand, applyThemeSlots, makeLook, resolveKitStyle, slotsFromThemeRecord, type KitLook, type KitStyle } from "./kit/look";
import { KIT_STYLES, kitStyleNames } from "./kit/looks";
import { repairContrast } from "./repair";
import { normalizeOutline, outlineItemJsonSchema, type Archetype, type DeckTheme, type DesignType, type OutlineItem } from "./outline";
import type { DeckRecipe } from "./deck";

/** The page fields a recomposition reads (a schema Page fits). */
export interface RecomposePageLike {
  width: number;
  height: number;
  children: unknown[];
  notes?: string;
  layoutId?: string;
  data?: Record<string, unknown>;
}

/** The document fields a recomposition reads (a DesignFile fits). */
export interface RecomposeDocLike {
  title: string;
  theme?: Theme;
  meta?: Record<string, unknown>;
  pages: RecomposePageLike[];
}

export interface RecomposeInput {
  doc: RecomposeDocLike;
  pageIndex: number;
  /** The revised outline item, normalized (reviseSlideItem). */
  item: OutlineItem;
  brandPalette?: string[];
  brandFonts?: { heading?: string; body?: string };
  logo?: DeckLogo | null;
  dir?: "ltr" | "rtl";
}

export interface RecomposedSlide {
  background: Fill;
  nodes: Node[];
  /** Placeholder id to image prompt for every photo slot on the page. */
  imagePrompts: Record<string, string>;
  archetype: Archetype;
  /** Text nodes whose copy did not fit at the floor of the ladder. */
  overfull: string[];
  /** Text runs re-inked to AA before the page left. */
  repairs: number;
  /** The kit style the page was set in, when the kit drew it. */
  style?: string;
}

type LooseNode = {
  type?: string;
  name?: string;
  shape?: string;
  size?: { width: number; height: number };
  cornerRadius?: unknown;
  data?: { placeholderId?: string };
  content?: { runs: { text: string; style?: { fontSize?: number } }[] }[];
};

const titleSeed = (title: string): number => Array.from(title).reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7);

/** The recipe a file's meta carries, or null when the deck predates it. */
export function deckRecipeOf(meta: unknown): DeckRecipe | null {
  const rec = meta && typeof meta === "object" ? (meta as Record<string, unknown>).aiDeck : undefined;
  if (!rec || typeof rec !== "object") return null;
  const r = rec as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
  return {
    renderer: r.renderer === "classic" ? "classic" : "kit",
    style: str(r.style),
    look: str(r.look),
    mood: str(r.mood),
    organization: str(r.organization),
    kicker: str(r.kicker),
    farewell: str(r.farewell),
    designType: str(r.designType) as DesignType | undefined,
    fontsAuthored: typeof r.fontsAuthored === "boolean" ? r.fontsAuthored : undefined,
    themeSlots: Array.isArray(r.themeSlots) && r.themeSlots.every((s) => typeof s === "string") ? (r.themeSlots as string[]) : r.themeSlots === null ? null : undefined,
  };
}

/** The outline item a page was set from (Page.data aiOutline), re-normalized
 *  so a hand-edited or older record still yields a well-formed item; null
 *  when the page carries none. */
export function slideItemOf(page: { data?: Record<string, unknown> }): OutlineItem | null {
  const raw = page.data?.aiOutline;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  try {
    return normalizeOutline({ title: "slide", theme: "", pages: [raw] }).pages[0] ?? null;
  } catch {
    return null;
  }
}

/** Whether a page is one the composers drew: it carries its outline item,
 *  or it wears the composers' furniture (a named title beside decor, a page
 *  number, a kicker, an eyebrow or a footer) with no layout link and no
 *  placeholder text box. Such a page regenerates by recomposition; a
 *  layout-linked page regenerates through its layout's slots. */
export function isComposedSlide(page: { children: unknown[]; layoutId?: string; data?: Record<string, unknown> }): boolean {
  if (slideItemOf(page)) return true;
  if (page.layoutId) return false;
  const kids = page.children as LooseNode[];
  if (kids.some((n) => n.type === "text" && n.data?.placeholderId)) return false;
  const names = new Set(kids.map((n) => n.name));
  // The furniture both composers set: the kit's decor, page number, kicker,
  // eyebrow and footer; the classic composer's points, section number and
  // subhead. A page the user drew from the toolbar names none of these.
  return names.has("Title") && ["Decor", "Page number", "Kicker", "Eyebrow", "Footer", "Points", "Section number", "Subhead"].some((n) => names.has(n));
}

/** The page's text, one line per box named by its role, for the model to
 *  read when the page kept no outline item. Furniture the composer sets
 *  itself (the footer, the page number, the deck's kicker) is left out. */
export function slideTextDump(page: { notes?: string; children: unknown[] }): string {
  const lines: string[] = [];
  for (const n of page.children as LooseNode[]) {
    if (n.type !== "text") continue;
    const name = n.name ?? "Text";
    if (name === "Footer" || name === "Page number" || name === "Kicker") continue;
    const text = (n.content ?? []).map((par) => par.runs.map((r) => r.text).join("")).join(" / ").trim();
    if (text) lines.push(`${name}: ${text}`);
  }
  if (page.notes?.trim()) lines.push(`Speaker note: ${page.notes.trim()}`);
  return lines.join("\n");
}

/** The schema a slide revision returns: an outline item, with the note
 *  optional so a reply that keeps the current note verbatim (or omits it)
 *  still validates. */
export function reviseSlideSchema(): Record<string, unknown> {
  const item = JSON.parse(JSON.stringify(outlineItemJsonSchema)) as { required: string[]; properties: { note: Record<string, unknown> } };
  item.required = ["title", "archetype"];
  delete item.properties.note.minLength;
  return item as unknown as Record<string, unknown>;
}

/** System prompt for the one revision call. */
export function reviseSlideSystemPrompt(styleClause = ""): string {
  return (
    "You REVISE one existing presentation slide per the user's instruction and return the slide as an outline item. " +
    "Ground the revision in the slide's current content: keep every figure, date, name and proper noun exactly as written unless the instruction changes it; add material only where the instruction asks for it. " +
    "When asked to fit, tighten or shorten, cut words and merge points; never drop a fact. " +
    "Keep the slide's form (archetype) and its typed fields (stats, table, columns, steps, quote, pairs) unless the instruction calls for another form; when the current slide is given as text boxes named by role, infer the form from them (rows of short cells are a table, figures with labels are a kpiGrid, two headed groups are columns). " +
    "Write in the same language as the current content unless the instruction says otherwise. " +
    (styleClause.trim() ? styleClause.trim() + " " : "") +
    "Output ONLY a single JSON object matching the schema, no prose or fences. Schema: " + JSON.stringify(reviseSlideSchema())
  );
}

const TYPED_FIELDS = ["stat", "quote", "steps", "columns", "chart", "stats", "table", "people", "composition", "pairs", "signature"] as const;

/** The revised item: the model's reply over the current item, normalized.
 *  A reply that names another form drops the old form's typed fields, so a
 *  table turned into bullets does not keep its rows; a reply that omits the
 *  note keeps the current one. Throws when the reply holds no page. */
export function reviseSlideItem(parsed: unknown, current: OutlineItem | null): OutlineItem {
  const raw = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const base: Record<string, unknown> = current ? { ...current } : {};
  delete base.id;
  if (current && typeof raw.archetype === "string" && raw.archetype !== current.archetype) {
    for (const k of TYPED_FIELDS) if (!(k in raw)) delete base[k];
  }
  return normalizeOutline({ title: "slide", theme: "", pages: [{ ...base, ...raw }] }).pages[0];
}

// --- the look, rebuilt ---------------------------------------------------------

interface LookParts {
  system: DesignSystem;
  kit: KitLook | null;
}

/** The kit style a deck was set in, from its own words: the recipe when the
 *  file has one, else the style its mood and title point at, else one by
 *  seed, exactly as the deck was first set. */
function baseStyle(input: RecomposeInput, recipe: DeckRecipe | null, styleName: string | undefined, mood: string, seed: number): KitStyle {
  return resolveKitStyle({ style: styleName, look: recipe?.look, seed, mood: [mood, input.doc.title].filter(Boolean).join(" ") });
}

/** A kit look for one style, the way layoutDeck builds it: the chosen
 *  theme's slots when the deck wore them (else the theme record's, which
 *  for a kit deck are the very colours it wore), the brand over that, and
 *  the deck's voice merged in. */
function kitLookFor(style: KitStyle, input: RecomposeInput, recipe: DeckRecipe | null, voice: DeckVoice, theme: DeckTheme, fontsAuthored: boolean): KitLook {
  const record = input.doc.theme ?? null;
  const slots = recipe && recipe.themeSlots !== undefined ? recipe.themeSlots : record ? slotsFromThemeRecord(record) : null;
  const repainted = applyBrand(slots ? applyThemeSlots(style, slots) : style, {
    brandPalette: input.brandPalette ?? [],
    brandFonts: fontsAuthored ? { heading: input.brandFonts?.heading ?? theme.fontHeading, body: input.brandFonts?.body ?? theme.fontBody } : undefined,
  });
  return makeLook(repainted, { organization: voice.organization, deckName: input.doc.title, kicker: voice.kicker, farewell: voice.farewell, total: input.doc.pages.length, logo: input.logo ?? null });
}

interface DeckVoice {
  organization?: string;
  kicker?: string;
  farewell?: string;
}

const flatText = (n: LooseNode): string => (n.content ?? []).map((par) => par.runs.map((r) => r.text).join("")).join(" ").trim();

/** The deck's voice: the recipe's when the file has one, else read off the
 *  pages the kit set it on (the kicker line, the closing's farewell, the
 *  organization in the footer beside the deck's title). */
function deckVoiceOf(doc: RecomposeDocLike, recipe: DeckRecipe | null): DeckVoice {
  if (recipe) return { organization: recipe.organization, kicker: recipe.kicker, farewell: recipe.farewell };
  const voice: DeckVoice = {};
  const last = doc.pages.length - 1;
  doc.pages.forEach((p, i) => {
    for (const n of p.children as LooseNode[]) {
      if (n.type !== "text") continue;
      const text = flatText(n);
      if (!text) continue;
      if (n.name === "Kicker") {
        if (i === last && i > 0) voice.farewell ??= text;
        else voice.kicker ??= text;
      } else if (n.name === "Footer" && !voice.organization) {
        voice.organization = text.split("·").map((s) => s.trim()).filter(Boolean).find((s) => s !== doc.title.trim());
      }
    }
  });
  return voice;
}

/** A page's ornament as a multiset: every decor shape by kind and size, the
 *  title's set size, a panel's corner. What a kit style leaves on a page
 *  whatever the copy says, so a style can be told from a page it set. */
function ornamentSignature(nodes: unknown[]): Map<string, number> {
  const sig = new Map<string, number>();
  const add = (k: string) => sig.set(k, (sig.get(k) ?? 0) + 1);
  let panel = false;
  for (const n of nodes as LooseNode[]) {
    if (n.name === "Decor" && n.size) add(`${n.shape ?? n.type}:${Math.round(n.size.width)}x${Math.round(n.size.height)}`);
    else if (n.name === "Title" && n.type === "text") {
      const size = n.content?.[0]?.runs?.[0]?.style?.fontSize;
      if (size) add(`title:${Math.round(size)}`);
    } else if (n.name === "Panel" && !panel && n.cornerRadius !== undefined) {
      panel = true;
      add(`panel:${JSON.stringify(n.cornerRadius)}`);
    }
  }
  return sig;
}

/** How much of the probe's ornament the page carries, 0..1. */
function ornamentMatch(page: Map<string, number>, probe: Map<string, number>): number {
  let total = 0;
  let hit = 0;
  for (const [k, n] of probe) {
    total += n;
    hit += Math.min(n, page.get(k) ?? 0);
  }
  return total ? hit / total : 0;
}

/** The kit style a page was set in, told from its ornament: every style is
 *  tried on the page's own title and form and the one whose decor the page
 *  carries wins. Null when no style accounts for most of the page's decor
 *  (a page the user redrew, or one the classic composer set). */
export function recoverKitStyle(page: { children: unknown[] }, probe: (style: KitStyle) => Node[]): string | null {
  const have = ornamentSignature(page.children);
  if (!have.size) return null;
  let best: string | null = null;
  let bestScore = 0;
  for (const name of kitStyleNames) {
    const style = KIT_STYLES[name];
    if (!style) continue;
    const score = ornamentMatch(have, ornamentSignature(probe(style)));
    if (score > bestScore) { bestScore = score; best = name; }
  }
  return bestScore >= 0.6 ? best : null;
}

/** The system the kit's colours and faces repaint, as layoutDeck does. */
function withKit(system: DesignSystem, kit: KitLook): DesignSystem {
  const c = (hex: string) => fromHex(hex) ?? system.colors.ink;
  return {
    ...system,
    fonts: { heading: kit.display, body: kit.body, ...(kit.mono ? { mono: kit.mono } : {}) },
    colors: { ...system.colors, primary: c(kit.paper.accent2), accent: c(kit.paper.accent), deep: c(kit.deep.bg), tint: c(kit.paper.panel), ink: c(kit.paper.ink), paper: c(kit.paper.bg) },
    radius: kit.radius,
  };
}

/** Set one page of a composed deck again from a revised item. Null when the
 *  page does not exist. */
export function recomposeSlide(input: RecomposeInput): RecomposedSlide | null {
  const { doc, pageIndex, item } = input;
  const page = doc.pages[pageIndex];
  if (!page) return null;
  const size = { width: Math.max(1, Math.round(page.width)), height: Math.max(1, Math.round(page.height)) };
  const recipe = deckRecipeOf(doc.meta);
  const total = doc.pages.length;
  const seed = titleSeed(doc.title);
  const brandPalette = input.brandPalette ?? [];
  const record = doc.theme ?? null;
  const theme: DeckTheme = record
    ? deckThemeFromRecord(record, doc.title)
    : deckThemes({ brandPalette, kicker: doc.title, count: 1, seed, fontHeading: input.brandFonts?.heading, fontBody: input.brandFonts?.body })[0];
  const themed: DeckTheme = { ...theme, kicker: theme.kicker ?? doc.title };
  const designType: DesignType = recipe?.designType ?? "deck";
  const fontsAuthored = recipe?.fontsAuthored ?? !!(input.brandFonts?.heading || input.brandFonts?.body || record);
  const mood = recipe?.mood ?? record?.name ?? "";
  const voice = deckVoiceOf(doc, recipe);
  const plain = deriveDesignSystem(themed, size, { brandPalette, seed, logo: input.logo ?? null, look: recipe?.look, mood, fontsAuthored, catalog: null, dir: input.dir });
  // Section dividers are numbered in deck order; the deck's one signature
  // form stays with the page that has it.
  const items = doc.pages.map((p, i) => (i === pageIndex ? item : slideItemOf(p)));
  const section = item.archetype === "section" ? items.slice(0, pageIndex).filter((it) => it?.archetype === "section").length + 1 : undefined;
  const signatureUsed = items.some((it, i) => i !== pageIndex && !!it?.signature);
  const ctx: KitContext = { index: pageIndex, total, section, designType, motion: plain.motion, scale: size.width / 1920, artDirection: plain.artDirection, signatureUsed: { value: signatureUsed } };
  const useKit = (recipe?.renderer ?? "kit") === "kit" && kitFits(size, designType);
  let parts: LookParts = { system: plain, kit: null };
  if (useKit) {
    let styleName = recipe?.style;
    if (!styleName) {
      // A deck from before the recipe: the style is read off the page's own
      // ornament, so the page comes back matching its neighbours.
      // The probe carries the page's CURRENT title, so the title's set size
      // (which follows the copy's length) matches the one on the page.
      const currentTitle = (page.children as LooseNode[]).find((n) => n.type === "text" && n.name === "Title");
      const probeItem: OutlineItem = { id: "probe", title: (currentTitle && flatText(currentTitle)) || item.title, points: [], visualRole: item.visualRole, archetype: item.archetype, ...(item.eyebrow ? { eyebrow: item.eyebrow } : {}) };
      styleName = recoverKitStyle(page, (style) => composeKitPage(probeItem, kitLookFor(style, input, recipe, voice, theme, fontsAuthored), { ...ctx, signatureUsed: { value: true } }).nodes) ?? undefined;
    }
    const kit = kitLookFor(baseStyle(input, recipe, styleName, mood, seed), input, recipe, voice, theme, fontsAuthored);
    parts = { system: withKit(plain, kit), kit };
  }
  const composed: ComposedPage = parts.kit
    ? composeKitPage(item, parts.kit, { ...ctx, motion: parts.system.motion, artDirection: parts.system.artDirection })
    : composeArchetypePage(item, parts.system, { index: pageIndex, total, section, designType });
  const repairs = repairContrast({ background: composed.background, nodes: composed.nodes, size });
  return {
    background: composed.background,
    nodes: composed.nodes,
    imagePrompts: composed.imagePrompts,
    archetype: composed.archetype,
    overfull: composed.overfull,
    repairs,
    ...(parts.kit ? { style: parts.kit.name } : {}),
  };
}
