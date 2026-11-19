// Unicode text segmentation via the platform Intl.Segmenter (available in
// modern browsers and Node 18+). Caret/selection operate on grapheme clusters,
// not code units, and line breaking uses word segments.

// Building an Intl.Segmenter is far more expensive than using one, and text is
// laid out on every canvas repaint, so keep one per locale and granularity.
const segmenters = new Map<string, Intl.Segmenter>();
function segmenter(locale: string | undefined, granularity: "grapheme" | "word"): Intl.Segmenter {
  const key = `${granularity}|${locale ?? ""}`;
  let seg = segmenters.get(key);
  if (!seg) {
    seg = new Intl.Segmenter(locale, { granularity });
    segmenters.set(key, seg);
  }
  return seg;
}

export function graphemes(text: string, locale?: string): string[] {
  const seg = segmenter(locale, "grapheme");
  return Array.from(seg.segment(text), (s) => s.segment);
}

/** Count of grapheme clusters (the user-perceived character count). */
export function graphemeCount(text: string, locale?: string): number {
  return graphemes(text, locale).length;
}

/** Word-like segments (excludes whitespace/punctuation-only segments). */
export function words(text: string, locale?: string): string[] {
  const seg = segmenter(locale, "word");
  const out: string[] = [];
  for (const s of seg.segment(text)) if (s.isWordLike) out.push(s.segment);
  return out;
}

export interface WrapChunk {
  text: string;
  /** True for whitespace-only chunks (collapsible at a line break). */
  whitespace: boolean;
}

// wrapChunks depends only on its text and locale, and the same runs are split
// again on every repaint (a pan redraws every text box each frame), so results
// are memoized. Bounded: the whole map is dropped when it fills up.
const WRAP_CACHE_MAX = 4096;
const wrapCache = new Map<string, readonly Readonly<WrapChunk>[]>();

/**
 * Split text into chunks at word boundaries for line breaking: each word-like
 * segment and each run of trailing whitespace becomes a chunk, so a line break
 * may occur between any two chunks. The result is shared between callers and
 * frozen, so treat it as read-only.
 */
export function wrapChunks(text: string, locale?: string): readonly Readonly<WrapChunk>[] {
  const key = `${locale ?? ""}\u0000${text}`;
  const hit = wrapCache.get(key);
  if (hit) return hit;
  const out = computeWrapChunks(text, locale);
  if (wrapCache.size >= WRAP_CACHE_MAX) wrapCache.clear();
  wrapCache.set(key, out);
  return out;
}

function computeWrapChunks(text: string, locale?: string): readonly Readonly<WrapChunk>[] {
  const seg = segmenter(locale, "word");
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
  for (const c of out) Object.freeze(c);
  return Object.freeze(out);
}

/** Spaces that keep the words around them together: no-break space, figure
 *  space, narrow no-break space, word joiner, zero-width no-break space. */
const NO_BREAK = /^[\u00A0\u2007\u202F\u2060\uFEFF]+$/;
