// Whole-box restyles must keep an auto-height text box fitted to its content.
//
// The inline editor and the side-handle resize both re-fit height through the
// shared measurer, but the panel restyle paths (setTextStyle: font family,
// size, weight, spacing, line height; stepTextFontSize: the size shortcuts)
// used to mutate run styles and stop. The text then rewrapped to a different
// line count while size.height kept the old value, so the selection box
// covered three lines while five painted. These pin the re-fit and its undo.

import { beforeEach, describe, expect, it } from "vitest";
import { useEditor } from "./editor";
import { measuredTextHeight } from "@/lib/textFit";
import type { Node, TextNode } from "@hc/schema";

const LONG = "This is hands down the best tool our team has adopted this year";

function textNode(mode: "fixed" | "autoHeight"): Node {
  return {
    id: "txt", type: "text",
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: 200, height: 40 }, opacity: 1, blendMode: "normal",
    box: { mode, width: 200, height: 40 },
    content: [{
      runs: [{ text: LONG, style: { fontFamily: "system", fontStyle: "Regular", fontSize: 16 } }],
      style: { align: "left" },
    }],
  } as unknown as Node;
}

function node() {
  const st = useEditor.getState();
  return st.doc.pages[st.activePage].children.find((n) => n.id === "txt") as unknown as {
    size: { width: number; height: number };
    box: { mode: string; height: number };
    content: { runs: { style: { fontSize: number } }[] }[];
  };
}

function seed(mode: "fixed" | "autoHeight") {
  const st = useEditor.getState();
  const p = st.doc.pages[st.activePage];
  p.children.length = 0;
  p.children.push(textNode(mode));
  useEditor.setState({ selection: ["txt"], undoStack: [], redoStack: [], editingTextId: null });
}

beforeEach(() => seed("autoHeight"));

describe("setTextStyle on an auto-height box", () => {
  it("re-fits the box to the rewrapped content", () => {
    useEditor.getState().setTextStyle("txt", { fontSize: 32 });
    const n = node();
    const fitted = measuredTextHeight(n as unknown as TextNode);
    expect(n.size.height).toBe(fitted);
    expect(n.box.height).toBe(fitted);
    expect(n.size.height).toBeGreaterThan(40); // wraps to more, taller lines
  });

  it("restores the previous height on undo, in the same step as the style", () => {
    useEditor.getState().setTextStyle("txt", { fontSize: 32 });
    useEditor.getState().undo();
    const n = node();
    expect(n.size.height).toBe(40);
    expect(n.box.height).toBe(40);
    expect(n.content[0].runs[0].style.fontSize).toBe(16);
  });
});

describe("stepTextFontSize on an auto-height box", () => {
  it("re-fits the box as the shortcut steps the size", () => {
    useEditor.getState().stepTextFontSize("txt", 16); // 16 -> 32
    const n = node();
    expect(n.size.height).toBe(measuredTextHeight(n as unknown as TextNode));
    expect(n.size.height).toBeGreaterThan(40);
  });
});

describe("a fixed-height box clamps to its content", () => {
  // One rule everywhere: a box may never lie about containing its text. Fixed
  // boxes keep the user's chosen height as a FLOOR and grow past it only
  // while the content needs the room.
  it("grows when a restyle rewraps taller, and undo restores the old height", () => {
    seed("fixed");
    useEditor.getState().setTextStyle("txt", { fontSize: 32 });
    const n = node();
    expect(n.size.height).toBe(Math.max(40, measuredTextHeight(n as unknown as TextNode)));
    expect(n.size.height).toBeGreaterThan(40);
    useEditor.getState().undo();
    expect(node().size.height).toBe(40);
    expect(node().box.height).toBe(40);
  });

  it("never shrinks below the chosen height", () => {
    seed("fixed");
    const n = node();
    n.size.height = 400; // a deliberately roomy frame
    n.box.height = 400;
    useEditor.getState().setTextStyle("txt", { fontSize: 8 }); // content now tiny
    expect(node().size.height).toBe(400);
  });

  it("leaves an auto-fit frame alone (the font scales to fit instead)", () => {
    seed("fixed");
    (node().box as { autoFit?: { enabled: boolean; min: number; max: number } }).autoFit = { enabled: true, min: 8, max: 512 };
    useEditor.getState().setTextStyle("txt", { fontSize: 32 });
    expect(node().size.height).toBe(40);
  });
});

