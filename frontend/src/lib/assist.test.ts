// Unit tests for the pure F22 assist analyzers (FR-8/9/11/14). These cover the
// core logic over plain data: contrast detection, off-canvas/overflow detection,
// font/color/radius harmonization proposals, alignment/spacing detection, the
// auto-layout suggestion mapping, and the staggered auto-animate plan.

import { describe, expect, it } from "vitest";
import {
  detectContrast,
  detectOffCanvas,
  detectReadability,
  detectAlignment,
  detectSpacing,
  harmonizeProposal,
  hasHarmonizeChanges,
  autoLayoutSuggestions,
  autoAnimatePlan,
  type ElementBox,
  type StyleSample,
} from "./assist";

const box = (id: string, x: number, y: number, w = 100, h = 40, extra: Partial<ElementBox> = {}): ElementBox => ({
  id,
  bounds: { x, y, width: w, height: h },
  isText: false,
  ...extra,
});

const PAGE = { width: 1000, height: 1000 };

describe("detectContrast", () => {
  it("flags ratios below 4.5 with a passing-color fix and skips passing text", () => {
    const issues = detectContrast([
      { id: "a", ratio: 2.1, passingHex: "#000000" },
      { id: "b", ratio: 7.0, passingHex: "#000000" },
      { id: "c", ratio: 4.0, passingHex: "#111111" },
    ]);
    expect(issues.map((i) => i.nodeId)).toEqual(["a", "c"]);
    expect(issues[0].category).toBe("contrast");
    expect(issues[0].severity).toBe("high"); // ratio < 3
    expect(issues[1].severity).toBe("med"); // 3 <= ratio < 4.5
    expect(issues[0].fix).toEqual({ kind: "set_text_color", nodeId: "a", hex: "#000000" });
  });
});

describe("detectOffCanvas", () => {
  it("flags a fully off-canvas element as high severity with a move-back fix", () => {
    const issues = detectOffCanvas([box("a", 1200, 200)], PAGE);
    expect(issues).toHaveLength(1);
    expect(issues[0].category).toBe("offcanvas");
    expect(issues[0].severity).toBe("high");
    // moved so its right edge sits at the page edge
    expect(issues[0].fix).toMatchObject({ kind: "move_into_bounds", nodeId: "a" });
    const fix = issues[0].fix as { dx: number };
    expect(1200 + fix.dx + 100).toBeLessThanOrEqual(PAGE.width + 0.001);
  });

  it("flags a partly clipped element as overflow (med) and not a fully-inside one", () => {
    const issues = detectOffCanvas([box("over", -20, 100), box("inside", 100, 100)], PAGE);
    expect(issues.map((i) => i.nodeId)).toEqual(["over"]);
    expect(issues[0].category).toBe("overflow");
    expect(issues[0].severity).toBe("med");
    expect(issues[0].fix).toMatchObject({ dx: 20, dy: 0 });
  });
});

describe("detectReadability", () => {
  it("flags tiny text only", () => {
    const issues = detectReadability([
      box("tiny", 0, 0, 100, 40, { isText: true, minFontPx: 6 }),
      box("ok", 0, 0, 100, 40, { isText: true, minFontPx: 24 }),
      box("shape", 0, 0), // not text
    ]);
    expect(issues.map((i) => i.nodeId)).toEqual(["tiny"]);
    expect(issues[0].severity).toBe("high"); // < 8
    expect(issues[0].fix).toBeUndefined();
  });
});

describe("detectAlignment", () => {
  it("flags a near-aligned outlier and offers an align-nudge to the common edge", () => {
    // three boxes whose left edges are 100,100,107 -> 107 should snap to 100
    const issues = detectAlignment([
      box("a", 100, 0),
      box("b", 100, 200),
      box("c", 107, 400),
    ]);
    const xIssues = issues.filter((i) => i.fix && i.fix.kind === "align_nudge" && i.fix.dx !== 0);
    expect(xIssues).toHaveLength(1);
    expect(xIssues[0].nodeId).toBe("c");
    const fix = xIssues[0].fix as { dx: number };
    expect(fix.dx).toBe(-7); // 100 - 107
  });

  it("does not flag perfectly aligned edges", () => {
    const issues = detectAlignment([box("a", 50, 0), box("b", 50, 100), box("c", 50, 200)]);
    expect(issues.filter((i) => i.fix?.kind === "align_nudge" && i.fix.dx !== 0)).toHaveLength(0);
  });
});

