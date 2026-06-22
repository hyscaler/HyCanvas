import { describe, it, expect } from "vitest";
import { createBlankDesign, createNode, type DesignFile, type Node } from "@hc/schema";
import {
  applyFilenameTemplate,
  applyPreset,
  toPreset,
  ExportError,
  preflight,
  rasterDimensions,
  resolvePages,
  toSvg,
  type ExportRequest,
} from "../index";

function shape(id: string, init?: Partial<Node>): Node {
  return createNode("shape", {
    id,
    shape: "rect",
    transform: { x: 10, y: 20, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: 100, height: 60 },
    fills: [{ type: "solid", color: { srgb: { r: 1, g: 0, b: 0, a: 1 } } }],
    ...init,
  } as Partial<Node>);
}

function twoPageDesign(): DesignFile {
  const d = createBlankDesign({ title: "My Design", width: 800, height: 600 });
  d.pages.push({ id: "p2", name: "Page 2", width: 400, height: 300, children: [] });
  return d;
}

describe("resolvePages (FR-1, Section 9)", () => {
  it("resolves all/current/range and de-dups range order", () => {
    const d = twoPageDesign();
    expect(resolvePages(d, { mode: "all" })).toEqual([0, 1]);
    expect(resolvePages(d, { mode: "current" }, 1)).toEqual([1]);
    expect(resolvePages(d, { mode: "range", range: [1, 1, 0] })).toEqual([1, 0]);
  });

  it("throws on out-of-range and empty selections", () => {
    const d = twoPageDesign();
    expect(() => resolvePages(d, { mode: "range", range: [5] })).toThrow(ExportError);
    expect(() => resolvePages(d, { mode: "range", range: [] })).toThrow(/empty-range|no pages/);
    expect(() => resolvePages(d, { mode: "current" }, 9)).toThrow(/out of range/);
  });
});

describe("rasterDimensions (FR-3, AC-2)", () => {
  it("2x scale and explicit 300 DPI produce correct pixel dimensions", () => {
    const page = { width: 800, height: 600 };
    expect(rasterDimensions(page, { scale: 2 }, 96)).toMatchObject({ width: 1600, height: 1200, scale: 2 });
    const dpi = rasterDimensions(page, { dpi: 300 }, 96);
    expect(dpi.width).toBe(Math.round(800 * (300 / 96)));
    expect(dpi.height).toBe(Math.round(600 * (300 / 96)));
    expect(dpi.dpi).toBeCloseTo(300, 6);
  });

  it("defaults to 1x and never below 1px", () => {
    expect(rasterDimensions({ width: 10, height: 10 })).toMatchObject({ width: 10, height: 10, scale: 1 });
    expect(rasterDimensions({ width: 0, height: 0 }, { scale: 1 }).width).toBe(1);
  });
});

describe("applyFilenameTemplate", () => {
  it("substitutes tokens and appends the format extension", () => {
    expect(applyFilenameTemplate("{title}-{page}", { title: "My Design", format: "png", index: 0, total: 3 })).toBe("My-Design-1.png");
    expect(applyFilenameTemplate("{title}", { title: "Logo", format: "pdfx", index: 0, total: 1 })).toBe("Logo.pdf");
    expect(applyFilenameTemplate("page-{index}-of-{total}", { title: "x", format: "jpg", index: 2, total: 5 })).toBe("page-2-of-5.jpg");
  });

  it("does not duplicate an extension already present", () => {
    expect(applyFilenameTemplate("{title}.png", { title: "a", format: "png", index: 0, total: 1 })).toBe("a.png");
  });
});

describe("presets (FR-8, AC-7)", () => {
  it("round-trips a request through a preset across designs", () => {
    const req: ExportRequest = {
      designId: "design-A",
      format: "png",
      pages: { mode: "range", range: [0, 2] },
      raster: { transparent: true, scale: 2 },
      filenameTemplate: "{title}-{page}",
    };
    const preset = toPreset(req, { id: "pr1", name: "Social PNG", scope: "user" });
    expect("designId" in preset.request).toBe(false);
    const applied = applyPreset(preset, "design-B");
    expect(applied).toEqual({ ...req, designId: "design-B" });
    // Applying does not alias the stored preset.
    applied.raster!.scale = 4;
    expect(preset.request.raster!.scale).toBe(2);
  });
});