describe("typing into a fixed box (the inline editor's paths)", () => {
  it("setContent commits a height that contains the text, floored at the edit-start height", () => {
    seed("fixed");
    const st = useEditor.getState();
    const content = structuredClone((node() as unknown as { content: unknown }).content);
    st.setContent("txt", content as never, 120, 40); // measured 120, editing began at 40
    expect(node().size.height).toBe(120);
    expect(node().box.height).toBe(120);
    st.setContent("txt", content as never, 20, 40); // lines deleted: content below the floor
    expect(node().size.height).toBe(40);
  });

  it("growTextBoxLive tracks typing transiently with the same clamp", () => {
    seed("fixed");
    const st = useEditor.getState();
    st.growTextBoxLive("txt", 120, 40);
    expect(node().size.height).toBe(120);
    st.growTextBoxLive("txt", 20, 40);
    expect(node().size.height).toBe(40);
    expect(useEditor.getState().undoStack).toHaveLength(0); // live growth is not an undo step
  });
});

describe("content rewrites re-fit too", () => {
  it("setText (AI/plain-text replace) grows the box with the new text", () => {
    useEditor.getState().setText("txt", `${LONG} ${LONG}`);
    const n = node();
    expect(n.size.height).toBe(measuredTextHeight(n as unknown as TextNode));
    expect(n.size.height).toBeGreaterThan(40);
    useEditor.getState().undo();
    expect(node().size.height).toBe(40);
  });

  it("findReplace re-fits every changed box and undoes heights with the text", () => {
    useEditor.getState().findReplace("best", "absolutely most extraordinary");
    const n = node();
    expect(n.size.height).toBe(measuredTextHeight(n as unknown as TextNode));
    useEditor.getState().undo();
    expect(node().size.height).toBe(40);
  });

  it("applyDeckTexts (translation batch) re-fits the touched box", () => {
    useEditor.getState().applyDeckTexts([
      { ref: { kind: "run", nodeId: "txt", para: 0, run: 0 }, text: `${LONG} und dann noch ein deutlich laengerer uebersetzter Satz` },
    ]);
    const n = node();
    expect(n.size.height).toBe(measuredTextHeight(n as unknown as TextNode));
    expect(n.size.height).toBeGreaterThan(40);
    useEditor.getState().undo();
    expect(node().size.height).toBe(40);
  });
});

describe("brand font swap (applyBrandFixes)", () => {
  it("re-fits an auto-height box whose font was swapped", () => {
    // The node-env fallback measurer is family-blind, so this seeds a box
    // whose stored height is already stale (40 < the content's ~4 wrapped
    // lines) and asserts the swap snaps the box onto its content - the same
    // corrective the browser needs when the brand font wraps differently.
    useEditor.getState().applyBrandFixes([{ nodeId: "txt", fix: { kind: "swap_font", from: "system", to: "Inter" } }]);
    const n = node();
    expect(n.size.height).toBe(measuredTextHeight(n as unknown as TextNode));
    expect(n.size.height).toBeGreaterThan(40);
    useEditor.getState().undo();
    expect(node().size.height).toBe(40);
  });
});

describe("switching a box to auto-height", () => {
  it("snaps a drifted box back onto its content", () => {
    seed("fixed"); // stored height 40, from a document authored before the clamp
    useEditor.getState().setTextBoxMode("txt", "autoHeight");
    const n = node();
    expect(n.size.height).toBe(measuredTextHeight(n as unknown as TextNode));
    expect(n.size.height).toBeGreaterThan(40);
    useEditor.getState().undo();
    expect(node().size.height).toBe(40);
    expect(node().box.mode).toBe("fixed");
  });
});
