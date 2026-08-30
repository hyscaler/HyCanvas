// A generation is ONE undoable turn, including the work that lands after it.
// Streamed slide copy, placeholder images and hero backgrounds arrive seconds
// later; each used to push its own undo entry, so a single undo peeled off one
// stray image instead of reverting the deck the success toast promised, and
// each also cleared the user's redo stack.
import { beforeEach, describe, expect, it } from "vitest";
import type { Node } from "@hc/schema";
import { useEditor } from "./editor";

function seed() {
  const st = useEditor.getState();
  const doc = st.doc;
  doc.pages.splice(1);
  (doc.pages[0] as unknown as { children: Node[] }).children.length = 0;
  useEditor.setState({ activePage: 0, selection: [], undoStack: [], redoStack: [] });
}

beforeEach(seed);

describe("async AI landings fold into the turn they continue", () => {
  it("merges into the previous turn, so one undo reverts both", () => {
    const st = useEditor.getState();
    st.runAsTurn(() => st.addTextBox("the turn"));
    expect(useEditor.getState().undoStack.length).toBe(1);
    const turnId = useEditor.getState().currentTurnId();
    const folded = st.extendTurn(turnId, () => st.addTextBox("landed later"));
    expect(folded).toBe(true);
    // Still ONE entry, and undoing it reverts the late landing too - the case
    // that matters when the work lands on a page the turn did not create.
    expect(useEditor.getState().undoStack.length).toBe(1);
    const kids = () => (useEditor.getState().doc.pages[0] as unknown as { children: Node[] }).children.length;
    expect(kids()).toBe(2);
    st.undo();
    expect(kids()).toBe(0);
    st.redo();
    expect(kids()).toBe(2);
  });

  it("does NOT rewrite history the user has moved on from", () => {
    const st = useEditor.getState();
    st.runAsTurn(() => st.addTextBox("the turn"));
    const turnId = useEditor.getState().currentTurnId();
    st.addTextBox("the user's own next edit");
    expect(useEditor.getState().undoStack.length).toBe(2);
    // The late result must NOT fold into an edit it had no part in: its own
    // turn is no longer on top, so it applies without rewriting that history.
    const folded = st.extendTurn(turnId, () => st.addTextBox("landed later"));
    expect(folded).toBe(false);
    expect(useEditor.getState().undoStack.length).toBe(2);
  });

  it("preserves the redo stack when folding", () => {
    const st = useEditor.getState();
    st.addTextBox("one");
    st.runAsTurn(() => st.addTextBox("two"));
    st.undo();
    expect(useEditor.getState().redoStack.length).toBe(1);
    st.extendTurn(useEditor.getState().currentTurnId(), () => st.addTextBox("landed later"));
    // A continuation is not a new user action, so it must not discard the
    // redo the user still has available.
    expect(useEditor.getState().redoStack.length).toBe(1);
  });
});

describe("async AI landings do not fragment the undo history", () => {
  it("records no undo entry and leaves redo intact", () => {
    const st = useEditor.getState();
    // A user turn to sit on the stack, then an undo so redo has something.
    st.addTextBox("hello");
    expect(useEditor.getState().undoStack.length).toBe(1);
    st.undo();
    expect(useEditor.getState().redoStack.length).toBe(1);

    const before = {
      undo: useEditor.getState().undoStack.length,
      redo: useEditor.getState().redoStack.length,
    };
    // A late AI landing: applies, but must not touch either stack.
    let ran = false;
    st.runWithoutHistory(() => {
      ran = true;
      st.addTextBox("streamed in later");
    });
    expect(ran).toBe(true);
    const after = useEditor.getState();
    expect(after.undoStack.length).toBe(before.undo);
    expect(after.redoStack.length).toBe(before.redo);
    // The mutation itself still happened.
    expect((after.doc.pages[0] as unknown as { children: Node[] }).children.length).toBeGreaterThan(0);
  });

  it("restores history after the scope, even if the work throws", () => {
    const st = useEditor.getState();
    expect(() => st.runWithoutHistory(() => { throw new Error("boom"); })).toThrow();
    st.addTextBox("after");
    expect(useEditor.getState().undoStack.length).toBe(1);
  });

  it("nests safely: overlapping queues cannot re-enable history early", () => {
    const st = useEditor.getState();
    st.runWithoutHistory(() => {
      st.runWithoutHistory(() => st.addTextBox("inner"));
      // The inner scope closed; the outer one must still suppress.
      st.addTextBox("outer");
    });
    expect(useEditor.getState().undoStack.length).toBe(0);
  });
});
