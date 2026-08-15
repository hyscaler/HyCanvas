// fromDocWithPageReuse (doc 16 FR-2/FR-7 incremental apply at scale): projects
// only pages absent from the reuse map, emits reused JS objects by IDENTITY,
// and matches fromDoc's ordering semantics (rank sort with id tiebreak; a
// rankless keyed array keeps insertion order).
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { DesignFile } from "@hc/schema";
import { fromDoc, fromDocWithPageReuse, reconcile } from "../index";

function fileWithPages(ids: string[]): DesignFile {
  return {
    schemaVersion: 1,
    id: "d1",
    title: "Reuse",
    pages: ids.map((id) => ({
      id,
      width: 800,
      height: 600,
      children: [
        {
          id: `${id}-n1`,
          type: "shape",
          shape: "rect",
          transform: { x: 1, y: 2, scaleX: 1, scaleY: 1, rotation: 0 },
          size: { width: 10, height: 10 },
        },
      ],
    })),
  } as unknown as DesignFile;
}

describe("fromDocWithPageReuse", () => {
  it("reuses given page objects by identity and projects the rest", () => {
    const ydoc = new Y.Doc();
    reconcile(fileWithPages(["p1", "p2", "p3"]), ydoc);
    const base = fromDoc(ydoc);

    const reusable = new Map<string, unknown>([
      ["p1", base.pages[0]],
      ["p3", base.pages[2]],
    ]);
    const out = fromDocWithPageReuse(ydoc, reusable);
    expect(out.pages.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
    expect(out.pages[0]).toBe(base.pages[0]); // identical object, zero projection cost
    expect(out.pages[2]).toBe(base.pages[2]);
    expect(out.pages[1]).not.toBe(base.pages[1]); // dirty page projected fresh
    expect(out.pages[1]).toEqual(base.pages[1]); // ...but equal in content
    expect(out.title).toBe("Reuse"); // meta projects normally
  });

  it("orders reused bodies by the LIVE ranks (a reorder works against full reuse)", () => {
    const ydoc = new Y.Doc();
    reconcile(fileWithPages(["a", "b", "c"]), ydoc);
    const base = fromDoc(ydoc);
    // Reorder pages via a normal reconcile (rank rewrite, not delete+insert).
    reconcile(
      { ...base, pages: [base.pages[2], base.pages[0], base.pages[1]] } as DesignFile,
      ydoc,
    );
    const reusable = new Map<string, unknown>(base.pages.map((p) => [p.id as string, p]));
    const out = fromDocWithPageReuse(ydoc, reusable);
    expect(out.pages.map((p) => p.id)).toEqual(["c", "a", "b"]);
    expect(out.pages[0]).toBe(base.pages[2]); // same bodies, new order
  });

  it("matches fromDoc exactly when nothing is reusable", () => {
    const ydoc = new Y.Doc();
    reconcile(fileWithPages(["x", "y"]), ydoc);
    const plain = fromDoc(ydoc);
    const viaReuse = fromDocWithPageReuse(ydoc, new Map());
    expect(viaReuse).toEqual(plain);
  });
});
