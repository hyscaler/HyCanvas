import { describe, it, expect } from "vitest";
import { plainToRichText } from "../model";
import type { DocBlock } from "../model";
import { docOutline, docStats, blockText } from "../stats";

function heading(id: string, level: 1 | 2 | 3, text: string): DocBlock {
  return { id, type: "heading", level, text: plainToRichText(text) };
}
function para(id: string, text: string): DocBlock {
  return { id, type: "paragraph", text: plainToRichText(text) };
}

describe("docOutline", () => {
  it("extracts headings in order with levels and slugs", () => {
    const blocks: DocBlock[] = [
      heading("h1", 1, "Getting Started"),
      para("p1", "intro text"),
      heading("h2", 2, "Install & Setup"),
      heading("h3", 2, "Install & Setup"), // duplicate title -> unique slug
    ];
    const out = docOutline(blocks);
    expect(out.map((o) => o.text)).toEqual(["Getting Started", "Install & Setup", "Install & Setup"]);
    expect(out.map((o) => o.level)).toEqual([1, 2, 2]);
    expect(out[0].slug).toBe("getting-started");
    expect(out[1].slug).toBe("install-setup");
    expect(out[2].slug).toBe("install-setup-1"); // de-duplicated
  });

  it("ignores non-heading blocks", () => {
    expect(docOutline([para("p", "just a paragraph")])).toEqual([]);
  });
});

describe("docStats", () => {
  it("counts words, characters, headings and reading time", () => {
    const blocks: DocBlock[] = [
      heading("h", 1, "Title Here"), // 2 words
      para("p", "one two three four five"), // 5 words
      { id: "l", type: "list", style: "bullet", items: [{ id: "i1", text: plainToRichText("alpha beta") }] }, // 2 words
    ];
    const s = docStats(blocks);
    expect(s.words).toBe(9);
    expect(s.headings).toBe(1);
    expect(s.blocks).toBe(3);
    expect(s.charactersNoSpaces).toBeLessThan(s.characters);
    expect(s.readingMinutes).toBe(1); // small doc => at least 1 minute
  });

  it("reading time scales with word count", () => {
    const big = Array.from({ length: 50 }, (_, i) => para(`p${i}`, "word ".repeat(20).trim()));
    const s = docStats(big); // 50 * 20 = 1000 words
    expect(s.words).toBe(1000);
    expect(s.readingMinutes).toBe(5); // 1000 / 200
  });

  it("empty document reads as zero", () => {
    const s = docStats([]);
    expect(s.words).toBe(0);
    expect(s.readingMinutes).toBe(0);
  });

  it("blockText pulls text from list, table, and code blocks", () => {
    expect(blockText({ id: "c", type: "code", code: "let x = 1" })).toBe("let x = 1");
    const table: DocBlock = {
      id: "t", type: "table",
      columns: [{ id: "c1" }, { id: "c2" }],
      rows: [{ id: "r1", cells: [plainToRichText("a"), plainToRichText("b")] }],
    };
    expect(blockText(table)).toBe("a b");
  });
});
