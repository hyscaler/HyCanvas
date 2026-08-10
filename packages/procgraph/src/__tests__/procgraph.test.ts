// The evaluation core, tested against the requirements it exists to satisfy.
// Each block names its FR so a future change that breaks one is told which
// promise it broke, rather than just which assertion failed.

import { describe, expect, it } from "vitest";
import { canonicalize, canonicalNumber, hashValue } from "../canonical";
import { rngFor } from "../prng";
import { buildDependencyGraph, dirtySet, requiredFor, topologicalOrder } from "../graph";
import { OpCatalog, assertDeterministicSource } from "../catalog";
import { ResultCache, cacheKey } from "../cache";
import { evaluate, graphHash } from "../evaluate";
import type { EvalEnv, GraphOp, NodeGraph } from "../types";

const ENV: EvalEnv = { quality: "final", colorSpace: "srgb", resolutionClass: 1 };

function op(id: string, kind: string, params: Record<string, unknown> = {}): GraphOp {
  return {
    id,
    op: kind,
    opVersion: 1,
    params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, { kind: "literal", value: v } as const])),
  };
}

/** A catalog whose ops record the order they ran in, for ordering assertions. */
function testCatalog(log: string[] = []) {
  const c = new OpCatalog();
  c.register({
    op: "const",
    version: 1,
    inputs: [],
    run: (ctx) => {
      log.push("const");
      return Number(ctx.params.value ?? 0);
    },
  });
  c.register({
    op: "add",
    version: 1,
    inputs: ["a", "b"],
    run: (ctx) => {
      log.push("add");
      return Number(ctx.inputs.a ?? 0) + Number(ctx.inputs.b ?? 0);
    },
  });
  c.register({
    op: "double",
    version: 1,
    inputs: ["in"],
    run: (ctx) => {
      log.push("double");
      return Number(ctx.inputs.in ?? 0) * 2;
    },
  });
  c.register({ op: "boom", version: 1, inputs: [], run: () => { throw new Error("op exploded"); } });
  c.register({
    op: "spawn",
    version: 1,
    inputs: [],
    run: (ctx) => {
      ctx.count("instances", Number(ctx.params.n ?? 0));
      return Number(ctx.params.n ?? 0);
    },
  });
  return { catalog: c, log };
}

function graph(ops: GraphOp[], edges: NodeGraph["edges"], output: string, extra: Partial<NodeGraph> = {}): NodeGraph {
  return { version: 1, ops, edges, output, ...extra };
}

describe("canonical form (FR-14)", () => {
  it("is independent of key insertion order", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it("keeps values JSON conflates apart", () => {
    // Without explicit spellings these all collapse, and two different graphs
    // would share a cache entry.
    expect(canonicalNumber(-0)).not.toBe(canonicalNumber(0));
    expect(canonicalNumber(NaN)).not.toBe("null");
    expect(canonicalNumber(Infinity)).not.toBe(canonicalNumber(-Infinity));
    expect(hashValue({ a: NaN })).not.toBe(hashValue({ a: null }));
  });

  it("hashes are stable and differ on any change", () => {
    expect(hashValue({ a: 1 })).toBe(hashValue({ a: 1 }));
    expect(hashValue({ a: 1 })).not.toBe(hashValue({ a: 2 }));
    expect(hashValue("é")).toBe(hashValue("é")); // multi-byte UTF-8 path
    expect(hashValue("😀")).toHaveLength(16); // surrogate pair path
  });
});

describe("seeded randomness (FR-15)", () => {
  it("is reproducible for the same coordinates", () => {
    const a = rngFor(7, "op1", 0, "pos");
    const b = rngFor(7, "op1", 0, "pos");
    expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()]);
  });

  it("separates ops, instances, and channels", () => {
    expect(rngFor(7, "op1").next()).not.toBe(rngFor(7, "op2").next());
    expect(rngFor(7, "op1", 0).next()).not.toBe(rngFor(7, "op1", 1).next());
    expect(rngFor(7, "op1", 0, "pos").next()).not.toBe(rngFor(7, "op1", 0, "rot").next());
  });

  it("an op's sequence does not move when the graph changes elsewhere", () => {
    // The whole point of keying on coordinates: this is what a single shared
    // generator would get wrong.
    const before = [rngFor(1, "keep").next(), rngFor(1, "keep").next()];
    rngFor(1, "a-new-op-added-upstream").next();
    expect([rngFor(1, "keep").next(), rngFor(1, "keep").next()]).toEqual(before);
  });

  it("stays in range", () => {
    const r = rngFor(3, "x");
    for (let i = 0; i < 200; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    for (let i = 0; i < 50; i++) expect([5, 6, 7]).toContain(rngFor(3, "y", i).nextInt(5, 8));
  });
});

