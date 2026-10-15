// Convert an SVG document (icon/illustration) into editable scene-graph nodes
//. Minimal, dependency-free XML scanning sufficient for the
// flat icon SVGs the catalog serves: <path>, <rect>, <circle>, <ellipse>,
// <polygon>/<polyline>, <line>. Each becomes a native node a user can recolor
// and reshape; nothing is flattened to a raster. Solid colors, CSS-named colors,
// hsl()/rgb()/hex, gradient fills (linear/radial via <defs>/url(#id)) and
// fill/stroke/element opacity are resolved so imported art keeps its color.

import { createNode, type Color, type Fill, type GradientFill, type Node, type PathSegment, type Stroke } from "@hc/schema";
import { parsePathData, type SubPathData } from "./pathdata";

type Attrs = Record<string, string>;

function parseAttrs(s: string): Attrs {
  const out: Attrs = {};
  // Decode entities in values: serialized outerHTML escapes the quotes in
  // `fill:url("#id")` to `&quot;`, which would otherwise defeat url() matching.
  // Bound the attribute-name run (real names are short); an unbounded `[\w:-]+`
  // backtracks quadratically across a long name-like input that never reaches `=`.
  for (const m of s.matchAll(/([\w:-]{1,64})\s*=\s*"([^"]*)"/g)) out[m[1]] = decodeEntities(m[2]);
  // CSS `style="fill:..;font-size:.."` overrides presentation attributes (SVG
  // spec). Most exporters put fill/font on style, so fold it in.
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

// The standard CSS/SVG named colors. The browser import path resolves names via
// getComputedStyle, but the direct path (catalog icons, no-DOM) relies on this.
const NAMED: Record<string, string> = {
  aliceblue: "#f0f8ff", antiquewhite: "#faebd7", aqua: "#00ffff", aquamarine: "#7fffd4", azure: "#f0ffff",
  beige: "#f5f5dc", bisque: "#ffe4c4", black: "#000000", blanchedalmond: "#ffebcd", blue: "#0000ff",
  blueviolet: "#8a2be2", brown: "#a52a2a", burlywood: "#deb887", cadetblue: "#5f9ea0", chartreuse: "#7fff00",
  chocolate: "#d2691e", coral: "#ff7f50", cornflowerblue: "#6495ed", cornsilk: "#fff8dc", crimson: "#dc143c",
  cyan: "#00ffff", darkblue: "#00008b", darkcyan: "#008b8b", darkgoldenrod: "#b8860b", darkgray: "#a9a9a9",
  darkgreen: "#006400", darkgrey: "#a9a9a9", darkkhaki: "#bdb76b", darkmagenta: "#8b008b", darkolivegreen: "#556b2f",
  darkorange: "#ff8c00", darkorchid: "#9932cc", darkred: "#8b0000", darksalmon: "#e9967a", darkseagreen: "#8fbc8f",
  darkslateblue: "#483d8b", darkslategray: "#2f4f4f", darkslategrey: "#2f4f4f", darkturquoise: "#00ced1",
  darkviolet: "#9400d3", deeppink: "#ff1493", deepskyblue: "#00bfff", dimgray: "#696969", dimgrey: "#696969",
  dodgerblue: "#1e90ff", firebrick: "#b22222", floralwhite: "#fffaf0", forestgreen: "#228b22", fuchsia: "#ff00ff",
  gainsboro: "#dcdcdc", ghostwhite: "#f8f8ff", gold: "#ffd700", goldenrod: "#daa520", gray: "#808080",
  green: "#008000", greenyellow: "#adff2f", grey: "#808080", honeydew: "#f0fff0", hotpink: "#ff69b4",
  indianred: "#cd5c5c", indigo: "#4b0082", ivory: "#fffff0", khaki: "#f0e68c", lavender: "#e6e6fa",
  lavenderblush: "#fff0f5", lawngreen: "#7cfc00", lemonchiffon: "#fffacd", lightblue: "#add8e6", lightcoral: "#f08080",
  lightcyan: "#e0ffff", lightgoldenrodyellow: "#fafad2", lightgray: "#d3d3d3", lightgreen: "#90ee90", lightgrey: "#d3d3d3",
  lightpink: "#ffb6c1", lightsalmon: "#ffa07a", lightseagreen: "#20b2aa", lightskyblue: "#87cefa", lightslategray: "#778899",
  lightslategrey: "#778899", lightsteelblue: "#b0c4de", lightyellow: "#ffffe0", lime: "#00ff00", limegreen: "#32cd32",
  linen: "#faf0e6", magenta: "#ff00ff", maroon: "#800000", mediumaquamarine: "#66cdaa", mediumblue: "#0000cd",
  mediumorchid: "#ba55d3", mediumpurple: "#9370db", mediumseagreen: "#3cb371", mediumslateblue: "#7b68ee",
  mediumspringgreen: "#00fa9a", mediumturquoise: "#48d1cc", mediumvioletred: "#c71585", midnightblue: "#191970",
  mintcream: "#f5fffa", mistyrose: "#ffe4e1", moccasin: "#ffe4b5", navajowhite: "#ffdead", navy: "#000080",
  oldlace: "#fdf5e6", olive: "#808000", olivedrab: "#6b8e23", orange: "#ffa500", orangered: "#ff4500",
  orchid: "#da70d6", palegoldenrod: "#eee8aa", palegreen: "#98fb98", paleturquoise: "#afeeee", palevioletred: "#db7093",
  papayawhip: "#ffefd5", peachpuff: "#ffdab9", peru: "#cd853f", pink: "#ffc0cb", plum: "#dda0dd",
  powderblue: "#b0e0e6", purple: "#800080", rebeccapurple: "#663399", red: "#ff0000", rosybrown: "#bc8f8f",
  royalblue: "#4169e1", saddlebrown: "#8b4513", salmon: "#fa8072", sandybrown: "#f4a460", seagreen: "#2e8b57",
  seashell: "#fff5ee", sienna: "#a0522d", silver: "#c0c0c0", skyblue: "#87ceeb", slateblue: "#6a5acd",
  slategray: "#708090", slategrey: "#708090", snow: "#fffafa", springgreen: "#00ff7f", steelblue: "#4682b4",
  tan: "#d2b48c", teal: "#008080", thistle: "#d8bfd8", tomato: "#ff6347", turquoise: "#40e0d0",
  violet: "#ee82ee", wheat: "#f5deb3", white: "#ffffff", whitesmoke: "#f5f5f5", yellow: "#ffff00", yellowgreen: "#9acd32",
};

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
const srgb = (r: number, g: number, b: number, a = 1): Color => ({ srgb: { r: clamp01(r), g: clamp01(g), b: clamp01(b), a: clamp01(a) } });

function hslToColor(h: number, s: number, l: number, a: number): Color {
  h = ((h % 360) + 360) % 360; s = clamp01(s); l = clamp01(l);
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return srgb(r + m, g + m, b + m, a);
}

function parseColor(v: string | undefined): Color | "none" | null {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  if (s === "none" || s === "transparent") return "none";
  if (s === "currentcolor") return srgb(0, 0, 0, 1); // no inherited `color` in the flat path -> black
  if (s.startsWith("#")) {
    let h = s.slice(1);
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    else if (h.length === 4) h = h.split("").map((c) => c + c).join(""); // #rgba -> #rrggbbaa
    if (h.length !== 6 && h.length !== 8) return null;
    const n = parseInt(h.slice(0, 6), 16);
    if (Number.isNaN(n)) return null;
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return srgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a);
  }
  if (s.startsWith("rgb")) {
    const inner = s.slice(s.indexOf("(") + 1, s.lastIndexOf(")"));
    const parts = inner.split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const chan = (p: string) => (p.endsWith("%") ? (parseFloat(p) / 100) * 255 : parseFloat(p));
    const r = chan(parts[0]), g = chan(parts[1]), b = chan(parts[2]);
    if (![r, g, b].every(Number.isFinite)) return null;
    let a = 1;
    if (parts[3] !== undefined) a = parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    return srgb(r / 255, g / 255, b / 255, Number.isFinite(a) ? a : 1);
  }
  if (s.startsWith("hsl")) {
    const inner = s.slice(s.indexOf("(") + 1, s.lastIndexOf(")"));
    const parts = inner.split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const h = parseFloat(parts[0]);
    const sa = parts[1].endsWith("%") ? parseFloat(parts[1]) / 100 : parseFloat(parts[1]);
    const l = parts[2].endsWith("%") ? parseFloat(parts[2]) / 100 : parseFloat(parts[2]);
    if (![h, sa, l].every(Number.isFinite)) return null;
    let a = 1;
    if (parts[3] !== undefined) a = parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    return hslToColor(h, sa, l, Number.isFinite(a) ? a : 1);
  }
  const named = NAMED[s];
  return named ? parseColor(named) : null;
}

