// Measure a composed deck the way a reviewer would, then decide what to fix.
//
// A generated deck used to leave the composer and go straight to the user.
// Nothing looked at it. This is the look: per page, did any text hit the
// readability floor and still not fit (overfull), how much of the reading
// area is empty (whitespace), and does the deck repeat one form too often.
// The report is deterministic and computed from the document model, so it
// runs identically in the editor and under goja, and the remedies it proposes
// are deterministic too: a layout variant for a monotonous or sparse page, and
// a flag for the one thing geometry cannot fix, copy that is simply too long,
// which the caller may hand back to the model once.
//
// Measured from the model rather than from pixels on purpose. The engine's
// own layout estimates are what the composer sized against, so the two agree,
// and a report that needs a rasterizer would not run where the composer does.

import type { Node } from "@hc/schema";
import type { Archetype, DesignOutline } from "./outline";
import type { QualityIssue } from "./quality";
import type { ComposedPage } from "./archetypes";

/** A compose-time variation of a form, chosen by the fixer, never by the model. */
export type PageVariant =
  /** Bullets split across two unnamed columns: the remedy for a long list. */
  | "twoUp"
  /** Bullets set one step larger: the remedy for a short list on an empty page. */
  | "large";

export interface PageReport {
  index: number;
  archetype: Archetype;
  impact: boolean;
  /** Names of text nodes that reached the floor of the ladder and still did
   *  not fit. Copy the composer could not place; only shorter copy fixes it. */
  overfull: string[];
  /** Share of the reading area with no node on it, 0..1. */
  whitespace: number;
  issues: QualityIssue[];
}

export interface DeckReport {
  pages: PageReport[];
  /** Share of pages composed as plain bullets. */
  bulletShare: number;
  /** Page indices that sit in a run of three or more of the same form. */
  repetition: number[];
  /** Pages whose copy needs shortening: geometry has done what it can. */
  shorten: number[];
  /** True when nothing needs a second pass. */
  ok: boolean;
}

interface Box { x: number; y: number; w: number; h: number }

function boxOf(n: Node): Box | null {
  const t = (n as { transform?: { x?: number; y?: number } }).transform;
  const s = (n as { size?: { width?: number; height?: number } }).size;
  if (!t || !s) return null;
  return { x: t.x ?? 0, y: t.y ?? 0, w: s.width ?? 0, h: s.height ?? 0 };
}

/** The share of a rect not covered by any box, by sampling a coarse grid.
 *  Exact union area is overkill for a design judgement; a 48x27 grid is. */
function whitespaceShare(boxes: Box[], area: Box): number {
  const cols = 48;
  const rows = 27;
  let empty = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const px = area.x + (c + 0.5) * (area.w / cols);
      const py = area.y + (r + 0.5) * (area.h / rows);
      let covered = false;
      for (const b of boxes) {
        if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) { covered = true; break; }
      }
      if (!covered) empty++;
    }
  }
  return empty / (cols * rows);
}

export interface MeasurablePage {
  archetype: Archetype;
  impact: boolean;
  nodes: Node[];
  overfull: string[];
  issues: QualityIssue[];
}

/** Whitespace above this on a paper page reads as unfinished. Impact pages
 *  are meant to be spare, so they are never judged on it. */
export const sparseThreshold = 0.68;

export function measureDeck(pages: MeasurablePage[], size: { width: number; height: number }, margin: number): DeckReport {
  const area: Box = { x: margin, y: margin, w: size.width - 2 * margin, h: size.height - 2 * margin };
  const reports: PageReport[] = pages.map((p, i) => {
    // Furniture (kicker, page number) is not content: it must not count as
    // filling the page.
    const boxes = p.nodes.filter((n) => n.name !== "Kicker" && n.name !== "Page number").map(boxOf).filter((b): b is Box => !!b);
    return {
      index: i,
      archetype: p.archetype,
      impact: p.impact,
      overfull: [...p.overfull],
      whitespace: Math.round(whitespaceShare(boxes, area) * 1000) / 1000,
      issues: p.issues,
    };
  });
  const bulletShare = pages.length ? pages.filter((p) => p.archetype === "bullets").length / pages.length : 0;
  const repetition: number[] = [];
  for (let i = 0; i < pages.length; i++) {
    const a = pages[i].archetype;
    if (i >= 2 && pages[i - 1].archetype === a && pages[i - 2].archetype === a) {
      // The third and later pages of a run are the ones to vary; the first two
      // are fine.
      repetition.push(i);
    }
  }
  const shorten = reports.filter((r) => r.overfull.length > 0).map((r) => r.index);
  return {
    pages: reports,
    bulletShare: Math.round(bulletShare * 100) / 100,
    repetition,
    shorten,
    // Repetition and sparseness are the fixer's business and are remedied by
    // variants before a caller sees this; what remains for a second pass is
    // copy that did not fit, and any hard quality issue.
    ok: shorten.length === 0 && reports.every((r) => r.issues.length === 0),
  };
}

/** Decide the deterministic remedies for one measured deck.
 *
 *  A bullets page in a run of three, or a bullets page with a long list, is
 *  set two-up; a sparse bullets page is set one step larger. Other forms have
 *  their own rhythm and are left alone. Overfull copy is not a variant's job
 *  and is reported for the caller to shorten. */
export function planVariants(report: DeckReport, outline: DesignOutline): Record<number, PageVariant> {
  const out: Record<number, PageVariant> = {};
  for (const r of report.pages) {
    if (r.archetype !== "bullets") continue;
    const points = outline.pages[r.index]?.points.length ?? 0;
    if (report.repetition.includes(r.index) && points >= 4) out[r.index] = "twoUp";
    else if (points >= 5) out[r.index] = "twoUp";
    else if (!r.impact && r.whitespace > sparseThreshold && points <= 3) out[r.index] = "large";
  }
  return out;
}

/** Convenience for callers holding ComposedPages plus their quality issues. */
export function toMeasurable(page: ComposedPage, issues: QualityIssue[]): MeasurablePage {
  return { archetype: page.archetype, impact: page.impact, nodes: page.nodes, overfull: page.overfull, issues };
}