describe("detectSpacing", () => {
  it("flags uneven gaps in a horizontal row", () => {
    // gaps: 0->100 (gap 0), then 200->... uneven
    const issues = detectSpacing([
      box("a", 0, 100, 100, 40),
      box("b", 110, 100, 100, 40), // gap 10
      box("c", 400, 100, 100, 40), // gap 190
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].category).toBe("spacing");
  });

  it("does not flag even spacing", () => {
    const issues = detectSpacing([
      box("a", 0, 100, 100, 40),
      box("b", 150, 100, 100, 40), // gap 50
      box("c", 300, 100, 100, 40), // gap 50
    ]);
    expect(issues).toHaveLength(0);
  });
});

describe("harmonizeProposal", () => {
  const samples: StyleSample[] = [
    { nodeId: "1", fonts: ["Inter"], colors: ["#ff0000"], radius: 8 },
    { nodeId: "2", fonts: ["Inter"], colors: ["#ff0000"], radius: 8 },
    { nodeId: "3", fonts: ["Comic Sans"], colors: ["#fe0101"], radius: 4 },
  ];

  it("collapses minority fonts onto the most common family", () => {
    const p = harmonizeProposal(samples, { maxFonts: 1 });
    expect(p.keepFonts).toEqual(["Inter"]);
    const swap = p.fonts.find((c) => c.from === "Comic Sans");
    expect(swap?.to).toBe("Inter");
  });

  it("snaps an off color to its nearest kept role color", () => {
    const p = harmonizeProposal(samples, { maxColors: 1 });
    expect(p.keepColors).toEqual(["#ff0000"]);
    const swap = p.colors.find((c) => c.from === "#fe0101");
    expect(swap?.to).toBe("#ff0000"); // near red snaps to red
  });

  it("unifies corner radii onto the most common radius", () => {
    const p = harmonizeProposal(samples);
    expect(p.keepRadius).toBe(8);
    expect(p.radii.find((c) => c.from === 4)?.to).toBe(8);
  });

  it("yields no changes for an already-consistent page", () => {
    const consistent: StyleSample[] = [
      { nodeId: "1", fonts: ["Inter"], colors: ["#000000"], radius: 0 },
      { nodeId: "2", fonts: ["Inter"], colors: ["#000000"], radius: 0 },
    ];
    const p = harmonizeProposal(consistent);
    expect(hasHarmonizeChanges(p)).toBe(false);
  });
});

describe("autoLayoutSuggestions", () => {
  it("suggests align + tidy for misaligned siblings", () => {
    const boxes = [box("a", 100, 0), box("b", 100, 200), box("c", 107, 400)];
    const ops = autoLayoutSuggestions(boxes, PAGE).map((s) => s.op);
    expect(ops).toContain("align-left");
    expect(ops).toContain("tidy");
  });

  it("suggests fit when an element is off-canvas", () => {
    const boxes = [box("a", 100, 100), box("stray", 1200, 100)];
    const fit = autoLayoutSuggestions(boxes, PAGE).find((s) => s.op === "fit");
    expect(fit).toBeDefined();
    expect(fit?.nodeIds).toContain("stray");
  });
});

describe("autoAnimatePlan", () => {
  it("staggers delays in reading order (top-to-bottom, then left-to-right)", () => {
    const plan = autoAnimatePlan(
      [
        { id: "bottom", bounds: { x: 0, y: 500, width: 10, height: 10 } },
        { id: "topRight", bounds: { x: 300, y: 0, width: 10, height: 10 } },
        { id: "topLeft", bounds: { x: 0, y: 0, width: 10, height: 10 } },
      ],
      "rise",
      { staggerMs: 100 },
    );
    expect(plan.map((p) => p.nodeId)).toEqual(["topLeft", "topRight", "bottom"]);
    expect(plan.map((p) => p.delayMs)).toEqual([0, 100, 200]);
    expect(plan.every((p) => p.preset === "rise")).toBe(true);
  });
});
