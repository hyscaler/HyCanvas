// Pre-flight: a pure pass over the design that surfaces export risks before the
// job runs. Reports low-resolution images (low PPI),
// out-of-gamut colors for a CMYK target, and missing bleed for print.
// Font embeddability is reported when the design declares it; absent that
// metadata it is treated as embeddable (no false warnings).

import { childrenOf, type Color, type DesignFile, type ImageNode, type Node } from "@hc/schema";
import { computeEffectivePpi } from "@hc/engine";
import { gamutCheck } from "@hc/color";
import { resolvePages } from "./pages";
import { printFormats, type ExportRequest, type PreflightReport } from "./types";

type AnyRec = Record<string, unknown>;

const PRINT_MIN_PPI = 150;
const SCREEN_MIN_PPI = 72;

/** Visit a node and all descendants (containers, mask child, boolean operands). */
function visit(node: Node, fn: (n: Node) => void): void {
  fn(node);
  for (const c of childrenOf(node)) visit(c, fn);
  const rec = node as unknown as AnyRec;
  if (node.type === "mask" && rec.child) visit(rec.child as Node, fn);
  if (node.type === "boolean" && Array.isArray(rec.operands)) {
    for (const op of rec.operands as Node[]) visit(op, fn);
  }
}

/** Pull solid colors out of a fills array (gradients are checked per stop). */
function colorsOfFills(fills: unknown, out: Color[]): void {
  if (!Array.isArray(fills)) return;
  for (const f of fills as AnyRec[]) {
    if (!f) continue;
    if (f.type === "solid" && f.color) out.push(f.color as Color);
    else if (f.type === "gradient" && Array.isArray(f.stops)) {
      for (const s of f.stops as AnyRec[]) if (s?.color) out.push(s.color as Color);
    }
  }
}

/** Colors referenced by a node (node fills, stroke fill, text run fills). */
function colorsOfNode(node: Node): Color[] {
  const out: Color[] = [];
  const rec = node as unknown as AnyRec;
  colorsOfFills(rec.fills, out);
  const stroke = rec.stroke as AnyRec | undefined;
  if (stroke?.fill) colorsOfFills([stroke.fill], out);
  if (node.type === "text" && Array.isArray(rec.content)) {
    for (const para of rec.content as AnyRec[]) {
      for (const run of (para.runs as AnyRec[]) ?? []) {
        const style = run.style as AnyRec | undefined;
        if (style?.fill) colorsOfFills([style.fill], out);
      }
    }
  }
  return out;
}

/**
 * Run pre-flight for an export request over its selected pages. Pure: no I/O.
 */
export function preflight(file: DesignFile, request: ExportRequest): PreflightReport {
  const pages = resolvePages(file, request.pages);
  const isPrint = printFormats.has(request.format);
  const isPdf = request.format === "pdf" || request.format === "pdfx";
  const minPpi = isPdf ? PRINT_MIN_PPI : SCREEN_MIN_PPI;
  const cmyk = request.pdf?.intent === "cmyk";
  const cmykProfile = request.pdf?.cmykProfile;

  const lowResImages: PreflightReport["lowResImages"] = [];
  const outOfGamut: PreflightReport["outOfGamut"] = [];

  for (const pi of pages) {
    for (const root of file.pages[pi].children) {
      visit(root, (node) => {
        if (node.type === "image") {
          const ppi = computeEffectivePpi(node as ImageNode, file);
          if (Number.isFinite(ppi) && ppi > 0 && ppi < minPpi) {
            lowResImages.push({ nodeId: node.id, ppi: Math.round(ppi) });
          }
        }
        if (cmyk) {
          for (const color of colorsOfNode(node)) {
            if (!gamutCheck(color, cmykProfile).inGamut) {
              outOfGamut.push({ nodeId: node.id, color });
            }
          }
        }
      });
    }
  }

  // Print needs a bleed on every exported page; flag if any lacks one.
  const missingBleed = isPrint && pages.some((pi) => !file.pages[pi].bleed);

  // Font embeddability: honor an explicit `embeddable === false` on a FontRef.
  const fontIssues: PreflightReport["fontIssues"] = [];
  for (const font of file.fonts) {
    const rec = font as unknown as AnyRec;
    if (rec.embeddable === false) {
      fontIssues.push({ fontId: font.id, reason: "font does not permit embedding" });
    }
  }

  return { lowResImages, outOfGamut, missingBleed, fontIssues };
}
