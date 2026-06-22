import { describe, it, expect } from "vitest";
import {
  buildCommandManifest,
  buildCommandBarSystem,
  parseCommandChoice,
} from "./aiCommandBar";

const COMMANDS = [
  { id: "insert.rect", label: "Add rectangle", category: "Insert", keywords: ["shape", "box"] },
  { id: "edit.undo", label: "Undo", category: "Edit" },
  { id: "file.export", label: "Export…", category: "File", keywords: ["download", "png"] },
];

describe("buildCommandManifest (F22 FR-13)", () => {
  it("derives id + compact description from label, category, keywords", () => {
    const m = buildCommandManifest(COMMANDS);
    expect(m[0]).toEqual({ id: "insert.rect", description: "Insert: Add rectangle (shape, box)" });
    expect(m[1]).toEqual({ id: "edit.undo", description: "Edit: Undo" });
  });

  it("omits the keyword clause when there are none", () => {
    const m = buildCommandManifest([{ id: "x", label: "X" }]);
    expect(m[0]).toEqual({ id: "x", description: "X" });
  });
});

describe("buildCommandBarSystem (F22 FR-13)", () => {
  it("embeds every action id and asks for strict JSON", () => {
    const sys = buildCommandBarSystem(buildCommandManifest(COMMANDS));
    expect(sys).toContain("insert.rect");
    expect(sys).toContain("file.export");
    expect(sys).toContain('{"action":"<id>"');
    expect(sys).toContain('{"action":null}');
  });
});

describe("parseCommandChoice (F22 FR-13)", () => {
  const ids = new Set(COMMANDS.map((c) => c.id));

  it("accepts a valid action id", () => {
    expect(parseCommandChoice('{"action":"edit.undo","reason":"user asked to undo"}', ids)).toEqual({
      action: "edit.undo",
      reason: "user asked to undo",
    });
  });

  it("strips code fences via parseModelJson", () => {
    expect(parseCommandChoice('```json\n{"action":"insert.rect"}\n```', ids).action).toBe("insert.rect");
  });

  it("rejects an id not in the registry", () => {
    expect(parseCommandChoice('{"action":"made.up"}', ids)).toEqual({ action: null });
  });

  it("passes through explicit null (no match)", () => {
    expect(parseCommandChoice('{"action":null}', ids)).toEqual({ action: null });
  });

  it("degrades to null on malformed output", () => {
    expect(parseCommandChoice("not json at all", ids)).toEqual({ action: null });
    expect(parseCommandChoice("[1,2,3]", ids)).toEqual({ action: null });
  });

  it("captures optional args object when present", () => {
    const c = parseCommandChoice('{"action":"insert.rect","args":{"color":"red"}}', ids);
    expect(c.action).toBe("insert.rect");
    expect(c.args).toEqual({ color: "red" });
  });
});
