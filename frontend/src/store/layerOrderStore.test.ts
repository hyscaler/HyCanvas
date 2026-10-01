// Restacking inside a group: reorderLayer and the z-order commands move a
// node among its own siblings, whether those are the page's layers or a
// group's children, and a selection across containers restacks within each.

import { beforeEach, describe, expect, it } from "vitest";
import { createBlankDesign, createNode, type Node } from "@hc/schema";
import { useEditor } from "./editor";

function shape(id: string): Node {
  return createNode("shape", { id, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 10, height: 10 } } as Partial<Node>);
}

const top = () => useEditor.getState().doc.pages[0].children.map((n) => n.id);
const inGroup = () => ((useEditor.getState().doc.pages[0].children.find((n) => n.id === "g") as unknown as { children: Node[] }).children).map((n) => n.id);

beforeEach(() => {
  const doc = createBlankDesign({ title: "t", width: 800, height: 600 });
  const g = createNode("group", { id: "g", children: [shape("x"), shape("y"), shape("z")] } as Partial<Node>);
  doc.pages[0].children.push(shape("a"), g, shape("b"));
  useEditor.getState().loadDoc(doc);
});

describe("z-order inside a group", () => {
  it("reorderLayer moves a grouped node among the group's children, undoably", () => {
    useEditor.getState().reorderLayer("x", 2);
    expect(inGroup()).toEqual(["y", "z", "x"]);
    expect(top()).toEqual(["a", "g", "b"]);
    useEditor.getState().undo();
    expect(inGroup()).toEqual(["x", "y", "z"]);
  });

  it("bring forward and send backward act within the group", () => {
    const st = useEditor.getState();
    st.select(["x"]);
    st.orderSelection("forward");
    expect(inGroup()).toEqual(["y", "x", "z"]);
    st.orderSelection("front");
    expect(inGroup()).toEqual(["y", "z", "x"]);
    st.orderSelection("back");
    expect(inGroup()).toEqual(["x", "y", "z"]);
    expect(top()).toEqual(["a", "g", "b"]);
  });

  it("a selection across containers restacks within each, as one undo step", () => {
    const st = useEditor.getState();
    st.select(["a", "x"]);
    st.orderSelection("front");
    expect(top()).toEqual(["g", "b", "a"]);
    expect(inGroup()).toEqual(["y", "z", "x"]);
    useEditor.getState().undo();
    expect(top()).toEqual(["a", "g", "b"]);
    expect(inGroup()).toEqual(["x", "y", "z"]);
  });
});
