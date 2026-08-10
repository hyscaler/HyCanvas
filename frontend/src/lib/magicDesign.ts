// Pure parse/normalize helpers for Magic Design (F22 FR-4) and Magic Charts
// (F22 FR-7). The platform only exposes a free-text AI primitive
// (oc.aiText), so these helpers turn the model's free text into a strict,
// validated shape on the client: strip code fences, parse JSON robustly, and
// validate the result so a malformed model response produces a friendly error
// instead of corrupt nodes. They are framework-free and unit-testable; the
// store + panel turn the validated shapes into native, editable scene nodes.

import type { ChartType } from "@hc/schema";
import { tr } from "@/lib/i18n";

/** Thrown when the model returned text we cannot turn into the expected shape.
 *  The message is user-facing (surfaced via a toast). */
export class MagicParseError extends Error {}

/**
 * Robustly extract a JSON value from a model's free-text reply. Models often
 * wrap JSON in ```json fences or add a sentence of preamble, so we strip a
 * fenced block when present, else fall back to the first balanced {...} or
 * [...] span. Returns the parsed value or throws MagicParseError.
 */
export function parseModelJson(raw: string): unknown {
  const text = (raw ?? "").trim();
  if (!text) throw new MagicParseError(tr("app.the_ai_returned_an_empty_response_try_again"));

  // Prefer a fenced code block (```json ... ``` or ``` ... ```), using its body.
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates: string[] = [];
  if (fence?.[1]) candidates.push(fence[1].trim());
  candidates.push(text);
  // As a last resort, the first {...} or [...] span in the text.
  const span = firstJsonSpan(text);
  if (span) candidates.push(span);

  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // try the next candidate
    }
  }
  throw new MagicParseError(tr("app.the_ai_response_wasnt_valid_json_try_again_o"));
}

/** Return the first balanced {...} or [...] substring, or null. Tolerates braces
 *  inside strings so a quoted "}" does not end the span early. */
