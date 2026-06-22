// Font catalog. A curated, framework-agnostic list of families the
// editor offers, plus helpers to search them and to build a Google Fonts CSS URL
// the browser font provider uses to lazy-load a family. Uploaded/brand fonts
// (FR-6) are layered on top of this at runtime; this is the built-in library.

export type FontCategory =
  | "sans-serif"
  | "serif"
  | "display"
  | "handwriting"
  | "monospace";

export interface FontCatalogEntry {
  family: string;
  category: FontCategory;
  /** Selectable weights (numeric). */
  weights: number[];
  /** Whether the family ships italic faces. */
  italics?: boolean;
  /** Variable font with continuous axes (FR-6). */
  variable?: boolean;
  /** System stack rather than a downloadable web font. */
  system?: boolean;
}

const W = {
  text: [300, 400, 500, 600, 700],
  full: [100, 200, 300, 400, 500, 600, 700, 800, 900],
  display: [400, 700],
  mono: [400, 500, 700],
};

/** Built-in font library. Web fonts are loaded on demand from Google Fonts. */
export const FONT_CATALOG: FontCatalogEntry[] = [
  { family: "system", category: "sans-serif", weights: [400, 600, 700], system: true },
  // Sans-serif
  { family: "Inter", category: "sans-serif", weights: W.full, italics: true, variable: true },
  { family: "Roboto", category: "sans-serif", weights: [100, 300, 400, 500, 700, 900], italics: true },
  { family: "Open Sans", category: "sans-serif", weights: W.text, italics: true, variable: true },
  { family: "Lato", category: "sans-serif", weights: [100, 300, 400, 700, 900], italics: true },
  { family: "Montserrat", category: "sans-serif", weights: W.full, italics: true, variable: true },
  { family: "Poppins", category: "sans-serif", weights: W.full, italics: true },
  { family: "Nunito", category: "sans-serif", weights: W.text, italics: true, variable: true },
  { family: "Raleway", category: "sans-serif", weights: W.full, italics: true, variable: true },
  { family: "Work Sans", category: "sans-serif", weights: W.full, italics: true, variable: true },
  { family: "DM Sans", category: "sans-serif", weights: [400, 500, 700], italics: true, variable: true },
  { family: "Manrope", category: "sans-serif", weights: [200, 300, 400, 500, 600, 700, 800], variable: true },
  { family: "Figtree", category: "sans-serif", weights: [300, 400, 500, 600, 700, 800, 900], variable: true },
  { family: "Outfit", category: "sans-serif", weights: W.full, variable: true },
  // Serif
  { family: "Playfair Display", category: "serif", weights: [400, 500, 600, 700, 800, 900], italics: true, variable: true },
  { family: "Merriweather", category: "serif", weights: [300, 400, 700, 900], italics: true },
  { family: "Lora", category: "serif", weights: [400, 500, 600, 700], italics: true, variable: true },
  { family: "PT Serif", category: "serif", weights: [400, 700], italics: true },
  { family: "Source Serif 4", category: "serif", weights: W.full, italics: true, variable: true },
  { family: "Roboto Slab", category: "serif", weights: W.full, variable: true },
  // Display
  { family: "Oswald", category: "display", weights: [200, 300, 400, 500, 600, 700], variable: true },
  { family: "Bebas Neue", category: "display", weights: [400] },
  { family: "Archivo Black", category: "display", weights: [400] },
  { family: "Anton", category: "display", weights: [400] },
  // Handwriting
  { family: "Dancing Script", category: "handwriting", weights: [400, 500, 600, 700], variable: true },
  { family: "Pacifico", category: "handwriting", weights: [400] },
  { family: "Caveat", category: "handwriting", weights: [400, 500, 600, 700], variable: true },
  { family: "Lobster", category: "handwriting", weights: [400] },
  // Monospace
  { family: "Roboto Mono", category: "monospace", weights: W.mono, italics: true, variable: true },
  { family: "JetBrains Mono", category: "monospace", weights: [400, 500, 700, 800], italics: true, variable: true },
  { family: "Space Mono", category: "monospace", weights: [400, 700], italics: true },
];

const BY_FAMILY = new Map(FONT_CATALOG.map((f) => [f.family.toLowerCase(), f]));

/** True for the system stack (no web font to load). */
export function isSystemFont(family: string | undefined): boolean {
  return !family || family.toLowerCase() === "system";
}

/** Catalog entry for a family (case-insensitive), or undefined. */
export function getFontEntry(family: string): FontCatalogEntry | undefined {
  return BY_FAMILY.get(family.toLowerCase());
}

/** Search the catalog by free text and optional category, ranked by prefix. */
export function searchFonts(query = "", category?: FontCategory): FontCatalogEntry[] {
  const q = query.trim().toLowerCase();
  const base = category ? FONT_CATALOG.filter((f) => f.category === category) : FONT_CATALOG;
  if (!q) return base;
  return base
    .filter((f) => f.family.toLowerCase().includes(q))
    .sort((a, b) => {
      const ap = a.family.toLowerCase().startsWith(q) ? 0 : 1;
      const bp = b.family.toLowerCase().startsWith(q) ? 0 : 1;
      return ap - bp || a.family.localeCompare(b.family);
    });
}

/**
 * Google Fonts CSS2 URL to load a family's selected weights (and italics when
 * available). The browser provider injects this as a stylesheet, then waits for
 * the face via the CSS Font Loading API.
 */
export function googleFontsCssUrl(family: string, weights: number[] = [400, 700]): string {
  const entry = getFontEntry(family);
  if (!entry || entry.system) return "";
  const name = family.replace(/\s+/g, "+");
  const ws = [...new Set(weights.length ? weights : entry.weights)].sort((a, b) => a - b);
  let axis: string;
  if (entry.italics) {
    const tuples = [
      ...ws.map((w) => `0,${w}`),
      ...ws.map((w) => `1,${w}`),
    ].join(";");
    axis = `:ital,wght@${tuples}`;
  } else {
    axis = `:wght@${ws.join(";")}`;
  }
  return `https://fonts.googleapis.com/css2?family=${name}${axis}&display=swap`;
}
