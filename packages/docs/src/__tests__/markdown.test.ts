import { describe, expect, it } from "vitest";
import { blocksToMarkdown, markdownToBlocks } from "../markdown";
import {
  newCode,
  newDivider,
  newHeading,
  newList,
  newListItem,
  newParagraph,
  newTable,
  newTableRow,
  plainToRichText,
  richTextToPlain,
  type CodeBlock,
  type DocBlock,
  type HeadingBlock,
  type ListBlock,
  type ParagraphBlock,
  type TableBlock,
} from "../model";

function plainOf(b: DocBlock): string {
  return richTextToPlain((b as any).text);
}

describe("blocksToMarkdown", () => {
  it("renders headings at the right level", () => {
    expect(blocksToMarkdown([newHeading(1, "A")])).toBe("# A");
    expect(blocksToMarkdown([newHeading(2, "B")])).toBe("## B");
    expect(blocksToMarkdown([newHeading(3, "C")])).toBe("### C");
  });

  it("renders bullet, numbered, and checklist lists", () => {
    const bullet = newList("bullet", [newListItem("one"), newListItem("two")]);
    expect(blocksToMarkdown([bullet])).toBe("- one\n- two");

    const numbered = newList("numbered", [newListItem("a"), newListItem("b")]);
    expect(blocksToMarkdown([numbered])).toBe("1. a\n2. b");

    const checked = newListItem("done");
    checked.checked = true;
    const checklist = newList("checklist", [newListItem("todo"), checked]);
    expect(blocksToMarkdown([checklist])).toBe("- [ ] todo\n- [x] done");
  });

  it("renders fenced code with language", () => {
    const md = blocksToMarkdown([newCode("const x = 1;", "ts")]);
    expect(md).toBe("```ts\nconst x = 1;\n```");
  });

  it("renders inline marks", () => {
    const p = newParagraph({
      runs: [
        { text: "b", marks: ["bold"] },
        { text: "i", marks: ["italic"] },
        { text: "s", marks: ["strike"] },
        { text: "c", marks: ["code"] },
        { text: "u", marks: ["underline"] },
        { text: "link", link: "https://x.com" },
      ],
    });
    expect(blocksToMarkdown([p])).toBe("**b**_i_~~s~~`c`<u>u</u>[link](https://x.com)");
  });

  it("renders a GFM pipe table", () => {
    const table = newTable(
      [{ align: "left" }, { align: "center" }],
      [
        newTableRow([plainToRichText("H1"), plainToRichText("H2")]),
        newTableRow([plainToRichText("a"), plainToRichText("b")]),
      ],
      true,
    );
    const md = blocksToMarkdown([table]);
    expect(md).toBe("| H1 | H2 |\n| --- | :---: |\n| a | b |");
  });

  it("does NOT emit a --- horizontal rule for a divider", () => {
    const md = blocksToMarkdown([newParagraph("before"), newDivider(), newParagraph("after")]);
    expect(md).not.toMatch(/(^|\n)\s*---\s*(\n|$)/);
    expect(md).not.toContain("\n---\n");
  });

  it("renders images and embeds", () => {
    expect(blocksToMarkdown([{ id: "i", type: "image", assetId: "", url: "u.png", alt: "cat" }])).toBe(
      "![cat](u.png)",
    );
    expect(blocksToMarkdown([{ id: "e", type: "embed", url: "https://e.com" }])).toBe("https://e.com");
  });
});

