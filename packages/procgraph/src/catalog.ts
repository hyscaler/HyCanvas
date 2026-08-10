// The op catalog (F40 FR-4, FR-14).
//
// FR-14 asks for determinism "by construction, not by convention: the op
// interface makes these unavailable rather than merely discouraged". That is
// the reason `OpContext` is as narrow as it is. An op is handed its resolved
// params, its inputs, the environment, a seeded stream, and a counter. It is
// given no clock, no locale, no environment access, and no way to reach the
// network. An op that wants randomness has to ask for a stream keyed to its own
// identity, so it cannot accidentally depend on evaluation order.
//
// None of that stops a determined author from importing `Date` directly, which
// is why `assertDeterministicSource` exists as a cheap review aid rather than a
// guarantee. The real guarantee is the conformance suite in FR-16 running the
// same corpus through every runtime; this only catches the obvious cases early,
// where the error message can still name the op.

import type { OpDefinition } from "./types";

export class OpCatalog {
  private readonly defs = new Map<string, OpDefinition>();

  /** Catalog version: bumped whenever the set or any member version changes. */
  get version(): number {
    let v = 0;
    // Sorted so the version is a function of content, not registration order.
    for (const id of [...this.defs.keys()].sort()) v = (v * 31 + this.defs.get(id)!.version) | 0;
    return v;
  }

  register(def: OpDefinition): this {
    if (this.defs.has(def.op)) throw new Error(`op already registered: ${def.op}`);
    this.defs.set(def.op, def);
    return this;
  }

  get(op: string): OpDefinition | undefined {
    return this.defs.get(op);
  }

  has(op: string): boolean {
    return this.defs.has(op);
  }

  /** Registered ids, sorted, so callers cannot depend on registration order. */
  ids(): string[] {
    return [...this.defs.keys()].sort();
  }
}

/**
 * Flag the obvious ways an op body can become non-deterministic.
 *
 * Source-level and therefore easily fooled; it exists so a mistake is caught in
 * a unit test with the op's name attached, rather than as a parity failure
 * between the browser and the Go renderer weeks later.
 */
export function assertDeterministicSource(def: OpDefinition): void {
  const src = def.run.toString();
  const banned: [RegExp, string][] = [
    [/\bMath\s*\.\s*random\b/, "Math.random (use ctx.random, which is seeded)"],
    [/\bDate\s*\.\s*now\b/, "Date.now (evaluation may not read the clock)"],
    [/\bnew\s+Date\b/, "new Date (evaluation may not read the clock)"],
    [/\btoLocale[A-Za-z]*\s*\(/, "toLocale* (locale-dependent formatting)"],
    [/\blocaleCompare\s*\(/, "localeCompare (locale-dependent ordering)"],
    [/\bprocess\s*\.\s*env\b/, "process.env (environment access)"],
    [/\bfetch\s*\(/, "fetch (network access)"],
    [/\bperformance\s*\.\s*now\b/, "performance.now (evaluation may not read the clock)"],
  ];
  for (const [re, why] of banned) {
    if (re.test(src)) throw new Error(`op ${def.op} is not deterministic: ${why}`);
  }
}
