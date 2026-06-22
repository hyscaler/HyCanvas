import { describe, expect, it } from "vitest";
import { validate } from "@hc/schema";
import { blocksToDesign, designToDoc } from "../convert";
import {
  newHeading,
  newImage,
  newList,
  newListItem,
  newParagraph,
  newTable,
  newTableRow,
  plainToRichText,
  richTextToPlain,
  type DocBlock,
  type HeadingBlock,
} from "../model";

function sampleDoc(): DocBlock[] {
  return [
    newHeading(1, "Section One"),
    newParagraph("Intro paragraph for section one."),
    newList("bullet", [newListItem("point a"), newListItem("point b")]),
    newHeading(1, "Section Two"),
    newParagraph("Section two body."),
    newImage({ assetId: "asset-1", url: "img.png", alt: "diagram" }),
  ];
}

describe("blocksToDesign", () => {
  it("splits at h1 into one page per section", () => {
    const design = blocksToDesign(sampleDoc());
    expect(design.pages).toHaveLength(2);
  });

  it("produces a valid DesignFile", () => {
    const design = blocksToDesign(sampleDoc());
    const result = validate(design);
    expect(result.ok).toBe(true);
  });

  it("sets meta.kind to design", () => {
    const design = blocksToDesign(sampleDoc());
    expect((design.meta as any).kind).toBe("design");
  });

  it("respects a custom split level (splits at each h2)", () => {
    const blocks = [
      newHeading(2, "A"),
      newParagraph("a body"),
      newHeading(2, "B"),
      newParagraph("b body"),
    ];
    const design = blocksToDesign(blocks, { splitLevel: 2 });
    // Two h2 sections -> two pages.
    expect(design.pages).toHaveLength(2);
  });

  it("does not split at heading levels other than the chosen one", () => {
    const blocks = [
      newHeading(1, "Doc"),
      newHeading(2, "A"),
      newParagraph("a body"),
      newHeading(3, "B"),
      newParagraph("b body"),
    ];
    const design = blocksToDesign(blocks, { splitLevel: 1 });
    // Only the single h1 starts content; h2/h3 do not split.
    expect(design.pages).toHaveLength(1);
  });

  it("falls back to a single page when there are no headings", () => {
    const design = blocksToDesign([newParagraph("just text"), newParagraph("more")]);
    expect(design.pages).toHaveLength(1);
    expect(design.pages[0].children.length).toBeGreaterThan(0);
  });

  it("stacks node y coordinates increasing down each page", () => {
    const design = blocksToDesign(sampleDoc());
    const firstPage = design.pages[0];
    const ys = firstPage.children.map((n) => n.transform.y);
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i]).toBeGreaterThan(ys[i - 1]);
    }
  });

  it("maps an image block to an image node referencing the asset", () => {
    const design = blocksToDesign([newImage({ assetId: "asset-9", url: "x.png" })]);
    const img = design.pages[0].children.find((n) => n.type === "image") as any;
    expect(img).toBeTruthy();
    expect(img.source.assetId).toBe("asset-9");
  });

  it("maps a table block to a valid table node", () => {
    const table = newTable(
      [{ align: "left" }, { align: "left" }],
      [
        newTableRow([plainToRichText("h1"), plainToRichText("h2")]),
        newTableRow([plainToRichText("v1"), plainToRichText("v2")]),
      ],
      true,
    );
    const design = blocksToDesign([table]);
    const result = validate(design);
    expect(result.ok).toBe(true);
    const node = design.pages[0].children.find((n) => n.type === "table") as any;
    expect(node.rows).toBe(2);
    expect(node.cols).toBe(2);
    expect(node.cells).toHaveLength(4);
  });
});

describe("designToDoc", () => {
  it("reads large text nodes back as headings and body as paragraphs", () => {
    const design = blocksToDesign([newHeading(1, "Big Title"), newParagraph("body text here")]);
    const blocks = designToDoc(design);
    expect(blocks[0].type).toBe("heading");
    expect((blocks[0] as HeadingBlock).level).toBe(1);
    expect(richTextToPlain((blocks[0] as any).text)).toBe("Big Title");
    expect(blocks[1].type).toBe("paragraph");
  });

  it("reverses image nodes to image blocks", () => {
    const design = blocksToDesign([newImage({ assetId: "a1", url: "p.png" })]);
    const blocks = designToDoc(design);
    expect(blocks[0].type).toBe("image");
    expect((blocks[0] as any).assetId).toBe("a1");
  });

  it("reverses table nodes to table blocks", () => {
    const table = newTable(
      [{ align: "left" }, { align: "left" }],
      [
        newTableRow([plainToRichText("a"), plainToRichText("b")]),
        newTableRow([plainToRichText("c"), plainToRichText("d")]),
      ],
      true,
    );
    const design = blocksToDesign([table]);
    const blocks = designToDoc(design);
    const t = blocks.find((b) => b.type === "table") as any;
    expect(t).toBeTruthy();
    expect(t.rows).toHaveLength(2);
    expect(richTextToPlain(t.rows[0].cells[0])).toBe("a");
  });
});
