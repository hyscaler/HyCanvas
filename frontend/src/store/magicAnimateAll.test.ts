// C05: bulk magic-animate across every slide, one undo turn, hand-authored
// builds skipped by default.

import { beforeEach, describe, expect, it } from "vitest";
import type { Node } from "@hc/schema";
import { useEditor } from "./editor";

function textNode(id: string): Node {
  return {
    id, type: "text",
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: 100, height: 20 }, opacity: 1, blendMode: "normal",
    content: [{ runs: [{ text: "x", style: { fontFamily: "system", fontStyle: "Regular", fontSize: 16 } }], style: { align: "left" } }],
  } as unknown as Node;
}

beforeEach(() => {
  const st = useEditor.getState();
  const p0 = st.doc.pages[0];
  p0.children = [textNode("a1")] as never;
  const p1 = structuredClone(p0);
  p1.id = "pg2";
  p1.children = [textNode("b1")] as never;
  (p1.children[0] as unknown as { animation?: unknown }).animation = { entrance: { preset: "fade", durationMs: 300, delayMs: 0, easing: "ease-out" } };
  const p2 = structuredClone(p0);
  p2.id = "pg3";
  p2.children = [textNode("c1")] as never;
  st.doc.pages = [p0, p1, p2] as never;
  useEditor.setState({ selection: [], undoStack: [], redoStack: [], editingTextId: null, activePage: 0 });
});

describe("magicAnimateAllPages (C05)", () => {
  const anim = (pi: number) => (useEditor.getState().doc.pages[pi].children[0] as unknown as { animation?: unknown }).animation;

  it("animates every slide without builds, skips hand-authored ones, one undo turn", () => {
    const n = useEditor.getState().magicAnimateAllPages();
    expect(n).toBe(2); // pages 1 and 3; page 2 already had a build
    expect(anim(0)).toBeTruthy();
    expect((anim(1) as { entrance: { preset: string } }).entrance.preset).toBe("fade"); // untouched
    expect(anim(2)).toBeTruthy();
    expect(useEditor.getState().undoStack.length).toBe(1); // collapsed turn
    useEditor.getState().undo();
    expect(anim(0)).toBeUndefined();
    expect(anim(2)).toBeUndefined();
  });

  it("replaceExisting overrides hand-authored builds", () => {
    const n = useEditor.getState().magicAnimateAllPages(true);
    expect(n).toBe(3);
    expect((anim(1) as { entrance: { preset: string } }).entrance.preset).toBe("rise"); // text preset replaced fade
  });
});
