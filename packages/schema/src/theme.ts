// Slide master / layout / theme cascade (doc 28 FR-3, FR-4).
//
// Pure resolution helpers over the open format. The cascade is
// page -> layout -> master -> file theme, and every level is optional, so a
// deck with no masters behaves exactly as it always has: `resolvePageStyle`
// simply returns the page's own background and no placeholders.
//
// Nothing here mutates the design. `applyTheme` returns a new file, because
// swapping a deck's theme must be one undoable action (FR-4).

import type { Color, ColorSwatch, DesignFile, Fill, Page, Placeholder, PlaceholderRole, SlideLayout, SlideMaster, Theme } from "./schema";

/** The layout a page inherits from, or undefined when it stands alone (no
 *  `layoutId`, or one that dangles because the layout was deleted). */
export function layoutForPage(file: DesignFile, page: Page): SlideLayout | undefined {
  if (!page.layoutId) return undefined;
  return file.layouts?.find((l) => l.id === page.layoutId);
}

/** The master behind a layout, or undefined when the reference dangles. */
export function masterForLayout(file: DesignFile, layout: SlideLayout | undefined): SlideMaster | undefined {
  if (!layout) return undefined;
  return file.masters?.find((m) => m.id === layout.masterId);
}

/** The theme in effect for a page: the master's named theme when it resolves,
 *  else the file theme. */
export function themeForPage(file: DesignFile, page: Page): Theme | undefined {
  const master = masterForLayout(file, layoutForPage(file, page));
  if (master?.theme && file.theme?.id === master.theme) return file.theme;
  return file.theme;
}

/** Placeholders a page inherits: the master's, with the layout's overriding by
 *  `id` and appended when new. Keyed by id, not role, because a layout may
 *  legitimately declare several of a role (two-content has two `content`
 *  regions). A page with no layout inherits none, the pre-master behavior. */
export function placeholdersForPage(file: DesignFile, page: Page): Placeholder[] {
  const layout = layoutForPage(file, page);
  if (!layout) return [];
  const master = masterForLayout(file, layout);
  const byId = new Map<string, Placeholder>();
  for (const p of master?.placeholders ?? []) byId.set(p.id, p);
  for (const p of layout.placeholders) byId.set(p.id, p); // layout wins
  return [...byId.values()];
}

/** The resolved style for rendering a page: its own background when set, else
 *  the layout's, else the master's. */
export function resolvePageStyle(file: DesignFile, page: Page): { background?: Fill; placeholders: Placeholder[] } {
  const layout = layoutForPage(file, page);
  const master = masterForLayout(file, layout);
  return {
    background: page.background ?? layout?.background ?? master?.background,
    placeholders: placeholdersForPage(file, page),
  };
}

/** The title placeholder for a page, if its layout declares one. Its presence
 *  is what guarantees a real, screen-reader-navigable slide title (FR-3). */
export function titlePlaceholder(file: DesignFile, page: Page): Placeholder | undefined {
  return placeholdersForPage(file, page).find((p) => p.role === "title");
}

/** A page's accessible title: its name, else the deck position. Never empty, so
 *  an exported deck always has per-slide titles (FR-29). */
export function slideTitle(page: Page, index: number): string {
  const name = page.name?.trim();
  return name && name.length ? name : `Slide ${index + 1}`;
}

/** Look up a theme color slot by index; undefined when out of range. */
export function themeColor(theme: Theme | undefined, slot: number): Color | undefined {
  return theme?.colors[slot]?.color;
}

/**
 * Adopt `theme` for the whole deck (FR-4).
 *
 * Purely a file-level swap: the theme record is replaced and every master that
 * named the OLD theme is repointed at the new one, so the cascade keeps
 * resolving. Page content is untouched (recoloring individual nodes is the
 * separate "re-skin" operation the Brand panel already owns), which is what
 * keeps this a safe, reversible, single undo step.
 */
export function applyTheme(file: DesignFile, theme: Theme): DesignFile {
  const prevId = file.theme?.id;
  const masters = file.masters?.map((m) => (m.theme && m.theme === prevId ? { ...m, theme: theme.id } : m));
  return { ...file, theme, ...(masters ? { masters } : {}) };
}

/** A theme's variant as a full theme (variants only override the palette). */
export function themeVariant(theme: Theme, variantId: string): Theme | undefined {
  const v = theme.variants?.find((x) => x.id === variantId);
  if (!v) return undefined;
  return { ...theme, id: v.id, name: v.name ?? theme.name, colors: v.colors, variants: theme.variants };
}

/** Build a theme from a flat palette + font pair, so a deck that predates the
 *  theme record (or a brand kit) can adopt one without hand-authoring it. */
export function themeFromPalette(
  id: string,
  colors: ColorSwatch[],
  opts: { name?: string; fontHeading?: string; fontBody?: string } = {},
): Theme {
  return { id, name: opts.name, colors, fontHeading: opts.fontHeading, fontBody: opts.fontBody };
}

