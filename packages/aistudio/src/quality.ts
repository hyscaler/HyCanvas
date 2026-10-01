// F39 AI Creative Studio - the quality pass. Given a laid-out page (background +
// nodes), report problems a human designer would catch: text that fails WCAG AA
// against the background, blocks that overflow the page, and blocks that overlap.
// layoutDesign already avoids these by construction; qualityCheck is the
// verifier (used in tests and surfaced as warnings), so the two stay honest.

import type { Color, Fill, Node } from "@hc/schema";
import { contrastRatio } from "@hc/color";

export type QualityIssueKind = "contrast" | "overflow" | "overlap";

export interface QualityIssue {
  kind: QualityIssueKind;
  nodeId: string;
  message: string;
  /** Measured contrast ratio for "contrast" issues. */
  ratio?: number;
}

export interface QualityReport {
  ok: boolean;
  issues: QualityIssue[];
}

interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function nodeBox(n: Node): Box | null {
  const t = (n as { transform?: { x?: number; y?: number } }).transform;
  const s = (n as { size?: { width?: number; height?: number } }).size;
  if (!t || !s) return null;
  return { id: n.id, x: t.x ?? 0, y: t.y ?? 0, w: s.width ?? 0, h: s.height ?? 0 };
}

function backgroundReferences(background: Fill): Color[] {
  if (background.type === "solid") return [background.color];
  if (background.type === "gradient" && background.stops.length) {
    // Every stop is a reference: text must be readable across the whole
    // gradient, so contrast is judged against the worst stop, not an average.
    return background.stops.map((s) => s.color);
  }
  return [];
}

function firstTextColor(n: Node): Color | null {
  const content = (n as { content?: Array<{ runs?: Array<{ style?: { fill?: Fill } }> }> }).content;
  const fill = content?.[0]?.runs?.[0]?.style?.fill;
  if (fill && fill.type === "solid") return fill.color;
  return null;
}

function overlaps(a: Box, b: Box): boolean {
  // Ignore touching edges; require real area overlap with a small tolerance.
  const tol = 1;
  return a.x < b.x + b.w - tol && a.x + a.w > b.x + tol && a.y < b.y + b.h - tol && a.y + a.h > b.y + tol;
}

export interface PageInput {
  background: Fill;
  nodes: Node[];
  size: { width: number; height: number };
}

function fillReferences(fill: Fill | undefined): Color[] {
  if (!fill) return [];
  if (fill.type === "solid") return [fill.color];
  if (fill.type === "gradient" && fill.stops.length) return fill.stops.map((s) => s.color);
  return [];
}

/** The colors a text node actually sits on: the innermost filled shape
 *  drawn beneath it that holds its whole box (a panel, a badge, a stand-in),
 *  else the page background. Judging every text against the page alone
 *  called a figure on a tinted panel wrong in both directions. */
export function groundReferences(node: Node, nodes: Node[], background: Fill): Color[] {
  const box = nodeBox(node);
  if (!box) return backgroundReferences(background);
  const tol = 1;
  let ground: Color[] | null = null;
  for (const n of nodes) {
    if (n === node) break; // only what is drawn beneath
    if (n.type !== "shape") continue;
    const b = nodeBox(n);
    if (!b) continue;
    if (b.x - tol <= box.x && b.y - tol <= box.y && b.x + b.w + tol >= box.x + box.w && b.y + b.h + tol >= box.y + box.h) {
      const refs = fillReferences((n as { fills?: Fill[] }).fills?.[0]);
      if (refs.length) ground = refs; // a later, inner shape wins
    }
  }
  return ground ?? backgroundReferences(background);
}

export function qualityCheck(page: PageInput): QualityReport {
  const issues: QualityIssue[] = [];
  const bgRefs = backgroundReferences(page.background);
  const boxes: Box[] = [];

  for (const n of page.nodes) {
    // Ornament (a decor disc bleeding off the edge, the icon set in it) is
    // drawn behind everything and may cross the page edge and each other on
    // purpose; it is neither an overlap nor an overflow.
    // A panel is drawn behind the content it holds; that is not an overlap.
    if ((n as { data?: { decor?: boolean; panel?: boolean } }).data?.decor || (n as { data?: { panel?: boolean } }).data?.panel) continue;
    const box = nodeBox(n);
    if (!box) continue;
    boxes.push(box);

    // Contrast (text nodes only): worst case across every reference of the
    // ground the text sits on.
    if (n.type === "text" && bgRefs.length) {
      const fg = firstTextColor(n);
      if (fg) {
        let ratio = Infinity;
        for (const ref of groundReferences(n, page.nodes, page.background)) ratio = Math.min(ratio, contrastRatio(fg, ref));
        if (ratio < 4.5) {
          issues.push({ kind: "contrast", nodeId: n.id, ratio, message: `Text contrast ${ratio.toFixed(2)}:1 is below AA (4.5:1).` });
        }
      }
    }

    // Overflow past the page bounds (small tolerance for rounding).
    const tol = 1;
    if (box.x < -tol || box.y < -tol || box.x + box.w > page.size.width + tol || box.y + box.h > page.size.height + tol) {
      issues.push({ kind: "overflow", nodeId: n.id, message: "Element extends past the page bounds." });
    }
  }

  // Overlap between any two placed boxes.
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (overlaps(boxes[i], boxes[j])) {
        issues.push({ kind: "overlap", nodeId: boxes[i].id, message: `Overlaps element ${boxes[j].id}.` });
      }
    }
  }

  return { ok: issues.length === 0, issues };
}
