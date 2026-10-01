import { describe, expect, it } from "vitest";
import { cutBlocks, hasMarkdown, parseChatMarkdown, parseInlines } from "./chatMarkdown";

describe("parseInlines", () => {
  it("reads bold, italic, code and leaves the rest as text", () => {
    expect(parseInlines("The note says: **Tranche plan** in `four` parts, _really_.")).toEqual([
      { kind: "text", text: "The note says: " },
      { kind: "bold", text: "Tranche plan" },
      { kind: "text", text: " in " },
      { kind: "code", text: "four" },
      { kind: "text", text: " parts, " },
      { kind: "italic", text: "really" },
      { kind: "text", text: "." },
    ]);
  });
  it("links only to the web, and keeps a sentence's full stop out of a bare URL", () => {
    expect(parseInlines("See [the docs](https://example.test/a) or https://example.test/b.")).toEqual([
      { kind: "text", text: "See " },
      { kind: "link", text: "the docs", href: "https://example.test/a" },
      { kind: "text", text: " or " },
      { kind: "link", text: "https://example.test/b", href: "https://example.test/b" },
      { kind: "text", text: "." },
    ]);
    expect(parseInlines("[x](javascript:alert(1))")).toEqual([{ kind: "text", text: "[x](javascript:alert(1))" }]);
  });
  it("does not read a lone asterisk, spaced asterisks or snake_case as markup", () => {
    expect(parseInlines("2 * 3 and snake_case_name")).toEqual([{ kind: "text", text: "2 * 3 and snake_case_name" }]);
    expect(parseInlines("2 * 3 * 4 is 24")).toEqual([{ kind: "text", text: "2 * 3 * 4 is 24" }]);
    expect(parseInlines("**bold** and *it*")).toEqual([{ kind: "bold", text: "bold" }, { kind: "text", text: " and " }, { kind: "italic", text: "it" }]);
  });
});

describe("parseChatMarkdown", () => {
  it("splits paragraphs, headings, lists and fenced code", () => {
    const blocks = parseChatMarkdown("## Plan\nFirst line\nsecond line\n\n- one\n- **two**\n\n1. a\n2. b\n\n```\ncode here\n```\nTail");
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "list", "list", "code", "paragraph"]);
    expect(blocks[1]).toEqual({ kind: "paragraph", inlines: [{ kind: "text", text: "First line\nsecond line" }] });
    expect(blocks[2]).toMatchObject({ ordered: false, items: [[{ kind: "text", text: "one" }], [{ kind: "bold", text: "two" }]] });
    expect(blocks[3]).toMatchObject({ ordered: true });
    expect(blocks[4]).toEqual({ kind: "code", text: "code here" });
  });
  it("renders plain prose as one paragraph", () => {
    expect(parseChatMarkdown("Just a sentence.")).toEqual([{ kind: "paragraph", inlines: [{ kind: "text", text: "Just a sentence." }] }]);
    expect(hasMarkdown("Just a sentence.")).toBe(false);
    expect(hasMarkdown("- a bullet")).toBe(true);
  });
});

describe("cutBlocks", () => {
  it("keeps formatting while showing only the first characters", () => {
    const blocks = parseChatMarkdown("The **plan**:\n\n- one\n- two");
    const cut = cutBlocks(blocks, 7);
    expect(cut).toEqual([{ kind: "paragraph", inlines: [{ kind: "text", text: "The " }, { kind: "bold", text: "pla" }] }]);
    // "The plan:" is nine visible characters; two more reach into the list.
    const more = cutBlocks(blocks, 11);
    expect(more[1]).toMatchObject({ kind: "list", items: [[{ kind: "text", text: "on" }]] });
    expect(cutBlocks(blocks, 1000)).toEqual(blocks);
  });
});
