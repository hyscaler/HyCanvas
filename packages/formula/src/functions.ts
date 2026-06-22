// Function library. Each function receives already-resolved argument values.
// An argument value is a scalar (CellValue) or a 2D array of scalars (a range).
// Functions are tolerant of ranges flattened to 1D arrays as well.

export type Scalar = number | string | boolean | null;

export interface FormulaError {
  error:
    | "#DIV/0!"
    | "#REF!"
    | "#NAME?"
    | "#VALUE!"
    | "#CIRCULAR!"
    | "#N/A";
}

export type CellValue = Scalar | FormulaError;

// An argument as passed to a function: a scalar, an error, or a 2D matrix.
export type ArgValue = CellValue | CellValue[][];

export function isError(v: unknown): v is FormulaError {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { error?: unknown }).error === "string"
  );
}

const ERR = (
  code: FormulaError["error"]
): FormulaError => ({ error: code });

/** Flatten an argument (scalar or matrix) into a 1D list of scalars/errors. */
export function flattenArg(arg: ArgValue): CellValue[] {
  if (Array.isArray(arg)) {
    const out: CellValue[] = [];
    for (const row of arg) {
      if (Array.isArray(row)) {
        for (const c of row) out.push(c);
      } else {
        out.push(row as CellValue);
      }
    }
    return out;
  }
  return [arg];
}

export function flattenAll(args: ArgValue[]): CellValue[] {
  const out: CellValue[] = [];
  for (const a of args) out.push(...flattenArg(a));
  return out;
}

/** First error found in a value, or undefined. */
export function findError(v: ArgValue): FormulaError | undefined {
  if (isError(v)) return v;
  if (Array.isArray(v)) {
    for (const x of flattenArg(v)) {
      if (isError(x)) return x;
    }
  }
  return undefined;
}

/** Coerce a scalar to a number; returns #VALUE! on failure. */
export function toNumber(v: CellValue): number | FormulaError {
  if (isError(v)) return v;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === null || v === "") return 0;
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (trimmed === "") return 0;
    const n = Number(trimmed);
    if (!Number.isNaN(n)) return n;
    return ERR("#VALUE!");
  }
  return ERR("#VALUE!");
}

export function toText(v: CellValue): string {
  if (isError(v)) return v.error;
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}

export function toBool(v: CellValue): boolean | FormulaError {
  if (isError(v)) return v;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const u = v.trim().toUpperCase();
    if (u === "TRUE") return true;
    if (u === "FALSE") return false;
    if (u === "") return false;
    const n = Number(u);
    if (!Number.isNaN(n)) return n !== 0;
    return ERR("#VALUE!");
  }
  if (v === null) return false;
  return ERR("#VALUE!");
}

/** Numeric values only (skips text/blank/bool), used by SUM/AVERAGE/etc. */
function numericValues(args: ArgValue[]): number[] | FormulaError {
  const out: number[] = [];
  for (const v of flattenAll(args)) {
    if (isError(v)) return v;
    if (typeof v === "number") out.push(v);
    else if (typeof v === "boolean") out.push(v ? 1 : 0);
    // text and null are ignored for aggregation
  }
  return out;
}

type Fn = (args: ArgValue[], ctx: FnContext) => CellValue;

export interface FnContext {
  now: number; // ms epoch, injectable
}

// Date-serial helpers: serial 0 == 1899-12-30 (Excel-compatible-ish epoch).
const DATE_EPOCH_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 86400000;

export function dateToSerial(year: number, month: number, day: number): number {
  const ms = Date.UTC(year, month - 1, day);
  return Math.round((ms - DATE_EPOCH_MS) / DAY_MS);
}

