import { describe, expect, it } from "vitest";
import {
  dialsClause,
  sanitizeEditedOutline,
  maxOutlinePages,
  maxOutlineTitleChars,
  verbosityRule,
  type DesignOutline,
} from "../index";

describe("dialsClause", () => {
  it("is empty for missing or all-auto dials", () => {
    expect(dialsClause(undefined)).toBe("");
    expect(dialsClause({})).toBe("");
    expect(dialsClause({ density: "auto", tone: "auto", audience: "auto", scenario: "auto" })).toBe("");
  });

  it("renders only the chosen dials as an authoritative settings clause", () => {
    const c = dialsClause({ density: "concise", tone: "persuasive", scenario: "analysis-report" });
    expect(c).toContain("Generation settings (authoritative):");
    expect(c).toContain(verbosityRule("concise"));
    expect(c).toContain("Tone: persuasive.");
    expect(c).toContain("Scenario: analysis report."); // hyphens humanized
    expect(c).not.toContain("Audience:");
  });
});

describe("sanitizeEditedOutline", () => {
  const base: DesignOutline = {
    title: "  My Deck  ",
    theme: " warm ",
    pages: [
      { id: "a", title: "  Keep ", points: ["  one ", "", "   "], visualRole: "cover" },
      { id: "b", title: "", points: [], visualRole: "content" }, // emptied by the edit -> dropped
      { id: "c", title: "x".repeat(500), points: ["p"], visualRole: "weird" as never },
    ],
  };

  it("clips, drops empties, fixes roles, and never mutates the input", () => {
    const snapshot = JSON.stringify(base);
    const o = sanitizeEditedOutline(base);
    expect(JSON.stringify(base)).toBe(snapshot);
    expect(o.title).toBe("My Deck");
    expect(o.theme).toBe("warm");
    expect(o.pages).toHaveLength(2);
    expect(o.pages[0]).toMatchObject({ id: "a", title: "Keep", points: ["one"], visualRole: "cover" });
    expect(o.pages[1].title.length).toBe(maxOutlineTitleChars);
    expect(o.pages[1].visualRole).toBe("content");
  });

  it("caps the page count at the deck max", () => {
    const many: DesignOutline = {
      title: "t", theme: "",
      pages: Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, title: `Page ${i}`, points: [], visualRole: "content" as const })),
    };
    expect(sanitizeEditedOutline(many).pages).toHaveLength(maxOutlinePages);
  });

  it("keeps and normalizes notes, drops empty ones", () => {
    const o = sanitizeEditedOutline({
      title: "t", theme: "",
      pages: [{ id: "a", title: "A", points: [], visualRole: "content", note: "  Keep  this. " }],
    });
    expect(o.pages[0].note).toBe("Keep this.");
  });

  it("an edit that empties everything yields zero pages, not a throw", () => {
    const o = sanitizeEditedOutline({ title: "", theme: "", pages: [{ id: "a", title: " ", points: ["  "], visualRole: "content" }] });
    expect(o.pages).toHaveLength(0);
    expect(o.title).toBe("Untitled");
  });
});