describe("dependency order (FR-6)", () => {
  it("runs an op only after its precedents", () => {
    const g = buildDependencyGraph(
      [op("a", "const"), op("b", "const"), op("sum", "add"), op("out", "double")],
      [
        { from: { op: "a", socket: "out" }, to: { op: "sum", socket: "a" } },
        { from: { op: "b", socket: "out" }, to: { op: "sum", socket: "b" } },
        { from: { op: "sum", socket: "out" }, to: { op: "out", socket: "in" } },
      ],
    );
    const { order } = topologicalOrder([op("a", "const"), op("b", "const"), op("sum", "add"), op("out", "double")], g);
    expect(order.indexOf("sum")).toBeGreaterThan(order.indexOf("a"));
    expect(order.indexOf("sum")).toBeGreaterThan(order.indexOf("b"));
    expect(order.indexOf("out")).toBeGreaterThan(order.indexOf("sum"));
  });

  it("breaks ties by id so order is a function of the graph alone", () => {
    const ops = [op("z", "const"), op("a", "const"), op("m", "const")];
    const g = buildDependencyGraph(ops, []);
    expect(topologicalOrder(ops, g).order).toEqual(["a", "m", "z"]);
    // Same graph, different array order, same result.
    const shuffled = [op("m", "const"), op("z", "const"), op("a", "const")];
    expect(topologicalOrder(shuffled, buildDependencyGraph(shuffled, [])).order).toEqual(["a", "m", "z"]);
  });
});

describe("incrementality (FR-7)", () => {
  it("dirties only what depends on the change", () => {
    const ops = [op("a", "const"), op("b", "const"), op("sum", "add"), op("side", "double")];
    const dep = buildDependencyGraph(ops, [
      { from: { op: "a", socket: "o" }, to: { op: "sum", socket: "a" } },
      { from: { op: "b", socket: "o" }, to: { op: "sum", socket: "b" } },
    ]);
    const dirty = dirtySet(["a"], dep);
    expect([...dirty].sort()).toEqual(["a", "sum"]);
    expect(dirty.has("side")).toBe(false);
    expect(dirty.has("b")).toBe(false);
  });

  it("skips ops the output does not depend on", () => {
    const { catalog, log } = testCatalog();
    const g = graph(
      [op("used", "const", { value: 2 }), op("unused", "const", { value: 9 }), op("out", "double")],
      [{ from: { op: "used", socket: "o" }, to: { op: "out", socket: "in" } }],
      "out",
    );
    const r = evaluate({ graph: g, catalog, env: ENV });
    expect(r.output).toBe(4);
    expect(r.stats.skipped).toBeGreaterThan(0);
    expect(log).not.toContain("const:unused");
    expect(requiredFor("out", buildDependencyGraph(g.ops, g.edges)).has("unused")).toBe(false);
  });
});

describe("caching (FR-8, FR-11)", () => {
  it("serves a repeat evaluation from cache", () => {
    const { catalog } = testCatalog();
    const cache = new ResultCache();
    const g = graph([op("a", "const", { value: 5 })], [], "a");
    const first = evaluate({ graph: g, catalog, env: ENV, cache });
    const second = evaluate({ graph: g, catalog, env: ENV, cache });
    expect(first.stats.evaluated).toBe(1);
    expect(second.stats.cached).toBe(1);
    expect(second.stats.evaluated).toBe(0);
    expect(second.output).toBe(5);
  });

  it("never serves a preview result to a final evaluation", () => {
    const base = { op: "x", opVersion: 1, params: { a: 1 }, inputHashes: [] };
    const preview = cacheKey({ ...base, env: { ...ENV, quality: "preview" } });
    const final = cacheKey({ ...base, env: { ...ENV, quality: "final" } });
    expect(preview).not.toBe(final);
  });

  it("keys on content, so identical work in different graphs shares an entry", () => {
    const a = cacheKey({ op: "blur", opVersion: 2, params: { r: 4 }, inputHashes: ["h1"], env: ENV });
    const b = cacheKey({ op: "blur", opVersion: 2, params: { r: 4 }, inputHashes: ["h1"], env: ENV });
    expect(a).toBe(b);
    // ...but input ORDER matters: swapped inputs are a different computation.
    expect(cacheKey({ op: "m", opVersion: 1, params: {}, inputHashes: ["x", "y"], env: ENV }))
      .not.toBe(cacheKey({ op: "m", opVersion: 1, params: {}, inputHashes: ["y", "x"], env: ENV }));
  });

  it("evicts to stay inside its byte budget", () => {
    const cache = new ResultCache(200);
    for (let i = 0; i < 50; i++) cache.set(`k${i}`, "x".repeat(40), 100);
    expect(cache.byteSize).toBeLessThanOrEqual(200);
    expect(cache.size).toBeLessThanOrEqual(2);
  });

  it("declines an item larger than the whole budget rather than evicting everything", () => {
    const cache = new ResultCache(100);
    cache.set("keep", 1, 50);
    cache.set("huge", 2, 5000);
    expect(cache.get("huge").hit).toBe(false);
    expect(cache.get("keep").hit).toBe(true);
  });
});

