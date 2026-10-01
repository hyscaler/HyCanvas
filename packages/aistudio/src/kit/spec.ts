// The kit's slide vocabulary and its compiler.
//
// A kit layout describes a slide as a list of primitives in page space
// (text, rect, ellipse, button, icon, photo, path, chart, drawing), the
// same vocabulary the presentation templates are written in. This module
// turns that list into file-format nodes: one text node per text, a shape
// per rect or ellipse, a pill and a label per button, a path per icon, a
// frame per photo slot, a group of paths per drawing. It also does the one
// thing a template compiler never had to: fit copy the model wrote into
// boxes a designer drew, stepping the size down until the copy holds, and
// naming what still does not so the deck's report can hand it back.

import { createNode, roundedCorners, type Fill, type Node, type PathContour } from "@hc/schema";
import { ICON_BOX, ICON_GLYPHS } from "../iconset";
import { PACK_DRAWINGS, type PackDrawing } from "./packset";
import { decodeDrawingPath } from "../archetypes";

/** A solid hex, or a gradient between hex stops. */
export type SpecFill = string | { angle?: number; stops: [string, number][]; radial?: boolean };

export interface TextSpan { text: string; color?: string; weight?: number }

export interface TextPrim {
  kind: "text";
  x: number; y: number; w: number; h: number;
  text: string;
  family: string;
  size: number;
  weight?: number;
  color?: string;
  align?: "left" | "center" | "right";
  vAlign?: "top" | "middle" | "bottom";
  lineHeight?: number;
  letterSpacing?: number;
  upper?: boolean;
  spans?: TextSpan[];
  opacity?: number;
  rotation?: number;
  /** The node's name: what the motion and the measure read. */
  name?: string;
  /** Average glyph advance as a fraction of the size, for the fit estimate. */
  cw?: number;
  /** Never step the size down: furniture and ornament are set as authored. */
  fixed?: boolean;
  /** Ornament text (a watermark): drawn behind, never measured. */
  decor?: boolean;
}

export interface ShapePrim {
  kind: "rect" | "ellipse";
  x: number; y: number; w: number; h: number;
  fill?: SpecFill;
  radius?: number;
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
  rotation?: number;
  name?: string;
  /** Ornament: may bleed off the page and sit under anything. */
  decor?: boolean;
  /** A card or a badge the content sits on: not an overlap. */
  panel?: boolean;
  data?: Record<string, unknown>;
}

export interface ButtonPrim {
  kind: "button";
  x: number; y: number; w: number; h: number;
  label: string;
  fill: SpecFill;
  color: string;
  family: string;
  size?: number;
  weight?: number;
  radius?: number;
  upper?: boolean;
  letterSpacing?: number;
}

export interface IconPrim { kind: "icon"; icon: string; x: number; y: number; w: number; h: number; color: string }

export interface PhotoPrim {
  kind: "photo";
  x: number; y: number; w: number; h: number;
  fill: SpecFill;
  shape?: "rect" | "ellipse";
  radius?: number;
  /** Set when the picture pipeline should fill the slot: the id it lands by
   *  and the prompt it draws from. */
  placeholderId?: string;
  prompt?: string;
}

export type PathPoint = [number, number] | { x: number; y: number; cIn?: { x: number; y: number }; cOut?: { x: number; y: number } };
export interface PathPrim {
  kind: "path";
  points: PathPoint[];
  fill?: SpecFill;
  stroke?: string;
  strokeWidth?: number;
  closed?: boolean;
  cap?: "butt" | "round" | "square";
  join?: "miter" | "round" | "bevel";
  dash?: number[];
  name?: string;
  decor?: boolean;
}

export interface ChartPrim {
  kind: "chart";
  x: number; y: number; w: number; h: number;
  chartType: string;
  categories: string[];
  series: { name: string; values: number[]; color?: string }[];
  fontSize?: number;
}

/** The brand's logo, fitted into the box: an image node the file's asset
 *  list backs, tagged so brand tooling knows it from a picture. */
