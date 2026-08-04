// applyTemplateFile: appends a template's pages with fresh ids as ONE undo
// step, merges asset refs without duplicates, and refuses to mutate read-only
// states (history preview / non-edit access).
import { afterEach, describe, expect, it } from "vitest";
import type { DesignFile, Node } from "@hc/schema";
import { createBlankDesign } from "@hc/schema";
import { useEditor } from "./editor";
import { usePresence } from "./presence";

function templateFile(nodeIds: string[], size?: { width: number; height: number }): DesignFile {
  return {
    schemaVersion: useEditor.getState().doc.schemaVersion,
    id: "tpl-1",
    title: "Tpl",
    assets: [{ id: "asset-tpl-1", kind: "image", url: "/x.png", mime: "image/*", checksum: "" }],
    fonts: [{ id: "font-tpl-1", family: "Studio Sans", source: "upload", url: "data:font/woff2;base64,AAAA" }],
    pages: [
      {
        id: "tpl-page-1",
        width: size?.width ?? 500,
        height: size?.height ?? 400,
        // Authored screen-reader order (reversed on purpose): must survive the
        // id remap on apply instead of pointing at the template's old ids.
        readingOrder: [...nodeIds].reverse(),
        children: nodeIds.map((id) => ({
          id,
          type: "shape",
          shape: "rect",
          transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
          size: { width: 10, height: 10 },
        })),
      },
    ],
  } as unknown as DesignFile;
}

const allNodeIds = (): string[] => {
  const ids: string[] = [];
  const walk = (ns: Node[]) => {
    for (const n of ns) {
      ids.push(n.id);
      walk(((n as unknown as { children?: Node[] }).children ?? []) as Node[]);
    }
  };
  for (const p of useEditor.getState().doc.pages) walk(p.children as Node[]);
  return ids;
};

afterEach(() => {
  usePresence.getState().setAccessMode("edit");
});

describe("applyTemplateFile", () => {
  it("appends pages + assets + fonts as one undo step, with fresh ids on re-apply", () => {
    useEditor.getState().loadDoc(createBlankDesign({ width: 800, height: 600 }));
    const st = useEditor.getState();
    expect(st.applyTemplateFile(templateFile(["t1", "t2"]), "Tpl")).toBe(true);
    let doc = useEditor.getState().doc;
    expect(doc.pages.length).toBe(2);
    expect(useEditor.getState().activePage).toBe(1);
    expect(doc.pages[1].children.length).toBe(2);
    expect((doc.pages[1] as unknown as { name?: string }).name).toBe("Tpl");
    expect(doc.assets.some((a) => a.id === "asset-tpl-1")).toBe(true);
    // Uploaded-font refs ride along so the text renders cross-device.
    expect((doc.fonts ?? []).some((f) => f.family === "Studio Sans")).toBe(true);
    // The authored reading order survives, remapped to the FRESH ids in the
    // same (reversed) order.
    const applied = doc.pages[1] as unknown as { readingOrder?: string[]; children: Node[] };
    expect(applied.readingOrder).toEqual([applied.children[1].id, applied.children[0].id]);
    expect(applied.readingOrder!.every((id) => !["t1", "t2"].includes(id))).toBe(true);

    // Re-apply: fresh node ids, asset ref and font family NOT duplicated.
    st.applyTemplateFile(templateFile(["t1", "t2"]), "Tpl");
    doc = useEditor.getState().doc;
    expect(doc.pages.length).toBe(3);
    const ids = allNodeIds();
    expect(new Set(ids).size).toBe(ids.length);
    expect(doc.assets.filter((a) => a.id === "asset-tpl-1").length).toBe(1);
    expect((doc.fonts ?? []).filter((f) => f.family === "Studio Sans").length).toBe(1);

    // One undo removes exactly the last apply (page + nothing else).
    useEditor.getState().undo();
    doc = useEditor.getState().doc;
    expect(doc.pages.length).toBe(2);
    expect(doc.assets.filter((a) => a.id === "asset-tpl-1").length).toBe(1); // still used by apply #1
    useEditor.getState().undo();
    doc = useEditor.getState().doc;
    expect(doc.pages.length).toBe(1);
    expect(doc.assets.some((a) => a.id === "asset-tpl-1")).toBe(false);
    expect((doc.fonts ?? []).some((f) => f.family === "Studio Sans")).toBe(false);
  });

  it("resizes differently-sized template pages to the active page's dimensions", () => {
    useEditor.getState().loadDoc(createBlankDesign({ width: 800, height: 600 }));
    const st = useEditor.getState();
    // Template authored at 500x400 lands as an 800x600 page (no mixed sizes),
    // with its content scaled up by the resize mapping rather than left small.
    expect(st.applyTemplateFile(templateFile(["t1"]), "Tpl")).toBe(true);
    const applied = useEditor.getState().doc.pages[1];
    expect(applied.width).toBe(800);
    expect(applied.height).toBe(600);
    const box = applied.children[0].size;
    expect(box.width).toBeGreaterThan(10);
    expect(box.height).toBeGreaterThan(10);
  });

  it("leaves same-size template pages untouched", () => {
    useEditor.getState().loadDoc(createBlankDesign({ width: 800, height: 600 }));
    const st = useEditor.getState();
    expect(st.applyTemplateFile(templateFile(["t1"], { width: 800, height: 600 }), "Tpl")).toBe(true);
    const applied = useEditor.getState().doc.pages[1];
    expect(applied.width).toBe(800);
    expect(applied.height).toBe(600);
    expect(applied.children[0].size).toEqual({ width: 10, height: 10 });
    expect(applied.children[0].transform).toEqual({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 });
  });

  it("no-ops in a history preview and for non-edit access", () => {
    useEditor.getState().loadDoc(createBlankDesign({ width: 800, height: 600 }));
    const st = useEditor.getState();

    st.enterPreview(structuredClone(useEditor.getState().doc), "past version");
    expect(st.applyTemplateFile(templateFile(["p1"]), "Tpl")).toBe(false);
    expect(useEditor.getState().doc.pages.length).toBe(1); // preview untouched
    st.exitPreview();

    usePresence.getState().setAccessMode("view");
    expect(st.applyTemplateFile(templateFile(["p2"]), "Tpl")).toBe(false);
    expect(useEditor.getState().doc.pages.length).toBe(1);

    // zero-page templates are refused too
    usePresence.getState().setAccessMode("edit");
    expect(st.applyTemplateFile({ schemaVersion: 1, pages: [] } as unknown as DesignFile, "Empty")).toBe(false);
    expect(useEditor.getState().doc.pages.length).toBe(1);
  });
});
