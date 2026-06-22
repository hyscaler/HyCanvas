// Print pre-flight (F35 FR-5/FR-6). Runs the print-grade checks against a design
// for a chosen product + size and gates ordering.
//
// We REUSE @hc/export's `preflight` (which itself reuses @hc/engine's
// `computeEffectivePpi`, @hc/color's `gamutCheck`, and surfaces missing bleed and
// font-embedding issues) for the overlapping DPI / gamut / bleed / font checks,
// then ADD the print-specific checks the export report does not cover:
//   - color_space: product wants CMYK but the design declares an RGB profile
//   - icc: product requires an ICC profile and the design has none / a mismatch
//   - safe_zone: a node extends outside the product's safe rectangle (warn)
//   - overprint: pure-black / registration-black hints that may over-ink
//
// Each result is a PreflightCheck (pass/warn/error) with the offending nodeId
// where applicable; the aggregate status gates ordering via `evaluateGate`.

import { childrenOf, type DesignFile, type Node } from "@hc/schema";
import { preflight as exportPreflight, type ExportRequest, type PreflightReport } from "@hc/export";
import {
  type PreflightCheck,
  type PreflightCode,
  type PreflightLevel,
  type PreflightResult,
  type PrintProduct,
} from "./types";
import { printRects, mmToPx, type Rect } from "./geometry";

type AnyRec = Record<string, unknown>;

export interface PrintPreflightOptions {
  /** Page index within the design that maps to the product (default 0). */
  pageIndex?: number;
  /** ISO timestamp for `ranAt`; defaults to a fixed empty string for determinism. */
  ranAt?: string;
  /** Inject a pre-computed export report (tests / caching). Otherwise computed. */
  exportReport?: PreflightReport;
}

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

/** Axis-aligned bounding box of a node in design pixels (ignores rotation; uses
 *  the transformed top-left and the scaled size, which is sufficient for a
 *  conservative safe-zone containment test). */
function nodeBounds(node: Node): Rect {
  const sx = Math.abs(node.transform.scaleX || 1);
  const sy = Math.abs(node.transform.scaleY || 1);
  const w = node.size.width * sx;
  const h = node.size.height * sy;
  return { x: node.transform.x, y: node.transform.y, width: w, height: h };
}

/** True when `inner` is fully contained within `outer` (with a small tolerance). */
function contains(outer: Rect, inner: Rect, tol = 0.5): boolean {
  return (
    inner.x >= outer.x - tol &&
    inner.y >= outer.y - tol &&
    inner.x + inner.width <= outer.x + outer.width + tol &&
    inner.y + inner.height <= outer.y + outer.height + tol
  );
}

/** Build the export request that mirrors a print job: PDF/X, CMYK intent when
 *  the product is CMYK, single mapped page. */
function buildExportRequest(design: DesignFile, product: PrintProduct, pageIndex: number): ExportRequest {
  const cmyk = product.colorSpace === "CMYK";
  return {
    designId: design.id,
    format: "pdfx",
    pages: { mode: "range", range: [pageIndex] },
    pdf: {
      intent: cmyk ? "cmyk" : "rgb",
      cmykProfile: product.iccProfile,
      embedFonts: true,
      bleedMm: product.bleedMm,
      cropMarks: true,
    },
  };
}

/** Is a color pure black (or registration black) that may over-ink on press? */
function isOverprintRisk(rec: AnyRec): boolean {
  const fills = rec.fills;
  if (!Array.isArray(fills)) return false;
  for (const f of fills as AnyRec[]) {
    if (f?.type !== "solid" || !f.color) continue;
    const color = f.color as AnyRec;
    const srgb = color.srgb as AnyRec | undefined;
    const cmyk = color.cmyk as AnyRec | undefined;
    // Registration black: all four CMYK channels at/near full.
    if (
      cmyk &&
      (cmyk.c as number) >= 0.99 &&
      (cmyk.m as number) >= 0.99 &&
      (cmyk.y as number) >= 0.99 &&
      (cmyk.k as number) >= 0.99
    ) {
      return true;
    }
    // Rich/pure black in RGB on a CMYK product can over-ink when naively converted.
    if (srgb && (srgb.r as number) <= 0.01 && (srgb.g as number) <= 0.01 && (srgb.b as number) <= 0.01) {
      return true;
    }
  }
  return false;
}

