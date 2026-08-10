// Content-addressed result cache (F40 FR-8).
//
// Two properties from the requirement drive the design.
//
// "Identical subgraphs, including identical instances of the same preset in
// different documents, share cache entries." That is why the key is a hash of
// WHAT the op is and what it was given, and contains nothing about which
// document or which node asked. Two documents using the same preset with the
// same parameters hit the same entry.
//
// "The cache is never load-bearing for correctness." So a miss must only ever
// cost time. Nothing here may mutate a stored result, and callers must treat
// what they get back as frozen; the evaluator returns cached values directly to
// avoid a copy on every hit, which is safe exactly as long as ops never mutate
// their inputs.

import { hashValue, type Canonical } from "./canonical";
import type { EvalEnv } from "./types";

/**
 * The cache key for one op invocation.
 *
 * Everything a result legitimately depends on has to be in here, or a stale
 * result gets served. `env` carries quality, which is what stops a preview
 * result from ever being handed to an export (FR-11).
 */
export function cacheKey(args: {
  op: string;
  opVersion: number;
  params: Record<string, unknown>;
  inputHashes: string[];
  env: EvalEnv;
}): string {
  return hashValue({
    op: args.op,
    v: args.opVersion,
    p: args.params as Canonical,
    // Input hashes are positional (socket order is fixed by the definition), so
    // they are NOT sorted: swapping two inputs is a different computation.
    i: args.inputHashes,
    e: { q: args.env.quality, c: args.env.colorSpace, r: args.env.resolutionClass },
  });
}

interface Entry {
  value: unknown;
  bytes: number;
  /** Monotonic counter, not a clock: FR-14 forbids reading time. */
  used: number;
}

/**
 * Bounded LRU over a byte budget.
 *
 * Recency is tracked with a counter rather than a timestamp, both because the
 * evaluator may not read the clock and because a counter cannot go backwards
 * when a machine's clock is adjusted.
 */
export class ResultCache {
  private readonly entries = new Map<string, Entry>();
  private tick = 0;
  private bytes = 0;

  constructor(private readonly budgetBytes = 64 * 1024 * 1024) {}

  get size(): number {
    return this.entries.size;
  }

  get byteSize(): number {
    return this.bytes;
  }

  get(key: string): { hit: true; value: unknown } | { hit: false } {
    const e = this.entries.get(key);
    if (!e) return { hit: false };
    e.used = ++this.tick;
    return { hit: true, value: e.value };
  }

  set(key: string, value: unknown, bytes: number): void {
    const existing = this.entries.get(key);
    if (existing) this.bytes -= existing.bytes;
    // A single item larger than the whole budget is not cached; caching it
    // would evict everything else to hold one thing.
    if (bytes > this.budgetBytes) {
      if (existing) this.entries.delete(key);
      return;
    }
    this.entries.set(key, { value, bytes, used: ++this.tick });
    this.bytes += bytes;
    this.evictToBudget();
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  private evictToBudget(): void {
    if (this.bytes <= this.budgetBytes) return;
    // Least-recently-used first. Sorting on eviction rather than maintaining an
    // intrusive list keeps this simple; eviction is rare relative to lookup.
    const byAge = [...this.entries.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [key, e] of byAge) {
      if (this.bytes <= this.budgetBytes) break;
      this.entries.delete(key);
      this.bytes -= e.bytes;
    }
  }
}

/**
 * A rough size for budgeting. Deliberately an estimate: an exact figure would
 * mean walking every result on every store, and the budget only has to be
 * approximately right to stop unbounded growth.
 */
export function estimateBytes(value: unknown): number {
  if (value === null || value === undefined) return 8;
  switch (typeof value) {
    case "number":
    case "boolean":
      return 8;
    case "string":
      return 2 * value.length + 16;
    case "object": {
      if (ArrayBuffer.isView(value)) return (value as ArrayBufferView).byteLength + 16;
      if (Array.isArray(value)) {
        let n = 16;
        for (const v of value) n += estimateBytes(v);
        return n;
      }
      let n = 16;
      for (const k of Object.keys(value as object)) {
        n += 2 * k.length + estimateBytes((value as Record<string, unknown>)[k]);
      }
      return n;
    }
    default:
      return 16;
  }
}
