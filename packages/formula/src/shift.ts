// Reference shifting for structural edits (insert/delete row or column).
// When a sheet inserts or deletes a row/column, every formula that names a
// cell on or past the edit point must be rewritten so it keeps pointing at the
// same logical cell. A reference that pointed exactly at a deleted row/column
// can no longer resolve and becomes the "#REF!" error literal.
//
// We tokenize the formula and rewrite only "ref" and "range" tokens, leaving
// numbers, strings, operators, and function names (e.g. SUM, LOG10) untouched.

import { parseRef, indexToCol, type CellRef } from "./refs";
import { tokenize } from "./tokenizer";

export interface ShiftOpts {
  axis: "row" | "col";
  /** 0-based index at which the row/col is inserted or deleted. */
  at: number;
  /** +1 for an insert, -1 for a delete. */
  delta: number;
}

const REF_ERR = "#REF!";

/** Render a CellRef back to A1 text, preserving its absolute markers. */
function refToText(ref: CellRef): string {
  const col = (ref.colAbsolute ? "$" : "") + indexToCol(ref.col);
  const row = (ref.rowAbsolute ? "$" : "") + (ref.row + 1);
  return col + row;
}

/**
 * Shift a single endpoint along the edited axis. Returns the rewritten ref
 * text, or null when the endpoint sat exactly on a deleted row/col (#REF!).
 */
function shiftEndpoint(ref: CellRef, opts: ShiftOpts): string | null {
  const index = opts.axis === "row" ? ref.row : ref.col;

  // Anything before the edit point is unaffected.
  if (index < opts.at) {
    return refToText(ref);
  }

  if (opts.delta < 0 && index === opts.at) {
    // The exact row/col this endpoint named was deleted.
    return null;
  }

  const shifted: CellRef = { ...ref };
  if (opts.axis === "row") {
    shifted.row = ref.row + opts.delta;
  } else {
    shifted.col = ref.col + opts.delta;
  }
  return refToText(shifted);
}

/** Rewrite a single "ref" token's text. */
function shiftRef(text: string, opts: ShiftOpts): string {
  const out = shiftEndpoint(parseRef(text), opts);
  return out ?? REF_ERR;
}

/** Rewrite a "range" token (A1:B3) by shifting both endpoints. */
function shiftRangeToken(text: string, opts: ShiftOpts): string {
  const [a, b] = text.split(":");
  const sa = shiftEndpoint(parseRef(a), opts);
  const sb = shiftEndpoint(parseRef(b), opts);
  // If either endpoint was deleted, the whole range can no longer resolve.
  if (sa === null || sb === null) {
    return REF_ERR;
  }
  return sa + ":" + sb;
}

/**
 * Rewrite every A1 cell/range reference in a formula source string for a
 * structural edit. The leading "=" (if any) is preserved. Non-reference tokens
 * (numbers, strings, function names, operators) pass through unchanged, so a
 * name like LOG10 or a quoted "A1" string is never mangled.
 *
 * On a delete (delta < 0) a reference that names exactly the removed row/col,
 * and a range with such an endpoint, is replaced with the literal "#REF!".
 */
export function shiftRefs(formula: string, opts: ShiftOpts): string {
  const hasEquals = formula.startsWith("=");
  const body = hasEquals ? formula.slice(1) : formula;

  let tokens;
  try {
    tokens = tokenize(body);
  } catch {
    // Not parseable; return the source untouched rather than corrupt it.
    return formula;
  }

  // Rebuild from token positions so we only touch ref/range spans and keep
  // every other character (whitespace, operators, parens, strings) verbatim.
  // For ref/range tokens the token value equals its source text, so the span
  // [pos, pos+value.length) is exact; we never reconstruct other token kinds.
  let out = "";
  let cursor = 0;
  for (const tok of tokens) {
    if (tok.type === "eof") break;
    if (tok.type === "ref" || tok.type === "range") {
      const end = tok.pos + tok.value.length;
      // A ref token whose text is immediately followed by "(" is actually a
      // function call (e.g. LOG10(...)), not a cell reference. The tokenizer
      // does not distinguish these, so guard it here and leave it verbatim.
      const next = body[end] ?? "";
      if (tok.type === "ref" && next === "(") {
        continue;
      }
      // Copy verbatim text preceding this reference.
      out += body.slice(cursor, tok.pos);
      out +=
        tok.type === "ref"
          ? shiftRef(tok.value, opts)
          : shiftRangeToken(tok.value, opts);
      cursor = end;
    }
  }
  out += body.slice(cursor);

  return (hasEquals ? "=" : "") + out;
}
