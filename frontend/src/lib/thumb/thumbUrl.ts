// The downscaled variant of an uploaded image, for drawing it small.
//
// A design references its images by their content URL
// (/api/v1/assets/<id>/content). The server also serves the same image at a
// few fixed widths (/thumb?w=), made on first request, and falls back to the
// original for anything it has no smaller copy of (a video, an SVG, an image
// that is already small). So a preview can ask for the thumb of every asset
// and download kilobytes where the editor downloads the full files (#77).
// Anything that is not an asset content URL (a data URL, a stock or template
// path, an external host) is returned unchanged.

const CONTENT_RE = /^(.*\/v1\/assets\/[^/?#]+)\/content(?:\?[^#]*)?(#.*)?$/;

/** Pixels a preview needs, as the smallest of the server's variant widths
 *  that covers a card `cssWidth` wide at `dpr`. An image fills at most the
 *  whole page, so the card's own width is the most any image needs. */
export function thumbWidthFor(cssWidth: number, dpr: number): number {
  const px = Math.max(1, Math.round(cssWidth * dpr));
  return px <= 256 ? 256 : px <= 512 ? 512 : 1024;
}

/**
 * Whether a preview should download the web fonts its text is set in. A grid
 * of cards can name dozens of families, so it is skipped where that is a poor
 * trade: a data-saver or 2G/3G connection, and template cards on a phone (the
 * user's own designs still get their real faces there). The text then draws in
 * fallback faces, which is all previews did before they loaded fonts.
 */
export function previewFontsWanted(isTemplate: boolean): boolean {
  if (typeof navigator === "undefined") return false;
  const conn = (navigator as unknown as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (conn?.saveData) return false;
  if (conn?.effectiveType && /2g|3g/.test(conn.effectiveType)) return false;
  if (isTemplate && typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia("(pointer: coarse) and (max-width: 640px)").matches) return false;
  return true;
}

/** `url` rewritten to its downscaled variant at `width` px, when it is an
 *  uploaded asset's content URL; otherwise `url` itself. */
export function thumbUrl(url: string, width: number): string {
  if (!url || url.startsWith("data:") || url.startsWith("blob:")) return url;
  const m = CONTENT_RE.exec(url);
  if (!m) return url;
  return `${m[1]}/thumb?w=${Math.max(1, Math.round(width))}`;
}
