// Core correctness proof for the CRDT reconciler. These tests
// run entirely in-process (two Y.Docs, no socket): round-trip fidelity, minimal
// ops, and the two concurrent-merge scenarios that demonstrate AC-2/AC-3
// (different-node and same-node-different-field edits both converge with no
// loss).

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { designRootKey, type DesignFile } from "@hc/schema";
import { reconcile, fromDoc, localOrigin, seedDocFromFile, docToFile, canApplyUpdates, isEmptyDoc } from "../index";

/**
 * A rich multi-page design exercising every structural shape the reconciler
 * handles: keyed arrays (pages, children), nested groups, idless/primitive
 * arrays (path segments, text runs, dash), and an UnknownNode carrying a free
 * `raw` blob (forward-compat extension slot). Built as a plain object so the
 * test controls the exact shape; reconcile/fromY are structural and schema-free.
 */
function richDesign(): DesignFile {
  return {
    schemaVersion: 4,
    id: "design-1",
    title: "Rich design",
    assets: [
      { id: "asset-1", kind: "image", url: "https://x/y.png", mime: "image/png", checksum: "abc" },
    ],
    pages: [
      {
        id: "page-1",
        name: "Page 1",
        width: 1080,
        height: 1080,
        background: { type: "solid", color: { srgb: { r: 1, g: 1, b: 1, a: 1 } } },
        children: [
          {
            id: "node-1",
            type: "shape",
            name: "Rect",
            shape: "rect",
            transform: { x: 10, y: 20, scaleX: 1, scaleY: 1, rotation: 0 },
            size: { width: 100, height: 60 },
            opacity: 1,
            fills: [{ type: "solid", color: { srgb: { r: 0.2, g: 0.4, b: 0.9, a: 1 } } }],
            stroke: { width: 2, dash: [4, 2], align: "center" },
          },
          {
            id: "group-1",
            type: "group",
            name: "Group",
            transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
            size: { width: 300, height: 300 },
            opacity: 1,
            children: [
              {
                id: "node-2",
                type: "text",
                name: "Heading",
                transform: { x: 5, y: 5, scaleX: 1, scaleY: 1, rotation: 0 },
                size: { width: 200, height: 40 },
                opacity: 1,
                content: [
                  {
                    runs: [
                      { text: "Hello ", style: { fontSize: 24, fill: { srgb: { r: 0, g: 0, b: 0, a: 1 } } } },
                      { text: "world", style: { fontSize: 24, fill: { srgb: { r: 1, g: 0, b: 0, a: 1 } } } },
                    ],
                    style: { align: "left" },
                  },
                ],
              },
              {
                id: "node-3",
                type: "path",
                name: "Path",
                transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
                size: { width: 50, height: 50 },
                opacity: 1,
                closed: false,
                segments: [
                  { x: 0, y: 0 },
                  { x: 10, y: 10, cIn: { x: 5, y: 5 }, cOut: { x: 15, y: 15 } },
                  { x: 20, y: 0 },
                ],
              },
            ],
          },
          {
            id: "node-4",
            type: "future-widget",
            name: "Unknown",
            transform: { x: 1, y: 2, scaleX: 1, scaleY: 1, rotation: 0 },
            size: { width: 10, height: 10 },
            opacity: 1,
            raw: { anything: [1, 2, { nested: true }], flag: false, n: null },
          },
        ],
      },
      {
        id: "page-2",
        name: "Page 2",
        width: 800,
        height: 600,
        background: { type: "solid", color: { srgb: { r: 0.95, g: 0.95, b: 0.95, a: 1 } } },
        children: [],
      },
    ],
  } as unknown as DesignFile;
}

/** Seed a fresh Y.Doc from a file via reconcile. */
function docFrom(file: DesignFile): Y.Doc {
  const doc = new Y.Doc();
  reconcile(file, doc);
  return doc;
}

/**
 * Fork a Y.Doc into a second client that shares the SAME CRDT history. This is
 * how two clients establish a common ancestor in real life (the sync protocol
 * exchanges initial state): the replica is built by applying the original's
 * encoded state to an empty doc, NOT by independently reconciling the same file
 * (which would create divergent structures for the same logical content).
 */
function forkDoc(doc: Y.Doc): Y.Doc {
  const replica = new Y.Doc();
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
  return replica;
}

describe("reconcile round-trip", () => {
  it("reconcile then fromY deep-equals the original (rich multi-page file)", () => {
    const file = richDesign();
    const ydoc = docFrom(file);
    expect(fromDoc(ydoc)).toEqual(file);
  });

  it("is idempotent: reconciling the same file twice changes nothing", () => {
    const file = richDesign();
    const ydoc = docFrom(file);
    let touched = false;
    ydoc.on("update", () => { touched = true; });
    reconcile(file, ydoc);
    expect(touched).toBe(false);
    expect(fromDoc(ydoc)).toEqual(file);
  });

  it("seedDocFromFile only seeds an empty doc", () => {
    const file = richDesign();
    const ydoc = new Y.Doc();
    expect(isEmptyDoc(ydoc)).toBe(true);
    expect(seedDocFromFile(ydoc, file)).toBe(true);
    expect(isEmptyDoc(ydoc)).toBe(false);
    // Second call is a no-op (already seeded).
    expect(seedDocFromFile(ydoc, richDesign())).toBe(false);
    expect(docToFile(ydoc)).toEqual(file);
  });
});

