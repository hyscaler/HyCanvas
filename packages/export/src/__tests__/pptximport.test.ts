// PPTX import (doc 28): the round-trip proof. A deck exported by our own
// deckToPptx re-imports with structure intact (slides, text runs + styling,
// shapes + fills, images + assets, notes, background), and deflate-compressed
// archives (what PowerPoint actually writes) unzip correctly. The XML parser
// and coordinate/rotation conversions get targeted checks.
import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { createBlankDesign, createNode, validate, type DesignFile, type Node } from "@hc/schema";
import { deckToPptx } from "../pptx";
import { pptxToDesign } from "../pptximport";
import { parseXml, findFirst } from "../xml";
import { unzip } from "../unzip";
import { zipStore } from "../zipstore";

const PNG_STUB = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

function sampleDeck(): DesignFile {
  const file = createBlankDesign({ title: "Round trip", width: 1280, height: 720 });
  file.pages[0].id = "s1";
  (file.pages[0] as { notes?: string }).notes = "Open strong.";
  (file.pages[0] as { background?: unknown }).background = { type: "solid", color: { srgb: { r: 0.95, g: 0.97, b: 1, a: 1 } } };
  file.pages[0].children = [
    createNode("shape", {
      id: "sh1",
      shape: "ellipse",
      transform: { x: 100, y: 80, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 300, height: 200 },
      fills: [{ type: "solid", color: { srgb: { r: 0.2, g: 0.4, b: 0.8, a: 1 } } }],
      stroke: { fill: { type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } }, width: 2, align: "center", cap: "butt", join: "miter" },
    } as Partial<Node>),
    createNode("text", {
      id: "tx1",
      transform: { x: 120, y: 320, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 600, height: 60 },
      content: [{
        runs: [
          { text: "Hello ", style: { fontFamily: "Inter", fontStyle: "Bold", fontSize: 32, fill: { type: "solid", color: { srgb: { r: 0.1, g: 0.1, b: 0.1, a: 1 } } } } },
          { text: "world", style: { fontFamily: "Inter", fontStyle: "Regular", fontSize: 32, fill: { type: "solid", color: { srgb: { r: 0.8, g: 0.2, b: 0.2, a: 1 } } } } },
        ],
        style: { align: "center" },
      }],
    } as Partial<Node>),
    createNode("image", {
      id: "im1",
      transform: { x: 700, y: 100, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 320, height: 180 },
      source: { assetId: "asset-1", naturalWidth: 640, naturalHeight: 480 },
      fit: "cover",
    } as Partial<Node>),
  ];
  return file;
}

