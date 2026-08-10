// The evaluator (F40 FR-6 through FR-11, FR-14).
//
// The governing rule is FR-9's: a bad graph never throws, never blanks the
// canvas, and never blocks a save. So nothing in here raises on bad input. A
// cycle, an unknown op, a missing input, or a blown limit all resolve the same
// way: the affected ops and everything downstream of them are marked
// unevaluable, a diagnostic is attached to the specific op, and the rest of the
// graph evaluates normally. The caller falls back to the node's bake for the
// unevaluable part.
//
// The one thing that IS allowed to be missing is the output: if the output op
// cannot be evaluated, `output` is undefined and the caller renders the bake.

import { cacheKey, estimateBytes, ResultCache } from "./cache";
import { hashValue, type Canonical } from "./canonical";
import { buildDependencyGraph, downstreamClosure, requiredFor, topologicalOrder } from "./graph";
import { rngFor } from "./prng";
import type { OpCatalog } from "./catalog";
import type {
  Diagnostic,
  EvalEnv,
  EvalResult,
  GraphLimits,
  NodeGraph,
  OpContext,
  ParamValue,
} from "./types";

export interface EvaluateOptions {
  graph: NodeGraph;
  catalog: OpCatalog;
  env: EvalEnv;
  cache?: ResultCache;
  /** Values for exposed params, by name. Missing names fall back to defaults. */
  exposed?: Record<string, unknown>;
  /**
   * Wall-clock deadline check, injected rather than read (FR-14). Omit it and
   * evaluation has no time bound, which is the deterministic default; a host
   * that wants `limits.maxMillis` enforced supplies a clock explicitly and
   * accepts that the cut-off point is not reproducible.
   */
  now?: () => number;
}

const DEFAULT_LIMITS: Required<Pick<GraphLimits, "maxOps" | "maxInstances" | "maxOutputNodes" | "maxPixels">> = {
  maxOps: 2000,
  maxInstances: 100_000,
  maxOutputNodes: 50_000,
  maxPixels: 64_000_000,
};

