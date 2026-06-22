// Evaluate a formula source against a cell-resolution context.

import { Node, parse } from "./parser";
import { parseRef, parseRange } from "./refs";
import {
  ArgValue,
  CellValue,
  FormulaError,
  FUNCTIONS,
  FnContext,
  compareValues,
  isError,
  toNumber,
  toText,
} from "./functions";

export interface EvalContext {
  /** Resolve a single cell's current value. col/row are 0-based. */
  getCell(col: number, row: number): CellValue;
  /** Injectable clock for TODAY/NOW. Defaults to Date.now(). */
  now?: number;
}

const ERR = (code: FormulaError["error"]): FormulaError => ({ error: code });

/** Parse and evaluate a formula source (with or without leading "="). */
export function evaluate(
  formulaSource: string,
  ctx: EvalContext
): CellValue {
  let ast: Node;
  try {
    ast = parse(formulaSource);
  } catch {
    return ERR("#VALUE!");
  }
  const fnCtx: FnContext = { now: ctx.now ?? Date.now() };
  try {
    const result = evalNode(ast, ctx, fnCtx);
    // a bare range collapses to its top-left cell when used as a scalar result
    if (Array.isArray(result)) {
      const flat = result.flat();
      return flat.length ? (flat[0] as CellValue) : null;
    }
    return result;
  } catch (e) {
    if (isError(e)) return e as FormulaError;
    return ERR("#VALUE!");
  }
}

function evalNode(
  node: Node,
  ctx: EvalContext,
  fnCtx: FnContext
): ArgValue {
  switch (node.kind) {
    case "number":
      return node.value;
    case "string":
      return node.value;
    case "boolean":
      return node.value;
    case "ref": {
      let ref;
      try {
        ref = parseRef(node.ref);
      } catch {
        return ERR("#REF!");
      }
      return ctx.getCell(ref.col, ref.row);
    }
    case "range": {
      let range;
      try {
        range = parseRange(node.range);
      } catch {
        return ERR("#REF!");
      }
      const matrix: CellValue[][] = [];
      for (let r = range.start.row; r <= range.end.row; r++) {
        const row: CellValue[] = [];
        for (let c = range.start.col; c <= range.end.col; c++) {
          row.push(ctx.getCell(c, r));
        }
        matrix.push(row);
      }
      return matrix;
    }
    case "unary": {
      const operand = scalarize(evalNode(node.operand, ctx, fnCtx));
      if (isError(operand)) return operand;
      const n = toNumber(operand);
      if (isError(n)) return n;
      return node.op === "-" ? -n : n;
    }
    case "binary":
      return evalBinary(node, ctx, fnCtx);
    case "call": {
      const fn = FUNCTIONS[node.name];
      if (!fn) return ERR("#NAME?");
      const args: ArgValue[] = node.args.map((a) =>
        evalNode(a, ctx, fnCtx)
      );
      return fn(args, fnCtx);
    }
  }
}

function evalBinary(
  node: Extract<Node, { kind: "binary" }>,
  ctx: EvalContext,
  fnCtx: FnContext
): ArgValue {
  const left = scalarize(evalNode(node.left, ctx, fnCtx));
  const right = scalarize(evalNode(node.right, ctx, fnCtx));
  if (isError(left)) return left;
  if (isError(right)) return right;

  const op = node.op;

  if (op === "&") {
    return toText(left) + toText(right);
  }

  if (op === "=" || op === "<>" || op === "<" || op === "<=" || op === ">" || op === ">=") {
    const cmp = compareValues(left, right);
    if (Number.isNaN(cmp)) return ERR("#VALUE!");
    switch (op) {
      case "=":
        return cmp === 0;
      case "<>":
        return cmp !== 0;
      case "<":
        return cmp < 0;
      case "<=":
        return cmp <= 0;
      case ">":
        return cmp > 0;
      case ">=":
        return cmp >= 0;
    }
  }

  // arithmetic
  const a = toNumber(left);
  if (isError(a)) return a;
  const b = toNumber(right);
  if (isError(b)) return b;
  switch (op) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      if (b === 0) return ERR("#DIV/0!");
      return a / b;
    case "^":
      return Math.pow(a, b);
  }
  return ERR("#VALUE!");
}

/** Collapse a matrix arg to a single scalar (top-left), pass scalars through. */
function scalarize(v: ArgValue): CellValue {
  if (Array.isArray(v)) {
    const flat = (v as CellValue[][]).flat();
    return flat.length ? flat[0] : null;
  }
  return v;
}
