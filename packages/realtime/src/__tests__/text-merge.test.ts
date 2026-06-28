// F16 character-level rich-text merge (the headline collaboration win). A text
// node's paragraphs store their runs as a Yjs Y.Text, so two people typing in
// the SAME paragraph merge character-by-character instead of one clobbering the
// other (the old idless-runs-array path delete+reinserted the whole array). These
// tests run entirely in-process (two Y.Docs, no socket): round-trip fidelity of
// the new representation, the concurrent-typing merge, sibling-paragraph
// isolation, and style-only edits via the format pass.

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { type DesignFile } from "@hc/schema";
import { reconcile, fromDoc, LOCAL_ORIGIN } from "../index";

function run(text: string, style: Record<string, unknown> = { fontSize: 24 }) {
  return { text, style };
}
function para(runs: unknown[], style: Record<string, unknown> = { align: "left", direction: "ltr" }) {
  return { runs, style };
}
function textNode(id: string, content: unknown[]) {
  return {
    id,
    type: "text",
    name: id,
    box: { mode: "fixed", width: 100, height: 50 },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: 100, height: 50 },
    opacity: 1,
    content,
  };
}
function design(nodes: unknown[]): DesignFile {
  return {
    schemaVersion: 4,
    id: "d",
    title: "t",
    assets: [],
    pages: [{ id: "p1", name: "P", width: 100, height: 100, children: nodes }],
  } as unknown as DesignFile;
}

type Para = { runs: { text: string; style: Record<string, unknown> }[]; style: Record<string, unknown> };
function contentOf(file: DesignFile, nodeId: string): Para[] {
  const n = file.pages[0].children.find((c) => (c as { id: string }).id === nodeId) as
    | { content: Para[] }
    | undefined;
  return n?.content ?? [];
}
function paraText(file: DesignFile, nodeId: string, pIdx: number): string {
  return (contentOf(file, nodeId)[pIdx]?.runs ?? []).map((r) => r.text).join("");
}

function docFrom(file: DesignFile): Y.Doc {
  const doc = new Y.Doc();
  reconcile(file, doc);
  return doc;
}
function forkDoc(doc: Y.Doc): Y.Doc {
  const replica = new Y.Doc();
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
  return replica;
}

describe("rich-text round-trip (runs <-> Y.Text)", () => {
  it("a multi-run paragraph round-trips through the Y.Text representation", () => {
    const file = design([
      textNode("t1", [para([run("Hello ", { fontSize: 24 }), run("world", { fontSize: 24, decoration: ["underline"] })])]),
    ]);
    const doc = docFrom(file);
    expect(fromDoc(doc)).toEqual(file);
  });

  it("an empty paragraph with runs:[] round-trips to runs:[]", () => {
    const file = design([textNode("t1", [para([])])]);
    const doc = docFrom(file);
    expect(fromDoc(doc)).toEqual(file);
  });

  it("an all-empty run keeps its style across the round-trip (empty-run stash)", () => {
    // A blank line the editor models as a single empty-text run carrying the
    // caret style. The Y.Text is empty, so the run is stashed and restored.
    const file = design([textNode("t1", [para([run("", { fontSize: 48, fontFamily: "Inter" })])])]);
    const doc = docFrom(file);
    expect(fromDoc(doc)).toEqual(file);
    expect(contentOf(fromDoc(doc), "t1")[0].runs[0].style.fontSize).toBe(48);
  });

  it("is idempotent: reconciling the same text twice produces zero ops", () => {
    const file = design([textNode("t1", [para([run("Hello "), run("world", { fontSize: 24, decoration: ["underline"] })])])]);
    const doc = docFrom(file);
    let touched = false;
    doc.on("update", () => {
      touched = true;
    });
    reconcile(file, doc);
    expect(touched).toBe(false);
  });
});

