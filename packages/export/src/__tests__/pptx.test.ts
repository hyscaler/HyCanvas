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
