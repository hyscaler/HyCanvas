// Correctness proof for the server-side per-node lock enforcement helpers
// (collaboration FR-8 / brand controls FR-6 defense-in-depth). Socket-free: build a Y.Doc from a
// multi-node file, snapshot the protected nodes, apply an "unauthorized"
// mutation, then restore and assert the protected node reverts while an allowed
// edit on a different node survives.

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { type DesignFile } from "@hc/schema";
import {
  reconcile,
  fromDoc,
  findNodeMap,
  snapshotNodes,
  restoreNodes,
  SERVER_ORIGIN,
} from "../index";

/** A two-page file with a nested group, so findNodeMap's recursion is exercised. */
function sampleFile(): DesignFile {
  return {
    schemaVersion: 4,
    id: "design-1",
    title: "Doc",
    assets: [],
    pages: [
      {
        id: "page-1",
        name: "Page 1",
        width: 100,
        height: 100,
        children: [
          {
            id: "locked-1",
            type: "shape",
            name: "Locked rect",
            transform: { x: 10, y: 20, scaleX: 1, scaleY: 1, rotation: 0 },
            size: { width: 50, height: 50 },
            opacity: 1,
            fills: [{ type: "solid", color: { srgb: { r: 0.1, g: 0.2, b: 0.3, a: 1 } } }],
          },
          {
            id: "free-1",
            type: "shape",
            name: "Free rect",
            transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
            size: { width: 10, height: 10 },
            opacity: 1,
          },
          {
            id: "group-1",
            type: "group",
            name: "Group",
            transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
            size: { width: 200, height: 200 },
            opacity: 1,
            children: [
              {
                id: "nested-locked",
                type: "text",
                name: "Nested",
                transform: { x: 5, y: 5, scaleX: 1, scaleY: 1, rotation: 0 },
                size: { width: 80, height: 30 },
                opacity: 1,
              },
            ],
          },
        ],
      },
    ],
  } as unknown as DesignFile;
}

function docFrom(file: DesignFile): Y.Doc {
  const doc = new Y.Doc();
  reconcile(file, doc);
  return doc;
}

/** Find a node's serialized JSON in a DesignFile by id (top-level + groups). */
function nodeJson(file: DesignFile, id: string): Record<string, unknown> | null {
  const walk = (children: unknown[]): Record<string, unknown> | null => {
    for (const c of children as Record<string, unknown>[]) {
      if (c.id === id) return c;
      if (Array.isArray(c.children)) {
        const found = walk(c.children);
        if (found) return found;
      }
    }
    return null;
  };
  for (const page of file.pages as unknown as { children: unknown[] }[]) {
    const found = walk(page.children);
    if (found) return found;
  }
  return null;
}

describe("findNodeMap", () => {
  it("finds top-level and nested nodes, returns null for unknown ids", () => {
    const doc = docFrom(sampleFile());
    expect(findNodeMap(doc, "locked-1")?.get("name")).toBe("Locked rect");
    expect(findNodeMap(doc, "nested-locked")?.get("name")).toBe("Nested");
    expect(findNodeMap(doc, "group-1")?.get("type")).toBe("group");
    expect(findNodeMap(doc, "does-not-exist")).toBeNull();
  });
});

describe("snapshotNodes", () => {
  it("serializes present nodes and records absent ids as null", () => {
    const doc = docFrom(sampleFile());
    const snap = snapshotNodes(doc, ["locked-1", "ghost"]);
    expect(snap.get("locked-1")).toEqual(nodeJson(sampleFile(), "locked-1"));
    expect(snap.get("ghost")).toBeNull();
  });
});

