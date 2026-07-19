// Regression gate for editor undo through the collab bridge. Once a DesignDoc
// binds (every design opened from the dashboard), store.undo() delegates
// EXCLUSIVELY to the Yjs UndoManager, so undo only works if local edits
// actually reconcile into the Y.Doc. This suite runs the REAL store against
// the REAL bridge, the exact path Cmd+Z takes; it caught the dual-yjs-instance
// break (ESM app + CJS @hc/realtime loading different yjs builds ->
// "Unexpected content type" on every reconcile -> undo, outbound sync, and
// offline persistence all dead). @hc/realtime building as ESM (one yjs.mjs
// app-wide) plus vitest's yjs alias is what keeps it fixed; the manager
// canUndo/canRedo assertions here fail if edits silently stop being tracked.

import { describe, it, expect, beforeEach } from "vitest";
import * as Y from "yjs";
import { reconcile } from "@hc/realtime";
import { useEditor } from "../store/editor";
import { DesignDoc } from "./ydoc";
import { createBlankDesign } from "@hc/schema";

/** Simulate the room's initial sync: apply the store doc as a REMOTE update so
 *  the Y.Doc is non-empty and untracked, like a server-seeded room. */
function syncRoom(dd: DesignDoc): void {
  const tmp = new Y.Doc();
  reconcile(useEditor.getState().doc, tmp);
  dd.applyUpdate(Y.encodeStateAsUpdate(tmp));
}

const children = () => useEditor.getState().doc.pages[0].children.length;

describe("undo through the collab bridge", () => {
  beforeEach(() => {
    useEditor.getState().loadDoc(createBlankDesign({ width: 800, height: 600 }));
  });

  it("store-only undo works without a DesignDoc", () => {
    const st = useEditor.getState();
    expect(useEditor.getState().collabUndo).toBeNull();
    const before = children();
    st.addNode("shape", {});
    expect(children()).toBe(before + 1);
    useEditor.getState().undo();
    expect(children()).toBe(before);
  });

  it("undo and redo run through the CRDT manager on a synced doc", () => {
    const dd = new DesignDoc("undo-regression");
    try {
      syncRoom(dd);
      const cu = useEditor.getState().collabUndo!;
      expect(cu).not.toBeNull();
      const before = children();
      useEditor.getState().addNode("shape", {});
      const after = children();
      expect(after).toBe(before + 1);
      // The edit must be TRACKED by the manager (this is what the dual-yjs bug
      // silently broke), and undo/redo must run through it, not a fallback.
      expect(cu.canUndo()).toBe(true);
      useEditor.getState().undo(); // what Cmd+Z runs
      expect(children()).toBe(before);
      expect(cu.canRedo()).toBe(true);
      useEditor.getState().redo(); // what Cmd+Shift+Z runs
      expect(children()).toBe(after);
      expect(cu.canRedo()).toBe(false);
    } finally {
      dd.dispose();
    }
  });

  it("undo reverts only the newest step", () => {
    const dd = new DesignDoc("undo-regression-2");
    try {
      syncRoom(dd);
      const cu = useEditor.getState().collabUndo!;
      useEditor.getState().addNode("shape", {});
      const afterFirst = children();
      // Yjs merges tracked transactions within its capture window; a new step
      // must be forced the way interactive pauses do it.
      cu.stopCapturing();
      useEditor.getState().addNode("text", {});
      useEditor.getState().undo();
      expect(children()).toBe(afterFirst);
    } finally {
      dd.dispose();
    }
  });

  it("an edit before any sync is undoable, and undo cannot wipe the doc", () => {
    // No room sync yet: the bridge seeds the PRE-EDIT baseline into the empty
    // Y.Doc as a non-undoable transaction, then reconciles the edit as its own
    // tracked step. Undo reverts the edit only; the seeded document itself can
    // never be blanked by undo.
    const dd = new DesignDoc("undo-regression-3");
    try {
      const cu = useEditor.getState().collabUndo!;
      const before = children();
      useEditor.getState().addNode("shape", {});
      expect(children()).toBe(before + 1);
      // The session's FIRST action is a normal undoable step (regression: the
      // seed used to swallow it via undoMgr.clear()).
      expect(cu.canUndo()).toBe(true);
      useEditor.getState().undo();
      expect(children()).toBe(before); // the edit reverted, not the document
      // No further step: undo never reverts the seed (a blanked doc).
      expect(cu.canUndo()).toBe(false);
      useEditor.getState().undo();
      expect(children()).toBe(before); // safe no-op
      expect(useEditor.getState().doc.pages.length).toBeGreaterThan(0);
      // The next edit is a normal tracked step and undoes cleanly.
      useEditor.getState().addNode("text", {});
      expect(cu.canUndo()).toBe(true);
      useEditor.getState().undo();
      expect(children()).toBe(before);
    } finally {
      dd.dispose();
    }
  });

  it("local stacks stay empty while a CRDT manager is bound", () => {
    // Local entries are never consumed by CRDT undo; if they accumulated, a
    // fallback replay would re-apply stale state over newer (or peer) edits.
    const dd = new DesignDoc("undo-regression-4");
    try {
      syncRoom(dd);
      useEditor.getState().addNode("shape", {});
      expect(useEditor.getState().undoStack.length).toBe(0);
      expect(useEditor.getState().redoStack.length).toBe(0);
    } finally {
      dd.dispose();
    }
  });
});
