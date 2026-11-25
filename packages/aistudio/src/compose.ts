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
  roundedCorners,
  themeFromPalette,
  type DesignFile,
  type Fill,
  type Node,
  type Page,
  type SlideLayout,
  type SlideMaster,
  type Theme,
} from "@hc/schema";
import { fromHex } from "@hc/color";
import { normalizeOutline, type DesignType } from "./outline";
import { deckThemes } from "./theme";
import { layoutDeck, type DeckRecipe } from "./deck";
import { slotsFromThemeRecord } from "./kit/look";
import { layoutDesign, readableTextColor } from "./layout";
import type { DesignSystem } from "./designSystem";
import { fallbackLayoutFill, repairLayoutSelection } from "./layoutSchema";
import { accentRuleRect, pageTreatment, slotTypeScale } from "./deckStyle";
import { reflowPage } from "./reflow";
import { themeSlotNames } from "./themeGen";
import { qualityCheck } from "./quality";
import { repairContrast } from "./repair";
import { catalogEntryForMood, designSystemSlots, type DeckLogo, type DeckMotion } from "./designSystem";
import { applyMotion } from "./archetypes";
import { measureDeck, type DeckReport } from "./measure";
import { themeCatalogEntry, type ThemeCatalogEntry } from "./themeCatalog";
import type { DeckTheme } from "./outline";
import type { Color } from "@hc/schema";
import { deckThemeFromCatalog, deckThemeFromRecord, themeRecordFromCatalog, themeRecordFromDesignSystem, themeRecordFromSlots } from "./themeRecords";

export { deckThemeFromCatalog, deckThemeFromRecord, themeRecordFromCatalog, themeRecordFromDesignSystem } from "./themeRecords";

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
  /** Entrance motion on the composed pages: "subtle" (default) or "none". */
  motion?: DeckMotion;
  /** The brand kit's faces by role; the generated theme sets headings and
   *  body in them. A catalog theme or a template keeps its own. */
  brandFonts?: { heading?: string; body?: string };
  /** The brand kit's primary logo, placed on every archetype page and listed
   *  in the file's assets. */
  logo?: DeckLogo | null;
  /** What the pages are: "deck" (default), "doc", "poster" or "social" /
   *  "social-set". A post or poster composes without deck furniture. */
  designType?: string;
  /** The deck's house style: "classic", "editorial", "bold" or "technical".
   *  Overrides the look the outline named; a catalog style stands in for both. */
  look?: string;
  /** Which composer draws a deck's pages: the kit (the default) or the
   *  classic archetype composer. */
  renderer?: "kit" | "classic";
}

/** Contrast references of a Fill (solid color or gradient stops). */
function fillRefs(fill: Fill | undefined): Color[] {
  const f = fill as unknown as { type?: string; color?: Color; stops?: { color: Color }[] } | undefined;
  if (!f) return [];
  if (f.type === "solid" && f.color) return [f.color];
  if (Array.isArray(f.stops)) return f.stops.map((s) => s.color);
  return [];
}

/** Compose a full design file from an outline. Pages are fully laid out
 *  (background + nodes + speaker notes); the theme record is stamped so the
 *  theme picker reflects the generated visual system (T19). The file id is a
 *  placeholder: persistence.Create assigns the real id at the write boundary. */
export function composeDeckFile(input: ComposeDeckInput): DesignFile {
  return composeDeckFileWithReport(input).file;
}

/** composeDeckFile plus the reviewer's report: which pages carry copy the
 *  composer could not fit, how sparse each is, whether a form repeats. The
 *  API uses it to hand overfull copy back to the model once. */
