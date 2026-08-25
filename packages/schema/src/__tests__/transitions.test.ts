// Schema v22: PageTransition.easing + Page.transitionOut (F28 completion
// C02+C03). Both optional and additive; the easing is deliberately a PLAIN
// string so an easing name a given client has never heard of keeps validating
// everywhere (the engine clamps unknowns to its default at render time).

import { describe, expect, it } from "vitest";
import { createBlankDesign, currentSchemaVersion, migrate, PageTransitionSchema, validate } from "../index";

describe("migration to v22", () => {
  it("pins the exact version pair (see the Go twin in v22_test.go)", () => {
    // The paired EXACT pins are the cross-language drift alarm: a future bump
    // must update this line, the Go pin, and both currentSchemaVersion
    // mirrors in the SAME change (CLAUDE.md bump protocol). A >= assertion
    // would let the mirrors drift apart silently.
    expect(currentSchemaVersion).toBe(22);
  });

  it("is a pure no-op on a v21 document", () => {
    const before = { ...createBlankDesign(), schemaVersion: 21 } as Record<string, unknown>;
    const after = migrate(structuredClone(before) as never, 22) as unknown as Record<string, unknown>;
    expect(after.schemaVersion).toBe(22);
    expect({ ...after, schemaVersion: 21 }).toEqual(before);
  });
});

describe("v22 transition fields", () => {
  it("accepts ANY easing string, including names no current client knows", () => {
    for (const easing of ["linear", "ease-in-out", "spring", "a-future-easing"]) {
      const r = PageTransitionSchema.safeParse({ type: "fade", durationMs: 300, easing });
      expect(r.success, easing).toBe(true);
    }
  });

  it("a document carrying transitionOut and easing validates whole", () => {
    const file = createBlankDesign();
    (file.pages[0] as Record<string, unknown>).transition = { type: "slide", direction: "left", durationMs: 400, easing: "linear" };
    (file.pages[0] as Record<string, unknown>).transitionOut = { type: "fade", durationMs: 300 };
    const check = validate(file);
    expect(check.ok, "ok" in check && !check.ok ? `${check.pointer}: ${check.message}` : "").toBe(true);
  });

  it("both fields stay optional: a bare page still validates", () => {
    const check = validate(createBlankDesign());
    expect(check.ok).toBe(true);
  });
});
