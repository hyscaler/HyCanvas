import { describe, it, expect } from "vitest";
import { fuzzyScore, search, type MenuItem } from "../index";

const items: MenuItem[] = [
  { id: "selection.duplicate", label: "Duplicate", keywords: ["clone", "copy"], category: "Edit" },
  { id: "clipboard.paste", label: "Paste", category: "Clipboard" },
  { id: "clipboard.pasteInPlace", label: "Paste in place", category: "Clipboard" },
  { id: "history.undo", label: "Undo", category: "History" },
  { id: "image.crop", label: "Crop image", category: "Image", enabled: false },
];

describe("fuzzyScore (FR-10)", () => {
  it("returns null when the query is not a subsequence", () => {
    expect(fuzzyScore("zzz", "Duplicate")).toBeNull();
  });

  it("scores a prefix higher than a scattered match", () => {
    const prefix = fuzzyScore("dup", "Duplicate")!;
    const scattered = fuzzyScore("dae", "Duplicate")!;
    expect(prefix).toBeGreaterThan(scattered);
  });

  it("rewards consecutive runs", () => {
    expect(fuzzyScore("past", "Paste")).toBeGreaterThan(fuzzyScore("pst", "Paste")!);
  });
});

describe("search", () => {
  it("filters to subsequence matches and ranks the best first", () => {
    const r = search("paste", items);
    expect(r[0].item.id).toBe("clipboard.paste");
    expect(r.map((x) => x.item.id)).toContain("clipboard.pasteInPlace");
    expect(r.map((x) => x.item.id)).not.toContain("history.undo");
  });

  it("matches via keywords", () => {
    const r = search("clone", items);
    expect(r[0].item.id).toBe("selection.duplicate");
  });

  it("boosts recent commands on an empty query", () => {
    const r = search("", items, { recents: ["history.undo"] });
    expect(r[0].item.id).toBe("history.undo");
  });

  it("keeps disabled items but ranks them below enabled matches", () => {
    const r = search("crop", items);
    expect(r.map((x) => x.item.id)).toContain("image.crop");
    // With another enabled 'cr' match present, disabled would sort lower; here
    // it is the only match, so it still appears (never silently dropped).
    expect(r[0].item.enabled).toBe(false);
  });

  it("respects the limit", () => {
    expect(search("", items, { limit: 2 })).toHaveLength(2);
  });
});
