// Centering on the page: one node lands at the page's middle on both axes in
// a single undo step; many nodes keep their arrangement and center as a box.

import { beforeEach, describe, expect, it } from "vitest";
import { createBlankDesign, createNode, type Node } from "@hc/schema";
import { useEditor } from "./editor";

function shape(id: string, x: number, y: number, w: number, h: number): Node {
  return createNode("shape", {
    id,
    transform: { x, y, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: w, height: h },
  } as Partial<Node>);
}

const at = (id: string) => {
  const n = useEditor.getState().doc.pages[0].children.find((c) => c.id === id) as unknown as { transform: { x: number; y: number } };
  return [n.transform.x, n.transform.y];
};

describe("alignSelection center", () => {
  beforeEach(() => {
    const doc = createBlankDesign({ title: "t", width: 800, height: 600 });
    doc.pages[0].children.push(shape("a", 10, 10, 100, 50), shape("b", 500, 400, 50, 50));
    useEditor.getState().loadDoc(doc);
  });

  it("centers one node on the page, undoable in one step", () => {
    const st = useEditor.getState();
    st.select(["a"]);
    st.alignSelection("center");
    expect(at("a")).toEqual([350, 275]);
    useEditor.getState().undo();
    expect(at("a")).toEqual([10, 10]);
  });

  it("centers many nodes on each other, as the single-axis edges do", () => {
    const st = useEditor.getState();
    st.select(["a", "b"]);
    st.alignSelection("center");
    // With many selected the target is the selection's own box (10..550 by
    // 10..450, centre 280, 230), so both land on that centre.
    expect(at("a")).toEqual([230, 205]);
    expect(at("b")).toEqual([255, 205]);
  });

  it("keeps the single-axis edges as before", () => {
    const st = useEditor.getState();
    st.select(["a"]);
    st.alignSelection("right");
    expect(at("a")).toEqual([700, 10]);
    st.alignSelection("bottom");
    expect(at("a")).toEqual([700, 550]);
  });
});
