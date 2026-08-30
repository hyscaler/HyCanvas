// ODP (OpenDocument Presentation) import (F28 completion C25).
//
// Client-side and dependency-free like the PPTX importer: unzip (bomb-capped)
// + the compact XML parser, no server round trip. Honest v1 scope, stated in
// the capability row: slides in order, text frames (paragraphs and spans as
// plain runs, font size where declared inline), images (zip members embedded
// as data URLs), frame geometry from svg:x/y/width/height, page size from the
// first master page's layout in styles.xml, and a solid page background where
// the drawing-page style declares one. Styles are resolved from the
// AUTOMATIC styles in content.xml only - the full ODF style cascade (named
// styles, inheritance chains) is out of scope, so complex decks import with
// simplified styling rather than failing. Keynote and Google Slides users
// bridge through PPTX export, which both products offer.

import { createBlankDesign, createNode, type DesignFile, type Node, type Page } from "@hc/schema";
import { unzip } from "./unzip";
import { findAll, findFirst, parseXml, type XmlElement } from "./xml";

/** ODF length ("2.54cm", "1in", "72pt", "960px") to CSS px at 96dpi. */
export function odfLengthPx(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^(-?[\d.]+)\s*(cm|mm|in|pt|pc|px)?$/.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  switch (m[2] ?? "px") {
    case "cm": return (n / 2.54) * 96;
    case "mm": return (n / 25.4) * 96;
    case "in": return n * 96;
    case "pt": return (n / 72) * 96;
    case "pc": return (n / 6) * 96;
    default: return n;
  }
}

function mimeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp" }[ext] ?? "image/png";
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

/** Concatenated visible text of a text:p paragraph (spans, nested, tabs/breaks
 *  as separators). LIMITATION: the compact XML parser concatenates an
 *  element's direct text fragments, so a paragraph that INTERLEAVES plain
 *  text around styled spans ("A <span>B</span> C") comes out with the plain
 *  text first ("A C B"); the common shapes - all-plain or all-span
 *  paragraphs, or a leading plain run - keep their order. */
function paragraphText(p: XmlElement): string {
  let out = "";
  const walk = (el: XmlElement): void => {
    out += el.text;
    for (const c of el.children) {
      if (c.tag === "text:tab") out += "\t";
      else if (c.tag === "text:line-break") out += "\n";
      else if (c.tag === "text:s") out += " ".repeat(Math.max(1, Number(c.attrs["text:c"] ?? 1)));
      else walk(c);
    }
  };
  walk(p);
  return out;
}

/** Automatic styles in content.xml, indexed by style:name: the pieces v1
 *  reads (font size from paragraph/text properties, drawing-page fill). */
interface OdpStyles {
  fontSizePx: Map<string, number>;
  pageFill: Map<string, string>;
}

