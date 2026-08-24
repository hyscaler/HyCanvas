// PPTX (PowerPoint) export (doc 28, import/export interop). Serializes a deck
// into a standard OOXML .pptx: one slide per page, native DrawingML for the
// node types PowerPoint can express (text boxes with per-run styling, rect /
// rounded-rect / ellipse / triangle-family shapes with solid or gradient fills
// and strokes, images with crop, straight lines), speaker notes as real notes
// slides, and a caller-provided raster fallback for everything else (charts,
// paths, ink, QR, tables, ...) so no node is silently dropped - unsupported
// content lands as a correctly-placed PNG.
//
// Coordinate mapping: design px (96dpi) -> EMU (x9525). HyCanvas rotates a
// node clockwise about its LOCAL ORIGIN (its x,y corner; engine
// math.ts fromTransform), while DrawingML rotates about the shape CENTER with
// an unrotated offset, so rotated nodes re-anchor: off = rendered-center -
// half-extent. Groups flatten with accumulated translate+scale (structure is
// not round-tripped; a rotated group rasterizes as a unit rather than emit
// subtly-wrong member positions).
//
// Pure and dependency-free (no DOM): callers pass async resolvers for image
// bytes and node rasterization, so it runs in browser, worker, or tests alike.

import type { DesignFile, Node, Page } from "@hc/schema";
import { weightFromFontStyle } from "@hc/engine";
import { zipStore, type StoredZipEntry } from "./zipstore";

const EMU_PER_PX = 9525; // 914400 EMU/inch at 96 px/inch
const DEG = 60000; // DrawingML angle unit: 1/60000 degree

export interface PptxImage {
  data: Uint8Array;
  /** image/png or image/jpeg; anything else falls back to png extension. */
  mime: string;
}

