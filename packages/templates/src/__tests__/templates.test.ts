import { describe, it, expect } from "vitest";
import { createBlankDesign, createNode, type DesignFile, type Node } from "@hc/schema";
import type { AttributionEntry } from "@hc/stock";
import {
  applyStyle,
  applyTemplateIntoExisting,
  applyTemplateToNew,
  deepCopyDesign,
  extractFillableFields,
  extractStyle,
  filtersToTemplateQuery,
  mergeAttributions,
  readLockedRegions,
  remapAttributions,
  remapLockedRegions,
  searchTemplates,
  templateMatches,
  withLockedRegions,
  validateFill,
  applyFill,
  validateFillRow,
  type FillableField,
  type StyleDescriptor,
  type Template,
} from "../index";

function rect(id: string, hex: { r: number; g: number; b: number }): Node {
  return createNode("shape", {
    id,
    shape: "rect",
    size: { width: 100, height: 50 },
    fills: [{ type: "solid", color: { srgb: { r: hex.r, g: hex.g, b: hex.b, a: 1 } } }],
  } as Partial<Node>);
}

function textNode(id: string, runs: { text: string; size: number; family: string; wght?: number }[]): Node {
  return createNode("text", {
    id,
    content: [{
      runs: runs.map((r) => ({ text: r.text, style: { fontFamily: r.family, fontStyle: "Regular", fontSize: r.size, axes: { wght: r.wght ?? 400 }, fill: { type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } } } })),
      style: { align: "left", direction: "auto" },
    }],
  } as Partial<Node>);
}

function design(...nodes: Node[]): DesignFile {
  const d = createBlankDesign({ title: "T" });
  d.pages[0].children = nodes;
  return d;
}

const gen = () => { let i = 0; return () => `c-${++i}`; };

describe("deepCopyDesign (FR-5, FR-14, AC-2, AC-8)", () => {
  it("regenerates design, page, and node ids and decouples from the source", () => {
    const src = design(rect("a", { r: 1, g: 0, b: 0 }));
    const grp = createNode("group", { id: "g", children: [rect("child", { r: 0, g: 1, b: 0 })], size: { width: 200, height: 200 } } as Partial<Node>);
    src.pages[0].children.push(grp);
    const { file, idMap } = deepCopyDesign(src, { idGen: gen() });
    expect(file.id).not.toBe(src.id);
    expect(file.pages[0].id).not.toBe(src.pages[0].id);
    expect(file.pages[0].children[0].id).not.toBe("a");
    expect(idMap.get("a")).toBe(file.pages[0].children[0].id);
    // mutating the copy does not touch the source
    file.pages[0].children[0].opacity = 0.1;
    expect(src.pages[0].children[0].opacity).toBe(1);
  });
});

describe("extractStyle / applyStyle (FR-7, FR-9, AC-3)", () => {
  it("extracts a palette and ranks typography roles by size", () => {
    const d = design(
      rect("r1", { r: 1, g: 0, b: 0 }),
      rect("r2", { r: 1, g: 0, b: 0 }),
      rect("r3", { r: 0, g: 0, b: 1 }),
      textNode("t", [{ text: "Big", size: 48, family: "Poppins", wght: 700 }, { text: "small", size: 16, family: "Inter" }]),
    );
    const style = extractStyle(d);
    expect(style.palette[0]).toBe("#ff0000"); // most frequent
    expect(style.palette).toContain("#0000ff");
    expect(style.typography[0]).toMatchObject({ role: "heading", family: "Poppins", weight: 700 });
    expect(style.typography.find((t) => t.role === "subheading")?.family).toBe("Inter");
  });

  it("re-skins colors and typography while keeping content, without mutating input", () => {
    const d = design(rect("r1", { r: 1, g: 0, b: 0 }), textNode("t", [{ text: "Hi", size: 40, family: "Inter" }]));
    const style: StyleDescriptor = {
      palette: ["#00aa00"],
      typography: [{ role: "heading", family: "Georgia", weight: 800 }, { role: "body", family: "Georgia", weight: 400 }],
    };
    const res = applyStyle(d, style);
    expect(res.colorsRemapped).toBeGreaterThan(0);
    const fill = (res.file.pages[0].children[0] as unknown as { fills: { color: { srgb: { g: number } } }[] }).fills[0];
    expect(fill.color.srgb.g).toBeCloseTo(2 / 3, 1); // #00aa00 green channel ~0.667
    const run = (res.file.pages[0].children[1] as unknown as { content: { runs: { text: string; style: { fontFamily: string } }[] }[] }).content[0].runs[0];
    expect(run.style.fontFamily).toBe("Georgia");
    expect(run.text).toBe("Hi"); // copy intact
    // source unchanged
    expect((d.pages[0].children[0] as unknown as { fills: { color: { srgb: { r: number } } }[] }).fills[0].color.srgb.r).toBe(1);
  });
});