/** Multiply a color's alpha by `mult` (for fill-opacity / stroke-opacity). */
function withAlpha(c: Color, mult: number): Color {
  if (mult >= 1) return c;
  return { ...c, srgb: { ...c.srgb, a: clamp01((c.srgb.a ?? 1) * mult) } };
}
/** Apply an opacity multiplier to a fill (solid or gradient stops). */
function fillWithOpacity(f: Fill, mult: number): Fill {
  if (mult >= 1) return f;
  if (f.type === "solid") return { ...f, color: withAlpha(f.color, mult) };
  if (f.type === "gradient") return { ...f, stops: f.stops.map((s) => ({ ...s, color: withAlpha(s.color, mult) })) };
  return f;
}

// --- gradients (<defs><linearGradient>/<radialGradient>) --------------------

type RawGrad = { kind: "linear" | "radial"; attrs: Attrs; stops: { position: number; color: Color }[]; href?: string };

function parseStops(inner: string): { position: number; color: Color }[] {
  const stops: { position: number; color: Color }[] = [];
  for (const m of inner.matchAll(/<stop\b([^>]*)\/?>/gi)) {
    const a = parseAttrs(m[1]);
    const off = a.offset ?? "0";
    const position = clamp01(off.endsWith("%") ? parseFloat(off) / 100 : parseFloat(off) || 0);
    const cv = a["stop-color"] ?? a.style?.match(/stop-color\s*:\s*([^;]+)/)?.[1] ?? "#000000";
    const c = parseColor(cv);
    const color = c && c !== "none" ? c : srgb(0, 0, 0, 1);
    const so = a["stop-opacity"] ?? a.style?.match(/stop-opacity\s*:\s*([^;]+)/)?.[1];
    const op = so !== undefined ? parseFloat(so) : 1;
    stops.push({ position, color: withAlpha(color, Number.isFinite(op) ? op : 1) });
  }
  return stops;
}