describe("pptxToDesign", () => {
  it("round-trips our own export: slides, text, shapes, images, notes, background", async () => {
    const bytes = await deckToPptx(sampleDeck(), {
      resolveImage: async () => ({ data: PNG_STUB, mime: "image/png" }),
    });
    const file = await pptxToDesign(bytes, { title: "Back again" });

    expect(file.pages).toHaveLength(1);
    expect(file.pages[0].width).toBe(1280);
    expect(file.pages[0].height).toBe(720);
    expect((file.pages[0] as { notes?: string }).notes).toBe("Open strong.");
    const bg = (file.pages[0] as { background?: { type?: string } }).background;
    expect(bg?.type).toBe("solid");

    const kids = file.pages[0].children as Node[];
    const shape = kids.find((n) => n.type === "shape")!;
    expect((shape as unknown as { shape: string }).shape).toBe("ellipse");
    expect(Math.round(shape.transform.x)).toBe(100);
    expect(Math.round(shape.size.width)).toBe(300);
    const fills = (shape as unknown as { fills: { color: { srgb: { b: number } } }[] }).fills;
    expect(fills[0].color.srgb.b).toBeCloseTo(0.8, 1);
    expect((shape as unknown as { stroke?: { width: number } }).stroke?.width).toBeCloseTo(2, 0);

    const text = kids.find((n) => n.type === "text")!;
    const paras = (text as unknown as { content: { runs: { text: string; style: { fontStyle: string; fontSize: number; fontFamily: string } }[]; style: { align: string } }[] }).content;
    expect(paras[0].runs.map((r) => r.text)).toEqual(["Hello ", "world"]);
    expect(paras[0].runs[0].style.fontStyle).toBe("Bold");
    expect(paras[0].runs[0].style.fontFamily).toBe("Inter");
    expect(paras[0].runs[0].style.fontSize).toBeCloseTo(32, 0);
    expect(paras[0].style.align).toBe("center");

    const image = kids.find((n) => n.type === "image")!;
    const assetId = (image as unknown as { source: { assetId: string } }).source.assetId;
    const asset = (file as { assets?: { id: string; url: string }[] }).assets?.find((a) => a.id === assetId);
    expect(asset?.url.startsWith("data:image/png;base64,")).toBe(true);
    // The cover crop derived on export comes back as an explicit crop.
    expect((image as unknown as { crop?: object }).crop).toBeTruthy();
  });

  it("converts PowerPoint center-rotation back to top-left-origin rotation", async () => {
    const file = createBlankDesign({ title: "rot", width: 1000, height: 1000 });
    file.pages[0].children = [
      createNode("shape", {
        id: "r1",
        shape: "rect",
        transform: { x: 100, y: 100, scaleX: 1, scaleY: 1, rotation: 90 },
        size: { width: 200, height: 100 },
        fills: [{ type: "solid", color: { srgb: { r: 1, g: 0, b: 0, a: 1 } } }],
      } as Partial<Node>),
    ];
    const back = await pptxToDesign(await deckToPptx(file));
    const shape = (back.pages[0].children as Node[]).find((n) => n.type === "shape")!;
    expect(shape.transform.rotation).toBeCloseTo(90, 3);
    expect(shape.transform.x).toBeCloseTo(100, 0); // full inverse of the export re-anchor
    expect(shape.transform.y).toBeCloseTo(100, 0);
  });

  it("unzips deflate-compressed archives (what PowerPoint writes)", async () => {
    // Build a tiny deflated zip by hand: one entry, method 8.
    const name = new TextEncoder().encode("hello.txt");
    const content = new TextEncoder().encode("hello pptx");
    const comp = new Uint8Array(deflateRawSync(content));
    const crcTable = (() => { const t = new Uint32Array(256); for (let n2 = 0; n2 < 256; n2++) { let c = n2; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n2] = c >>> 0; } return t; })();
    let crc = 0xffffffff;
    for (const b of content) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
    crc = (crc ^ 0xffffffff) >>> 0;

    const local = new Uint8Array(30 + name.length + comp.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(8, 8, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, comp.length, true); lv.setUint32(22, content.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30); local.set(comp, 30 + name.length);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(10, 8, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, comp.length, true); cv.setUint32(24, content.length, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, 0, true);
    central.set(name, 46);

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, 1, true); ev.setUint16(10, 1, true);
    ev.setUint32(12, central.length, true); ev.setUint32(16, local.length, true);

    const zip = new Uint8Array(local.length + central.length + eocd.length);
    zip.set(local, 0); zip.set(central, local.length); zip.set(eocd, local.length + central.length);

    const files = await unzip(zip);
    expect(new TextDecoder().decode(files.get("hello.txt"))).toBe("hello pptx");
  });

  it("parses XML with attributes, nesting, entities, CDATA, and self-closing tags", () => {
    const root = parseXml(`<?xml version="1.0"?><a:r x="1&amp;2"><a:t>Hi &lt;there&gt;</a:t><b/><![CDATA[raw]]></a:r>`);
    expect(root.tag).toBe("a:r");
    expect(root.attrs.x).toBe("1&2");
    expect(findFirst(root, "a:t")!.text).toBe("Hi <there>");
    expect(findFirst(root, "b")).toBeTruthy();
    expect(root.text).toBe("raw");
  });

  // Real PowerPoint decks carry tables, charts and SmartArt as p:graphicFrame.
  // A table must come back editable; anything with no native equivalent must
  // still leave a visible marker rather than vanishing from the slide.
  it("imports graphicFrame tables as editable tables and marks what it cannot convert", async () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const frame = (inner: string, x: number) =>
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="Q3 numbers"/></p:nvGraphicFramePr>` +
      `<p:xfrm><a:off x="${x}" y="952500"/><a:ext cx="2857500" cy="1905000"/></p:xfrm>` +
      `<a:graphic><a:graphicData uri="${inner.includes("a:tbl") ? "http://schemas.openxmlformats.org/drawingml/2006/table" : "http://schemas.openxmlformats.org/drawingml/2006/chart"}">${inner}</a:graphicData></a:graphic></p:graphicFrame>`;
    const cell = (t: string) => `<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>${t}</a:t></a:r></a:p></a:txBody></a:tc>`;
    const tbl =
      `<a:tbl><a:tblGrid><a:gridCol w="1428750"/><a:gridCol w="1428750"/></a:tblGrid>` +
      `<a:tr h="476250">${cell("Region")}${cell("Revenue")}</a:tr>` +
      `<a:tr h="476250">${cell("EMEA")}${cell("1.2M")}</a:tr></a:tbl>`;
    const slideXml =
      `<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>` +
      frame(tbl, 952500) +
      frame(`<c:chart xmlns:c="c" r:id="rId9" xmlns:r="r"/>`, 4762500) +
      `</p:spTree></p:cSld></p:sld>`;
    const bytes = zipStore([
      { name: "ppt/presentation.xml", data: enc(`<?xml version="1.0"?><p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`) },
      { name: "ppt/_rels/presentation.xml.rels", data: enc(`<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>`) },
      { name: "ppt/slides/slide1.xml", data: enc(slideXml) },
    ]);

    const file = await pptxToDesign(bytes);
    const kids = file.pages[0].children as Node[];

    const table = kids.find((n) => n.type === "table") as unknown as {
      rows: number; cols: number; colWidths: number[]; cells: { row: number; col: number; content: { text: string }[] }[];
      transform: { x: number }; size: { width: number };
    };
    expect(table).toBeTruthy();
    expect([table.rows, table.cols]).toEqual([2, 2]);
    // The whole imported file must satisfy the OPEN FORMAT, not merely look
    // right: a table cell is TextRun[] (fontId/fontSize/weight), not the
    // paragraph/run tree a text node uses. Getting that wrong writes a design
    // the frontend's own validator would later refuse to open.
    const check = validate(file);
    expect(check.ok, "ok" in check && !check.ok ? `${check.pointer}: ${check.message}` : "").toBe(true);
    const run = table.cells[0].content[0] as unknown as { text: string; fontId: string; fontSize: number; weight: number };
    expect(run.fontId).toBeTruthy();
    expect(typeof run.fontSize).toBe("number");
    expect(run.weight).toBeGreaterThanOrEqual(100);
    expect(table.cells.map((c) => c.content.map((r) => r.text).join(""))).toEqual(["Region", "Revenue", "EMEA", "1.2M"]);
    // Positioned where the slide put it, and the grid scales into that frame.
    expect(Math.round(table.transform.x)).toBe(100);
    expect(Math.round(table.size.width)).toBe(300);
    expect(Math.round(table.colWidths.reduce((a, b) => a + b, 0))).toBe(300);

    // The chart has no native equivalent yet: it must still be visible, in place.
    const marker = kids.find((n) => n.type === "text") as unknown as { content: { runs: { text: string }[] }[]; transform: { x: number } };
    expect(marker).toBeTruthy();
    const label = marker.content[0].runs[0].text;
    expect(label).toContain("Chart");
    expect(label).toContain("Q3 numbers");
    expect(Math.round(marker.transform.x)).toBe(500);
  });

  it("rejects non-pptx archives cleanly", async () => {
    await expect(pptxToDesign(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });
});