export interface LogoPrim { kind: "logo"; assetId: string; x: number; y: number; w: number; h: number }

/** A drawing from the pack, fitted and centered in the box. */
export interface DrawingPrim { kind: "drawing"; asset: string; x: number; y: number; w: number; h: number; opacity?: number; rotation?: number; name?: string }

export type Prim = TextPrim | ShapePrim | ButtonPrim | IconPrim | PhotoPrim | PathPrim | ChartPrim | DrawingPrim | LogoPrim;

// --- constructors ---------------------------------------------------------------

type TextOpts = Omit<TextPrim, "kind" | "x" | "y" | "w" | "h" | "text" | "family" | "size"> & { family: string; size: number };
export const text = (x: number, y: number, w: number, h: number, t: string, o: TextOpts): TextPrim => ({ kind: "text", x, y, w, h, text: t, ...o });
export const rect = (x: number, y: number, w: number, h: number, fill: SpecFill | undefined, o: Partial<Omit<ShapePrim, "kind">> = {}): ShapePrim => ({ kind: "rect", x, y, w, h, fill, ...o });
export const ellipse = (x: number, y: number, w: number, h: number, fill: SpecFill | undefined, o: Partial<Omit<ShapePrim, "kind">> = {}): ShapePrim => ({ kind: "ellipse", x, y, w, h, fill, ...o });
export const button = (x: number, y: number, w: number, h: number, label: string, o: Omit<ButtonPrim, "kind" | "x" | "y" | "w" | "h" | "label">): ButtonPrim => ({ kind: "button", x, y, w, h, label, ...o });
export const icon = (name: string, x: number, y: number, size: number, color: string): IconPrim => ({ kind: "icon", icon: name, x, y, w: size, h: size, color });
export const photo = (x: number, y: number, w: number, h: number, fill: SpecFill, o: Partial<Omit<PhotoPrim, "kind" | "x" | "y" | "w" | "h" | "fill">> = {}): PhotoPrim => ({ kind: "photo", x, y, w, h, fill, ...o });
export const path = (points: PathPoint[], o: Partial<Omit<PathPrim, "kind" | "points">> = {}): PathPrim => ({ kind: "path", points, ...o });
export const logo = (assetId: string, x: number, y: number, w: number, h: number): LogoPrim => ({ kind: "logo", assetId, x, y, w, h });
export const drawing = (asset: string, x: number, y: number, w: number, h: number, o: Partial<Omit<DrawingPrim, "kind" | "asset" | "x" | "y" | "w" | "h">> = {}): DrawingPrim => ({ kind: "drawing", asset, x, y, w, h, ...o });

/** Mark primitives as ornament: drawn behind, allowed off the page, never
 *  counted as content. */
export function decor<T extends Prim>(prims: T[]): T[] {
  for (const p of prims) if (p.kind === "rect" || p.kind === "ellipse" || p.kind === "path" || p.kind === "text") (p as { decor?: boolean }).decor = true;
  return prims;
}

// --- colour --------------------------------------------------------------------

export function hex6(hex: string): string {
  const h = hex.replace("#", "");
  return "#" + (h.length === 3 ? [...h].map((c) => c + c).join("") : h.slice(0, 6)).toLowerCase();
}

export function srgb(hex: string): { srgb: { r: number; g: number; b: number; a: number } } {
  const h = hex6(hex).slice(1);
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { srgb: { r: n(0), g: n(2), b: n(4), a: 1 } };
}

export function fillOf(f: SpecFill): Fill {
  if (typeof f === "string") return { type: "solid", color: srgb(f) };
  return {
    type: "gradient",
    gradient: f.radial ? "radial" : "linear",
    angle: f.angle ?? 90,
    stops: f.stops.map(([hex, position]) => ({ position, color: srgb(hex) })),
  } as Fill;
}

// --- text estimates ---------------------------------------------------------------

/** Estimated width of a line: a conservative average advance, so a heavy
 *  face still fits where the estimate says it does. */