export function composeDeckFileWithReport(input: ComposeDeckInput): { file: DesignFile; report: DeckReport } {
  const outline = normalizeOutline(input.outline);
  const width = Math.max(1, Math.round(input.width));
  const height = Math.max(1, Math.round(input.height));
  // Theme resolution order: an explicit template record (E14), a named
  // catalog theme (E12), else the same title-seeded hue selection as the
  // editor panel, so the API and the panel generate the same deck for the
  // same brief.
  let theme: DeckTheme;
  let record: Theme | null = null;
  // The catalog entry the design system draws its six slots and type pairing
  // from. Named themes use their own; a deck with neither theme nor brand
  // takes one by title seed, so an unbranded brief still gets a designed
  // palette and a real pairing rather than a lone hue and the system font.
  let catalog: ThemeCatalogEntry | null = null;
  const seed = Array.from(outline.title).reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7);
  if (input.themeRecord) {
    record = input.themeRecord;
    theme = deckThemeFromRecord(record, outline.title);
  } else if (input.themeId) {
    const entry = themeCatalogEntry(input.themeId);
    if (!entry) throw new Error(`unknown themeId: ${input.themeId}`);
    theme = deckThemeFromCatalog(entry, outline.title);
    record = themeRecordFromCatalog(entry);
    catalog = entry;
  } else {
    theme = deckThemes({ brandPalette: input.brandPalette ?? [], kicker: outline.title, count: 1, seed, fontHeading: input.brandFonts?.heading, fontBody: input.brandFonts?.body })[0];
    if (!(input.brandPalette ?? []).length) catalog = catalogEntryForMood(outline.theme, seed);
  }

  let pages: Page[];
  let masters: SlideMaster[] | undefined;
  let layoutsOut: SlideLayout[] | undefined;
  let system: DesignSystem | null = null;
  let report: DeckReport | null = null;
  let recipe: DeckRecipe | null = null;
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
    const overfullByPage: string[][] = [];
    pages = outline.pages.map((item, i) => {
      const overfull: string[] = [];
      overfullByPage.push(overfull);
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
          // Points are real list items: the text engine and every exporter
          // draw the marker in a gutter, so the copy carries no bullet
          // character and the estimate below takes the gutter off the width.
          const isList = list !== undefined && list.length > 0;
          const paragraphs = isList ? list : [text ?? ""];
          const fitted = reflowPage(layout, [{
            nodeId: `probe-${ph.id}`,
            placeholderId: ph.id,
            rect: { width: r.width, height: r.height },
            fontSize: scale.base,
            paragraphs,
            list: isList,
          }], { width, height });
          const fontSize = fitted.adjustments[0]?.fontSize ?? scale.base;
          if (fitted.verdicts[ph.id] === "overfull") overfull.push(ph.id);
          const runStyle = {
            fontFamily: (isTitle ? theme.fontHeading : theme.fontBody) ?? "system",
            fontStyle: isTitle ? "Bold" : "Regular",
            fontSize,
            fill: { type: "solid", color: structuredClone(ink) },
          };
          const paraStyle = { align: "left", direction: "auto", ...(isList ? { list: { type: "bullet", level: 0 } } : {}) };
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
            // Both anchored to the middle of their slot. A middle title over a
            // top-anchored body put them on different baselines and left the
            // lower half of every reading page empty.
            box: { mode: "fixed", width: r.width, height: r.height, autoFit: { enabled: false, min: 8, max: 512 }, verticalAlign: "middle" },
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
            cornerRadius: roundedCorners(Math.round(bar.height / 2)),
            // Same tag the editor uses, so a layout change in the editor
            // carries (or drops) a headless-composed deck's rule too.
            data: { accentRule: true },
          } as never) as never);
        }
      }
      // The same quiet reveal the archetype door gives its pages.
      applyMotion(children as Array<{ name?: string; animation?: unknown }>, input.motion ?? "subtle");
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
    report = measureDeck(
      pages.map((pg, i) => {
        const page = { background: pg.background as Fill, nodes: pg.children as Node[], size: { width, height } };
        const repairs = repairContrast(page);
        return {
          archetype: (outline.pages[i].archetype ?? "bullets"),
          impact: pageTreatment(outline.pages[i].visualRole, theme.background).impact,
          nodes: pg.children as Node[],
          overfull: overfullByPage[i],
          issues: qualityCheck(page).issues,
          repairs,
        };
      }),
      { width, height },
      Math.round(Math.min(width, height) * 0.012) * 6,
    );
  } else {
    const dt = (input.designType ?? "").toLowerCase();
    const designType: DesignType = dt === "social" || dt === "social-set" ? "social-set" : dt === "poster" ? "poster" : dt === "doc" ? "doc" : "deck";
    // A brand kit or a theme the caller chose authored the fonts; a look's
    // own pairing must not replace them.
    const fontsAuthored = !!(input.brandFonts?.heading || input.brandFonts?.body || input.themeId || input.themeRecord);
    const deck = layoutDeck(outline, theme, { width, height }, { dir: input.dir, catalog, brandPalette: input.brandPalette, seed, motion: input.motion, logo: input.logo, designType, look: input.look, outlineLook: outline.look, fontsAuthored, renderer: input.renderer === "classic" ? "classic" : "kit", brandFonts: input.brandFonts, themeChosen: !!(input.themeId || input.themeRecord), themeSlots: input.themeRecord ? slotsFromThemeRecord(input.themeRecord) : null });
    system = deck.system;
    report = deck.report;
    recipe = deck.recipe ?? null;
    pages = deck.pages.map((p, i) => ({
      id: `api-page-${i + 1}`,
      name: p.name || `Page ${i + 1}`,
      width,
      height,
      background: p.background,
      children: p.nodes,
      ...(p.note ? { notes: p.note } : {}),
      // The item the page was set from, so the editor can revise and set
      // this one page again later (per-slide regeneration).
      ...(p.item ? { data: { aiOutline: p.item } } : {}),
    }) as unknown as Page);
  }

  const file = {
    format: "hycanvas.design",
    schemaVersion: currentSchemaVersion,
    id: "pending",
    title: outline.title,
    unit: "px",
    dpi: 96,
    // Required by the file schema even when empty; the editor tolerates its
    // absence on load but the .hyc door validates strictly. A composed deck
    // records how it was set, for per-slide regeneration in the editor.
    meta: recipe ? { aiDeck: recipe } : {},
    pages,
    // The logo is the one asset a composed deck references before any
    // picture lands; the archetype door placed it on every page.
    assets: system?.logo ? [{ id: system.logo.assetId, kind: "image", url: system.logo.url, mime: "image/*", checksum: "" }] : [],
    fonts: [],
    ...(masters ? { masters } : {}),
    ...(layoutsOut ? { layouts: layoutsOut } : {}),
    // The file's theme record carries the very slots the pages were painted
    // with, so the theme picker shows the deck's palette and a later swap can
    // remap it precisely.
    // The record carries the pairing the pages were set in: the design
    // system's, which is the look's or the seeded one for an unbranded deck,
    // as the editor door already stamps it. The deck theme's own fonts are
    // empty for such a deck and used to leave the record with none.
    theme: record ?? (system ? themeRecordFromDesignSystem(system, theme, outline.theme) : themeRecordFromSlots(null, theme, outline.theme)),
  } as unknown as DesignFile;
  return { file, report: report ?? { pages: [], bulletShare: 0, repetition: [], shorten: [], ok: true } };
}
