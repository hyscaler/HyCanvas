import { describe, it, expect } from "vitest";
import { createBlankDesign, type DesignFile } from "@hc/schema";
import { checkAccessibility } from "../index";

function deck(names: (string | undefined)[]): DesignFile {
  const file = createBlankDesign({ title: "Deck", width: 800, height: 600 });
  file.pages = names.map((name, i) => ({ ...structuredClone(file.pages[0]), id: `p${i}`, name }));
  return file;
}

describe("slide-title check (doc 28 FR-3 / FR-29)", () => {
  it("flags every untitled slide in a deck", () => {
    const issues = checkAccessibility(deck(["Agenda", undefined, "   "])).filter((i) => i.kind === "slide-title");
    expect(issues).toHaveLength(2);
    expect(issues[0].pageIndex).toBe(1);
    expect(issues[1].pageIndex).toBe(2);
    expect(issues[0].severity).toBe("warning");
  });

  it("passes a fully titled deck", () => {
    const issues = checkAccessibility(deck(["One", "Two"])).filter((i) => i.kind === "slide-title");
    expect(issues).toHaveLength(0);
  });

  it("exempts a single-page design (not a deck)", () => {
    const file = createBlankDesign({ title: "Poster", width: 800, height: 600 });
    delete file.pages[0].name;
    const issues = checkAccessibility(file).filter((i) => i.kind === "slide-title");
    expect(issues).toHaveLength(0);
  });

  it("points at the page, so the UI navigates rather than selecting a node", () => {
    const d = deck(["A", undefined]);
    const issue = checkAccessibility(d).find((i) => i.kind === "slide-title")!;
    expect(issue.nodeId).toBe(d.pages[1].id);
  });
});