describe("fillable fields (FR-10)", () => {
  it("extracts fields by node kind and drops missing nodes", () => {
    const d = design(textNode("t", [{ text: "x", size: 20, family: "Inter" }]), rect("img", { r: 0, g: 0, b: 0 }));
    const { fields, dropped } = extractFillableFields(d, [
      { nodeId: "t", label: "Headline", constraints: { maxChars: 5 } },
      { nodeId: "missing", label: "Nope" },
    ]);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ nodeId: "t", kind: "text", label: "Headline" });
    expect(dropped).toEqual(["missing"]);
  });

  it("validates constraints at fill time", () => {
    const field: FillableField = { nodeId: "t", kind: "text", label: "Headline", constraints: { maxChars: 5, required: true } };
    expect(validateFill(field, { text: "hello" }).ok).toBe(true);
    expect(validateFill(field, { text: "too long" }).ok).toBe(false);
    expect(validateFill(field, { present: false }).ok).toBe(false);
    const img: FillableField = { nodeId: "i", kind: "image", label: "Photo", constraints: { aspect: 1.5 } };
    expect(validateFill(img, { aspect: 1.5 }).ok).toBe(true);
    expect(validateFill(img, { aspect: 1.0 }).ok).toBe(false);
  });
});

describe("applyFill / validateFillRow", () => {
  function imageNode(id: string): Node {
    return createNode("image", { id, source: { assetId: "old-asset", naturalWidth: 800, naturalHeight: 600 }, fit: "cover" } as Partial<Node>);
  }

  it("lists fields then a fill substitutes text and image into a copy", () => {
    const d = design(textNode("name", [{ text: "placeholder", size: 24, family: "Inter" }]), imageNode("photo"));
    const { fields } = extractFillableFields(d, [
      { nodeId: "name", label: "Name" },
      { nodeId: "photo", label: "Photo" },
    ]);
    expect(fields.map((f) => f.kind)).toEqual(["text", "image"]);

    const res = applyFill(d, { name: { text: "Ada Lovelace" }, photo: { imageUrl: "https://cdn/x.png" } });
    expect(res.filled.sort()).toEqual(["name", "photo"]);
    const filledText = (res.file.pages[0].children[0] as unknown as { content: { runs: { text: string; style: unknown }[] }[] }).content[0].runs[0];
    expect(filledText.text).toBe("Ada Lovelace");
    expect(filledText.style).toBeTruthy(); // run style preserved
    const filledImg = res.file.pages[0].children[1] as unknown as { source: { assetId: string } };
    expect(filledImg.source.assetId).toBe("https://cdn/x.png");
    // source design untouched
    expect((d.pages[0].children[0] as unknown as { content: { runs: { text: string }[] }[] }).content[0].runs[0].text).toBe("placeholder");
    expect((d.pages[0].children[1] as unknown as { source: { assetId: string } }).source.assetId).toBe("old-asset");
  });

  it("missing values leave defaults; unknown node ids report missing", () => {
    const d = design(textNode("name", [{ text: "default", size: 24, family: "Inter" }]));
    const res = applyFill(d, { name: { text: "" }, gone: { text: "x" } });
    expect(res.filled).toEqual([]);
    expect(res.missing).toEqual(["gone"]);
    expect((res.file.pages[0].children[0] as unknown as { content: { runs: { text: string }[] }[] }).content[0].runs[0].text).toBe("default");
  });

  it("validateFillRow rejects bad input (required + maxChars)", () => {
    const fields: FillableField[] = [
      { nodeId: "name", kind: "text", label: "Name", constraints: { required: true, maxChars: 5 } },
    ];
    expect(validateFillRow(fields, { name: { text: "Ada" } }).ok).toBe(true);
    expect(validateFillRow(fields, {}).ok).toBe(false); // required missing
    expect(validateFillRow(fields, { name: { text: "too long here" } }).ok).toBe(false); // maxChars
  });

  it("fills a table-cell text field (TextRun[] content shape, not Paragraph)", () => {
    // A node whose `content` is a TextRun[] (the TableCell shape: runs carry
    // `text` directly, with no `.runs` wrapper). applyFill must detect this and
    // substitute text in place rather than producing a malformed cell.
    const cellNode = createNode("text", { id: "cell" } as Partial<Node>) as unknown as {
      content: Array<{ text: string; fontId: string; fontSize: number; weight: number; color?: unknown }>;
    } & Node;
    cellNode.content = [
      { text: "placeholder", fontId: "system", fontSize: 14, weight: 400, color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } },
    ];
    const d = design(cellNode as Node);

    const res = applyFill(d, { cell: { text: "Q1 Revenue" } });
    expect(res.filled).toEqual(["cell"]);
    const filled = (res.file.pages[0].children[0] as unknown as {
      content: Array<{ text: string; fontId: string; weight: number; color?: unknown }>;
    }).content;
    expect(filled).toHaveLength(1);
    expect(filled[0].text).toBe("Q1 Revenue");
    // run style is preserved (no `.runs` wrapper introduced)
    expect(filled[0].fontId).toBe("system");
    expect(filled[0].weight).toBe(400);
    expect(filled[0].color).toBeTruthy();
    expect("runs" in filled[0]).toBe(false);
  });
});