export interface PptxRaster {
  png: Uint8Array;
  /** Placement in page px (the node's rendered bounds). */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PptxOptions {
  /** Bytes for an ImageNode's asset. Null skips the image. */
  resolveImage?: (assetId: string) => Promise<PptxImage | null>;
  /** Rasterize a node PowerPoint can't express natively (charts, paths, ink,
   *  tables, ...). Null drops the node. Without the callback such nodes are
   *  skipped entirely - the export still succeeds, visibly degraded. */
  rasterizeNode?: (pageIndex: number, nodeId: string) => Promise<PptxRaster | null>;
  title?: string;
}

// ---------------------------------------------------------------------------
// small helpers

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const emu = (px: number): number => Math.round(px * EMU_PER_PX);

type Rgba = { r: number; g: number; b: number; a: number };

function colorOf(fill: unknown): Rgba | null {
  const f = fill as { type?: string; color?: { srgb?: Rgba }; stops?: { color?: { srgb?: Rgba } }[] } | undefined;
  if (!f) return null;
  if (f.color?.srgb) return f.color.srgb;
  const first = f.stops?.[0]?.color?.srgb;
  return first ?? null;
}

const hex2 = (v: number): string => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
const rgbHex = (c: Rgba): string => `${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`.toUpperCase();

function solidFillXml(c: Rgba): string {
  const alpha = c.a != null && c.a < 1 ? `<a:alpha val="${Math.round(Math.max(0, Math.min(1, c.a)) * 100000)}"/>` : "";
  return `<a:solidFill><a:srgbClr val="${rgbHex(c)}">${alpha}</a:srgbClr></a:solidFill>`;
}

/** DrawingML fill for a schema Fill: solid and linear-gradient natively; a
 *  pattern/image fill degrades to its dominant color (callers rasterize image
 *  fills at the node level when fidelity matters). */
function fillXml(fill: unknown): string {
  const f = fill as { type?: string; angle?: number; stops?: { position?: number; color?: { srgb?: Rgba } }[] } | undefined;
  if (f?.type === "gradient" && Array.isArray(f.stops) && f.stops.length >= 2) {
    const gs = f.stops
      .map((s) => {
        const c = s.color?.srgb;
        if (!c) return "";
        return `<a:gs pos="${Math.round(Math.max(0, Math.min(1, s.position ?? 0)) * 100000)}">${`<a:srgbClr val="${rgbHex(c)}"${c.a != null && c.a < 1 ? `><a:alpha val="${Math.round(c.a * 100000)}"/></a:srgbClr` : "/"}>`}</a:gs>`;
      })
      .join("");
    // A radial gradient maps to a centered circular path; conic/mesh have no
    // DrawingML equivalent and degrade to linear (pinned by the goldens).
    const kind = (f as { gradient?: string }).gradient;
    if (kind === "radial") {
      return `<a:gradFill><a:gsLst>${gs}</a:gsLst><a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path></a:gradFill>`;
    }
    // Both the engine (fills.ts) and DrawingML measure the linear angle
    // CLOCKWISE FROM 3 O'CLOCK (y-down), so the mapping is the identity; the
    // engine renders a missing angle as 0 (left to right).
    const ang = Math.round(((((f.angle ?? 0) % 360) + 360) % 360) * DEG);
    return `<a:gradFill><a:gsLst>${gs}</a:gsLst><a:lin ang="${ang}" scaled="1"/></a:gradFill>`;
  }
  const c = colorOf(fill);
  return c ? solidFillXml(c) : "<a:noFill/>";
}

function strokeXml(stroke: unknown): string {
  const st = stroke as { width?: number; fill?: unknown } | undefined;
  if (!st || !st.width || st.width <= 0) return "";
  const c = colorOf(st.fill);
  if (!c) return "";
  return `<a:ln w="${emu(st.width)}">${solidFillXml(c)}</a:ln>`;
}

/** off/ext + rot for a node box. HyCanvas rotates clockwise about the box's
 *  top-left (x,y); DrawingML rotates about the center of an unrotated box. */
function xfrmXml(x: number, y: number, w: number, h: number, rotationDeg: number, flipH: boolean, flipV: boolean): string {
  let ox = x;
  let oy = y;
  if (rotationDeg) {
    const rad = (rotationDeg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    // Rendered center = origin + R(theta) . (w/2, h/2)   (clockwise, y-down)
    const cx = x + cos * (w / 2) - sin * (h / 2);
    const cy = y + sin * (w / 2) + cos * (h / 2);
    ox = cx - w / 2;
    oy = cy - h / 2;
  }
  const rot = rotationDeg ? ` rot="${Math.round(((rotationDeg % 360) + 360) % 360 * DEG)}"` : "";
  const flips = `${flipH ? ' flipH="1"' : ""}${flipV ? ' flipV="1"' : ""}`;
  return `<a:xfrm${rot}${flips}><a:off x="${emu(ox)}" y="${emu(oy)}"/><a:ext cx="${emu(Math.max(1, w))}" cy="${emu(Math.max(1, h))}"/></a:xfrm>`;
}

// Shape kind -> DrawingML preset geometry. sides-aware for polygons.
function presetFor(node: Record<string, unknown>): string | null {
  const shape = String(node.shape ?? "");
  const corner = node.cornerRadius as { tl?: number } | number | undefined;
  const rounded = typeof corner === "number" ? corner > 0 : !!corner && Object.values(corner).some((v) => typeof v === "number" && v > 0);
  switch (shape) {
    case "rect":
      return rounded ? "roundRect" : "rect";
    case "ellipse":
      return "ellipse";
    case "triangle":
      return "triangle";
    case "star":
      return "star5";
    case "polygon": {
      const sides = typeof node.sides === "number" ? node.sides : 6;
      return { 3: "triangle", 4: "diamond", 5: "pentagon", 6: "hexagon", 7: "heptagon", 8: "octagon", 10: "decagon", 12: "dodecagon" }[sides] ?? null;
    }
    default:
      return null; // custom -> raster fallback
  }
}

// ---------------------------------------------------------------------------
// text

type Run = { text?: string; style?: { fontFamily?: string; fontStyle?: string; fontSize?: number; fill?: unknown; axes?: Record<string, number>; decoration?: string[] } };
type Paragraph = { runs?: Run[]; style?: { align?: string } };

function runXml(r: Run): string {
  if (!r.text) return "";
  const st = r.style ?? {};
  const sizePt100 = Math.max(100, Math.round((st.fontSize ?? 16) * 0.75 * 100)); // px -> pt -> 1/100 pt
  const styleName = (st.fontStyle ?? "").toLowerCase();
  // Weight resolves exactly as the engine renders it: a variable wght axis
  // takes PRECEDENCE over the style name (so "Bold" forced to wght 400
  // renders - and exports - regular), and named weights use the engine's own
  // table so Black/Heavy (900) bold correctly, not just names containing
  // "bold". PPTX has no numeric weight; >= 600 becomes b="1".
  const bold = (st.axes?.wght ?? weightFromFontStyle(st.fontStyle)) >= 600;
  const italic = styleName.includes("italic") || styleName.includes("oblique");
  const under = st.decoration?.includes("underline");
  const strike = st.decoration?.includes("strikethrough");
  const c = colorOf(st.fill);
  const attrs = `lang="en-US" sz="${sizePt100}"${bold ? ' b="1"' : ""}${italic ? ' i="1"' : ""}${under ? ' u="sng"' : ""}${strike ? ' strike="sngStrike"' : ""} dirty="0"`;
  const fill = c ? solidFillXml(c) : "";
  const latin = st.fontFamily && st.fontFamily !== "system" ? `<a:latin typeface="${esc(st.fontFamily)}"/>` : "";
  return `<a:r><a:rPr ${attrs}>${fill}${latin}</a:rPr><a:t>${esc(r.text)}</a:t></a:r>`;
}

function paragraphXml(p: Paragraph): string {
  const align = { left: "l", center: "ctr", right: "r", justify: "just" }[p.style?.align ?? "left"] ?? "l";
  const runs = (p.runs ?? []).map(runXml).join("");
  return `<a:p><a:pPr algn="${align}"/>${runs || "<a:endParaRPr/>"}</a:p>`;
}

// ---------------------------------------------------------------------------
// the writer

interface SlideMedia {
  name: string; // media file name inside ppt/media
  data: Uint8Array;
  contentType: string;
}

export async function deckToPptx(file: DesignFile, opts: PptxOptions = {}): Promise<Uint8Array> {
  const pages = (file.pages ?? []) as Page[];
  if (!pages.length) throw new Error("deckToPptx: design has no pages");
  const pageW = Math.max(1, Math.round(pages[0].width));
  const pageH = Math.max(1, Math.round(pages[0].height));
  const title = opts.title ?? (file as { title?: string }).title ?? "Presentation";

  const entries: StoredZipEntry[] = [];
  const enc = new TextEncoder();
  const put = (name: string, xml: string) => entries.push({ name, data: enc.encode(xml) });

  const mediaSeq = { n: 0 };
  const contentTypeExts = new Set<string>(["png"]); // png always declared (raster fallback)

  interface BuiltSlide {
    xml: string;
    rels: string[];
    media: SlideMedia[];
    notes: string | null;
  }

  const slides: BuiltSlide[] = [];
  for (let pi = 0; pi < pages.length; pi++) {
    slides.push(await buildSlide(pages[pi], pi));
  }

  async function buildSlide(page: Page, pageIndex: number): Promise<BuiltSlide> {
    const shapes: string[] = [];
    const rels: string[] = [];
    const media: SlideMedia[] = [];
    let sid = 2; // shape ids start after the group root

    const addImageRel = (data: Uint8Array, mime: string): string => {
      const ext = mime === "image/jpeg" ? "jpeg" : "png";
      contentTypeExts.add(ext);
      mediaSeq.n++;
      const name = `image${mediaSeq.n}.${ext}`;
      media.push({ name, data, contentType: mime === "image/jpeg" ? "image/jpeg" : "image/png" });
      const relId = `rId${rels.length + 1}`;
      rels.push(`<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${name}"/>`);
      return relId;
    };

    const rasterize = async (node: Node): Promise<void> => {
      if (!opts.rasterizeNode) return; // no fallback available: skip
      const r = await opts.rasterizeNode(pageIndex, node.id);
      if (!r || !r.png.length) return;
      const relId = addImageRel(r.png, "image/png");
      shapes.push(
        `<p:pic><p:nvPicPr><p:cNvPr id="${sid++}" name="${esc(nodeName(node))}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
          `<p:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
          `<p:spPr>${xfrmXml(r.x, r.y, r.width, r.height, 0, false, false)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`,
      );
    };

    // Walk top-level nodes, flattening groups with accumulated translate+scale.
    const walk = async (nodes: Node[], tx: number, ty: number, sx: number, sy: number): Promise<void> => {
      for (const raw of nodes) {
        const node = raw as Node & Record<string, unknown>;
        if (node.hidden) continue;
        const t = node.transform;
        const w = Math.abs(node.size.width * t.scaleX * sx);
        const h = Math.abs(node.size.height * t.scaleY * sy);
        // Box origin honoring negative scale (a flip renders leftward/upward).
        const x = tx + Math.min(t.x * sx, t.x * sx + node.size.width * t.scaleX * sx);
        const y = ty + Math.min(t.y * sy, t.y * sy + node.size.height * t.scaleY * sy);
        const flipH = t.scaleX * sx < 0;
        const flipV = t.scaleY * sy < 0;
        const rot = t.rotation ?? 0;

        if (node.type === "group" || node.type === "frame") {
          const kids = (node as { children?: Node[] }).children ?? [];
          // A rotated/flipped container can't flatten without skewing member
          // positions - rasterize the whole unit instead. Frames also rasterize
          // when they clip (the clip has no flattened equivalent).
          const clips = node.type === "frame" && !!(node as { clip?: boolean }).clip && kids.length > 0;
          if (rot || flipH || flipV || clips) {
            await rasterize(node);
            continue;
          }
          if (node.type === "frame") {
            // An unclipped frame may carry its own fill: emit it as a rect.
            const fills = (node as { fills?: unknown[] }).fills;
            if (fills?.length) {
              shapes.push(
                `<p:sp><p:nvSpPr><p:cNvPr id="${sid++}" name="Frame"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
                  `<p:spPr>${xfrmXml(x, y, w, h, 0, false, false)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fillXml(fills[0])}</p:spPr></p:sp>`,
              );
            }
          }
          await walk(kids, tx + t.x * sx, ty + t.y * sy, sx * t.scaleX, sy * t.scaleY);
          continue;
        }

        if (node.type === "text") {
          const paras = ((node as { content?: Paragraph[] }).content ?? []).map(paragraphXml).join("");
          shapes.push(
            `<p:sp><p:nvSpPr><p:cNvPr id="${sid++}" name="${esc(nodeName(node))}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
              `<p:spPr>${xfrmXml(x, y, w, h, rot, flipH, flipV)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
              `<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paras || "<a:p><a:endParaRPr/></a:p>"}</p:txBody></p:sp>`,
          );
          continue;
        }

        if (node.type === "shape") {
          const prst = presetFor(node);
          const fills = (node as { fills?: unknown[] }).fills ?? [];
          const imageFill = fills.some((f) => (f as { type?: string })?.type === "image");
          if (!prst || imageFill) {
            await rasterize(node); // custom geometry / image fill: keep fidelity
            continue;
          }
          shapes.push(
            `<p:sp><p:nvSpPr><p:cNvPr id="${sid++}" name="${esc(nodeName(node))}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
              `<p:spPr>${xfrmXml(x, y, w, h, rot, flipH, flipV)}<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>${fillXml(fills[0])}${strokeXml((node as { stroke?: unknown }).stroke)}</p:spPr>` +
              `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr/></a:p></p:txBody></p:sp>`,
          );
          continue;
        }

        if (node.type === "image") {
          const src = (node as { source?: { assetId?: string; naturalWidth?: number; naturalHeight?: number } }).source;
          const img = src?.assetId && opts.resolveImage ? await opts.resolveImage(src.assetId) : null;
          if (!img) {
            await rasterize(node);
            continue;
          }
          const relId = addImageRel(img.data, img.mime);
          // Crop: an explicit normalized crop maps 1:1 to srcRect; a cover-fit
          // image without one derives the centered crop from the aspect ratios.
          let srcRect = "";
          const crop = (node as { crop?: { x: number; y: number; width: number; height: number } }).crop;
          const fit = String((node as { fit?: string }).fit ?? "cover");
          const per = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 100000);
          if (crop && crop.width > 0 && crop.height > 0) {
            srcRect = `<a:srcRect l="${per(crop.x)}" t="${per(crop.y)}" r="${per(1 - crop.x - crop.width)}" b="${per(1 - crop.y - crop.height)}"/>`;
          } else if (fit === "cover" && src?.naturalWidth && src?.naturalHeight && w > 0 && h > 0) {
            const scale = Math.max(w / src.naturalWidth, h / src.naturalHeight);
            const visW = w / scale / src.naturalWidth;
            const visH = h / scale / src.naturalHeight;
            const l = (1 - visW) / 2;
            const tp = (1 - visH) / 2;
            if (visW < 0.999 || visH < 0.999) srcRect = `<a:srcRect l="${per(l)}" t="${per(tp)}" r="${per(l)}" b="${per(tp)}"/>`;
          }
          shapes.push(
            `<p:pic><p:nvPicPr><p:cNvPr id="${sid++}" name="${esc(nodeName(node))}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
              `<p:blipFill><a:blip r:embed="${relId}"/>${srcRect}<a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
              `<p:spPr>${xfrmXml(x, y, w, h, rot, flipH, flipV)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`,
          );
          continue;
        }

        if (node.type === "line") {
          const pts = (node as { points?: { x: number; y: number }[] }).points;
          if (pts && pts.length === 2) {
            const ax = tx + (t.x + pts[0].x * t.scaleX) * sx;
            const ay = ty + (t.y + pts[0].y * t.scaleY) * sy;
            const bx = tx + (t.x + pts[1].x * t.scaleX) * sx;
            const by = ty + (t.y + pts[1].y * t.scaleY) * sy;
            const lx = Math.min(ax, bx);
            const ly = Math.min(ay, by);
            const lw = Math.abs(bx - ax);
            const lh = Math.abs(by - ay);
            const down = (bx - ax) * (by - ay) >= 0; // line runs TL->BR (else BL->TR: flipV)
            shapes.push(
              `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${sid++}" name="Line"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>` +
                `<p:spPr>${xfrmXml(lx, ly, Math.max(lw, 0.5), Math.max(lh, 0.5), 0, false, !down)}<a:prstGeom prst="line"><a:avLst/></a:prstGeom>${strokeXml((node as { stroke?: unknown }).stroke) || `<a:ln w="${emu(2)}">${solidFillXml({ r: 0, g: 0, b: 0, a: 1 })}</a:ln>`}</p:spPr></p:cxnSp>`,
            );
            continue;
          }
          await rasterize(node);
          continue;
        }

        // Everything else (chart, table, path, ink, sticky, qr, video, ...):
        // raster fallback keeps the slide visually complete.
        await rasterize(node);
      }
    };

    await walk((page.children ?? []) as Node[], 0, 0, 1, 1);

    // Page background: a solid/gradient becomes the slide <p:bg>.
    const bgFill = (page as { background?: unknown }).background;
    const bg = bgFill ? `<p:bg><p:bgPr>${fillXml(bgFill)}<a:effectLst/></p:bgPr></p:bg>` : "";

    const xml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
      `<p:cSld>${bg}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
      `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
      shapes.join("") +
      `</p:spTree></p:cSld><p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr></p:sld>`;

    const notes = typeof (page as { notes?: string }).notes === "string" && (page as { notes?: string }).notes!.trim() ? (page as { notes?: string }).notes!.trim() : null;
    return { xml, rels, media, notes };
  }

  // --- fixed boilerplate parts --------------------------------------------

  const layoutRel = `<Relationship Id="rIdLayout" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`;

  slides.forEach((s, i) => {
    const n = i + 1;
    put(`ppt/slides/slide${n}.xml`, s.xml);
    const notesRel = s.notes
      ? `<Relationship Id="rIdNotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/>`
      : "";
    put(
      `ppt/slides/_rels/slide${n}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${layoutRel}${notesRel}${s.rels.join("")}</Relationships>`,
    );
    for (const m of s.media) entries.push({ name: `ppt/media/${m.name}`, data: m.data });
    if (s.notes) {
      put(
        `ppt/notesSlides/notesSlide${n}.xml`,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
          `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
          `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes"/><p:cNvSpPr txBox="1"/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>` +
          `<p:txBody><a:bodyPr/><a:lstStyle/>${s.notes.split("\n").map((line) => `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${esc(line)}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp>` +
          `</p:spTree></p:cSld></p:notes>`,
      );
      put(
        `ppt/notesSlides/_rels/notesSlide${n}.xml.rels`,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdSlide" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slides/slide${n}.xml"/></Relationships>`,
      );
    }
  });

  const slideRefs = slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rIdS${i + 1}"/>`).join("");
  put(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
      `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster"/></p:sldMasterIdLst>` +
      `<p:sldIdLst>${slideRefs}</p:sldIdLst>` +
      `<p:sldSz cx="${emu(pageW)}" cy="${emu(pageH)}"/><p:notesSz cx="${emu(pageH)}" cy="${emu(pageW)}"/></p:presentation>`,
  );
  put(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rIdMaster" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>` +
      slides.map((_, i) => `<Relationship Id="rIdS${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join("") +
      `<Relationship Id="rIdTheme" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>`,
  );

  // Minimal master + layout + theme (blank layout; slides carry all content).
  put(
    "ppt/slideMasters/slideMaster1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
      `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>` +
      `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
      `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rIdLayout1"/></p:sldLayoutIdLst></p:sldMaster>`,
  );
  put(
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rIdLayout1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
      `<Relationship Id="rIdTheme" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`,
  );
  put(
    "ppt/slideLayouts/slideLayout1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank">` +
      `<p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld></p:sldLayout>`,
  );
  put(
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rIdMaster" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
  );
  put(
    "ppt/theme/theme1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="HyCanvas"><a:themeElements>` +
      `<a:clrScheme name="HyCanvas"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F1F1F"/></a:dk2><a:lt2><a:srgbClr val="F5F5F5"/></a:lt2>` +
      `<a:accent1><a:srgbClr val="4F46E5"/></a:accent1><a:accent2><a:srgbClr val="0EA5E9"/></a:accent2><a:accent3><a:srgbClr val="10B981"/></a:accent3><a:accent4><a:srgbClr val="F59E0B"/></a:accent4><a:accent5><a:srgbClr val="EF4444"/></a:accent5><a:accent6><a:srgbClr val="8B5CF6"/></a:accent6>` +
      `<a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme>` +
      `<a:fontScheme name="HyCanvas"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>` +
      `<a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>` +
      `<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>` +
      `<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>` +
      `<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>` +
      `</a:themeElements></a:theme>`,
  );

  // Package plumbing: content types, root rels, doc props.
  const notesOverrides = slides
    .map((s, i) => (s.notes ? `<Override PartName="/ppt/notesSlides/notesSlide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>` : ""))
    .join("");
  put(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
      [...contentTypeExts].map((ext) => `<Default Extension="${ext}" ContentType="image/${ext === "jpeg" ? "jpeg" : "png"}"/>`).join("") +
      `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
      slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("") +
      notesOverrides +
      `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>` +
      `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>` +
      `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
      `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
      `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
  );
  put(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
      `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
  );
  put(
    "docProps/core.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(title)}</dc:title><dc:creator>HyCanvas</dc:creator></cp:coreProperties>`,
  );
  put(
    "docProps/app.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>HyCanvas</Application><Slides>${slides.length}</Slides></Properties>`,
  );

  return zipStore(entries);
}

function nodeName(node: Node): string {
  return (node as { name?: string }).name || node.type;
}
