import { describe, expect, it } from "vitest";
import { builtinMasterAndLayouts, type SlideLayout } from "@hc/schema";
import { layoutsAreAuthored, shouldGroundInLayouts } from "./generationRoute";

const builtin = builtinMasterAndLayouts({ width: 1920, height: 1080 }).layouts;
const authored: SlideLayout[] = [{ ...builtin[0], id: "tpl-title", masterId: "master-brand" }];

describe("generation route", () => {
  it("treats the builtin slide layouts as scaffolding, not as a template", () => {
    expect(layoutsAreAuthored(builtin)).toBe(false);
    expect(layoutsAreAuthored([])).toBe(false);
    expect(layoutsAreAuthored(undefined)).toBe(false);
    expect(layoutsAreAuthored(authored)).toBe(true);
  });

  it("composes through the archetype door unless a template governs the document", () => {
    expect(shouldGroundInLayouts({ designType: "deck", docLayouts: builtin })).toBe(false);
    expect(shouldGroundInLayouts({ designType: "deck", docLayouts: [] })).toBe(false);
    expect(shouldGroundInLayouts({ designType: "deck", docLayouts: authored })).toBe(true);
    expect(shouldGroundInLayouts({ designType: "deck", docLayouts: builtin, templateAdopted: true })).toBe(true);
    // Posters and social sets never ground in slide layouts.
    expect(shouldGroundInLayouts({ designType: "poster", docLayouts: authored })).toBe(false);
  });
});