/** Build an id -> GradientFill map from an SVG's gradient defs. Resolves
 *  xlink:href/href stop inheritance (common in exporters). */
export function parseGradients(svg: string): Record<string, GradientFill> {
  const raw: Record<string, RawGrad> = {};
  // Block gradients (with stops) and self-closing (href-only) gradients.
  for (const m of svg.matchAll(/<(linear|radial)Gradient\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1Gradient>)/gi)) {
    const attrs = parseAttrs(m[2]);
    const id = attrs.id;
    if (!id) continue;
    raw[id] = { kind: m[1].toLowerCase() as "linear" | "radial", attrs, stops: m[3] ? parseStops(m[3]) : [], href: (attrs["xlink:href"] || attrs.href)?.replace(/^#/, "") };
  }
  const out: Record<string, GradientFill> = {};
  const stopsOf = (g: RawGrad, depth = 0): { position: number; color: Color }[] => {
    if (g.stops.length || !g.href || depth > 8) return g.stops;
    const base = raw[g.href];
    return base ? stopsOf(base, depth + 1) : g.stops;
  };
  for (const [id, g] of Object.entries(raw)) {
    const stops = stopsOf(g);
    if (stops.length < 1) continue;
    const norm = stops.length === 1 ? [{ ...stops[0], position: 0 }, { ...stops[0], position: 1 }] : stops;
    if (g.kind === "linear") {
      const x1 = parseFloat(g.attrs.x1 ?? "0"), y1 = parseFloat(g.attrs.y1 ?? "0");
      const x2 = parseFloat(g.attrs.x2 ?? "1"), y2 = parseFloat(g.attrs.y2 ?? "0");
      const angle = Math.round((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI);
      out[id] = { type: "gradient", gradient: "linear", angle: Number.isFinite(angle) ? angle : 0, stops: norm };
    } else {
      out[id] = { type: "gradient", gradient: "radial", center: { x: 0.5, y: 0.5 }, radius: 0.5, stops: norm };
    }
  }
  return out;
}

/** Resolve a paint value to a Fill: a gradient ref (url(#id)), a solid color, or
 *  null/"none". `mult` applies fill/stroke-opacity. */
function paintToFill(value: string | undefined, gradients: Record<string, GradientFill>, mult: number): Fill | "none" | null {
  if (!value) return null;
  // `\s` excluded from the id so `url(#g )` / `url(#g\n)` don't capture whitespace.
  const url = /url\(\s*["']?#([^)"'\s]+)["']?\s*\)/i.exec(value);
  if (url) {
    const g = gradients[url[1].trim()];
    if (g) return fillWithOpacity(g, mult);
    // SVG paint fallback: `url(#missing) red` -> use the trailing color, if any.
    const rest = value.slice(url.index + url[0].length).trim();
    if (rest) {
      const fc = parseColor(rest);
      if (fc === "none") return "none";
      if (fc) return fillWithOpacity({ type: "solid", color: fc }, mult);
    }
    return null; // unknown ref, no fallback -> no fill (don't paint spurious black)
  }
  const c = parseColor(value);
  if (c === "none") return "none";
  if (c) return fillWithOpacity({ type: "solid", color: c }, mult);
  return null;
}

function opacityOf(attrs: Attrs, key: string): number {
  const v = parseFloat(attrs[key]);
  return Number.isFinite(v) ? clamp01(v) : 1;
}

function fillsFrom(attrs: Attrs, fallback: boolean, gradients: Record<string, GradientFill>): Fill[] {
  const f = paintToFill(attrs.fill, gradients, opacityOf(attrs, "fill-opacity"));
  if (f === "none") return [];
  if (f) return [f];
  return fallback ? [{ type: "solid", color: srgb(0, 0, 0, 1) }] : [];
}

/** A Stroke from presentation attrs, or undefined when there is no visible stroke. */
function strokeFrom(attrs: Attrs, gradients: Record<string, GradientFill>): Stroke | undefined {
  const f = paintToFill(attrs.stroke, gradients, opacityOf(attrs, "stroke-opacity"));
  if (!f || f === "none") return undefined;
  const width = num(attrs, "stroke-width", 1) || 1;
  const cap = attrs["stroke-linecap"];
  const join = attrs["stroke-linejoin"];
  return {
    fill: f,
    width,
    align: "center",
    cap: cap === "round" || cap === "square" ? cap : "butt",
    join: join === "round" || join === "bevel" ? join : "miter",
  };
}

const INHERITED_PAINT = [
  "fill", "fill-opacity", "stroke", "stroke-opacity", "stroke-width",
  "stroke-linecap", "stroke-linejoin", "opacity", "font-family", "font-size",
  "font-weight", "font-style", "text-anchor",
] as const;

function rootInherited(svg: string): Attrs {
  const open = /<svg\b([^>]*)>/i.exec(svg)?.[1] ?? "";
  const all = parseAttrs(open);
  const out: Attrs = {};
  for (const k of INHERITED_PAINT) if (all[k] !== undefined) out[k] = all[k];
  return out;
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

// One node per <path> element: the first subpath fills `segments`/`closed`,
// the rest become `contours` so interior subpaths cut holes under the
// even-odd rule instead of each flooding as a separate solid shape. A
// degenerate leading subpath (a lone moveto) would make renderers skip the
// whole node, so the primary slot gets the first drawable subpath instead.
// --- transforms --------------------------------------------------------------
// An SVG transform list as a 2 by 3 matrix [a, b, c, d, e, f]. Groups nest
// their transforms; every leaf is emitted in root space, so a drawing whose
// parts sit in translated groups (every Sketch export) lands where it was
// drawn. A pure translate or scale keeps a rect or ellipse as a shape; a
// rotation or skew turns it into a path, which carries any matrix exactly.

type Mat = [number, number, number, number, number, number];
const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

function matMul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
const matApply = (m: Mat, x: number, y: number) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });
const matIsIdentity = (m: Mat) => m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
/** No rotation or skew, positive scale: a shape can stay a shape. */
const matIsAxisAligned = (m: Mat) => m[1] === 0 && m[2] === 0 && m[0] > 0 && m[3] > 0;

export function parseTransform(v: string | undefined): Mat {
  let m: Mat = IDENTITY;
  if (!v) return m;
  // The argument list excludes "(" as well as ")": with only ")" excluded, a
  // run of "scale((" made the engine re-scan from every "(" (CodeQL
  // js/polynomial-redos); a transform never nests parentheses.
  for (const t of v.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^()]*)\)/g)) {
    const a = t[2].trim().split(/[\s,]+/).filter(Boolean).map(Number);
    let n: Mat = IDENTITY;
    switch (t[1]) {
      case "matrix": if (a.length >= 6) n = [a[0], a[1], a[2], a[3], a[4], a[5]]; break;
      case "translate": n = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0]; break;
      case "scale": n = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0]; break;
      case "rotate": {
        const r = ((a[0] ?? 0) * Math.PI) / 180;
        const rot: Mat = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
        n = a.length >= 3 ? matMul(matMul([1, 0, 0, 1, a[1], a[2]], rot), [1, 0, 0, 1, -a[1], -a[2]]) : rot;
        break;
      }
      case "skewX": n = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0]; break;
      case "skewY": n = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0]; break;
    }
    if (n.some((x) => !Number.isFinite(x))) continue;
    m = matMul(m, n);
  }
  return m;
}