describe("preflight (FR-11, AC-8)", () => {
  function imageNode(id: string, naturalWH: number, displayWH: number): Node {
    return {
      id,
      type: "image",
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: displayWH, height: displayWH },
      opacity: 1,
      blendMode: "normal",
      source: { assetId: "a1", naturalWidth: naturalWH, naturalHeight: naturalWH },
      fit: "cover",
    } as unknown as Node;
  }

  it("flags a low-resolution image for the chosen format threshold", () => {
    const d = createBlankDesign({ width: 800, height: 600 });
    // 100 source px shown at 200px @96dpi -> ~48 ppi.
    d.pages[0].children = [imageNode("img", 100, 200)];
    const req: ExportRequest = { designId: "d", format: "png", pages: { mode: "all" } };
    const report = preflight(d, req);
    expect(report.lowResImages).toHaveLength(1);
    expect(report.lowResImages[0]).toMatchObject({ nodeId: "img" });
    expect(report.lowResImages[0].ppi).toBeLessThan(72);
  });

  it("flags missing bleed only for print (pdfx) pages without bleed", () => {
    const d = createBlankDesign({ width: 800, height: 600 });
    const print: ExportRequest = { designId: "d", format: "pdfx", pages: { mode: "all" }, pdf: { intent: "cmyk", embedFonts: true } };
    expect(preflight(d, print).missingBleed).toBe(true);
    d.pages[0].bleed = 9;
    expect(preflight(d, print).missingBleed).toBe(false);
    // Non-print never flags bleed.
    expect(preflight(d, { designId: "d", format: "png", pages: { mode: "all" } }).missingBleed).toBe(false);
  });

  it("runs the CMYK gamut pass without error (naive CMM is lossless -> no flags yet)", () => {
    const d = createBlankDesign();
    d.pages[0].children = [shape("s")];
    const req: ExportRequest = { designId: "d", format: "pdfx", pages: { mode: "all" }, pdf: { intent: "cmyk", embedFonts: true } };
    expect(preflight(d, req).outOfGamut).toEqual([]);
  });
});

describe("toSvg (FR-4, AC-3)", () => {
  it("emits an svg root with viewBox and a background rect", () => {
    const d = createBlankDesign({ width: 800, height: 600 });
    d.pages[0].background = { type: "solid", color: { srgb: { r: 1, g: 1, b: 1, a: 1 } } };
    d.pages[0].children = [shape("s")];
    const svg = toSvg(d, 0);
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('viewBox="0 0 800 600"');
    expect(svg).toContain('width="800"');
    // background + the shape rect both present
    expect(svg.match(/<rect /g)!.length).toBeGreaterThanOrEqual(2);
    expect(svg).toContain('fill="rgb(255,0,0)"');
    // editable: the shape is a <rect>, not a flattened image
    expect(svg).not.toContain("<image");
    expect(svg).toContain('transform="matrix(');
    expect(svg).toContain('data-oc-id="s"');
  });

  it("emits editable text tspans and a gradient def", () => {
    const d = createBlankDesign({ width: 400, height: 200 });
    const txt = createNode("text", {
      id: "t",
      transform: { x: 5, y: 5, scaleX: 1, scaleY: 1, rotation: 0 },
      content: [
        { runs: [{ text: "Hello", style: { fontFamily: "Inter", fontStyle: "Regular", fontSize: 24, fill: { type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } } } }], style: { align: "left", direction: "auto" } },
      ],
    } as Partial<Node>);
    const grad = shape("g", {
      fills: [{ type: "gradient", gradient: "linear", angle: 90, stops: [
        { position: 0, color: { srgb: { r: 1, g: 0, b: 0, a: 1 } } },
        { position: 1, color: { srgb: { r: 0, g: 0, b: 1, a: 1 } } },
      ] }],
    } as Partial<Node>);
    d.pages[0].children = [txt, grad];
    const svg = toSvg(d, 0);
    expect(svg).toContain("<text");
    expect(svg).toContain("<tspan");
    expect(svg).toContain("Hello");
    expect(svg).toContain("<linearGradient");
    expect(svg).toContain('fill="url(#grad-1)"');
  });

  it("escapes XML special characters in text", () => {
    const d = createBlankDesign({ width: 100, height: 100 });
    const txt = createNode("text", {
      id: "t",
      content: [{ runs: [{ text: "a < b & \"c\"", style: { fontFamily: "x", fontStyle: "Regular", fontSize: 12, fill: { type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } } } }], style: { align: "left", direction: "auto" } }],
    } as Partial<Node>);
    d.pages[0].children = [txt];
    const svg = toSvg(d, 0);
    expect(svg).toContain("a &lt; b &amp; &quot;c&quot;");
  });

  it("throws for an out-of-range page index", () => {
    const d = createBlankDesign();
    expect(() => toSvg(d, 9)).toThrow(/out of range/);
  });
});
