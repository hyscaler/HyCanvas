// Rich-text document operations over the paragraph/run model: plain-
// text extraction (for AI/accessibility/find), find & replace across paragraphs
// (replacement inherits the format at the match start, the documented boundary
// rule, FR-14), and per-range character formatting that splits/coalesces runs.
//
// Find/replace indexes by UTF-16 code unit so positions align with RegExp;
// grapheme-accurate editing is layered on top via segment.ts where needed.

import type { CharStyle, Paragraph, Run, TextNode } from "@hc/schema";

/** Plain text of a node: runs concatenated, paragraphs joined by newlines. */
export function getPlainText(node: TextNode): string {
  return node.content.map((p) => p.runs.map((r) => r.text).join("")).join("\n");
}

export function getParagraphText(p: Paragraph): string {
  return p.runs.map((r) => r.text).join("");
}

// Per-character (UTF-16 unit) style array for a paragraph.
function explode(p: Paragraph): { chars: string[]; styles: CharStyle[] } {
  const chars: string[] = [];
  const styles: CharStyle[] = [];
  for (const run of p.runs) {
    for (const ch of run.text.split("")) {
      chars.push(ch);
      styles.push(run.style);
    }
  }
  return { chars, styles };
}

// Coalesce consecutive equal-style characters back into runs.
function rebuild(chars: string[], styles: CharStyle[]): Run[] {
  const runs: Run[] = [];
  let i = 0;
  while (i < chars.length) {
    const style = styles[i];
    const key = JSON.stringify(style);
    let text = chars[i];
    let j = i + 1;
    while (j < chars.length && JSON.stringify(styles[j]) === key) {
      text += chars[j];
      j++;
    }
    runs.push({ text, style });
    i = j;
  }
  return runs;
}

export interface FindQuery {
  text: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}

export interface Match {
  paragraph: number;
  start: number;
  end: number;
  text: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRegExp(q: FindQuery): RegExp {
  let src = q.regex ? q.text : escapeRegExp(q.text);
  if (q.wholeWord) src = `\\b(?:${src})\\b`;
  return new RegExp(src, q.caseSensitive ? "g" : "gi");
}

/** All matches across the node's paragraphs (matches do not cross paragraphs). */
export function findMatches(node: TextNode, q: FindQuery): Match[] {
  if (q.text === "") return [];
  const out: Match[] = [];
  node.content.forEach((p, pi) => {
    const text = getParagraphText(p);
    const re = buildRegExp(q);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      out.push({ paragraph: pi, start: m.index, end: m.index + m[0].length, text: m[0] });
      if (m[0].length === 0) re.lastIndex++; // avoid infinite loop on empty match
    }
  });
  return out;
}

/**
 * Replace all matches with `replacement`, mutating the node in place. Replacement
 * text takes the character style at each match start. Returns the match count.
 */
export function replaceAll(node: TextNode, q: FindQuery, replacement: string): number {
  if (q.text === "") return 0;
  const all = findMatches(node, q); // scan once, then apply per paragraph
  let count = 0;
  node.content.forEach((p, pi) => {
    const matches = all.filter((m) => m.paragraph === pi);
    if (matches.length === 0) return;
    const { chars, styles } = explode(p);
    // Apply right-to-left so earlier indices stay valid.
    for (let k = matches.length - 1; k >= 0; k--) {
      const m = matches[k];
      const startStyle = styles[m.start] ?? styles[m.start - 1] ?? p.runs[0]?.style;
      const repChars = replacement.split("");
      const repStyles = repChars.map(() => startStyle);
      chars.splice(m.start, m.end - m.start, ...repChars);
      styles.splice(m.start, m.end - m.start, ...repStyles);
      count++;
    }
    p.runs = rebuild(chars, styles);
  });
  return count;
}

/** Apply a character-style patch to a [start, end) range of a paragraph. */
export function applyCharToRange(
  node: TextNode,
  paragraphIndex: number,
  start: number,
  end: number,
  patch: Partial<CharStyle>,
): void {
  const p = node.content[paragraphIndex];
  if (!p) return;
  const { chars, styles } = explode(p);
  for (let i = Math.max(0, start); i < Math.min(end, chars.length); i++) {
    styles[i] = { ...styles[i], ...patch };
  }
  p.runs = rebuild(chars, styles);
}
