// A1-style reference helpers. Columns are 0-based indices internally
// (A=0, B=1, ... Z=25, AA=26, AB=27, ...); rows are 0-based internally
// while the A1 textual form is 1-based ("A1" -> {col:0, row:0}).

export interface CellRef {
  col: number;
  row: number;
  colAbsolute?: boolean;
  rowAbsolute?: boolean;
}

export interface RangeRef {
  start: CellRef;
  end: CellRef;
}

/** "A" -> 0, "Z" -> 25, "AA" -> 26, "AB" -> 27. Case-insensitive. */
export function colToIndex(col: string): number {
  const s = col.toUpperCase();
  if (!/^[A-Z]+$/.test(s)) {
    throw new Error(`Invalid column label: ${col}`);
  }
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    n = n * 26 + (s.charCodeAt(i) - 64); // 'A' is 65 -> 1
  }
  return n - 1; // make 0-based
}

/** 0 -> "A", 25 -> "Z", 26 -> "AA", 27 -> "AB". */
export function indexToCol(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Invalid column index: ${index}`);
  }
  let n = index + 1; // 1-based
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const REF_RE = /^(\$?)([A-Za-z]+)(\$?)(\d+)$/;

/** Parse "B3" -> {col:1,row:2}. Supports absolute "$A$1". */
export function parseRef(ref: string): CellRef {
  const m = REF_RE.exec(ref.trim());
  if (!m) {
    throw new Error(`Invalid cell reference: ${ref}`);
  }
  const [, colDollar, colLabel, rowDollar, rowDigits] = m;
  const row = parseInt(rowDigits, 10) - 1;
  if (row < 0) {
    throw new Error(`Invalid cell reference: ${ref}`);
  }
  return {
    col: colToIndex(colLabel),
    row,
    colAbsolute: colDollar === "$",
    rowAbsolute: rowDollar === "$",
  };
}

/** Parse "A1:B3" -> {start,end}. Normalizes so start is top-left. */
export function parseRange(range: string): RangeRef {
  const parts = range.split(":");
  if (parts.length !== 2) {
    throw new Error(`Invalid range: ${range}`);
  }
  const a = parseRef(parts[0]);
  const b = parseRef(parts[1]);
  return {
    start: {
      col: Math.min(a.col, b.col),
      row: Math.min(a.row, b.row),
      colAbsolute: a.colAbsolute,
      rowAbsolute: a.rowAbsolute,
    },
    end: {
      col: Math.max(a.col, b.col),
      row: Math.max(a.row, b.row),
      colAbsolute: b.colAbsolute,
      rowAbsolute: b.rowAbsolute,
    },
  };
}

/** (1,0) -> "B1". Produces a canonical (non-absolute) cell key. */
export function cellKey(col: number, row: number): string {
  return indexToCol(col) + (row + 1);
}

/** Expand a range into the flat list of cell keys, row-major. */
export function rangeKeys(range: RangeRef): string[] {
  const out: string[] = [];
  for (let r = range.start.row; r <= range.end.row; r++) {
    for (let c = range.start.col; c <= range.end.col; c++) {
      out.push(cellKey(c, r));
    }
  }
  return out;
}

/** Is a string a valid A1 cell reference (ignoring absolute markers)? */
export function isCellRef(s: string): boolean {
  return REF_RE.test(s.trim());
}
