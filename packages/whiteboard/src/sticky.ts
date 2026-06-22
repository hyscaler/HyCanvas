// Sticky-note font auto-fit heuristic (FR-3). Pure, no DOM/measurement.
// Estimates how large the text can be while still fitting the card, using an
// average glyph-width factor and a line-height factor. Returns a fontScale
// multiplier (relative to basePx) clamped to [minScale, maxScale].

export interface StickyFitOpts {
  basePx?: number; // nominal font size at scale 1
  minScale?: number;
  maxScale?: number;
}

const AVG_GLYPH_WIDTH = 0.55; // fraction of font px per character (rough)
const LINE_HEIGHT = 1.25; // multiple of font px per line
const PADDING = 0.12; // fraction of each dimension reserved as inner padding

/**
 * Find a fontScale so the (word-wrapped) text fits within width x height.
 * Monotonic in text length: more text yields a smaller-or-equal scale.
 *
 * Approach: for a candidate font size, estimate characters-per-line from the
 * usable width and required lines from the character count, then check the
 * total text height fits the usable height. Binary-search the largest fitting
 * size, then convert to a scale and clamp.
 */
export function fitStickyFontScale(
  text: string,
  width: number,
  height: number,
  opts: StickyFitOpts = {},
): number {
  const basePx = opts.basePx ?? 24;
  const minScale = opts.minScale ?? 0.25;
  const maxScale = opts.maxScale ?? 3;

  const usableW = Math.max(1, width * (1 - PADDING * 2));
  const usableH = Math.max(1, height * (1 - PADDING * 2));

  // Empty text always fits at the maximum scale.
  const chars = text.length;
  if (chars === 0) return clamp(maxScale, minScale, maxScale);

  // Longest single word sets a hard lower bound on characters-per-line (a word
  // cannot be split), so very long words force a smaller size.
  const longestWord = text
    .split(/\s+/)
    .reduce((m, w) => Math.max(m, w.length), 0);

  const fits = (fontPx: number): boolean => {
    const glyphW = fontPx * AVG_GLYPH_WIDTH;
    const charsPerLine = Math.max(1, Math.floor(usableW / glyphW));
    // A single word must fit on one line.
    if (longestWord > charsPerLine) return false;
    const lines = Math.max(1, Math.ceil(chars / charsPerLine));
    const lineH = fontPx * LINE_HEIGHT;
    return lines * lineH <= usableH;
  };

  // Binary search the largest fitting font size within the scale-derived bounds.
  let lo = basePx * minScale;
  let hi = basePx * maxScale;
  if (fits(hi)) return clamp(maxScale, minScale, maxScale);
  if (!fits(lo)) return clamp(minScale, minScale, maxScale);

  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return clamp(lo / basePx, minScale, maxScale);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
