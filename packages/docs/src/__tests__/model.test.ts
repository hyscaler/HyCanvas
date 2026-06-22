import { describe, expect, it } from "vitest";
import {
  convertBlock,
  newCallout,
  newCode,
  newHeading,
  newList,
  newListItem,
  newParagraph,
  newQuote,
  plainToRichText,
  reorderBlocks,
  richTextToPlain,
  type ListBlock,
  type ParagraphBlock,
} from "../model";

describe("RichText helpers", () => {
  it("round-trips plain <-> rich text", () => {
    const rt = plainToRichText("hello world");
    expect(rt.runs).toEqual([{ text: "hello world" }]);
    expect(richTextToPlain(rt)).toBe("hello world");
  });

  it("concatenates multiple runs", () => {
    expect(richTextToPlain({ runs: [{ text: "a" }, { text: "b" }, { text: "c" }] })).toBe("abc");
  });
});

describe("convertBlock", () => {
  it("paragraph -> heading preserves text and id", () => {
    const p = newParagraph("Title text");
    const h = convertBlock(p, "heading");
    expect(h.type).toBe("heading");
    expect(h.id).toBe(p.id);
    expect(richTextToPlain((h as any).text)).toBe("Title text");
    expect((h as any).level).toBe(1);
  });

  it("heading -> quote -> callout preserves text", () => {
    const h = newHeading(2, "Some words");
    const q = convertBlock(h, "quote");
    expect(q.type).toBe("quote");
    expect(richTextToPlain((q as any).text)).toBe("Some words");
    const c = convertBlock(q, "callout");
    expect(c.type).toBe("callout");
    expect((c as any).tone).toBe("info");
    expect(richTextToPlain((c as any).text)).toBe("Some words");
  });

  it("preserves run-level marks across text conversions", () => {
    const p = newParagraph({ runs: [{ text: "bold", marks: ["bold"] }, { text: " plain" }] });
    const h = convertBlock(p, "heading");
    expect((h as any).text.runs).toEqual([
      { text: "bold", marks: ["bold"] },
      { text: " plain" },
    ]);
  });

  it("paragraph -> list splits lines into items", () => {
    const p = newParagraph(plainToRichText("one\ntwo\nthree"));
    const list = convertBlock(p, "list") as ListBlock;
    expect(list.type).toBe("list");
    expect(list.items.map((i) => richTextToPlain(i.text))).toEqual(["one", "two", "three"]);
    expect(list.style).toBe("bullet");
  });

  it("list -> paragraph joins items with newlines", () => {
    const list = newList("bullet", [
      newListItem("alpha"),
      newListItem("beta"),
    ]);
    const p = convertBlock(list, "paragraph") as ParagraphBlock;
    expect(p.type).toBe("paragraph");
    expect(richTextToPlain(p.text)).toBe("alpha\nbeta");
  });

  it("code -> paragraph and paragraph -> code round-trip text", () => {
    const code = newCode("line one\nline two");
    const p = convertBlock(code, "paragraph") as ParagraphBlock;
    expect(p.type).toBe("paragraph");
    expect(p.id).toBe(code.id);
    expect(richTextToPlain(p.text)).toBe("line one\nline two");

    const back = convertBlock(p, "code");
    expect(back.type).toBe("code");
    expect(back.id).toBe(code.id);
    expect((back as any).code).toBe("line one\nline two");
  });

  it("paragraph -> code preserves text as the code body", () => {
    const p = newParagraph("const x = 1;");
    const code = convertBlock(p, "code");
    expect(code.type).toBe("code");
    expect((code as any).code).toBe("const x = 1;");
  });

  it("code -> list splits lines and list -> code joins them", () => {
    const code = newCode("a\nb\nc");
    const list = convertBlock(code, "list") as ListBlock;
    expect(list.type).toBe("list");
    expect(list.items.map((i) => richTextToPlain(i.text))).toEqual(["a", "b", "c"]);
    const back = convertBlock(list, "code");
    expect(back.type).toBe("code");
    expect((back as any).code).toBe("a\nb\nc");
  });

  it("returns the same block when converting to the same type", () => {
    const p = newParagraph("x");
    expect(convertBlock(p, "paragraph")).toBe(p);
  });

  it("leaves incompatible conversions unchanged", () => {
    const code = newCode("const x = 1;");
    const result = convertBlock(code, "image");
    expect(result).toBe(code);
  });
});

describe("reorderBlocks", () => {
  it("moves an item forward", () => {
    expect(reorderBlocks(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
  });

  it("moves an item backward", () => {
    expect(reorderBlocks(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
  });

  it("is a no-op when from === to", () => {
    expect(reorderBlocks(["a", "b", "c"], 1, 1)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the input", () => {
    const input = ["a", "b", "c"];
    reorderBlocks(input, 0, 2);
    expect(input).toEqual(["a", "b", "c"]);
  });

  it("clamps out-of-range indices", () => {
    expect(reorderBlocks(["a", "b", "c"], 0, 99)).toEqual(["b", "c", "a"]);
    expect(reorderBlocks([], 0, 1)).toEqual([]);
  });
});
