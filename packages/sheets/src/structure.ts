// Structural grid operations: insert/delete rows and columns, and sort a
// range. Every operation is pure and returns a NEW Grid. Cells are stored
// sparsely keyed "A1", so each op re-keys the affected cells and rewrites any
// formula text whose references move (via @hc/formula's shiftRefs). A formula
// reference to a deleted row/column becomes the literal "#REF!" in the text.

import {
  parseRef,
  parseRange,
  cellKey,
  shiftRefs,
  type CellValue,
  isError,
} from "@hc/formula";
import type { Grid, Cell } from "./model";

type Axis = "row" | "col";

/** A cell is a formula cell when its `f` source begins with "=". */
function isFormula(cell: Cell): boolean {
  return typeof cell.f === "string" && cell.f.startsWith("=");
}

/** Rewrite a cell's formula text for a structural edit, if it has one. */
function rewriteFormula(cell: Cell, axis: Axis, at: number, delta: number): Cell {
  if (!isFormula(cell)) return cell;
  return { ...cell, f: shiftRefs(cell.f as string, { axis, at, delta }) };
}

/**
 * Shared core for the four structural ops. Walks every populated cell, drops
 * the ones on a deleted line, re-keys the rest after the shift, and rewrites
 * formula references. Returns a brand new Grid.
 */
function restructure(grid: Grid, axis: Axis, at: number, delta: number): Grid {
  const cells: Record<string, Cell> = {};
  for (const [key, cell] of Object.entries(grid.cells)) {
    const ref = parseRef(key);
    const index = axis === "row" ? ref.row : ref.col;

    if (delta < 0 && index === at) {
      // This cell sat on the deleted row/column; drop it.
      continue;
    }

    let col = ref.col;
    let row = ref.row;
    if (index >= at) {
      if (axis === "row") row += delta;
      else col += delta;
    }

    const rewritten = rewriteFormula(cell, axis, at, delta);
    cells[cellKey(col, row)] = rewritten;
  }

  const next: Grid = { ...grid, cells };
  if (axis === "row") {
    next.rows = Math.max(1, grid.rows + delta);
  } else {
    next.cols = Math.max(1, grid.cols + delta);
  }
  return next;
}

/** Insert a blank row at 0-based index `at`, shifting lower rows down. */
export function insertRow(grid: Grid, at: number): Grid {
  return restructure(grid, "row", at, 1);
}

/** Delete the row at 0-based index `at`, shifting lower rows up. */
export function deleteRow(grid: Grid, at: number): Grid {
  return restructure(grid, "row", at, -1);
}

/** Insert a blank column at 0-based index `at`, shifting later columns right. */
export function insertCol(grid: Grid, at: number): Grid {
  return restructure(grid, "col", at, 1);
}

/** Delete the column at 0-based index `at`, shifting later columns left. */
export function deleteCol(grid: Grid, at: number): Grid {
  return restructure(grid, "col", at, -1);
}

/** Numeric coercion mirroring table.ts so blanks/strings sort consistently. */
function toNum(v: CellValue): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isNaN(n) ? NaN : n;
  }
  return NaN;
}

/** Comparison used for sorting: numbers numerically, else lexically, blanks last. */
function compare(a: CellValue, b: CellValue): number {
  if (isError(a) || isError(b)) return 0;
  const aBlank = a === null || a === undefined || a === "";
  const bBlank = b === null || b === undefined || b === "";
  if (aBlank && bBlank) return 0;
  if (aBlank) return 1; // blanks sort last
  if (bBlank) return -1;

  const an = toNum(a);
  const bn = toNum(b);
  if (!Number.isNaN(an) && !Number.isNaN(bn)) {
    return an < bn ? -1 : an > bn ? 1 : 0;
  }
  const as = String(a);
  const bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/** The value used to sort a cell: its formula result is opaque here, so we
 *  compare on the stored literal `v` (computed results are not part of the
 *  model). Empty cells compare as blank. */
function sortValue(cell: Cell | undefined): CellValue {
  if (cell === undefined) return null;
  return cell.v ?? null;
}

/**
 * Sort the rows within `range` (e.g. "A1:C10") by the column at 0-based offset
 * `byCol` within the range, writing the reordered cells back into the same
 * cells of the range (a destructive "Sort range", like Google Sheets). When
 * `headerRow` is set the first row of the range stays fixed.
 *
 * The whole row block inside the range moves together (values and formats);
 * formulas inside the range have their references rewritten so they keep
 * pointing at the row they travel with. Pure: returns a new Grid.
 */
export function sortRange(
  grid: Grid,
  range: string,
  byCol: number,
  dir: "asc" | "desc",
  opts: { headerRow?: boolean } = {}
): Grid {
  const r = parseRange(range);
  const top = r.start.row;
  const left = r.start.col;
  const width = r.end.col - r.start.col + 1;
  const sortColIndex = left + byCol;

  // Snapshot every row in the range as an array of (existing) cells.
  const startRow = opts.headerRow ? top + 1 : top;
  type RowSnapshot = { cells: (Cell | undefined)[]; origRow: number };
  const rows: RowSnapshot[] = [];
  for (let row = startRow; row <= r.end.row; row++) {
    const rowCells: (Cell | undefined)[] = [];
    for (let c = 0; c < width; c++) {
      rowCells.push(grid.cells[cellKey(left + c, row)]);
    }
    rows.push({ cells: rowCells, origRow: row });
  }

  const factor = dir === "desc" ? -1 : 1;
  const sorted = rows
    .map((row, i) => ({ row, i }))
    .sort((x, y) => {
      const cx = x.row.cells[sortColIndex - left];
      const cy = y.row.cells[sortColIndex - left];
      const c = compare(sortValue(cx), sortValue(cy));
      return c !== 0 ? c * factor : x.i - y.i; // stable
    })
    .map((e) => e.row);

  // Rebuild the grid: keep everything outside the sorted body, then write the
  // reordered rows back into the body slots, shifting each row's formulas by
  // the distance it moved.
  const cells: Record<string, Cell> = { ...grid.cells };
  // Clear the body region first so vacated cells become empty.
  for (let row = startRow; row <= r.end.row; row++) {
    for (let c = 0; c < width; c++) {
      delete cells[cellKey(left + c, row)];
    }
  }

  sorted.forEach((snapshot, idx) => {
    const destRow = startRow + idx;
    for (let c = 0; c < width; c++) {
      const cell = snapshot.cells[c];
      if (cell === undefined) continue;
      // The cell (value, formula text, and formatting) travels with its row.
      // Like Google Sheets' "Sort range", the formula text is carried verbatim.
      cells[cellKey(left + c, destRow)] = cell;
    }
  });

  return { ...grid, cells };
}
