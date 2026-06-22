// Convert an SVG document (icon/illustration) into editable scene-graph nodes
//. Minimal, dependency-free XML scanning sufficient for the
// flat icon SVGs the catalog serves: <path>, <rect>, <circle>, <ellipse>,
// <polygon>/<polyline>, <line>. Each becomes a native node a user can recolor
// and reshape; nothing is flattened to a raster.

import { createNode, type Color, type Fill, type Node, type PathSegment } from "@hc/schema";
import { parsePathData, type SubPathData } from "./pathdata";

type Attrs = Record<string, string>;

function parseAttrs(s: string): Attrs {
  const out: Attrs = {};
  for (const m of s.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
  // CSS `style="fill:..;font-size:.."` overrides presentation attributes (SVG
  // spec). Most exporters (incl. Canva) put fill/font on style, so fold it in.
  if (out.style) {
    for (const decl of out.style.split(";")) {
      const i = decl.indexOf(":");
      if (i > 0) {
        const k = decl.slice(0, i).trim();
        const v = decl.slice(i + 1).trim();
        if (k && v) out[k] = v;
      }
    }
  }
  return out;
}

const NAMED: Record<string, [number, number, number]> = {
  black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0],
  green: [0, 128, 0], blue: [0, 0, 255], gray: [128, 128, 128], grey: [128, 128, 128],
};

function parseColor(v: string | undefined): Color | "none" | null {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  if (s === "none" || s === "transparent") return "none";
  if (s.startsWith("#")) {
    let h = s.slice(1);
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    if (h.length !== 6) return null;
    const n = parseInt(h, 16);
    if (Number.isNaN(n)) return null;
    return { srgb: { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 } };
  }
  const named = NAMED[s];
  return named ? { srgb: { r: named[0] / 255, g: named[1] / 255, b: named[2] / 255, a: 1 } } : null;
}

function fillsFrom(attrs: Attrs, fallback = true): Fill[] {
  const c = parseColor(attrs.fill);
  if (c === "none") return [];
  if (c) return [{ type: "solid", color: c }];
  return fallback ? [{ type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } }] : [];
}

function bboxOfSegments(segs: PathSegment[]): { x: number; y: number; w: number; h: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of segs) {
    for (const p of [s, s.cIn, s.cOut]) {
      if (!p) continue;
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function num(attrs: Attrs, key: string, dflt = 0): number {
  const v = parseFloat(attrs[key]);
  return Number.isFinite(v) ? v : dflt;
}

function pathNodeFromSub(sub: SubPathData, fills: Fill[], id: string): Node {
  const bb = bboxOfSegments(sub.segments);
  return createNode("path", {
    id,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: bb.w, height: bb.h },
    segments: sub.segments,
    closed: sub.closed,
    fills,
  } as Partial<Node>);
}

function pointsToSegments(points: string): PathSegment[] {
  const nums = points.match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g)?.map(Number) ?? [];
  const segs: PathSegment[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) segs.push({ x: nums[i], y: nums[i + 1] });
  return segs;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&"); // ampersand last so it does not double-decode
}