describe("attribution merge (FR-15, AC-9)", () => {
  const a = (assetId: string, nodeIds: string[]): AttributionEntry => ({ assetId, source: "stock", attributionText: `by ${assetId}`, nodeIds });

  it("dedupes by asset and unions node ids", () => {
    const merged = mergeAttributions([a("s1", ["n1"])], [a("s1", ["n2"]), a("s2", ["n3"])]);
    expect(merged).toHaveLength(2);
    expect(merged.find((e) => e.assetId === "s1")!.nodeIds.sort()).toEqual(["n1", "n2"]);
  });

  it("remaps node ids through a deep-copy id map", () => {
    const map = new Map([["n1", "x1"]]);
    expect(remapAttributions([a("s1", ["n1", "n9"])], map)[0].nodeIds).toEqual(["x1", "n9"]);
  });
});

describe("apply pipelines (FR-5, FR-6, AC-2, AC-9)", () => {
  it("apply-to-new creates a decoupled design with remapped attributions", () => {
    const tpl = design(rect("a", { r: 1, g: 0, b: 0 }));
    const attrs: AttributionEntry[] = [{ assetId: "s1", source: "stock", attributionText: "by s1", nodeIds: ["a"] }];
    const res = applyTemplateToNew(tpl, attrs, { idGen: gen() });
    expect(res.file.id).not.toBe(tpl.id);
    const newNodeId = res.file.pages[0].children[0].id;
    expect(res.attributions[0].nodeIds).toEqual([newNodeId]);
  });

  it("apply-into-existing appends template pages without mutating the target", () => {
    const target = design(rect("t1", { r: 0, g: 0, b: 0 }));
    const tpl = design(rect("a", { r: 1, g: 0, b: 0 }));
    const res = applyTemplateIntoExisting(target, tpl, [], { idGen: gen() });
    expect(res.file.pages).toHaveLength(2);
    expect(target.pages).toHaveLength(1); // unchanged
  });
});