describe("cycles are contained, never thrown (FR-9)", () => {
  it("marks the cycle and its downstream, evaluates the rest, and does not throw", () => {
    const { catalog } = testCatalog();
    const g = graph(
      [op("fine", "const", { value: 3 }), op("x", "double"), op("y", "double"), op("after", "double")],
      [
        { from: { op: "x", socket: "o" }, to: { op: "y", socket: "in" } },
        { from: { op: "y", socket: "o" }, to: { op: "x", socket: "in" } },
        { from: { op: "y", socket: "o" }, to: { op: "after", socket: "in" } },
      ],
      "fine",
    );
    const r = evaluate({ graph: g, catalog, env: ENV });
    expect(r.diagnostics.some((d) => d.code === "cycle")).toBe(true);
    expect(r.unevaluable.has("x")).toBe(true);
    expect(r.unevaluable.has("y")).toBe(true);
    expect(r.unevaluable.has("after")).toBe(true); // downstream is poisoned too
    expect(r.output).toBe(3); // the healthy part still evaluates
  });

  it("reports the offending op rather than failing the document", () => {
    const { catalog } = testCatalog();
    const g = graph([op("b", "boom")], [], "b");
    const r = evaluate({ graph: g, catalog, env: ENV });
    expect(r.output).toBeUndefined();
    expect(r.diagnostics[0]).toMatchObject({ code: "op-failed", opId: "b" });
  });

  it("treats an unknown op as unevaluable, not fatal", () => {
    const { catalog } = testCatalog();
    const g = graph(
      [op("known", "const", { value: 1 }), op("weird", "vendor.future"), op("out", "double")],
      [{ from: { op: "weird", socket: "o" }, to: { op: "out", socket: "in" } }],
      "out",
    );
    const r = evaluate({ graph: g, catalog, env: ENV });
    expect(r.diagnostics.some((d) => d.code === "unknown-op" && d.opId === "weird")).toBe(true);
    expect(r.output).toBeUndefined();
  });
});

describe("bounds (FR-10)", () => {
  it("refuses an over-large graph before running anything", () => {
    const { catalog } = testCatalog();
    const ops = Array.from({ length: 12 }, (_, i) => op(`n${i}`, "const", { value: i }));
    const r = evaluate({ graph: graph(ops, [], "n0", { limits: { maxOps: 10 } }), catalog, env: ENV });
    expect(r.diagnostics[0].code).toBe("limit-ops");
    expect(r.stats.evaluated).toBe(0);
  });

  it("stops an op that generates past the instance limit", () => {
    const { catalog } = testCatalog();
    const g = graph([op("s", "spawn", { n: 5000 })], [], "s", { limits: { maxInstances: 100 } });
    const r = evaluate({ graph: g, catalog, env: ENV });
    expect(r.diagnostics.some((d) => d.code === "limit-instances")).toBe(true);
    expect(r.output).toBeUndefined();
  });
});

describe("disabled ops pass through (FR-17 groundwork)", () => {
  it("does not sever the chain below them", () => {
    const { catalog } = testCatalog();
    const ops = [op("a", "const", { value: 4 }), { ...op("skip", "double"), disabled: true }, op("out", "double")];
    const g = graph(
      ops,
      [
        { from: { op: "a", socket: "o" }, to: { op: "skip", socket: "in" } },
        { from: { op: "skip", socket: "o" }, to: { op: "out", socket: "in" } },
      ],
      "out",
    );
    // 4 passes through the disabled doubler untouched, then doubles once.
    expect(evaluate({ graph: g, catalog, env: ENV }).output).toBe(8);
  });
});

describe("determinism guards (FR-14)", () => {
  it("rejects an op that reaches for a clock or unseeded randomness", () => {
    expect(() => assertDeterministicSource({ op: "bad", version: 1, inputs: [], run: () => Math.random() }))
      .toThrow(/not deterministic/);
    expect(() => assertDeterministicSource({ op: "bad2", version: 1, inputs: [], run: () => Date.now() }))
      .toThrow(/clock/);
    expect(() => assertDeterministicSource({ op: "ok", version: 1, inputs: [], run: (c) => c.random() }))
      .not.toThrow();
  });

  it("produces the same result across repeated evaluations", () => {
    const { catalog } = testCatalog();
    const g = graph([op("a", "const", { value: 1 }), op("b", "const", { value: 2 }), op("s", "add")], [
      { from: { op: "a", socket: "o" }, to: { op: "s", socket: "a" } },
      { from: { op: "b", socket: "o" }, to: { op: "s", socket: "b" } },
    ], "s");
    const runs = Array.from({ length: 5 }, () => evaluate({ graph: g, catalog, env: ENV }).output);
    expect(new Set(runs).size).toBe(1);
  });
});

describe("graph hash (FR-24 groundwork)", () => {
  it("is stable under reordering and changes with content", () => {
    const a = graph([op("x", "const", { v: 1 }), op("y", "const", { v: 2 })], [], "x");
    const b = graph([op("y", "const", { v: 2 }), op("x", "const", { v: 1 })], [], "x");
    expect(graphHash(a)).toBe(graphHash(b));
    const c = graph([op("x", "const", { v: 99 }), op("y", "const", { v: 2 })], [], "x");
    expect(graphHash(a)).not.toBe(graphHash(c));
  });
});
