// Accessibility checker: audit a design file for the common, automatable
// WCAG issues a designer can fix in the editor - low text contrast, images
// missing alt text, and text too small to read. Framework-agnostic and pure so
// it runs in the editor, on the server, and in tests. Contrast reuses @hc/color.
//
// Scope/limits: contrast is measured against the page background (a text box
// sitting on top of a colored shape is not resolved - that needs render-order
// compositing). Gradient/solid fills are handled; image/pattern backgrounds are
// treated as unknown and skipped for contrast.

import { walkNodes, type Color, type DesignFile, type Fill } from "@hc/schema";
import { contrastRatio } from "@hc/color";

export type A11ySeverity = "error" | "warning";
export type A11yKind = "contrast" | "alt-text" | "small-text" | "touch-target" | "slide-title";

export interface A11yIssue {
  nodeId: string;
  nodeName?: string;
  pageIndex: number;
  kind: A11yKind;
  severity: A11ySeverity;
  message: string;
  /** Contrast issues: the measured ratio and the WCAG AA minimum it missed. */
  ratio?: number;
  required?: number;
}

/** Text below this point size is flagged as hard to read. */
export const MIN_READABLE_FONT = 12;

/** WCAG 2.2 (2.5.8) minimum target size for interactive elements, in CSS px. */
export const MIN_TOUCH_TARGET = 24;

const WHITE: Color = { srgb: { r: 1, g: 1, b: 1, a: 1 } };

/** A representative solid color for a fill, or null when it can't be reduced to
 *  one (image/pattern fill, or absent). Gradients use their first stop. */
function solidOf(fill: Fill | undefined): Color | null {
  if (!fill) return null;
  if (fill.type === "solid") return fill.color;
  if (fill.type === "gradient" && fill.stops[0]) return fill.stops[0].color;
  return null;
}

/** WCAG "large text" = >= 24px, or >= 18.66px when bold (>=700). */
function isLarge(fontSize: number, weight: number): boolean {
  return fontSize >= 24 || (fontSize >= 18.66 && weight >= 700);
}

/** Audit a design file. Returns one issue per problem, in page/visit order. */
export function checkAccessibility(doc: DesignFile): A11yIssue[] {
  const issues: A11yIssue[] = [];
  // Slide titles (doc 28 FR-3/FR-29): every slide in a deck needs a name, or a
  // screen-reader user cannot navigate the presentation. Single-page designs
  // are not decks, so they are exempt.
  if (doc.pages.length > 1) {
    doc.pages.forEach((page, pageIndex) => {
      if (!page.name?.trim()) {
        issues.push({
          nodeId: page.id,
          nodeName: page.name,
          pageIndex,
          kind: "slide-title",
          severity: "warning",
          message: `Slide ${pageIndex + 1} has no title. Name the slide so screen readers can navigate the deck.`,
        });
      }
    });
  }
  doc.pages.forEach((page, pageIndex) => {
    const bg = solidOf(page.background) ?? WHITE;
    walkNodes(
      page.children,
      (node) => {
        const name = (node as { name?: string }).name;
        if (node.type === "text") {
          const tn = node as unknown as { content: { runs: { style: { fontSize?: number; fill?: Fill; axes?: Record<string, number> } }[] }[] };
          let worst: { ratio: number; required: number } | null = null;
          let minFont = Infinity;
          for (const para of tn.content) {
            for (const run of para.runs) {
              const fs = run.style.fontSize ?? 16;
              minFont = Math.min(minFont, fs);
              const fg = solidOf(run.style.fill);
              if (!fg) continue;
              const required = isLarge(fs, run.style.axes?.wght ?? 400) ? 3 : 4.5;
              const ratio = contrastRatio(fg, bg);
              if (ratio < required && (!worst || ratio < worst.ratio)) worst = { ratio, required };
            }
          }
          if (worst) {
            issues.push({
              nodeId: node.id,
              nodeName: name,
              pageIndex,
              kind: "contrast",
              severity: worst.ratio < 3 ? "error" : "warning",
              message: `Low text contrast (${worst.ratio.toFixed(1)}:1; WCAG AA needs ${worst.required}:1)`,
              ratio: worst.ratio,
              required: worst.required,
            });
          }
          if (minFont !== Infinity && minFont < MIN_READABLE_FONT) {
            issues.push({
              nodeId: node.id,
              nodeName: name,
              pageIndex,
              kind: "small-text",
              severity: "warning",
              message: `Very small text (${Math.round(minFont)}px) is hard to read`,
            });
          }
        } else if (node.type === "image") {
          const alt = (node as { alt?: string }).alt;
          if (!alt || !alt.trim()) {
            issues.push({
              nodeId: node.id,
              nodeName: name,
              pageIndex,
              kind: "alt-text",
              severity: "warning",
              message: "Image has no alt text for screen readers",
            });
          }
        }
        // Interactive elements (a link or pointer interaction) must meet the
        // minimum target size, regardless of node type (WCAG 2.5.8).
        const interactive = node as { link?: unknown; interaction?: unknown; size?: { width: number; height: number }; transform?: { scaleX?: number; scaleY?: number } };
        if ((interactive.link || interactive.interaction) && interactive.size) {
          const w = interactive.size.width * Math.abs(interactive.transform?.scaleX ?? 1);
          const h = interactive.size.height * Math.abs(interactive.transform?.scaleY ?? 1);
          if (w < MIN_TOUCH_TARGET || h < MIN_TOUCH_TARGET) {
            issues.push({
              nodeId: node.id,
              nodeName: name,
              pageIndex,
              kind: "touch-target",
              severity: "warning",
              message: `Interactive target is small (${Math.round(w)}x${Math.round(h)}px; WCAG needs ${MIN_TOUCH_TARGET}x${MIN_TOUCH_TARGET}px)`,
            });
          }
        }
      },
      ["pages", pageIndex, "children"],
    );
  });
  return issues;
}

export interface A11ySummary {
  total: number;
  errors: number;
  warnings: number;
  byKind: Record<A11yKind, number>;
  /** True when there are no error-severity issues (warnings allowed). */
  passes: boolean;
}

/** Roll up an issue list into counts for the accessibility panel/score. */
export function summarizeAccessibility(issues: A11yIssue[]): A11ySummary {
  const byKind: Record<A11yKind, number> = { contrast: 0, "alt-text": 0, "small-text": 0, "touch-target": 0, "slide-title": 0 };
  let errors = 0;
  let warnings = 0;
  for (const i of issues) {
    byKind[i.kind]++;
    if (i.severity === "error") errors++;
    else warnings++;
  }
  return { total: issues.length, errors, warnings, byKind, passes: errors === 0 };
}