// ---------------------------------------------------------------------------
// Built-in masters and layouts (doc 28 FR-3)
// ---------------------------------------------------------------------------

/** Percentage rect -> absolute, so the built-ins fit any page size. */
function rect(page: { width: number; height: number }, x: number, y: number, w: number, h: number) {
  return { x: page.width * x, y: page.height * y, width: page.width * w, height: page.height * h };
}

export const builtinMasterId = "master-default";

/** The default master + the five built-in layouts PowerPoint users expect
 *  (title, title+content, two-content, comparison, picture). Sized to `page`,
 *  so a 16:9 deck and an A4 deck both get sane placeholder rects. */
/** Derive capacity hints for a placeholder from its rect (as page fractions)
 *  and role, per the chars-per-area heuristic layout-grounded generation uses:
 *  titles cap at a headline length, bodies scale with area up to a few hundred
 *  characters, content slots also bound their list length; the floor is about
 *  half the ceiling so a slot is neither overflowed nor left looking empty
 *  (F28 T11). Picture/chart/media/footer roles carry no text capacity. */
export function capacityForPlaceholder(
  role: PlaceholderRole,
  rect: { width: number; height: number },
  page: { width: number; height: number },
): Pick<Placeholder, "maxChars" | "minChars" | "minItems" | "maxItems"> {
  const wFrac = rect.width / page.width;
  const hFrac = rect.height / page.height;
  const area = wFrac * hFrac;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));
  switch (role) {
    case "title": {
      const max = clamp(45 * wFrac + 120 * area, 20, 60);
      return { maxChars: max, minChars: Math.round(max / 2) };
    }
    case "body": {
      const max = clamp(1800 * area, 40, 300);
      return { maxChars: max, minChars: Math.round(max / 2) };
    }
    case "content": {
      const max = clamp(1500 * area, 100, 500);
      return { maxChars: max, minChars: Math.round(max / 2), minItems: 2, maxItems: clamp(12 * hFrac, 3, 6) };
    }
    default:
      return {};
  }
}

export function builtinMasterAndLayouts(page: { width: number; height: number }): {
  master: SlideMaster;
  layouts: SlideLayout[];
} {
  const master: SlideMaster = {
    id: builtinMasterId,
    name: "Default",
    placeholders: [{ id: "ph-footer", role: "footer", rect: rect(page, 0.06, 0.9, 0.88, 0.06) }],
  };
  const L = (id: string, name: string, placeholders: Placeholder[]): SlideLayout => ({
    id,
    masterId: master.id,
    name,
    // Built-ins carry capacity hints derived from their rects (v21) so
    // layout-grounded generation can size content; user-captured layouts may
    // leave them unset.
    placeholders: placeholders.map((ph) => ({ ...ph, ...capacityForPlaceholder(ph.role, ph.rect, page) })),
  });
  return {
    master,
    layouts: [
      L("layout-title", "Title", [
        { id: "ph-title", role: "title", rect: rect(page, 0.1, 0.34, 0.8, 0.18) },
        { id: "ph-sub", role: "body", rect: rect(page, 0.1, 0.54, 0.8, 0.12) },
      ]),
      L("layout-title-content", "Title and content", [
        { id: "ph-title", role: "title", rect: rect(page, 0.06, 0.08, 0.88, 0.14) },
        { id: "ph-content", role: "content", rect: rect(page, 0.06, 0.26, 0.88, 0.6) },
      ]),
      L("layout-two-content", "Two content", [
        { id: "ph-title", role: "title", rect: rect(page, 0.06, 0.08, 0.88, 0.14) },
        { id: "ph-left", role: "content", rect: rect(page, 0.06, 0.26, 0.42, 0.6) },
        { id: "ph-right", role: "content", rect: rect(page, 0.52, 0.26, 0.42, 0.6) },
      ]),
      L("layout-comparison", "Comparison", [
        { id: "ph-title", role: "title", rect: rect(page, 0.06, 0.06, 0.88, 0.12) },
        { id: "ph-left-h", role: "body", rect: rect(page, 0.06, 0.22, 0.42, 0.08) },
        { id: "ph-left", role: "content", rect: rect(page, 0.06, 0.32, 0.42, 0.54) },
        { id: "ph-right-h", role: "body", rect: rect(page, 0.52, 0.22, 0.42, 0.08) },
        { id: "ph-right", role: "content", rect: rect(page, 0.52, 0.32, 0.42, 0.54) },
      ]),
      L("layout-picture", "Picture with caption", [
        { id: "ph-title", role: "title", rect: rect(page, 0.06, 0.08, 0.88, 0.12) },
        { id: "ph-pic", role: "picture", rect: rect(page, 0.06, 0.24, 0.56, 0.62) },
        { id: "ph-cap", role: "body", rect: rect(page, 0.66, 0.24, 0.28, 0.62) },
      ]),
    ],
  };
}
