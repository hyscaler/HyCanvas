// Document outline + statistics: pure helpers over the doc block model
// for the TOC sidebar, reading-time estimate, and word/character counts. No I/O.

import { richTextToPlain } from "./model";
import type { DocBlock } from "./model";

export interface OutlineEntry {
  id: string;
  level: 1 | 2 | 3;
  text: string;
  /** URL-safe anchor slug derived from the heading text. */
  slug: string;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

/** Extract the heading outline (TOC) in document order. */
export function docOutline(blocks: DocBlock[]): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  const used = new Map<string, number>();
  for (const b of blocks) {
    if (b.type !== "heading") continue;
    const text = richTextToPlain(b.text).trim();
    let slug = slugify(text) || "section";
    // De-duplicate slugs (heading-2, heading-3, ...) for stable anchors.
    const n = used.get(slug) ?? 0;
    used.set(slug, n + 1);
    if (n > 0) slug = `${slug}-${n}`;
    out.push({ id: b.id, level: b.level, text, slug });
  }
  return out;
}

/** All plain text contained in a block (paragraphs, list items, table cells,
 *  captions, code), used for counting. */
export function blockText(block: DocBlock): string {
  switch (block.type) {
    case "paragraph":
    case "heading":
    case "quote":
    case "callout":
      return richTextToPlain(block.text);
    case "list":
      return block.items.map((i) => richTextToPlain(i.text)).join(" ");
    case "code":
      return block.code ?? "";
    case "image":
      return block.caption ? richTextToPlain(block.caption) : "";
    case "table":
      return block.rows.map((r) => r.cells.map((c) => richTextToPlain(c)).join(" ")).join(" ");
    default:
      return "";
  }
}

export interface DocStats {
  words: number;
  characters: number;
  charactersNoSpaces: number;
  blocks: number;
  headings: number;
  /** Estimated reading time in minutes (>= 1 for any content) at 200 wpm. */
  readingMinutes: number;
}

function countWords(text: string): number {
  const t = text.trim();
  return t === "" ? 0 : t.split(/\s+/).length;
}

/** Aggregate word/character counts and reading time across a document. */
export function docStats(blocks: DocBlock[], wordsPerMinute = 200): DocStats {
  let words = 0;
  let characters = 0;
  let charactersNoSpaces = 0;
  let headings = 0;
  for (const b of blocks) {
    if (b.type === "heading") headings++;
    const text = blockText(b);
    words += countWords(text);
    characters += text.length;
    charactersNoSpaces += text.replace(/\s/g, "").length;
  }
  const readingMinutes = words === 0 ? 0 : Math.max(1, Math.ceil(words / Math.max(1, wordsPerMinute)));
  return { words, characters, charactersNoSpaces, blocks: blocks.length, headings, readingMinutes };
}