export const estWidth = (str: string, size: number, f = 0.56): number => str.length * size * f;

/** The size at which every line of `str` (split on newlines) fits `width`,
 *  never below `floor` of the asked size. */
export function fitSize(str: string, size: number, width: number, floor = 0.6, f = 0.56): number {
  const longest = Math.max(...str.split("\n").map((l) => estWidth(l, size, f)));
  if (longest <= width) return size;
  return Math.max(size * floor, Math.round((size * width) / longest));
}

/** Lines a run of text takes at a size in a width, wrapping on words. */
export function linesFor(str: string, size: number, width: number, f = 0.56): number {
  let n = 0;
  for (const line of str.split("\n")) {
    const words = line.split(/\s+/).filter(Boolean);
    if (!words.length) { n += 1; continue; }
    let rows = 1;
    let x = 0;
    const space = size * f;
    for (const w of words) {
      const ww = estWidth(w, size, f);
      if (x > 0 && x + space + ww > width) { rows += Math.max(1, Math.ceil(ww / width)); x = ww % width; }
      else { x += (x > 0 ? space : 0) + ww; if (ww > width) { rows += Math.ceil(ww / width) - 1; x = ww % width; } }
    }
    n += rows;
  }
  return n;
}

// --- the compiler ---------------------------------------------------------------

export interface CompileResult { nodes: Node[]; overfull: string[] }

const radius = (r: number) => roundedCorners(r);

function base(p: { x: number; y: number; w: number; h: number; rotation?: number; opacity?: number; name?: string }) {
  return {
    ...(p.name ? { name: p.name } : {}),
    transform: { x: p.x, y: p.y, scaleX: 1, scaleY: 1, rotation: p.rotation ?? 0 },
    size: { width: p.w, height: p.h },
    opacity: p.opacity ?? 1,
  };
}

function shapeNode(p: ShapePrim): Node {
  const data: Record<string, unknown> = { ...(p.data ?? {}) };
  if (p.decor) data.decor = true;
  if (p.panel) data.panel = true;
  return createNode("shape", {
    ...base({ ...p, name: p.name ?? (p.decor ? "Decor" : p.panel ? "Panel" : "Shape") }),
    shape: p.kind,
    fills: p.fill === undefined ? [] : [fillOf(p.fill)],
    ...(p.radius ? { cornerRadius: radius(p.radius) } : {}),
    ...(p.stroke ? { stroke: { fill: fillOf(p.stroke), width: p.strokeWidth ?? 2, align: "center", cap: "butt", join: "miter" } } : {}),
    ...(Object.keys(data).length ? { data } : {}),
  } as never) as Node;
}

/** Sizes step down in even numbers to seven tenths of what was asked; copy
 *  that still does not hold is named for the report. */
function fitText(p: TextPrim): { size: number; over: boolean } {
  const asked = p.size;
  if (p.fixed || p.spans) return { size: asked, over: false };
  const lh = p.lineHeight ?? 1.3;
  const cw = p.cw ?? 0.56;
  const floor = Math.max(12, Math.round(asked * 0.7));
  let size = asked;
  const holds = (s: number) => linesFor(p.text, s, p.w, cw) * s * lh <= p.h + 1;
  while (size > floor && !holds(size)) size -= size > 40 ? 4 : 2;
  if (size < floor) size = floor;
  return { size, over: !holds(size) };
}

