// Bridge the sheet cell model to @hc/formula's dependency-graph recompute.

import {
  recompute,
  cellKey,
  type CellValue,
  type FormulaError,
  isError,
} from "@hc/formula";
import type { Grid, Cell } from "./model";

export type { CellValue, FormulaError };
export { isError };

/** A cell is a formula cell when its `f` source begins with "=". */
function isFormulaCell(cell: Cell): boolean {
  return typeof cell.f === "string" && cell.f.startsWith("=");
}

/** Read a cell's literal value (used for non-formula precedents). */
function literalAt(grid: Grid, col: number, row: number): CellValue {
  const cell = grid.cells[cellKey(col, row)];
  if (cell === undefined) return null;
  if (isFormulaCell(cell)) {
    // a formula cell's literal fallback is its stored `v` (last computed),
    // but during recompute the graph supplies the fresh value; this only
    // applies to formula cells outside the dirty set.
    return cell.v ?? null;
  }
  return cell.v ?? null;
}

/**
 * Recompute every formula cell in the grid. Returns a map of
 * cellKey -> computed CellValue covering all formula cells.
 *
 * This performs a full recompute (all formula cells are considered changed),
 * which is the correct behavior for an initial load or a snapshot restore.
 */
export function recomputeGrid(
  grid: Grid,
  opts?: { now?: number }
): Record<string, CellValue> {
  const formulas = new Map<string, string>();
  const changed: string[] = [];
  for (const [key, cell] of Object.entries(grid.cells)) {
    if (isFormulaCell(cell)) {
      formulas.set(key, cell.f as string);
      changed.push(key);
    }
  }

  if (formulas.size === 0) return {};

  const computed = recompute(
    formulas,
    changed,
    (col, row) => literalAt(grid, col, row),
    { now: opts?.now }
  );

  const out: Record<string, CellValue> = {};
  for (const [key, value] of computed) out[key] = value;
  return out;
}

/**
 * Incremental recompute: given the keys that just changed, return only the
 * affected formula cells' new values.
 */
export function recomputeChanged(
  grid: Grid,
  changedKeys: string[],
  opts?: { now?: number }
): Record<string, CellValue> {
  const formulas = new Map<string, string>();
  for (const [key, cell] of Object.entries(grid.cells)) {
    if (isFormulaCell(cell)) formulas.set(key, cell.f as string);
  }
  const computed = recompute(
    formulas,
    changedKeys,
    (col, row) => literalAt(grid, col, row),
    { now: opts?.now }
  );
  const out: Record<string, CellValue> = {};
  for (const [key, value] of computed) out[key] = value;
  return out;
}
