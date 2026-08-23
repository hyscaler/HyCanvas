// .hyc parsing: content decides (never the filename), older files forward-
// migrate, newer files are refused with a clear message, and the round-trip
// through downloadHycFile's serialization is lossless.
import { describe, expect, it } from "vitest";
import { currentSchemaVersion, createBlankDesign } from "@hc/schema";
import { importedTitle, parseHycFile } from "./hycFile";

describe("parseHycFile", () => {
  it("round-trips a current design file losslessly", () => {
    const file = createBlankDesign({ title: "Round trip", width: 800, height: 600 });
    const parsed = parseHycFile(JSON.stringify(file, null, 2));
    expect(parsed).toEqual(file);
  });

  it("forward-migrates an old-schema file to current", () => {
    // A realistic older file: a full current-shape design (format, dpi, pages)
    // stamped with an old schemaVersion, so migrate() chains it up and the
    // structural validator still accepts it.
    const old = { ...createBlankDesign({ title: "Old file", width: 1080, height: 1080 }), schemaVersion: 7 };
    const parsed = parseHycFile(JSON.stringify(old));
    expect(parsed.schemaVersion).toBe(currentSchemaVersion);
    expect(parsed.pages).toHaveLength(1);
  });

  it("rejects a structurally invalid file (the poison-template guard)", () => {
    // A hand-edited current-version file whose node is missing its `type`:
    // parseable and current-versioned, but the server would reject it on write.
    // Catching it here stops it from becoming an undeletable, always-failing
    // template (or a design import that 422s cryptically).
    const broken = createBlankDesign({ title: "Broken", width: 100, height: 100 });
    (broken.pages[0].children as unknown[]).push({ id: "n1", transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 10, height: 10 } });
    expect(() => parseHycFile(JSON.stringify(broken))).toThrow(/not a valid HyCanvas design/);
  });

  it("refuses files from a newer build instead of dropping fields", () => {
    const newer = { schemaVersion: currentSchemaVersion + 1, pages: [{ id: "p", children: [] }] };
    expect(() => parseHycFile(JSON.stringify(newer))).toThrow(/newer version/);
  });

  it("rejects non-design content by shape, not by name", () => {
    expect(() => parseHycFile("not json {")).toThrow(/not valid JSON/);
    expect(() => parseHycFile('"just a string"')).toThrow(/not a HyCanvas design file/);
    expect(() => parseHycFile("[1,2,3]")).toThrow(/not a HyCanvas design file/);
    expect(() => parseHycFile(JSON.stringify({ schemaVersion: 1, pages: [] }))).toThrow(/missing pages/);
    expect(() => parseHycFile(JSON.stringify({ pages: [{}] }))).toThrow(/missing pages or schema/);
  });
});

describe("importedTitle", () => {
  it("prefers the file's own title, then the filename stem", () => {
    const file = createBlankDesign({ title: "Own title", width: 100, height: 100 });
    expect(importedTitle(file, "whatever.hyc")).toBe("Own title");
    file.title = "";
    expect(importedTitle(file, "spring-campaign.hyc")).toBe("spring-campaign");
    expect(importedTitle(file, ".hyc")).toBe("Imported design");
  });
});
