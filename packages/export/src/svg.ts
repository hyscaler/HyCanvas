// Editable SVG export. Serializes a page's scene graph to
// SVG primitives so shapes, paths, text, and groups stay editable and the
// output reopens in HyCanvas and standard SVG tools without flattening to a
// single raster. Raster nodes are linked (or, with bytes available at runtime,
// embedded). The non-editable/outlined path and base64 embedding belong to the
// runtime layer; this core emits primitives.

import {
  childrenOf,
  type Color,
  type DesignFile,
  type Fill,
  type Node,
  type Page,
  type Stroke,
  type SubPath,
  type VectorPath,
} from "@hc/schema";
import { fromTransform } from "@hc/engine";
import { shapeToPath } from "@hc/geometry";
import type { SvgOptions } from "./types";

type AnyRec = Record<string, unknown>;

interface Ctx {
  defs: string[];
  gradId: number;
  file: DesignFile;
  opts: SvgOptions;
}

function num(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return (Math.round(n * 1000) / 1000).toString();
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function rgbOf(c: Color): string {
  const r = Math.round(c.srgb.r * 255);
  const g = Math.round(c.srgb.g * 255);
  const b = Math.round(c.srgb.b * 255);
  return `rgb(${r},${g},${b})`;
}

interface Paint {
  ref: string; // "rgb(...)" | "url(#id)" | "none"
  opacity: number;
}

function paintOf(fill: Fill | undefined, ctx: Ctx): Paint {
  if (!fill) return { ref: "none", opacity: 1 };
  if (fill.type === "solid") return { ref: rgbOf(fill.color), opacity: fill.color.srgb.a };
  if (fill.type === "gradient") {
    const id = `grad-${++ctx.gradId}`;
    const stops = fill.stops
      .map(
        (s) =>
          `<stop offset="${num(s.position)}" stop-color="${rgbOf(s.color)}" stop-opacity="${num(s.color.srgb.a)}"/>`,
      )
      .join("");
    if (fill.gradient === "radial") {
      const c = fill.center ?? { x: 0.5, y: 0.5 };
      const r = fill.radius ?? 0.5;
      ctx.defs.push(
        `<radialGradient id="${id}" cx="${num(c.x)}" cy="${num(c.y)}" r="${num(r)}">${stops}</radialGradient>`,
      );
    } else {
      // linear (and a reasonable fallback for conic/mesh on the SVG path)
      const rad = ((fill.angle ?? 0) * Math.PI) / 180;
      const dx = Math.cos(rad) * 0.5;
      const dy = Math.sin(rad) * 0.5;
      ctx.defs.push(
        `<linearGradient id="${id}" x1="${num(0.5 - dx)}" y1="${num(0.5 - dy)}" x2="${num(0.5 + dx)}" y2="${num(0.5 + dy)}">${stops}</linearGradient>`,
      );
    }
    return { ref: `url(#${id})`, opacity: 1 };
  }
  // pattern / image fills are painted as media; not representable as a flat paint here.
  return { ref: "none", opacity: 1 };
}

function fillAttrs(fills: Fill[] | undefined, ctx: Ctx): string {
  const p = paintOf(fills && fills.length > 0 ? fills[0] : undefined, ctx);
  let out = ` fill="${p.ref}"`;
  if (p.opacity < 1) out += ` fill-opacity="${num(p.opacity)}"`;
  return out;
}

function strokeAttrs(stroke: Stroke | undefined, ctx: Ctx): string {
  if (!stroke) return "";
  const p = paintOf(stroke.fill, ctx);
  let out = ` stroke="${p.ref}" stroke-width="${num(stroke.width)}"`;
  if (p.opacity < 1) out += ` stroke-opacity="${num(p.opacity)}"`;
  const rec = stroke as unknown as AnyRec;
  if (rec.cap) out += ` stroke-linecap="${esc(String(rec.cap))}"`;
  if (rec.join) out += ` stroke-linejoin="${esc(String(rec.join))}"`;
  if (Array.isArray(rec.dash) && rec.dash.length) out += ` stroke-dasharray="${(rec.dash as number[]).map(num).join(",")}"`;
  return out;
}

/** Build an SVG path `d` from a VectorPath (cubic beziers via anchor handles). */
function vectorPathToD(vp: VectorPath): string {
  const parts: string[] = [];
  for (const sub of vp.subpaths) parts.push(subPathToD(sub));
  return parts.join(" ");
}

function subPathToD(sub: SubPath): string {
  const a = sub.anchors;
  if (a.length === 0) return "";
  let d = `M ${num(a[0].x)} ${num(a[0].y)}`;
  const segCount = sub.closed ? a.length : a.length - 1;
  for (let i = 0; i < segCount; i++) {
    const from = a[i];
    const to = a[(i + 1) % a.length];
    if (from.outHandle || to.inHandle) {
      const c1 = from.outHandle ?? { x: from.x, y: from.y };
      const c2 = to.inHandle ?? { x: to.x, y: to.y };
      d += ` C ${num(c1.x)} ${num(c1.y)} ${num(c2.x)} ${num(c2.y)} ${num(to.x)} ${num(to.y)}`;
    } else {
      d += ` L ${num(to.x)} ${num(to.y)}`;
    }
  }
  if (sub.closed) d += " Z";
  return d;
}

function matrixAttr(node: Node): string {
  const m = fromTransform(node.transform);
  return `matrix(${num(m.a)},${num(m.b)},${num(m.c)},${num(m.d)},${num(m.e)},${num(m.f)})`;
}

function shapeBody(node: Node, ctx: Ctx): string {
  const rec = node as unknown as AnyRec;
  const w = node.size.width;
  const h = node.size.height;
  const paint = fillAttrs(rec.fills as Fill[] | undefined, ctx) + strokeAttrs(rec.stroke as Stroke | undefined, ctx);
  const kind = rec.shape as string;
  if (kind === "rect") {
    const cr = rec.cornerRadius as AnyRec | undefined;
    const r = cr ? Math.max(0, Number(cr.topLeft) || 0) : 0;
    const rx = r > 0 ? ` rx="${num(r)}"` : "";
    return `<rect x="0" y="0" width="${num(w)}" height="${num(h)}"${rx}${paint}/>`;
  }
  if (kind === "ellipse") {
    return `<ellipse cx="${num(w / 2)}" cy="${num(h / 2)}" rx="${num(w / 2)}" ry="${num(h / 2)}"${paint}/>`;
  }
  if (kind === "custom" && typeof rec.pathData === "string" && rec.pathData) {
    return `<path d="${esc(rec.pathData)}"${paint}/>`;
  }
  // polygon / star / triangle -> parametric path
  let vp: VectorPath | null = null;
  if (kind === "polygon" || kind === "triangle") {
    vp = shapeToPath({ kind: "polygon", width: w, height: h, sides: kind === "triangle" ? 3 : Number(rec.sides) || 3 });
  } else if (kind === "star") {
    vp = shapeToPath({ kind: "star", width: w, height: h, points: Number(rec.sides) || 5, innerRatio: Number(rec.innerRadius) || 0.5 });
  }
  if (vp) return `<path d="${vectorPathToD(vp)}"${paint}/>`;
  return "";
}

function pathContourD(segs: AnyRec[], closed: boolean): string {
  let d = `M ${num(Number(segs[0].x))} ${num(Number(segs[0].y))}`;
  const count = closed ? segs.length : segs.length - 1;
  for (let i = 0; i < count; i++) {
    const from = segs[i];
    const to = segs[(i + 1) % segs.length];
    const cOut = from.cOut as AnyRec | undefined;
    const cIn = to.cIn as AnyRec | undefined;
    if (cOut || cIn) {
      const c1 = cOut ?? { x: from.x, y: from.y };
      const c2 = cIn ?? { x: to.x, y: to.y };
      d += ` C ${num(Number(c1.x))} ${num(Number(c1.y))} ${num(Number(c2.x))} ${num(Number(c2.y))} ${num(Number(to.x))} ${num(Number(to.y))}`;
    } else {
      d += ` L ${num(Number(to.x))} ${num(Number(to.y))}`;
    }
  }
  if (closed) d += " Z";
  return d;
}

function pathBody(node: Node, ctx: Ctx): string {
  const rec = node as unknown as AnyRec;
  const segs = (rec.segments as AnyRec[]) ?? [];
  if (segs.length === 0) return "";
  const parts = [pathContourD(segs, !!rec.closed)];
  // Extra contours of a compound path (schema v15) join the same path data;
  // fill-rule="evenodd" makes interior contours cut holes.
  for (const c of (rec.contours as AnyRec[] | undefined) ?? []) {
    const cs = (c.segments as AnyRec[]) ?? [];
    if (cs.length >= 2) parts.push(pathContourD(cs, !!c.closed));
  }
  const rule = parts.length > 1 ? ` fill-rule="evenodd"` : "";
  const paint = fillAttrs(rec.fills as Fill[] | undefined, ctx) + strokeAttrs(rec.stroke as Stroke | undefined, ctx);
  return `<path d="${parts.join(" ")}"${rule}${paint}/>`;
}

function lineBody(node: Node, ctx: Ctx): string {
  const rec = node as unknown as AnyRec;
  const pts = (rec.points as AnyRec[]) ?? [];
  const points = pts.map((p) => `${num(Number(p.x))},${num(Number(p.y))}`).join(" ");
  return `<polyline points="${points}" fill="none"${strokeAttrs(rec.stroke as Stroke | undefined, ctx)}/>`;
}

function textBody(node: Node, ctx: Ctx): string {
  const rec = node as unknown as AnyRec;
  const paras = (rec.content as AnyRec[]) ?? [];
  let y = 0;
  const lines: string[] = [];
  for (const para of paras) {
    const runs = (para.runs as AnyRec[]) ?? [];
    let lineHeight = 0;
    const tspans: string[] = [];
    for (const run of runs) {
      const style = (run.style as AnyRec) ?? {};
      const size = Number(style.fontSize) || 16;
      lineHeight = Math.max(lineHeight, size * 1.2);
      const family = esc(String(style.fontFamily ?? "sans-serif"));
      const paint = paintOf(style.fill as Fill | undefined, ctx);
      const fo = paint.opacity < 1 ? ` fill-opacity="${num(paint.opacity)}"` : "";
      tspans.push(
        `<tspan font-family="${family}" font-size="${num(size)}" fill="${paint.ref}"${fo}>${esc(String(run.text ?? ""))}</tspan>`,
      );
    }
    if (lineHeight === 0) lineHeight = 16 * 1.2;
    y += lineHeight;
    lines.push(`<text x="0" y="${num(y)}">${tspans.join("")}</text>`);
  }
  return lines.join("");
}

function imageBody(node: Node, ctx: Ctx): string {
  const rec = node as unknown as AnyRec;
  const source = rec.source as AnyRec | undefined;
  const assetId = source?.assetId as string | undefined;
  const asset = assetId ? ctx.file.assets.find((a) => a.id === assetId) : undefined;
  const href = asset?.url ?? "";
  // Embedding as a data URI needs the decoded bytes (runtime); the core links.
  return `<image x="0" y="0" width="${num(node.size.width)}" height="${num(node.size.height)}" preserveAspectRatio="none" href="${esc(href)}"/>`;
}

function emitNode(node: Node, ctx: Ctx): string {
  if (node.hidden) return "";
  const transform = ` transform="${matrixAttr(node)}"`;
  const opacity = node.opacity < 1 ? ` opacity="${num(node.opacity)}"` : "";
  const idAttr = ` data-oc-id="${esc(node.id)}"`;
  const open = `<g${idAttr}${transform}${opacity}>`;

  let body: string;
  switch (node.type) {
    case "shape":
      body = shapeBody(node, ctx);
      break;
    case "path":
      body = pathBody(node, ctx);
      break;
    case "line":
      body = lineBody(node, ctx);
      break;
    case "text":
      body = textBody(node, ctx);
      break;
    case "image":
      body = imageBody(node, ctx);
      break;
    case "group":
    case "frame":
    case "grid":
      body = childrenOf(node).map((c) => emitNode(c, ctx)).join("");
      break;
    default:
      // Unsupported-in-SVG node types are noted, not silently dropped.
      body = `<!-- unsupported node type for svg: ${esc(node.type)} -->`;
  }
  return `${open}${body}</g>`;
}

/** Serialize a single page to an editable SVG document string. */
export function toSvg(file: DesignFile, pageIndex: number, opts: SvgOptions = { keepEditable: true, embedRasters: true }): string {
  const page: Page | undefined = file.pages[pageIndex];
  if (!page) throw new Error(`page index ${pageIndex} out of range`);
  const ctx: Ctx = { defs: [], gradId: 0, file, opts };

  const bg =
    page.background && page.background.type !== "pattern" && page.background.type !== "image"
      ? `<rect x="0" y="0" width="${num(page.width)}" height="${num(page.height)}"${fillAttrs([page.background], ctx)}/>`
      : "";
  const content = page.children.map((n) => emitNode(n, ctx)).join("");
  const defs = ctx.defs.length ? `<defs>${ctx.defs.join("")}</defs>` : "";

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(page.width)}" height="${num(page.height)}" ` +
    `viewBox="0 0 ${num(page.width)} ${num(page.height)}">` +
    defs +
    bg +
    content +
    `</svg>`
  );
}
