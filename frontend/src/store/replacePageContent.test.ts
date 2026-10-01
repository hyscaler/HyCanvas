// Per-slide regeneration of a composed deck lands by replacing one page's
// content in place: the page keeps its id and every field the replacement
// does not name, the children array stays the same array, and the whole
// change is one undo step that also restores the page's note and data.
import { beforeEach, describe, expect, it } from "vitest";
import { createNode, type Node } from "@hc/schema";
import { useEditor } from "./editor";

function seed() {
  const st = useEditor.getState();
  const doc = st.doc;
  doc.pages.splice(1);
  (doc.pages[0] as unknown as { children: Node[] }).children.length = 0;
  delete (doc.pages[0] as unknown as { notes?: string }).notes;
  delete (doc.pages[0] as unknown as { data?: unknown }).data;
  useEditor.setState({ activePage: 0, selection: [], undoStack: [], redoStack: [] });
}

beforeEach(seed);

const textNode = (name: string, text: string): Node =>
  createNode("text", {
    name,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: 400, height: 60 },
    content: [{ runs: [{ text, style: { fontFamily: "system", fontStyle: "Regular", fontSize: 24, fill: { type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } } } }], style: { align: "left", direction: "auto" } }],
  } as never) as Node;

const texts = (): string[] =>
  (useEditor.getState().doc.pages[0] as unknown as { children: { content?: { runs: { text: string }[] }[] }[] }).children
    .flatMap((n) => (n.content ?? []).flatMap((p) => p.runs.map((r) => r.text)));

describe("replacePageContent", () => {
  it("replaces the content in place, keeps the page's identity and other fields, and is one undo", () => {
    const st = useEditor.getState();
    st.addTextBox("the old copy");
    const page = st.doc.pages[0] as unknown as { id: string; children: Node[]; notes?: string; data?: Record<string, unknown>; hidden?: boolean };
    page.data = { keep: 1 };
    page.hidden = true;
    const id = page.id;
    const kids = page.children;
    const entries = useEditor.getState().undoStack.length;

    expect(st.replacePageContent(0, { children: [textNode("Title", "the new title"), textNode("Text", "the new line")], notes: "say it slowly", data: { aiOutline: { title: "the new title" } } })).toBe(true);
    const live = useEditor.getState().doc.pages[0] as unknown as typeof page;
    expect(live.id).toBe(id);
    expect(live.children).toBe(kids);
    expect(texts()).toEqual(["the new title", "the new line"]);
    expect(live.notes).toBe("say it slowly");
    expect(live.data).toEqual({ keep: 1, aiOutline: { title: "the new title" } });
    expect(live.hidden).toBe(true);
    expect(useEditor.getState().undoStack.length).toBe(entries + 1);

    st.undo();
    expect(texts()).toEqual(["the old copy"]);
    expect((useEditor.getState().doc.pages[0] as unknown as typeof page).notes).toBeUndefined();
    expect((useEditor.getState().doc.pages[0] as unknown as typeof page).data).toEqual({ keep: 1 });
    st.redo();
    expect(texts()).toEqual(["the new title", "the new line"]);
    expect((useEditor.getState().doc.pages[0] as unknown as typeof page).notes).toBe("say it slowly");
  });

  it("lists an asset the new content needs once, and drops it again on undo", () => {
    const st = useEditor.getState();
    const ref = { id: "logo-asset", kind: "image" as const, url: "https://example.test/logo.png", mime: "image/*", checksum: "" };
    st.replacePageContent(0, { children: [textNode("Title", "one")], assets: [ref] });
    expect(useEditor.getState().doc.assets.filter((a) => a.id === ref.id)).toHaveLength(1);
    st.replacePageContent(0, { children: [textNode("Title", "two")], assets: [ref] });
    expect(useEditor.getState().doc.assets.filter((a) => a.id === ref.id)).toHaveLength(1);
    st.undo();
    expect(useEditor.getState().doc.assets.filter((a) => a.id === ref.id)).toHaveLength(1);
    st.undo();
    expect(useEditor.getState().doc.assets.filter((a) => a.id === ref.id)).toHaveLength(0);
  });

  it("refuses a page that does not exist", () => {
    expect(useEditor.getState().replacePageContent(4, { children: [] })).toBe(false);
  });
});