export function evaluate(opts: EvaluateOptions): EvalResult {
  const { graph, catalog, env } = opts;
  const cache = opts.cache;
  const diagnostics: Diagnostic[] = [];
  const results = new Map<string, unknown>();
  const hashes = new Map<string, string>();
  const unevaluable = new Set<string>();
  const stats = { evaluated: 0, cached: 0, skipped: 0 };

  const limits = { ...DEFAULT_LIMITS, ...(graph.limits ?? {}) };

  // Structural bound first: an op count blowout is refused before any work.
  if (graph.ops.length > limits.maxOps) {
    diagnostics.push({
      code: "limit-ops",
      message: `graph has ${graph.ops.length} ops, over the limit of ${limits.maxOps}`,
    });
    return { output: undefined, results, diagnostics, unevaluable: new Set(graph.ops.map((o) => o.id)), stats };
  }

  const byId = new Map(graph.ops.map((o) => [o.id, o]));
  const dep = buildDependencyGraph(graph.ops, graph.edges);
  const { order, cyclic } = topologicalOrder(graph.ops, dep);

  // Cycles: mark members and everything downstream, then carry on (FR-9).
  if (cyclic.size) {
    for (const id of [...cyclic].sort()) {
      diagnostics.push({ code: "cycle", opId: id, message: "op is part of a dependency cycle and cannot be evaluated" });
    }
    for (const id of downstreamClosure(cyclic, dep)) unevaluable.add(id);
  }

  if (!byId.has(graph.output)) {
    diagnostics.push({ code: "unknown-output", message: `output op "${graph.output}" is not in the graph` });
  }

  // Only what the output depends on needs to run. An op left dangling by an
  // edit is not an error; it is just not needed.
  const needed = byId.has(graph.output) ? requiredFor(graph.output, dep) : new Set<string>();

  // Edges into each op, by socket, so inputs can be gathered positionally.
  const incoming = new Map<string, { socket: string; from: string }[]>();
  for (const e of graph.edges) {
    if (!byId.has(e.from.op)) {
      diagnostics.push({
        code: "missing-input",
        opId: e.to.op,
        message: `input socket "${e.to.socket}" is connected to unknown op "${e.from.op}"`,
      });
      unevaluable.add(e.to.op);
      continue;
    }
    const list = incoming.get(e.to.op) ?? [];
    list.push({ socket: e.to.socket, from: e.from.op });
    incoming.set(e.to.op, list);
  }
  // Propagate the damage from a dangling edge downstream.
  for (const id of downstreamClosure([...unevaluable], dep)) unevaluable.add(id);

  const counters = { instances: 0, outputNodes: 0, pixels: 0 };
  const start = opts.now?.();
  let timedOut = false;

  for (const id of order) {
    if (!needed.has(id)) {
      stats.skipped++;
      continue;
    }
    if (unevaluable.has(id)) continue;

    const op = byId.get(id)!;

    if (op.disabled) {
      // A disabled op is a pass-through of its first input, so toggling it off
      // does not sever the chain below it.
      const first = (incoming.get(id) ?? []).sort((a, b) => a.socket.localeCompare(b.socket))[0];
      const passed = first ? results.get(first.from) : undefined;
      results.set(id, passed);
      hashes.set(id, first ? hashes.get(first.from) ?? "none" : "none");
      stats.skipped++;
      continue;
    }

    const def = catalog.get(op.op);
    if (!def) {
      // FR-4: an unknown op is preserved on save (the caller keeps `raw`); here
      // it simply cannot run, and its dependents cannot either.
      diagnostics.push({ code: "unknown-op", opId: id, message: `unknown op "${op.op}"` });
      for (const d of downstreamClosure([id], dep)) unevaluable.add(d);
      continue;
    }

    // Gather inputs. A socket the definition declares but no edge feeds is
    // absent rather than undefined-valued, so an op can tell "not connected"
    // from "connected to something that produced undefined".
    const inputs: Record<string, unknown> = {};
    const inputHashes: string[] = [];
    let inputMissing = false;
    const feeds = new Map((incoming.get(id) ?? []).map((e) => [e.socket, e.from]));
    for (const socket of def.inputs) {
      const from = feeds.get(socket);
      if (from === undefined) {
        inputHashes.push("none");
        continue;
      }
      if (unevaluable.has(from)) {
        inputMissing = true;
        break;
      }
      inputs[socket] = results.get(from);
      inputHashes.push(hashes.get(from) ?? "none");
    }
    if (inputMissing) {
      for (const d of downstreamClosure([id], dep)) unevaluable.add(d);
      continue;
    }

    const params = resolveParams(op.params, opts.exposed, graph);

    // Cache before running (FR-8). A hit costs a hash; a miss costs the op.
    const key = cacheKey({ op: op.op, opVersion: def.version, params, inputHashes, env });
    if (cache) {
      const got = cache.get(key);
      if (got.hit) {
        results.set(id, got.value);
        hashes.set(id, key);
        stats.cached++;
        continue;
      }
    }

    if (start !== undefined && limits.maxMillis !== undefined && !timedOut) {
      if ((opts.now!() - start) > limits.maxMillis) {
        timedOut = true;
        diagnostics.push({ code: "limit-time", opId: id, message: `evaluation exceeded ${limits.maxMillis}ms` });
      }
    }
    if (timedOut) {
      for (const d of downstreamClosure([id], dep)) unevaluable.add(d);
      continue;
    }

    let over: Diagnostic | null = null;
    const ctx: OpContext = {
      params,
      inputs,
      env,
      random: (channel = "default", instanceIndex = 0) =>
        rngFor(graph.seed ?? 0, id, instanceIndex, channel).next(),
      count: (kind, n) => {
        counters[kind] += n;
        if (kind === "instances" && counters.instances > limits.maxInstances) {
          over = { code: "limit-instances", opId: id, message: `over the instance limit of ${limits.maxInstances}` };
        } else if (kind === "outputNodes" && counters.outputNodes > limits.maxOutputNodes) {
          over = { code: "limit-output-nodes", opId: id, message: `over the output-node limit of ${limits.maxOutputNodes}` };
        } else if (kind === "pixels" && counters.pixels > limits.maxPixels) {
          over = { code: "limit-pixels", opId: id, message: `over the pixel limit of ${limits.maxPixels}` };
        }
      },
    };

    let value: unknown;
    try {
      value = def.run(ctx);
    } catch (err) {
      // An op that throws is a bug in the op, not a reason to lose the document.
      diagnostics.push({
        code: "op-failed",
        opId: id,
        message: err instanceof Error ? err.message : String(err),
      });
      for (const d of downstreamClosure([id], dep)) unevaluable.add(d);
      continue;
    }

    if (over) {
      diagnostics.push(over);
      for (const d of downstreamClosure([id], dep)) unevaluable.add(d);
      continue;
    }

    results.set(id, value);
    hashes.set(id, key);
    stats.evaluated++;
    if (cache) cache.set(key, value, estimateBytes(value));
  }

  const output = unevaluable.has(graph.output) ? undefined : results.get(graph.output);
  return { output, results, diagnostics, unevaluable, stats };
}

/**
 * Turn `ParamValue`s into plain values.
 *
 * `expr` is not evaluated here. FR-23 puts expressions on an extension of the
 * existing parser in `packages/editor/src/expression.ts`, and wiring that in is
 * Phase 2 work; until then an expression resolves to its declared default so a
 * graph carrying one still renders rather than failing.
 */
function resolveParams(
  params: Record<string, ParamValue>,
  exposed: Record<string, unknown> | undefined,
  graph: NodeGraph,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Sorted: the resulting object is hashed, and while `canonicalize` sorts keys
  // anyway, building it in a fixed order keeps the two consistent.
  for (const name of Object.keys(params).sort()) {
    const p = params[name];
    if (!p) continue;
    switch (p.kind) {
      case "literal":
        out[name] = p.value;
        break;
      case "param": {
        const declared = graph.exposed?.find((e) => e.name === p.name);
        out[name] = exposed && p.name in exposed ? exposed[p.name] : declared?.default;
        break;
      }
      case "expr":
        out[name] = graph.exposed?.find((e) => e.name === name)?.default;
        break;
    }
  }
  return out;
}

/** Hash of a graph's structure and parameters, for bake divergence (FR-24). */
export function graphHash(graph: NodeGraph): string {
  return hashValue({
    version: graph.version,
    output: graph.output,
    seed: graph.seed ?? 0,
    ops: [...graph.ops]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((o) => ({ id: o.id, op: o.op, v: o.opVersion, p: o.params as unknown as Canonical, d: o.disabled ?? false })),
    edges: [...graph.edges]
      .map((e) => `${e.from.op}:${e.from.socket}>${e.to.op}:${e.to.socket}`)
      .sort(),
  } as Canonical);
}
