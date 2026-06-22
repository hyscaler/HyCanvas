// Recursive-descent / precedence-climbing parser producing an AST.

import { Token, tokenize } from "./tokenizer";

export type Node =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "ref"; ref: string }
  | { kind: "range"; range: string }
  | { kind: "unary"; op: string; operand: Node }
  | { kind: "binary"; op: string; left: Node; right: Node }
  | { kind: "call"; name: string; args: Node[] };

// Binary operator precedence (higher binds tighter).
const PRECEDENCE: Record<string, number> = {
  "=": 1,
  "<>": 1,
  "<": 1,
  "<=": 1,
  ">": 1,
  ">=": 1,
  "&": 2,
  "+": 3,
  "-": 3,
  "*": 4,
  "/": 4,
  "^": 5,
};

const RIGHT_ASSOC = new Set(["^"]);

/** Strip a leading "=" if present and parse the formula body into an AST. */
export function parse(source: string): Node {
  const body = source.startsWith("=") ? source.slice(1) : source;
  const tokens = tokenize(body);
  const parser = new Parser(tokens);
  const node = parser.parseExpression(0);
  parser.expect("eof");
  return node;
}

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  expect(type: string): Token {
    const t = this.peek();
    if (t.type !== type) {
      throw new Error(`Expected ${type} but got ${t.type} '${t.value}'`);
    }
    return this.next();
  }

  parseExpression(minPrec: number): Node {
    let left = this.parseUnary();
    while (true) {
      const t = this.peek();
      if (t.type !== "op") break;
      const prec = PRECEDENCE[t.value];
      if (prec === undefined || prec < minPrec) break;
      this.next();
      const nextMin = RIGHT_ASSOC.has(t.value) ? prec : prec + 1;
      const right = this.parseExpression(nextMin);
      left = { kind: "binary", op: t.value, left, right };
    }
    return left;
  }

  private parseUnary(): Node {
    const t = this.peek();
    if (t.type === "op" && (t.value === "+" || t.value === "-")) {
      this.next();
      const operand = this.parseUnary();
      return { kind: "unary", op: t.value, operand };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Node {
    const t = this.peek();
    switch (t.type) {
      case "number":
        this.next();
        return { kind: "number", value: Number(t.value) };
      case "string":
        this.next();
        return { kind: "string", value: t.value };
      case "boolean":
        this.next();
        return { kind: "boolean", value: t.value === "TRUE" };
      case "ref":
        this.next();
        return { kind: "ref", ref: t.value };
      case "range":
        this.next();
        return { kind: "range", range: t.value };
      case "name": {
        this.next();
        // must be a function call
        this.expect("lparen");
        const args: Node[] = [];
        if (this.peek().type !== "rparen") {
          args.push(this.parseExpression(0));
          while (this.peek().type === "comma") {
            this.next();
            args.push(this.parseExpression(0));
          }
        }
        this.expect("rparen");
        return { kind: "call", name: t.value.toUpperCase(), args };
      }
      case "lparen": {
        this.next();
        const expr = this.parseExpression(0);
        this.expect("rparen");
        return expr;
      }
      default:
        throw new Error(`Unexpected token ${t.type} '${t.value}'`);
    }
  }
}
