// The collab bridge's first-edit-before-sync seeding: an edit made before the
// room sync lands must stay undoable (the pre-edit baseline seeds separately),
// while a document load into an empty Y.Doc is a pure seed that undo never
// reverts. Runs against the real editor store and a real Y.Doc; no network or
// IndexedDB (both are absent in this environment and the bridge degrades).
import { afterEach, describe, expect, it } from "vitest";
import type { DesignFile, Node } from "@hc/schema";
import { fromDoc } from "@hc/realtime";
import { DesignDoc } from "./ydoc";
import { useEditor } from "@/store/editor";

function fileWith(nodes: Node[]): DesignFile {
  return {
    schemaVersion: 1,
    id: "test-design",
    title: "Test",
    pages: [{ id: "p1", width: 1080, height: 1080, children: nodes }],
  } as unknown as DesignFile;
}

function rect(id: string): Node {
  return {
    id,
    type: "shape",
    shape: "rect",
    transform: { x: 10, y: 10, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: 100, height: 80 },
  } as unknown as Node;
}

let live: DesignDoc | null = null;

afterEach(() => {
  live?.dispose();
  live = null;
});

describe("DesignDoc seeding vs first-edit undo", () => {
  it("keeps an edit made before any sync undoable", () => {
    // Production order: the REST file loads, THEN the bridge binds.
    useEditor.getState().loadDoc(fileWith([rect("n1")]));
    live = new DesignDoc("test-first-edit");
    const cu = useEditor.getState().collabUndo;
    expect(cu).not.toBeNull();

    // A local edit before any room sync: perform() under a bound collabUndo
    // mutates the doc in place and bumps rev (same doc object).
    const doc = useEditor.getState().doc;
    doc.pages[0].children.push(rect("n2"));
    useEditor.setState((s) => ({ rev: s.rev + 1 }));

    // Both the baseline and the edit are in the Y.Doc...
    expect((fromDoc(live.ydoc).pages[0].children as Node[]).map((n) => n.id)).toEqual(["n1", "n2"]);
    // ...and the edit is one undoable step, while the seed is not.
    expect(cu!.canUndo()).toBe(true);
    cu!.undo();
    expect((fromDoc(live.ydoc).pages[0].children as Node[]).map((n) => n.id)).toEqual(["n1"]);
    // The undo applied under the manager's origin, so the store rebuilt too.
    expect((useEditor.getState().doc.pages[0].children as Node[]).map((n) => n.id)).toEqual(["n1"]);
    // No further step: undo must never revert the seeded document itself.
    expect(cu!.canUndo()).toBe(false);

    // Redo restores the edit.
    expect(cu!.canRedo()).toBe(true);
    cu!.redo();
    expect((fromDoc(live.ydoc).pages[0].children as Node[]).map((n) => n.id)).toEqual(["n1", "n2"]);
  });

  it("treats a document load into an empty Y.Doc as a pure, non-undoable seed", () => {
    useEditor.getState().loadDoc(fileWith([rect("a")]));
    live = new DesignDoc("test-doc-swap");
    const cu = useEditor.getState().collabUndo;

    // A document SWAP (loadDoc installs a NEW doc object) while the Y.Doc is
    // still empty: the whole file seeds in and must not be undoable.
    useEditor.getState().loadDoc(fileWith([rect("b1"), rect("b2")]));
    expect((fromDoc(live.ydoc).pages[0].children as Node[]).map((n) => n.id)).toEqual(["b1", "b2"]);
    expect(cu!.canUndo()).toBe(false);

    // The NEXT edit diffs normally and is undoable.
    const doc = useEditor.getState().doc;
    doc.pages[0].children.push(rect("b3"));
    useEditor.setState((s) => ({ rev: s.rev + 1 }));
    expect(cu!.canUndo()).toBe(true);
    cu!.undo();
    expect((fromDoc(live.ydoc).pages[0].children as Node[]).map((n) => n.id)).toEqual(["b1", "b2"]);
  });
});