function collectStyles(content: XmlElement): OdpStyles {
  const fontSizePx = new Map<string, number>();
  const pageFill = new Map<string, string>();
  const auto = findFirst(content, "office:automatic-styles");
  for (const st of auto ? findAll(auto, "style:style") : []) {
    const name = st.attrs["style:name"];
    if (!name) continue;
    const textProps = findFirst(st, "style:text-properties");
    const size = odfLengthPx(textProps?.attrs["fo:font-size"]);
    if (size) fontSizePx.set(name, size);
    const pageProps = findFirst(st, "style:drawing-page-properties");
    const fill = pageProps?.attrs["draw:fill-color"];
    if (fill && /^#[0-9a-fA-F]{6}$/.test(fill)) pageFill.set(name, fill.toLowerCase());
  }
  return { fontSizePx, pageFill };
}

function hexColor(hex: string): { srgb: { r: number; g: number; b: number; a: number } } {
  const n = parseInt(hex.slice(1), 16);
  return { srgb: { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 } };
}

/** Import an .odp archive into the open design format. Throws on a
 *  non-presentation archive; per-frame failures degrade to skipping the
 *  frame rather than failing the deck. */
export async function odpToDesign(bytes: Uint8Array, opts: { title?: string } = {}): Promise<DesignFile> {
  const files = await unzip(bytes);
  const contentRaw = files.get("content.xml");
  if (!contentRaw) throw new Error("not an OpenDocument presentation (no content.xml)");
  const content = parseXml(new TextDecoder().decode(contentRaw));
  const presentation = findFirst(content, "office:presentation");
  if (!presentation) throw new Error("not an OpenDocument presentation (no office:presentation)");

  // Page size: the first master page's layout in styles.xml; 4:3 ODF default
  // when absent (Impress's classic 28cm x 21cm).
  let pageW = (28 / 2.54) * 96;
  let pageH = (21 / 2.54) * 96;
  const stylesRaw = files.get("styles.xml");
  if (stylesRaw) {
    try {
      const styles = parseXml(new TextDecoder().decode(stylesRaw));
      const layout = findFirst(styles, "style:page-layout-properties");
      const w = odfLengthPx(layout?.attrs["fo:page-width"]);
      const h = odfLengthPx(layout?.attrs["fo:page-height"]);
      if (w && h && w > 100 && h > 100) {
        pageW = w;
        pageH = h;
      }
    } catch {
      /* keep the default size */
    }
  }
  pageW = Math.round(pageW);
  pageH = Math.round(pageH);

  const auto = collectStyles(content);
  const file = createBlankDesign({ title: opts.title ?? "Imported presentation", width: pageW, height: pageH });
  file.pages = [];
  let nodeSeq = 0;
  const nid = (kind: string) => `odp-${kind}-${++nodeSeq}`;
  const assets: { id: string; kind: "image"; name: string; url: string; mime: string; checksum: string }[] = [];
  const assetByPath = new Map<string, string>();

  for (const pageEl of findAll(presentation, "draw:page")) {
    const children: Node[] = [];
    for (const frame of findAll(pageEl, "draw:frame")) {
      const x = odfLengthPx(frame.attrs["svg:x"]) ?? 0;
      const y = odfLengthPx(frame.attrs["svg:y"]) ?? 0;
      const w = odfLengthPx(frame.attrs["svg:width"]) ?? 100;
      const h = odfLengthPx(frame.attrs["svg:height"]) ?? 50;
      const textBox = findFirst(frame, "draw:text-box");
      const image = findFirst(frame, "draw:image");
      if (image) {
        const href = image.attrs["xlink:href"] ?? "";
        const member = files.get(href) ?? files.get(href.replace(/^\.\//, ""));
        if (!member) continue; // an external or missing picture: skip the frame
        let assetId = assetByPath.get(href);
        if (!assetId) {
          assetId = `odp-asset-${assets.length + 1}`;
          assetByPath.set(href, assetId);
          const mime = mimeFor(href);
          assets.push({ id: assetId, kind: "image", name: href.split("/").pop() ?? "image", url: `data:${mime};base64,${toBase64(member)}`, mime, checksum: "" });
        }
        children.push(createNode("image", {
          id: nid("image"),
          transform: { x, y, scaleX: 1, scaleY: 1, rotation: 0 },
          size: { width: w, height: h },
          source: { assetId, naturalWidth: 0, naturalHeight: 0 },
          fit: "contain",
        } as Partial<Node>));
        continue;
      }
      if (textBox) {
        const paras = findAll(textBox, "text:p").map((p) => {
          // Font size: the paragraph's first styled span, else the paragraph
          // style, else the ODF body default.
          const span = findFirst(p, "text:span");
          const size =
            (span?.attrs["text:style-name"] ? auto.fontSizePx.get(span.attrs["text:style-name"]) : undefined) ??
            (p.attrs["text:style-name"] ? auto.fontSizePx.get(p.attrs["text:style-name"]) : undefined) ??
            18;
          return { text: paragraphText(p), size };
        });
        if (!paras.some((pp) => pp.text.trim())) continue; // an empty placeholder frame
        children.push(createNode("text", {
          id: nid("text"),
          transform: { x, y, scaleX: 1, scaleY: 1, rotation: 0 },
          size: { width: w, height: h },
          box: { mode: "fixed", width: w, height: h, autoFit: { enabled: false, min: 6, max: 512 }, verticalAlign: "top" },
          content: paras.map((pp) => ({
            runs: [{ text: pp.text, style: { fontFamily: "system", fontStyle: "Regular", fontSize: pp.size, fill: { type: "solid", color: { srgb: { r: 0.1, g: 0.12, b: 0.16, a: 1 } } } } }],
            style: { align: "left" as const, direction: "auto" as const },
          })),
        } as Partial<Node>));
      }
    }
    const page: Page = {
      id: nid("page"),
      name: pageEl.attrs["draw:name"] || undefined,
      width: pageW,
      height: pageH,
      children,
    } as unknown as Page;
    const pageStyle = pageEl.attrs["draw:style-name"];
    const fill = pageStyle ? auto.pageFill.get(pageStyle) : undefined;
    if (fill) (page as unknown as { background?: unknown }).background = { type: "solid", color: hexColor(fill) };
    file.pages.push(page);
  }

  if (!file.pages.length) throw new Error("no slides found in the .odp");
  file.assets.push(...(assets as never[]));
  return file;
}
