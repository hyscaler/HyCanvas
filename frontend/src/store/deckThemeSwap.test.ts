// F28 T19: adopting a deck theme restyles what the previous theme painted -
// an exact slot-by-slot color remap plus the font pair - in ONE undo step,
// while a user's own colors and fonts (which match no slot) never move.

import { beforeEach, describe, expect, it } from "vitest";
import type { Color, Node, Theme } from "@hc/schema";
import { useEditor } from "./editor";

const c = (r: number, g: number, b: number, a = 1): Color => ({ srgb: { r, g, b, a } });
const RED = c(1, 0, 0);
const BLUE = c(0, 0, 1);
const GREEN = c(0, 0.5, 0);
const TEAL = c(0, 0.5, 0.5);
const USER = c(0.42, 0.13, 0.37); // matches no slot in either theme

const oldTheme: Theme = {
  id: "t-old",
  colors: [
    { id: "o-0", name: "primary", color: RED },
    { id: "o-1", name: "ink", color: c(0.1, 0.1, 0.1) },
  ],
  fontHeading: "OldHead",
  fontBody: "OldBody",
};
const newTheme: Theme = {
  id: "t-new",
  colors: [
    { id: "n-0", name: "primary", color: BLUE },
    { id: "n-1", name: "ink", color: c(0.9, 0.9, 0.9) },
  ],
  fontHeading: "NewHead",
  fontBody: "NewBody",
};

function seed() {
  const st = useEditor.getState();
  const doc = st.doc as unknown as {
    theme?: Theme;
    masters?: { id: string; placeholders: { id: string; role: string }[] }[];
    layouts?: { id: string; masterId: string; name: string; placeholders: { id: string; role: string; rect: object }[] }[];
  };
  doc.theme = structuredClone(oldTheme);
  doc.masters = [{ id: "m1", placeholders: [] }];
  doc.layouts = [
    {
      id: "l1",
      masterId: "m1",
      name: "Title and content",
      placeholders: [
        { id: "ph-title", role: "title", rect: { x: 0, y: 0, width: 100, height: 40 } },
        { id: "ph-content", role: "content", rect: { x: 0, y: 50, width: 100, height: 40 } },
      ],
    },
  ];
  const page = st.doc.pages[st.activePage] as unknown as { layoutId?: string; background?: unknown; children: Node[] };
  page.layoutId = "l1";
  page.background = { type: "solid", color: structuredClone(RED) };
  page.children.length = 0;
  page.children.push(
    // A shape painted with the old primary at half alpha, plus a user color.
    {
      id: "shape", type: "rect",
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 10, height: 10 }, opacity: 1, blendMode: "normal",
      fills: [{ type: "solid", color: c(1, 0, 0, 0.5) }, { type: "solid", color: structuredClone(USER) }],
    } as unknown as Node,
    // Placeholder title wearing the old heading font.
    {
      id: "title", type: "text",
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 100, height: 20 }, opacity: 1, blendMode: "normal",
      box: { mode: "autoHeight", width: 100, height: 20 },
      data: { placeholderId: "ph-title" },
      content: [{ runs: [{ text: "Hello", style: { fontFamily: "OldHead", fontStyle: "Regular", fontSize: 16 } }], style: { align: "left" } }],
    } as unknown as Node,
    // Placeholder content where the user hand-picked a font.
    {
      id: "body", type: "text",
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 100, height: 20 }, opacity: 1, blendMode: "normal",
      box: { mode: "autoHeight", width: 100, height: 20 },
      data: { placeholderId: "ph-content" },
      content: [{ runs: [{ text: "Mine", style: { fontFamily: "HandPicked", fontStyle: "Regular", fontSize: 12 } }], style: { align: "left" } }],
    } as unknown as Node,
  );
  useEditor.setState({ selection: [], undoStack: [], redoStack: [], editingTextId: null });
}

function page() {
  const st = useEditor.getState();
  return st.doc.pages[st.activePage] as unknown as {
    background?: { type: string; color: Color };
    children: (Node & {
      fills?: { type: string; color: Color }[];
      content?: { runs: { style: { fontFamily?: string } }[] }[];
    })[];
  };
}

beforeEach(seed);

