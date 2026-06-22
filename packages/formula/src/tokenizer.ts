// Tokenizer for spreadsheet formula source. A formula source begins with "=";
// the tokenizer is given the body (without the leading "=").

export type TokenType =
  | "number"
  | "string"
  | "boolean"
  | "ref"
  | "range"
  | "name"
  | "op"
  | "lparen"
  | "rparen"
  | "comma"
  | "eof";

export interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const REF_TOKEN_RE = /^\$?[A-Za-z]+\$?\d+/;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.]*/;

// Multi-char operators must be tried before single-char ones.
const OPERATORS = ["<=", ">=", "<>", "+", "-", "*", "/", "^", "&", "=", "<", ">"];

export function tokenize(body: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = body.length;

  while (i < n) {
    const ch = body[i];

    // whitespace
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }

    // string literal
    if (ch === '"') {
      let j = i + 1;
      let str = "";
      while (j < n) {
        if (body[j] === '"') {
          // doubled quote is an escaped quote
          if (body[j + 1] === '"') {
            str += '"';
            j += 2;
            continue;
          }
          break;
        }
        str += body[j];
        j++;
      }
      if (j >= n) {
        throw new Error("Unterminated string literal");
      }
      tokens.push({ type: "string", value: str, pos: i });
      i = j + 1;
      continue;
    }

    // number (allow leading digit or .5)
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(body[i + 1] ?? ""))) {
      const m = /^[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?/.exec(body.slice(i));
      if (m) {
        tokens.push({ type: "number", value: m[0], pos: i });
        i += m[0].length;
        continue;
      }
    }

    // parens / comma
    if (ch === "(") {
      tokens.push({ type: "lparen", value: ch, pos: i });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen", value: ch, pos: i });
      i++;
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: "comma", value: ch, pos: i });
      i++;
      continue;
    }

    // ref / range / boolean / function name
    if (/[A-Za-z$]/.test(ch)) {
      const rest = body.slice(i);
      const refM = REF_TOKEN_RE.exec(rest);
      // a ref is only a ref/range if NOT immediately followed by "(" (function call)
      if (refM) {
        const after = i + refM[0].length;
        // range? look for ":" then another ref
        const tail = body.slice(after);
        const rangeM = /^:\$?[A-Za-z]+\$?\d+/.exec(tail);
        if (rangeM) {
          tokens.push({
            type: "range",
            value: refM[0] + rangeM[0],
            pos: i,
          });
          i = after + rangeM[0].length;
          continue;
        }
        // ensure it's not actually a name (e.g. would "A1" be followed by letters?)
        const nextCh = body[after] ?? "";
        if (!/[A-Za-z0-9_.]/.test(nextCh)) {
          tokens.push({ type: "ref", value: refM[0], pos: i });
          i = after;
          continue;
        }
      }
      const nameM = NAME_RE.exec(rest);
      if (nameM) {
        const word = nameM[0];
        const upper = word.toUpperCase();
        if (upper === "TRUE" || upper === "FALSE") {
          tokens.push({ type: "boolean", value: upper, pos: i });
        } else {
          tokens.push({ type: "name", value: word, pos: i });
        }
        i += word.length;
        continue;
      }
    }

    // operators
    let matched = false;
    for (const op of OPERATORS) {
      if (body.startsWith(op, i)) {
        tokens.push({ type: "op", value: op, pos: i });
        i += op.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    throw new Error(`Unexpected character '${ch}' at position ${i}`);
  }

  tokens.push({ type: "eof", value: "", pos: n });
  return tokens;
}
