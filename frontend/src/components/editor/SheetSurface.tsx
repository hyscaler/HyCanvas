// F32 Sheets editing surface. A spreadsheet grid that lives entirely
// in `doc.meta.sheet` as a SheetMeta (from @hc/sheets); cells are NOT scene
// nodes. EditorApp mounts this (via DocumentSurface) when `doc.meta.kind ===
// "sheet"`. All persistence flows through the editor store's `setDocMeta`, so a
// cell commit / row insert / format change is one undoable step. Formula
// recompute is delegated to @hc/sheets' `recomputeGrid` (which wraps
// @hc/formula's dependency-graph engine).
//
// Deferred: real-time co-editing presence, live external
// data sources, chart binding, bulk-create handoff, AI formula/insights, true
// windowed virtualization for very large grids (we render up to a safe DOM cap
// and note when data exceeds it), data-table filter/view UI, function
// autocomplete, merge cells, column/row resize, and a full conditional-
// formatting rule builder (rules already stored under `meta.sheet.conditional`
// are honored for display).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  Rows3,
  Columns3,
  Bold,
  Italic,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Type,
  PaintBucket,
  Square,
  ChevronDown,
  DecimalsArrowLeft,
  DecimalsArrowRight,
} from "lucide-react";
import {
  type Cell,
  type CellFormat,
  type Grid,
  type SheetMeta,
  getCell,
  setCell,
  cellDisplayValue,
  createGrid,
  recomputeGrid,
  formatNumber,
  applyConditionalFormat,
  type CellValue,
  isError,
  insertRow,
  deleteRow,
  insertCol,
  deleteCol,
} from "@hc/sheets";
import { cellKey, indexToCol, parseRef } from "@hc/formula";
import { useEditor } from "@/store/editor";
import { useToast } from "@/components/ui/Toast";

// Render cap. True windowed virtualization (for 100k-row grids) is deferred; to
// avoid the everyday dead-end where added rows/columns are unreachable we render
// the whole grid up to a safe DOM size and only show the "virtualization
// deferred" note when data truly exceeds that cap.
const MAX_RENDER_ROWS = 300;
const MAX_RENDER_COLS = 60;

const DEFAULT_COLS = 26;
const DEFAULT_ROWS = 50;

const COL_WIDTH = 96; // px
const ROW_HEADER_WIDTH = 48; // px
const ROW_HEIGHT = 28; // px

interface NumberFormatOption {
  label: string;
  value: string; // empty string === General
}

const NUMBER_FORMATS: NumberFormatOption[] = [
  { label: "General", value: "" },
  { label: "Number (0.00)", value: "#,##0.00" },
  { label: "Percent (0%)", value: "0%" },
  { label: "Currency ($)", value: "$#,##0.00" },
  { label: "Date (yyyy-mm-dd)", value: "yyyy-mm-dd" },
];

// ---- pure helpers -----------------------------------------------------------

/** Build the empty initial sheet model: one grid, no populated cells. */
function initialSheetMeta(): SheetMeta {
  return {
    kind: "sheet",
    grids: [createGrid("grid-1", "Sheet 1", DEFAULT_ROWS, DEFAULT_COLS)],
  };
}

/**
 * The raw, editable text for a cell: its formula source when it has one,
 * otherwise the literal value as a string. This is what the formula bar and the
 * in-cell editor show while editing.
 */
function rawText(cell: Cell | undefined): string {
  if (cell === undefined) return "";
  if (typeof cell.f === "string" && cell.f.startsWith("=")) return cell.f;
  if (cell.v === undefined || cell.v === null) return "";
  return String(cell.v);
}

/**
 * Turn user-entered text into a Cell. A leading "=" makes it a formula;
 * otherwise we infer number / boolean / string. Empty text clears the cell.
 */
function cellFromInput(text: string, prev: Cell | undefined): Cell | undefined {
  const trimmed = text.trim();
  const fmt = prev?.fmt;

  if (trimmed === "") {
    // Preserve formatting on an otherwise-empty cell so format-then-type works.
    if (fmt) return { fmt };
    return undefined;
  }

  if (trimmed.startsWith("=")) {
    // A formula's result type is not known until it is computed (it may be a
    // string, boolean, number, or date), so we omit `t` and let consumers
    // derive the type from the computed value rather than mislabelling it.
    return { f: trimmed, ...(fmt ? { fmt } : {}) };
  }

  // boolean
  const lower = trimmed.toLowerCase();
  if (lower === "true" || lower === "false") {
    return { v: lower === "true", t: "bool", ...(fmt ? { fmt } : {}) };
  }

  // number (reject things like "1px"; allow leading +/-, decimals, exponent)
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
    return { v: Number(trimmed), t: "number", ...(fmt ? { fmt } : {}) };
  }

  return { v: text, t: "string", ...(fmt ? { fmt } : {}) };
}

/** Render a computed value for display, applying the cell's number format. */
function displayString(
  cell: Cell | undefined,
  computed: CellValue | undefined,
): { text: string; error: boolean } {
  const value = cellDisplayValue(cell, computed);
  if (value === null) return { text: "", error: false };
  if (isError(value)) return { text: value.error, error: true };
  if (typeof value === "boolean") {
    return { text: value ? "TRUE" : "FALSE", error: false };
  }
  if (typeof value === "number") {
    const nf = cell?.fmt?.numberFormat;
    if (nf) return { text: formatNumber(value, nf), error: false };
    return { text: String(value), error: false };
  }
  // string
  return { text: value, error: false };
}

/** CSS for a cell's static formatting (font, fill, alignment, borders). */
function formatStyle(fmt: CellFormat | undefined): React.CSSProperties {
  if (!fmt) return {};
  const style: React.CSSProperties = {};
  if (fmt.fill) style.backgroundColor = fmt.fill;
  if (fmt.font) {
    if (fmt.font.family) style.fontFamily = fmt.font.family;
    if (fmt.font.size) style.fontSize = fmt.font.size;
    if (fmt.font.bold) style.fontWeight = 600;
    if (fmt.font.italic) style.fontStyle = "italic";
    if (fmt.font.color) style.color = fmt.font.color;
  }
  if (fmt.align?.h) style.textAlign = fmt.align.h;
  if (fmt.border) {
    const c = fmt.border.color ?? "#94a3b8";
    if (fmt.border.top) style.borderTop = `1px solid ${c}`;
    if (fmt.border.right) style.borderRight = `1px solid ${c}`;
    if (fmt.border.bottom) style.borderBottom = `1px solid ${c}`;
    if (fmt.border.left) style.borderLeft = `1px solid ${c}`;
  }
  return style;
}

