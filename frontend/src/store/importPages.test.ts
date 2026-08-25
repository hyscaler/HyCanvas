// F28 completion C38: reuse slides from another deck. Copies land after the
// active page with fresh ids, source-document references (layout/section)
// dropped, colliding asset ids reminted with the page references rewritten,
// and (optionally) the source theme's paint remapped slot-by-slot onto this
// document's theme. One undo step reverts pages AND carried assets.

import { beforeEach, describe, expect, it } from "vitest";
import { createBlankDesign, type Color, type DesignFile, type Node, type Theme } from "@hc/schema";
import { useEditor } from "./editor";

const c = (r: number, g: number, b: number, a = 1): Color => ({ srgb: { r, g, b, a } });
const RED = c(1, 0, 0);
const BLUE = c(0, 0, 1);
const USER = c(0.42, 0.13, 0.37);

const srcTheme: Theme = {
  id: "t-src",
  colors: [{ id: "s-0", name: "primary", color: RED }],
  fontHeading: "SrcHead",
  fontBody: "SrcBody",
};
const destTheme: Theme = {
  id: "t-dest",
  colors: [{ id: "d-0", name: "primary", color: BLUE }],
  fontHeading: "DestHead",
  fontBody: "DestBody",
};

function sourceFile(): DesignFile {
  const file = createBlankDesign({ title: "Source deck", width: 1920, height: 1080 });
  (file as unknown as { theme?: Theme }).theme = structuredClone(srcTheme);
  file.assets.push({ id: "shared-asset", kind: "image", name: "pic", url: "https://src.example/pic.png", mime: "image/png", checksum: "" } as never);
  const page = file.pages[0] as unknown as { name?: string; layoutId?: string; sectionId?: string; readingOrder?: string[]; children: Node[] };
  page.name = "Quarterly numbers";
  page.layoutId = "src-layout";
  page.sectionId = "src-section";
  page.children.push(
    {
      id: "src-shape", type: "rect",
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 10, height: 10 }, opacity: 1, blendMode: "normal",
      fills: [{ type: "solid", color: c(1, 0, 0, 0.5) }, { type: "solid", color: structuredClone(USER) }],
    } as unknown as Node,
    {
      id: "src-img", type: "image",
      transform: { x: 20, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 10, height: 10 }, opacity: 1, blendMode: "normal",
      source: { assetId: "shared-asset", naturalWidth: 0, naturalHeight: 0 }, fit: "contain",
    } as unknown as Node,
    {
      id: "src-text", type: "text",
      transform: { x: 0, y: 20, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 100, height: 20 }, opacity: 1, blendMode: "normal",
      box: { mode: "autoHeight", width: 100, height: 20 },
      content: [{ runs: [{ text: "Hi", style: { fontFamily: "SrcHead", fontStyle: "Regular", fontSize: 16 } }], style: { align: "left" } }],
    } as unknown as Node,
  );
  page.readingOrder = ["src-text", "src-shape", "src-img"];
  return file;
}

function resetDest() {
  const st = useEditor.getState();
  const doc = st.doc as unknown as DesignFile & { theme?: Theme };
  doc.theme = structuredClone(destTheme);
  doc.pages.splice(1); // one page
  (doc.pages[0] as unknown as { children: Node[] }).children.length = 0;
  doc.assets.length = 0;
  useEditor.setState({ activePage: 0, selection: [] });
}

beforeEach(resetDest);

