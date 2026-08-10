// Dependency structure, ordering, and cycle containment (F40 FR-6, FR-9).
//
// The precedents/dependents shape is deliberately the same as
// `packages/formula/src/graph.ts`, because it is the same problem: a sheet
// recomputing only the cells affected by an edit is a procedural graph
// recomputing only the ops affected by a parameter change. FR-6 says to reuse
// that structure rather than invent a second one, and reusing the SHAPE (not
// the code, since the key types differ) means anyone who has read one can read
// the other.
//
// Cycles are contained rather than thrown (FR-9). A cycle must not blank the
// canvas or block a save, so the evaluator needs to know precisely which ops
// are poisoned: the cycle members themselves, plus everything transitively
// downstream. Everything else still evaluates.

import type { GraphEdge, GraphOp, NodeGraph } from "./types";

export interface DependencyGraph {
  /** op id -> ops that depend ON it. */
  dependents: Map<string, Set<string>>;
  /** op id -> ops it depends on. */
  precedents: Map<string, Set<string>>;
}

export function buildDependencyGraph(ops: GraphOp[], edges: GraphEdge[]): DependencyGraph {
  const dependents = new Map<string, Set<string>>();
  const precedents = new Map<string, Set<string>>();
  for (const op of ops) {
    dependents.set(op.id, new Set());
    precedents.set(op.id, new Set());
  }
  for (const e of edges) {
    // An edge naming an op that does not exist is ignored here; the evaluator
    // reports it as a missing input, which is the more useful place to say so.
    if (!precedents.has(e.to.op) || !dependents.has(e.from.op)) continue;
    precedents.get(e.to.op)!.add(e.from.op);
    dependents.get(e.from.op)!.add(e.to.op);
  }
  return { dependents, precedents };
}

/**
 * Ops in dependency order, plus the ones that can never run.
 *
 * Kahn's algorithm, with one deliberate addition: ties are broken by op id, not
 * by insertion order. FR-14 forbids letting an unordered iteration leak into
 * results, and without the sort the execution order within a dependency level
 * would depend on array order, which would in turn make the ORDER of side
 * effects (counting, diagnostics) differ between a document and a re-serialized
 * copy of itself.
 *
 * Whatever Kahn cannot emit is, by definition, in a cycle or downstream of one.
 */
export function topologicalOrder(
  ops: GraphOp[],
  dep: DependencyGraph,
): { order: string[]; cyclic: Set<string> } {
  const remaining = new Map<string, number>();
  for (const op of ops) remaining.set(op.id, dep.precedents.get(op.id)?.size ?? 0);

  const ready: string[] = [];
  for (const [id, n] of remaining) if (n === 0) ready.push(id);
  ready.sort();

  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    const freed: string[] = [];
    for (const d of sorted(dep.dependents.get(id))) {
      const n = (remaining.get(d) ?? 0) - 1;
      remaining.set(d, n);
      if (n === 0) freed.push(d);
    }
    // Keep the frontier sorted so the emitted order is a function of the graph
    // alone. Re-sorting a short list is cheaper than it looks and this is not
    // the hot path; evaluation is.
    if (freed.length) {
      ready.push(...freed);
      ready.sort();
    }
  }

  const emitted = new Set(order);
  const cyclic = new Set<string>();
  for (const op of ops) if (!emitted.has(op.id)) cyclic.add(op.id);
  return { order, cyclic };
}

function sorted(s: Set<string> | undefined): string[] {
  return s ? [...s].sort() : [];
}

/** Every op reachable downstream from any of `roots`, inclusive. */
export function downstreamClosure(roots: Iterable<string>, dep: DependencyGraph): Set<string> {
  const out = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const d of dep.dependents.get(id) ?? []) if (!out.has(d)) stack.push(d);
  }
  return out;
}

/**
 * The ops that must be recomputed when `changed` changes (FR-7).
 *
 * This is the whole of incrementality: a leaf parameter change in a 500-op
 * graph marks its own op and whatever reads from it, and nothing else. The
 * evaluator still walks the full topological order, but everything outside this
 * set is served from cache.
 */
export function dirtySet(changed: Iterable<string>, dep: DependencyGraph): Set<string> {
  return downstreamClosure(changed, dep);
}

/** Ops the output actually depends on. Anything else need not be evaluated. */
export function requiredFor(output: string, dep: DependencyGraph): Set<string> {
  const out = new Set<string>();
  const stack = [output];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const p of dep.precedents.get(id) ?? []) if (!out.has(p)) stack.push(p);
  }
  return out;
}

/** Structural checks that do not need an evaluation to answer. */
export function graphOpIds(graph: NodeGraph): Set<string> {
  return new Set(graph.ops.map((o) => o.id));
}
