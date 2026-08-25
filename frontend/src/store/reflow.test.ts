// F40 E16/E17: live adaptive reflow. A placeholder-tagged box on a
// layout-linked page steps its font along the role ladder inside the SAME
// undo step as the edit; hand-moved boxes and mixed run sizes are left alone;
// the per-page opt-out rides Page.data.autoflow; and past what the ladder
// absorbs, a variant hint appears whose apply switches the layout and
// redistributes the text in one undo turn.
import { beforeEach, describe, expect, it } from "vitest";
import type { Node } from "@hc/schema";
import { useEditor } from "./editor";

type Paragraphs = { runs: { text: string; style: Record<string, unknown> }[]; style: Record<string, unknown> }[];

const para = (text: string, fontSize: number): Paragraphs[number] => ({
  runs: [{ text, style: { fontFamily: "system", fontStyle: "Regular", fontSize } }],
  style: { align: "left" },
});

function seed() {
  const st = useEditor.getState();
  const doc = st.doc;
  doc.pages.splice(1);
  (doc.pages[0] as unknown as { children: Node[]; layoutId?: string; data?: Record<string, unknown> }).children.length = 0;
  delete (doc.pages[0] as unknown as { layoutId?: string }).layoutId;
  delete (doc.pages[0] as unknown as { data?: unknown }).data;
  (doc as unknown as { layouts?: unknown[] }).layouts = undefined;
  (doc as unknown as { masters?: unknown[] }).masters = undefined;
  useEditor.setState({ activePage: 0, selection: [], reflowHint: null });
  // Install the builtins and link + materialize the title-and-content layout.
  st.ensureSlideLayouts({ width: 1920, height: 1080 });
  st.applyLayoutToPage("layout-title-content", 0);
}

beforeEach(seed);

const contentBox = () => {
  const page = useEditor.getState().doc.pages[0] as unknown as { children: (Node & { data?: { placeholderId?: string }; content: Paragraphs })[] };
  return page.children.find((n) => n.data?.placeholderId === "ph-content")!;
};

const crowd = (n: number): Paragraphs =>
  Array.from({ length: n }, (_, i) => para(`•  Bullet ${i + 1}: a reasonably long line of body copy that wraps at least once inside the slot`, 20));

describe("live reflow on edit (E16)", () => {
  it("steps the font down the ladder inside the same undo step", () => {
    const st = useEditor.getState();
    const box = contentBox();
    st.setContent(box.id, crowd(48));
    const size = contentBox().content[0].runs[0].style.fontSize;
    expect(size).toBeLessThan(20);
    st.undo();
    // One undo reverts content AND size together.
    expect(contentBox().content.length).toBeLessThanOrEqual(1);
  });

  it("steps back up when the content shrinks", () => {
    const st = useEditor.getState();
    const box = contentBox();
    st.setContent(box.id, crowd(48));
    expect(contentBox().content[0].runs[0].style.fontSize).toBeLessThan(20);
    st.setContent(box.id, [para("one short point", contentBox().content[0].runs[0].style.fontSize as number)]);
    expect(contentBox().content[0].runs[0].style.fontSize).toBe(20);
  });

  it("respects the per-page opt-out and the hand-moved guard", () => {
    const st = useEditor.getState();
    st.setPageAutoflow(0, false);
    st.setContent(contentBox().id, crowd(24));
    expect(contentBox().content[0].runs[0].style.fontSize).toBe(20);
    st.setPageAutoflow(0, true);
    // Hand-move the box off its slot: the link is broken for that box.
    const box = contentBox();
    (box as unknown as { transform: { x: number } }).transform.x += 40;
    st.setContent(box.id, crowd(24));
    expect(contentBox().content[0].runs[0].style.fontSize).toBe(20);
  });

  it("treats a hand-RESIZED box as link-broken too (width off the slot)", () => {
    const st = useEditor.getState();
    const box = contentBox();
    (box as unknown as { size: { width: number } }).size.width += 40;
    st.setContent(box.id, crowd(48));
    expect(contentBox().content[0].runs[0].style.fontSize).toBe(20);
  });

  it("leaves mixed run sizes alone (deliberate styling)", () => {
    const st = useEditor.getState();
    const mixed: Paragraphs = [
      { runs: [{ text: "Big lead-in. ", style: { fontFamily: "system", fontStyle: "Regular", fontSize: 28 } }, { text: "then a very long remainder of body copy repeated ".repeat(30), style: { fontFamily: "system", fontStyle: "Regular", fontSize: 20 } }], style: { align: "left" } },
    ];
    st.setContent(contentBox().id, mixed);
    expect(contentBox().content[0].runs[0].style.fontSize).toBe(28);
  });
});

