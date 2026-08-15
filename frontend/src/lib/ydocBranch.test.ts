// Branch-bound DesignDoc guards (doc 16 FR-10). A branch doc binds the store
// to a DIFFERENT lineage than main, so it must never absorb the store's
// current (main) state while empty - its only legitimate seed is the branch's
// journaled lineage (applyJournalFrames) or room sync. Runs against the real
// editor store and real Y.Docs; no network or IndexedDB.
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import type { DesignFile, Node } from "@hc/schema";
import { fromDoc, reconcile } from "@hc/realtime";
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

/** A journaled-style y-protocols update frame (base64) carrying `file`'s full
 *  state, exactly what the server pages out of a branch lineage. */
function frameFor(file: DesignFile): string {
  const scratch = new Y.Doc();
  reconcile(file, scratch);
  const enc = encoding.createEncoder();
  syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(scratch));
  scratch.destroy();
  const bytes = encoding.toUint8Array(enc);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

let live: DesignDoc | null = null;

afterEach(() => {
  live?.dispose();
  live = null;
});

describe("branch-bound DesignDoc", () => {
  it("never seeds from the store while empty (main state must not leak in)", () => {
    // The store holds MAIN state at switch time.
    useEditor.getState().loadDoc(fileWith([rect("main-node")]));
    live = new DesignDoc("test-branch-guard", "branch-1");

    // A rev bump while the branch doc is empty (an edit racing the seed, or the
    // switch-time load) must NOT reconcile main state into the branch doc.
    const doc = useEditor.getState().doc;
    doc.pages[0].children.push(rect("raced-edit"));
    useEditor.setState((s) => ({ rev: s.rev + 1 }));
    expect(live.hasState).toBe(false);

    // A document swap while empty is equally blocked.
    useEditor.getState().loadDoc(fileWith([rect("swapped")]));
    expect(live.hasState).toBe(false);

    // seedIfEmpty (the local-doc fallback) is refused too.
    live.seedIfEmpty(fileWith([rect("seed-attempt")]));
    expect(live.hasState).toBe(false);
  });

  it("seeds from journaled lineage frames and rebuilds the store", () => {
    useEditor.getState().loadDoc(fileWith([rect("main-node")]));
    live = new DesignDoc("test-branch-seed", "branch-2");

    const branchState = fileWith([rect("branch-a"), rect("branch-b")]);
    live.applyJournalFrames([frameFor(branchState)]);

    // The branch doc holds the lineage state...
    expect(live.hasState).toBe(true);
    expect((fromDoc(live.ydoc).pages[0].children as Node[]).map((n) => n.id)).toEqual(["branch-a", "branch-b"]);
    // ...and the store rebuilt from it (REMOTE origin -> Y->Local observer).
    expect((useEditor.getState().doc.pages[0].children as Node[]).map((n) => n.id)).toEqual(["branch-a", "branch-b"]);
    // The seed is not undoable (nothing on the collab undo stack).
    expect(useEditor.getState().collabUndo?.canUndo()).toBe(false);
  });

  it("edits after the journal seed reconcile into the branch doc normally", () => {
    useEditor.getState().loadDoc(fileWith([rect("main-node")]));
    live = new DesignDoc("test-branch-edit", "branch-3");
    live.applyJournalFrames([frameFor(fileWith([rect("base")]))]);

    const doc = useEditor.getState().doc;
    doc.pages[0].children.push(rect("on-branch"));
    useEditor.setState((s) => ({ rev: s.rev + 1 }));

    expect((fromDoc(live.ydoc).pages[0].children as Node[]).map((n) => n.id)).toEqual(["base", "on-branch"]);
    // The post-seed edit is a normal undoable step.
    expect(useEditor.getState().collabUndo?.canUndo()).toBe(true);
  });

  it("switching branch -> main never grafts branch state onto main", () => {
    // Live on a branch: the branch's state becomes the store's document.
    useEditor.getState().loadDoc(fileWith([rect("main-node")]));
    const onBranch = new DesignDoc("test-switch-back", "branch-4");
    onBranch.applyJournalFrames([frameFor(fileWith([rect("branch-only")]))]);
    expect((useEditor.getState().doc.pages[0].children as Node[]).map((n) => n.id)).toEqual(["branch-only"]);
    onBranch.dispose();

    // Switch back to main. The store still holds BRANCH state until main's room
    // syncs, so an edit in that window must not seed main's room with it.
    live = new DesignDoc("test-switch-back");
    const doc = useEditor.getState().doc;
    doc.pages[0].children.push(rect("raced-after-switch"));
    useEditor.setState((s) => ({ rev: s.rev + 1 }));
    expect(live.hasState).toBe(false);

    // Main's authoritative state arrives and wins outright: no branch content,
    // no duplicate pages.
    live.applyJournalFrames([frameFor(fileWith([rect("main-node")]))]);
    expect((fromDoc(live.ydoc).pages[0].children as Node[]).map((n) => n.id)).toEqual(["main-node"]);
  });

  it("adoptStore releases the guard so a switched-back main room still takes edits", () => {
    // The binder reloads main's own document after a switch-back and calls
    // adoptStore. Without that release the guard never lifts for a main room
    // with no peer, no journal and no local state, and every edit is dropped.
    useEditor.getState().loadDoc(fileWith([rect("main-node")]));
    const onBranch = new DesignDoc("test-adopt", "branch-9");
    onBranch.applyJournalFrames([frameFor(fileWith([rect("branch-only")]))]);
    onBranch.dispose();

    live = new DesignDoc("test-adopt");
    // Still foreign: the store holds branch content, so edits must not seed.
    useEditor.getState().doc.pages[0].children.push(rect("dropped"));
    useEditor.setState((s) => ({ rev: s.rev + 1 }));
    expect(live.hasState).toBe(false);

    // The binder loads main's persisted file and adopts it.
    useEditor.getState().loadDoc(fileWith([rect("main-node")]));
    live.adoptStore();
    useEditor.getState().doc.pages[0].children.push(rect("kept"));
    useEditor.setState((s) => ({ rev: s.rev + 1 }));

    expect(live.hasState).toBe(true);
    const ids = (fromDoc(live.ydoc).pages[0].children as Node[]).map((n) => n.id);
    expect(ids).toEqual(["main-node", "kept"]); // no branch content, edit kept
  });

  it("a main doc (no branch) still seeds from the store as before", () => {
    useEditor.getState().loadDoc(fileWith([rect("n1")]));
    live = new DesignDoc("test-main-regression");
    const doc = useEditor.getState().doc;
    doc.pages[0].children.push(rect("n2"));
    useEditor.setState((s) => ({ rev: s.rev + 1 }));
    expect((fromDoc(live.ydoc).pages[0].children as Node[]).map((n) => n.id)).toEqual(["n1", "n2"]);
  });
});

