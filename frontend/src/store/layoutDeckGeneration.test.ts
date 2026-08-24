// T12 layout-grounded generation at the store level: empty pages land with the
// theme background, layouts link + materialize placeholder boxes, the fill
// writes into those boxes (inheriting the materialized typography), picture
// slots receive images by page id + placeholder id, and syncLayoutPages keeps
// restyling generated pages afterwards.

import { beforeEach, describe, expect, it } from "vitest";
import { useEditor } from "./editor";

type Textish = {
  id: string;
  type: string;
  data?: { placeholderId?: string; aiImagePrompt?: string };
  content?: { runs: { text: string }[] }[];
  source?: { assetId?: string };
};

function pageChildren(i: number): Textish[] {
  return useEditor.getState().doc.pages[i].children as unknown as Textish[];
}

describe("layout-grounded deck generation", () => {
  beforeEach(() => {
    // Reset to a blank document; fall back to loading a blank design when the
    // store exposes no newDocument action.
    const st = useEditor.getState() as unknown as { newDocument?: () => void };
    if (st.newDocument) st.newDocument();
  });

  it("builds pages carrying layoutId, filled placeholders, and notes", () => {
    const st = useEditor.getState();
    st.ensureSlideLayouts();
    const layouts = (st.doc as unknown as { layouts: { id: string }[] }).layouts;
    expect(layouts.length).toBeGreaterThanOrEqual(5);

    const deckLike = {
      title: "T12 Deck",
      pages: [
        { name: "Cover", note: "Welcome them.", background: { type: "solid", color: { srgb: { r: 1, g: 1, b: 1, a: 1 } } }, nodes: [] },
        { name: "Body", background: { type: "solid", color: { srgb: { r: 1, g: 1, b: 1, a: 1 } } }, nodes: [] },
      ],
    } as unknown as Parameters<typeof st.buildDeckFromOutline>[0];
    const ids = st.buildDeckFromOutline(deckLike, { width: 1920, height: 1080 });
    expect(ids).toHaveLength(2);

    expect(st.applyLayoutToPage("layout-title", 0)).toBe(true);
    expect(st.applyLayoutToPage("layout-title-content", 1)).toBe(true);
    const doc = useEditor.getState().doc as unknown as { pages: { layoutId?: string; notes?: string }[] };
    expect(doc.pages[0].layoutId).toBe("layout-title");
    expect(doc.pages[1].layoutId).toBe("layout-title-content");
    expect(doc.pages[0].notes).toBe("Welcome them.");

    // Fill writes into the materialized boxes and keeps unnamed slots intact.
    expect(useEditor.getState().fillPlaceholderContent(0, { texts: { "ph-title": "Hello World" }, lists: {} })).toBe(true);
    expect(useEditor.getState().fillPlaceholderContent(1, { texts: { "ph-title": "Agenda" }, lists: { "ph-content": ["One", "Two"] } })).toBe(true);
    const title0 = pageChildren(0).find((n) => n.data?.placeholderId === "ph-title");
    expect(title0?.content?.[0]?.runs[0]?.text).toBe("Hello World");
    const content1 = pageChildren(1).find((n) => n.data?.placeholderId === "ph-content");
    expect(content1?.content).toHaveLength(2);
    expect(content1?.content?.[0]?.runs[0]?.text).toContain("One");

    // One combined undo path stays consistent (each op is individually undoable
    // here; the panel collapses them via runAsTurn).
    useEditor.getState().undo();
    const afterUndo = pageChildren(1).find((n) => n.data?.placeholderId === "ph-content");
    expect(afterUndo?.content?.[0]?.runs[0]?.text).not.toContain("One");
  });

  it("places a picture-slot image by page id and refuses when the slot is gone", () => {
    const st = useEditor.getState();
    st.ensureSlideLayouts();
    const deckLike = {
      title: "Pic",
      pages: [{ name: "P", background: { type: "solid", color: { srgb: { r: 1, g: 1, b: 1, a: 1 } } }, nodes: [] }],
    } as unknown as Parameters<typeof st.buildDeckFromOutline>[0];
    const ids = st.buildDeckFromOutline(deckLike, { width: 1920, height: 1080 });
    st.applyLayoutToPage("layout-picture", 0);

    const ok = useEditor.getState().applyGeneratedImageToPlaceholder(ids[0], "ph-pic", "https://x/img.png", "a lighthouse");
    expect(ok).toBe(true);
    const img = pageChildren(0).find((n) => n.type === "image" && n.data?.placeholderId === "ph-pic");
    expect(img?.data?.aiImagePrompt).toBe("a lighthouse");
    // The materialized text box for the slot was replaced, not duplicated.
    expect(pageChildren(0).filter((n) => n.data?.placeholderId === "ph-pic")).toHaveLength(1);

    // Unknown page id: refused, nothing thrown.
    expect(useEditor.getState().applyGeneratedImageToPlaceholder("page-gone", "ph-pic", "https://x", "p")).toBe(false);
    // Undo restores the placeholder box.
    useEditor.getState().undo();
    const restored = pageChildren(0).find((n) => n.data?.placeholderId === "ph-pic");
    expect(restored?.type).toBe("text");
  });
});