// --- Fidelity golden set (F28 T22 part 1) ------------------------------------
// The import half: decorated multi-run text, the b="1" -> Bold mapping,
// gradient fills with their stops, explicit crops, multi-paragraph notes,
// z-order, group flattening through chOff/chExt, and the no-silent-drop rule
// (an unconvertible graphicFrame lands as a labelled placeholder in place).
describe("pptxToDesign fidelity goldens", () => {
  it("round-trips decorated runs, gradients, crops, notes, and z-order through our exporter", async () => {
    const file = createBlankDesign({ title: "golden", width: 1280, height: 720 });
    (file.pages[0] as { notes?: string }).notes = "First cue.\n\nSecond cue."; // the blank line is deliberate spacing
    (file.pages[0] as { background?: unknown }).background = {
      type: "gradient", gradient: "linear", angle: 135,
      stops: [
        { position: 0, color: { srgb: { r: 0.1, g: 0.2, b: 0.9, a: 1 } } },
        { position: 1, color: { srgb: { r: 0, g: 0, b: 0.2, a: 1 } } },
      ],
    };
    file.pages[0].children = [
      // z-order bottom: a gradient-filled shape.
      createNode("shape", {
        id: "z0", shape: "rect",
        transform: { x: 40, y: 40, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 200, height: 100 },
        fills: [{
          type: "gradient", gradient: "linear", angle: 90,
          stops: [
            { position: 0, color: { srgb: { r: 1, g: 0.5, b: 0, a: 1 } } },
            { position: 0.5, color: { srgb: { r: 1, g: 1, b: 0, a: 1 } } },
            { position: 1, color: { srgb: { r: 0, g: 0.5, b: 0, a: 1 } } },
          ],
        }],
      } as Partial<Node>),
      // z-order middle: a paragraph mixing four styling shapes in one run list.
      createNode("text", {
        id: "z1",
        transform: { x: 60, y: 300, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 900, height: 80 },
        content: [{
          runs: [
            { text: "bold ", style: { fontFamily: "Inter", fontStyle: "Bold", fontSize: 24 } },
            { text: "italic ", style: { fontFamily: "Inter", fontStyle: "Italic", fontSize: 24 } },
            { text: "deco ", style: { fontFamily: "Inter", fontStyle: "Regular", fontSize: 24, decoration: ["underline", "strikethrough"] } },
            { text: "both", style: { fontFamily: "Inter", fontStyle: "Bold Italic", fontSize: 24 } },
          ],
          style: { align: "left" },
        }],
      } as Partial<Node>),
      // z-order top: an explicitly cropped image.
      createNode("image", {
        id: "z2",
        transform: { x: 800, y: 80, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 320, height: 180 },
        source: { assetId: "asset-1", naturalWidth: 1280, naturalHeight: 720 },
        fit: "cover",
        crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      } as Partial<Node>),
    ];
    const back = await pptxToDesign(
      await deckToPptx(file, { resolveImage: async () => ({ data: PNG_STUB, mime: "image/png" }) }),
    );
    const page = back.pages[0];
    // Notes: both paragraphs AND the deliberate blank line between them.
    expect((page as { notes?: string }).notes).toBe("First cue.\n\nSecond cue.");
    // Background gradient with both stops AND the angle (identity both ways).
    const bg = (page as { background?: { type?: string; angle?: number; stops?: { color: { srgb: { b: number } } }[] } }).background;
    expect(bg?.type).toBe("gradient");
    expect(bg?.stops).toHaveLength(2);
    expect(bg!.stops![0].color.srgb.b).toBeCloseTo(0.9, 1);
    expect(bg!.angle).toBeCloseTo(135, 3);
    // Z-order: children come back in spTree order (bottom first).
    const kinds = (page.children as Node[]).map((n) => n.type);
    expect(kinds).toEqual(["shape", "text", "image"]);
    // Shape gradient: all three stops in order, angle preserved.
    const shape = page.children[0] as unknown as { fills: { type: string; angle?: number; stops?: { position: number }[] }[] };
    expect(shape.fills[0].type).toBe("gradient");
    expect(shape.fills[0].stops?.map((s) => s.position)).toEqual([0, 0.5, 1]);
    expect(shape.fills[0].angle).toBeCloseTo(90, 3);
    // Runs: styles and decorations mapped back.
    const paras = (page.children[1] as unknown as { content: { runs: { text: string; style: { fontStyle: string; decoration?: string[] } }[] }[] }).content;
    expect(paras[0].runs.map((r) => r.style.fontStyle)).toEqual(["Bold", "Italic", "Regular", "Bold Italic"]);
    expect(paras[0].runs[2].style.decoration).toEqual(["underline", "strikethrough"]);
    // Crop: the explicit crop round-trips through a:srcRect.
    const crop = (page.children[2] as unknown as { crop?: { x: number; y: number; width: number; height: number } }).crop!;
    expect(crop.x).toBeCloseTo(0.25, 3);
    expect(crop.y).toBeCloseTo(0.25, 3);
    expect(crop.width).toBeCloseTo(0.5, 3);
    expect(crop.height).toBeCloseTo(0.5, 3);
  });

  it("a radial gradient round-trips as radial", async () => {
    const file = createBlankDesign({ title: "radial-rt", width: 1000, height: 1000 });
    file.pages[0].children = [
      createNode("shape", {
        id: "rad", shape: "rect",
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 100, height: 100 },
        fills: [{
          type: "gradient", gradient: "radial",
          stops: [
            { position: 0, color: { srgb: { r: 1, g: 1, b: 1, a: 1 } } },
            { position: 1, color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } },
          ],
        }],
      } as Partial<Node>),
    ];
    const back = await pptxToDesign(await deckToPptx(file));
    const shape = (back.pages[0].children as Node[]).find((n) => n.type === "shape")!;
    const fill = (shape as unknown as { fills: { type: string; gradient?: string }[] }).fills[0];
    expect(fill.type).toBe("gradient");
    expect(fill.gradient).toBe("radial");
  });

  it("table cells map b=1 to weight 700 and its absence to 400 on import", async () => {
    const cell = (text: string, bold: boolean) =>
      `<a:tc><a:txBody><a:p><a:r><a:rPr${bold ? ' b="1"' : ""} sz="1400"/><a:t>${text}</a:t></a:r></a:p></a:txBody></a:tc>`;
    const tbl =
      `<a:tbl><a:tblGrid><a:gridCol w="1905000"/><a:gridCol w="1905000"/></a:tblGrid>` +
      `<a:tr h="381000">${cell("Head", true)}${cell("Body", false)}</a:tr></a:tbl>`;
    const slide =
      `<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>` +
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="t"/></p:nvGraphicFramePr>` +
      `<p:xfrm><a:off x="952500" y="952500"/><a:ext cx="3810000" cy="381000"/></p:xfrm>` +
      `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">${tbl}</a:graphicData></a:graphic>` +
      `</p:graphicFrame></p:spTree></p:cSld></p:sld>`;
    const bytes = zipStore([
      { name: "ppt/presentation.xml", data: new TextEncoder().encode('<?xml version="1.0"?><p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>') },
      { name: "ppt/_rels/presentation.xml.rels", data: new TextEncoder().encode('<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>') },
      { name: "ppt/slides/slide1.xml", data: new TextEncoder().encode(slide) },
    ]);
    const file = await pptxToDesign(bytes);
    const table = (file.pages[0].children as Node[]).find((n) => n.type === "table") as unknown as {
      cells: { content: { text: string; weight: number }[] }[];
    };
    expect(table).toBeTruthy();
    expect(table.cells[0].content[0].weight).toBe(700); // b="1" -> bold
    expect(table.cells[1].content[0].weight).toBe(400); // absent -> regular
  });

  it("a group flattens through chOff/chExt scaling on import", async () => {
    // A raw grpSp whose child coordinate space (chOff/chExt) differs from its
    // placed extent: the child's frame must scale into slide space.
    const slide = `<?xml version="1.0"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld><p:spTree>
    <p:grpSp>
      <p:grpSpPr><a:xfrm>
        <a:off x="952500" y="952500"/><a:ext cx="1905000" cy="1905000"/>
        <a:chOff x="0" y="0"/><a:chExt cx="952500" cy="952500"/>
      </a:xfrm></p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="kid"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="95250" y="190500"/><a:ext cx="190500" cy="95250"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>
        </p:spPr>
      </p:sp>
    </p:grpSp>
  </p:spTree></p:cSld>
</p:sld>`;
    const bytes = zipStore([
      { name: "ppt/presentation.xml", data: new TextEncoder().encode('<?xml version="1.0"?><p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>') },
      { name: "ppt/_rels/presentation.xml.rels", data: new TextEncoder().encode('<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>') },
      { name: "ppt/slides/slide1.xml", data: new TextEncoder().encode(slide) },
    ]);
    const file = await pptxToDesign(bytes);
    const shape = (file.pages[0].children as Node[]).find((n) => n.type === "shape")!;
    // Group: placed at (100,100)px, 200x200; child space 100x100 -> scale 2.
    // Child at (10,20) 20x10 in child units -> (100+20, 100+40) 40x20 on the slide.
    expect(shape.transform.x).toBeCloseTo(120, 0);
    expect(shape.transform.y).toBeCloseTo(140, 0);
    expect(shape.size.width).toBeCloseTo(40, 0);
    expect(shape.size.height).toBeCloseTo(20, 0);
  });

  it("no silent drops: a chart graphicFrame imports as a labelled placeholder in place", async () => {
    const slide = `<?xml version="1.0"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:graphicFrame>
      <p:nvGraphicFramePr><p:cNvPr id="5" name="Sales chart"/></p:nvGraphicFramePr>
      <p:xfrm><a:off x="952500" y="1905000"/><a:ext cx="3810000" cy="2857500"/></p:xfrm>
      <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"/></a:graphic>
    </p:graphicFrame>
  </p:spTree></p:cSld>
</p:sld>`;
    const bytes = zipStore([
      { name: "ppt/presentation.xml", data: new TextEncoder().encode('<?xml version="1.0"?><p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>') },
      { name: "ppt/_rels/presentation.xml.rels", data: new TextEncoder().encode('<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>') },
      { name: "ppt/slides/slide1.xml", data: new TextEncoder().encode(slide) },
    ]);
    const file = await pptxToDesign(bytes);
    const kids = file.pages[0].children as Node[];
    expect(kids).toHaveLength(1); // present, not dropped
    const box = kids[0] as unknown as { type: string; content: { runs: { text: string }[] }[]; transform: { x: number; y: number }; size: { width: number } };
    expect(box.type).toBe("text");
    expect(box.content[0].runs[0].text).toContain("Chart");
    expect(box.content[0].runs[0].text).toContain("Sales chart");
    expect(box.transform.x).toBeCloseTo(100, 0); // in position (952500 EMU = 100px)
    expect(box.transform.y).toBeCloseTo(200, 0);
    expect(box.size.width).toBeCloseTo(400, 0);
  });
});

