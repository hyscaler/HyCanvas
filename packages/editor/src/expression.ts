// Safe arithmetic for numeric property fields (FR-12). A leading +, -, *, or /
// applies relative to the current value (e.g. "+10" nudges, "*2" doubles);
// anything else is evaluated as an absolute expression (e.g. "100/2" -> 50).
// Evaluated by a tiny recursive-descent parser, never `eval`.

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  const re = /\s*([0-9]*\.?[0-9]+|[()+\-*/])/y;
  let m: RegExpExecArray | null;
  let pos = 0;
  while (pos < input.length) {
    re.lastIndex = pos;
    m = re.exec(input);
    if (!m) throw new Error(`invalid expression near "${input.slice(pos)}"`);
    tokens.push(m[1]);
    pos = re.lastIndex;
  }
  return tokens;
}

// expr := term (('+'|'-') term)*  term := factor (('*'|'/') factor)*
// factor := number | '(' expr ')' | ('-'|'+') factor
function parse(tokens: string[]): number {
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];

  function expr(): number {
    let v = term();
    while (peek() === "+" || peek() === "-") {
      const op = next();
      const r = term();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  function term(): number {
    let v = factor();
    while (peek() === "*" || peek() === "/") {
      const op = next();
      const r = factor();
      v = op === "*" ? v * r : v / r;
    }
    return v;
  }
  function factor(): number {
    const t = peek();
    if (t === "+" || t === "-") {
      next();
      const v = factor();
      return t === "-" ? -v : v;
    }
    if (t === "(") {
      next();
      const v = expr();
      if (next() !== ")") throw new Error("unbalanced parentheses");
      return v;
    }
    const n = Number(next());
    if (Number.isNaN(n)) throw new Error("expected a number");
    return n;
  }

  const result = expr();
  if (i !== tokens.length) throw new Error("unexpected trailing input");
  return result;
}

/**
 * Evaluate a numeric field. Returns null if the input is not a valid expression
 * (callers keep the prior value). `current` anchors relative expressions.
 */
export function evalExpression(input: string, current = 0): number | null {
  const s = input.trim();
  if (s === "") return null;
  try {
    let result: number;
    // No `\s*` before the capture: whitespace and `.` both match, which lets the
    // two overlap and backtrack quadratically. The operand is trimmed below, so
    // capturing any leading space is harmless. The number test splits the
    // optional-fraction case out of a single class to remove the `[0-9]*`/`[0-9]+`
    // ambiguity around the dot.
    const rel = /^([+\-*/])(.+)$/.exec(s);
    const bareNumber = rel ? /^[0-9]+$|^[0-9]*\.[0-9]+$/.test(rel[2].trim()) : false;
    if (rel && (rel[1] === "*" || rel[1] === "/") && bareNumber) {
      // Leading * or / is relative only for a bare number ("*2" doubles); a
      // compound like "*2+1" is ambiguous and rejected (caller keeps the value).
      const v = parse(tokenize(rel[2]));
      result = rel[1] === "*" ? current * v : current / v;
    } else if (rel && (rel[1] === "+" || rel[1] === "-") && bareNumber) {
      // Leading + or - is relative only for a bare signed-number nudge (e.g.
      // "+10"); a full expression like "-5+2" evaluates absolutely.
      const v = parse(tokenize(rel[2]));
      result = rel[1] === "+" ? current + v : current - v;
    } else {
      result = parse(tokenize(s));
    }
    // Reject non-finite results (e.g. division by zero) so they never reach a
    // transform; the caller keeps the prior value.
    return Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
}
