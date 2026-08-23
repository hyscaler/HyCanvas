// Export engine data model. These types describe an export
// request, presets, jobs, and the pre-flight report. The pure core in this
// package operates on a DesignFile and produces SVG, dimensions, page
// lists, filenames, presets, and pre-flight results. Binary encoding (PNG/JPG/
// PDF/GIF), job execution, REST, and realtime are the runtime/worker layer.

import type { Color } from "@hc/schema";

export type ExportFormat = "png" | "jpg" | "svg" | "pdf" | "pdfx" | "gif" | "apng" | "lottie";

export type ColorIntent = "rgb" | "cmyk";

export interface PageSelection {
  mode: "all" | "current" | "range";
  range?: number[]; // page indices when mode === "range"
}

export interface RasterOptions {
  transparent?: boolean; // png only
  scale?: number; // multiplier; mutually informs dpi
  dpi?: number; // explicit target dpi
  jpgQuality?: number; // 0..100
  matte?: Color; // background for non-alpha formats
}

export interface SvgOptions {
  keepEditable: boolean; // emit primitives vs flattened raster
  embedRasters: boolean; // embed (true) or link (false)
}

export interface PdfOptions {
  intent: ColorIntent;
  cmykProfile?: string; // ICC profile id when intent === "cmyk"
  embedFonts: boolean;
  flattenTransparency?: boolean;
  // print (pdfx) only:
  bleedMm?: number;
  cropMarks?: boolean;
  trimMarks?: boolean;
  registrationMarks?: boolean;
  colorBars?: boolean;
}

export interface AnimatedOptions {
  fps: number;
  loop?: number; // gif/apng loop count, 0 = infinite
  durationMs?: number;
}

export interface ExportRequest {
  designId: string;
  format: ExportFormat;
  pages: PageSelection;
  raster?: RasterOptions;
  svg?: SvgOptions;
  pdf?: PdfOptions;
  animated?: AnimatedOptions;
  filenameTemplate?: string; // e.g. "{title}-{page}"
}

export interface ExportPreset {
  id: string;
  name: string;
  scope: "user" | "workspace";
  request: Omit<ExportRequest, "designId">;
}

export interface ExportJob {
  id: string;
  designId: string;
  status: "queued" | "rendering" | "encoding" | "done" | "error";
  progress: number; // 0..1
  outputs?: { url: string; bytes: number; page?: number; format: ExportFormat }[];
  archiveUrl?: string; // batch zip
  error?: { code: string; message: string };
}

export interface PreflightReport {
  lowResImages: { nodeId: string; ppi: number }[];
  outOfGamut: { nodeId: string; color: Color }[];
  missingBleed: boolean;
  fontIssues: { fontId: string; reason: string }[];
}

/** Formats that produce raster pixels (need dimension math). */
export const rasterFormats: ReadonlySet<ExportFormat> = new Set(["png", "jpg", "gif", "apng"]);
/** Formats that are print-grade and care about bleed / CMYK gamut. */
export const printFormats: ReadonlySet<ExportFormat> = new Set(["pdfx"]);
