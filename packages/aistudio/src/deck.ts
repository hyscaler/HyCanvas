// Assemble a whole multi-page design from an outline and a theme.
//
// Each outline page is composed in its archetype's form from one design
// system derived once for the deck, so the result is one system applied
// many ways rather than a stack of unrelated slides. Pure: the store just
// persists the pages. The quality report per page is the verifier that the
// composer stayed honest (no overflow, no overlap, AA contrast).

import type { Fill, Node } from "@hc/schema";
import type { Size } from "./layout";
import { qualityCheck, type QualityReport } from "./quality";
import { repairContrast } from "./repair";
import type { Archetype, DeckTheme, DesignOutline, DesignType, OutlineItem } from "./outline";
import { deriveDesignSystem, type DesignSystem, type DeriveOptions } from "./designSystem";
import { composeArchetypePage, type ComposedPage } from "./archetypes";
import { measureDeck, planVariants, toMeasurable, type DeckReport, type PageVariant } from "./measure";
import { fromHex } from "@hc/color";
import { applyBrand, applyThemeSlots, makeLook, resolveKitStyle } from "./kit/look";
import { composeKitPage, kitFits } from "./kit/render";

export interface DeckPage {
  background: Fill;
  nodes: Node[];
  name: string;
  quality: QualityReport;
  /** Speaker note carried from the outline item; becomes Page.notes. */
  note?: string;
  /** The form the page was composed in. */
  archetype: Archetype;
  /** Placeholder id to English image prompt for every picture region on the
   *  page, so a caller can hand them to the image pipeline. */
  imagePrompts: Record<string, string>;
  /** The outline item the page was set from, kept on the page (Page.data
   *  aiOutline) so a later per-slide regeneration revises the item and sets
   *  it again rather than reading the copy back out of the boxes. */
  item?: OutlineItem;
}

/** What setting one page again, later, needs to know about how the deck was
 *  set and that neither the theme record nor the workspace brand carries:
 *  the composer, the kit style and the deck's voice. Stamped on the file's
 *  meta as `aiDeck`. A deck composed before the recipe existed recomposes
 *  from the theme record and the title, with the style recovered from the
 *  page's own ornament. */
export interface DeckRecipe {
  renderer: "kit" | "classic";
  /** The kit style the deck is set in (kit/looks.ts), when the kit drew it. */
  style?: string;
  look?: string;
  /** The outline's mood phrase, which directs the deck's pictures. */
  mood?: string;
  organization?: string;
  kicker?: string;
  farewell?: string;
  designType?: DesignType;
  fontsAuthored?: boolean;
  /** The six slots the kit wore, or null when it wore the brand alone. */
  themeSlots?: string[] | null;
}

export interface DeckResult {
  title: string;
  pages: DeckPage[];
  /** The system the deck was composed from, for stamping the file's theme. */
  system: DesignSystem;
  /** The reviewer's report on the deck as returned, after the fix pass. */
  report: DeckReport;
  /** Which composer drew the pages. A kit deck draws its own pictures
   *  (drawings in halos, tagged slots for photographs), so a caller adds no
   *  hero picture behind any of its pages. */
  renderer: "kit" | "classic";
  /** How the deck was set, for a later per-slide recomposition. */
  recipe?: DeckRecipe;
}

export type LayoutDeckOptions = DeriveOptions & {
  /** What the pages are; a post or poster carries no deck furniture. */
  designType?: DesignType;
  /** Which composer draws the pages: the kit (the signature templates'
   *  systems and forms; the doors' default for a 16 by 9 deck) or the
   *  classic archetype composer. The kit falls back to the classic composer
   *  for a page it cannot set (a post, a poster, a document). */
  renderer?: "kit" | "classic";
  /** The brand kit's faces, applied to the kit's display and body roles
   *  when `fontsAuthored` is set. */
  brandFonts?: { heading?: string; body?: string };
  /** True when the user chose the catalog theme (a dial, a template), so
   *  the kit wears its six slots; a theme picked by mood for an unbranded
   *  deck does not override the kit's own style. */
  themeChosen?: boolean;
  /** A template theme record's six slots (slotsFromThemeRecord), which the
   *  kit wears the way it wears a chosen catalog theme's. */
  themeSlots?: string[] | null;
};