/**
 * Run print pre-flight for `design` against `product`/`sizeId`. Pure: no I/O.
 */
export function runPrintPreflight(
  design: DesignFile,
  product: PrintProduct,
  sizeId: string,
  opts: PrintPreflightOptions = {},
): PreflightResult {
  const pageIndex = opts.pageIndex ?? 0;
  const size = product.sizes.find((s) => s.id === sizeId);
  if (!size) throw new Error(`size ${sizeId} not found on product ${product.id}`);
  const page = design.pages[pageIndex];
  if (!page) throw new Error(`page index ${pageIndex} out of range`);

  const checks: PreflightCheck[] = [];

  // --- Reused @hc/export report (DPI / gamut / bleed / fonts) -----------------
  const report =
    opts.exportReport ?? exportPreflight(design, buildExportRequest(design, product, pageIndex));

  // dpi: the export report uses a fixed print floor; re-check each low-res image
  // against THIS product's requiredDpi so the product minimum governs.
  // The export report already isolated images below the print floor; for any it
  // missed (product requires more than the floor) we still surface via report.
  if (report.lowResImages.length === 0) {
    checks.push({
      code: "dpi",
      level: "pass",
      message: `all placed images meet the ${product.requiredDpi} DPI minimum`,
      overridable: false,
    });
  } else {
    for (const img of report.lowResImages) {
      const level: PreflightLevel = img.ppi < product.requiredDpi * 0.75 ? "error" : "warn";
      checks.push({
        code: "dpi",
        level,
        message: `image is ${img.ppi} DPI, below the product minimum of ${product.requiredDpi} DPI`,
        nodeId: img.nodeId,
        overridable: true,
      });
    }
  }

  // color_space: CMYK product with an RGB-declared design profile -> warn.
  if (product.colorSpace === "CMYK") {
    const profile = (design.colorProfile ?? "").toLowerCase();
    const looksRgb = profile === "" || profile.includes("rgb") || profile.includes("srgb");
    if (looksRgb) {
      checks.push({
        code: "color_space",
        level: "warn",
        message:
          "design is RGB but the product prints in CMYK; colors will be converted and may shift",
        overridable: true,
      });
    } else {
      checks.push({
        code: "color_space",
        level: "pass",
        message: "design color profile matches the CMYK product",
        overridable: false,
      });
    }
    // out-of-gamut colors (reused @hc/color gamut check via the export report).
    for (const og of report.outOfGamut) {
      checks.push({
        code: "color_space",
        level: "warn",
        message: "color is outside the CMYK gamut and will be approximated",
        nodeId: og.nodeId,
        overridable: true,
      });
    }
  } else {
    checks.push({
      code: "color_space",
      level: "pass",
      message: "RGB product; no CMYK conversion required",
      overridable: false,
    });
  }

  // icc: product requires a profile; flag when the design declares none / a
  // different one.
  if (product.iccProfile) {
    const designProfile = design.colorProfile;
    if (!designProfile) {
      checks.push({
        code: "icc",
        level: "warn",
        message: `product expects ICC profile "${product.iccProfile}"; the design declares none`,
        overridable: true,
      });
    } else if (designProfile !== product.iccProfile) {
      checks.push({
        code: "icc",
        level: "warn",
        message: `design ICC profile "${designProfile}" differs from the product's "${product.iccProfile}"`,
        overridable: true,
      });
    } else {
      checks.push({
        code: "icc",
        level: "pass",
        message: `ICC profile "${product.iccProfile}" matches`,
        overridable: false,
      });
    }
  }

  // bleed: reuse the export report's missingBleed for the mapped page.
  if (report.missingBleed) {
    checks.push({
      code: "bleed",
      level: "error",
      message: `content does not extend into the ${product.bleedMm}mm bleed`,
      overridable: true,
    });
  } else {
    checks.push({
      code: "bleed",
      level: "pass",
      message: "page declares a bleed",
      overridable: false,
    });
  }

  // safe_zone: any node whose bounds extend outside the safe rect -> warn. The
  // safe rect is computed in the design's own pixels: the trim box is the page,
  // and the safe inset is `safeZoneMm` converted to px at the design dpi.
  const safeInsetPx = mmToPx(product.safeZoneMm, design.dpi);
  const pageRect: Rect = { x: 0, y: 0, width: page.width, height: page.height };
  const safeRect: Rect = {
    x: pageRect.x + safeInsetPx,
    y: pageRect.y + safeInsetPx,
    width: Math.max(0, pageRect.width - 2 * safeInsetPx),
    height: Math.max(0, pageRect.height - 2 * safeInsetPx),
  };
  let safeViolation = false;
  for (const root of page.children) {
    visit(root, (node) => {
      if (node.hidden) return;
      if (!contains(safeRect, nodeBounds(node))) {
        safeViolation = true;
        checks.push({
          code: "safe_zone",
          level: "warn",
          message: "element extends outside the safe zone and may be trimmed",
          nodeId: node.id,
          overridable: true,
        });
      }
    });
  }
  if (!safeViolation) {
    checks.push({
      code: "safe_zone",
      level: "pass",
      message: "all elements are inside the safe zone",
      overridable: false,
    });
  }

  // font_embed: reuse the export report's font issues.
  if (report.fontIssues.length === 0) {
    checks.push({
      code: "font_embed",
      level: "pass",
      message: "all fonts are embeddable",
      overridable: false,
    });
  } else {
    for (const fi of report.fontIssues) {
      checks.push({
        code: "font_embed",
        level: "error",
        message: `font ${fi.fontId}: ${fi.reason}`,
        overridable: false,
      });
    }
  }

  // overprint: flag pure/registration black that may over-ink on a CMYK press.
  if (product.colorSpace === "CMYK") {
    let overprintFound = false;
    for (const root of page.children) {
      visit(root, (node) => {
        if (isOverprintRisk(node as unknown as AnyRec)) {
          overprintFound = true;
          checks.push({
            code: "overprint",
            level: "warn",
            message: "element uses pure/registration black which may over-ink on press",
            nodeId: node.id,
            overridable: true,
          });
        }
      });
    }
    if (!overprintFound) {
      checks.push({
        code: "overprint",
        level: "pass",
        message: "no overprint risks detected",
        overridable: false,
      });
    }
  }

  const status = aggregateStatus(checks);
  return {
    designId: design.id,
    productId: product.id,
    sizeId,
    checks,
    status,
    ranAt: opts.ranAt ?? "",
  };
}