describe("rich-text concurrent merge", () => {
  it("two clients typing in the SAME paragraph both survive (char-level merge)", () => {
    const A = docFrom(design([textNode("t1", [para([run("Hello world")])])]));
    const B = forkDoc(A);
    const aU: Uint8Array[] = [];
    const bU: Uint8Array[] = [];
    A.on("update", (u: Uint8Array, o: unknown) => {
      if (o === LOCAL_ORIGIN) aU.push(u);
    });
    B.on("update", (u: Uint8Array, o: unknown) => {
      if (o === LOCAL_ORIGIN) bU.push(u);
    });

    // A inserts "X" after "Hello" (offset 5); B appends "Z" at the end (offset 11).
    reconcile(design([textNode("t1", [para([run("HelloX world")])])]), A);
    reconcile(design([textNode("t1", [para([run("Hello worldZ")])])]), B);

    for (const u of aU) Y.applyUpdate(B, u);
    for (const u of bU) Y.applyUpdate(A, u);

    const merged = fromDoc(A);
    expect(fromDoc(B)).toEqual(merged); // converge
    // Both insertions present (old whole-array replace would have lost one).
    expect(paraText(merged, "t1", 0)).toBe("HelloX worldZ");
  });

  it("two clients editing DIFFERENT paragraphs of one text node both survive", () => {
    const A = docFrom(design([textNode("t1", [para([run("AAA")]), para([run("BBB")])])]));
    const B = forkDoc(A);
    const aU: Uint8Array[] = [];
    const bU: Uint8Array[] = [];
    A.on("update", (u: Uint8Array, o: unknown) => {
      if (o === LOCAL_ORIGIN) aU.push(u);
    });
    B.on("update", (u: Uint8Array, o: unknown) => {
      if (o === LOCAL_ORIGIN) bU.push(u);
    });

    reconcile(design([textNode("t1", [para([run("AAAx")]), para([run("BBB")])])]), A);
    reconcile(design([textNode("t1", [para([run("AAA")]), para([run("BBBy")])])]), B);

    for (const u of aU) Y.applyUpdate(B, u);
    for (const u of bU) Y.applyUpdate(A, u);

    const merged = fromDoc(A);
    expect(fromDoc(B)).toEqual(merged);
    expect(paraText(merged, "t1", 0)).toBe("AAAx");
    expect(paraText(merged, "t1", 1)).toBe("BBBy");
  });

  it("concurrent insert of the same char-region from both ends keeps both runs of text", () => {
    // Both prepend to a one-paragraph node: A "1-", B "2-". Yjs orders the two
    // concurrent inserts deterministically; both texts survive, neither is lost.
    const A = docFrom(design([textNode("t1", [para([run("base")])])]));
    const B = forkDoc(A);
    const aU: Uint8Array[] = [];
    const bU: Uint8Array[] = [];
    A.on("update", (u: Uint8Array, o: unknown) => {
      if (o === LOCAL_ORIGIN) aU.push(u);
    });
    B.on("update", (u: Uint8Array, o: unknown) => {
      if (o === LOCAL_ORIGIN) bU.push(u);
    });

    reconcile(design([textNode("t1", [para([run("1-base")])])]), A);
    reconcile(design([textNode("t1", [para([run("2-base")])])]), B);

    for (const u of aU) Y.applyUpdate(B, u);
    for (const u of bU) Y.applyUpdate(A, u);

    const merged = fromDoc(A);
    expect(fromDoc(B)).toEqual(merged);
    const txt = paraText(merged, "t1", 0);
    expect(txt).toContain("1-");
    expect(txt).toContain("2-");
    expect(txt).toContain("base");
  });
});

describe("rich-text minimal ops", () => {
  it("editing one paragraph leaves a sibling paragraph's Y.Text untouched", () => {
    const file = design([textNode("t1", [para([run("AAA")]), para([run("BBB")])])]);
    const doc = docFrom(file);

    // Find the sibling (para 1) runs Y.Text instance up front.
    const root = doc.getMap("design");
    const pages = root.get("pages") as Y.Array<unknown>;
    const node = (pages.get(0) as Y.Map<unknown>).get("children") as Y.Array<unknown>;
    const t1 = node.get(0) as Y.Map<unknown>;
    const contentArr = t1.get("content") as Y.Array<unknown>;
    const siblingText = (contentArr.get(1) as Y.Map<unknown>).get("runs") as Y.Text;

    const changed = new Set<unknown>();
    root.observeDeep((events) => {
      for (const e of events) changed.add(e.target);
    });

    // Type into paragraph 0 only.
    reconcile(design([textNode("t1", [para([run("AAAz")]), para([run("BBB")])])]), doc);

    // The sibling paragraph's Y.Text is the same instance and was NOT in the
    // change set (no op rewrote it).
    expect((contentArr.get(1) as Y.Map<unknown>).get("runs")).toBe(siblingText);
    expect(changed.has(siblingText)).toBe(false);
    expect(siblingText.toString()).toBe("BBB");
  });
});

