import { describe, expect, it } from "vitest";
import { createBlankDesign, createNode, type Node } from "@hc/schema";
import { collectPageColors, collectSelectionColors } from "./pageColors";

const rgb = (r: number, g: number, b: number, a = 1) => ({ srgb: { r, g, b, a } });
const shape = (id: string, color: { srgb: { r: number; g: number; b: number; a: number } }, extra: Record<string, unknown> = {}) =>
  createNode("shape", { id, fills: [{ type: "solid", color }], ...extra } as Partial<Node>);

describe("page colours", () => {
  it("lists the page's solid colours most used first, background included", () => {
    const doc = createBlankDesign({ title: "t", width: 800, height: 600 });
    const page = doc.pages[0];
    page.background = { type: "solid", color: rgb(1, 1, 1) };
    page.children.push(
      shape("a", rgb(1, 0, 0)),
      shape("b", rgb(1, 0, 0)),
      shape("b2", rgb(1, 0, 0)),
      shape("c", rgb(0, 0, 1), { stroke: { width: 2, fill: { type: "solid", color: rgb(0, 1, 0) } } }),
      createNode("group", { id: "g", children: [shape("d", rgb(0, 0, 1))] } as Partial<Node>),
      createNode("text", {
        id: "t",
        content: [{ runs: [{ text: "hi", style: { fill: { type: "solid", color: rgb(0, 0, 0) } } }], style: {} }],
      } as Partial<Node>),
    );
    expect(collectPageColors(page)).toEqual(["#ff0000", "#0000ff", "#000000", "#00ff00", "#ffffff"]);
  });

  it("skips gradients and fully transparent fills, and caps the list", () => {
    const doc = createBlankDesign({ title: "t", width: 800, height: 600 });
    const page = doc.pages[0];
    page.children.push(
      createNode("shape", { id: "grad", fills: [{ type: "linear", stops: [] }] } as unknown as Partial<Node>),
      shape("clear", rgb(0.5, 0.5, 0.5, 0)),
    );
    for (let i = 0; i < 20; i++) page.children.push(shape(`s${i}`, rgb(i / 20, 0, 0)));
    const out = collectPageColors(page, 8);
    expect(out).toHaveLength(8);
    expect(out).not.toContain("#808080");
  });

  it("reads a selection's colours in the order found", () => {
    expect(collectSelectionColors([shape("a", rgb(0, 0, 1)), shape("b", rgb(1, 1, 0))])).toEqual(["#0000ff", "#ffff00"]);
  });
});
