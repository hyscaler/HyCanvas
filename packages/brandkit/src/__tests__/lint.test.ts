import { describe, expect, it } from "vitest";
import { createBlankDesign, createNode, type Color, type DesignFile, type Node } from "@hc/schema";
import { evaluateBrandGate, lintDesign, type LintBrandKit } from "../index";

function rgb(r: number, g: number, b: number, a = 1): Color {
  return { srgb: { r, g, b, a } };
}

// A kit: white + black palette, "Inter" body font, one logo with min size 80px.
function makeKit(over: Partial<LintBrandKit["controls"]> = {}): LintBrandKit {
  return {
    palettes: [
      {
        id: "p1",
        name: "Core",
        colors: [
          { id: "s1", role: "background", value: rgb(1, 1, 1) },
          { id: "s2", role: "primary", value: rgb(0, 0, 0) },
        ],
      },
    ],
    fonts: [{ id: "f1", role: "body", fontFamily: "Inter" }],
    logos: [{ id: "l1", label: "primary", assetId: "logo-asset", minSizePx: 80 }],
    controls: { lockColors: true, lockFonts: true, lintPolicy: "warn", ...over },
  };
}

function withBg(color: Color): DesignFile {
  const d = createBlankDesign({ title: "D", width: 800, height: 600 });
  d.pages[0].background = { type: "solid", color };
  return d;
}

function textNode(opts: { font?: string; color?: Color; id?: string }): Node {
  return createNode("text", {
    id: opts.id ?? "txt",
    transform: { x: 100, y: 100, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: 300, height: 60 },
    content: [
      {
        align: "left",
        runs: [
          {
            text: "Hello",
            style: {
              fontFamily: opts.font ?? "Inter",
              fontSize: 24,
              ...(opts.color ? { color: opts.color } : {}),
            },
          },
        ],
      },
    ],
  } as Partial<Node>);
}

