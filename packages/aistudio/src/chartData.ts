// F28 T17 - computed chart values from attached data. When a generation turn
// carries tabular source data, chart values are PARSED from it, never
// estimated: the model chooses only the chart type and which columns, and the
// numbers come from the data. Pure: CSV/TSV parsing with header detection and
// numeric coercion, the column-selection contract for the one structured
// call, and the series builder.

/** A parsed tabular source: the header row (detected or synthesized), the
 *  data rows, and which columns coerce to numbers. */
export interface DataMatrix {
  headers: string[];
  rows: string[][];
  /** Column indexes where most data cells parse as numbers. */
  numericColumns: number[];
}

/** Split one line on the delimiter, honoring double quotes (CSV rules). */
function splitLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === delim) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/** Coerce one cell to a number: plain, thousands separators, %, and common
 *  currency prefixes; null when it is not numeric. */
export function coerceNumber(cell: string): number | null {
  const cleaned = cell.trim().replace(/^[$€£¥₹]/, "").replace(/,/g, "").replace(/%$/, "");
  if (cleaned === "" || cleaned === "-") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** True when the text READS as tabular data: several lines sharing a
 *  consistent delimiter count with at least one numeric column. The `[Sheet
 *  N]` blocks the xlsx extractor emits qualify via their tab delimiters. */
export function looksTabular(text: string): boolean {
  const m = parseDataMatrix(text);
  return m !== null && m.rows.length >= 2 && m.numericColumns.length >= 1;
}

/** Parse CSV/TSV-ish text into a matrix: delimiter by frequency (tab beats
 *  comma beats semicolon), `[Sheet N]`/markdown noise dropped, the header row
 *  detected (first row mostly non-numeric while data rows are numeric) or
 *  synthesized as Column N. Null when nothing tabular is found. */
export function parseDataMatrix(text: string): DataMatrix | null {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^\[(Sheet|Slide) \d+\]$/.test(l) && !/^---/.test(l));
  if (lines.length < 2) return null;
  // Pick the delimiter that yields the most consistent multi-column split.
  let best: { delim: string; cols: number } | null = null;
  for (const delim of ["\t", ",", ";"]) {
    const counts = lines.slice(0, 20).map((l) => splitLine(l, delim).length);
    const cols = counts.sort((a, b) => a - b)[Math.floor(counts.length / 2)]; // median
    if (cols >= 2 && (!best || cols > best.cols)) best = { delim, cols };
  }
  if (!best) return null;
  const raw = lines.map((l) => splitLine(l, best!.delim)).filter((r) => r.length >= 2);
  if (raw.length < 2) return null;
  const width = Math.max(...raw.map((r) => r.length));
  const rows = raw.map((r) => [...r, ...Array(width - r.length).fill("")]);

  // Header detection: the first row is a header when it is mostly non-numeric
  // while the rows below are numeric in at least one shared column.
  const numericShare = (row: string[]) => row.filter((c) => coerceNumber(c) !== null).length / row.length;
  const first = rows[0];
  const hasHeader = numericShare(first) < 0.5 && rows.slice(1).some((r) => numericShare(r) >= 0.3);
  const headers = hasHeader ? first.map((h, i) => h || `Column ${i + 1}`) : first.map((_, i) => `Column ${i + 1}`);
  const dataRows = hasHeader ? rows.slice(1) : rows;
  if (!dataRows.length) return null;

  // A column is numeric when most of its non-empty cells coerce.
  const numericColumns: number[] = [];
  for (let c = 0; c < width; c++) {
    const cells = dataRows.map((r) => r[c]).filter((x) => x !== "");
    if (!cells.length) continue;
    const numeric = cells.filter((x) => coerceNumber(x) !== null).length;
    if (numeric / cells.length >= 0.6) numericColumns.push(c);
  }
  return { headers, rows: dataRows, numericColumns };
}

export const chartTypes = ["bar", "line", "area", "pie", "donut", "scatter", "radar"] as const;

/** JSON schema for the one column-selection call: the model picks a chart
 *  type, ONE category column, and 1..4 numeric value columns - by header
 *  name, from enums, so an invented column cannot arrive. */