// Human-readable explanations for formula error codes, surfaced as a cell
// `title` so hovering an error reveals why (FR-7b).
const ERROR_EXPLANATIONS: Record<string, string> = {
  "#CIRCULAR!": "#CIRCULAR!: a formula refers to itself",
  "#REF!": "#REF!: invalid cell reference",
  "#DIV/0!": "#DIV/0!: division by zero",
  "#NAME?": "#NAME?: unknown function/name",
  "#VALUE!": "#VALUE!: wrong value type",
  "#N/A": "#N/A: value not available",
};

interface CellRC {
  r: number;
  c: number;
}

interface Selection {
  anchor: CellRC;
  focus: CellRC;
}

/** Normalize a selection to an inclusive top-left/bottom-right rectangle. */
function selectionRect(sel: Selection): {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
} {
  return {
    r0: Math.min(sel.anchor.r, sel.focus.r),
    r1: Math.max(sel.anchor.r, sel.focus.r),
    c0: Math.min(sel.anchor.c, sel.focus.c),
    c1: Math.max(sel.anchor.c, sel.focus.c),
  };
}

/** Enumerate every cell key inside a selection, row-major. */
function selectionKeys(sel: Selection): string[] {
  const { r0, r1, c0, c1 } = selectionRect(sel);
  const keys: string[] = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) keys.push(cellKey(c, r));
  }
  return keys;
}

/** Parse clipboard TSV text into a 2D block of raw cell strings. */
function parseTsv(text: string): string[][] {
  // Strip a single trailing newline so a copied block does not gain a blank row.
  const body = text.replace(/\r\n/g, "\n").replace(/\n$/, "");
  if (body === "") return [[""]];
  return body.split("\n").map((line) => line.split("\t"));
}

/**
 * Decimal-format helpers for the increase/decrease-decimals buttons. We only
 * manipulate plain fixed-decimal formats ("0", "0.0", "0.00", ...). Any other
 * number format (currency, percent, date) is left to the presets dropdown; the
 * buttons then start a fresh fixed-decimal format from scratch.
 */
function decimalCount(nf: string | undefined): number | null {
  if (nf === undefined || nf === "") return 0; // General behaves like 0 decimals
  const m = /^0(?:\.(0+))?$/.exec(nf);
  if (!m) return null;
  return m[1] ? m[1].length : 0;
}

function decimalFormat(count: number): string | undefined {
  if (count <= 0) return undefined; // back to General
  return "0." + "0".repeat(count);
}

// ---- component --------------------------------------------------------------

