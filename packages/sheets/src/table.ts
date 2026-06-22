// Data tables: read a range, apply filters then sort, return 2D rows.

import {
  parseRange,
  cellKey,
  type CellValue,
  isError,
} from "@hc/formula";
import type { Grid, DataTable } from "./model";

/**
 * Read the effective value of a cell in the grid, preferring a computed
 * formula result over the stored literal.
 */
function cellValueAt(
  grid: Grid,
  col: number,
  row: number,
  computed: Record<string, CellValue>
): CellValue {
  const key = cellKey(col, row);
  if (key in computed) return computed[key];
  const cell = grid.cells[key];
  if (cell === undefined) return null;
  if (typeof cell.f === "string" && cell.f.startsWith("=")) {
    return cell.v ?? null;
  }
  return cell.v ?? null;
}

/** Read the table's range into a dense 2D matrix of values (row-major). */
function readRange(
  grid: Grid,
  range: string,
  computed: Record<string, CellValue>
): CellValue[][] {
  const r = parseRange(range);
  const rows: CellValue[][] = [];
  for (let row = r.start.row; row <= r.end.row; row++) {
    const out: CellValue[] = [];
    for (let col = r.start.col; col <= r.end.col; col++) {
      out.push(cellValueAt(grid, col, row, computed));
    }
    rows.push(out);
  }
  return rows;
}

function toNum(v: CellValue): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isNaN(n) ? NaN : n;
  }
  return NaN;
}

function compare(a: CellValue, b: CellValue): number {
  if (isError(a) || isError(b)) return 0;
  const an = toNum(a);
  const bn = toNum(b);
  if (!Number.isNaN(an) && !Number.isNaN(bn)) {
    return an < bn ? -1 : an > bn ? 1 : 0;
  }
  const as = a === null ? "" : String(a);
  const bs = b === null ? "" : String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

function filterMatch(value: CellValue, op: string, target: unknown): boolean {
  switch (op) {
    case "eq":
    case "=":
      if (typeof target === "number" || typeof value === "number") {
        return toNum(value) === toNum(target as CellValue);
      }
      return String(value ?? "") === String(target ?? "");
    case "neq":
    case "<>":
      return String(value ?? "") !== String(target ?? "");
    case "gt":
    case ">":
      return toNum(value) > toNum(target as CellValue);
    case "gte":
    case ">=":
      return toNum(value) >= toNum(target as CellValue);
    case "lt":
    case "<":
      return toNum(value) < toNum(target as CellValue);
    case "lte":
    case "<=":
      return toNum(value) <= toNum(target as CellValue);
    case "contains":
      return String(value ?? "")
        .toLowerCase()
        .includes(String(target ?? "").toLowerCase());
    default:
      return true;
  }
}

/**
 * Apply a data-table view to a grid: read the range, drop the header row if
 * present, apply filters then sort, and return the resulting body rows.
 * Pure: never mutates the grid.
 */
export function applyTableView(
  grid: Grid,
  table: DataTable,
  computed: Record<string, CellValue> = {}
): { rows: CellValue[][] } {
  const all = readRange(grid, table.range, computed);
  let body = table.headerRow ? all.slice(1) : all.slice();

  if (table.filters && table.filters.length) {
    for (const f of table.filters) {
      body = body.filter((row) => filterMatch(row[f.col], f.op, f.value));
    }
  }

  if (table.sort) {
    const { col, dir } = table.sort;
    const factor = dir === "desc" ? -1 : 1;
    body = body
      .map((row, i) => ({ row, i }))
      .sort((x, y) => {
        const c = compare(x.row[col], y.row[col]);
        return c !== 0 ? c * factor : x.i - y.i; // stable
      })
      .map((e) => e.row);
  }

  return { rows: body };
}
