// Headless deck composition (F40 E03). One pure function from a generated
// outline to a complete, validating DesignFile: the exact pipeline the editor
// panel's freeform path runs (normalizeOutline -> seeded deckThemes ->
// layoutDeck -> pages), packaged so the Go server can execute it under goja
// (backend/internal/composer) and the generation API can mint decks with no
// browser in the loop. Deterministic BY CONTRACT: no Math.random, no
// Date.now; node ids come from the environment's crypto.randomUUID, which the
// goja entry and the parity test both replace with a counter, so the same
// input composes to the same bytes on both runtimes.

import {
  createNode,
  currentSchemaVersion,
  themeFromPalette,
  type DesignFile,
  type Fill,
  type Page,
  type SlideLayout,
  type SlideMaster,
  type Theme,
} from "@hc/schema";
import { fromHex } from "@hc/color";
import { normalizeOutline } from "./outline";
import { deckThemes } from "./theme";
import { layoutDeck } from "./deck";
import { layoutDesign, readableTextColor } from "./layout";
import { fallbackLayoutFill, repairLayoutSelection } from "./layoutSchema";
import { accentRuleRect, pageTreatment, slotTypeScale } from "./deckStyle";
import { reflowPage } from "./reflow";
import { themeRecordFromDeckTheme, themeSlotNames } from "./themeGen";
import { themeCatalogEntry, type ThemeCatalogEntry } from "./themeCatalog";
import type { DeckTheme } from "./outline";
import type { Color } from "@hc/schema";

export interface ComposeDeckInput {
  /** The generated outline, exactly as the server outline endpoint returns it
   *  (normalizeOutline is tolerant of the raw model/job JSON). */
  outline: unknown;
  width: number;
  height: number;
  /** Brand palette hexes; seeds the theme like the panel's brand grounding. */
  brandPalette?: string[];
  /** A built-in catalog theme id (F40 E12): when set and known, the deck is
   *  composed on that theme instead of a title-seeded generated one, and the
   *  catalog theme record is stamped on the file. Unknown ids THROW - a
   *  caller who names a theme means it, and silence would be a wrong deck. */
  themeId?: string;
  /** A template's layout system (F40 E14): when present with layouts, pages
   *  are composed LAYOUT-GROUNDED - deterministic per-page layout selection,
   *  placeholder-materialized text boxes, layout/master backgrounds - and the
   *  masters/layouts ride into the file so the deck stays layout-linked. */
  layoutSet?: { masters: SlideMaster[]; layouts: SlideLayout[] };
  /** The template's theme record (E14): stamps the file theme and styles the
   *  materialized text (fonts by role, ink readable against the background). */
  themeRecord?: Theme;
  dir?: "ltr" | "rtl";
}

/** A T19 theme record as a generation DeckTheme (the template path's
 *  counterpart of deckThemeFromCatalog): deep-to-primary gradient, pair fonts.
 *  Slots resolve by NAME so a hand-edited record still reads correctly. */
export function deckThemeFromRecord(rec: Theme, kicker?: string): DeckTheme {
  const slot = (name: string) => rec.colors.find((c) => c.name === name)?.color;
  const toHex6 = (c: Color | undefined, fallback: string) => {
    if (!c) return fallback;
    const h = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
    return `#${h(c.srgb.r)}${h(c.srgb.g)}${h(c.srgb.b)}`;
  };
  const deep = toHex6(slot("deep") ?? rec.colors[2]?.color, "#1f2937");
  const primary = toHex6(slot("primary") ?? rec.colors[0]?.color, "#334155");
  return {
    background: { kind: "gradient", color: deep, color2: primary, angle: 145 },
    kicker,
    fontHeading: rec.fontHeading,
    fontBody: rec.fontBody,
  };
}

/** Contrast references of a Fill (solid color or gradient stops). */
function fillRefs(fill: Fill | undefined): Color[] {
  const f = fill as unknown as { type?: string; color?: Color; stops?: { color: Color }[] } | undefined;
  if (!f) return [];
  if (f.type === "solid" && f.color) return [f.color];
  if (Array.isArray(f.stops)) return f.stops.map((s) => s.color);
  return [];
}

/** A catalog entry as a generation DeckTheme: the deep-to-primary gradient
 *  reads as the theme's identity at deck scale (the same construction the
 *  reference-image transfer uses), and the pair fonts ride along. */
export function deckThemeFromCatalog(entry: ThemeCatalogEntry, kicker?: string): DeckTheme {
  const [primary, , deep] = entry.colors;
  return {
    background: { kind: "gradient", color: deep, color2: primary, angle: 145 },
    kicker,
    fontHeading: entry.fontHeading,
    fontBody: entry.fontBody,
  };
}