export const FUNCTIONS: Record<string, Fn> = {
  SUM(args) {
    const nums = numericValues(args);
    if (isError(nums)) return nums;
    return nums.reduce((a, b) => a + b, 0);
  },

  AVERAGE(args) {
    const nums = numericValues(args);
    if (isError(nums)) return nums;
    if (nums.length === 0) return ERR("#DIV/0!");
    return nums.reduce((a, b) => a + b, 0) / nums.length;
  },

  COUNT(args) {
    // count numeric values only
    let n = 0;
    for (const v of flattenAll(args)) {
      if (typeof v === "number") n++;
    }
    return n;
  },

  COUNTA(args) {
    // count non-empty values (errors count as non-empty)
    let n = 0;
    for (const v of flattenAll(args)) {
      if (v !== null && v !== "") n++;
    }
    return n;
  },

  MIN(args) {
    const nums = numericValues(args);
    if (isError(nums)) return nums;
    if (nums.length === 0) return 0;
    return Math.min(...nums);
  },

  MAX(args) {
    const nums = numericValues(args);
    if (isError(nums)) return nums;
    if (nums.length === 0) return 0;
    return Math.max(...nums);
  },

  ROUND(args) {
    const x = toNumber(scalar(args[0]));
    if (isError(x)) return x;
    const digitsArg = args.length > 1 ? toNumber(scalar(args[1])) : 0;
    if (isError(digitsArg)) return digitsArg;
    const factor = Math.pow(10, digitsArg);
    return Math.round((x + Number.EPSILON) * factor) / factor;
  },

  ABS(args) {
    const x = toNumber(scalar(args[0]));
    if (isError(x)) return x;
    return Math.abs(x);
  },

  IF(args) {
    const cond = toBool(scalar(args[0]));
    if (isError(cond)) return cond;
    if (cond) return scalar(args[1] ?? null);
    return scalar(args.length > 2 ? args[2] : false);
  },

  AND(args) {
    const vals = flattenAll(args);
    for (const v of vals) {
      const b = toBool(v);
      if (isError(b)) return b;
      if (!b) return false;
    }
    return true;
  },

  OR(args) {
    const vals = flattenAll(args);
    for (const v of vals) {
      const b = toBool(v);
      if (isError(b)) return b;
      if (b) return true;
    }
    return false;
  },

  NOT(args) {
    const b = toBool(scalar(args[0]));
    if (isError(b)) return b;
    return !b;
  },

  CONCAT(args) {
    let out = "";
    for (const v of flattenAll(args)) {
      if (isError(v)) return v;
      out += toText(v);
    }
    return out;
  },

  CONCATENATE(args, ctx) {
    return FUNCTIONS.CONCAT(args, ctx);
  },

  LEN(args) {
    const s = scalar(args[0]);
    if (isError(s)) return s;
    return toText(s).length;
  },

  LEFT(args) {
    const s = scalar(args[0]);
    if (isError(s)) return s;
    const nArg = args.length > 1 ? toNumber(scalar(args[1])) : 1;
    if (isError(nArg)) return nArg;
    return toText(s).slice(0, Math.max(0, Math.trunc(nArg)));
  },

  RIGHT(args) {
    const s = scalar(args[0]);
    if (isError(s)) return s;
    const nArg = args.length > 1 ? toNumber(scalar(args[1])) : 1;
    if (isError(nArg)) return nArg;
    const text = toText(s);
    const n = Math.max(0, Math.trunc(nArg));
    return n === 0 ? "" : text.slice(Math.max(0, text.length - n));
  },

  MID(args) {
    const s = scalar(args[0]);
    if (isError(s)) return s;
    const startArg = toNumber(scalar(args[1]));
    if (isError(startArg)) return startArg;
    const lenArg = toNumber(scalar(args[2]));
    if (isError(lenArg)) return lenArg;
    const text = toText(s);
    const start = Math.max(0, Math.trunc(startArg) - 1); // 1-based
    return text.slice(start, start + Math.max(0, Math.trunc(lenArg)));
  },

  UPPER(args) {
    const s = scalar(args[0]);
    if (isError(s)) return s;
    return toText(s).toUpperCase();
  },

  LOWER(args) {
    const s = scalar(args[0]);
    if (isError(s)) return s;
    return toText(s).toLowerCase();
  },

  TRIM(args) {
    const s = scalar(args[0]);
    if (isError(s)) return s;
    // collapse internal runs of spaces and trim ends (Excel-like)
    return toText(s).replace(/\s+/g, " ").trim();
  },

  DATE(args) {
    const y = toNumber(scalar(args[0]));
    if (isError(y)) return y;
    const m = toNumber(scalar(args[1]));
    if (isError(m)) return m;
    const d = toNumber(scalar(args[2]));
    if (isError(d)) return d;
    return dateToSerial(Math.trunc(y), Math.trunc(m), Math.trunc(d));
  },

  TODAY(_args, ctx) {
    const d = new Date(ctx.now);
    return dateToSerial(
      d.getUTCFullYear(),
      d.getUTCMonth() + 1,
      d.getUTCDate()
    );
  },

  // NOW() returns a date/time serial: the whole part is the day count (same
  // convention as TODAY/DATE, serial 0 == 1899-12-30) and the fractional part
  // is the time of day (0.5 == noon). Deterministic via the injected ctx.now.
  NOW(_args, ctx) {
    return (ctx.now - DATE_EPOCH_MS) / DAY_MS;
  },

  VLOOKUP(args) {
    const lookup = scalar(args[0]);
    if (isError(lookup)) return lookup;
    const table = args[1];
    const colArg = toNumber(scalar(args[2]));
    if (isError(colArg)) return colArg;
    const colIndex = Math.trunc(colArg) - 1; // 1-based
    const approximate = args.length > 3 ? toBool(scalar(args[3])) : true;
    if (isError(approximate)) return approximate;

    const matrix = asMatrix(table);
    if (matrix.length === 0) return ERR("#N/A");
    if (colIndex < 0 || colIndex >= matrix[0].length) return ERR("#REF!");

    if (!approximate) {
      for (const row of matrix) {
        if (looseEqual(row[0], lookup)) return row[colIndex] ?? ERR("#N/A");
      }
      return ERR("#N/A");
    }
    // approximate: largest value <= lookup (assumes ascending first column)
    let best: CellValue | undefined;
    for (const row of matrix) {
      const key = row[0];
      if (compareValues(key, lookup) <= 0) best = row[colIndex];
      else break;
    }
    return best === undefined ? ERR("#N/A") : best;
  },

  LOOKUP(args) {
    const lookup = scalar(args[0]);
    if (isError(lookup)) return lookup;
    const searchVec = flattenArg(args[1]);
    const resultVec =
      args.length > 2 ? flattenArg(args[2]) : searchVec;
    // largest value <= lookup
    let bestIdx = -1;
    for (let i = 0; i < searchVec.length; i++) {
      if (compareValues(searchVec[i], lookup) <= 0) bestIdx = i;
      else break;
    }
    if (bestIdx < 0) return ERR("#N/A");
    return resultVec[bestIdx] ?? ERR("#N/A");
  },

  // ---- error handling / branching ----
  IFERROR(args) {
    if (args[0] === undefined) return ERR("#N/A");
    return findError(args[0]) ? scalar(args[1] ?? null) : scalar(args[0]);
  },
  IFNA(args) {
    const err = findError(args[0] ?? null);
    return err && err.error === "#N/A" ? scalar(args[1] ?? null) : scalar(args[0] ?? null);
  },
  IFS(args) {
    for (let i = 0; i + 1 < args.length; i += 2) {
      const cond = toBool(scalar(args[i]));
      if (isError(cond)) return cond;
      if (cond) return scalar(args[i + 1]);
    }
    return ERR("#N/A");
  },
  SWITCH(args) {
    const subject = scalar(args[0]);
    if (isError(subject)) return subject;
    let i = 1;
    for (; i + 1 < args.length; i += 2) {
      if (looseEqual(subject, scalar(args[i]))) return scalar(args[i + 1]);
    }
    return i < args.length ? scalar(args[i]) : ERR("#N/A"); // trailing default
  },

  // ---- math ----
  PRODUCT(args) {
    const nums = numericValues(args);
    if (isError(nums)) return nums;
    return nums.length === 0 ? 0 : nums.reduce((a, b) => a * b, 1);
  },
  MEDIAN(args) {
    const nums = numericValues(args);
    if (isError(nums)) return nums;
    if (nums.length === 0) return ERR("#VALUE!");
    const s = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  },
  MOD(args) {
    const a = toNumber(scalar(args[0]));
    if (isError(a)) return a;
    const b = toNumber(scalar(args[1]));
    if (isError(b)) return b;
    if (b === 0) return ERR("#DIV/0!");
    return a - b * Math.floor(a / b); // result takes the divisor's sign (Excel)
  },
  POWER(args) {
    const a = toNumber(scalar(args[0]));
    if (isError(a)) return a;
    const b = toNumber(scalar(args[1]));
    if (isError(b)) return b;
    const r = Math.pow(a, b);
    return Number.isFinite(r) ? r : ERR("#VALUE!");
  },
  SQRT(args) {
    const a = toNumber(scalar(args[0]));
    if (isError(a)) return a;
    return a < 0 ? ERR("#VALUE!") : Math.sqrt(a);
  },
  INT(args) {
    const a = toNumber(scalar(args[0]));
    if (isError(a)) return a;
    return Math.floor(a);
  },
  ROUNDUP(args) {
    const x = toNumber(scalar(args[0]));
    if (isError(x)) return x;
    const d = args.length > 1 ? toNumber(scalar(args[1])) : 0;
    if (isError(d)) return d;
    const f = Math.pow(10, d);
    return (Math.sign(x) || 1) * (Math.ceil(Math.abs(x) * f) / f);
  },
  ROUNDDOWN(args) {
    const x = toNumber(scalar(args[0]));
    if (isError(x)) return x;
    const d = args.length > 1 ? toNumber(scalar(args[1])) : 0;
    if (isError(d)) return d;
    const f = Math.pow(10, d);
    return (Math.sign(x) || 1) * (Math.floor(Math.abs(x) * f) / f);
  },
  CEILING(args) {
    const x = toNumber(scalar(args[0]));
    if (isError(x)) return x;
    const sig = args.length > 1 ? toNumber(scalar(args[1])) : 1;
    if (isError(sig)) return sig;
    return sig === 0 ? 0 : Math.ceil(x / sig) * sig;
  },
  FLOOR(args) {
    const x = toNumber(scalar(args[0]));
    if (isError(x)) return x;
    const sig = args.length > 1 ? toNumber(scalar(args[1])) : 1;
    if (isError(sig)) return sig;
    return sig === 0 ? ERR("#DIV/0!") : Math.floor(x / sig) * sig;
  },
  PI() {
    return Math.PI;
  },

  // ---- conditional aggregation ----
  SUMIF(args) {
    const range = flattenArg(args[0]);
    const pred = criteriaPredicate(scalar(args[1]));
    const sumRange = args.length > 2 ? flattenArg(args[2]) : range;
    let sum = 0;
    for (let i = 0; i < range.length; i++) {
      if (pred(range[i])) {
        const n = toNumber(sumRange[i] ?? null);
        if (!isError(n)) sum += n;
      }
    }
    return sum;
  },
  COUNTIF(args) {
    const range = flattenArg(args[0]);
    const pred = criteriaPredicate(scalar(args[1]));
    let c = 0;
    for (const v of range) if (pred(v)) c++;
    return c;
  },
  AVERAGEIF(args) {
    const range = flattenArg(args[0]);
    const pred = criteriaPredicate(scalar(args[1]));
    const avgRange = args.length > 2 ? flattenArg(args[2]) : range;
    let sum = 0;
    let c = 0;
    for (let i = 0; i < range.length; i++) {
      if (pred(range[i])) {
        const n = toNumber(avgRange[i] ?? null);
        if (!isError(n)) {
          sum += n;
          c++;
        }
      }
    }
    return c ? sum / c : ERR("#DIV/0!");
  },

  // ---- predicates ----
  ISBLANK(args) {
    const s = scalar(args[0]);
    return s === null || s === "";
  },
  ISNUMBER(args) {
    return typeof scalar(args[0]) === "number";
  },
  ISTEXT(args) {
    return typeof scalar(args[0]) === "string";
  },
  ISLOGICAL(args) {
    return typeof scalar(args[0]) === "boolean";
  },
  ISERROR(args) {
    return findError(args[0] ?? null) !== undefined;
  },

  // ---- text ----
  SUBSTITUTE(args) {
    const s = scalar(args[0]);
    if (isError(s)) return s;
    const oldT = scalar(args[1]);
    if (isError(oldT)) return oldT;
    const newT = scalar(args[2]);
    if (isError(newT)) return newT;
    const text = toText(s);
    const o = toText(oldT);
    const n = toText(newT);
    if (o === "") return text;
    if (args.length > 3) {
      const whichArg = toNumber(scalar(args[3]));
      if (isError(whichArg)) return whichArg;
      const which = Math.trunc(whichArg);
      let count = 0;
      let from = 0;
      let idx = -1;
      while ((idx = text.indexOf(o, from)) >= 0) {
        count++;
        if (count === which) return text.slice(0, idx) + n + text.slice(idx + o.length);
        from = idx + o.length;
      }
      return text;
    }
    return text.split(o).join(n);
  },
  REPLACE(args) {
    const s = scalar(args[0]);
    if (isError(s)) return s;
    const startArg = toNumber(scalar(args[1]));
    if (isError(startArg)) return startArg;
    const lenArg = toNumber(scalar(args[2]));
    if (isError(lenArg)) return lenArg;
    const nw = scalar(args[3]);
    if (isError(nw)) return nw;
    const text = toText(s);
    const st = Math.max(0, Math.trunc(startArg) - 1);
    return text.slice(0, st) + toText(nw) + text.slice(st + Math.max(0, Math.trunc(lenArg)));
  },
  FIND(args) {
    const find = scalar(args[0]);
    if (isError(find)) return find;
    const within = scalar(args[1]);
    if (isError(within)) return within;
    const start = args.length > 2 ? toNumber(scalar(args[2])) : 1;
    if (isError(start)) return start;
    const idx = toText(within).indexOf(toText(find), Math.max(0, Math.trunc(start) - 1));
    return idx < 0 ? ERR("#VALUE!") : idx + 1;
  },
  SEARCH(args) {
    const find = scalar(args[0]);
    if (isError(find)) return find;
    const within = scalar(args[1]);
    if (isError(within)) return within;
    const start = args.length > 2 ? toNumber(scalar(args[2])) : 1;
    if (isError(start)) return start;
    const idx = toText(within).toLowerCase().indexOf(toText(find).toLowerCase(), Math.max(0, Math.trunc(start) - 1));
    return idx < 0 ? ERR("#VALUE!") : idx + 1;
  },
  TEXT(args) {
    const v = scalar(args[0]);
    if (isError(v)) return v;
    const fmt = toText(scalar(args[1]));
    const m = /^0(\.(0+))?$/.exec(fmt);
    if (m) {
      const n = toNumber(v);
      if (isError(n)) return n;
      return n.toFixed(m[2] ? m[2].length : 0);
    }
    return toText(v);
  },

  // ---- lookup ----
  HLOOKUP(args) {
    const lookup = scalar(args[0]);
    if (isError(lookup)) return lookup;
    const matrix = asMatrix(args[1]);
    const rowArg = toNumber(scalar(args[2]));
    if (isError(rowArg)) return rowArg;
    const rowIndex = Math.trunc(rowArg) - 1;
    const approx = args.length > 3 ? toBool(scalar(args[3])) : true;
    if (isError(approx)) return approx;
    if (matrix.length === 0) return ERR("#N/A");
    if (rowIndex < 0 || rowIndex >= matrix.length) return ERR("#REF!");
    const header = matrix[0];
    if (!approx) {
      for (let c = 0; c < header.length; c++) if (looseEqual(header[c], lookup)) return matrix[rowIndex][c] ?? ERR("#N/A");
      return ERR("#N/A");
    }
    let best = -1;
    for (let c = 0; c < header.length; c++) {
      if (compareValues(header[c], lookup) <= 0) best = c;
      else break;
    }
    return best < 0 ? ERR("#N/A") : matrix[rowIndex][best] ?? ERR("#N/A");
  },
  INDEX(args) {
    const matrix = asMatrix(args[0]);
    if (matrix.length === 0) return ERR("#REF!");
    const rowArg = toNumber(scalar(args[1]));
    if (isError(rowArg)) return rowArg;
    const row = Math.trunc(rowArg);
    const colArg = args.length > 2 ? toNumber(scalar(args[2])) : 0;
    if (isError(colArg)) return colArg;
    const col = Math.trunc(colArg);
    if (col === 0) {
      if (matrix.length === 1) {
        const r = matrix[0];
        return row - 1 >= 0 && row - 1 < r.length ? r[row - 1] ?? null : ERR("#REF!");
      }
      return row - 1 >= 0 && row - 1 < matrix.length ? matrix[row - 1][0] ?? null : ERR("#REF!");
    }
    const ri = row - 1;
    const ci = col - 1;
    if (ri < 0 || ri >= matrix.length || ci < 0 || ci >= matrix[ri].length) return ERR("#REF!");
    return matrix[ri][ci] ?? null;
  },
  MATCH(args) {
    const lookup = scalar(args[0]);
    if (isError(lookup)) return lookup;
    const vec = flattenArg(args[1]);
    const typeArg = args.length > 2 ? toNumber(scalar(args[2])) : 1;
    if (isError(typeArg)) return typeArg;
    const type = Math.trunc(typeArg);
    if (type === 0) {
      for (let i = 0; i < vec.length; i++) if (looseEqual(vec[i], lookup)) return i + 1;
      return ERR("#N/A");
    }
    let best = -1;
    for (let i = 0; i < vec.length; i++) {
      const cmp = compareValues(vec[i], lookup);
      if (type > 0 ? cmp <= 0 : cmp >= 0) best = i;
      else break;
    }
    return best < 0 ? ERR("#N/A") : best + 1;
  },
};

