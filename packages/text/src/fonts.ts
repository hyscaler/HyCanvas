// Font catalog. The full open-source font library (Bunny's keyless mirror of the
// Google Fonts families), bundled as metadata so search works offline with no API
// key, plus helpers to search it and to build the CSS2 URL the browser font
// provider uses to lazy-load a family. A small featured set is surfaced first.
// Uploaded/brand fonts (FR-6) are layered on top of this at runtime.

import { GENERATED_FONTS } from "./font-catalog.generated";

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

// Families surfaced first (in this order) in the no-query view; the rest of the
// library follows alphabetically. Weights/italics/variable for every family come
// from the generated Bunny catalog, so a family's CSS request always matches what
// the provider can actually serve.
const FEATURED_ORDER = [
  "Inter", "Roboto", "Open Sans", "Lato", "Montserrat", "Poppins", "Nunito",
  "Raleway", "Work Sans", "DM Sans", "Manrope", "Figtree", "Outfit",
  "Playfair Display", "Merriweather", "Lora", "PT Serif", "Source Serif 4", "Roboto Slab",
  "Oswald", "Bebas Neue", "Archivo Black", "Anton",
  "Dancing Script", "Pacifico", "Caveat", "Lobster",
  "Roboto Mono", "JetBrains Mono", "Space Mono",
];

const SYSTEM_ENTRY: FontCatalogEntry = { family: "system", category: "sans-serif", weights: [400, 600, 700], system: true };

/**
 * Built-in font library: the system stack, then the featured families (in
 * FEATURED_ORDER), then the rest of the full open-source library (Bunny's mirror
 * of Google Fonts, ~2k families) alphabetically. Metadata is bundled so search
 * works offline with no API key; each family's web font is fetched on demand from
 * the configured provider (Bunny) when it is previewed or applied.
 */
export const FONT_CATALOG: FontCatalogEntry[] = (() => {
  const byName = new Map(GENERATED_FONTS.map((f) => [f.family.toLowerCase(), f]));
  const seen = new Set<string>();
  const featured: FontCatalogEntry[] = [];
  for (const name of FEATURED_ORDER) {
    const key = name.toLowerCase();
    const e = byName.get(key);
    if (e && !seen.has(key)) { featured.push(e); seen.add(key); }
  }
  const rest = GENERATED_FONTS.filter((f) => !seen.has(f.family.toLowerCase()));
  return [SYSTEM_ENTRY, ...featured, ...rest];
})();

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

// Where webfont CSS is loaded from. Bunny Fonts (fonts.bunny.net) is the
// default: it is a keyless, GDPR-safe mirror that serves the SAME open-source
// fonts as Google via a CSS2-compatible endpoint, but with a stated zero-
// logging policy, so a self-hosted instance does not leak end-user IPs to
// Google on every page. Self-hosters who prefer Google can switch the host.
const FONT_CSS_HOSTS = {
  bunny: "https://fonts.bunny.net/css2",
  google: "https://fonts.googleapis.com/css2",
} as const;
export type FontCssProvider = keyof typeof FONT_CSS_HOSTS;
let fontCssHost: string = FONT_CSS_HOSTS.bunny;

/** Switch the webfont CSS source ("bunny" default, or "google"). */
export function setFontCssProvider(provider: FontCssProvider): void {
  fontCssHost = FONT_CSS_HOSTS[provider] ?? FONT_CSS_HOSTS.bunny;
}

/**
 * Webfont CSS URL to load a family's selected weights (and italics when
 * available), from the configured provider (Bunny by default, Google
 * optional; the CSS2 request syntax is identical on both). The browser
 * provider injects this as a stylesheet, then waits for the face via the CSS
 * Font Loading API. Empty string for system/unknown families.
 */
export function fontCssUrl(family: string, weights: number[] = [400, 700]): string {
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
  return `${fontCssHost}?family=${name}${axis}&display=swap`;
}

/** @deprecated use fontCssUrl; kept so existing imports keep compiling. */
export const googleFontsCssUrl = fontCssUrl;