function textNode(p: TextPrim, overfull: string[]): Node {
  const { size, over } = fitText(p);
  const name = p.name ?? (p.decor ? "Decor" : "Text");
  if (over) overfull.push(name);
  const style: Record<string, unknown> = {
    fontFamily: p.family,
    fontStyle: "Regular",
    fontSize: size,
    axes: { wght: p.weight ?? 400 },
    fill: fillOf(p.color ?? "#111111"),
  };
  if (p.letterSpacing) style.letterSpacing = p.letterSpacing;
  if (p.upper) style.case = "upper";
  if (p.lineHeight) style.lineHeight = { mode: "multiple", value: p.lineHeight };
  const paraStyle = { align: p.align ?? "left", direction: "auto" };
  const content = p.spans
    ? [{ runs: p.spans.map((sp) => ({ text: sp.text, style: { ...style, ...(sp.color ? { fill: fillOf(sp.color) } : {}), ...(sp.weight ? { axes: { wght: sp.weight } } : {}) } })), style: paraStyle }]
    : String(p.text).split("\n").map((line) => ({ runs: [{ text: line, style: { ...style } }], style: { ...paraStyle } }));
  return createNode("text", {
    ...base({ ...p, name }),
    box: { mode: "fixed", width: p.w, height: p.h, autoFit: { enabled: false, min: 8, max: 512 }, verticalAlign: p.vAlign ?? "top" },
    content,
    ...(p.decor ? { data: { decor: true } } : {}),
  } as never) as Node;
}

function buttonNodes(p: ButtonPrim, overfull: string[]): Node[] {
  const bg = shapeNode({ kind: "rect", x: p.x, y: p.y, w: p.w, h: p.h, fill: p.fill, radius: p.radius ?? p.h / 2, panel: true, name: "Button" });
  const label = textNode({
    kind: "text", x: p.x, y: p.y, w: p.w, h: p.h, text: p.label, family: p.family, size: p.size ?? 28, weight: p.weight ?? 700,
    color: p.color, align: "center", vAlign: "middle", letterSpacing: p.letterSpacing, upper: p.upper, name: "Label", lineHeight: 1.1, cw: 0.58,
  }, overfull);
  return [bg, label];
}

function iconNode(p: IconPrim): Node | null {
  const contours = ICON_GLYPHS[p.icon];
  if (!contours?.length) return null;
  const size = p.w;
  const k = size / ICON_BOX;
  const pt = (q: { x: number; y: number }) => ({ x: Math.round(q.x * k * 100) / 100, y: Math.round(q.y * k * 100) / 100 });
  const scaled = contours.map((c) => ({
    closed: c.closed,
    segments: c.segments.map((sg) => ({ ...pt(sg), ...(sg.cIn ? { cIn: pt(sg.cIn) } : {}), ...(sg.cOut ? { cOut: pt(sg.cOut) } : {}) })),
  }));
  const [first, ...rest] = scaled;
  return createNode("path", {
    ...base({ x: p.x, y: p.y, w: size, h: size, name: "Icon" }),
    segments: first.segments,
    closed: first.closed,
    ...(rest.length ? { contours: rest } : {}),
    fills: [fillOf(p.color)],
    data: { icon: p.icon },
  } as never) as Node;
}

/** A picture slot. Tagged for the picture pipeline, it is the same stand-in
 *  shape the classic composer makes (both ladders, the editor's and the
 *  API's, replace a tagged shape with the picture); untagged, it is an empty
 *  image frame a photo can be dropped on, elliptical for a portrait. */
function photoNode(p: PhotoPrim): Node {
  if (p.placeholderId) {
    return createNode("shape", {
      ...base({ ...p, name: "Image" }),
      shape: "rect",
      fills: [fillOf(p.fill)],
      ...(p.radius ? { cornerRadius: radius(p.radius) } : {}),
      data: { placeholderId: p.placeholderId, aiImagePrompt: p.prompt ?? "" },
    } as never) as Node;
  }
  const data: Record<string, unknown> = { panel: true };
  return createNode("frame", {
    ...base({ ...p, name: "Photo" }),
    clip: true,
    children: [],
    maskShape: p.shape === "ellipse" ? "ellipse" : "rect",
    fills: [fillOf(p.fill)],
    ...(p.radius && p.shape !== "ellipse" ? { cornerRadius: radius(p.radius) } : {}),
    data,
  } as never) as Node;
}

