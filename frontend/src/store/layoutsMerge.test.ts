// Slide layouts (doc 28 FR-3/FR-4, materialization model) and bulk data-merge
// into slides. Layouts: capture a page's background + text placeholders, apply
// to pages (idempotent via placeholder tags), update from a page, and sync to
// every linked page. Merge: one page per CSV row with {{token}} substitution.
import { describe, expect, it } from "vitest";
import type { DesignFile, Node } from "@hc/schema";
import { useEditor } from "./editor";

function textNode(id: string, text: string, size = 20, x = 40, y = 40): Node {
  return {
    id,
    type: "text",
    transform: { x, y, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: 400, height: 60 },
    content: [{ runs: [{ text, style: { fontFamily: "system", fontStyle: "Regular", fontSize: size } }], style: { align: "left" } }],
  } as unknown as Node;
}

function deck(): DesignFile {
  return {
    schemaVersion: 1,
    id: "d",
    title: "Deck",
    pages: [
      {
        id: "p1",
        width: 1280,
        height: 720,
        background: { type: "solid", color: { srgb: { r: 0.1, g: 0.2, b: 0.3, a: 1 } } },
        children: [textNode("t-title", "Big title", 44, 60, 50), textNode("t-body", "Body copy", 20, 60, 200)],
      },
      { id: "p2", width: 1280, height: 720, children: [] },
    ],
  } as unknown as DesignFile;
}

const doc = () => useEditor.getState().doc as DesignFile & { layouts?: { id: string; name: string; background?: unknown; placeholders: { id: string; role: string }[] }[]; masters?: unknown[] };

describe("slide layouts", () => {
  it("captures the page as a layout (title = largest font) with a default master", () => {
    useEditor.getState().loadDoc(deck());
    const id = useEditor.getState().savePageAsLayout("Title + body");
    expect(id).toBeTruthy();
    const d = doc();
    expect(d.masters).toHaveLength(1);
    expect(d.layouts).toHaveLength(1);
    expect(d.layouts![0].name).toBe("Title + body");
    expect(d.layouts![0].placeholders.map((p) => p.role)).toEqual(["title", "body"]);
    expect((d.pages[0] as { layoutId?: string }).layoutId).toBe(id);
    // Undoable as one step.
    useEditor.getState().undo();
    expect(doc().layouts ?? []).toHaveLength(0);
  });

  it("applies a layout to a blank page: background + placeholder text boxes, idempotently", () => {
    useEditor.getState().loadDoc(deck());
    const id = useEditor.getState().savePageAsLayout("L")!;
    expect(useEditor.getState().applyLayoutToPage(id, 1)).toBe(true);
    const p2 = doc().pages[1] as unknown as { background?: { type?: string }; children: Node[]; layoutId?: string };
    expect(p2.layoutId).toBe(id);
    expect(p2.background?.type).toBe("solid");
    expect(p2.children).toHaveLength(2);
    const tags = p2.children.map((n) => (n.data as { placeholderId?: string }).placeholderId);
    expect(tags).toEqual(["ph-1", "ph-2"]);
    // Re-apply never duplicates placeholders.
    expect(useEditor.getState().applyLayoutToPage(id, 1)).toBe(true);
    expect((doc().pages[1].children as Node[])).toHaveLength(2);
    // Unlink keeps content.
    expect(useEditor.getState().applyLayoutToPage(null, 1)).toBe(true);
    expect((doc().pages[1] as { layoutId?: string }).layoutId).toBeUndefined();
    expect((doc().pages[1].children as Node[])).toHaveLength(2);
  });

  it("update-from-page then sync pushes changes to every linked page", () => {
    useEditor.getState().loadDoc(deck());
    const st = useEditor.getState();
    const id = st.savePageAsLayout("L")!;
    st.applyLayoutToPage(id, 1);
    // Change the source page's background, recapture, and sync.
    st.setActivePage(0);
    st.setPageBackground({ type: "solid", color: { srgb: { r: 1, g: 0, b: 0, a: 1 } } } as never);
    expect(st.updateLayoutFromPage(id)).toBe(true);
    const undosBefore = useEditor.getState().undoStack.length;
    expect(st.syncLayoutPages(id)).toBe(2);
    // Two pages synced, but the gesture is ONE undo step.
    expect(useEditor.getState().undoStack.length).toBe(undosBefore + 1);
    const p2bg = (doc().pages[1] as unknown as { background?: { color?: { srgb?: { r: number } } } }).background;
    expect(p2bg?.color?.srgb?.r).toBe(1);
  });
});

describe("bulkMergePages", () => {
  it("creates one page per row, substituting {{tokens}} in runs and stickies", () => {
    const d = deck();
    d.pages[0].children = [
      textNode("t1", "Hi {{name}}, welcome to {{city}}!"),
      {
        id: "s1",
        type: "sticky",
        text: "Owner: {{name}}",
        fontScale: 1,
        transform: { x: 500, y: 40, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 170, height: 170 },
      } as unknown as Node,
    ];
    useEditor.getState().loadDoc(d);
    const n = useEditor.getState().bulkMergePages([
      { name: "Ada", city: "London" },
      { name: "Grace", city: "DC" },
    ]);
    expect(n).toBe(2);
    const pages = doc().pages;
    expect(pages).toHaveLength(4); // template + 2 merged + trailing blank
    const runText = (pg: unknown) => ((pg as { children: Node[] }).children[0] as unknown as { content: { runs: { text: string }[] }[] }).content[0].runs[0].text;
    expect(runText(pages[1])).toBe("Hi Ada, welcome to London!");
    expect(runText(pages[2])).toBe("Hi Grace, welcome to DC!");
    expect(((pages[1] as { children: Node[] }).children[1] as unknown as { text: string }).text).toBe("Owner: Ada");
    // Unknown tokens stay verbatim; template page untouched.
    expect(runText(pages[0])).toContain("{{name}}");
    // Fresh node ids per page (no cross-page id collisions).
    const ids = pages.flatMap((pg) => (pg.children as Node[]).map((c) => c.id));
    expect(new Set(ids).size).toBe(ids.length);
    // One undo removes all merged pages.
    useEditor.getState().undo();
    expect(doc().pages).toHaveLength(2);
  });

  it("leaves prototype-named tokens verbatim", () => {
    const d = deck();
    d.pages[0].children = [textNode("t1", "{{constructor}} and {{toString}} and {{name}}")];
    useEditor.getState().loadDoc(d);
    expect(useEditor.getState().bulkMergePages([{ name: "Ada" }])).toBe(1);
    const merged = (doc().pages[1] as { children: Node[] }).children[0] as unknown as { content: { runs: { text: string }[] }[] };
    expect(merged.content[0].runs[0].text).toBe("{{constructor}} and {{toString}} and Ada");
  });

  it("returns 0 for an empty dataset", () => {
    useEditor.getState().loadDoc(deck());
    expect(useEditor.getState().bulkMergePages([])).toBe(0);
  });
});