describe("restoreNodes (snapshot-and-correct)", () => {
  it("reverts a protected node's transform while a different node's edit survives", () => {
    const doc = docFrom(sampleFile());
    const snap = snapshotNodes(doc, ["locked-1"]);

    // Simulate an opaque inbound update: move the protected node AND move an
    // allowed node, applied as one client edit.
    const file = fromDoc(doc);
    nodeJson(file, "locked-1")!.transform = { x: 999, y: 999, scaleX: 1, scaleY: 1, rotation: 0 };
    nodeJson(file, "free-1")!.transform = { x: 7, y: 7, scaleX: 1, scaleY: 1, rotation: 0 };
    reconcile(file, doc);

    const corrected = restoreNodes(doc, snap);
    expect(corrected).toEqual(["locked-1"]);

    const out = fromDoc(doc);
    // Protected node is back to its snapshot.
    expect(nodeJson(out, "locked-1")!.transform).toEqual(
      nodeJson(sampleFile(), "locked-1")!.transform,
    );
    // The allowed node's change survived.
    expect(nodeJson(out, "free-1")!.transform).toEqual({ x: 7, y: 7, scaleX: 1, scaleY: 1, rotation: 0 });
  });

  it("reverts a same-node different-field mutation (props)", () => {
    const doc = docFrom(sampleFile());
    const snap = snapshotNodes(doc, ["locked-1"]);

    const file = fromDoc(doc);
    nodeJson(file, "locked-1")!.opacity = 0.25; // a different field than transform
    reconcile(file, doc);

    const corrected = restoreNodes(doc, snap);
    expect(corrected).toEqual(["locked-1"]);
    expect(nodeJson(fromDoc(doc), "locked-1")!.opacity).toBe(1);
  });

  it("reverts a nested (grouped) protected node", () => {
    const doc = docFrom(sampleFile());
    const snap = snapshotNodes(doc, ["nested-locked"]);

    const file = fromDoc(doc);
    nodeJson(file, "nested-locked")!.opacity = 0.1;
    reconcile(file, doc);

    expect(restoreNodes(doc, snap)).toEqual(["nested-locked"]);
    expect(nodeJson(fromDoc(doc), "nested-locked")!.opacity).toBe(1);
  });

  it("corrects nothing when the protected node was not touched", () => {
    const doc = docFrom(sampleFile());
    const snap = snapshotNodes(doc, ["locked-1"]);

    const file = fromDoc(doc);
    nodeJson(file, "free-1")!.opacity = 0.5; // only the free node changes
    reconcile(file, doc);

    expect(restoreNodes(doc, snap)).toEqual([]);
    expect(nodeJson(fromDoc(doc), "free-1")!.opacity).toBe(0.5);
  });

  it("removes an unauthorized insertion when the snapshot recorded the id absent", () => {
    const doc = docFrom(sampleFile());
    const snap = snapshotNodes(doc, ["new-locked"]); // absent at snapshot time
    expect(snap.get("new-locked")).toBeNull();

    const file = fromDoc(doc);
    (file.pages[0].children as unknown[]).push({
      id: "new-locked",
      type: "shape",
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 1, height: 1 },
      opacity: 1,
    });
    reconcile(file, doc);
    expect(findNodeMap(doc, "new-locked")).not.toBeNull();

    expect(restoreNodes(doc, snap)).toEqual(["new-locked"]);
    expect(findNodeMap(doc, "new-locked")).toBeNull();
  });

  it("best-effort re-inserts a deleted top-level locked node", () => {
    const doc = docFrom(sampleFile());
    const snap = snapshotNodes(doc, ["locked-1"]);

    const file = fromDoc(doc);
    file.pages[0].children = (file.pages[0].children as unknown[]).filter(
      (c) => (c as { id: string }).id !== "locked-1",
    ) as never;
    reconcile(file, doc);
    expect(findNodeMap(doc, "locked-1")).toBeNull();

    expect(restoreNodes(doc, snap)).toEqual(["locked-1"]);
    const restored = findNodeMap(doc, "locked-1");
    expect(restored).not.toBeNull();
    // The restored node carries the snapshot's content.
    expect(nodeJson(fromDoc(doc), "locked-1")!.name).toBe("Locked rect");
  });

  it("stamps the corrective transaction with the SERVER origin", () => {
    const doc = docFrom(sampleFile());
    const snap = snapshotNodes(doc, ["locked-1"]);
    const file = fromDoc(doc);
    nodeJson(file, "locked-1")!.opacity = 0.3;
    reconcile(file, doc);

    const origins: unknown[] = [];
    doc.on("update", (_u: Uint8Array, origin: unknown) => origins.push(origin));
    restoreNodes(doc, snap);
    expect(origins).toContain(SERVER_ORIGIN);
  });
});
