import { describe, it, expect } from "vitest";
import {
  chordFromEvent,
  detectConflicts,
  defaultScheme,
  normalizeChord,
  resolveChord,
  type ShortcutScheme,
} from "../index";

describe("normalizeChord (FR-9)", () => {
  it("orders modifiers canonically and lowercases the key", () => {
    expect(normalizeChord("Shift+Mod+V")).toBe("mod+shift+v");
    expect(normalizeChord("CMD+K")).toBe("mod+k");
    expect(normalizeChord("Ctrl+Alt+Delete")).toBe("ctrl+alt+delete");
  });

  it("normalizes aliases", () => {
    expect(normalizeChord("Command+Option+C")).toBe("mod+alt+c");
    expect(normalizeChord("Esc")).toBe("escape");
    expect(normalizeChord("ArrowUp")).toBe("up");
  });

  it("rejects empty or multi-key chords", () => {
    expect(() => normalizeChord("")).toThrow();
    expect(() => normalizeChord("a+b")).toThrow(/multiple non-modifier/);
    expect(() => normalizeChord("mod+ctrl")).toThrow(/no main key/);
  });
});

describe("chordFromEvent (mod maps per platform)", () => {
  it("maps metaKey to mod on mac and ctrlKey to mod elsewhere", () => {
    expect(chordFromEvent({ key: "k", metaKey: true }, "mac")).toBe("mod+k");
    expect(chordFromEvent({ key: "k", ctrlKey: true }, "other")).toBe("mod+k");
  });

  it("keeps a non-accelerator ctrl distinct on mac", () => {
    expect(chordFromEvent({ key: "c", metaKey: true, ctrlKey: true }, "mac")).toBe("mod+ctrl+c");
  });

  it("returns only modifiers when the key itself is a modifier", () => {
    expect(chordFromEvent({ key: "Shift", shiftKey: true }, "other")).toBe("shift");
  });
});

describe("resolveChord", () => {
  it("matches an event against the default scheme", () => {
    const b = resolveChord({ key: "d", ctrlKey: true }, defaultScheme, "other");
    expect(b?.commandId).toBe("selection.duplicate");
    const k = resolveChord({ key: "k", metaKey: true }, defaultScheme, "mac");
    expect(k?.commandId).toBe("commandMenu.open");
  });

  it("returns null for an unbound chord", () => {
    expect(resolveChord({ key: "j", ctrlKey: true }, defaultScheme, "other")).toBeNull();
  });
});

describe("detectConflicts (AC-7)", () => {
  it("flags two commands bound to the same chord", () => {
    const scheme: ShortcutScheme = {
      id: "c",
      name: "Custom",
      bindings: [
        { commandId: "a", chord: "mod+e" },
        { commandId: "b", chord: "Mod+E" },
      ],
    };
    const conflicts = detectConflicts(scheme);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].commandIds.sort()).toEqual(["a", "b"]);
    expect(conflicts[0].chord).toBe("mod+e");
  });

  it("does not flag the same chord under different when-guards", () => {
    const scheme: ShortcutScheme = {
      id: "c",
      name: "Custom",
      bindings: [
        { commandId: "a", chord: "mod+e", when: "text" },
        { commandId: "b", chord: "mod+e", when: "canvas" },
      ],
    };
    expect(detectConflicts(scheme)).toHaveLength(0);
  });

  it("the shipped default scheme has no conflicts", () => {
    expect(detectConflicts(defaultScheme)).toEqual([]);
  });
});