// ---- helpers used by functions ----

function scalar(arg: ArgValue | undefined): CellValue {
  if (arg === undefined) return null;
  if (Array.isArray(arg)) {
    const flat = flattenArg(arg);
    return flat.length ? flat[0] : null;
  }
  return arg;
}

function asMatrix(arg: ArgValue): CellValue[][] {
  if (Array.isArray(arg)) {
    if (arg.length > 0 && Array.isArray(arg[0])) {
      return arg as CellValue[][];
    }
    // 1D treated as a single column
    return (arg as unknown as CellValue[]).map((v) => [v]);
  }
  return [[arg]];
}

function looseEqual(a: CellValue, b: CellValue): boolean {
  if (isError(a) || isError(b)) return false;
  if (typeof a === "string" && typeof b === "string") {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

// Build a predicate from a SUMIF/COUNTIF criterion: a bare value (equality) or a
// string with a leading comparison operator (">5", "<=3", "<>x"). Numeric
// right-hand sides compare numerically; otherwise loose (case-insensitive) match.
function criteriaPredicate(criterion: CellValue): (v: CellValue) => boolean {
  if (isError(criterion)) return () => false;
  if (typeof criterion === "number" || typeof criterion === "boolean") {
    return (v) => looseEqual(v, criterion);
  }
  const s = criterion === null ? "" : String(criterion);
  const m = /^(>=|<=|<>|>|<|=)?([\s\S]*)$/.exec(s)!;
  const op = m[1] ?? "";
  const rhsRaw = m[2] ?? "";
  const rhsNum = Number(rhsRaw);
  const rhsIsNum = rhsRaw.trim() !== "" && !Number.isNaN(rhsNum);
  const rhs: CellValue = rhsIsNum ? rhsNum : rhsRaw;
  return (v) => {
    if (isError(v)) return false;
    if (op === "" || op === "=") return rhsIsNum && typeof v === "number" ? v === rhsNum : looseEqual(v, rhs);
    if (op === "<>") return rhsIsNum && typeof v === "number" ? v !== rhsNum : !looseEqual(v, rhs);
    const cmp = compareValues(v, rhs);
    if (Number.isNaN(cmp)) return false;
    if (op === ">") return cmp > 0;
    if (op === "<") return cmp < 0;
    if (op === ">=") return cmp >= 0;
    return cmp <= 0; // "<="
  };
}

export function compareValues(a: CellValue, b: CellValue): number {
  if (isError(a) || isError(b)) return NaN;
  const an = a === null ? 0 : a;
  const bn = b === null ? 0 : b;
  if (typeof an === "number" && typeof bn === "number") {
    return an < bn ? -1 : an > bn ? 1 : 0;
  }
  if (typeof an === "boolean" || typeof bn === "boolean") {
    const av = typeof an === "boolean" ? (an ? 1 : 0) : Number(an);
    const bv = typeof bn === "boolean" ? (bn ? 1 : 0) : Number(bn);
    return av < bv ? -1 : av > bv ? 1 : 0;
  }
  const as = String(an);
  const bs = String(bn);
  return as < bs ? -1 : as > bs ? 1 : 0;
}
