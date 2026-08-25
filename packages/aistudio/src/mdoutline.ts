// Markdown outline interchange (F28 completion C26). DETERMINISTIC, no AI:
// a markdown outline parses straight into a DesignOutline (the same shape the
// deck builder consumes), and a design's pages serialize back to a markdown
// outline. Honest scope, stated in the capability row: this is OUTLINE
// interchange (structure and text), not a code-first slide format - Marp,
// Slidev, and reveal.js round-trips stay out.
//
// Grammar (import):
//   # Title            -> the deck title (first one wins)
//   ## Heading         -> starts a slide (### and deeper also start slides)
//   - item / * item    -> a point on the current slide (nesting flattens)
//   1. item            -> same, ordered lists
//   > note: text       -> the slide's speaker note
//   plain paragraph    -> a point on the current slide
// Text before the first slide heading (other than the title) seeds the first
// slide. Fenced code blocks are treated as opaque points, one per fence.

import type { DesignOutline, OutlineItem } from "./outline";
import { maxOutlinePages } from "./outlineEdit";

let mdSeq = 0;
const mdId = () => `md-${++mdSeq}`;

/** Parse a markdown outline into a DesignOutline, or null when the text has
 *  no usable structure at all (no headings and no list items). */
export function parseMarkdownOutline(md: string, opts: { fallbackTitle?: string } = {}): DesignOutline | null {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  let title: string | null = null;
  const pages: { title: string; points: string[]; note?: string }[] = [];
  type Draft = { title: string; points: string[]; note?: string };
  let current: Draft | null = null;
  let sawStructure = false;
  let inFence = false;
  let fenceBuf: string[] = [];

  const ensurePage = (t: string): Draft => {
    const d: Draft = { title: t.trim(), points: [] };
    pages.push(d);
    current = d;
    return d;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^```/.test(line.trim())) {
      if (inFence) {
        const cur = current as Draft | null;
        if (cur && fenceBuf.length) cur.points.push(fenceBuf.join("\n"));
        fenceBuf = [];
      }
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      fenceBuf.push(raw);
      continue;
    }
    const h = /^(#{1,6})\s+(.+)$/.exec(line);
    if (h) {
      sawStructure = true;
      if (h[1].length === 1 && title === null && pages.length === 0) {
        title = h[2].trim();
        continue;
      }
      if (pages.length >= maxOutlinePages) continue; // cap, matching generation
      ensurePage(h[2]);
      continue;
    }
    const note = /^>\s*note:\s*(.+)$/i.exec(line);
    const curForNote = current as Draft | null;
    if (note && curForNote) {
      curForNote.note = curForNote.note ? `${curForNote.note} ${note[1].trim()}` : note[1].trim();
      continue;
    }
    const li = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line);
    if (li) {
      sawStructure = true;
      const cur = (current as Draft | null) ?? ensurePage(title ?? opts.fallbackTitle ?? "Slide 1");
      cur.points.push(li[1].trim());
      continue;
    }
    const text = line.trim();
    if (text) {
      let cur = current as Draft | null;
      if (!cur) {
        if (title === null) {
          // A leading plain line with no heading reads as the title.
          title = text;
          continue;
        }
        cur = ensurePage(title);
      }
      cur.points.push(text);
    }
  }
  const curTail = current as Draft | null;
  if (inFence && curTail && fenceBuf.length) curTail.points.push(fenceBuf.join("\n")); // unclosed fence

  if (!sawStructure && pages.length === 0) return null;
  if (pages.length === 0 && title !== null) ensurePage(title);
  const items: OutlineItem[] = pages.map((p, i) => ({
    id: mdId(),
    title: p.title || `Slide ${i + 1}`,
    points: p.points.slice(0, 12),
    visualRole: i === 0 ? "cover" : "content",
    ...(p.note ? { note: p.note.slice(0, 500) } : {}),
  }));
  return {
    title: title ?? opts.fallbackTitle ?? items[0]?.title ?? "Imported outline",
    theme: "",
    pages: items,
  };
}

/** The minimal page shape serialization reads (structural, not the full Page). */
export interface OutlinePageLike {
  name?: string;
  notes?: string;
  children: {
    type: string;
    hidden?: boolean;
    content?: { runs: { text: string }[] }[];
    data?: { placeholderId?: string };
  }[];
}

/** Serialize a deck to a markdown outline: `# deck title`, one `##` per slide
 *  (page name first, else the largest-role text), text-node lines as points,
 *  speaker notes as `> note:` lines. Pure and lossy by design - an outline is
 *  structure and words, never geometry. */
export function serializeOutlineMarkdown(title: string, pages: OutlinePageLike[]): string {
  const out: string[] = [`# ${title.trim() || "Presentation"}`];
  pages.forEach((page, i) => {
    if (page.children.length === 0) return; // an empty page adds nothing to an outline
    const texts = page.children.filter((n) => n.type === "text" && !n.hidden && n.content?.length);
    const lineOf = (n: OutlinePageLike["children"][number]) =>
      (n.content ?? [])
        .map((p) => p.runs.map((r) => r.text).join(""))
        .map((t) => t.replace(/•\s*/g, "").trim())
        .filter(Boolean);
    const slideTitle = page.name?.trim() || lineOf(texts[0] ?? { type: "text", content: [] })[0] || `Slide ${i + 1}`;
    out.push("", `## ${slideTitle}`);
    const titleWasFirstText = !page.name?.trim() && texts.length > 0;
    texts.forEach((n, ti) => {
      const lines = lineOf(n);
      const startAt = titleWasFirstText && ti === 0 ? 1 : 0; // the title line is not also a point
      for (const l of lines.slice(startAt)) out.push(`- ${l}`);
    });
    const note = page.notes?.trim();
    if (note) for (const nl of note.split(/\n+/)) out.push(`> note: ${nl.trim()}`);
  });
  return out.join("\n") + "\n";
}