// --- Archive-bomb guards (F28 completion C01) ---------------------------------
// Untrusted archives must be rejected, never allowed to exhaust the tab: entry
// count, per-entry decompressed size, and total decompressed size all cap, and
// the per-entry cap trips DURING inflation (a lying directory cannot bypass it).
describe("unzip archive-bomb guards", () => {
  const deflated = (payload: Uint8Array) => deflateRawSync(payload);

  function zipWithDeflate(entries: { name: string; raw: Uint8Array; comp: Uint8Array }[]): Uint8Array {
    // Hand-build a minimal method-8 zip (zipStore only writes method 0).
    const enc = new TextEncoder();
    const locals: Uint8Array[] = [];
    const centrals: Uint8Array[] = [];
    let offset = 0;
    for (const e of entries) {
      const nameB = enc.encode(e.name);
      const local = new Uint8Array(30 + nameB.length + e.comp.length);
      const ldv = new DataView(local.buffer);
      ldv.setUint32(0, 0x04034b50, true);
      ldv.setUint16(8, 8, true); // method deflate
      ldv.setUint32(18, e.comp.length, true);
      ldv.setUint32(22, e.raw.length, true);
      ldv.setUint16(26, nameB.length, true);
      local.set(nameB, 30);
      local.set(e.comp, 30 + nameB.length);
      locals.push(local);
      const central = new Uint8Array(46 + nameB.length);
      const cdv = new DataView(central.buffer);
      cdv.setUint32(0, 0x02014b50, true);
      cdv.setUint16(10, 8, true);
      cdv.setUint32(20, e.comp.length, true);
      cdv.setUint32(24, e.raw.length, true);
      cdv.setUint16(28, nameB.length, true);
      cdv.setUint32(42, offset, true);
      central.set(nameB, 46);
      centrals.push(central);
      offset += local.length;
    }
    const cdStart = offset;
    let cdLen = 0;
    for (const c of centrals) cdLen += c.length;
    const eocd = new Uint8Array(22);
    const edv = new DataView(eocd.buffer);
    edv.setUint32(0, 0x06054b50, true);
    edv.setUint16(8, entries.length, true);
    edv.setUint16(10, entries.length, true);
    edv.setUint32(12, cdLen, true);
    edv.setUint32(16, cdStart, true);
    const out = new Uint8Array(offset + cdLen + 22);
    let p = 0;
    for (const l of locals) { out.set(l, p); p += l.length; }
    for (const c of centrals) { out.set(c, p); p += c.length; }
    out.set(eocd, p);
    return out;
  }

  it("rejects an archive with too many entries before reading any", async () => {
    const bytes = zipStore(Array.from({ length: 3 }, (_, i) => ({ name: `e${i}.txt`, data: new Uint8Array([1]) })));
    await expect(unzip(bytes, { maxEntries: 2 })).rejects.toThrow(/too many entries/);
  });

  it("rejects an entry that expands past the per-entry cap mid-inflate", async () => {
    const big = new Uint8Array(1 << 20); // 1 MiB of zeros compresses to ~1 KB
    const bytes = zipWithDeflate([{ name: "bomb.xml", raw: big, comp: deflated(big) }]);
    await expect(unzip(bytes, { maxEntryBytes: 64 << 10 })).rejects.toThrow(/expands past the .* limit: bomb\.xml/);
  });

  it("rejects when the archive total crosses the total cap", async () => {
    const chunk = new Uint8Array(1 << 20);
    const comp = deflated(chunk);
    const bytes = zipWithDeflate([
      { name: "a.xml", raw: chunk, comp },
      { name: "b.xml", raw: chunk, comp },
      { name: "c.xml", raw: chunk, comp },
    ]);
    await expect(unzip(bytes, { maxTotalBytes: 2 << 20 })).rejects.toThrow(/total decompression limit/);
  });

  it("real archives under the caps are untouched", async () => {
    const payload = new TextEncoder().encode("hello world");
    const bytes = zipWithDeflate([{ name: "ok.xml", raw: payload, comp: deflated(payload) }]);
    const files = await unzip(bytes);
    expect(new TextDecoder().decode(files.get("ok.xml"))).toBe("hello world");
  });
});