describe("rich-text hostile/corrupt __runs stash (trust boundary)", () => {
  function paraMap(doc: Y.Doc): Y.Map<unknown> {
    const root = doc.getMap("design");
    const pages = root.get("pages") as Y.Array<unknown>;
    const node = (pages.get(0) as Y.Map<unknown>).get("children") as Y.Array<unknown>;
    return ((node.get(0) as Y.Map<unknown>).get("content") as Y.Array<unknown>).get(0) as Y.Map<unknown>;
  }

  it("a corrupt/hostile stash degrades to an empty paragraph, never malformed runs", () => {
    // A non-canonical paragraph (empty run) -> runs stashed as JSON.
    const file = design([textNode("t1", [para([run("", { fontSize: 24 })])])]);
    const doc = docFrom(file);
    const pmap = paraMap(doc);
    expect(typeof pmap.get("__runs")).toBe("string"); // sanity: a stash exists

    // The relay forwards Yjs updates opaquely; a hostile peer could write any of
    // these. fromDoc must NOT surface a malformed run (which would crash the
    // non-defensive text engine on run.text.split for every collaborator).
    for (const bad of ["[null]", "[42]", "[{}]", '["x"]', '[{"text":5}]', "{}", "42"]) {
      pmap.set("__runs", bad);
      const out = contentOf(fromDoc(doc), "t1")[0];
      expect(out.runs).toEqual([]);
    }

    // A well-formed stash still restores verbatim.
    pmap.set("__runs", JSON.stringify([{ text: "", style: { fontSize: 24 } }]));
    expect(contentOf(fromDoc(doc), "t1")[0].runs).toEqual([{ text: "", style: { fontSize: 24 } }]);
  });
});

describe("rich-text style-only edit (format pass)", () => {
  it("applying a style to a sub-range with no text change reconciles and round-trips", () => {
    const file = design([textNode("t1", [para([run("Hello", { fontSize: 24 })])])]);
    const doc = docFrom(file);

    // Underline the last 3 chars: text unchanged, runs split 2/3.
    const next = design([
      textNode("t1", [para([run("He", { fontSize: 24 }), run("llo", { fontSize: 24, decoration: ["underline"] })])]),
    ]);
    reconcile(next, doc);

    const out = fromDoc(doc);
    expect(out).toEqual(next);
    const runs = contentOf(out, "t1")[0].runs;
    expect(runs.map((r) => r.text)).toEqual(["He", "llo"]);
    expect(runs[1].style.decoration).toEqual(["underline"]);
  });
});

// Regression tests for the adversarial-review findings: non-canonical paragraph
// shapes (empty runs, adjacent identical-payload runs) that a naive Y.Text delta
// would corrupt. These round-trip via the verbatim runs stash. Every case also
// asserts idempotency (a second identical reconcile emits zero Yjs ops), since
// the stash write must be value-compare guarded.
function reconcileIsNoOp(file: DesignFile, doc: Y.Doc): boolean {
  let touched = false;
  const off = (u: unknown, o: unknown) => {
    void u;
    void o;
    touched = true;
  };
  doc.on("update", off);
  reconcile(file, doc);
  doc.off("update", off);
  return !touched;
}