describe("page-granular incremental projection (FR-2/FR-7 at scale)", () => {
  it("a remote edit to one page reuses every other page object by identity", () => {
    useEditor.getState().loadDoc(fileWith([rect("n1")]));
    live = new DesignDoc("test-incremental");
    // Seed a 3-page doc through the doc (remote-style), so the store's doc is
    // the projected file the bridge tracks.
    const three = {
      ...fileWith([rect("n1")]),
      pages: ["p1", "p2", "p3"].map((id) => ({ id, width: 800, height: 600, children: [rect(`${id}-a`)] })),
    } as unknown as DesignFile;
    live.applyJournalFrames([frameFor(three)]);
    const before = useEditor.getState().doc;
    expect(before.pages.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);

    // A remote peer edits ONLY p2: apply a remote-origin update built from a
    // second doc that shares the same CRDT identity space.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(live.ydoc));
    const peerFile = fromDoc(peer) as DesignFile;
    (peerFile.pages[1].children as Node[]).push(rect("p2-new"));
    reconcile(peerFile, peer);
    const delta = Y.encodeStateAsUpdate(peer, Y.encodeStateVector(live.ydoc));
    live.applyUpdate(delta);

    const after = useEditor.getState().doc;
    expect(after).not.toBe(before);
    expect((after.pages[1].children as Node[]).map((n) => n.id)).toEqual(["p2-a", "p2-new"]);
    // Untouched pages are the SAME objects (zero re-projection cost).
    expect(after.pages[0]).toBe(before.pages[0]);
    expect(after.pages[2]).toBe(before.pages[2]);
    expect(after.pages[1]).not.toBe(before.pages[1]);
  });

  it("a loadDoc swap disables reuse until the next projection", () => {
    useEditor.getState().loadDoc(fileWith([rect("n1")]));
    live = new DesignDoc("test-incremental-swap");
    live.applyJournalFrames([frameFor(fileWith([rect("base")]))]);
    // Swap the store doc (e.g. exit-preview resync): identity chain broken.
    useEditor.getState().loadDoc(structuredClone(useEditor.getState().doc));
    const swapped = useEditor.getState().doc;

    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(live.ydoc));
    const peerFile = fromDoc(peer) as DesignFile;
    (peerFile.pages[0].children as Node[]).push(rect("later"));
    reconcile(peerFile, peer);
    live.applyUpdate(Y.encodeStateAsUpdate(peer, Y.encodeStateVector(live.ydoc)));

    const after = useEditor.getState().doc;
    // Full rebuild: fresh objects, correct content, no stale-reuse corruption.
    expect(after).not.toBe(swapped);
    expect((after.pages[0].children as Node[]).map((n) => n.id)).toEqual(["base", "later"]);
  });
});