export function SheetSurface(props: {
  workspaceId?: string;
  designId?: string;
}): React.ReactElement {
  void props.workspaceId;
  void props.designId;

  const sheet = useEditor((s) => s.doc.meta.sheet as SheetMeta | undefined);
  // `rev` is bumped on every store mutation; subscribing makes recompute and
  // the rendered grid track undo/redo and external edits.
  const rev = useEditor((s) => s.rev);

  // The active grid (tab). Multi-grid tabs are deferred; we always use grid 0.
  const grid: Grid | undefined = sheet?.grids[0];

  const toast = useToast();

  // Active cell + editing state.
  const [activeKey, setActiveKey] = useState<string>("A1");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const editorRef = useRef<HTMLInputElement | null>(null);
  const gridScrollRef = useRef<HTMLDivElement | null>(null);

  // Range selection. anchor is the fixed corner, focus the moving corner; both
  // default to the active cell so a single click is a 1x1 selection. The active
  // cell (the one the formula bar edits) is kept distinct from the block.
  const [selection, setSelection] = useState<Selection>({
    anchor: { r: 0, c: 0 },
    focus: { r: 0, c: 0 },
  });
  // True while the primary mouse button is held over the grid (drag-select).
  const draggingRef = useRef(false);
  // Caret position inside the in-cell editor, tracked so clicking another cell
  // while editing an "=" formula can splice a ref in at the caret (FR-7a).
  const caretRef = useRef<number>(0);

  // First-mount initialization: if there is no sheet, create one. Run as an
  // effect so it persists through the store (one undoable step) rather than
  // mutating during render.
  useEffect(() => {
    if (sheet === undefined) {
      useEditor.getState().setDocMeta({ sheet: initialSheetMeta() });
    }
  }, [sheet]);

  // A per-mount clock for TODAY/NOW-style functions, captured via a lazy
  // initializer (not during render) so recompute stays a pure function of its
  // inputs and the React compiler is satisfied.
  const [now] = useState(() => Date.now());

  // Cell formatting lives in the top toolbar (spreadsheet convention, like
  // Google Sheets), so it never competes with the grid for horizontal space.
  // The borders control is a small dropdown to keep the toolbar compact.
  const [bordersOpen, setBordersOpen] = useState(false);
  const bordersRef = useRef<HTMLDivElement | null>(null);

  // Header right-click context menu (insert/delete row or column at a position).
  const [headerMenu, setHeaderMenu] = useState<
    | { kind: "row"; index: number; x: number; y: number }
    | { kind: "col"; index: number; x: number; y: number }
    | null
  >(null);
  useEffect(() => {
    if (!headerMenu) return;
    const close = () => setHeaderMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHeaderMenu(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [headerMenu]);

  // Release the drag-select flag on any mouse-up, even outside the grid.
  useEffect(() => {
    const onUp = () => {
      draggingRef.current = false;
    };
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, []);
  useEffect(() => {
    if (!bordersOpen) return;
    const onDown = (e: MouseEvent) => {
      if (bordersRef.current && !bordersRef.current.contains(e.target as Node)) setBordersOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setBordersOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [bordersOpen]);

  // Recompute formula results whenever the grid (or rev) changes.
  const computed = useMemo<Record<string, CellValue>>(() => {
    if (!grid) return {};
    return recomputeGrid(grid, { now });
    // rev captures structural mutations the grid identity might not surface.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid, rev, now]);

  const conditional = sheet?.conditional ?? [];

  // Persist a replacement grid back into doc.meta.sheet as one undoable step.
  const commitGrid = useCallback(
    (nextGrid: Grid) => {
      const base = useEditor.getState().doc.meta.sheet as
        | SheetMeta
        | undefined;
      const current = base ?? initialSheetMeta();
      const grids = current.grids.slice();
      grids[0] = nextGrid;
      useEditor.getState().setDocMeta({ sheet: { ...current, grids } });
    },
    [],
  );

  const renderRows = grid ? Math.min(grid.rows, MAX_RENDER_ROWS) : 0;
  const renderCols = grid ? Math.min(grid.cols, MAX_RENDER_COLS) : 0;

  // ---- editing lifecycle ----------------------------------------------------

  const beginEdit = useCallback(
    (key: string, seed?: string) => {
      if (!grid) return;
      setActiveKey(key);
      setEditing(true);
      setDraft(seed ?? rawText(getCell(grid, key)));
    },
    [grid],
  );

  const cancelEdit = useCallback(() => {
    setEditing(false);
    setDraft("");
  }, []);

  // Commit the draft to a specific cell. Persistence happens here (on
  // commit/blur/Enter/Tab), never per keystroke, so typing is one undo step.
  const commitDraft = useCallback(
    (key: string, text: string) => {
      if (!grid) return;
      const prev = getCell(grid, key);
      const nextCell = cellFromInput(text, prev);
      const nextGrid = setCell(grid, key, nextCell);
      commitGrid(nextGrid);
      setEditing(false);
      setDraft("");
    },
    [grid, commitGrid],
  );

  // True when we are mid-edit on a formula (draft begins with "="). In that mode
  // clicking / drag-selecting cells splices a ref into the draft rather than
  // moving the active cell (FR-7a).
  const insertingRef = editing && draft.trimStart().startsWith("=");

  // The span of text last spliced into the draft by a ref click, so a follow-up
  // drag can rewrite it from a single ref ("B3") to a range ("B3:C5").
  const refSpanRef = useRef<{ start: number; len: number } | null>(null);

  const focusEditorCaret = useCallback((pos: number) => {
    requestAnimationFrame(() => {
      const el = editorRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(pos, pos);
      }
    });
  }, []);

  // Splice an A1 ref (cell "B3" or range "B3:C5") into the draft at the caret,
  // then keep editing (FR-7a). Records the inserted span for range upgrades.
  const insertRefIntoDraft = useCallback(
    (ref: string) => {
      const start = Math.min(caretRef.current, draft.length);
      setDraft((prev) => prev.slice(0, start) + ref + prev.slice(start));
      refSpanRef.current = { start, len: ref.length };
      caretRef.current = start + ref.length;
      focusEditorCaret(start + ref.length);
    },
    [draft, focusEditorCaret],
  );

  // Replace the last-inserted ref span with new text (used when a ref-click
  // turns into a drag, upgrading "B3" -> "B3:C5").
  const replaceRefSpan = useCallback(
    (ref: string) => {
      const span = refSpanRef.current;
      if (!span) return;
      setDraft((prev) => prev.slice(0, span.start) + ref + prev.slice(span.start + span.len));
      refSpanRef.current = { start: span.start, len: ref.length };
      caretRef.current = span.start + ref.length;
      focusEditorCaret(span.start + ref.length);
    },
    [focusEditorCaret],
  );

  // Move the active cell by a delta, clamped to the grid extent. A plain move
  // collapses the selection onto the new active cell; an extending move
  // (Shift+Arrow) keeps the anchor and moves only the focus (FR-3).
  const moveActive = useCallback(
    (dCol: number, dRow: number, extend = false) => {
      if (!grid) return;
      let ref;
      try {
        ref = parseRef(activeKey);
      } catch {
        return;
      }
      const col = Math.max(0, Math.min(grid.cols - 1, ref.col + dCol));
      const row = Math.max(0, Math.min(grid.rows - 1, ref.row + dRow));
      if (extend) {
        // Keep the active cell fixed; grow/shrink the selection focus from it.
        setSelection((prev) => ({ anchor: prev.anchor, focus: { r: row, c: col } }));
      } else {
        setActiveKey(cellKey(col, row));
        setSelection({ anchor: { r: row, c: col }, focus: { r: row, c: col } });
      }
    },
    [grid, activeKey],
  );

  // Focus the in-cell editor when editing starts. When editing ENDS, return
  // focus to the grid container so keyboard navigation (arrows / Enter / typing)
  // resumes immediately after an Enter/Tab commit instead of falling to <body>
  // and dropping the next keypress. We only steal focus back when it landed on
  // <body> or stayed inside the surface (i.e. the in-cell input just unmounted),
  // never when the user clicked/tabbed away to another part of the page.
  useEffect(() => {
    if (editing) {
      if (editorRef.current) {
        editorRef.current.focus();
        editorRef.current.select();
      }
      return;
    }
    const container = gridScrollRef.current;
    if (!container) return;
    const active = document.activeElement;
    const focusLeftEditor =
      active === null ||
      active === document.body ||
      container.contains(active);
    if (focusLeftEditor && active !== container) {
      container.focus();
    }
  }, [editing]);

  // In-cell / formula-bar editor key handling.
  const onEditorKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitDraft(activeKey, draft);
        moveActive(0, e.shiftKey ? -1 : 1); // Shift+Enter moves up
      } else if (e.key === "Tab") {
        e.preventDefault();
        commitDraft(activeKey, draft);
        moveActive(e.shiftKey ? -1 : 1, 0); // Shift+Tab moves left
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelEdit();
      }
    },
    [activeKey, draft, commitDraft, moveActive, cancelEdit],
  );

  // ---- toolbar actions ------------------------------------------------------

  // Merge a format `partial` into one cell's `fmt`, returning the next Cell (or
  // undefined if the cell becomes entirely empty). `partial` is shallow-merged;
  // a field whose value is `undefined` is deleted (so callers can clear a key by
  // passing `{ fill: undefined }`). Empty font/border/align sub-objects are
  // dropped. This is pure so it can be applied across a whole selection.
  const mergeCellFmt = useCallback(
    (prev: Cell | undefined, partial: Partial<CellFormat>): Cell | undefined => {
      const nextFmt: CellFormat = { ...(prev?.fmt ?? {}) };
      for (const [k, value] of Object.entries(partial)) {
        const field = k as keyof CellFormat;
        if (value === undefined) {
          delete nextFmt[field];
        } else {
          const existing = nextFmt[field];
          if (
            existing &&
            typeof existing === "object" &&
            typeof value === "object"
          ) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (nextFmt as any)[field] = { ...existing, ...value };
          } else {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (nextFmt as any)[field] = value;
          }
        }
      }
      for (const sub of ["font", "border", "align"] as const) {
        const v = nextFmt[sub];
        if (v && typeof v === "object" && Object.keys(v).length === 0) {
          delete nextFmt[sub];
        }
      }
      const hasFmt = Object.keys(nextFmt).length > 0;
      const nextCell: Cell = { ...(prev ?? {}), fmt: hasFmt ? nextFmt : undefined };
      const isEmpty =
        nextCell.v === undefined &&
        nextCell.f === undefined &&
        nextCell.fmt === undefined;
      return isEmpty ? undefined : nextCell;
    },
    [],
  );

  // Apply a format `partial` to every cell in the current selection (the whole
  // highlighted block, not just the active cell) as one undoable commit. Reads
  // live state via `getCell`.
  const patchActiveFmt = useCallback(
    (partial: Partial<CellFormat>) => {
      if (!grid) return;
      const keys = selectionKeys(selection);
      let next = grid;
      for (const key of keys) {
        next = setCell(next, key, mergeCellFmt(getCell(next, key), partial));
      }
      commitGrid(next);
    },
    [grid, selection, commitGrid, mergeCellFmt],
  );

  const setActiveNumberFormat = useCallback(
    (numberFormat: string) => {
      patchActiveFmt({ numberFormat: numberFormat === "" ? undefined : numberFormat });
    },
    [patchActiveFmt],
  );

  // Increase / decrease the decimal places of every selected cell's number
  // format, anchored on the active cell's current decimal count (FR-8).
  const stepDecimals = useCallback(
    (delta: number) => {
      if (!grid) return;
      const cur = decimalCount(getCell(grid, activeKey)?.fmt?.numberFormat);
      const base = cur === null ? 0 : cur; // non-fixed formats restart at 0
      const next = Math.max(0, Math.min(10, base + delta));
      patchActiveFmt({ numberFormat: decimalFormat(next) });
    },
    [grid, activeKey, patchActiveFmt],
  );

  // ---- structural ops (insert/delete row & column at a position) ------------

  const addRow = useCallback(() => {
    if (!grid) return;
    commitGrid(insertRow(grid, grid.rows));
    // Scroll the new last row into view so the added row is visibly reachable.
    requestAnimationFrame(() => {
      const el = gridScrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, [grid, commitGrid]);

  const addColumn = useCallback(() => {
    if (!grid) return;
    commitGrid(insertCol(grid, grid.cols));
    requestAnimationFrame(() => {
      const el = gridScrollRef.current;
      if (el) el.scrollLeft = el.scrollWidth;
    });
  }, [grid, commitGrid]);

  const doInsertRow = useCallback(
    (at: number) => {
      if (!grid) return;
      commitGrid(insertRow(grid, at));
    },
    [grid, commitGrid],
  );
  const doDeleteRow = useCallback(
    (at: number) => {
      if (!grid || grid.rows <= 1) return;
      commitGrid(deleteRow(grid, at));
    },
    [grid, commitGrid],
  );
  const doInsertCol = useCallback(
    (at: number) => {
      if (!grid) return;
      commitGrid(insertCol(grid, at));
    },
    [grid, commitGrid],
  );
  const doDeleteCol = useCallback(
    (at: number) => {
      if (!grid || grid.cols <= 1) return;
      commitGrid(deleteCol(grid, at));
    },
    [grid, commitGrid],
  );

  // ---- clipboard + fill -----------------------------------------------------

  // Build the TSV for the current selection from each cell's RAW text (formula
  // source or literal), tab between columns, newline between rows.
  const selectionToTsv = useCallback((): string => {
    if (!grid) return "";
    const { r0, r1, c0, c1 } = selectionRect(selection);
    const rows: string[] = [];
    for (let r = r0; r <= r1; r++) {
      const cols: string[] = [];
      for (let c = c0; c <= c1; c++) cols.push(rawText(getCell(grid, cellKey(c, r))));
      rows.push(cols.join("\t"));
    }
    return rows.join("\n");
  }, [grid, selection]);

  const copySelection = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(selectionToTsv());
    } catch {
      toast.error("Clipboard copy blocked by the browser. Grant clipboard permission.");
    }
  }, [selectionToTsv, toast]);

  const clearSelectionGrid = useCallback(
    (g: Grid): Grid => {
      let next = g;
      for (const key of selectionKeys(selection)) {
        // Preserve formatting on cut, matching delete: clear value/formula only.
        const prev = getCell(next, key);
        const kept = prev?.fmt ? { fmt: prev.fmt } : undefined;
        next = setCell(next, key, kept);
      }
      return next;
    },
    [selection],
  );

  const cutSelection = useCallback(async () => {
    if (!grid) return;
    try {
      await navigator.clipboard.writeText(selectionToTsv());
    } catch {
      toast.error("Clipboard cut blocked by the browser. Grant clipboard permission.");
      return;
    }
    commitGrid(clearSelectionGrid(grid));
  }, [grid, selectionToTsv, clearSelectionGrid, commitGrid, toast]);

  const pasteSelection = useCallback(async () => {
    if (!grid) return;
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      toast.error("Clipboard paste blocked by the browser. Grant clipboard permission.");
      return;
    }
    if (text === "") return;
    const block = parseTsv(text);
    let ref;
    try {
      ref = parseRef(activeKey);
    } catch {
      return;
    }
    const needRows = ref.row + block.length;
    const needCols = ref.col + Math.max(...block.map((row) => row.length));
    let next: Grid = {
      ...grid,
      rows: Math.max(grid.rows, needRows),
      cols: Math.max(grid.cols, needCols),
    };
    for (let r = 0; r < block.length; r++) {
      const row = block[r];
      for (let c = 0; c < row.length; c++) {
        const key = cellKey(ref.col + c, ref.row + r);
        next = setCell(next, key, cellFromInput(row[c], getCell(next, key)));
      }
    }
    commitGrid(next);
  }, [grid, activeKey, commitGrid, toast]);

  // Fill DOWN: copy the top row of the selection into every row below it.
  // Fill RIGHT: copy the left column into every column to its right (FR-4).
  const fillSelection = useCallback(
    (dir: "down" | "right") => {
      if (!grid) return;
      const { r0, r1, c0, c1 } = selectionRect(selection);
      let next = grid;
      if (dir === "down") {
        for (let c = c0; c <= c1; c++) {
          const src = getCell(next, cellKey(c, r0));
          for (let r = r0 + 1; r <= r1; r++) {
            next = setCell(next, cellKey(c, r), src ? { ...src } : undefined);
          }
        }
      } else {
        for (let r = r0; r <= r1; r++) {
          const src = getCell(next, cellKey(c0, r));
          for (let c = c0 + 1; c <= c1; c++) {
            next = setCell(next, cellKey(c, r), src ? { ...src } : undefined);
          }
        }
      }
      commitGrid(next);
    },
    [grid, selection, commitGrid],
  );

  // Keyboard handling on the grid container (when not editing a cell). Declared
  // after the clipboard/fill callbacks it references.
  const onGridKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (editing) return;
      const mod = e.metaKey || e.ctrlKey;

      // Undo / redo. The Canvas (which normally owns these) is not mounted for
      // sheets, so without this Cmd+Z would do nothing in a spreadsheet.
      if (mod && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) useEditor.getState().redo();
        else useEditor.getState().undo();
        return;
      }
      if (mod && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        useEditor.getState().redo();
        return;
      }

      // Clipboard + fill. These read/write the live selection.
      if (mod && (e.key === "c" || e.key === "C")) {
        e.preventDefault();
        void copySelection();
        return;
      }
      if (mod && (e.key === "x" || e.key === "X")) {
        e.preventDefault();
        void cutSelection();
        return;
      }
      if (mod && (e.key === "v" || e.key === "V")) {
        e.preventDefault();
        void pasteSelection();
        return;
      }
      if (mod && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        fillSelection("down");
        return;
      }
      if (mod && (e.key === "r" || e.key === "R")) {
        e.preventDefault();
        fillSelection("right");
        return;
      }

      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          moveActive(0, -1, e.shiftKey);
          break;
        case "ArrowDown":
          e.preventDefault();
          moveActive(0, 1, e.shiftKey);
          break;
        case "ArrowLeft":
          e.preventDefault();
          moveActive(-1, 0, e.shiftKey);
          break;
        case "ArrowRight":
          e.preventDefault();
          moveActive(1, 0, e.shiftKey);
          break;
        case "Tab":
          e.preventDefault();
          moveActive(e.shiftKey ? -1 : 1, 0);
          break;
        case "Enter":
        case "F2":
          e.preventDefault();
          beginEdit(activeKey);
          break;
        case "Backspace":
        case "Delete":
          e.preventDefault();
          // Clear value/formula for the whole selection (keep formatting),
          // one undoable commit.
          if (grid) commitGrid(clearSelectionGrid(grid));
          break;
        default:
          // A printable character starts editing with that character.
          if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
            e.preventDefault();
            beginEdit(activeKey, e.key);
          }
      }
    },
    [
      editing,
      moveActive,
      beginEdit,
      activeKey,
      grid,
      commitGrid,
      copySelection,
      cutSelection,
      pasteSelection,
      fillSelection,
      clearSelectionGrid,
    ],
  );

  // ---- render ---------------------------------------------------------------

  if (!grid) {
    return (
      <div className="grid flex-1 place-items-center bg-neutral-50 text-sm text-neutral-500">
        Preparing sheet...
      </div>
    );
  }

  const activeCell = getCell(grid, activeKey);
  const activeFmt = activeCell?.fmt;
  const activeFormatValue = activeFmt?.numberFormat ?? "";
  const fontColor = activeFmt?.font?.color ?? "#1f2937";
  const fillColor = activeFmt?.fill ?? "#ffffff";
  const borderColor = activeFmt?.border?.color ?? "#94a3b8";
  const alignH = activeFmt?.align?.h;
  const selRect = selectionRect(selection);

  // Toggle a single border edge on/off, preserving the others and the color.
  const toggleBorderEdge = (edge: "top" | "right" | "bottom" | "left") => {
    const cur = activeFmt?.border ?? {};
    const nextOn = !cur[edge];
    const next: NonNullable<CellFormat["border"]> = { ...cur, [edge]: nextOn };
    if (!nextOn) delete next[edge];
    // Drop a color-only border (no edges) so the cell does not keep dead state.
    const hasEdge = next.top || next.right || next.bottom || next.left;
    if (!hasEdge) {
      patchActiveFmt({ border: undefined });
    } else {
      if (!next.color) next.color = borderColor;
      patchActiveFmt({ border: next });
    }
  };

  const setAllBorders = () => {
    patchActiveFmt({
      border: {
        top: true,
        right: true,
        bottom: true,
        left: true,
        color: activeFmt?.border?.color ?? borderColor,
      },
    });
  };

  // A small square toggle button used across the Text/Alignment/Borders groups.
  const iconToggle = (
    active: boolean,
    onClick: () => void,
    title: string,
    node: React.ReactNode,
  ) => (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={title}
      className={[
        "inline-flex h-7 w-7 items-center justify-center rounded-md border text-xs",
        active
          ? "border-blue-400 bg-blue-50 text-blue-600"
          : "border-neutral-200 bg-surface text-neutral-600 hover:bg-neutral-100",
      ].join(" ")}
    >
      {node}
    </button>
  );

  return (
    <div className="light flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-surface text-neutral-900">
      {/* Toolbar: structure + cell formatting for the active cell (spreadsheet
          convention - a full-width top toolbar, like Google Sheets). */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-neutral-200 bg-neutral-50 px-3 py-1.5">
        <button
          type="button"
          onClick={addRow}
          className="inline-flex items-center gap-1 rounded-md border border-neutral-200 bg-surface px-2 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100"
          title="Add row"
        >
          <Rows3 className="h-3.5 w-3.5" /> Row
        </button>
        <button
          type="button"
          onClick={addColumn}
          className="inline-flex items-center gap-1 rounded-md border border-neutral-200 bg-surface px-2 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100"
          title="Add column"
        >
          <Columns3 className="h-3.5 w-3.5" /> Column
        </button>

        <div className="mx-0.5 h-5 w-px bg-neutral-200" />

        {/* Number format */}
        <select
          value={activeFormatValue}
          onChange={(e) => setActiveNumberFormat(e.target.value)}
          className="rounded-md border border-neutral-200 bg-surface px-1.5 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 focus:outline-none focus:ring-1 focus:ring-blue-400"
          title="Number format for the active cell"
        >
          {NUMBER_FORMATS.map((nf) => (
            <option key={nf.label} value={nf.value}>{nf.label}</option>
          ))}
        </select>

        {/* Decimal places */}
        <button
          type="button"
          onClick={() => stepDecimals(1)}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-neutral-200 bg-surface text-neutral-600 hover:bg-neutral-100"
          title="Increase decimal places"
        >
          <DecimalsArrowRight className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => stepDecimals(-1)}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-neutral-200 bg-surface text-neutral-600 hover:bg-neutral-100"
          title="Decrease decimal places"
        >
          <DecimalsArrowLeft className="h-3.5 w-3.5" />
        </button>

        <div className="mx-0.5 h-5 w-px bg-neutral-200" />

        {/* Text: bold / italic / color / size */}
        {iconToggle(
          !!activeFmt?.font?.bold,
          () => patchActiveFmt({ font: { bold: activeFmt?.font?.bold ? undefined : true } }),
          "Bold",
          <Bold className="h-3.5 w-3.5" />,
        )}
        {iconToggle(
          !!activeFmt?.font?.italic,
          () => patchActiveFmt({ font: { italic: activeFmt?.font?.italic ? undefined : true } }),
          "Italic",
          <Italic className="h-3.5 w-3.5" />,
        )}
        <label className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-neutral-200 bg-surface hover:bg-neutral-100" title="Text color" style={{ color: fontColor }}>
          <Type className="h-3.5 w-3.5" />
          <input type="color" value={fontColor} onChange={(e) => patchActiveFmt({ font: { color: e.target.value } })} className="sr-only" />
        </label>
        <input
          type="number"
          min={6}
          max={96}
          value={activeFmt?.font?.size ?? ""}
          placeholder="Size"
          onChange={(e) => {
            const n = Number(e.target.value);
            patchActiveFmt({ font: { size: e.target.value === "" || !Number.isFinite(n) ? undefined : n } });
          }}
          className="w-14 rounded-md border border-neutral-200 px-1.5 py-1 text-xs text-neutral-700 focus:outline-none focus:ring-1 focus:ring-blue-400"
          title="Font size"
        />

        <div className="mx-0.5 h-5 w-px bg-neutral-200" />

        {/* Alignment */}
        {iconToggle(alignH === "left", () => patchActiveFmt({ align: { h: alignH === "left" ? undefined : "left" } }), "Align left", <AlignLeft className="h-3.5 w-3.5" />)}
        {iconToggle(alignH === "center", () => patchActiveFmt({ align: { h: alignH === "center" ? undefined : "center" } }), "Align center", <AlignCenter className="h-3.5 w-3.5" />)}
        {iconToggle(alignH === "right", () => patchActiveFmt({ align: { h: alignH === "right" ? undefined : "right" } }), "Align right", <AlignRight className="h-3.5 w-3.5" />)}

        <div className="mx-0.5 h-5 w-px bg-neutral-200" />

        {/* Fill */}
        <label className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-neutral-200 bg-surface hover:bg-neutral-100" title="Fill color" style={{ color: fillColor }}>
          <PaintBucket className="h-3.5 w-3.5" />
          <input type="color" value={fillColor} onChange={(e) => patchActiveFmt({ fill: e.target.value })} className="sr-only" />
        </label>
        {activeFmt?.fill && (
          <button type="button" onClick={() => patchActiveFmt({ fill: undefined })} className="rounded-md border border-neutral-200 bg-surface px-1.5 py-1 text-[11px] text-neutral-600 hover:bg-neutral-100" title="Clear fill">Clear</button>
        )}

        {/* Borders dropdown */}
        <div ref={bordersRef} className="relative">
          <button
            type="button"
            onClick={() => setBordersOpen((v) => !v)}
            className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs ${bordersOpen ? "border-blue-400 bg-blue-50 text-blue-600" : "border-neutral-200 bg-surface text-neutral-600 hover:bg-neutral-100"}`}
            title="Borders"
            aria-expanded={bordersOpen}
          >
            <Square className="h-3.5 w-3.5" /> <ChevronDown className="h-3 w-3" />
          </button>
          {bordersOpen && (
            <div className="absolute left-0 z-30 mt-1 flex flex-col gap-2 rounded-lg border border-neutral-200 bg-surface p-2 shadow-lg">
              <div className="flex items-center gap-1.5">
                {iconToggle(!!activeFmt?.border?.top, () => toggleBorderEdge("top"), "Top border", <span className="text-[10px] font-semibold">T</span>)}
                {iconToggle(!!activeFmt?.border?.right, () => toggleBorderEdge("right"), "Right border", <span className="text-[10px] font-semibold">R</span>)}
                {iconToggle(!!activeFmt?.border?.bottom, () => toggleBorderEdge("bottom"), "Bottom border", <span className="text-[10px] font-semibold">B</span>)}
                {iconToggle(!!activeFmt?.border?.left, () => toggleBorderEdge("left"), "Left border", <span className="text-[10px] font-semibold">L</span>)}
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={setAllBorders} className="rounded-md border border-neutral-200 bg-surface px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100">All</button>
                <button type="button" onClick={() => patchActiveFmt({ border: undefined })} className="rounded-md border border-neutral-200 bg-surface px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100">None</button>
                <label className="ml-auto inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-neutral-200" title="Border color" style={{ color: borderColor }}>
                  <Square className="h-3.5 w-3.5" />
                  <input
                    type="color"
                    value={borderColor}
                    onChange={(e) => {
                      const cur = activeFmt?.border;
                      if (cur && (cur.top || cur.right || cur.bottom || cur.left)) patchActiveFmt({ border: { color: e.target.value } });
                      else patchActiveFmt({ border: { top: true, right: true, bottom: true, left: true, color: e.target.value } });
                    }}
                    className="sr-only"
                  />
                </label>
              </div>
            </div>
          )}
        </div>

        <span className="ml-auto whitespace-nowrap text-xs text-neutral-400">
          {grid.name} · {grid.rows}×{grid.cols}
        </span>
      </div>

      {/* Formula bar */}
      <div className="flex items-center gap-2 border-b border-neutral-200 bg-surface px-3 py-1.5">
        <span className="min-w-12 rounded border border-neutral-200 bg-neutral-50 px-2 py-1 text-center font-mono text-xs font-semibold text-neutral-700">
          {activeKey}
        </span>
        <span className="select-none text-sm text-neutral-400">fx</span>
        <input
          // Editing through the formula bar uses the same draft as the cell.
          value={editing ? draft : rawText(activeCell)}
          onChange={(e) => {
            if (!editing) setEditing(true);
            caretRef.current = e.target.selectionStart ?? e.target.value.length;
            setDraft(e.target.value);
          }}
          onSelect={(e) => {
            caretRef.current = e.currentTarget.selectionStart ?? caretRef.current;
          }}
          onFocus={() => {
            if (!editing) {
              setEditing(true);
              setDraft(rawText(activeCell));
            }
          }}
          onKeyDown={onEditorKeyDown}
          onBlur={() => {
            // A blur caused by clicking a cell to splice a formula ref must not
            // commit and tear down the edit; the cell mouse handler manages it.
            if (editing && !insertingRef) commitDraft(activeKey, draft);
          }}
          placeholder="Enter a value or =FORMULA"
          className="flex-1 rounded border border-transparent px-2 py-1 font-mono text-sm text-neutral-800 hover:border-neutral-200 focus:border-blue-400 focus:outline-none"
        />
      </div>

      {/* Grid (fills the area; formatting is in the top toolbar). */}
      <div
        ref={gridScrollRef}
        tabIndex={0}
        onKeyDown={onGridKeyDown}
        className="min-h-0 min-w-0 flex-1 overflow-auto outline-none"
      >
        <table
          className="border-collapse"
          style={{ tableLayout: "fixed" }}
        >
          <thead>
            <tr>
              {/* Corner */}
              <th
                className="sticky left-0 top-0 z-30 border border-neutral-200 bg-neutral-100"
                style={{
                  width: ROW_HEADER_WIDTH,
                  minWidth: ROW_HEADER_WIDTH,
                  height: ROW_HEIGHT,
                }}
              />
              {Array.from({ length: renderCols }, (_, c) => (
                <th
                  key={c}
                  onMouseDown={() => {
                    // Select the whole column.
                    if (editing) commitDraft(activeKey, draft);
                    setActiveKey(cellKey(c, 0));
                    setSelection({
                      anchor: { r: 0, c },
                      focus: { r: grid.rows - 1, c },
                    });
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setHeaderMenu({ kind: "col", index: c, x: e.clientX, y: e.clientY });
                  }}
                  className="sticky top-0 z-20 cursor-pointer select-none border border-neutral-200 bg-neutral-100 text-center text-[11px] font-semibold text-neutral-500 hover:bg-neutral-200"
                  style={{ width: COL_WIDTH, minWidth: COL_WIDTH, height: ROW_HEIGHT }}
                >
                  {indexToCol(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: renderRows }, (_, r) => (
              <tr key={r}>
                {/* Row number */}
                <th
                  onMouseDown={() => {
                    // Select the whole row.
                    if (editing) commitDraft(activeKey, draft);
                    setActiveKey(cellKey(0, r));
                    setSelection({
                      anchor: { r, c: 0 },
                      focus: { r, c: grid.cols - 1 },
                    });
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setHeaderMenu({ kind: "row", index: r, x: e.clientX, y: e.clientY });
                  }}
                  className="sticky left-0 z-10 cursor-pointer select-none border border-neutral-200 bg-neutral-100 text-center text-[11px] font-semibold text-neutral-500 hover:bg-neutral-200"
                  style={{
                    width: ROW_HEADER_WIDTH,
                    minWidth: ROW_HEADER_WIDTH,
                    height: ROW_HEIGHT,
                  }}
                >
                  {r + 1}
                </th>
                {Array.from({ length: renderCols }, (_, c) => {
                  const key = cellKey(c, r);
                  const cell = getCell(grid, key);
                  const isActive = key === activeKey;
                  const isEditingThis = isActive && editing;
                  const { text, error } = displayString(cell, computed[key]);

                  // Selection highlight: in-rect cells get a tint; the rectangle
                  // edges get a blue border so the block reads as one region.
                  const inSel =
                    r >= selRect.r0 &&
                    r <= selRect.r1 &&
                    c >= selRect.c0 &&
                    c <= selRect.c1;
                  const multiSel =
                    selRect.r0 !== selRect.r1 || selRect.c0 !== selRect.c1;

                  // Explain a computed error on hover (FR-7b).
                  const computedVal = computed[key];
                  const errorTitle =
                    error && isError(computedVal)
                      ? ERROR_EXPLANATIONS[computedVal.error] ?? computedVal.error
                      : undefined;

                  // Conditional formatting (display-only) layered over the
                  // cell's own format. Later rules win (see @hc/sheets).
                  const condFmt = conditional.length
                    ? applyConditionalFormat(
                        cellDisplayValue(cell, computed[key]),
                        conditional,
                        key,
                      )
                    : undefined;
                  const baseStyle = formatStyle(cell?.fmt);
                  const condStyle = formatStyle(condFmt);

                  const selBorder: React.CSSProperties =
                    inSel && multiSel
                      ? {
                          borderTopColor: r === selRect.r0 ? "#3b82f6" : undefined,
                          borderBottomColor: r === selRect.r1 ? "#3b82f6" : undefined,
                          borderLeftColor: c === selRect.c0 ? "#3b82f6" : undefined,
                          borderRightColor: c === selRect.c1 ? "#3b82f6" : undefined,
                        }
                      : {};

                  return (
                    <td
                      key={c}
                      title={errorTitle}
                      onMouseDown={(e) => {
                        // Formula-ref insertion: while editing an "=" formula,
                        // clicking a cell splices its A1 ref into the draft
                        // instead of moving the active cell (FR-7a).
                        if (insertingRef) {
                          e.preventDefault();
                          draggingRef.current = true;
                          // Seed a 1x1 selection on the clicked cell so a drag
                          // extends from here; the active cell stays put.
                          setSelection({
                            anchor: { r, c },
                            focus: { r, c },
                          });
                          insertRefIntoDraft(key);
                          return;
                        }
                        draggingRef.current = true;
                        if (editing) commitDraft(activeKey, draft);
                        if (e.shiftKey) {
                          // Extend the selection focus to the clicked cell.
                          setSelection((prev) => ({ anchor: prev.anchor, focus: { r, c } }));
                        } else {
                          setActiveKey(key);
                          setSelection({ anchor: { r, c }, focus: { r, c } });
                        }
                      }}
                      onMouseEnter={(e) => {
                        if (!draggingRef.current) return;
                        // Drag-select extends the focus (buttons===1 while held).
                        if (e.buttons !== 1) {
                          draggingRef.current = false;
                          return;
                        }
                        if (insertingRef) {
                          // Upgrade the inserted ref to a range spanning the
                          // drag (anchor -> current cell).
                          const a = selection.anchor;
                          const r0 = Math.min(a.r, r);
                          const r1 = Math.max(a.r, r);
                          const c0 = Math.min(a.c, c);
                          const c1 = Math.max(a.c, c);
                          const refText =
                            r0 === r1 && c0 === c1
                              ? cellKey(c0, r0)
                              : `${cellKey(c0, r0)}:${cellKey(c1, r1)}`;
                          replaceRefSpan(refText);
                          setSelection({ anchor: a, focus: { r, c } });
                          return;
                        }
                        setSelection((prev) => ({ anchor: prev.anchor, focus: { r, c } }));
                      }}
                      onDoubleClick={() => {
                        if (!insertingRef) beginEdit(key);
                      }}
                      className={[
                        "relative border border-neutral-200 px-1.5 align-middle text-sm",
                        inSel && !isActive ? "bg-blue-50" : "",
                        isActive
                          ? "outline outline-2 -outline-offset-2 outline-blue-500"
                          : "",
                      ].join(" ")}
                      style={{
                        width: COL_WIDTH,
                        minWidth: COL_WIDTH,
                        height: ROW_HEIGHT,
                        ...baseStyle,
                        ...condStyle,
                        ...selBorder,
                      }}
                    >
                      {isEditingThis ? (
                        <input
                          ref={editorRef}
                          value={draft}
                          onChange={(e) => {
                            caretRef.current =
                              e.target.selectionStart ?? e.target.value.length;
                            setDraft(e.target.value);
                          }}
                          onSelect={(e) => {
                            caretRef.current =
                              e.currentTarget.selectionStart ?? caretRef.current;
                          }}
                          onKeyDown={onEditorKeyDown}
                          onBlur={() => {
                            // Do not commit when the blur is from clicking a cell
                            // to splice a ref into an "=" formula.
                            if (!insertingRef) commitDraft(activeKey, draft);
                          }}
                          className="absolute inset-0 h-full w-full border-0 bg-surface px-1.5 font-mono text-sm text-neutral-900 outline-none"
                        />
                      ) : (
                        <span
                          className={[
                            "block truncate",
                            error ? "text-red-600" : "",
                            typeof cellDisplayValue(cell, computed[key]) ===
                            "number"
                              ? "text-right"
                              : "",
                          ].join(" ")}
                        >
                          {text}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>

        {(grid.rows > MAX_RENDER_ROWS || grid.cols > MAX_RENDER_COLS) && (
          <div className="flex items-center gap-1.5 px-3 py-2 text-[11px] text-neutral-400">
            <Plus className="h-3 w-3" />
            Showing {renderRows}×{renderCols} of {grid.rows}×{grid.cols}.
            Row/column virtualization is deferred.
          </div>
        )}
      </div>

      {/* Header right-click menu: insert / delete a row or column at a position. */}
      {headerMenu && (
        <div
          className="fixed z-50 min-w-44 rounded-md border border-neutral-200 bg-surface py-1 text-sm shadow-lg"
          style={{ left: headerMenu.x, top: headerMenu.y }}
          // Stop the document mousedown listener from closing before click runs.
          onMouseDown={(e) => e.stopPropagation()}
        >
          {headerMenu.kind === "row" ? (
            <>
              <button
                type="button"
                className="block w-full px-3 py-1.5 text-left text-neutral-700 hover:bg-neutral-100"
                onClick={() => {
                  doInsertRow(headerMenu.index);
                  setHeaderMenu(null);
                }}
              >
                Insert row above
              </button>
              <button
                type="button"
                className="block w-full px-3 py-1.5 text-left text-neutral-700 hover:bg-neutral-100"
                onClick={() => {
                  doInsertRow(headerMenu.index + 1);
                  setHeaderMenu(null);
                }}
              >
                Insert row below
              </button>
              <button
                type="button"
                disabled={grid.rows <= 1}
                className="block w-full px-3 py-1.5 text-left text-red-600 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:text-neutral-300"
                onClick={() => {
                  doDeleteRow(headerMenu.index);
                  setHeaderMenu(null);
                }}
              >
                Delete row
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="block w-full px-3 py-1.5 text-left text-neutral-700 hover:bg-neutral-100"
                onClick={() => {
                  doInsertCol(headerMenu.index);
                  setHeaderMenu(null);
                }}
              >
                Insert column left
              </button>
              <button
                type="button"
                className="block w-full px-3 py-1.5 text-left text-neutral-700 hover:bg-neutral-100"
                onClick={() => {
                  doInsertCol(headerMenu.index + 1);
                  setHeaderMenu(null);
                }}
              >
                Insert column right
              </button>
              <button
                type="button"
                disabled={grid.cols <= 1}
                className="block w-full px-3 py-1.5 text-left text-red-600 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:text-neutral-300"
                onClick={() => {
                  doDeleteCol(headerMenu.index);
                  setHeaderMenu(null);
                }}
              >
                Delete column
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
