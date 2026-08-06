// Whole-deck text collection/apply (doc 28 FR-23, whole-deck translation and
// AI speaker notes). collectDeckTexts addresses every translatable string
// (text runs, sticky notes, page speaker notes) with a stable ref; then
// applyDeckTexts writes results back as ONE undo step, preserving styling
// boundaries and skipping locked or since-deleted targets.
import { describe, expect, it } from "vitest";
import type { DesignFile, Node } from "@hc/schema";
import { useEditor } from "./editor";

function textNode(id: string, runs: string[], locked = false): Node {
  return {
    id,
    type: "text",
    locked,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: 200, height: 50 },
    content: [{ runs: runs.map((t) => ({ text: t, style: { fontFamily: "system", fontStyle: "Regular", fontSize: 16 } })), style: { align: "left" } }],
  } as unknown as Node;
}

function sticky(id: string, text: string): Node {
  return {
    id,
    type: "sticky",
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: 160, height: 160 },
    text,
    fontScale: 1,
  } as unknown as Node;
}

function deck(): DesignFile {
  return {
    schemaVersion: 1,
    id: "d",
    title: "T",
    pages: [
      { id: "p1", width: 800, height: 600, notes: "hello notes", children: [textNode("t1", ["Hello ", "world"]), sticky("s1", "note me")] },
      { id: "p2", width: 800, height: 600, children: [textNode("t2", ["Second"]), textNode("tlocked", ["never"], true)] },
    ],
  } as unknown as DesignFile;
}

describe("collectDeckTexts / applyDeckTexts", () => {
  it("collects runs, stickies, and notes with stable refs; skips locked", () => {
    useEditor.getState().loadDoc(deck());
    const entries = useEditor.getState().collectDeckTexts();
    expect(entries.map((e) => e.text)).toEqual(["Hello ", "world", "note me", "hello notes", "Second"]);
    expect(entries.map((e) => e.ref.kind)).toEqual(["run", "run", "sticky", "notes", "run"]);
  });

  it("applies translations back to exact addresses as one undo step", () => {
    useEditor.getState().loadDoc(deck());
    const st = useEditor.getState();
    const entries = st.collectDeckTexts();
    st.applyDeckTexts(entries.map((e) => ({ ref: e.ref, text: `XX ${e.text}` })));

    const doc = useEditor.getState().doc;
    const t1 = doc.pages[0].children[0] as unknown as { content: { runs: { text: string }[] }[] };
    expect(t1.content[0].runs.map((r) => r.text)).toEqual(["XX Hello ", "XX world"]); // per-run: styles kept
    expect((doc.pages[0].children[1] as unknown as { text: string }).text).toBe("XX note me");
    expect((doc.pages[0] as unknown as { notes: string }).notes).toBe("XX hello notes");
    expect((doc.pages[1].children[0] as unknown as { content: { runs: { text: string }[] }[] }).content[0].runs[0].text).toBe("XX Second");
    // Locked node untouched.
    expect((doc.pages[1].children[1] as unknown as { content: { runs: { text: string }[] }[] }).content[0].runs[0].text).toBe("never");

    // ONE undo restores everything.
    useEditor.getState().undo();
    const back = useEditor.getState().doc;
    expect((back.pages[0].children[0] as unknown as { content: { runs: { text: string }[] }[] }).content[0].runs[0].text).toBe("Hello ");
    expect((back.pages[0] as unknown as { notes: string }).notes).toBe("hello notes");
    expect((back.pages[0].children[1] as unknown as { text: string }).text).toBe("note me");
  });

  it("skips refs that no longer resolve instead of failing the batch", () => {
    useEditor.getState().loadDoc(deck());
    const st = useEditor.getState();
    const entries = st.collectDeckTexts();
    // Simulate a node deleted between collect and apply.
    st.applyDeckTexts([
      { ref: { kind: "run", nodeId: "gone", para: 0, run: 0 }, text: "nope" },
      { ref: entries[0].ref, text: "Bonjour " },
    ]);
    const t1 = useEditor.getState().doc.pages[0].children[0] as unknown as { content: { runs: { text: string }[] }[] };
    expect(t1.content[0].runs[0].text).toBe("Bonjour ");
  });
});