describe("reconcile minimal ops", () => {
  it("editing one node's x only touches that node's keys", () => {
    const file = richDesign();
    const ydoc = docFrom(file);

    // Observe which Y.Maps emit changes during the next reconcile.
    const changedMaps = new Set<unknown>();
    const root = ydoc.getMap(designRootKey);
    root.observeDeep((events) => {
      for (const e of events) changedMaps.add(e.target);
    });

    // Move node-1's x.
    (file.pages[0].children[0] as unknown as { transform: { x: number } }).transform.x = 999;
    reconcile(file, ydoc);

    // Exactly one Y.Map changed: node-1's transform map. No page map, no other
    // node, no children array was rewritten.
    expect(changedMaps.size).toBe(1);
    expect(fromDoc(ydoc)).toEqual(file);
  });

  it("a no-change reconcile produces zero ops (small update payload)", () => {
    const file = richDesign();
    const ydoc = docFrom(file);
    let updates = 0;
    ydoc.on("update", () => { updates += 1; });
    reconcile(file, ydoc);
    expect(updates).toBe(0);
  });
});

describe("reconcile concurrent merge (AC-2 / AC-3)", () => {
  it("different-node edits on two docs converge with both edits, no loss", () => {
    // A is seeded from the base; B is a fork of A (shared CRDT ancestor).
    const A = docFrom(richDesign());
    const B = forkDoc(A);

    // Capture each doc's local update stream after the common point.
    const aUpdates: Uint8Array[] = [];
    const bUpdates: Uint8Array[] = [];
    A.on("update", (u: Uint8Array, origin: unknown) => { if (origin === localOrigin) aUpdates.push(u); });
    B.on("update", (u: Uint8Array, origin: unknown) => { if (origin === localOrigin) bUpdates.push(u); });

    // A moves node-1; B recolors a text run on node-2 (different nodes). Each
    // edits an independent JS copy of the same content, then reconciles.
    const fileA = richDesign();
    (fileA.pages[0].children[0] as unknown as { transform: { x: number } }).transform.x = 500;
    reconcile(fileA, A);

    const fileB = richDesign();
    const groupChildrenB = (fileB.pages[0].children[1] as unknown as { children: unknown[] }).children;
    ((groupChildrenB[0] as { content: { runs: { style: { fill: { srgb: { r: number } } } }[] }[] }).content[0].runs[0].style.fill.srgb).r = 0.5;
    reconcile(fileB, B);

    // Exchange updates both ways.
    for (const u of aUpdates) Y.applyUpdate(B, u);
    for (const u of bUpdates) Y.applyUpdate(A, u);

    const merged = fromDoc(A);
    expect(fromDoc(B)).toEqual(merged); // both converge

    // Both edits survived: A's move AND B's recolor.
    expect((merged.pages[0].children[0] as unknown as { transform: { x: number } }).transform.x).toBe(500);
    const mergedGroup = (merged.pages[0].children[1] as unknown as { children: unknown[] }).children;
    expect((mergedGroup[0] as { content: { runs: { style: { fill: { srgb: { r: number } } } }[] }[] }).content[0].runs[0].style.fill.srgb.r).toBe(0.5);
  });

  it("same-node, different-field edits merge both fields", () => {
    const A = docFrom(richDesign());
    const B = forkDoc(A);

    const aUpdates: Uint8Array[] = [];
    const bUpdates: Uint8Array[] = [];
    A.on("update", (u: Uint8Array, origin: unknown) => { if (origin === localOrigin) aUpdates.push(u); });
    B.on("update", (u: Uint8Array, origin: unknown) => { if (origin === localOrigin) bUpdates.push(u); });

    // A changes node-1.transform.x; B changes node-1.transform.y (same map,
    // different keys) and node-1.opacity.
    const fileA = richDesign();
    (fileA.pages[0].children[0] as unknown as { transform: { x: number } }).transform.x = 42;
    reconcile(fileA, A);

    const fileB = richDesign();
    (fileB.pages[0].children[0] as unknown as { transform: { y: number } }).transform.y = 84;
    (fileB.pages[0].children[0] as unknown as { opacity: number }).opacity = 0.5;
    reconcile(fileB, B);

    for (const u of aUpdates) Y.applyUpdate(B, u);
    for (const u of bUpdates) Y.applyUpdate(A, u);

    const merged = fromDoc(A);
    expect(fromDoc(B)).toEqual(merged);
    const n1 = merged.pages[0].children[0] as unknown as { transform: { x: number; y: number }; opacity: number };
    expect(n1.transform.x).toBe(42); // A's field
    expect(n1.transform.y).toBe(84); // B's field
    expect(n1.opacity).toBe(0.5); // B's field
  });

  it("concurrent inserts of new nodes both land, ids preserved", () => {
    const A = docFrom(richDesign());
    const B = forkDoc(A);
    const aUpdates: Uint8Array[] = [];
    const bUpdates: Uint8Array[] = [];
    A.on("update", (u: Uint8Array, origin: unknown) => { if (origin === localOrigin) aUpdates.push(u); });
    B.on("update", (u: Uint8Array, origin: unknown) => { if (origin === localOrigin) bUpdates.push(u); });

    const fileA = richDesign();
    fileA.pages[0].children.push({ id: "new-A", type: "shape", transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 1, height: 1 }, opacity: 1 } as never);
    reconcile(fileA, A);

    const fileB = richDesign();
    fileB.pages[0].children.push({ id: "new-B", type: "shape", transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 1, height: 1 }, opacity: 1 } as never);
    reconcile(fileB, B);

    for (const u of aUpdates) Y.applyUpdate(B, u);
    for (const u of bUpdates) Y.applyUpdate(A, u);

    const merged = fromDoc(A);
    expect(fromDoc(B)).toEqual(merged);
    const ids = merged.pages[0].children.map((c) => c.id);
    expect(ids).toContain("new-A");
    expect(ids).toContain("new-B");
  });
});

