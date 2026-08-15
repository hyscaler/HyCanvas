// Bidirectional ordering (F38 FR-10). The format has carried
// `ParagraphStyle.direction` since the text model was written and nothing read
// it, so every right-to-left paragraph laid out left to right.
import { describe, expect, it } from "vitest";
import { resolveBaseDirection, resolveLevels, reorderRuns, orderLinePieces, hasRtl } from "../bidi";

const HE = "שלום"; // "shalom"
const AR = "مرحبا"; // "marhaba"

describe("resolveBaseDirection", () => {
  it("takes the first strong character when the paragraph says auto", () => {
    expect(resolveBaseDirection("hello world")).toBe("ltr");
    expect(resolveBaseDirection(HE)).toBe("rtl");
    expect(resolveBaseDirection(AR)).toBe("rtl");
    // Leading punctuation, digits and spaces are not strong.
    expect(resolveBaseDirection(`  "123" ${HE}`)).toBe("rtl");
    expect(resolveBaseDirection(`  "123" hello`)).toBe("ltr");
    // A Latin word before the Hebrew makes the paragraph left-to-right.
    expect(resolveBaseDirection(`Re: ${HE}`)).toBe("ltr");
  });

  it("honours an explicit declaration over the content", () => {
    expect(resolveBaseDirection(HE, "ltr")).toBe("ltr");
    expect(resolveBaseDirection("hello", "rtl")).toBe("rtl");
  });

  it("defaults to left-to-right with no strong character at all", () => {
    expect(resolveBaseDirection("")).toBe("ltr");
    expect(resolveBaseDirection("123 456 ...")).toBe("ltr");
  });
});

describe("resolveLevels", () => {
  it("gives right-to-left text an odd level inside a left-to-right paragraph", () => {
    const text = `hi ${HE}`;
    const levels = resolveLevels(text, "ltr");
    expect(levels).toHaveLength(text.length);
    expect(levels[0]).toBe(0); // "h"
    expect(levels[text.length - 1] % 2).toBe(1); // Hebrew
  });

  it("gives Latin an even level inside a right-to-left paragraph", () => {
    const text = `${AR} ok`;
    const levels = resolveLevels(text, "rtl");
    expect(levels[0] % 2).toBe(1); // Arabic at base level 1
    expect(levels[text.length - 1] % 2).toBe(0); // "k" raised to 2
  });

  it("keeps European digits running left-to-right inside Arabic (W2, I2)", () => {
    // Digits after Arabic become Arabic-Indic in class but still read LTR, so
    // they must land on an even level above the base.
    const text = `${AR} 2026`;
    const levels = resolveLevels(text, "rtl");
    const digitLevel = levels[text.length - 1];
    expect(digitLevel % 2).toBe(0);
    expect(digitLevel).toBeGreaterThan(1);
  });

  it("resolves a neutral between two right-to-left runs to right-to-left (N1)", () => {
    const text = `${HE} - ${HE}`;
    const levels = resolveLevels(text, "ltr");
    const dashIndex = text.indexOf("-");
    expect(levels[dashIndex] % 2).toBe(1);
  });

  it("resolves a neutral between opposite directions to the base (N2)", () => {
    const text = `abc - ${HE}`;
    const levels = resolveLevels(text, "ltr");
    expect(levels[text.indexOf("-")] % 2).toBe(0);
  });

  it("counts one level per code unit so callers can slice the string", () => {
    const emoji = "a😀b"; // the emoji is a surrogate pair
    expect(resolveLevels(emoji, "ltr")).toHaveLength(emoji.length);
  });
});

describe("reorderRuns", () => {
  it("reverses a right-to-left run inside left-to-right text", () => {
    // levels: L L R R L  ->  the middle pair swaps places as a block
    const runs = reorderRuns([0, 0, 1, 1, 0]);
    expect(runs.map((r) => [r.start, r.end, r.level])).toEqual([
      [0, 2, 0],
      [2, 4, 1],
      [4, 5, 0],
    ]);
  });

  it("reverses the whole line for a right-to-left paragraph", () => {
    // A right-to-left base with an embedded Latin word: the Latin keeps its
    // own left-to-right order but sits to the left of the Arabic.
    const runs = reorderRuns([1, 1, 2, 2, 1]);
    expect(runs.map((r) => r.level)).toEqual([1, 2, 1]);
    expect(runs[0].start).toBe(4); // the last logical run is displayed first
    expect(runs[2].start).toBe(0);
  });

  it("leaves a purely left-to-right line untouched", () => {
    expect(reorderRuns([0, 0, 0]).map((r) => [r.start, r.end])).toEqual([[0, 3]]);
  });
});

