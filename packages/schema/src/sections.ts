// Slide sections (doc 28 FR-5).
//
// Pure helpers over the open format. Sections are a *view* of the deck: `pages`
// order is the single source of truth for sequence, and `Page.sectionId` says
// which named group a slide belongs to. So a section can never disagree with
// the deck's order, and a deck with no sections behaves exactly as before.
//
// A section's slides are the run of consecutive pages carrying its id. If a
// deck is reordered so a section's pages are no longer contiguous, the groups
// below simply reflect that (two runs with the same section id), rather than
// silently reordering the author's slides.

import type { DesignFile, Page, SlideSection } from "./schema";

/** A contiguous run of slides sharing a section (or the unsectioned run). */
export interface SectionGroup {
  /** The section, or undefined for slides that belong to none. */
  section?: SlideSection;
  /** Page indices in deck order. */
  pageIndices: number[];
}

/** The section a page belongs to, or undefined (no id, or a dangling one). */
export function sectionForPage(file: DesignFile, page: Page): SlideSection | undefined {
  if (!page.sectionId) return undefined;
  return file.sections?.find((s) => s.id === page.sectionId);
}

/**
 * Group the deck into consecutive runs.
 *
 * Slides before the first section (or between sections) form an unsectioned
 * group, so every page appears exactly once and nothing is ever hidden. A
 * dangling `sectionId` (its section was deleted) is treated as unsectioned.
 */
export function groupPagesBySection(file: DesignFile): SectionGroup[] {
  const groups: SectionGroup[] = [];
  let current: SectionGroup | null = null;
  file.pages.forEach((page, i) => {
    const section = sectionForPage(file, page);
    const sameRun = current && current.section?.id === section?.id;
    if (!sameRun) {
      current = { section, pageIndices: [] };
      groups.push(current);
    }
    current!.pageIndices.push(i);
  });
  return groups;
}

/** Page indices belonging to a section, in deck order (may be non-contiguous). */
export function pagesInSection(file: DesignFile, sectionId: string): number[] {
  const out: number[] = [];
  file.pages.forEach((p, i) => {
    if (p.sectionId === sectionId) out.push(i);
  });
  return out;
}

/** True when the section is collapsed in the slide bar / overview. */
export function isSectionCollapsed(file: DesignFile, sectionId: string | undefined): boolean {
  if (!sectionId) return false;
  return file.sections?.find((s) => s.id === sectionId)?.collapsed === true;
}

/**
 * The slide a section-aware "next section" jump should land on, or -1.
 *
 * Present navigation is section-aware (FR-5): from anywhere inside a section,
 * this returns the first slide of the following group, skipping the rest of the
 * current one. Hidden slides are the caller's concern (present mode already
 * skips them), so this stays a pure structural query.
 */
export function nextSectionStart(file: DesignFile, fromPageIndex: number): number {
  const groups = groupPagesBySection(file);
  const gi = groups.findIndex((g) => g.pageIndices.includes(fromPageIndex));
  if (gi < 0 || gi + 1 >= groups.length) return -1;
  return groups[gi + 1].pageIndices[0] ?? -1;
}

/** The first slide of the previous group, or -1. */
export function prevSectionStart(file: DesignFile, fromPageIndex: number): number {
  const groups = groupPagesBySection(file);
  const gi = groups.findIndex((g) => g.pageIndices.includes(fromPageIndex));
  if (gi <= 0) return -1;
  return groups[gi - 1].pageIndices[0] ?? -1;
}

/** A section's title for display: its name, else a positional fallback. */
export function sectionTitle(section: SlideSection | undefined, groupIndex: number): string {
  const name = section?.name?.trim();
  if (name) return name;
  return section ? `Section ${groupIndex + 1}` : "Untitled section";
}