describe("reorder", () => {
  it("reordering children produces the new order under fromY", () => {
    const file = richDesign();
    const ydoc = docFrom(file);
    const kids = file.pages[0].children;
    file.pages[0].children = [kids[2], kids[0], kids[1]];
    reconcile(file, ydoc);
    const out = fromDoc(ydoc);
    expect(out.pages[0].children.map((c) => c.id)).toEqual(["node-4", "node-1", "group-1"]);
    expect(out).toEqual(file);
  });

  it("removing a node deletes it and keeps the rest intact", () => {
    const file = richDesign();
    const ydoc = docFrom(file);
    file.pages[0].children.splice(0, 1); // drop node-1
    reconcile(file, ydoc);
    const out = fromDoc(ydoc);
    expect(out.pages[0].children.map((c) => c.id)).toEqual(["group-1", "node-4"]);
    expect(out).toEqual(file);
  });

  // The move/intention primitive: a reorder is now a property edit on the
  // existing node Y.Map (__ord rank), never a delete + reinsert. This is the
  // scenario the old delete+reinsert path lost: one client reorders a node WHILE
  // another edits that same node's content. With ranks, node-1 is never
  // tombstoned, so B's concurrent transform edit survives the merge.
  it("concurrent reorder + content edit of the moved node keeps BOTH", () => {
    const A = docFrom(richDesign());
    const B = forkDoc(A);
    const aUpdates: Uint8Array[] = [];
    const bUpdates: Uint8Array[] = [];
    A.on("update", (u: Uint8Array, origin: unknown) => { if (origin === localOrigin) aUpdates.push(u); });
    B.on("update", (u: Uint8Array, origin: unknown) => { if (origin === localOrigin) bUpdates.push(u); });

    // A reorders so node-1 moves to the end: [group-1, node-4, node-1].
    const fileA = richDesign();
    const k = fileA.pages[0].children;
    fileA.pages[0].children = [k[1], k[2], k[0]];
    reconcile(fileA, A);

    // B (no reorder) moves node-1's x and drops its opacity, concurrently.
    const fileB = richDesign();
    (fileB.pages[0].children[0] as unknown as { transform: { x: number } }).transform.x = 777;
    (fileB.pages[0].children[0] as unknown as { opacity: number }).opacity = 0.25;
    reconcile(fileB, B);

    for (const u of aUpdates) Y.applyUpdate(B, u);
    for (const u of bUpdates) Y.applyUpdate(A, u);

    const merged = fromDoc(A);
    expect(fromDoc(B)).toEqual(merged); // both converge

    // A's reorder won (node-1 last) AND B's content edit on node-1 survived.
    expect(merged.pages[0].children.map((c) => c.id)).toEqual(["group-1", "node-4", "node-1"]);
    const n1 = merged.pages[0].children[2] as unknown as { transform: { x: number }; opacity: number };
    expect(n1.transform.x).toBe(777);
    expect(n1.opacity).toBe(0.25);
  });

  // Reordering must not leave __ord (the synthetic rank) in the projected file:
  // round-trip fidelity holds after a reorder.
  it("reorder leaves no __ord key in the projected DesignFile", () => {
    const file = richDesign();
    const ydoc = docFrom(file);
    const kids = file.pages[0].children;
    file.pages[0].children = [kids[2], kids[0], kids[1]];
    reconcile(file, ydoc);
    const out = fromDoc(ydoc);
    for (const c of out.pages[0].children) {
      expect(Object.prototype.hasOwnProperty.call(c, "__ord")).toBe(false);
    }
    expect(out).toEqual(file);
  });
});

describe("viewer gate (FR-13)", () => {
  it("editors may apply updates, viewers may not", () => {
    expect(canApplyUpdates("editor")).toBe(true);
    expect(canApplyUpdates("viewer")).toBe(false);
  });
});