describe("orderLinePieces", () => {
  const seg = (text: string, id: string) => ({ text, id });

  it("leaves left-to-right runs in authored order", () => {
    const pieces = orderLinePieces([seg("Hello ", "a"), seg("world", "b")], "ltr");
    expect(pieces.map((p) => p.text)).toEqual(["Hello ", "world"]);
  });

  it("reverses the run order of a right-to-left paragraph", () => {
    // Two style runs, both Hebrew: displayed right to left, so the SECOND
    // authored run is drawn first (leftmost). This is the bug that made a
    // styled Hebrew sentence unreadable while a single unstyled run looked fine.
    const pieces = orderLinePieces([seg("שלום ", "a"), seg("עולם", "b")], "rtl");
    expect(pieces.map((p) => p.item.id)).toEqual(["b", "a"]);
  });

  it("keeps an embedded Latin phrase readable inside Arabic", () => {
    const pieces = orderLinePieces([seg(`${AR} `, "a"), seg("HyCanvas", "b")], "rtl");
    // The Latin run is drawn leftmost, unreversed, with the Arabic to its right.
    expect(pieces[0].item.id).toBe("b");
    expect(pieces[0].text).toBe("HyCanvas");
    expect(pieces[0].level % 2).toBe(0);
    expect(pieces[pieces.length - 1].item.id).toBe("a");
  });

  it("keeps Hebrew to the right of a Latin lead-in", () => {
    const pieces = orderLinePieces([seg("Note: ", "a"), seg(HE, "b")], "ltr");
    expect(pieces.map((p) => p.item.id)).toEqual(["a", "b"]);
  });

  it("splits one style run across two levels when it mixes directions", () => {
    const pieces = orderLinePieces([seg(`abc ${HE} def`, "only")], "ltr");
    // Three pieces: Latin, Hebrew at an odd level, Latin.
    expect(pieces).toHaveLength(3);
    expect(pieces.map((p) => p.level % 2)).toEqual([0, 1, 0]);
    // Every piece still points at the run it came from, so styling survives.
    expect(new Set(pieces.map((p) => p.item.id))).toEqual(new Set(["only"]));
    // A SINGLE embedded run reverses to itself, so the concatenation is
    // unchanged here; what changes is that the middle piece is marked
    // right-to-left for the renderer. Two embedded runs do reorder.
    expect(pieces.map((p) => p.text).join("")).toBe(`abc ${HE} def`);
  });

  it("reorders two right-to-left words around a left-to-right one", () => {
    // Logical: HE1 "and" HE2 in a right-to-left paragraph. Displayed right to
    // left, HE1 is rightmost, so the pieces come out reversed.
    const pieces = orderLinePieces(
      [seg(`${HE} `, "he1"), seg("and", "en"), seg(` ${AR}`, "ar")],
      "rtl",
    );
    expect(pieces.map((p) => p.item.id)).toEqual(["ar", "en", "he1"]);
  });

  it("preserves the full text content regardless of ordering", () => {
    const items = [seg("Total: ", "a"), seg("42 ", "b"), seg(AR, "c")];
    for (const base of ["ltr", "rtl"] as const) {
      const joined = orderLinePieces(items, base)
        .map((p) => p.text)
        .join("");
      const original = items.map((i) => i.text).join("");
      expect([...joined].sort().join("")).toBe([...original].sort().join(""));
    }
  });

  it("handles an empty line and empty runs", () => {
    expect(orderLinePieces([], "rtl")).toEqual([]);
    expect(orderLinePieces([seg("", "a")], "rtl").map((p) => p.text).join("")).toBe("");
  });
});

describe("hasRtl", () => {
  it("detects Hebrew and Arabic, and ignores digits and Latin", () => {
    expect(hasRtl("hello")).toBe(false);
    expect(hasRtl("12345 .,")).toBe(false);
    expect(hasRtl(HE)).toBe(true);
    expect(hasRtl(`mixed ${AR}`)).toBe(true);
  });
});

// The layout engine must actually consult the direction. This is the
// end-to-end version of the bug: the format carried `direction` and the
// engine ignored it.
import { layoutText } from "../layout";
import type { TextNode } from "@hc/schema";

function node(paragraphs: { text: string; direction?: "ltr" | "rtl" | "auto"; align?: "left" | "right" }[]): TextNode {
  return {
    id: "t",
    type: "text",
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: 400, height: 100 },
    box: { mode: "fixed", width: 400, height: 100, autoFit: { enabled: false, min: 6, max: 512 }, verticalAlign: "top" },
    content: paragraphs.map((p) => ({
      runs: [{ text: p.text, style: { fontFamily: "system", fontStyle: "Regular", fontSize: 16 } }],
      style: { align: p.align, direction: p.direction ?? "auto" },
    })),
  } as unknown as TextNode;
}

describe("layoutText direction", () => {
  it("resolves and reports the base direction per paragraph", () => {
    const res = layoutText(node([{ text: "hello" }, { text: HE }]));
    expect(res.lines[0].direction).toBe("ltr");
    expect(res.lines[res.lines.length - 1].direction).toBe("rtl");
  });

  it("right-aligns a right-to-left paragraph that never chose an alignment", () => {
    const res = layoutText(node([{ text: AR }]));
    expect(res.lines[0].align).toBe("right");
  });

  it("keeps an explicit alignment even when the text is right-to-left", () => {
    const res = layoutText(node([{ text: AR, align: "left" }]));
    expect(res.lines[0].align).toBe("left");
  });

  it("leaves left-to-right paragraphs exactly as before", () => {
    const res = layoutText(node([{ text: "hello world" }]));
    expect(res.lines[0].align).toBe("left");
    expect(res.lines[0].direction).toBe("ltr");
    expect(res.lines[0].segments.map((s) => s.text).join("")).toBe("hello world");
  });
});
