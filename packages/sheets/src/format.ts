// Number/date formatting and conditional-format rule evaluation.

import type { CellValue } from "@hc/formula";
import type { CellFormat, ConditionalRule } from "./model";
import { parseRange, parseRef } from "@hc/formula";

// Date-serial epoch matches @hc/formula's DATE: serial 0 == 1899-12-30 UTC.
const DATE_EPOCH_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 86400000;

function serialToDate(serial: number): Date {
  return new Date(DATE_EPOCH_MS + serial * DAY_MS);
}

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

function groupThousands(intPart: string): string {
  // intPart is digits only (no sign)
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function fixed(value: number, decimals: number): string {
  return Math.abs(value).toFixed(decimals);
}

/**
 * Format a numeric value per a number-format string. Supported formats:
 *  - "" / "General": plain number
 *  - "0", "0.00", "0.000": fixed decimals
 *  - "#,##0", "#,##0.00": thousands separators (+ optional decimals)
 *  - "0%", "0.00%": percent
 *  - "$#,##0.00", "$#,##0": currency
 *  - "yyyy-mm-dd": date (value is a date-serial number)
 */
export function formatNumber(value: number, numberFormat: string): string {
  const fmt = (numberFormat ?? "").trim();

  if (fmt === "" || fmt.toLowerCase() === "general") {
    return String(value);
  }

  // Date format
  if (/[ymd]/i.test(fmt) && /-/.test(fmt)) {
    return formatDate(value, fmt);
  }

  const negative = value < 0;
  const sign = negative ? "-" : "";

  // Percent
  if (fmt.includes("%")) {
    const decimals = decimalsOf(fmt);
    const scaled = value * 100;
    return sign + fixed(scaled, decimals) + "%";
  }

  // Currency (prefix symbol)
  const currencyMatch = /^([^\d#0]+)/.exec(fmt);
  const hasThousands = fmt.includes(",");
  const decimals = decimalsOf(fmt);

  let body = fixed(value, decimals);
  if (hasThousands) {
    const [intPart, fracPart] = body.split(".");
    body = groupThousands(intPart) + (fracPart ? "." + fracPart : "");
  }

  const prefix = currencyMatch ? currencyMatch[1] : "";
  return sign + prefix + body;
}

function decimalsOf(fmt: string): number {
  const m = /\.(0+)/.exec(fmt);
  return m ? m[1].length : 0;
}

/** Format a date-serial (number) or ISO string per "yyyy-mm-dd". */
export function formatDate(value: number | string, _fmt: string): string {
  let d: Date;
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    d = parsed;
  } else {
    d = serialToDate(value);
  }
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return `${y}-${pad2(m)}-${pad2(day)}`;
}

/** Format any display value through an optional number format. */
export function formatValue(
  value: CellValue,
  numberFormat?: string
): string {
  if (value === null) return "";
  if (typeof value === "object") return value.error;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    if (numberFormat) return formatNumber(value, numberFormat);
    return String(value);
  }
  // string
  if (numberFormat && /[ymd]/i.test(numberFormat) && numberFormat.includes("-")) {
    return formatDate(value, numberFormat);
  }
  return value;
}

// ---- conditional formatting ----

function ruleMatches(value: CellValue, rule: ConditionalRule): boolean {
  if (value === null || typeof value === "object") return false;
  const { op, value: v1, value2 } = rule.when;
  switch (op) {
    case "gt":
      return num(value) > num(v1);
    case "lt":
      return num(value) < num(v1);
    case "eq":
      if (typeof value === "string" || typeof v1 === "string") {
        return String(value) === String(v1);
      }
      return num(value) === num(v1);
    case "between": {
      const lo = num(v1);
      const hi = num(value2);
      const x = num(value);
      return x >= Math.min(lo, hi) && x <= Math.max(lo, hi);
    }
    case "contains":
      return String(value).includes(String(v1));
    default:
      return false;
  }
}

function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = Number(v);
  return Number.isNaN(n) ? NaN : n;
}

/** Does a cell key fall inside a conditional rule's range? */
function keyInRange(cellKeyStr: string, range: string): boolean {
  try {
    const ref = parseRef(cellKeyStr);
    const r = parseRange(range);
    return (
      ref.col >= r.start.col &&
      ref.col <= r.end.col &&
      ref.row >= r.start.row &&
      ref.row <= r.end.row
    );
  } catch {
    return false;
  }
}

/**
 * Resolve the conditional format (if any) that applies to a cell.
 * Later rules in the list win when multiple match (last-writer-wins).
 */
export function applyConditionalFormat(
  value: CellValue,
  rules: ConditionalRule[],
  cellKeyStr: string
): CellFormat | undefined {
  let matched: CellFormat | undefined;
  for (const rule of rules) {
    if (!keyInRange(cellKeyStr, rule.range)) continue;
    if (ruleMatches(value, rule)) matched = rule.style;
  }
  return matched;
}
