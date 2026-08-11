// Traversal reaches nodes stored outside `children` (F40 Phase 1 groundwork).
//
// A mask keeps its subject in `child` and a boolean keeps its inputs in
// `operands`. Every walker read only `children`, so those nodes were invisible
// to id-uniqueness validation, comment anchoring, version diffs, and the scene
// build, which is the root reason masks did not render at all.

import { describe, expect, it } from "vitest";
import { collectIds, maxDepth, walkNodes, childNodesOf } from "../visitor";
import type { Node } from "../schema";

const leaf = (id: string): Node => ({
  id, type: "shape", shape: "rect",
  transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
  size: { width: 10, height: 10 }, opacity: 1, blendMode: "normal",
} as unknown as Node);

const mask = (id: string, child: Node): Node => ({
  id, type: "mask",
  transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
  size: { width: 50, height: 50 }, opacity: 1, blendMode: "normal",
  maskShape: { subpaths: [], fillRule: "nonzero" },
  child,
} as unknown as Node);

const bool = (id: string, operands: Node[]): Node => ({
  id, type: "boolean", op: "union", operands,
  transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
  size: { width: 50, height: 50 }, opacity: 1, blendMode: "normal",
} as unknown as Node);

const group = (id: string, children: Node[]): Node => ({
  id, type: "group", children,
  transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
  size: { width: 50, height: 50 }, opacity: 1, blendMode: "normal",
} as unknown as Node);

describe("nested slots are traversed", () => {
  it("sees a masked child", () => {
    expect(collectIds([mask("m", leaf("subject"))])).toEqual(["m", "subject"]);
  });

  it("sees boolean operands", () => {
    expect(collectIds([bool("b", [leaf("a"), leaf("c")])])).toEqual(["b", "a", "c"]);
  });

  it("sees a group nested inside a mask", () => {
    expect(collectIds([mask("m", group("g", [leaf("deep")]))])).toEqual(["m", "g", "deep"]);
  });

  it("counts masked nesting toward depth", () => {
    // Depth is what bounds recursion at the write boundary; a mask chain that
    // reported depth 0 would let an arbitrarily deep document through.
    expect(maxDepth([mask("m", leaf("x"))])).toBe(1);
    expect(maxDepth([mask("m1", mask("m2", leaf("x")))])).toBe(2);
  });
});

describe("paths address the node they name", () => {
  it("ends a mask child's pointer at the key, with no index", () => {
    // `child` is one node, not an array. A `/child/0` pointer resolves to
    // nothing, and these paths are what comment anchoring addresses.
    const paths: Array<Array<string | number>> = [];
    walkNodes([mask("m", leaf("subject"))], (_n, info) => paths.push(info.path));
    expect(paths).toEqual([[0], [0, "child"]]);
  });

  it("indexes operands", () => {
    const paths: Array<Array<string | number>> = [];
    walkNodes([bool("b", [leaf("a"), leaf("c")])], (_n, info) => paths.push(info.path));
    expect(paths).toEqual([[0], [0, "operands", 0], [0, "operands", 1]]);
  });

  it("stays correct for a mask inside a mask", () => {
    // The case a list-shaped recursion gets wrong: it appends an index to the
    // inner single-node slot and produces a pointer that does not resolve.
    const paths: Array<Array<string | number>> = [];
    walkNodes([mask("m1", mask("m2", leaf("x")))], (_n, info) => paths.push(info.path));
    expect(paths).toEqual([[0], [0, "child"], [0, "child", "child"]]);
  });
});

describe("childNodesOf", () => {
  it("returns nested nodes wherever they are stored", () => {
    expect(childNodesOf(mask("m", leaf("s"))).map((n) => n.id)).toEqual(["s"]);
    expect(childNodesOf(bool("b", [leaf("a"), leaf("c")])).map((n) => n.id)).toEqual(["a", "c"]);
    expect(childNodesOf(leaf("x"))).toEqual([]);
  });
});