describe("variant switching (E17)", () => {
  it("raises an overfull hint past the floor and switching redistributes the text", () => {
    const st = useEditor.getState();
    st.setContent(contentBox().id, crowd(120));
    const hint = useEditor.getState().reflowHint;
    expect(hint).toBeTruthy();
    expect(hint!.direction).toBe("denser");
    const ok = st.switchPageLayout(0, hint!.toLayoutId);
    expect(ok).toBe(true);
    expect(useEditor.getState().reflowHint).toBeNull();
    const page = useEditor.getState().doc.pages[0] as unknown as { layoutId?: string; children: (Node & { data?: { placeholderId?: string }; content?: Paragraphs })[] };
    expect(page.layoutId).toBe(hint!.toLayoutId);
    // The old slot's bullets landed in the NEW layout's content slots.
    const texts = page.children
      .filter((n) => n.data?.placeholderId && n.content?.length)
      .flatMap((n) => n.content!.map((p) => p.runs.map((r) => r.text).join("")));
    expect(texts.some((t) => t.includes("Bullet 1:"))).toBe(true);
    // One undo reverts the whole switch (layout + refill).
    st.undo();
    expect((useEditor.getState().doc.pages[0] as unknown as { layoutId?: string }).layoutId).toBe("layout-title-content");
  });

  it("clears the hint when a later edit fits again", () => {
    const st = useEditor.getState();
    st.setContent(contentBox().id, crowd(120));
    expect(useEditor.getState().reflowHint).toBeTruthy();
    st.setContent(contentBox().id, [para("fits fine", 12)]);
    expect(useEditor.getState().reflowHint).toBeNull();
  });

  it("clears the hint on undo (the state it described is gone)", () => {
    const st = useEditor.getState();
    st.setContent(contentBox().id, crowd(120));
    expect(useEditor.getState().reflowHint).toBeTruthy();
    st.undo();
    expect(useEditor.getState().reflowHint).toBeNull();
  });

  it("snaps a surviving same-id box onto the NEW layout's slot rect", () => {
    const st = useEditor.getState();
    st.setContent(contentBox().id, crowd(120));
    const hint = useEditor.getState().reflowHint!;
    st.switchPageLayout(0, hint.toLayoutId);
    // Layouts share the "ph-title" slot id with different rects: the title
    // box survives the switch and must sit on the NEW layout's rect (at the
    // same proportional page scale materialization uses).
    const doc = useEditor.getState().doc as unknown as {
      pages: { width: number; height: number; children: (Node & { data?: { placeholderId?: string } })[] }[];
      layouts: { id: string; placeholders: { id: string; rect: { x: number; y: number; width: number; height: number } }[] }[];
    };
    const to = doc.layouts.find((l) => l.id === hint.toLayoutId)!;
    let extentW = 0;
    let extentH = 0;
    for (const p of to.placeholders) {
      extentW = Math.max(extentW, p.rect.x + p.rect.width);
      extentH = Math.max(extentH, p.rect.y + p.rect.height);
    }
    const page = doc.pages[0];
    const sx = extentW > page.width ? page.width / extentW : 1;
    const sy = extentH > page.height ? page.height / extentH : 1;
    const slot = to.placeholders.find((p) => p.id === "ph-title")!.rect;
    const titleBox = page.children.find((n) => n.data?.placeholderId === "ph-title")! as unknown as { transform: { x: number; y: number }; size: { width: number } };
    expect(titleBox.transform.x).toBeCloseTo(slot.x * sx, 3);
    expect(titleBox.transform.y).toBeCloseTo(slot.y * sy, 3);
    expect(titleBox.size.width).toBeCloseTo(slot.width * sx, 3);
  });

  it("never turns scaffold text into content bullets on a switch", () => {
    const st = useEditor.getState();
    st.setContent(contentBox().id, crowd(120));
    const hint = useEditor.getState().reflowHint!;
    st.switchPageLayout(0, hint.toLayoutId);
    const page = useEditor.getState().doc.pages[0] as unknown as { children: (Node & { data?: { placeholderId?: string }; content?: Paragraphs })[] };
    const bullets = page.children
      .filter((n) => n.data?.placeholderId && n.content?.length)
      .flatMap((n) => n.content!.map((p) => p.runs.map((r) => r.text).join("")))
      .filter((t) => t.startsWith("•"));
    // The untouched title scaffold ("Title") and any body scaffold ("Text")
    // must not be swept into the redistributed points.
    expect(bullets.some((t) => /^•\s*(Title|Text)$/.test(t))).toBe(false);
  });
});
