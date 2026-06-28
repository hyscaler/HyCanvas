import { describe, expect, it } from "vitest";
import {
  DESIGN_LAYOUTS,
  DesignSpecError,
  normalizeDesignSpec,
  designSpecJsonSchema,
  layoutDesign,
  qualityCheck,
  type AiDesignSpec,
} from "../index";

const SIZE = { width: 1080, height: 1080 };

function specOf(over: Partial<AiDesignSpec> = {}): AiDesignSpec {
  return {
    layout: "centered",
    background: { kind: "solid", color: "#102030" },
    blocks: [
      { role: "eyebrow", text: "WORKSHOP" },
      { role: "heading", text: "Design Better, Faster" },
      { role: "body", text: "Join us for a hands-on session." },
    ],
    ...over,
  };
}

describe("normalizeDesignSpec", () => {
  it("accepts a well-formed spec", () => {
    const spec = normalizeDesignSpec(specOf());
    expect(spec.layout).toBe("centered");
    expect(spec.blocks).toHaveLength(3);
  });

  it("defaults unknown layout/background and drops empty text blocks", () => {
    const spec = normalizeDesignSpec({
      layout: "diagonal",
      background: { kind: "wat", color: "not-a-color" },
      blocks: [
        { role: "heading", text: "Keeps" },
        { role: "body", text: "   " },
        { role: "weird", text: "still kept as body" },
        { role: "accent" },
      ],
    });
    expect(spec.layout).toBe("centered");
    expect(spec.background.kind).toBe("solid");
    expect(spec.background.color).toBe("#ffffff");
    // empty body dropped; weird->body kept; accent kept
    expect(spec.blocks.map((b) => b.role)).toEqual(["heading", "body", "accent"]);
  });

  it("throws when nothing usable remains", () => {
    expect(() => normalizeDesignSpec({ blocks: [{ role: "accent" }] })).toThrow(DesignSpecError);
    expect(() => normalizeDesignSpec("nope")).toThrow(DesignSpecError);
  });

  it("exposes a JSON schema with the layout + role enums", () => {
    expect(designSpecJsonSchema.properties.layout.enum).toEqual(DESIGN_LAYOUTS);
  });
});

describe("layoutDesign", () => {
  it("produces a background fill and a node per block", () => {
    const { background, nodes } = layoutDesign(specOf(), SIZE);
    expect(background.type).toBe("solid");
    expect(nodes).toHaveLength(3);
    expect(nodes.every((n) => n.type === "text")).toBe(true);
  });

  it("renders accents as rounded rect shapes", () => {
    const { nodes } = layoutDesign(
      specOf({ blocks: [{ role: "heading", text: "Hi" }, { role: "accent" }] }),
      SIZE,
    );
    const accent = nodes.find((n) => n.type === "shape");
    expect(accent).toBeTruthy();
  });

  it("builds a gradient background when requested", () => {
    const { background } = layoutDesign(
      specOf({ background: { kind: "gradient", color: "#000000", color2: "#3355ff", angle: 90 } }),
      SIZE,
    );
    expect(background.type).toBe("gradient");
  });

  it("keeps all nodes within page bounds and AA-readable (quality pass clean)", () => {
    const { background, nodes } = layoutDesign(specOf(), SIZE);
    const report = qualityCheck({ background, nodes, size: SIZE });
    expect(report.ok).toBe(true);
    expect(report.issues).toHaveLength(0);
  });

  it("auto-corrects unreadable text color hints", () => {
    // Dark text hint on a dark background should be overridden to pass AA.
    const { background, nodes } = layoutDesign(
      specOf({
        background: { kind: "solid", color: "#101010" },
        blocks: [{ role: "heading", text: "Readable", color: "#1a1a1a" }],
      }),
      SIZE,
    );
    const report = qualityCheck({ background, nodes, size: SIZE });
    expect(report.issues.filter((i) => i.kind === "contrast")).toHaveLength(0);
  });

  it("keeps text AA-readable across a wide-luminance gradient (both stops)", () => {
    // White<->near-black gradient: no single fixed color is readable over both
    // ends unless the engine evaluates against every stop.
    const { background, nodes } = layoutDesign(
      specOf({ background: { kind: "gradient", color: "#ffffff", color2: "#000000", angle: 90 } }),
      SIZE,
    );
    const report = qualityCheck({ background, nodes, size: SIZE });
    expect(report.issues.filter((i) => i.kind === "contrast")).toHaveLength(0);
  });

  it("scales a text-heavy stack to fit the page (no overflow)", () => {
    const longLine = "This is a deliberately long body line that will wrap across many rows. ".repeat(6);
    const { background, nodes } = layoutDesign(
      specOf({
        layout: "left",
        blocks: [
          { role: "heading", text: "A Very Long Headline That Spans Multiple Lines On Its Own" },
          { role: "subheading", text: "Plus a subheading that also wraps a fair amount across the column" },
          { role: "body", text: longLine },
          { role: "body", text: longLine },
          { role: "body", text: longLine },
        ],
      }),
      SIZE,
    );
    const report = qualityCheck({ background, nodes, size: SIZE });
    expect(report.issues.filter((i) => i.kind === "overflow"), JSON.stringify(report.issues)).toHaveLength(0);
  });

  it("handles every layout intent without overflow or overlap", () => {
    for (const layout of DESIGN_LAYOUTS) {
      const { background, nodes } = layoutDesign(specOf({ layout }), SIZE);
      const report = qualityCheck({ background, nodes, size: SIZE });
      const bad = report.issues.filter((i) => i.kind !== "contrast");
      expect(bad, `${layout}: ${JSON.stringify(bad)}`).toHaveLength(0);
    }
  });
});

describe("qualityCheck", () => {
  it("flags low contrast, overflow, and overlap", () => {
    const bg = { type: "solid" as const, color: { srgb: { r: 0.06, g: 0.06, b: 0.06, a: 1 } } };
    const lowContrastText = {
      id: "t1",
      type: "text" as const,
      transform: { x: 50, y: 50, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 100, height: 40 },
      content: [{ runs: [{ text: "x", style: { fill: { type: "solid", color: { srgb: { r: 0.1, g: 0.1, b: 0.1, a: 1 } } } } }] }],
    } as unknown as Parameters<typeof qualityCheck>[0]["nodes"][number];
    const overflowing = {
      id: "t2",
      type: "shape" as const,
      transform: { x: 1000, y: 1000, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 500, height: 500 },
    } as unknown as Parameters<typeof qualityCheck>[0]["nodes"][number];
    const report = qualityCheck({ background: bg, nodes: [lowContrastText, overflowing], size: SIZE });
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.kind === "contrast")).toBe(true);
    expect(report.issues.some((i) => i.kind === "overflow")).toBe(true);
  });
});