function weightFrom(v: string | undefined): number | undefined {
  if (!v) return undefined;
  if (v === "bold" || v === "bolder") return 700;
  if (v === "normal" || v === "lighter") return 400;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function anchorToAlign(v: string | undefined): "left" | "center" | "right" {
  return v === "middle" ? "center" : v === "end" ? "right" : "left";
}

export interface SvgToNodesResult {
  nodes: Node[];
  /** Image assets referenced by emitted image nodes (id -> source url / data URL);
   *  the caller registers these and adds matching AssetRefs. */
  assets: { assetId: string; url: string }[];
  /** True when any path used arc commands (approximated by lines). */
  approximated: boolean;
}

/** Parse an SVG string into editable nodes. `idGen` lets tests be deterministic.
 *  Handles shapes/paths, plus <text> (-> editable text boxes) and <image> (->
 *  image elements) in document order so stacking is preserved. Group transforms
 *  are not resolved (flat/lightly-nested SVGs import faithfully). */
export function svgToNodes(svg: string, idGen: () => string = (() => { let i = 0; return () => `svg-${++i}`; })()): SvgToNodesResult {
  const nodes: Node[] = [];
  const assets: { assetId: string; url: string }[] = [];
  let approximated = false;

  // One ordered pass over every supported element so z-order matches the source:
  // self-closing shapes/image OR a <text>...</text> block.
  const re = /<(path|rect|circle|ellipse|polygon|polyline|line|image)\b([^>]*?)\/?>|<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  for (const m of svg.matchAll(re)) {
    // Text branch.
    if (m[3] !== undefined) {
      const attrs = parseAttrs(m[3]);
      const text = decodeEntities(m[4].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
      if (!text) continue;
      const fontSize = num(attrs, "font-size", 16) || 16;
      const weight = weightFrom(attrs["font-weight"]);
      const fc = parseColor(attrs.fill);
      const color: Color = fc && fc !== "none" ? fc : { srgb: { r: 0, g: 0, b: 0, a: 1 } };
      const estW = Math.max(16, text.length * fontSize * 0.55);
      const align = anchorToAlign(attrs["text-anchor"]);
      const x = num(attrs, "x");
      const left = align === "center" ? x - estW / 2 : align === "right" ? x - estW : x;
      nodes.push(createNode("text", {
        id: idGen(),
        name: text.slice(0, 24),
        transform: { x: left, y: num(attrs, "y") - fontSize * 0.8, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: estW, height: fontSize * 1.4 },
        box: { mode: "fixed", width: estW, height: fontSize * 1.4, autoFit: { enabled: false, min: 8, max: 512 }, verticalAlign: "top" },
        content: [{
          runs: [{ text, style: { fontFamily: (attrs["font-family"] || "system").replace(/['"]/g, "").split(",")[0].trim() || "system", fontStyle: weight && weight >= 600 ? "Bold" : "Regular", fontSize, ...(weight ? { axes: { wght: weight } } : {}), fill: { type: "solid", color } } }],
          style: { align, direction: "auto" },
        }],
      } as Partial<Node>));
      continue;
    }
    const tag = m[1].toLowerCase();
    const attrs = parseAttrs(m[2]);
    if (tag === "image") {
      const href = attrs.href || attrs["xlink:href"];
      if (!href) continue;
      const w = num(attrs, "width", 100) || 100;
      const h = num(attrs, "height", 100) || 100;
      const assetId = idGen();
      assets.push({ assetId, url: href });
      nodes.push(createNode("image", {
        id: idGen(),
        source: { assetId, naturalWidth: w, naturalHeight: h },
        fit: "cover",
        transform: { x: num(attrs, "x"), y: num(attrs, "y"), scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: w, height: h },
      } as Partial<Node>));
    } else if (tag === "path") {
      if (/[aA]/.test(attrs.d ?? "")) approximated = true;
      const subs = parsePathData(attrs.d ?? "");
      const fills = fillsFrom(attrs);
      for (const sub of subs) nodes.push(pathNodeFromSub(sub, fills, idGen()));
    } else if (tag === "rect") {
      const r = num(attrs, "rx", num(attrs, "ry", 0));
      nodes.push(createNode("shape", {
        id: idGen(),
        shape: "rect",
        transform: { x: num(attrs, "x"), y: num(attrs, "y"), scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: num(attrs, "width"), height: num(attrs, "height") },
        cornerRadius: r > 0 ? { topLeft: r, topRight: r, bottomRight: r, bottomLeft: r } : undefined,
        fills: fillsFrom(attrs),
      } as Partial<Node>));
    } else if (tag === "circle" || tag === "ellipse") {
      const rx = tag === "circle" ? num(attrs, "r") : num(attrs, "rx");
      const ry = tag === "circle" ? num(attrs, "r") : num(attrs, "ry");
      nodes.push(createNode("shape", {
        id: idGen(),
        shape: "ellipse",
        transform: { x: num(attrs, "cx") - rx, y: num(attrs, "cy") - ry, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: rx * 2, height: ry * 2 },
        fills: fillsFrom(attrs),
      } as Partial<Node>));
    } else if (tag === "polygon" || tag === "polyline") {
      const segs = pointsToSegments(attrs.points ?? "");
      if (segs.length) nodes.push(pathNodeFromSub({ segments: segs, closed: tag === "polygon" }, fillsFrom(attrs, tag === "polygon"), idGen()));
    } else if (tag === "line") {
      const segs: PathSegment[] = [
        { x: num(attrs, "x1"), y: num(attrs, "y1") },
        { x: num(attrs, "x2"), y: num(attrs, "y2") },
      ];
      nodes.push(pathNodeFromSub({ segments: segs, closed: false }, [], idGen()));
    }
  }
  return { nodes, assets, approximated };
}