/** A catalog entry as a T19 Theme record (the file's theme field). */
export function themeRecordFromCatalog(entry: ThemeCatalogEntry): Theme {
  return themeFromPalette(
    entry.id,
    entry.colors.map((hex, i) => ({
      id: `${entry.id}-${i}`,
      name: themeSlotNames[i],
      color: hexToColor(hex),
    })),
    { name: entry.name, fontHeading: entry.fontHeading, fontBody: entry.fontBody },
  );
}

function hexToColor(hex: string): { srgb: { r: number; g: number; b: number; a: number } } {
  const n = parseInt(hex.slice(1), 16);
  return { srgb: { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 } };
}

/** Compose a full design file from an outline. Pages are fully laid out
 *  (background + nodes + speaker notes); the theme record is stamped so the
 *  theme picker reflects the generated visual system (T19). The file id is a
 *  placeholder: persistence.Create assigns the real id at the write boundary. */
export function composeDeckFile(input: ComposeDeckInput): DesignFile {
  const outline = normalizeOutline(input.outline);
  const width = Math.max(1, Math.round(input.width));
  const height = Math.max(1, Math.round(input.height));
  // Theme resolution order: an explicit template record (E14), a named
  // catalog theme (E12), else the same title-seeded hue selection as the
  // editor panel, so the API and the panel generate the same deck for the
  // same brief.
  let theme: DeckTheme;
  let record: Theme | null = null;
  if (input.themeRecord) {
    record = input.themeRecord;
    theme = deckThemeFromRecord(record, outline.title);
  } else if (input.themeId) {
    const entry = themeCatalogEntry(input.themeId);
    if (!entry) throw new Error(`unknown themeId: ${input.themeId}`);
    theme = deckThemeFromCatalog(entry, outline.title);
    record = themeRecordFromCatalog(entry);
  } else {
    const seed = Array.from(outline.title).reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7);
    theme = deckThemes({ brandPalette: input.brandPalette ?? [], kicker: outline.title, count: 1, seed })[0];
  }

  let pages: Page[];
  let masters: SlideMaster[] | undefined;
  let layoutsOut: SlideLayout[] | undefined;
  if (input.layoutSet?.layouts?.length) {
    // Layout-grounded composition (E14): the template's own layout system,
    // materialized the way the editor's apply pass does it - deterministic
    // selection, one text box per fillable text slot, layout/master
    // background, readable ink, fonts by role. Picture slots are skipped
    // (headless composition places no images; the editor's queue does).
    masters = structuredClone(input.layoutSet.masters ?? []);
    layoutsOut = structuredClone(input.layoutSet.layouts);
    const layouts = layoutsOut;
    const byId = new Map(layouts.map((l) => [l.id, l] as const));
    const masterById = new Map((masters ?? []).map((m) => [m.id, m] as const));
    const selection = repairLayoutSelection(null, outline.pages, layouts);
    const themedBg = layoutDesign({ layout: "centered", background: theme.background, blocks: [], dir: input.dir ?? "ltr" }, { width, height }).background;
    pages = outline.pages.map((item, i) => {
      const layout = byId.get(selection[i]) ?? layouts[0];
      const master = masterById.get(layout.masterId);
      // Per-role treatment: impact pages (cover, section, quote, closing) keep
      // the deep themed background; reading pages flip to a paper tinted with
      // the same hue, so a deck alternates instead of showing eight identical
      // flat pages. A layout (or its master) that carries its OWN background
      // is an authored decision and always wins.
      const treatment = pageTreatment(item.visualRole, theme.background);
      const treatedBg = treatment.impact
        ? themedBg
        : (layoutDesign({ layout: "centered", background: treatment.background, blocks: [], dir: input.dir ?? "ltr" }, { width, height }).background as Fill);
      const bg = (layout.background ?? (master as { background?: Fill } | undefined)?.background ?? treatedBg) as Fill;
      const ink = readableTextColor(fillRefs(bg));
      const fill = fallbackLayoutFill(layout, item);
      // Proportional shrink when the layout was authored for a larger page
      // (the store's applyLayoutToPage does the same).
      let extentW = 0;
      let extentH = 0;
      for (const ph of layout.placeholders ?? []) {
        extentW = Math.max(extentW, ph.rect.x + ph.rect.width);
        extentH = Math.max(extentH, ph.rect.y + ph.rect.height);
      }
      const sx = extentW > width && extentW > 0 ? width / extentW : 1;
      const sy = extentH > height && extentH > 0 ? height / extentH : 1;
      const children = (layout.placeholders ?? [])
        .filter((ph) => ph.role === "title" || ph.role === "body" || ph.role === "content")
        .map((ph) => {
          const r = { x: ph.rect.x * sx, y: ph.rect.y * sy, width: ph.rect.width * sx, height: ph.rect.height * sy };
          const isTitle = ph.role === "title";
          // Type scale from the slot's own geometry (deckStyle), so a title on
          // a 1920x1080 slide is a title and not the fixed 44px that read as
          // fine print. The content itself then steps down the same ladder
          // when it outruns the slot.
          const scale = slotTypeScale(ph.role as "title" | "body" | "content", r, { width, height });
          const list = fill.lists[ph.id];
          const text = fill.texts[ph.id];
          const paragraphs = list !== undefined && list.length ? list.map((li) => `•  ${li}`) : [text ?? ""];
          const fitted = reflowPage(layout, [{
            nodeId: `probe-${ph.id}`,
            placeholderId: ph.id,
            rect: { width: r.width, height: r.height },
            fontSize: scale.base,
            paragraphs,
          }], { width, height });
          const fontSize = fitted.adjustments[0]?.fontSize ?? scale.base;
          const runStyle = {
            fontFamily: (isTitle ? theme.fontHeading : theme.fontBody) ?? "system",
            fontStyle: isTitle ? "Bold" : "Regular",
            fontSize,
            fill: { type: "solid", color: structuredClone(ink) },
          };
          const paraStyle = { align: "left", direction: "auto" };
          const content = paragraphs.map((line) => ({
            runs: [{ text: line, style: structuredClone(runStyle) }],
            style: structuredClone(paraStyle),
          }));
          return createNode("text", {
            name: isTitle ? "Title" : "Text",
            transform: { x: r.x, y: r.y, scaleX: 1, scaleY: 1, rotation: 0 },
            size: { width: r.width, height: r.height },
            // Middle-anchored: a slot is usually far taller than its text, and
            // top-anchoring left every page's copy clinging to the ceiling
            // above a field of empty background.
            box: { mode: "fixed", width: r.width, height: r.height, autoFit: { enabled: false, min: 8, max: 512 }, verticalAlign: isTitle ? "middle" : "top" },
            data: { placeholderId: ph.id },
            content,
          } as never);
        })
        // An empty slot renders as an empty box; drop boxes with no text at all.
        .filter((n) => {
          const c = (n as unknown as { content: { runs: { text: string }[] }[] }).content;
          return c.some((par) => par.runs.some((run) => run.text.trim()));
        });
      // One accent rule above the title on a reading page: the smallest mark
      // that makes a page read as designed rather than as a text box on a
      // colored rectangle. Skipped when the layout brings its own background
      // (an authored look is never overdrawn) or when the title sits too high
      // for the rule to fit above it.
      const titlePh = (layout.placeholders ?? []).find((p) => p.role === "title");
      const authoredBg = !!(layout.background ?? (master as { background?: Fill } | undefined)?.background);
      if (treatment.accent && titlePh && !authoredBg) {
        const bar = accentRuleRect(
          { x: titlePh.rect.x * sx, y: titlePh.rect.y * sy, width: titlePh.rect.width * sx, height: titlePh.rect.height * sy },
          { width, height },
        );
        const accentColor = fromHex(treatment.accent);
        if (bar && accentColor) {
          children.unshift(createNode("shape", {
            name: "Accent",
            shape: "rect",
            transform: { x: bar.x, y: bar.y, scaleX: 1, scaleY: 1, rotation: 0 },
            size: { width: bar.width, height: bar.height },
            fills: [{ type: "solid", color: accentColor }],
            cornerRadius: Math.round(bar.height / 2),
            // Same tag the editor uses, so a layout change in the editor
            // carries (or drops) a headless-composed deck's rule too.
            data: { accentRule: true },
          } as never) as never);
        }
      }
      return {
        id: `api-page-${i + 1}`,
        name: item.title || `Page ${i + 1}`,
        width,
        height,
        background: structuredClone(bg),
        layoutId: layout.id,
        children,
        ...(item.note ? { notes: item.note } : {}),
      } as unknown as Page;
    });
  } else {
    const deck = layoutDeck(outline, theme, { width, height }, { dir: input.dir });
    pages = deck.pages.map((p, i) => ({
      id: `api-page-${i + 1}`,
      name: p.name || `Page ${i + 1}`,
      width,
      height,
      background: p.background,
      children: p.nodes,
      ...(p.note ? { notes: p.note } : {}),
    }) as unknown as Page);
  }

  const file = {
    format: "hycanvas.design",
    schemaVersion: currentSchemaVersion,
    id: "pending",
    title: outline.title,
    unit: "px",
    dpi: 96,
    pages,
    assets: [],
    fonts: [],
    ...(masters ? { masters } : {}),
    ...(layoutsOut ? { layouts: layoutsOut } : {}),
    theme: record ?? themeRecordFromDeckTheme(theme, { name: outline.theme ? outline.theme.slice(0, 40) : undefined }),
  } as unknown as DesignFile;
  return file;
}
