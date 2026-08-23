// F16 per-user collaborative undo (the property the editor's DesignDoc relies
// on): a Yjs UndoManager scoped to localOrigin reverts only THIS client's edits
// and leaves a concurrent peer edit untouched, so undo never clobbers a
// teammate's work. Mirrors the wiring in frontend/src/lib/ydoc.ts.

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { designRootKey, type DesignFile } from "@hc/schema";
import { reconcile, fromDoc, localOrigin } from "../index";

function rect(id: string, x: number) {
  return {
    id,
    type: "shape",
    name: id,
    shape: "rect",
    transform: { x, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: 10, height: 10 },
    opacity: 1,
    fills: [],
  };
}

function design(nodes: unknown[]): DesignFile {
  return {
    schemaVersion: 4,
    id: "d",
    title: "t",
    assets: [],
    pages: [{ id: "p1", name: "P", width: 100, height: 100, children: nodes }],
  } as unknown as DesignFile;
}

function nodeX(file: DesignFile, id: string): number | undefined {
  const n = file.pages[0].children.find((c) => (c as { id: string }).id === id) as
    | { transform?: { x: number } }
    | undefined;
  return n?.transform?.x;
}

function hasNode(file: DesignFile, id: string): boolean {
  return file.pages[0].children.some((c) => (c as { id: string }).id === id);
}

describe("per-user collaborative undo (UndoManager scoped to localOrigin)", () => {
  it("undo reverts only the local edit and preserves a concurrent remote edit", () => {
    const doc = new Y.Doc();

    // Baseline shared state arrives as a remote/initial sync (NOT localOrigin),
    // so it is not tracked by the undo manager: one node `a` at x=0.
    const seed = new Y.Doc();
    reconcile(design([rect("a", 0)]), seed);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed), "remote");

    const um = new Y.UndoManager(doc.getMap(designRootKey), {
      trackedOrigins: new Set([localOrigin]),
    });

    // Local edit (tracked): move `a` to x=50. reconcile runs under localOrigin.
    reconcile(design([rect("a", 50)]), doc);
    expect(um.canUndo()).toBe(true);

    // Concurrent remote edit (NOT tracked): a peer adds node `b`, delivered to us
    // with a remote origin (as the relay would).
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc)); // share history
    reconcile(design([rect("a", 50), rect("b", 0)]), peer);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer), "remote");

    let file = fromDoc(doc);
    expect(nodeX(file, "a")).toBe(50);
    expect(hasNode(file, "b")).toBe(true);

    // Undo: reverts ONLY our local move of `a`; the peer's `b` survives.
    um.undo();
    file = fromDoc(doc);
    expect(nodeX(file, "a")).toBe(0); // local edit reverted
    expect(hasNode(file, "b")).toBe(true); // remote edit preserved (no clobber)
  });

  it("clear() drops the undo history so a baseline/restore is not undoable", () => {
    const doc = new Y.Doc();
    const um = new Y.UndoManager(doc.getMap(designRootKey), {
      trackedOrigins: new Set([localOrigin]),
    });
    reconcile(design([rect("a", 0)]), doc); // seed under localOrigin
    um.clear();
    expect(um.canUndo()).toBe(false);
  });
});