function transformSegments(m: Mat, segs: PathSegment[]): PathSegment[] {
  if (matIsIdentity(m)) return segs;
  return segs.map((sg) => ({
    ...sg,
    ...matApply(m, sg.x, sg.y),
    ...(sg.cIn ? { cIn: matApply(m, sg.cIn.x, sg.cIn.y) } : {}),
    ...(sg.cOut ? { cOut: matApply(m, sg.cOut.x, sg.cOut.y) } : {}),
  }));
}

/** A rect as a closed path (corner radius dropped: only a rotated or skewed
 *  rect takes this road, and a rounded one of those is rare in packs). */
function rectSegments(x: number, y: number, w: number, h: number): PathSegment[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

/** An ellipse as four cubic arcs. */
function ellipseSegments(cx: number, cy: number, rx: number, ry: number): PathSegment[] {
  const k = 0.5522847498;
  return [
    { x: cx + rx, y: cy, cIn: { x: cx + rx, y: cy + ry * k }, cOut: { x: cx + rx, y: cy - ry * k } },
    { x: cx, y: cy - ry, cIn: { x: cx + rx * k, y: cy - ry }, cOut: { x: cx - rx * k, y: cy - ry } },
    { x: cx - rx, y: cy, cIn: { x: cx - rx, y: cy - ry * k }, cOut: { x: cx - rx, y: cy + ry * k } },
    { x: cx, y: cy + ry, cIn: { x: cx - rx * k, y: cy + ry }, cOut: { x: cx + rx * k, y: cy + ry } },
  ];
}

function pathNodeFromSubs(subs: SubPathData[], fills: Fill[], id: string, stroke?: Stroke, opacity?: number): Node {
  const pi = Math.max(0, subs.findIndex((s) => s.segments.length >= 2));
  const first = subs[pi];
  const rest = subs.filter((_, i) => i !== pi);
  const bb = bboxOfSegments(subs.flatMap((s) => s.segments));
  return createNode("path", {
    id,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: bb.w, height: bb.h },
    segments: first.segments,
    closed: first.closed,
    ...(rest.length ? { contours: rest.map((s) => ({ segments: s.segments, closed: s.closed })) } : {}),
    fills,
    ...(stroke ? { stroke } : {}),
    ...(opacity != null && opacity < 1 ? { opacity } : {}),
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
    .replace(/&amp;/g, "&");
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
  assets: { assetId: string; url: string }[];
  approximated: boolean;
}

export function svgToNodes(
  svg: string,
  idGen: () => string = (() => { let i = 0; return () => `svg-${++i}`; })(),
  opts: { fallbackFill?: boolean; gradients?: Record<string, GradientFill> } = {},
): SvgToNodesResult {
  const nodes: Node[] = [];
  const assets: { assetId: string; url: string }[] = [];
  let approximated = false;
  const fallbackFill = opts.fallbackFill ?? true;
  // Gradient defs: those in this string, plus any injected by the caller (the
  // flatten path passes the root <defs> since it converts one leaf at a time).
  const gradients = { ...parseGradients(svg), ...(opts.gradients ?? {}) };
  const ff = (attrs: Attrs, want = true): Fill[] => fillsFrom(attrs, fallbackFill && want, gradients);

  const inherited = rootInherited(svg);
  const withInherited = (own: Attrs): Attrs => ({ ...inherited, ...own });

  // Containers are walked in document order alongside the leaves: a group
  // pushes its transform for everything inside it, and the contents of
  // defs, clip paths, masks, symbols, patterns and markers are not drawn.
  const stack: { tag: string; mat: Mat; hidden: boolean }[] = [];
  const current = (): Mat => (stack.length ? stack[stack.length - 1].mat : IDENTITY);
  const hidden = (): boolean => stack.some((f) => f.hidden);
  const HIDDEN = new Set(["defs", "clippath", "mask", "symbol", "pattern", "marker"]);
  const re = /<(g|defs|clipPath|mask|symbol|pattern|marker)\b([^>]*?)(\/?)>|<\/(g|defs|clipPath|mask|symbol|pattern|marker)\s*>|<(path|rect|circle|ellipse|polygon|polyline|line|image)\b([^>]*?)\/?>|<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  for (const m of svg.matchAll(re)) {
    if (m[1] !== undefined) {
      if (m[3] === "/") continue; // an empty container
      const tag = m[1].toLowerCase();
      const own = parseTransform(parseAttrs(m[2]).transform);
      stack.push({ tag, mat: matMul(current(), own), hidden: HIDDEN.has(tag) });
      continue;
    }
    if (m[4] !== undefined) {
      // Pop to the matching open tag; a stray close tag pops nothing.
      const tag = m[4].toLowerCase();
      for (let i = stack.length - 1; i >= 0; i--) if (stack[i].tag === tag) { stack.length = i; break; }
      continue;
    }
    if (hidden()) continue;
    if (m[7] !== undefined) {
      const attrs = withInherited(parseAttrs(m[7]));
      const text = decodeEntities(m[8].replace(/<[^<>]+>/g, " ")).replace(/\s+/g, " ").trim();
      if (!text) continue;
      const fontSize = num(attrs, "font-size", 16) || 16;
      const weight = weightFrom(attrs["font-weight"]);
      const fc = paintToFill(attrs.fill, gradients, opacityOf(attrs, "fill-opacity"));
      const color: Color = fc && fc !== "none" && fc.type === "solid" ? fc.color : { srgb: { r: 0, g: 0, b: 0, a: 1 } };
      const estW = Math.max(16, text.length * fontSize * 0.55);
      const align = anchorToAlign(attrs["text-anchor"]);
      const tm = matMul(current(), parseTransform(attrs.transform));
      const at = matApply(tm, num(attrs, "x"), num(attrs, "y"));
      const left = align === "center" ? at.x - estW / 2 : align === "right" ? at.x - estW : at.x;
      const op = opacityOf(attrs, "opacity");
      nodes.push(createNode("text", {
        id: idGen(),
        name: text.slice(0, 24),
        transform: { x: left, y: at.y - fontSize * 0.8, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: estW, height: fontSize * 1.4 },
        ...(op < 1 ? { opacity: op } : {}),
        box: { mode: "fixed", width: estW, height: fontSize * 1.4, autoFit: { enabled: false, min: 8, max: 512 }, verticalAlign: "top" },
        content: [{
          runs: [{ text, style: { fontFamily: (attrs["font-family"] || "system").replace(/['"]/g, "").split(",")[0].trim() || "system", fontStyle: weight && weight >= 600 ? "Bold" : "Regular", fontSize, ...(weight ? { axes: { wght: weight } } : {}), fill: { type: "solid", color } } }],
          style: { align, direction: "auto" },
        }],
      } as Partial<Node>));
      continue;
    }
    const tag = m[5].toLowerCase();
    const attrs = withInherited(parseAttrs(m[6]));
    const stroke = strokeFrom(attrs, gradients);
    const op = opacityOf(attrs, "opacity");
    const opP = op < 1 ? op : undefined;
    const tm = matMul(current(), parseTransform(attrs.transform));
    const aligned = matIsAxisAligned(tm);
    // A stroke's width scales with the drawing, uniformly enough.
    const scaled = stroke && !matIsIdentity(tm) ? { ...stroke, width: stroke.width * Math.sqrt(Math.abs(tm[0] * tm[3] - tm[1] * tm[2])) } : stroke;
    if (tag === "image") {
      const href = attrs.href || attrs["xlink:href"];
      if (!href) continue;
      const w = (num(attrs, "width", 100) || 100) * (aligned ? tm[0] : 1);
      const h = (num(attrs, "height", 100) || 100) * (aligned ? tm[3] : 1);
      const at = matApply(tm, num(attrs, "x"), num(attrs, "y"));
      const assetId = idGen();
      assets.push({ assetId, url: href });
      nodes.push(createNode("image", {
        id: idGen(),
        source: { assetId, naturalWidth: w, naturalHeight: h },
        fit: "cover",
        transform: { x: at.x, y: at.y, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: w, height: h },
        ...(opP != null ? { opacity: opP } : {}),
      } as Partial<Node>));
    } else if (tag === "path") {
      if (/[aA]/.test(attrs.d ?? "")) approximated = true;
      const subs = parsePathData(attrs.d ?? "").map((sp) => ({ ...sp, segments: transformSegments(tm, sp.segments) }));
      const fills = ff(attrs, !stroke);
      if (subs.length) nodes.push(pathNodeFromSubs(subs, fills, idGen(), scaled, opP));
    } else if (tag === "rect") {
      const r = num(attrs, "rx", num(attrs, "ry", 0));
      const x = num(attrs, "x"), y = num(attrs, "y"), w = num(attrs, "width"), h = num(attrs, "height");
      if (!aligned) {
        nodes.push(pathNodeFromSubs([{ segments: transformSegments(tm, rectSegments(x, y, w, h)), closed: true }], ff(attrs, !stroke), idGen(), scaled, opP));
        continue;
      }
      const at = matApply(tm, x, y);
      nodes.push(createNode("shape", {
        id: idGen(),
        shape: "rect",
        transform: { x: at.x, y: at.y, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: w * tm[0], height: h * tm[3] },
        cornerRadius: r > 0 ? { topLeft: r * tm[0], topRight: r * tm[0], bottomRight: r * tm[0], bottomLeft: r * tm[0] } : undefined,
        fills: ff(attrs, !stroke),
        ...(scaled ? { stroke: scaled } : {}),
        ...(opP != null ? { opacity: opP } : {}),
      } as Partial<Node>));
    } else if (tag === "circle" || tag === "ellipse") {
      const rx = tag === "circle" ? num(attrs, "r") : num(attrs, "rx");
      const ry = tag === "circle" ? num(attrs, "r") : num(attrs, "ry");
      const cx = num(attrs, "cx"), cy = num(attrs, "cy");
      if (!aligned) {
        nodes.push(pathNodeFromSubs([{ segments: transformSegments(tm, ellipseSegments(cx, cy, rx, ry)), closed: true }], ff(attrs, !stroke), idGen(), scaled, opP));
        continue;
      }
      const at = matApply(tm, cx - rx, cy - ry);
      nodes.push(createNode("shape", {
        id: idGen(),
        shape: "ellipse",
        transform: { x: at.x, y: at.y, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: rx * 2 * tm[0], height: ry * 2 * tm[3] },
        fills: ff(attrs, !stroke),
        ...(scaled ? { stroke: scaled } : {}),
        ...(opP != null ? { opacity: opP } : {}),
      } as Partial<Node>));
    } else if (tag === "polygon" || tag === "polyline") {
      const segs = transformSegments(tm, pointsToSegments(attrs.points ?? ""));
      const fills = tag === "polygon" ? ff(attrs, !stroke) : [];
      if (segs.length) nodes.push(pathNodeFromSubs([{ segments: segs, closed: tag === "polygon" }], fills, idGen(), scaled, opP));
    } else if (tag === "line") {
      const segs: PathSegment[] = transformSegments(tm, [
        { x: num(attrs, "x1"), y: num(attrs, "y1") },
        { x: num(attrs, "x2"), y: num(attrs, "y2") },
      ]);
      nodes.push(pathNodeFromSubs([{ segments: segs, closed: false }], [], idGen(), scaled, opP));
    }
  }
  return { nodes, assets, approximated };
}
