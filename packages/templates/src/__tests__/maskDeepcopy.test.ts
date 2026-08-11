// Duplicating content that contains a mask.
//
// `deepcopy.ts` descends into `mask.child` and `boolean.operands` explicitly,
// separately from the shared `childrenOf` walk. That is easy to lose track of:
// switching this file to the schema's `childNodesOf` helper looks like a
// tidy-up and instead makes every nested node visit TWICE, which regenerates
// its id twice and leaves `idMap` mapping the original id to an intermediate
// that no longer exists. Connector remapping then rewrites endpoints to a node
// that is not there.
//
// These pin the property rather than the mechanism: after a copy, every id is
// fresh and every id is unique, however the traversal is spelled.

import { describe, expect, it } from "vitest";
import { deepCopyDesign } from "../deepcopy";
import type { DesignFile, Node } from "@hc/schema";

function fileWithMask(): DesignFile {
  return {
    schemaVersion: 19, id: "d", title: "t", assets: [], fonts: [], meta: {},
    pages: [{ id: "p1", width: 200, height: 200, children: [{
      id: "m", type: "mask",
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 100, height: 100 }, opacity: 1, blendMode: "normal",
      maskShape: { fillRule: "nonzero", subpaths: [] },
      child: {
        id: "subject", type: "shape", shape: "rect",
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 50, height: 50 }, opacity: 1, blendMode: "normal",
      } as unknown as Node,
    }] }],
  } as unknown as DesignFile;
}

function idsOf(file: DesignFile): string[] {
  const out: string[] = [];
  const walk = (n: Record<string, unknown>) => {
    if (typeof n.id === "string") out.push(n.id);
    for (const kid of (n.children as Record<string, unknown>[]) ?? []) walk(kid);
    if (n.child) walk(n.child as Record<string, unknown>);
  };
  for (const page of file.pages) for (const n of page.children) walk(n as unknown as Record<string, unknown>);
  return out;
}

describe("deep copy reaches nodes stored outside `children`", () => {
  it("regenerates the id of a masked subject", () => {
    const copy = deepCopyDesign(fileWithMask()).file;
    const ids = idsOf(copy);
    expect(ids).toHaveLength(2);
    // Both must be fresh. Leaving `subject` behind means the copy collides
    // with the original, and the write boundary answers 422.
    expect(ids).not.toContain("subject");
    expect(ids).not.toContain("m");
  });

  it("keeps every id unique after the copy", () => {
    const ids = idsOf(deepCopyDesign(fileWithMask()).file);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