function chartNode(p: ChartPrim): Node {
  const series = p.series.map((s) => ({ name: s.name, values: s.values, ...(s.color ? { color: srgb(s.color) } : {}) }));
  const kind = p.chartType;
  return createNode("chart", {
    ...base({ ...p, name: "Chart" }),
    chartType: kind,
    categories: p.categories,
    series,
    options: {},
    style: {
      fontSize: p.fontSize ?? 18,
      valueLabels: kind === "bar" || kind === "barGrouped" || kind === "line",
      legend: { show: series.length > 1, position: "bottom" },
      axes: { showX: true, showY: kind !== "pie" && kind !== "donut" },
    },
  } as never) as Node;
}

function pathNode(p: PathPrim): Node {
  const pts = p.points.map((pt) => (Array.isArray(pt) ? { x: pt[0], y: pt[1] } : pt));
  const xs = pts.flatMap((pt) => [pt.x, pt.cIn?.x, pt.cOut?.x].filter((v): v is number => v !== undefined));
  const ys = pts.flatMap((pt) => [pt.y, pt.cIn?.y, pt.cOut?.y].filter((v): v is number => v !== undefined));
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  const w = Math.max(1, Math.max(...xs) - x0), h = Math.max(1, Math.max(...ys) - y0);
  const rel = (pt: { x: number; y: number }) => ({ x: Math.round((pt.x - x0) * 100) / 100, y: Math.round((pt.y - y0) * 100) / 100 });
  const segments = pts.map((pt) => ({ ...rel(pt), ...(pt.cIn ? { cIn: rel(pt.cIn) } : {}), ...(pt.cOut ? { cOut: rel(pt.cOut) } : {}) }));
  return createNode("path", {
    ...base({ x: x0, y: y0, w, h, name: p.name ?? (p.decor ? "Decor" : "Path") }),
    segments,
    closed: !!p.closed,
    fills: p.fill === undefined ? [] : [fillOf(p.fill)],
    ...(p.stroke ? { stroke: { fill: fillOf(p.stroke), width: p.strokeWidth ?? 2, align: "center", cap: p.cap ?? "round", join: p.join ?? "round", ...(p.dash ? { dash: p.dash } : {}) } } : {}),
    ...(p.decor ? { data: { decor: true } } : {}),
  } as never) as Node;
}

/** A drawing from the pack: one path node per layer, in the pack's own
 *  colours, fitted and centered in the box, grouped so the editor moves it
 *  as one thing and the measure sees one box. Named "Illustration" so the
 *  editor's picture queue leaves the page alone. */
export function drawingNode(p: DrawingPrim): Node | null {
  const d: PackDrawing | undefined = PACK_DRAWINGS[p.asset];
  if (!d) return null;
  const k = Math.min(p.w / d.w, p.h / d.h);
  const w = Math.round(d.w * k), h = Math.round(d.h * k);
  const x = p.x + Math.round((p.w - w) / 2), y = p.y + Math.round((p.h - h) / 2);
  const children: Node[] = [];
  for (const layer of d.layers) {
    const [fill, pathStr] = layer;
    const strokeW = layer[2] ?? 0;
    const opacity = layer[3] ?? 1;
    const strokeHex = layer[4] ?? "";
    const contours: PathContour[] = decodeDrawingPath(pathStr, k, 0, 0);
    if (!contours.length) continue;
    const [first, ...rest] = contours;
    children.push(createNode("path", {
      name: "Layer",
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: w, height: h },
      opacity,
      segments: first.segments,
      closed: first.closed,
      ...(rest.length ? { contours: rest } : {}),
      fills: fill ? [fillOf(fill)] : [],
      ...(strokeHex ? { stroke: { fill: fillOf(strokeHex), width: Math.max(0.5, Math.round(strokeW * k * 10) / 10), align: "center", cap: "round", join: "round" } } : {}),
    } as never) as Node);
  }
  if (!children.length) return null;
  return createNode("group", {
    ...base({ x, y, w, h, opacity: p.opacity, rotation: p.rotation, name: p.name ?? "Illustration" }),
    children,
    data: { illustration: p.asset, title: d.title },
  } as never) as Node;
}

