// @vitest-environment jsdom

// The layer panel's reordering: a drop lands the dragged layer directly in
// front of the row it lands on whichever way it travelled (it used to land one
// slot too far back when dragged down the list), the zone under the last row
// sends to the back, and every row has a step forward and a step back.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createBlankDesign, createNode, type Node } from "@hc/schema";
import { useEditor } from "@/store/editor";

vi.mock("@/lib/i18n", () => ({ tr: (k: string) => k }));

const { LayerPanel } = await import("./LayerPanel");

function shape(id: string): Node {
  return createNode("shape", { id, name: id.toUpperCase(), transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 10, height: 10 } } as Partial<Node>);
}

const order = () => useEditor.getState().doc.pages[0].children.map((n) => n.id);
const rows = () => screen.getAllByRole("treeitem");
const row = (name: string) => rows().find((r) => within(r).queryByText(name))!;

beforeEach(() => {
  cleanup();
  const doc = createBlankDesign({ title: "t", width: 800, height: 600 });
  doc.pages[0].children.push(shape("a"), shape("b"), shape("c"));
  useEditor.getState().loadDoc(doc);
});

describe("the layer panel", () => {
  it("lists the front layer first", () => {
    render(<LayerPanel />);
    expect(rows().map((r) => r.textContent?.slice(0, 6))).toEqual(["shapeC", "shapeB", "shapeA"]);
  });

  it("drops a layer directly in front of the row it lands on, both ways", () => {
    render(<LayerPanel />);
    // c (front) dragged down onto a: between b and a, so a, c, b.
    fireEvent.dragStart(row("C"));
    fireEvent.dragOver(row("A"));
    fireEvent.drop(row("A"));
    expect(order()).toEqual(["a", "c", "b"]);
    // a (back) dragged up onto c: in front of c, behind b.
    fireEvent.dragStart(row("A"));
    fireEvent.dragOver(row("C"));
    fireEvent.drop(row("C"));
    expect(order()).toEqual(["c", "a", "b"]);
    // b dragged onto the top row lands at the front.
    fireEvent.dragStart(row("B"));
    fireEvent.dragOver(row("A"));
    fireEvent.drop(row("A"));
    expect(order()).toEqual(["c", "a", "b"].filter((id) => id !== "b").concat("b"));
  });

  it("offers a zone past the last row that sends the layer to the back", () => {
    render(<LayerPanel />);
    expect(screen.queryByTestId("layer-drop-back")).toBeNull();
    fireEvent.dragStart(row("C"));
    const zone = screen.getByTestId("layer-drop-back");
    fireEvent.dragOver(zone);
    fireEvent.drop(zone);
    expect(order()).toEqual(["c", "a", "b"]);
  });

  it("steps a layer forward and back from its row, with the ends disabled", () => {
    render(<LayerPanel />);
    const b = row("B");
    fireEvent.click(within(b).getByRole("button", { name: "editor.bring_forward" }));
    expect(order()).toEqual(["a", "c", "b"]);
    fireEvent.click(within(row("B")).getByRole("button", { name: "editor.send_backward" }));
    expect(order()).toEqual(["a", "b", "c"]);
    expect((within(row("C")).getByRole("button", { name: "editor.bring_forward" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(row("A")).getByRole("button", { name: "editor.send_backward" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("moves the focused layer with Alt and the arrow keys", () => {
    render(<LayerPanel />);
    const a = row("A");
    a.focus();
    fireEvent.keyDown(a, { key: "ArrowUp", altKey: true });
    expect(order()).toEqual(["b", "a", "c"]);
  });
});

describe("layers inside a group", () => {
  beforeEach(() => {
    cleanup();
    const doc = createBlankDesign({ title: "t", width: 800, height: 600 });
    const g = createNode("group", { id: "g", name: "Group", children: [shape("x"), shape("y")] } as Partial<Node>);
    doc.pages[0].children.push(shape("a"), g);
    useEditor.getState().loadDoc(doc);
  });
  const inGroup = () => ((useEditor.getState().doc.pages[0].children.find((n) => n.id === "g") as unknown as { children: Node[] }).children).map((n) => n.id);

  it("opens a group to list its children indented, and closes it again", () => {
    render(<LayerPanel />);
    expect(rows().map((r) => r.textContent?.includes("X"))).toEqual([false, false]);
    fireEvent.click(within(row("Group")).getByRole("button", { name: "editor.expand" }));
    expect(rows()).toHaveLength(4);
    expect(row("Y").getAttribute("aria-level")).toBe("2");
    fireEvent.click(within(row("Group")).getByRole("button", { name: "editor.collapse" }));
    expect(rows()).toHaveLength(2);
  });

  it("restacks a child among the group's children, never the page's", () => {
    render(<LayerPanel />);
    fireEvent.click(within(row("Group")).getByRole("button", { name: "editor.expand" }));
    fireEvent.click(within(row("X")).getByRole("button", { name: "editor.bring_forward" }));
    expect(inGroup()).toEqual(["y", "x"]);
    expect(order()).toEqual(["a", "g"]);
    // Dragging a child onto its sibling restacks inside the group.
    fireEvent.dragStart(row("Y"));
    fireEvent.dragOver(row("X"));
    fireEvent.drop(row("X"));
    expect(inGroup()).toEqual(["x", "y"]);
    // Dragging a child onto a top-level row is not a restack and changes nothing.
    fireEvent.dragStart(row("Y"));
    fireEvent.dragOver(row("A"));
    fireEvent.drop(row("A"));
    expect(inGroup()).toEqual(["x", "y"]);
    expect(order()).toEqual(["a", "g"]);
  });

  it("offers the back zone for a top-level layer only", () => {
    render(<LayerPanel />);
    fireEvent.click(within(row("Group")).getByRole("button", { name: "editor.expand" }));
    fireEvent.dragStart(row("Y"));
    expect(screen.queryByTestId("layer-drop-back")).toBeNull();
    fireEvent.dragEnd(row("Y"));
    fireEvent.dragStart(row("Group"));
    expect(screen.getByTestId("layer-drop-back")).toBeTruthy();
  });
});
