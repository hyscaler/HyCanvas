// Markdown outline interchange (F28 completion C26): deterministic, no AI.

import { describe, expect, it } from "vitest";
import { parseMarkdownOutline, serializeOutlineMarkdown } from "../mdoutline";

describe("parseMarkdownOutline", () => {
  it("parses title, slides, points, ordered lists, and notes", () => {
    const md = `# Quarterly Review

## Growth
- Revenue up 12%
- Churn down
1. First priority
> note: Pause here for questions.

### Deep dive
Plain paragraph point.
`;
    const o = parseMarkdownOutline(md)!;
    expect(o.title).toBe("Quarterly Review");
    expect(o.pages).toHaveLength(2);
    expect(o.pages[0].title).toBe("Growth");
    expect(o.pages[0].points).toEqual(["Revenue up 12%", "Churn down", "First priority"]);
    expect(o.pages[0].note).toBe("Pause here for questions.");
    expect(o.pages[1].title).toBe("Deep dive");
    expect(o.pages[1].points).toEqual(["Plain paragraph point."]);
    expect(o.pages[0].visualRole).toBe("cover");
  });

  it("text before the first heading seeds the first slide; code fences stay opaque", () => {
    const md = "My Deck\n- early point\n\n## Code\n```\nconst x = 1;\nconst y = 2;\n```\n";
    const o = parseMarkdownOutline(md)!;
    expect(o.title).toBe("My Deck");
    expect(o.pages[0].title).toBe("My Deck");
    expect(o.pages[0].points).toEqual(["early point"]);
    expect(o.pages[1].points).toEqual(["const x = 1;\nconst y = 2;"]);
  });

  it("returns null for structureless text and caps points per slide", () => {
    expect(parseMarkdownOutline("")).toBeNull();
    const many = "## S\n" + Array.from({ length: 20 }, (_, i) => `- p${i}`).join("\n");
    expect(parseMarkdownOutline(many)!.pages[0].points).toHaveLength(12);
  });
});

describe("serializeOutlineMarkdown", () => {
  const text = (lines: string[], placeholderId?: string) => ({
    type: "text",
    ...(placeholderId ? { data: { placeholderId } } : {}),
    content: lines.map((l) => ({ runs: [{ text: l }] })),
  });

  it("emits title, per-slide headings, points, and notes", () => {
    const md = serializeOutlineMarkdown("Deck", [
      { name: "Opening", notes: "Welcome them.", children: [text(["Hello", "• World"])] },
      { children: [text(["Untitled slide title", "Point A"])] },
    ]);
    expect(md).toContain("# Deck");
    expect(md).toContain("## Opening");
    expect(md).toContain("- Hello");
    expect(md).toContain("- World"); // bullet glyphs stripped
    expect(md).toContain("> note: Welcome them.");
    // A page with no name titles itself from its first text line, which is
    // then NOT repeated as a point.
    expect(md).toContain("## Untitled slide title");
    expect(md).toContain("- Point A");
    expect(md).not.toContain("- Untitled slide title");
  });

  it("round-trips through the parser structurally", () => {
    const md = serializeOutlineMarkdown("Deck", [
      { name: "One", children: [text(["Alpha", "Beta"])] },
      { name: "Two", notes: "Note here.", children: [text(["Gamma"])] },
    ]);
    const back = parseMarkdownOutline(md)!;
    expect(back.title).toBe("Deck");
    expect(back.pages.map((p) => p.title)).toEqual(["One", "Two"]);
    expect(back.pages[1].note).toBe("Note here.");
  });
});