describe("markdownToBlocks round-trip", () => {
  it("round-trips headings", () => {
    const blocks = markdownToBlocks("# Title\n\n## Sub\n\n### Deep");
    expect(blocks.map((b) => b.type)).toEqual(["heading", "heading", "heading"]);
    expect((blocks[0] as HeadingBlock).level).toBe(1);
    expect((blocks[1] as HeadingBlock).level).toBe(2);
    expect((blocks[2] as HeadingBlock).level).toBe(3);
    expect(plainOf(blocks[0])).toBe("Title");
  });

  it("round-trips paragraphs", () => {
    const md = "First paragraph.\n\nSecond paragraph.";
    const blocks = markdownToBlocks(md);
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "paragraph"]);
    expect(plainOf(blocks[0])).toBe("First paragraph.");
    expect(blocksToMarkdown(blocks)).toBe(md);
  });

  it("round-trips bullet lists", () => {
    const md = "- one\n- two\n- three";
    const blocks = markdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    const list = blocks[0] as ListBlock;
    expect(list.style).toBe("bullet");
    expect(list.items.map((i) => richTextToPlain(i.text))).toEqual(["one", "two", "three"]);
    expect(blocksToMarkdown(blocks)).toBe(md);
  });

  it("round-trips numbered lists", () => {
    const md = "1. a\n2. b";
    const blocks = markdownToBlocks(md);
    expect((blocks[0] as ListBlock).style).toBe("numbered");
    expect(blocksToMarkdown(blocks)).toBe(md);
  });

  it("round-trips checklists with checked state", () => {
    const md = "- [ ] todo\n- [x] done";
    const blocks = markdownToBlocks(md);
    const list = blocks[0] as ListBlock;
    expect(list.style).toBe("checklist");
    expect(list.items[0].checked).toBe(false);
    expect(list.items[1].checked).toBe(true);
    expect(blocksToMarkdown(blocks)).toBe(md);
  });

  it("round-trips fenced code", () => {
    const md = "```ts\nconst x = 1;\nconst y = 2;\n```";
    const blocks = markdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    const code = blocks[0] as CodeBlock;
    expect(code.language).toBe("ts");
    expect(code.code).toBe("const x = 1;\nconst y = 2;");
    expect(blocksToMarkdown(blocks)).toBe(md);
  });

  it("round-trips a table", () => {
    const md = "| H1 | H2 |\n| --- | :---: |\n| a | b |";
    const blocks = markdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    const t = blocks[0] as TableBlock;
    expect(t.columns.map((c) => c.align)).toEqual(["left", "center"]);
    expect(t.rows).toHaveLength(2);
    expect(richTextToPlain(t.rows[1].cells[0])).toBe("a");
    expect(blocksToMarkdown(blocks)).toBe(md);
  });

  it("round-trips inline links and marks", () => {
    const md = "see **bold** and [link](https://x.com) and `code`";
    const blocks = markdownToBlocks(md);
    expect(blocksToMarkdown(blocks)).toBe(md);
    const p = blocks[0] as ParagraphBlock;
    const boldRun = p.text.runs.find((r) => r.marks?.includes("bold"));
    expect(boldRun?.text).toBe("bold");
    const linkRun = p.text.runs.find((r) => r.link);
    expect(linkRun?.link).toBe("https://x.com");
  });

  it("round-trips a bold-inside-link (styled link)", () => {
    const md = "[**bold**](https://x.com)";
    const blocks = markdownToBlocks(md);
    const p = blocks[0] as ParagraphBlock;
    const run = p.text.runs.find((r) => r.link);
    expect(run?.text).toBe("bold");
    expect(run?.link).toBe("https://x.com");
    expect(run?.marks).toContain("bold");
    expect(blocksToMarkdown(blocks)).toBe(md);
  });

  it("parses styled text inside a link as runs carrying the link", () => {
    const blocks = markdownToBlocks("see [a **b** c](https://x.com) end");
    const p = blocks[0] as ParagraphBlock;
    const linked = p.text.runs.filter((r) => r.link === "https://x.com");
    expect(linked.length).toBeGreaterThan(1);
    expect(linked.some((r) => r.marks?.includes("bold") && r.text === "b")).toBe(true);
  });

  it("round-trips an image", () => {
    const md = "![alt text](pic.png)";
    const blocks = markdownToBlocks(md);
    expect(blocks[0].type).toBe("image");
    expect((blocks[0] as any).url).toBe("pic.png");
    expect((blocks[0] as any).alt).toBe("alt text");
    expect(blocksToMarkdown(blocks)).toBe(md);
  });

  it("round-trips a mixed document for headings/lists/code/paragraph", () => {
    const md = ["# Heading", "", "A paragraph.", "", "- item a", "- item b", "", "```js", "x()", "```"].join(
      "\n",
    );
    const blocks = markdownToBlocks(md);
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "list", "code"]);
    expect(blocksToMarkdown(blocks)).toBe(md);
  });
});
