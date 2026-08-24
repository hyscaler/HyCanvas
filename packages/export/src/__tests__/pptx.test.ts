// PPTX export (doc 28 interop): the package must be a structurally valid OOXML
// zip - every part present and referenced, every relationship target real,
// content types complete - and the slide XML must carry the deck's content
// (text runs with styling, shapes with fills, images with rels, notes,
// backgrounds, raster fallbacks). Zip integrity is checked by walking the
// local headers and the central directory.
import { describe, expect, it } from "vitest";
import { createBlankDesign, createNode, type DesignFile, type Node } from "@hc/schema";
import { deckToPptx } from "../pptx";

// --- tiny store-zip reader (local headers only; store mode) ----------------
function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  while (p + 4 <= bytes.length && dv.getUint32(p, true) === 0x04034b50) {
    const nameLen = dv.getUint16(p + 26, true);
    const extraLen = dv.getUint16(p + 28, true);
    const size = dv.getUint32(p + 18, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 30, p + 30 + nameLen));
    const start = p + 30 + nameLen + extraLen;
    out.set(name, bytes.subarray(start, start + size));
    p = start + size;
  }
  return out;
}

const textOf = (zip: Map<string, Uint8Array>, name: string): string => {
  const data = zip.get(name);
  expect(data, `missing part ${name}`).toBeTruthy();
  return new TextDecoder().decode(data);
};