function logoNode(p: LogoPrim): Node {
  return createNode("image", {
    ...base({ ...p, name: "Logo" }),
    source: { assetId: p.assetId, naturalWidth: 0, naturalHeight: 0 },
    fit: "contain",
    data: { brandLogo: true },
  } as never) as Node;
}

/** Compile a slide's primitives, then its drawings on top, into nodes. */
export function compileSlide(prims: Prim[], drawings: DrawingPrim[] = []): CompileResult {
  const nodes: Node[] = [];
  const overfull: string[] = [];
  for (const p of prims) {
    switch (p.kind) {
      case "rect": case "ellipse": nodes.push(shapeNode(p)); break;
      case "text": nodes.push(textNode(p, overfull)); break;
      case "button": nodes.push(...buttonNodes(p, overfull)); break;
      case "icon": { const n = iconNode(p); if (n) nodes.push(n); break; }
      case "photo": nodes.push(photoNode(p)); break;
      case "chart": nodes.push(chartNode(p)); break;
      case "path": nodes.push(pathNode(p)); break;
      case "drawing": { const n = drawingNode(p); if (n) nodes.push(n); break; }
      case "logo": nodes.push(logoNode(p)); break;
    }
  }
  for (const d of drawings) { const n = drawingNode(d); if (n) nodes.push(n); }
  return { nodes, overfull };
}

/** Scale a slide composed at the kit's 1920 by 1080 to another page of the
 *  same proportions: every position, size, type size, radius, stroke and
 *  path point by one factor, so a 1280 by 720 deck is the same slide. */
export function scaleNodes(nodes: Node[], s: number): Node[] {
  if (s === 1) return nodes;
  const num = (v: number) => Math.round(v * s * 100) / 100;
  const pt = (p: { x: number; y: number; cIn?: { x: number; y: number }; cOut?: { x: number; y: number } }) => ({ ...p, x: num(p.x), y: num(p.y), ...(p.cIn ? { cIn: { x: num(p.cIn.x), y: num(p.cIn.y) } } : {}), ...(p.cOut ? { cOut: { x: num(p.cOut.x), y: num(p.cOut.y) } } : {}) });
  const walk = (n: Node) => {
    const a = n as unknown as Record<string, unknown>;
    const t = a.transform as { x: number; y: number };
    a.transform = { ...t, x: num(t.x), y: num(t.y) };
    const sz = a.size as { width: number; height: number };
    a.size = { width: num(sz.width), height: num(sz.height) };
    if (a.cornerRadius) { const c = a.cornerRadius as Record<string, number>; a.cornerRadius = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, num(v)])); }
    if (a.stroke) { const st = a.stroke as { width: number; dash?: number[] }; a.stroke = { ...st, width: Math.max(0.5, num(st.width)), ...(st.dash ? { dash: st.dash.map(num) } : {}) }; }
    if (a.box) { const b = a.box as { width: number; height: number }; a.box = { ...b, width: num(b.width), height: num(b.height) }; }
    if (Array.isArray(a.content)) {
      for (const para of a.content as Array<{ runs: Array<{ style: { fontSize: number; letterSpacing?: number } }> }>) {
        for (const run of para.runs) { run.style.fontSize = Math.max(6, num(run.style.fontSize)); if (run.style.letterSpacing) run.style.letterSpacing = num(run.style.letterSpacing); }
      }
    }
    if (Array.isArray(a.segments)) a.segments = (a.segments as Array<{ x: number; y: number }>).map(pt);
    if (Array.isArray(a.contours)) a.contours = (a.contours as Array<{ segments: Array<{ x: number; y: number }>; closed: boolean }>).map((c) => ({ ...c, segments: c.segments.map(pt) }));
    if (a.style && typeof a.style === "object" && "fontSize" in (a.style as object)) { const st = a.style as { fontSize: number }; st.fontSize = Math.max(6, num(st.fontSize)); }
    if (Array.isArray(a.children)) for (const c of a.children as Node[]) walk(c);
  };
  for (const n of nodes) walk(n);
  return nodes;
}
