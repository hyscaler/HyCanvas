// F28 T13 - narrative operations' pure core: the fully algorithmic agenda
// builder (entry math, contiguous even sections, page numbers that account for
// the inserted agenda pages themselves, per-page titles by heading -> first
// sentence -> first line fallback) and the agenda-layout picker (priority
// regexes over layout names with a list-layout fallback; null means skip
// silently). No store, no network.

import type { SlideLayout } from "@hc/schema";

/** Entries one agenda page comfortably lists. */
export const agendaEntriesPerPage = 10;

/** How many agenda pages an existing deck needs: the pages after the title
 *  slide, ten entries per agenda page. */
export function agendaPageCount(totalPages: number, hasTitleSlide: boolean): number {
  const entries = Math.max(0, totalPages - (hasTitleSlide ? 1 : 0));
  return Math.ceil(entries / agendaEntriesPerPage);
}

/** Split items into n contiguous sections with near-equal sizes (the earlier
 *  sections take the remainder). */
export function splitEvenly<T>(items: T[], n: number): T[][] {
  if (n <= 0 || !items.length) return [];
  const sections: T[][] = [];
  const base = Math.floor(items.length / n);
  let remainder = items.length % n;
  let cursor = 0;
  for (let i = 0; i < n && cursor < items.length; i++) {
    const size = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder--;
    sections.push(items.slice(cursor, cursor + size));
    cursor += size;
  }
  return sections.filter((s) => s.length);
}

/** A human-friendly title from a page's text: a markdown-style heading line
 *  first, else the first sentence, else the first non-empty line, else
 *  "Slide" (the reference fallback chain). */
export function extractTitleFromText(text: string): string {
  const t = (text ?? "").trim();
  // `[ \t]+` then a group that must START non-space: the two parts cannot both
  // claim the same run of spaces, so there is exactly one way to split. The
  // previous `\s+(.+)` was ambiguous at every space, which made a heading line
  // of N spaces cost O(N^2) to REJECT - reachable here because the text comes
  // from a model reply. Refusing to cross a newline is also more correct: a
  // heading's text is on the heading's own line.
  const heading = /^#{1,6}[ \t]+(\S[^\n]*)$/m.exec(t);
  if (heading) return heading[1].trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(t);
  if (sentence) return sentence[1].trim();
  for (const line of t.split("\n")) {
    const trimmed = line.trim();
    // A bare heading marker is punctuation, not a title. It reaches here when
    // the heading had no text of its own, and returning "#" as a slide title
    // is worse than falling through to the next line (or to "Slide").
    if (!trimmed || /^#+$/.test(trimmed)) continue;
    return trimmed;
  }
  return "Slide";
}

export interface AgendaEntry {
  /** 1-based page number AFTER the agenda pages are inserted. */
  pageNumber: number;
  title: string;
}

export interface AgendaPagePlan {
  entries: AgendaEntry[];
}

/** Build the agenda pages for an existing deck from its page titles: the
 *  agenda lands after the title slide, and every listed page number accounts
 *  for the agenda pages about to be inserted before it. */
export function buildAgendaPages(pageTitles: string[], hasTitleSlide: boolean): AgendaPagePlan[] {
  const before = hasTitleSlide ? 1 : 0;
  const listed = pageTitles.slice(before);
  const count = agendaPageCount(pageTitles.length, hasTitleSlide);
  if (!count || !listed.length) return [];
  const sections = splitEvenly(listed, count);
  const plans: AgendaPagePlan[] = [];
  let globalIndex = 0;
  for (const section of sections) {
    plans.push({
      entries: section.map((title) => ({
        pageNumber: before + sections.length + globalIndex++ + 1,
        title,
      })),
    });
  }
  return plans;
}

// Priority regexes for an agenda-suited layout, matched over the layout NAME
// (this repo's layouts carry no description field): explicit agenda/contents
// names first, then any list-like layout, then a content-slot fallback.
const agendaNamePatterns = [/\btable\s*of\s*contents\b/i, /\bagenda\b/i, /\bcontents\b/i, /\boutline\b/i, /\bindex\b/i, /\btoc\b/i];
const listNamePatterns = [/\bbullet(ed)?\s*list\b/i, /\bbullets?\b/i, /\b(numbered|ordered|unordered)\s*list\b/i, /\blist\b/i];

/** Pick the layout an agenda page should use, or null to skip silently (the
 *  reference behavior when no layout fits). */
export function pickAgendaLayout(layouts: SlideLayout[]): SlideLayout | null {
  for (const patterns of [agendaNamePatterns, listNamePatterns]) {
    for (const re of patterns) {
      const hit = layouts.find((l) => re.test(l.name ?? ""));
      if (hit) return hit;
    }
  }
  // List-layout fallback: any layout with a content slot can hold the entries.
  return layouts.find((l) => (l.placeholders ?? []).some((p) => p.role === "content")) ?? null;
}

/** JSON schema for the one splitSlide model call: two focused halves. */
export function splitSlideSchema(): Record<string, unknown> {
  const half = {
    type: "object", additionalProperties: false, required: ["title", "points"],
    properties: {
      title: { type: "string", maxLength: 80 },
      points: { type: "array", maxItems: 6, items: { type: "string", maxLength: 200 } },
    },
  };
  return { type: "object", additionalProperties: false, required: ["a", "b"], properties: { a: half, b: half } };
}

/** System prompt for the splitSlide call (kept beside its schema, like every
 *  other model prompt in this package). */
export function splitSlideSystemPrompt(): string {
  return (
    "Split ONE overloaded presentation slide into TWO coherent slides. Each half gets its own focused title and its share of the points; never invent content that is not on the slide. " +
    "Output ONLY a single JSON object matching the schema, no prose or fences. Schema: " + JSON.stringify(splitSlideSchema())
  );
}