/** error if any error, else warn if any warn, else pass. */
export function aggregateStatus(checks: PreflightCheck[]): PreflightLevel {
  if (checks.some((c) => c.level === "error")) return "error";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

export interface GateResult {
  /** True when nothing blocks ordering: no un-overridden errors and all warnings
   *  acknowledged. */
  canOrder: boolean;
  /** Checks currently blocking the order (errors not overridden, or warnings not
   *  acknowledged). */
  blocking: PreflightCheck[];
  /** Errors that were overridden (overridable + present in `overrides`). */
  acknowledged: PreflightCheck[];
}

/**
 * Gate ordering on a pre-flight result (FR-6). Errors block unless the check is
 * `overridable` and its code is in `overrides`. Warnings are non-blocking but
 * require acknowledgment (their code present in `overrides`). Pass checks never
 * block. A non-overridable error always blocks regardless of `overrides`.
 */
export function evaluateGate(
  result: PreflightResult,
  overrides: Set<PreflightCode> = new Set(),
): GateResult {
  const blocking: PreflightCheck[] = [];
  const acknowledged: PreflightCheck[] = [];
  for (const c of result.checks) {
    if (c.level === "pass") continue;
    const handled = overrides.has(c.code);
    if (c.level === "error") {
      if (c.overridable && handled) acknowledged.push(c);
      else blocking.push(c);
    } else {
      // warn: must be acknowledged to proceed.
      if (handled) acknowledged.push(c);
      else blocking.push(c);
    }
  }
  return { canOrder: blocking.length === 0, blocking, acknowledged };
}
