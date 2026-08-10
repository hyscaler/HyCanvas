// Keyboard resize (F38): growSelection changes the selection's size by a
// delta, clamps at 1px, skips locked nodes, and is undoable as one step.

import { describe, it, expect, beforeEach } from "vitest";
import { createBlankDesign, createNode, type Node } from "@hc/schema";
import { useEditor } from "./editor";

function loadDocWith(nodes: Node[]) {
  const doc = createBlankDesign({ title: "t", width: 800, height: 600 });
  doc.pages[0].children.push(...nodes);
  useEditor.getState().loadDoc(doc);
}

function shape(id: string, w: number, h: number, extra: Partial<Node> = {}): Node {
  return createNode("shape", {
    id,
    transform: { x: 10, y: 10, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: w, height: h },
    ...extra,
  } as Partial<Node>);
}

const node = (id: string) =>
  useEditor.getState().doc.pages[0].children.find((n) => n.id === id) as unknown as {
    size: { width: number; height: number };
    transform: { x: number; y: number };
  };

describe("growSelection", () => {
  beforeEach(() => loadDocWith([shape("a", 100, 50)]));

  it("grows and shrinks the selected node's size without moving it", () => {
    useEditor.getState().select(["a"]);
    useEditor.getState().growSelection(10, 4);
    expect(node("a").size).toEqual({ width: 110, height: 54 });
    expect(node("a").transform.x).toBe(10);
    useEditor.getState().growSelection(-10, -4);
    expect(node("a").size).toEqual({ width: 100, height: 50 });
  });

  it("clamps at 1px instead of inverting", () => {
    useEditor.getState().select(["a"]);
    useEditor.getState().growSelection(-500, -500);
    expect(node("a").size).toEqual({ width: 1, height: 1 });
  });

  it("skips locked nodes", () => {
    loadDocWith([shape("a", 100, 50), shape("b", 100, 50, { locked: true } as Partial<Node>)]);
    useEditor.getState().select(["a", "b"]);
    useEditor.getState().growSelection(10, 10);
    expect(node("a").size.width).toBe(110);
    expect(node("b").size.width).toBe(100);
  });

  it("undoes as a single step", () => {
    useEditor.getState().select(["a"]);
    useEditor.getState().growSelection(10, 10);
    useEditor.getState().undo();
    expect(node("a").size).toEqual({ width: 100, height: 50 });
  });
});

it("undoes a MIXED-type multi-selection resize as one step", () => {
  const text = createNode("text", {
    id: "t",
    transform: { x: 200, y: 10, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: 200, height: 60 },
    box: { mode: "fixed", width: 200, height: 60, autoFit: { enabled: false, min: 8, max: 512 }, verticalAlign: "top" },
    content: [{ runs: [{ text: "hi", style: { fontFamily: "system", fontSize: 20, fill: { type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } } } }] }],
  } as Partial<Node>);
  loadDocWith([shape("a", 100, 50), text]);
  useEditor.getState().select(["a", "t"]);
  useEditor.getState().growSelection(10, 10);
  expect(node("a").size.width).toBe(110);
  expect(node("t").size.width).toBe(210);
  useEditor.getState().undo();
  expect(node("a").size.width).toBe(100);
  expect(node("t").size.width).toBe(200);
});

it("rotateSelection turns about the node center as one undoable step", () => {
  loadDocWith([shape("a", 100, 50)]);
  useEditor.getState().select(["a"]);
  const cx0 = node("a").transform.x + 50; // unrotated center x
  useEditor.getState().rotateSelection(15);
  const n = useEditor.getState().doc.pages[0].children[0] as unknown as { transform: { rotation: number; x: number } };
  expect(n.transform.rotation).toBe(15);
  // Rotating about the CENTER moves the top-left anchor; a raw rotation
  // write would have left x untouched (pivoting about the corner instead).
  expect(n.transform.x).not.toBe(10);
  void cx0;
  useEditor.getState().undo();
  expect(node("a").transform.x).toBe(10);
  expect((node("a") as unknown as { transform: { rotation: number } }).transform.rotation).toBe(0);
});