describe("rich-text non-canonical paragraphs (round-trip fidelity)", () => {
  it("interior empty run carrying a distinct style survives the round-trip", () => {
    const file = design([
      textNode("t1", [
        para([run("Hello", { fontSize: 24 }), run("", { fontSize: 28, decoration: ["underline"] }), run("world", { fontSize: 24 })]),
      ]),
    ]);
    const doc = docFrom(file);
    expect(fromDoc(doc)).toEqual(file);
    expect(reconcileIsNoOp(file, doc)).toBe(true); // idempotent
  });

  it("adjacent runs with IDENTICAL payload keep their boundaries (no coalesce)", () => {
    // The old delta path merged these into one run "Hello world".
    const file = design([
      textNode("t1", [para([run("Hello", { fontSize: 24 }), run(" ", { fontSize: 24 }), run("world", { fontSize: 24 })])]),
    ]);
    const doc = docFrom(file);
    const out = fromDoc(doc);
    expect(out).toEqual(file);
    expect(contentOf(out, "t1")[0].runs.map((r) => r.text)).toEqual(["Hello", " ", "world"]);
    expect(reconcileIsNoOp(file, doc)).toBe(true);
  });

  it("multiple empty runs with distinct styles all survive", () => {
    const file = design([
      textNode("t1", [para([run("", { fontSize: 24 }), run("", { fontSize: 48, decoration: ["underline"] })])]),
    ]);
    const doc = docFrom(file);
    expect(fromDoc(doc)).toEqual(file);
    expect(contentOf(fromDoc(doc), "t1")[0].runs).toHaveLength(2);
    expect(reconcileIsNoOp(file, doc)).toBe(true);
  });

  it("leading empty run alongside a text run survives (mixed empty+text)", () => {
    const file = design([textNode("t1", [para([run("", { fontSize: 28 }), run("hi", { fontSize: 24 })])])]);
    const doc = docFrom(file);
    expect(fromDoc(doc)).toEqual(file);
    expect(reconcileIsNoOp(file, doc)).toBe(true);
  });

  it("adjacent identical-payload runs with charStyleId keep their boundary", () => {
    const file = design([
      textNode("t1", [
        para([
          { text: "foo", style: { fontSize: 24 }, charStyleId: "cs-1" },
          { text: "bar", style: { fontSize: 24 }, charStyleId: "cs-1" },
        ]),
      ]),
    ]);
    const doc = docFrom(file);
    expect(fromDoc(doc)).toEqual(file);
    expect(contentOf(fromDoc(doc), "t1")[0].runs.map((r) => r.text)).toEqual(["foo", "bar"]);
    expect(reconcileIsNoOp(file, doc)).toBe(true);
  });

  it("re-canonicalizes: a non-canonical paragraph edited to canonical regains char-merge", () => {
    // Brand recolor leaves two adjacent identical-payload runs (non-canonical,
    // stashed). The user then types, coalescing to one run (canonical): the
    // representation flips to the Y.Text path and the stash is dropped.
    const doc = docFrom(design([textNode("t1", [para([run("ab", { fontSize: 24 }), run("cd", { fontSize: 24 })])])]));
    // Sanity: stored as a stash (non-canonical), Y.Text empty.
    const root = doc.getMap("design");
    const pages = root.get("pages") as Y.Array<unknown>;
    const node = (pages.get(0) as Y.Map<unknown>).get("children") as Y.Array<unknown>;
    const pmap = ((node.get(0) as Y.Map<unknown>).get("content") as Y.Array<unknown>).get(0) as Y.Map<unknown>;
    expect(typeof pmap.get("__runs")).toBe("string");
    expect((pmap.get("runs") as Y.Text).toString()).toBe("");

    // Edit to a single canonical run.
    reconcile(design([textNode("t1", [para([run("abXcd", { fontSize: 24 })])])]), doc);
    expect(pmap.has("__runs")).toBe(false);
    expect((pmap.get("runs") as Y.Text).toString()).toBe("abXcd");
    expect(contentOf(fromDoc(doc), "t1")[0].runs).toEqual([{ text: "abXcd", style: { fontSize: 24 } }]);
  });

  it("does not clobber a peer's blank-line restyle trapped inside a multi-paragraph edit", () => {
    // The finding: an unguarded stash set, when a blank paragraph is sandwiched
    // between two paragraphs another client edits, last-writer-wins over the
    // peer's concurrent restyle. The value-compare guard prevents the clobber.
    const base = design([
      textNode("t1", [para([run("AAA")]), para([run("", { fontSize: 99 })]), para([run("CCC")])]),
    ]);
    const A = docFrom(base);
    const B = forkDoc(A);
    const aU: Uint8Array[] = [];
    const bU: Uint8Array[] = [];
    A.on("update", (u: Uint8Array, o: unknown) => {
      if (o === LOCAL_ORIGIN) aU.push(u);
    });
    B.on("update", (u: Uint8Array, o: unknown) => {
      if (o === LOCAL_ORIGIN) bU.push(u);
    });

    // A edits the two surrounding paragraphs (blank line untouched in intent).
    reconcile(design([textNode("t1", [para([run("AAAx")]), para([run("", { fontSize: 99 })]), para([run("CCCy")])])]), A);
    // B restyles ONLY the blank line.
    reconcile(design([textNode("t1", [para([run("AAA")]), para([run("", { fontSize: 200 })]), para([run("CCC")])])]), B);

    for (const u of aU) Y.applyUpdate(B, u);
    for (const u of bU) Y.applyUpdate(A, u);

    const merged = fromDoc(A);
    expect(fromDoc(B)).toEqual(merged); // converge
    // B's restyle of the blank line survived (A's no-op stash write emitted nothing).
    expect(contentOf(merged, "t1")[1].runs[0].style.fontSize).toBe(200);
  });
});