function firstJsonSpan(text: string): string | null {
  const open = text.search(/[{[]/);
  if (open < 0) return null;
  const openCh = text[open];
  const closeCh = openCh === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return null;
}

// --- Magic Design spec (FR-4) ---------------------------------------------

export type MagicElementKind = "heading" | "subheading" | "body" | "accent";

/** One element of a generated design, positioned in 0..1 page fractions so the
 *  layout maps cleanly to any target size. */
export interface MagicDesignElement {
  kind: MagicElementKind;
  text?: string;
  color?: string; // hex; text color, or accent fill
  x: number; // 0..1 left
  y: number; // 0..1 top
  w: number; // 0..1 width
  h: number; // 0..1 height
  fontSize?: number; // optional explicit px at the target size
}

export interface MagicDesignBackground {
  kind: "solid" | "gradient";
  color?: string; // solid, or gradient start
  color2?: string; // gradient end
  angle?: number; // gradient angle in degrees
}

export interface MagicDesignSpec {
  background: MagicDesignBackground;
  elements: MagicDesignElement[];
}

const ELEMENT_KINDS: MagicElementKind[] = ["heading", "subheading", "body", "accent"];
const HEX_RE = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function asObject(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new MagicParseError(tr("app.the_ai_response_wasnt_in_the_expected_format"));
  }
  return v as Record<string, unknown>;
}

function frac(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function hexOrUndef(v: unknown): string | undefined {
  return typeof v === "string" && HEX_RE.test(v.trim()) ? v.trim().toLowerCase() : undefined;
}

/** Validate + normalize a parsed Magic Design JSON value into a MagicDesignSpec.
 *  Clamps fractions to 0..1, drops elements with no usable position, and throws
 *  MagicParseError if there is no background or no usable element at all. */
export function normalizeMagicDesign(parsed: unknown): MagicDesignSpec {
  const root = asObject(parsed);
  const bgRaw = root.background ? asObject(root.background) : {};
  const bgKind = bgRaw.kind === "gradient" ? "gradient" : "solid";
  const background: MagicDesignBackground = {
    kind: bgKind,
    color: hexOrUndef(bgRaw.color) ?? "#ffffff",
    color2: hexOrUndef(bgRaw.color2),
    angle: typeof bgRaw.angle === "number" && Number.isFinite(bgRaw.angle) ? bgRaw.angle : 90,
  };

  const list = Array.isArray(root.elements) ? root.elements : [];
  const elements: MagicDesignElement[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    const kind = ELEMENT_KINDS.includes(e.kind as MagicElementKind) ? (e.kind as MagicElementKind) : "body";
    const text = typeof e.text === "string" ? e.text : undefined;
    // Text elements need content; accents are shapes and need none.
    if (kind !== "accent" && !text?.trim()) continue;
    const fontSize =
      typeof e.fontSize === "number" && Number.isFinite(e.fontSize) ? Math.max(6, Math.min(800, e.fontSize)) : undefined;
    elements.push({
      kind,
      text,
      color: hexOrUndef(e.color),
      x: frac(e.x, 0.1),
      y: frac(e.y, 0.1),
      w: frac(e.w, 0.8),
      h: frac(e.h, 0.15),
      fontSize,
    });
  }

  if (elements.length === 0) {
    throw new MagicParseError(tr("app.the_ai_didnt_return_any_usable_design_elemen"));
  }
  return { background, elements };
}

// --- Magic Charts data (FR-7) ---------------------------------------------

export interface ChartData {
  chartType: ChartType;
  categories: string[];
  series: { name: string; values: number[] }[];
}

const CHART_TYPES: ChartType[] = [
  "bar", "barStacked", "barGrouped", "line", "pie", "donut", "area",
  "scatter", "radar", "gauge", "funnel", "progress",
];

/** Coerce a cell to a finite number, tolerating thousands separators, currency
 *  symbols, percent signs, and parenthesized negatives. NaN-ish cells become 0
 *  (we never invent data; an unparseable cell is treated as missing/zero). */
export function parseNumber(cell: string): number {
  const s = (cell ?? "").trim();
  if (!s) return 0;
  const neg = /^\(.*\)$/.test(s);
  const cleaned = s.replace(/[(),$£€%\s]/g, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return 0;
  return neg ? -n : n;
}

/**
 * Turn a tabular cell matrix (header row + data rows, as produced by the F27
 * CSV parser's parseCsvMatrix) into chart data. The first column is treated as
 * the category labels; every remaining column becomes a numeric series named by
 * its header. Ragged rows are tolerated (missing cells become 0). Throws
 * MagicParseError when there is no usable data.
 */
export function tabularToChart(matrix: string[][], chartType: ChartType = "bar"): ChartData {
  const rows = matrix.filter((r) => r.some((c) => (c ?? "").trim() !== ""));
  if (rows.length < 2) {
    throw new MagicParseError(tr("app.need_a_header_row_plus_at_least_one_data_row"));
  }
  const header = rows[0].map((h) => (h ?? "").trim());
  const cols = header.length;
  if (cols < 2) {
    throw new MagicParseError(tr("app.need_at_least_two_columns_labels_plus_one_or"));
  }
  const dataRows = rows.slice(1);
  const categories = dataRows.map((r, i) => (r[0] ?? "").trim() || `Row ${i + 1}`);
  const series: { name: string; values: number[] }[] = [];
  for (let c = 1; c < cols; c++) {
    series.push({
      name: header[c] || `Series ${c}`,
      values: dataRows.map((r) => parseNumber(r[c] ?? "")),
    });
  }
  return { chartType, categories, series };
}

/** Validate + normalize a parsed natural-language chart JSON value into
 *  ChartData. Enforces a known chart type, numeric values, and equal series
 *  lengths matching the category count (truncating/padding defensively). Throws
 *  MagicParseError on malformed shape. */
export function normalizeChartData(parsed: unknown): ChartData {
  const root = asObject(parsed);
  const chartType = CHART_TYPES.includes(root.chartType as ChartType) ? (root.chartType as ChartType) : "bar";
  const categories = Array.isArray(root.categories)
    ? root.categories.map((c) => String(c))
    : [];
  if (categories.length === 0) {
    throw new MagicParseError(tr("app.the_ai_didnt_return_any_chart_categories_try"));
  }
  const rawSeries = Array.isArray(root.series) ? root.series : [];
  const series: { name: string; values: number[] }[] = [];
  rawSeries.forEach((s, i) => {
    if (!s || typeof s !== "object") return;
    const so = s as Record<string, unknown>;
    const name = typeof so.name === "string" && so.name.trim() ? so.name.trim() : `Series ${i + 1}`;
    const valuesRaw = Array.isArray(so.values) ? so.values : [];
    // Coerce to finite numbers; align length to the category count.
    const values = categories.map((_, idx) => {
      const v = valuesRaw[idx];
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : 0;
    });
    series.push({ name, values });
  });
  if (series.length === 0 || series.every((s) => s.values.every((v) => v === 0))) {
    throw new MagicParseError(tr("app.the_ai_didnt_return_any_chart_values_try_rep"));
  }
  return { chartType, categories, series };
}