function sampleDeck(): DesignFile {
  const file = createBlankDesign({ title: "Interop deck", width: 1280, height: 720 });
  file.pages[0].id = "s1";
  (file.pages[0] as { notes?: string }).notes = "Say hello.\nPause for effect.";
  (file.pages[0] as { background?: unknown }).background = { type: "solid", color: { srgb: { r: 1, g: 1, b: 1, a: 1 } } };
  file.pages[0].children = [
    createNode("shape", {
      id: "sh1",
      shape: "rect",
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
  // A second page with an exotic node exercising the raster fallback.
  const p2 = structuredClone(file.pages[0]);
  p2.id = "s2";
  (p2 as { notes?: string }).notes = "";
  p2.children = [
    createNode("qr", { id: "qr1", transform: { x: 40, y: 40, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 200, height: 200 } } as Partial<Node>),
  ];
  file.pages.push(p2);
  return file;
}

const PNG_STUB = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

describe("deckToPptx", () => {
  it("produces a structurally complete OOXML package", async () => {
    const zip = readZip(
      await deckToPptx(sampleDeck(), {
        resolveImage: async () => ({ data: PNG_STUB, mime: "image/png" }),
        rasterizeNode: async (_pi, _id) => ({ png: PNG_STUB, x: 40, y: 40, width: 200, height: 200 }),
      }),
    );

    // Package skeleton.
    for (const part of [
      "[Content_Types].xml",
      "_rels/.rels",
      "ppt/presentation.xml",
      "ppt/_rels/presentation.xml.rels",
      "ppt/slideMasters/slideMaster1.xml",
      "ppt/slideLayouts/slideLayout1.xml",
      "ppt/theme/theme1.xml",
      "ppt/slides/slide1.xml",
      "ppt/slides/slide2.xml",
      "ppt/slides/_rels/slide1.xml.rels",
      "ppt/notesSlides/notesSlide1.xml",
      "docProps/core.xml",
      "docProps/app.xml",
    ]) {
      expect(zip.has(part), `missing ${part}`).toBe(true);
    }

    // Every relationship target resolves to a real part.
    for (const [name, data] of zip) {
      if (!name.endsWith(".rels")) continue;
      const base = name.replace(/_rels\/[^/]+$/, "");
      const xml = new TextDecoder().decode(data);
      for (const m of xml.matchAll(/Target="([^"]+)"/g)) {
        const target = m[1];
        const resolved = target.startsWith("../")
          ? base.replace(/[^/]+\/$/, "") + target.slice(3)
          : base + target;
        expect(zip.has(resolved.replace(/^\//, "")), `${name} points at missing ${resolved}`).toBe(true);
      }
    }

    // presentation.xml: slide size in EMU and both slides listed.
    const pres = textOf(zip, "ppt/presentation.xml");
    expect(pres).toContain(`cx="${1280 * 9525}" cy="${720 * 9525}"`);
    expect(pres).toContain('r:id="rIdS1"');
    expect(pres).toContain('r:id="rIdS2"');

    // Slide 1 content: shape fill + stroke, styled runs, centered paragraph,
    // image rel with a derived cover crop, background.
    const s1 = textOf(zip, "ppt/slides/slide1.xml");
    expect(s1).toContain('<a:srgbClr val="3366CC">'); // 0.2/0.4/0.8
    expect(s1).toContain("<a:ln w=");
    expect(s1).toContain('algn="ctr"');
    expect(s1).toContain('b="1"'); // Bold run
    expect(s1).toContain("Hello ");
    expect(s1).toContain('<a:latin typeface="Inter"/>');
    expect(s1).toContain("r:embed=");
    expect(s1).toContain("<a:srcRect"); // cover crop derived from aspect mismatch
    expect(s1).toContain("<p:bg>");
    // Notes present and split into paragraphs.
    const n1 = textOf(zip, "ppt/notesSlides/notesSlide1.xml");
    expect(n1).toContain("Say hello.");
    expect(n1).toContain("Pause for effect.");

    // Slide 2: the QR node landed via the raster fallback at its bounds.
    const s2 = textOf(zip, "ppt/slides/slide2.xml");
    expect(s2).toContain("<p:pic>");
    expect(s2).toContain(`x="${40 * 9525}"`);
    // Media bytes present.
    expect([...zip.keys()].filter((k) => k.startsWith("ppt/media/")).length).toBeGreaterThanOrEqual(2);

    // Content types declare every slide + notes + media default.
    const ct = textOf(zip, "[Content_Types].xml");
    expect(ct).toContain("/ppt/slides/slide2.xml");
    expect(ct).toContain("notesSlide1.xml");
    expect(ct).toContain('Extension="png"');
  });

  it("skips unsupported nodes without a rasterizer but still exports", async () => {
    const bytes = await deckToPptx(sampleDeck(), { resolveImage: async () => null });
    const zip = readZip(bytes);
    const s2 = textOf(zip, "ppt/slides/slide2.xml");
    expect(s2).not.toContain("<p:pic>"); // QR dropped, slide still valid
    expect(textOf(zip, "ppt/slides/slide1.xml")).toContain("Hello ");
  });

  it("re-anchors a rotated node about its center and keeps flips", async () => {
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
    const zip = readZip(await deckToPptx(file));
    const s1 = textOf(zip, "ppt/slides/slide1.xml");
    expect(s1).toContain('rot="5400000"'); // 90deg * 60000
    // HyCanvas rotates about (100,100); rendered center = (100,100)+R(90)·(100,50)
    // = (100-50, 100+100) = (50, 200); PPT off = center - (w/2,h/2) = (-50, 150).
    expect(s1).toContain(`<a:off x="${-50 * 9525}" y="${150 * 9525}"/>`);
  });

  it("refuses an empty design", async () => {
    const file = createBlankDesign({ title: "empty", width: 100, height: 100 });
    file.pages = [];
    await expect(deckToPptx(file)).rejects.toThrow(/no pages/);
  });
});

// --- Fidelity golden set (F28 T22 part 1) ------------------------------------
// Pins the export rules that keep real-world decks faithful: gradient fills,
// the weight-600 bold threshold, decorated runs, group flattening vs the
// rotated-group raster fallback, explicit crops, and z-order. These are
// regression fixtures: a change that shifts any assertion is a fidelity change
// and must be deliberate.
describe("deckToPptx fidelity goldens", () => {
  const solid = (r: number, g: number, b: number, a = 1) => ({ type: "solid", color: { srgb: { r, g, b, a } } });

  it("gradient fills export natively with every stop and the angle", async () => {
    const file = createBlankDesign({ title: "grad", width: 1000, height: 1000 });
    (file.pages[0] as { background?: unknown }).background = {
      type: "gradient", gradient: "linear", angle: 90,
      stops: [
        { position: 0, color: { srgb: { r: 1, g: 0, b: 0, a: 1 } } },
        { position: 1, color: { srgb: { r: 0, g: 0, b: 1, a: 1 } } },
      ],
    };
    file.pages[0].children = [
      createNode("shape", {
        id: "g1", shape: "rect",
        transform: { x: 10, y: 10, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 100, height: 100 },
        fills: [{
          type: "gradient", gradient: "linear", angle: 135,
          stops: [
            { position: 0, color: { srgb: { r: 0, g: 1, b: 0, a: 1 } } },
            { position: 0.5, color: { srgb: { r: 1, g: 1, b: 0, a: 1 } } },
            { position: 1, color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } },
          ],
        }],
      } as Partial<Node>),
    ];
    const s1 = textOf(readZip(await deckToPptx(file)), "ppt/slides/slide1.xml");
    // Shape: three stops at 0/50/100% (per-thousand-percent positions).
    expect(s1).toContain('<a:gs pos="0">');
    expect(s1).toContain('<a:gs pos="50000">');
    expect(s1).toContain('<a:gs pos="100000">');
    expect(s1).toContain('<a:gs pos="0"><a:srgbClr val="00FF00"/>'); // full-alpha stops self-close
    // Background is a gradient too (inside <p:bg>).
    const bg = s1.slice(s1.indexOf("<p:bg>"), s1.indexOf("</p:bg>"));
    expect(bg).toContain("<a:gradFill>");
    expect(bg).toContain('val="FF0000"');
  });

  it("bold threshold: named weights and variable wght >= 600 export b=1, below stays regular", async () => {
    const file = createBlankDesign({ title: "bold", width: 1000, height: 1000 });
    const run = (text: string, style: Record<string, unknown>) => ({ text, style: { fontFamily: "Inter", fontSize: 20, ...style } });
    file.pages[0].children = [
      createNode("text", {
        id: "t1",
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 900, height: 200 },
        content: [{
          runs: [
            run("semibold-name ", { fontStyle: "SemiBold" }),
            run("wght600 ", { fontStyle: "Regular", axes: { wght: 600 } }),
            run("wght400 ", { fontStyle: "Regular", axes: { wght: 400 } }),
            run("decorated", { fontStyle: "Italic", decoration: ["underline", "strikethrough"] }),
          ],
          style: { align: "left" },
        }],
      } as Partial<Node>),
    ];
    const s1 = textOf(readZip(await deckToPptx(file)), "ppt/slides/slide1.xml");
    const runs = [...s1.matchAll(/<a:rPr ([^>]*)>/g)].map((m) => m[1]);
    expect(runs).toHaveLength(4);
    expect(runs[0]).toContain('b="1"'); // "SemiBold" name >= 600
    expect(runs[1]).toContain('b="1"'); // variable axis 600
    expect(runs[2]).not.toContain('b="1"'); // 400 stays regular
    expect(runs[3]).toContain('i="1"');
    expect(runs[3]).toContain('u="sng"');
    expect(runs[3]).toContain('strike="sngStrike"');
  });

  it("an unrotated group flattens natively; a rotated group rasterizes in place as one unit", async () => {
    const kid = (id: string) =>
      createNode("shape", {
        id, shape: "rect",
        transform: { x: 10, y: 20, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 50, height: 40 },
        fills: [solid(1, 0, 0)],
      } as Partial<Node>);
    const group = (id: string, rotation: number, child: Node) =>
      createNode("group", {
        id,
        transform: { x: 100, y: 200, scaleX: 2, scaleY: 1, rotation },
        size: { width: 100, height: 100 },
        children: [child],
      } as Partial<Node>);
    const file = createBlankDesign({ title: "groups", width: 1000, height: 1000 });
    file.pages[0].children = [group("gFlat", 0, kid("k1"))];
    const p2 = structuredClone(file.pages[0]);
    p2.id = "p2";
    p2.children = [group("gRot", 30, kid("k2")) as never];
    file.pages.push(p2);

    let rasterized: string[] = [];
    const zip = readZip(await deckToPptx(file, {
      rasterizeNode: async (_pi, id) => {
        rasterized.push(id);
        return { png: PNG_STUB, x: 100, y: 200, width: 200, height: 100 };
      },
    }));
    // Flat group: the child lands as a native shape at the ACCUMULATED
    // transform (x: 100 + 10*2 = 120, y: 200 + 20 = 220, w: 50*2 = 100).
    const s1 = textOf(zip, "ppt/slides/slide1.xml");
    expect(s1).toContain(`<a:off x="${120 * 9525}" y="${220 * 9525}"/>`);
    expect(s1).toContain(`<a:ext cx="${100 * 9525}" cy="${40 * 9525}"/>`);
    expect(s1).not.toContain("<p:pic>");
    // Rotated group: ONE raster at the group's bounds, no flattened child.
    const s2 = textOf(zip, "ppt/slides/slide2.xml");
    expect(rasterized).toEqual(["gRot"]);
    expect(s2).toContain("<p:pic>");
    expect(s2).not.toContain('<a:srgbClr val="FF0000">');
  });

  it("an explicit normalized crop maps 1:1 onto a:srcRect", async () => {
    const file = createBlankDesign({ title: "crop", width: 1000, height: 1000 });
    file.pages[0].children = [
      createNode("image", {
        id: "im1",
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 400, height: 300 },
        source: { assetId: "a1", naturalWidth: 800, naturalHeight: 600 },
        fit: "cover",
        crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 },
      } as Partial<Node>),
    ];
    const zip = readZip(await deckToPptx(file, { resolveImage: async () => ({ data: PNG_STUB, mime: "image/png" }) }));
    const s1 = textOf(zip, "ppt/slides/slide1.xml");
    // l=10% t=20% r=1-0.1-0.5=40% b=1-0.2-0.6=20%, in 1/1000 percent.
    expect(s1).toContain('<a:srcRect l="10000" t="20000" r="40000" b="20000"/>');
  });

  it("z-order: shapes serialize in children order, bottom first", async () => {
    const file = createBlankDesign({ title: "z", width: 1000, height: 1000 });
    file.pages[0].children = [
      createNode("shape", { id: "bottom", shape: "rect", transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 10, height: 10 }, fills: [solid(1, 0, 0)] } as Partial<Node>),
      createNode("text", { id: "mid", transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 100, height: 20 }, content: [{ runs: [{ text: "MidRun", style: { fontFamily: "Inter", fontStyle: "Regular", fontSize: 12 } }], style: { align: "left" } }] } as Partial<Node>),
      createNode("shape", { id: "top", shape: "ellipse", transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 10, height: 10 }, fills: [solid(0, 0, 1)] } as Partial<Node>),
    ];
    const s1 = textOf(readZip(await deckToPptx(file)), "ppt/slides/slide1.xml");
    const iBottom = s1.indexOf('val="FF0000"');
    const iMid = s1.indexOf("MidRun");
    const iTop = s1.indexOf('prst="ellipse"');
    expect(iBottom).toBeGreaterThan(-1);
    expect(iMid).toBeGreaterThan(iBottom);
    expect(iTop).toBeGreaterThan(iMid);
  });
});
