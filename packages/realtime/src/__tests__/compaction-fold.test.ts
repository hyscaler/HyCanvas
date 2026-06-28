// F16 FR-11 (log compaction) load-bearing property: a full-state CHECKPOINT
// (Y.encodeStateAsUpdate) applied as the base, followed by the tail delta
// updates, reconstructs the exact live document on the same CRDT identity space.
// This is what lets the server delete pre-checkpoint rows while the history
// scrubber still folds checkpoint-then-tail correctly (frontend historyFold.ts
// wraps the same primitives in y-protocols framing; that wrapper is a thin,
// third-party-guaranteed layer, so the CRDT claim is what matters here).

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { reconcile, docToFile } from "../index";
import type { DesignFile } from "@hc/schema";

function baseDesign(): DesignFile {
  return {
    schemaVersion: 4,
    id: "d1",
    title: "Compaction",
    pages: [
      {
        id: "p1",
        name: "Page 1",
        width: 200,
        height: 200,
        background: { type: "solid", color: { srgb: { r: 1, g: 1, b: 1, a: 1 } } },
        children: [
          {
            id: "n1",
            type: "shape",
            name: "Rect",
            shape: "rect",
            transform: { x: 10, y: 10, scaleX: 1, scaleY: 1, rotation: 0 },
            size: { width: 40, height: 40 },
            opacity: 1,
            fills: [{ type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } }],
          },
        ],
      },
    ],
  } as unknown as DesignFile;
}

describe("checkpoint compaction fold property (FR-11)", () => {
  it("checkpoint + tail deltas reconstructs the live document", () => {
    const live = new Y.Doc();
    reconcile(baseDesign(), live);

    // Full-state checkpoint captured at this point.
    const checkpoint = Y.encodeStateAsUpdate(live);

    // Capture every subsequent delta (what the hub would have journaled as tail).
    const tail: Uint8Array[] = [];
    const onUpdate = (u: Uint8Array) => tail.push(u);
    live.on("update", onUpdate);

    const edited = baseDesign();
    edited.pages[0].children[0].transform = { x: 80, y: 90, scaleX: 1, scaleY: 1, rotation: 0 };
    edited.pages[0].children[0].fills = [{ type: "solid", color: { srgb: { r: 1, g: 0, b: 0, a: 1 } } }];
    edited.pages[0].children.push({
      id: "n2",
      type: "shape",
      name: "Ellipse",
      shape: "ellipse",
      transform: { x: 5, y: 5, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 20, height: 20 },
      opacity: 1,
      fills: [{ type: "solid", color: { srgb: { r: 0, g: 0, b: 1, a: 1 } } }],
    } as unknown as DesignFile["pages"][number]["children"][number]);
    reconcile(edited, live);
    live.off("update", onUpdate);
    expect(tail.length).toBeGreaterThan(0);

    // Fold checkpoint-then-tail into a fresh doc, exactly as the scrubber does.
    const folded = new Y.Doc();
    Y.applyUpdate(folded, checkpoint);
    for (const u of tail) Y.applyUpdate(folded, u);

    expect(docToFile(folded)).toEqual(docToFile(live));
  });

  it("checkpoint alone reconstructs the document as of checkpoint time", () => {
    const live = new Y.Doc();
    reconcile(baseDesign(), live);
    const atCheckpoint = docToFile(live);
    const checkpoint = Y.encodeStateAsUpdate(live);

    // Mutate after the checkpoint; folding only the checkpoint must ignore it.
    const edited = baseDesign();
    edited.title = "after-checkpoint";
    reconcile(edited, live);

    const folded = new Y.Doc();
    Y.applyUpdate(folded, checkpoint);
    expect(docToFile(folded)).toEqual(atCheckpoint);
  });
});
