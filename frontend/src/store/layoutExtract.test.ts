// F28 T20 stage 1: extract a reusable layout set from a deck.
//
// Two proofs: (1) the fixture round-trip - a deck exported to PPTX by our own
// writer and re-imported still yields sensible layouts (title/content/picture
// roles survive the OOXML conversion, near-identical slides dedupe); (2) the
// store action installs the set, links the source pages, does it all in ONE
// undo step, and applying an extracted layout to a NEW page materializes its
// placeholders.

import { beforeEach, describe, expect, it } from "vitest";
import { createBlankDesign, createNode, type DesignFile, type Node, type Page } from "@hc/schema";
import { deckToPptx } from "@hc/export";
import { pptxToDesign } from "@hc/export";
import { extractLayoutSet, type ExtractPageLike } from "@hc/aistudio";
import { useEditor } from "./editor";

const PNG_STUB = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

function textNode(id: string, x: number, y: number, w: number, h: number, fontSize: number, text = "Hello"): Node {
  return createNode("text", {
    id,
    transform: { x, y, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: w, height: h },
    content: [{ runs: [{ text, style: { fontFamily: "Inter", fontStyle: "Regular", fontSize } }], style: { align: "left" } }],
  } as Partial<Node>);
}

function imageNode(id: string, x: number, y: number, w: number, h: number): Node {
  return createNode("image", {
    id,
    transform: { x, y, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: w, height: h },
    source: { assetId: "asset-1", naturalWidth: 640, naturalHeight: 480 },
    fit: "cover",
  } as Partial<Node>);
}

/** A 5-slide deck: 3 near-identical title+content slides, 1 title+picture, 1
 *  decoration-only slide. */
function sampleDeck(): DesignFile {
  const file = createBlankDesign({ title: "Extract me", width: 1280, height: 720 });
  file.assets.push({ id: "asset-1", kind: "image", name: "pic.png", url: "data:image/png;base64,iVBORw0KGgo=" } as never);
  const titleContent = (i: number): Page => ({
    ...structuredClone(file.pages[0]),
    id: `s-tc-${i}`,
    children: [
      textNode(`t${i}`, 80 + i, 60, 1100, 90, 40, `Slide ${i}`),
      textNode(`c${i}`, 80, 200, 1100, 420, 20, "Point one\nPoint two"),
    ],
  });
  const titlePicture: Page = {
    ...structuredClone(file.pages[0]),
    id: "s-pic",
    children: [textNode("tp", 80, 60, 1100, 90, 40, "Gallery"), imageNode("img1", 80, 200, 700, 420)],
  };
  const decorative: Page = {
    ...structuredClone(file.pages[0]),
    id: "s-dec",
    children: [
      createNode("shape", {
        id: "bar",
        shape: "rect",
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 1280, height: 40 },
        fills: [{ type: "solid", color: { srgb: { r: 0.2, g: 0.2, b: 0.2, a: 1 } } }],
      } as Partial<Node>),
    ],
  };
  file.pages = [titleContent(1), titleContent(2), titlePicture, titleContent(3), decorative];
  return file;
}

describe("T20 stage 1: PPTX fixture round-trip", () => {
  it("an exported deck re-imports and still extracts a sensible, deduped layout set", async () => {
    const bytes = await deckToPptx(sampleDeck(), {
      resolveImage: async () => ({ data: PNG_STUB, mime: "image/png" }),
    });
    const imported = await pptxToDesign(bytes, { title: "Back again" });
    expect(imported.pages).toHaveLength(5);

    const { layouts, assignments } = extractLayoutSet(imported.pages as unknown as ExtractPageLike[]);
    // 3 title+content slides collapse into one layout; title+picture is its own.
    expect(layouts).toHaveLength(2);
    expect(assignments).toEqual([0, 0, 1, 0, null]);
    expect(layouts[0].placeholders.map((p) => p.role)).toEqual(["title", "content"]);
    expect(layouts[1].placeholders.map((p) => p.role)).toEqual(["title", "picture"]);
    // Capacities derived from geometry (T11) survive the trip.
    expect(layouts[0].placeholders[1].maxChars).toBeGreaterThan(0);
  });
});

describe("T20 stage 1: store action", () => {
  beforeEach(() => {
    const st = useEditor.getState();
    const deck = sampleDeck();
    st.doc.pages = deck.pages as never;
    (st.doc as unknown as { layouts?: unknown[]; masters?: unknown[] }).layouts = undefined;
    (st.doc as unknown as { layouts?: unknown[]; masters?: unknown[] }).masters = undefined;
    useEditor.setState({ selection: [], undoStack: [], redoStack: [], editingTextId: null, activePage: 0 });
  });

  it("installs the set, links source pages, and undoes in one step", () => {
    const st = useEditor.getState();
    const result = st.extractLayoutsFromDeck();
    expect(result).toEqual({ created: 2, linked: 4 });
    const doc = useEditor.getState().doc as unknown as { layouts?: { id: string; name: string }[]; pages: { layoutId?: string }[] };
    expect(doc.layouts).toHaveLength(2);
    expect(doc.pages[0].layoutId).toBe(doc.layouts![0].id);
    expect(doc.pages[2].layoutId).toBe(doc.layouts![1].id);
    expect(doc.pages[4].layoutId).toBeUndefined(); // decoration-only page
    expect(useEditor.getState().undoStack.length).toBe(1);
    useEditor.getState().undo();
    const after = useEditor.getState().doc as unknown as { layouts?: unknown[]; pages: { layoutId?: string }[] };
    expect(after.layouts).toBeUndefined();
    expect(after.pages[0].layoutId).toBeUndefined();
  });

  it("never severs an existing layout link on re-extraction", () => {
    const st = useEditor.getState();
    st.extractLayoutsFromDeck();
    const firstId = (useEditor.getState().doc as unknown as { pages: { layoutId?: string }[] }).pages[0].layoutId;
    const again = st.extractLayoutsFromDeck();
    expect(again).toEqual({ created: 2, linked: 0 }); // all sources already linked
    expect((useEditor.getState().doc as unknown as { pages: { layoutId?: string }[] }).pages[0].layoutId).toBe(firstId);
  });

  it("applying an extracted layout to a new page materializes its placeholders", () => {
    const st = useEditor.getState();
    st.extractLayoutsFromDeck();
    const doc = useEditor.getState().doc as unknown as { layouts: { id: string }[] };
    st.addPage();
    const idx = useEditor.getState().doc.pages.length - 1;
    expect(st.applyLayoutToPage(doc.layouts[0].id, idx)).toBe(true);
    const page = useEditor.getState().doc.pages[idx] as unknown as { children: { type: string; data?: { placeholderId?: string } }[] };
    const slotted = page.children.filter((n) => n.data?.placeholderId);
    expect(slotted.length).toBeGreaterThanOrEqual(2); // title + content frames
  });
});