/** Lay out every outline page into a DeckPage. */
export function layoutDeck(
  outline: DesignOutline,
  theme: DeckTheme,
  size: Size,
  opts?: LayoutDeckOptions,
): DeckResult {
  // Default the kicker to the deck title so content pages carry it, unless the
  // theme already set one.
  const themed: DeckTheme = { ...theme, kicker: theme.kicker ?? outline.title };
  // The outline's own mood phrase directs the deck's pictures unless the
  // caller named one.
  let system = deriveDesignSystem(themed, size, { ...opts, mood: opts?.mood ?? outline.theme, outlineLook: opts?.outlineLook ?? outline.look });
  const total = outline.pages.length;
  // Section dividers are numbered in deck order.
  let sections = 0;
  const sectionNumbers = outline.pages.map((item) => (item.archetype === "section" ? ++sections : undefined));
  // The kit sets a 16 by 9 deck in one of the signature templates' systems:
  // the style the outline named (or one by title seed), repainted in the
  // brand when there is one, with the deck's own voice merged in. The
  // file's theme record then carries the kit's palette and pairing, so the
  // theme picker shows what the pages wear.
  const useKit = opts?.renderer === "kit" && kitFits(size, opts?.designType);
  const chosenSlots = opts?.themeSlots ?? (opts?.themeChosen && opts?.catalog ? opts.catalog.colors : null);
  const styleOpts = { style: outline.style, look: opts?.look ?? opts?.outlineLook ?? outline.look, seed: opts?.seed, mood: [outline.theme, outline.title].filter(Boolean).join(" ") };
  const kitLook = useKit
    ? makeLook(
        applyBrand(chosenSlots ? applyThemeSlots(resolveKitStyle(styleOpts), chosenSlots) : resolveKitStyle(styleOpts), {
          brandPalette: opts?.brandPalette,
          brandFonts: opts?.fontsAuthored ? { heading: opts?.brandFonts?.heading ?? theme.fontHeading, body: opts?.brandFonts?.body ?? theme.fontBody } : undefined,
        }),
        { organization: outline.organization, deckName: outline.title, kicker: outline.kicker, farewell: outline.farewell, total, logo: opts?.logo },
      )
    : null;
  if (kitLook) {
    const c = (hex: string) => fromHex(hex) ?? system.colors.ink;
    system = {
      ...system,
      fonts: { heading: kitLook.display, body: kitLook.body, ...(kitLook.mono ? { mono: kitLook.mono } : {}) },
      colors: { ...system.colors, primary: c(kitLook.paper.accent2), accent: c(kitLook.paper.accent), deep: c(kitLook.deep.bg), tint: c(kitLook.paper.panel), ink: c(kitLook.paper.ink), paper: c(kitLook.paper.bg) },
      radius: kitLook.radius,
    };
  }
  const signatureUsed = { value: false };
  const composeAll = (variants: Record<number, PageVariant>) => {
    signatureUsed.value = false;
    return outline.pages.map((item, i) =>
      kitLook
        ? composeKitPage(item, kitLook, { index: i, total, section: sectionNumbers[i], designType: opts?.designType, motion: system.motion, scale: size.width / 1920, artDirection: system.artDirection, signatureUsed })
        : composeArchetypePage(item, system, { index: i, total, variant: variants[i], section: sectionNumbers[i], designType: opts?.designType }),
    );
  };
  // Look, and fix what a look can fix: a text the checker would flag for
  // contrast is re-inked before it is measured, so the report says what
  // shipped and not what almost did.
  const measure = (composed: ComposedPage[]) =>
    measureDeck(
      composed.map((c) => {
        const page = { background: c.background, nodes: c.nodes, size: system.size };
        const repairs = repairContrast(page);
        return toMeasurable(c, qualityCheck(page).issues, repairs);
      }),
      system.size,
      system.margin,
    );
  // Compose, look, fix once, look again. The fix pass is deterministic
  // (variants for monotony and sparseness); what it cannot fix, overfull
  // copy, stays in the report for the caller.
  let composed = composeAll({});
  let report = measure(composed);
  // The kit's forms carry their own rhythm; variants are the classic
  // composer's remedy and are not re-composed for.
  const variants = kitLook ? {} : planVariants(report, outline);
  if (Object.keys(variants).length) {
    composed = composeAll(variants);
    report = measure(composed);
  }
  const pages: DeckPage[] = composed.map((c, i) => ({
    background: c.background,
    nodes: c.nodes,
    name: outline.pages[i].title || `Page ${i + 1}`,
    quality: { ok: report.pages[i].issues.length === 0, issues: report.pages[i].issues },
    archetype: c.archetype,
    imagePrompts: c.imagePrompts,
    item: outline.pages[i],
    ...(outline.pages[i].note ? { note: outline.pages[i].note } : {}),
  }));
  const recipe: DeckRecipe = {
    renderer: kitLook ? "kit" : "classic",
    ...(kitLook ? { style: kitLook.name } : {}),
    ...(typeof styleOpts.look === "string" && styleOpts.look ? { look: styleOpts.look } : {}),
    ...(outline.theme ? { mood: outline.theme } : {}),
    ...(outline.organization ? { organization: outline.organization } : {}),
    ...(outline.kicker ? { kicker: outline.kicker } : {}),
    ...(outline.farewell ? { farewell: outline.farewell } : {}),
    ...(opts?.designType ? { designType: opts.designType } : {}),
    fontsAuthored: !!opts?.fontsAuthored,
    themeSlots: chosenSlots ?? null,
  };
  return { title: outline.title, pages, system, report, renderer: kitLook ? "kit" : "classic", recipe };
}
