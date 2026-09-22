// Unicode text segmentation via the platform Intl.Segmenter (available in
// modern browsers and Node 18+). Caret/selection operate on grapheme clusters,
// not code units, and line breaking uses word segments.

export function graphemes(text: string, locale?: string): string[] {
  const seg = new Intl.Segmenter(locale, { granularity: "grapheme" });
  return Array.from(seg.segment(text), (s) => s.segment);
}

/** Count of grapheme clusters (the user-perceived character count). */
export function graphemeCount(text: string, locale?: string): number {
  return graphemes(text, locale).length;
}

/** Word-like segments (excludes whitespace/punctuation-only segments). */
export function words(text: string, locale?: string): string[] {
  const seg = new Intl.Segmenter(locale, { granularity: "word" });
  const out: string[] = [];
  for (const s of seg.segment(text)) if (s.isWordLike) out.push(s.segment);
  return out;
}

export interface WrapChunk {
  text: string;
  /** True for whitespace-only chunks (collapsible at a line break). */
  whitespace: boolean;
}

/**
 * Split text into chunks at word boundaries for line breaking: each word-like
 * segment and each run of trailing whitespace becomes a chunk, so a line break
 * may occur between any two chunks.
 */
export function wrapChunks(text: string, locale?: string): WrapChunk[] {
  const seg = new Intl.Segmenter(locale, { granularity: "word" });
  const out: WrapChunk[] = [];
  // A no-break space glues its neighbors: it is never a break opportunity
  // and the word before it and the word after it wrap as one chunk. That is
  // how a heading keeps its last word off a line of its own, and how the
  // server exporter already breaks (it treats these as letters).
  let glue = false;
  for (const s of seg.segment(text)) {
    const t = s.segment;
    const noBreak = NO_BREAK.test(t);
    const last = out[out.length - 1];
    if (last && !last.whitespace && (glue || noBreak)) last.text += t;
    else out.push({ text: t, whitespace: !noBreak && /^\s+$/.test(t) });
    glue = noBreak;
  }
  return out;
}

/** Spaces that keep the words around them together: no-break space, figure
 *  space, narrow no-break space, word joiner, zero-width no-break space. */
const NO_BREAK = /^[\u00A0\u2007\u202F\u2060\uFEFF]+$/;
