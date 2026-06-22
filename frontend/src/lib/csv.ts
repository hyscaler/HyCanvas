// A small, dependency-free CSV parser for bulk-create data merge.
// Handles quoted fields, embedded commas, embedded newlines, escaped quotes
// ("" inside a quoted field), and CRLF or LF line endings. The first row is
// treated as the header (column names); subsequent rows become objects keyed by
// header. Ragged rows are tolerated (missing trailing cells become "").

export interface ParsedCsv {
  headers: string[];
  rows: Array<Record<string, string>>;
  /** The raw cell matrix, header row included, for a preview table. */
  matrix: string[][];
}

/** Parse CSV text into a matrix of rows of cells. */
export function parseCsvMatrix(text: string): string[][] {
  // Strip a leading UTF-8 BOM so it does not contaminate the first header cell.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      endField();
      i++;
      continue;
    }
    if (c === "\r") {
      // swallow CRLF as one line break
      if (text[i + 1] === "\n") i++;
      endRow();
      i++;
      continue;
    }
    if (c === "\n") {
      endRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // Flush a final unterminated row. A terminating newline does NOT leave a
  // pending row (endRow already pushed the row it closed), so after a trailing
  // newline `field` and `row` are both empty and nothing extra is flushed. This
  // means a legitimate all-empty data row (e.g. a `,` line, or a single empty
  // last cell) is preserved rather than stripped by a content-based heuristic.
  if (field.length > 0 || row.length > 0) endRow();
  return rows;
}

/** Parse CSV text into headers + objects (first row = headers). */
export function parseCsv(text: string): ParsedCsv {
  const matrix = parseCsvMatrix(text.trim() === "" ? "" : text);
  if (matrix.length === 0) return { headers: [], rows: [], matrix: [] };
  const headers = matrix[0].map((h) => h.trim());
  const rows = matrix.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      obj[h] = (cells[idx] ?? "").trim();
    });
    return obj;
  });
  return { headers, rows, matrix };
}
