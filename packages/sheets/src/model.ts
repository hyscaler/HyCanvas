// Sheet cell model. A sheet lives in a Design's `meta.kind === "sheet"`.
// Cells are NOT scene nodes; they are stored sparsely on the grid keyed "A1".

import type { CellValue } from "@hc/formula";

export interface CellFont {
  family?: string;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
}

export interface CellBorder {
  top?: boolean;
  right?: boolean;
  bottom?: boolean;
  left?: boolean;
  color?: string;
}

export interface CellFormat {
  numberFormat?: string; // e.g. "#,##0.00", "0%", "yyyy-mm-dd", "$#,##0.00"
  font?: CellFont;
  fill?: string;
  border?: CellBorder;
  align?: { h?: "left" | "center" | "right"; v?: "top" | "middle" | "bottom" };
}

export interface Cell {
  v?: number | string | boolean; // literal value
  f?: string; // formula source, e.g. "=SUM(A1:A10)"
  t?: "number" | "string" | "bool" | "date";
  fmt?: CellFormat;
}

export interface Grid {
  id: string;
  name: string;
  rows: number;
  cols: number;
  cells: Record<string, Cell>; // keyed "A1"
}

export interface ConditionalRule {
  id: string;
  range: string; // "A1:A100"
  when: {
    op: "gt" | "lt" | "eq" | "between" | "contains";
    value: unknown;
    value2?: unknown;
  };
  style: CellFormat;
}

export interface DataTable {
  id: string;
  range: string;
  headerRow: boolean;
  columns: { name: string; type: "number" | "string" | "date" | "bool" }[];
  sort?: { col: number; dir: "asc" | "desc" };
  filters?: { col: number; op: string; value: unknown }[];
}

export interface ChartBinding {
  id: string;
  chartId: string;
  gridId: string;
  range: string;
  orientation: "rows" | "columns";
}

export interface SheetMeta {
  kind: "sheet";
  grids: Grid[];
  conditional?: ConditionalRule[];
  tables?: DataTable[];
  bindings?: ChartBinding[];
}

/** Read a cell by A1 key. Returns undefined when the cell is empty. */
export function getCell(grid: Grid, key: string): Cell | undefined {
  return grid.cells[key];
}

/**
 * Immutable cell update: returns a new Grid with the cell at `key` set.
 * Passing `undefined` clears the cell.
 */
export function setCell(
  grid: Grid,
  key: string,
  cell: Cell | undefined
): Grid {
  const cells = { ...grid.cells };
  if (cell === undefined) {
    delete cells[key];
  } else {
    cells[key] = cell;
  }
  return { ...grid, cells };
}

/**
 * The value a cell should display: a computed formula result when available,
 * otherwise the cell's literal value. Errors render as their code string.
 */
export function cellDisplayValue(
  cell: Cell | undefined,
  computed?: CellValue
): CellValue {
  if (cell === undefined) return null;
  if (cell.f !== undefined && cell.f.startsWith("=")) {
    return computed ?? null;
  }
  return cell.v ?? null;
}

/** Create an empty grid. */
export function createGrid(
  id: string,
  name: string,
  rows = 100,
  cols = 26
): Grid {
  return { id, name, rows, cols, cells: {} };
}