export function chartColumnSelectionSchema(matrix: DataMatrix): Record<string, unknown> {
  const valueHeaders = matrix.numericColumns.map((c) => matrix.headers[c]);
  return {
    type: "object",
    additionalProperties: false,
    required: ["chartType", "categoryColumn", "valueColumns"],
    properties: {
      chartType: { type: "string", enum: [...chartTypes] },
      categoryColumn: { type: "string", enum: matrix.headers, description: "the column whose cells label the chart's categories" },
      valueColumns: { type: "array", minItems: 1, maxItems: 4, items: { type: "string", enum: valueHeaders }, description: "the numeric columns to plot, one series each" },
    },
  };
}

/** System prompt for the column-selection call. */
export function chartColumnSelectionSystemPrompt(matrix: DataMatrix): string {
  return (
    "You choose how to chart an attached data table. Pick ONLY the chart type, the category column, and which numeric columns to plot - the values come from the data itself, never from you. " +
    "Pick the chartType that fits (bar for comparisons, line/area for trends over time, pie/donut for parts of a whole with one series, scatter for correlation, radar for multivariate). " +
    "Output ONLY a single JSON object matching the schema, no prose or fences. Schema: " + JSON.stringify(chartColumnSelectionSchema(matrix))
  );
}

export interface ComputedChart {
  chartType: (typeof chartTypes)[number];
  categories: string[];
  series: { name: string; values: number[] }[];
}

/** Build the chart FROM THE PARSED DATA per the model's column choices,
 *  repairing invalid choices deterministically (first non-numeric column as
 *  categories, first numeric column as the value series). Rows whose category
 *  is empty are dropped; missing numeric cells become 0 to keep series
 *  aligned 1:1 with categories. Rows cap at 30 for legibility. */
export function buildChartFromSelection(matrix: DataMatrix, selection: unknown): ComputedChart {
  const sel = (selection && typeof selection === "object" ? selection : {}) as { chartType?: unknown; categoryColumn?: unknown; valueColumns?: unknown };
  const chartType = chartTypes.includes(sel.chartType as never) ? (sel.chartType as ComputedChart["chartType"]) : "bar";
  const headerIndex = new Map(matrix.headers.map((h, i) => [h, i] as const));
  const numericSet = new Set(matrix.numericColumns);

  let catCol = typeof sel.categoryColumn === "string" ? headerIndex.get(sel.categoryColumn) : undefined;
  if (catCol === undefined) {
    catCol = matrix.headers.findIndex((_, i) => !numericSet.has(i));
    if (catCol < 0) catCol = 0;
  }
  const requested = Array.isArray(sel.valueColumns) ? sel.valueColumns : [];
  let valueCols = requested
    .map((h) => (typeof h === "string" ? headerIndex.get(h) : undefined))
    .filter((i): i is number => i !== undefined && numericSet.has(i) && i !== catCol)
    .slice(0, 4);
  if (!valueCols.length) valueCols = matrix.numericColumns.filter((c) => c !== catCol).slice(0, 1);

  const rows = matrix.rows.filter((r) => (r[catCol!] ?? "").trim() !== "").slice(0, 30);
  const categories = rows.map((r) => r[catCol!]);
  const series = valueCols.map((c) => ({
    name: matrix.headers[c],
    values: rows.map((r) => coerceNumber(r[c] ?? "") ?? 0),
  }));
  return { chartType, categories, series };
}

/** The attached sources' first tabular text, or null. */
export function firstTabularSource(sources: { name: string; text: string }[] | undefined): { name: string; text: string } | null {
  for (const s of sources ?? []) {
    if (looksTabular(s.text)) return s;
  }
  return null;
}

/** User prompt for the column-selection call: the chart intent from the plan
 *  plus the table's shape (kept beside its schema like every model prompt). */
export function chartColumnSelectionUserPrompt(
  intent: { chartType?: unknown; categories?: unknown },
  matrix: DataMatrix,
  sourceName: string,
): string {
  const wanted = typeof intent.chartType === "string" && intent.chartType ? intent.chartType : "a chart";
  const about = Array.isArray(intent.categories) && intent.categories.length ? (intent.categories as string[]).join(", ") : "the data";
  return `The user asked for: ${wanted} of ${about}.\nData columns: ${matrix.headers.join(", ")} (${matrix.rows.length} rows, from "${sourceName}").`;
}