describe("importPagesFrom (C38)", () => {
  it("copies pages with fresh ids, drops source layout/section links, remaps reading order", () => {
    const st = useEditor.getState();
    const n = st.importPagesFrom(sourceFile(), [0]);
    expect(n).toBe(1);
    const doc = st.doc;
    expect(doc.pages).toHaveLength(2);
    const page = doc.pages[1] as unknown as { id: string; name?: string; layoutId?: string; sectionId?: string; readingOrder?: string[]; children: { id: string }[] };
    expect(page.name).toBe("Quarterly numbers");
    expect(page.layoutId).toBeUndefined();
    expect(page.sectionId).toBeUndefined();
    expect(page.children.map((ch) => ch.id)).not.toContain("src-shape");
    // Reading order follows the remap (text, shape, image in the new ids).
    expect(page.readingOrder).toHaveLength(3);
    expect(page.readingOrder![0]).toBe(page.children[2].id);
  });

  it("carries a referenced asset, and remints a colliding id (different url) rewriting the page refs", () => {
    const st = useEditor.getState();
    st.doc.assets.push({ id: "shared-asset", kind: "image", name: "other", url: "https://dest.example/other.png", mime: "image/png", checksum: "" } as never);
    st.importPagesFrom(sourceFile(), [0]);
    const doc = st.doc;
    // The destination's own asset is untouched; the source's arrived under a fresh id.
    const ids = doc.assets.map((a) => a.id);
    expect(ids).toContain("shared-asset");
    expect(doc.assets.find((a) => a.id === "shared-asset")!.url).toBe("https://dest.example/other.png");
    const minted = doc.assets.find((a) => a.url === "https://src.example/pic.png");
    expect(minted).toBeTruthy();
    expect(minted!.id).not.toBe("shared-asset");
    const img = (doc.pages[1].children as unknown as { type: string; source?: { assetId: string } }[]).find((ch) => ch.type === "image")!;
    expect(img.source!.assetId).toBe(minted!.id);
  });

  it("carries an asset referenced only by the page background image fill", () => {
    const st = useEditor.getState();
    const file = sourceFile();
    file.assets.push({ id: "bg-asset", kind: "image", name: "bg", url: "https://src.example/bg.png", mime: "image/png", checksum: "" } as never);
    (file.pages[0] as unknown as { background?: unknown }).background = {
      type: "image",
      source: { assetId: "bg-asset", naturalWidth: 0, naturalHeight: 0 },
      fit: "cover",
    };
    st.importPagesFrom(file, [0]);
    expect(st.doc.assets.some((a) => a.id === "bg-asset")).toBe(true);
  });

  it("reuses an identical asset (same id and url) without duplicating the ref", () => {
    const st = useEditor.getState();
    st.doc.assets.push({ id: "shared-asset", kind: "image", name: "pic", url: "https://src.example/pic.png", mime: "image/png", checksum: "" } as never);
    st.importPagesFrom(sourceFile(), [0]);
    expect(st.doc.assets.filter((a) => a.id === "shared-asset")).toHaveLength(1);
    const img = (st.doc.pages[1].children as unknown as { type: string; source?: { assetId: string } }[]).find((ch) => ch.type === "image")!;
    expect(img.source!.assetId).toBe("shared-asset");
  });

  it("theme-matches the copies slot-by-slot (alpha preserved), leaving user colors and skipping when off", () => {
    const st = useEditor.getState();
    st.importPagesFrom(sourceFile(), [0], { matchTheme: true });
    const shape = (st.doc.pages[1].children as unknown as { type: string; fills?: { color: Color }[] }[]).find((ch) => ch.type === "rect")!;
    expect(shape.fills![0].color).toEqual(c(0, 0, 1, 0.5)); // RED@0.5 -> BLUE@0.5
    expect(shape.fills![1].color).toEqual(USER); // no slot match: untouched
    const text = (st.doc.pages[1].children as unknown as { type: string; content?: { runs: { style: { fontFamily: string } }[] }[] }[]).find((ch) => ch.type === "text")!;
    expect(text.content![0].runs[0].style.fontFamily).toBe("DestHead");

    resetDest();
    st.importPagesFrom(sourceFile(), [0], { matchTheme: false });
    const raw = (useEditor.getState().doc.pages[1].children as unknown as { type: string; fills?: { color: Color }[] }[]).find((ch) => ch.type === "rect")!;
    expect(raw.fills![0].color).toEqual(c(1, 0, 0, 0.5)); // untouched
  });

  it("one undo removes the pages and the carried assets", () => {
    const st = useEditor.getState();
    st.importPagesFrom(sourceFile(), [0]);
    expect(st.doc.pages).toHaveLength(2);
    expect(st.doc.assets.some((a) => a.url === "https://src.example/pic.png")).toBe(true);
    st.undo();
    expect(st.doc.pages).toHaveLength(1);
    expect(st.doc.assets.some((a) => a.url === "https://src.example/pic.png")).toBe(false);
  });
});

describe("per-slide status and assignee (C35)", () => {
  it("stores status and assignee in the page's open data record, deleting cleared keys", () => {
    const st = useEditor.getState();
    st.setPageWorkStatus(0, "review");
    st.setPageAssignee(0, { id: "u1", name: "Ada" });
    const data = (st.doc.pages[0] as unknown as { data?: Record<string, unknown> }).data!;
    expect(data.status).toBe("review");
    expect(data.assigneeId).toBe("u1");
    expect(data.assigneeName).toBe("Ada");
    st.setPageWorkStatus(0, null);
    st.setPageAssignee(0, null);
    // Deleted, never an explicit undefined (the CRDT reconcile is key-driven).
    expect("status" in data).toBe(false);
    expect("assigneeId" in data).toBe(false);
    expect("assigneeName" in data).toBe(false);
  });

  it("undo restores the previous status", () => {
    const st = useEditor.getState();
    st.setPageWorkStatus(0, "draft");
    st.setPageWorkStatus(0, "approved");
    st.undo();
    expect((st.doc.pages[0] as unknown as { data?: Record<string, unknown> }).data?.status).toBe("draft");
    st.undo();
    expect((st.doc.pages[0] as unknown as { data?: Record<string, unknown> }).data?.status).toBeUndefined();
  });
});