describe("setDeckTheme remap (T19)", () => {
  it("remaps exact slot colors (alpha preserved) and leaves user colors alone", () => {
    useEditor.getState().setDeckTheme(structuredClone(newTheme));
    const p = page();
    expect(p.background!.color.srgb).toEqual(BLUE.srgb); // page bg followed primary
    const shape = p.children.find((n) => n.id === "shape")!;
    expect(shape.fills![0].color.srgb).toEqual({ ...BLUE.srgb, a: 0.5 }); // alpha kept
    expect(shape.fills![1].color.srgb).toEqual(USER.srgb); // user color untouched
    expect((useEditor.getState().doc as { theme?: Theme }).theme?.id).toBe("t-new");
  });

  it("placeholder text wearing the old role font adopts the new pair; a hand-picked font stays", () => {
    useEditor.getState().setDeckTheme(structuredClone(newTheme));
    const p = page();
    const title = p.children.find((n) => n.id === "title")!;
    expect(title.content![0].runs[0].style.fontFamily).toBe("NewHead");
    const body = p.children.find((n) => n.id === "body")!;
    expect(body.content![0].runs[0].style.fontFamily).toBe("HandPicked");
  });

  it("reverts the whole swap - record, masters, and content - in one undo step", () => {
    const st = useEditor.getState();
    st.setDeckTheme(structuredClone(newTheme));
    expect(useEditor.getState().undoStack.length).toBe(1);
    useEditor.getState().undo();
    const p = page();
    expect(p.background!.color.srgb).toEqual(RED.srgb);
    const title = p.children.find((n) => n.id === "title")!;
    expect(title.content![0].runs[0].style.fontFamily).toBe("OldHead");
    expect((useEditor.getState().doc as { theme?: Theme }).theme?.id).toBe("t-old");
  });

  it("restyle:false swaps the record only", () => {
    useEditor.getState().setDeckTheme(structuredClone(newTheme), { restyle: false });
    const p = page();
    expect(p.background!.color.srgb).toEqual(RED.srgb); // content untouched
    expect((useEditor.getState().doc as { theme?: Theme }).theme?.id).toBe("t-new");
  });

  it("clearing the theme leaves content untouched", () => {
    useEditor.getState().setDeckTheme(undefined);
    const p = page();
    expect(p.background!.color.srgb).toEqual(RED.srgb);
    expect((useEditor.getState().doc as { theme?: Theme }).theme).toBeUndefined();
  });

  it("a color the OLD theme shares with the new one does not move", () => {
    const same: Theme = { ...structuredClone(newTheme), colors: [{ id: "n-0", name: "primary", color: RED }, ...structuredClone(newTheme.colors.slice(1))] };
    useEditor.getState().setDeckTheme(same);
    expect(page().background!.color.srgb).toEqual(RED.srgb);
  });

  it("a prior edit's undo survives a no-match theme swap (identity preserved)", () => {
    // Nothing on the page wears a slot color: the swap must not churn page or
    // node identity, or the earlier edit's captured-reference closure would
    // mutate a detached object.
    const st = useEditor.getState();
    const p0 = page();
    p0.background = { type: "solid", color: c(0.42, 0.13, 0.37) } as never; // USER color, no slot match
    const beforeChildren = p0.children;
    st.setPageBackground({ type: "solid", color: c(0, 0.5, 0) } as never);
    st.setDeckTheme({ ...structuredClone(newTheme), colors: [{ id: "n-0", name: "primary", color: c(0.9, 0.9, 0.1) }] });
    expect(page().children).toBe(beforeChildren); // no identity churn
    useEditor.getState().undo(); // theme swap
    useEditor.getState().undo(); // background edit
    expect(page().background!.color.srgb).toEqual({ r: 0.42, g: 0.13, b: 0.37, a: 1 });
  });

  it("an edit made after a matching swap survives an undo+redo round trip", () => {
    // Redo of the swap must restore INTO the existing page objects (by id),
    // never re-clone them, or the later edit's redo mutates a detached page.
    const st = useEditor.getState();
    st.setDeckTheme(structuredClone(newTheme)); // remaps RED
    expect(page().background!.color.srgb).toEqual(BLUE.srgb);
    useEditor.getState().setPageBackground({ type: "solid", color: GREEN } as never);
    expect(page().background!.color.srgb).toEqual(GREEN.srgb);
    useEditor.getState().undo(); // background edit
    useEditor.getState().undo(); // theme swap
    expect(page().background!.color.srgb).toEqual(RED.srgb);
    useEditor.getState().redo(); // theme swap
    expect(page().background!.color.srgb).toEqual(BLUE.srgb);
    useEditor.getState().redo(); // background edit
    expect(page().background!.color.srgb).toEqual(GREEN.srgb);
  });

  it("NODE identity survives undo and redo of a theme swap", () => {
    const st = useEditor.getState();
    const shapeBefore = page().children.find((n) => n.id === "shape")!;
    st.setDeckTheme(structuredClone(newTheme));
    expect(page().children.find((n) => n.id === "shape")).toBe(shapeBefore);
    useEditor.getState().undo();
    expect(page().children.find((n) => n.id === "shape")).toBe(shapeBefore);
    useEditor.getState().redo();
    expect(page().children.find((n) => n.id === "shape")).toBe(shapeBefore);
    expect(shapeBefore.fills![0].color.srgb).toEqual({ ...BLUE.srgb, a: 0.5 });
  });

  it("swapping between different slot counts remaps the shared prefix", () => {
    const wide: Theme = {
      id: "t-wide",
      colors: [
        { id: "w-0", name: "primary", color: GREEN },
        { id: "w-1", name: "ink", color: TEAL },
        { id: "w-2", name: "extra", color: c(0.2, 0.2, 0.2) },
      ],
    };
    useEditor.getState().setDeckTheme(wide);
    expect(page().background!.color.srgb).toEqual(GREEN.srgb);
  });
});