describe("template search (FR-2, FR-3, AC-1)", () => {
  function tpl(id: string, over: Partial<Template> = {}): Template {
    return {
      id, title: id, visibility: "public", ownerId: "u", workspaceId: null,
      categories: [], tags: [], style: { palette: [], typography: [] },
      format: { width: 1080, height: 1080, unit: "px" }, pageCount: 1, previewUrls: [],
      designFileKey: "k", fillableFields: [], attributions: [], version: 1,
      createdAt: "t", updatedAt: "t", ...over,
    };
  }
  const templates = [
    tpl("sale", { title: "Instagram Sale Post", tags: ["sale"], categories: ["social"], style: { palette: ["#ff2200"], typography: [], styleTags: ["bold"] } }),
    tpl("calm", { title: "Calm Quote", categories: ["social"], style: { palette: ["#2244ff"], typography: [], styleTags: ["minimal"] } }),
    tpl("mine", { title: "My Draft", visibility: "personal", workspaceId: "w1" }),
    tpl("other", { title: "Other Draft", visibility: "personal", workspaceId: "w2" }),
  ];

  it("maps filter params and ranks text relevance", () => {
    const q = filtersToTemplateQuery({ q: "sale", color: "#ff0000", style: "bold", category: "social" });
    expect(q).toMatchObject({ text: "sale", color: "#ff0000", style: ["bold"], category: ["social"] });
    expect(searchTemplates(templates, { text: "sale" })[0].id).toBe("sale");
  });

  it("filters by color tolerance, style tag, and category", () => {
    expect(searchTemplates(templates, { color: "#ee1100" }).map((t) => t.id)).toContain("sale");
    expect(searchTemplates(templates, { style: "minimal" }).map((t) => t.id)).toEqual(["calm"]);
    expect(searchTemplates(templates, { category: "social" }).map((t) => t.id).sort()).toEqual(["calm", "sale"]);
  });

  it("enforces visibility scope: personal templates do not leak across workspaces", () => {
    expect(templateMatches(templates[2], { scope: "all", workspaceId: "w1" })).toBe(true);
    expect(templateMatches(templates[2], { scope: "all", workspaceId: "w2" })).toBe(false);
    expect(searchTemplates(templates, { scope: "public" }).map((t) => t.id).sort()).toEqual(["calm", "sale"]);
    expect(searchTemplates(templates, { scope: "personal", workspaceId: "w1" }).map((t) => t.id)).toEqual(["mine"]);
  });
});

describe("locked regions", () => {
  it("remaps locked-region ids through the deep-copy id map and writes them to meta", () => {
    const tpl = createBlankDesign({ title: "Brand template" });
    tpl.pages[0].children = [
      createNode("shape", { id: "logo-box", shape: "rect", transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 50, height: 50 } } as Partial<Node>),
      createNode("text", { id: "headline", transform: { x: 0, y: 60, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 200, height: 40 }, content: [{ align: "left", runs: [{ text: "Hi", style: { fontSize: 20 } }] }] } as Partial<Node>),
    ];
    const { file, idMap } = applyTemplateToNew(tpl);
    const remapped = remapLockedRegions(["logo-box", "missing"], idMap);
    // The logo box maps to its new id; the missing id is dropped.
    expect(remapped).toEqual([idMap.get("logo-box")]);
    const withMeta = withLockedRegions(file, remapped);
    expect(readLockedRegions(withMeta)).toEqual([idMap.get("logo-box")]);
    // Original file unchanged.
    expect(readLockedRegions(file)).toEqual([]);
  });

  it("clears the meta key when there are no locked regions", () => {
    const f = withLockedRegions(createBlankDesign({ title: "x" }), []);
    expect(readLockedRegions(f)).toEqual([]);
    expect(f.meta.brandLockedRegions).toBeUndefined();
  });

  it("instantiating a template with locked regions remaps them onto the new design (AC-4)", () => {
    // A brand template that carries locked regions in its own meta.
    const tpl = withLockedRegions(
      design(
        rect("logo-box", { r: 1, g: 0, b: 0 }),
        rect("free-box", { r: 0, g: 1, b: 0 }),
      ),
      ["logo-box"],
    );
    const { file, idMap } = applyTemplateToNew(tpl, [], { idGen: gen() });
    const newLogoId = idMap.get("logo-box");
    // The new design's locked regions point at the copied node, not the template's id.
    expect(readLockedRegions(file)).toEqual([newLogoId]);
    expect(readLockedRegions(file)).not.toContain("logo-box");
    // The remapped id actually exists in the new design's node tree.
    const ids = file.pages.flatMap((p) => p.children.map((c) => c.id));
    expect(ids).toContain(newLogoId);
    // The source template is untouched (FR-14).
    expect(readLockedRegions(tpl)).toEqual(["logo-box"]);
  });

  it("appending a template into an existing design merges remapped locked regions (FR-6)", () => {
    const target = withLockedRegions(design(rect("keep", { r: 0, g: 0, b: 1 })), ["keep"]);
    const tpl = withLockedRegions(design(rect("logo-box", { r: 1, g: 0, b: 0 })), ["logo-box"]);
    const { file, idMap } = applyTemplateIntoExisting(target, tpl, [], { idGen: gen() });
    const locked = readLockedRegions(file);
    expect(locked).toContain("keep");
    expect(locked).toContain(idMap.get("logo-box"));
    expect(locked).not.toContain("logo-box");
  });
});