describe("lintDesign", () => {
  it("returns no violations for a clean, on-brand design", () => {
    const file = withBg(rgb(1, 1, 1));
    file.pages[0].children = [
      createNode("shape", {
        id: "rect",
        shape: "rect",
        transform: { x: 100, y: 100, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 100, height: 100 },
        fills: [{ type: "solid", color: rgb(0, 0, 0) }],
      } as Partial<Node>),
      textNode({ font: "Inter", color: rgb(0, 0, 0) }),
    ];
    expect(lintDesign(file, makeKit())).toEqual([]);
  });

  it("flags an off-brand color and offers a snap_color fix to the nearest swatch", () => {
    const file = withBg(rgb(1, 1, 1));
    file.pages[0].children = [
      createNode("shape", {
        id: "rect",
        shape: "rect",
        transform: { x: 100, y: 100, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 100, height: 100 },
        fills: [{ type: "solid", color: rgb(0.05, 0.05, 0.05) }], // near-black, off palette
      } as Partial<Node>),
    ];
    const v = lintDesign(file, makeKit()).filter((x) => x.kind === "off-brand-color");
    expect(v).toHaveLength(1);
    expect(v[0].nodeId).toBe("rect");
    expect(v[0].fix?.kind).toBe("snap_color");
    // nearest swatch to near-black is black.
    expect((v[0].fix as { to: Color }).to.srgb).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  });

  it("does not flag colors when lockColors is off", () => {
    const file = withBg(rgb(0.3, 0.7, 0.2));
    expect(
      lintDesign(file, makeKit({ lockColors: false })).filter((x) => x.kind === "off-brand-color"),
    ).toEqual([]);
  });

  it("flags an off-brand font and offers a swap_font fix to the brand body font", () => {
    const file = withBg(rgb(1, 1, 1));
    file.pages[0].children = [textNode({ font: "Comic Sans", color: rgb(0, 0, 0) })];
    const v = lintDesign(file, makeKit()).filter((x) => x.kind === "off-brand-font");
    expect(v).toHaveLength(1);
    expect(v[0].fix).toEqual({ kind: "swap_font", from: "Comic Sans", to: "Inter" });
  });

  it("flags low-contrast text and offers a fix_contrast color that passes AA", () => {
    // light-grey text on white background fails AA.
    const file = withBg(rgb(1, 1, 1));
    file.pages[0].children = [textNode({ font: "Inter", color: rgb(0.85, 0.85, 0.85) })];
    const v = lintDesign(file, makeKit()).filter((x) => x.kind === "low-contrast");
    expect(v).toHaveLength(1);
    expect(v[0].fix?.kind).toBe("fix_contrast");
  });

  it("flags a distorted (non-uniform scale) logo with a restore_logo fix", () => {
    const file = withBg(rgb(1, 1, 1));
    file.pages[0].children = [
      createNode("image", {
        id: "logo",
        source: { assetId: "logo-asset", naturalWidth: 200, naturalHeight: 200 },
        fit: "contain",
        transform: { x: 100, y: 100, scaleX: 1, scaleY: 2, rotation: 0 },
        size: { width: 200, height: 200 },
      } as unknown as Partial<Node>),
    ];
    const v = lintDesign(file, makeKit()).filter((x) => x.id.startsWith("logo-aspect"));
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe("logo-misuse");
    expect(v[0].fix).toEqual({ kind: "restore_logo", reason: "aspect" });
  });

  it("flags a logo below its minimum size", () => {
    const file = withBg(rgb(1, 1, 1));
    file.pages[0].children = [
      createNode("image", {
        id: "logo",
        source: { assetId: "logo-asset", naturalWidth: 200, naturalHeight: 200 },
        fit: "contain",
        transform: { x: 100, y: 100, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 40, height: 40 }, // below 80px min
      } as unknown as Partial<Node>),
    ];
    const v = lintDesign(file, makeKit()).filter((x) => x.id.startsWith("logo-size"));
    expect(v).toHaveLength(1);
    expect(v[0].fix).toEqual({ kind: "restore_logo", reason: "min_size" });
  });

  it("flags a recolored logo (solid fill overlay) as misuse", () => {
    const file = withBg(rgb(1, 1, 1));
    file.pages[0].children = [
      createNode("image", {
        id: "logo",
        source: { assetId: "logo-asset", naturalWidth: 200, naturalHeight: 200 },
        fit: "contain",
        transform: { x: 100, y: 100, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 200, height: 200 },
        fills: [{ type: "solid", color: rgb(1, 0, 0) }],
      } as unknown as Partial<Node>),
    ];
    const v = lintDesign(file, makeKit()).filter((x) => x.id.startsWith("logo-recolor"));
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe("logo-misuse");
  });

  it("flags spacing: an element overlapping the brand margin", () => {
    const file = withBg(rgb(1, 1, 1));
    file.meta.brandMargin = 50;
    file.pages[0].children = [
      createNode("shape", {
        id: "rect",
        shape: "rect",
        transform: { x: 10, y: 10, scaleX: 1, scaleY: 1, rotation: 0 }, // x=10 < 50 margin
        size: { width: 100, height: 100 },
        fills: [{ type: "solid", color: rgb(0, 0, 0) }],
      } as Partial<Node>),
    ];
    const v = lintDesign(file, makeKit()).filter((x) => x.kind === "spacing");
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe("info");
  });

  it("returns no violations when lintPolicy is off", () => {
    const file = withBg(rgb(0.3, 0.7, 0.2)); // off-brand bg
    expect(lintDesign(file, makeKit({ lintPolicy: "off" }))).toEqual([]);
  });
});

describe("evaluateBrandGate", () => {
  function offBrand(): DesignFile {
    const file = withBg(rgb(1, 1, 1));
    file.pages[0].children = [textNode({ font: "Comic Sans", color: rgb(0, 0, 0) })];
    return file;
  }

  it("never blocks with no kit", () => {
    const r = evaluateBrandGate(offBrand(), null);
    expect(r.blocked).toBe(false);
    expect(r.policy).toBe("off");
    expect(r.violations).toEqual([]);
  });

  it("warns without blocking under policy 'warn'", () => {
    const r = evaluateBrandGate(offBrand(), makeKit({ lintPolicy: "warn" }));
    expect(r.policy).toBe("warn");
    expect(r.violations.length).toBeGreaterThan(0);
    expect(r.blocked).toBe(false);
  });

  it("blocks under policy 'block' when there is a non-info violation", () => {
    const r = evaluateBrandGate(offBrand(), makeKit({ lintPolicy: "block" }));
    expect(r.blocked).toBe(true);
  });

  it("does not block under 'block' for a clean design", () => {
    const file = withBg(rgb(1, 1, 1));
    file.pages[0].children = [textNode({ font: "Inter", color: rgb(0, 0, 0) })];
    const r = evaluateBrandGate(file, makeKit({ lintPolicy: "block" }));
    expect(r.blocked).toBe(false);
    expect(r.violations).toEqual([]);
  });
});
