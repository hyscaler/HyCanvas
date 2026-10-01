// Bake the AI composer's drawing pack from the bundled illustration packs.
//
// The signature presentation templates place full-colour drawings from the
// bundled packs (illlustrations, lukaszadam, opendoodles) and drawn portraits
// (openpeeps) in halos on their covers, sections, pictures and closings. The
// composer runs in the browser and under goja, with no file system and no
// SVG parser, so a curated slice of those drawings is compiled here into a
// TypeScript module: each drawing as one compact path string per fill, in
// its own tight box, every transform flattened and every arc converted to
// cubics by the stock importer at generation time. Colours are kept as the
// pack drew them; the composer places the drawing as editable vector paths.
//
// Run: npm run build -w packages/stock && node scripts/gen-kit-packset.mjs
//
// Sources: illlustrations.co (MIT), Lukasz Adam (CC0), Open Doodles (CC0),
// Open Peeps (CC0), from backend/internal/stock/library.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIBRARY = join(ROOT, "backend", "internal", "stock", "library");
const OUT = join(ROOT, "packages", "aistudio", "src", "kit", "packset.ts");
const { svgToNodes } = await import(join(ROOT, "packages", "stock", "dist", "index.js"));

// Keyword the outline model may name -> pack asset. Chosen for what a deck
// talks about, and for the drawings the signature templates already use.
// Synonyms map onto one drawing so a model that writes "launch" or "rocket"
// gets the same picture.
const DRAWINGS = {
  rocket: "la-free-svg-illustration-rocket", launch: "il-day20-rocket", robot: "la-ai-robot-3", robots: "la-free-svg-illustrations-robots",
  success: "la-success-illustration", celebration: "il-day97-champagne", fireworks: "il-day35-firework", party: "il-day97-champagne",
  conversation: "la-conversation-illustration", meeting: "la-conversation-illustration", team: "la-flat-character-illustrations", people: "la-flat-character-illustrations", characters: "la-small-character-illustrations",
  working: "la-woman-working-1", desk: "la-desk-illustration-2", office: "la-working-2", laptop: "la-woman-working-2", workspace: "la-hero-image-2", remote: "il-121-work-from-home-1",
  thinking: "la-guy-with-glasses", waiting: "la-waitng-illustration", doodle: "la-doodle", scooter: "la-scooter", coffee: "la-coffee", cafe: "il-day30-cafe",
  building: "la-building", city: "il-day65-city-road", house: "la-house-illustrations", home: "il-day31-sweet-home",
  map: "il-109-map-location", travel: "il-day61-travel-bag", camping: "il-day96-camping", farm: "il-day53-farm", kitchen: "il-day59-kitchen", food: "il-day82-burger",
  coding: "il-111-coding", developer: "il-day13-it-girl", desktop: "il-day41-desktop", computer: "il-day38-macintosh", storage: "il-day44-hdd",
  design: "il-day94-ui-ux", easel: "il-day10-canvas-stand", writing: "il-day73-writing-tool", palette: "il-day15-color-tool",
  abacus: "il-day36-abacus", calculator: "il-day37-calculator", vault: "il-day6-open-vault", wallet: "il-day78-wallet", sale: "la-sale",
  blackboard: "il-day11-blackboard", library: "il-day57-reading-room",
  "walkie-talkie": "il-day17-walkie-talkie", radio: "il-day17-walkie-talkie", camera: "il-day4-polariod", video: "la-youtube-illustration",
  logistics: "il-day14-forklift", forklift: "il-day14-forklift", fitness: "il-103-gym-time", tools: "la-tools", science: "la-test-tubes", website: "la-website-builder",
  jumping: "od-jumping", strolling: "od-strolling", running: "od-running",
};
// Drawn portraits for team and quote slots, the ones the templates use most.
const PEEPS = ["op-peep-84", "op-peep-86", "op-peep-105", "op-peep-53", "op-peep-23", "op-peep-72", "op-peep-9", "op-peep-56", "op-peep-41", "op-peep-55", "op-peep-58", "op-peep-47"];
const MAX_DRAWING_BYTES = 60 * 1024;

const STOCK = new Map();
for (const pack of ["illlustrations", "lukaszadam", "opendoodles", "openpeeps"]) {
  const idx = JSON.parse(readFileSync(join(LIBRARY, pack, "index.json"), "utf8"));
  for (const a of idx.assets) STOCK.set(a.id, { pack, file: a.file, title: a.title });
}

const hex = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");
const fillHex = (fills) => {
  const f = fills?.[0];
  if (!f) return null;
  if (f.type === "solid") return hex(f.color.srgb);
  if (f.type === "gradient" && f.stops?.length) return hex(f.stops[0].color.srgb);
  return null;
};
// Coordinates to a tenth for a small box; a drawing in a thousand-unit box
// (the illlustrations pack) is exact enough at whole units and a fifth lighter.
let precision = 10;
const f1 = (n) => { const s = (Math.round(n * precision) / precision).toString(); return s.replace(/^(-?)0\./, "$1."); };
const KAPPA = 0.5522847498;

/** Every contour of a node in page (viewBox) space: a path's own, a shape's outline. */
function contoursOf(n) {
  if (n.type === "path") {
    const subs = [{ segments: n.segments, closed: n.closed }, ...(n.contours ?? [])];
    const { x, y } = n.transform ?? { x: 0, y: 0 };
    return subs.filter((s) => s.segments?.length >= 2).map((s) => ({ closed: !!s.closed, segments: s.segments.map((sg) => ({ x: sg.x + x, y: sg.y + y, ...(sg.cIn ? { cIn: { x: sg.cIn.x + x, y: sg.cIn.y + y } } : {}), ...(sg.cOut ? { cOut: { x: sg.cOut.x + x, y: sg.cOut.y + y } } : {}) })) }));
  }
  if (n.type === "shape") {
    const { x, y, rotation = 0 } = n.transform;
    const w = n.size.width, h = n.size.height;
    const rot = (px, py) => {
      if (!rotation) return { x: x + px, y: y + py };
      const a = (rotation * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
      return { x: x + px * c - py * s, y: y + px * s + py * c };
    };
    if (n.shape === "ellipse") {
      const cx = w / 2, cy = h / 2, rx = w / 2, ry = h / 2;
      const pts = [[cx + rx, cy], [cx, cy + ry], [cx - rx, cy], [cx, cy - ry]];
      const ctrl = [[[cx + rx, cy + ry * KAPPA], [cx + rx * KAPPA, cy + ry]], [[cx - rx * KAPPA, cy + ry], [cx - rx, cy + ry * KAPPA]], [[cx - rx, cy - ry * KAPPA], [cx - rx * KAPPA, cy - ry]], [[cx + rx * KAPPA, cy - ry], [cx + rx, cy - ry * KAPPA]]];
      const segs = pts.map(([px, py]) => rot(px, py));
      for (let i = 0; i < 4; i++) { segs[i].cOut = rot(...ctrl[i][0]); segs[(i + 1) % 4].cIn = rot(...ctrl[i][1]); }
      return [{ segments: segs, closed: true }];
    }
    return [{ segments: [rot(0, 0), rot(w, 0), rot(w, h), rot(0, h)], closed: true }];
  }
  return [];
}

function encode(contours, dx, dy) {
  let out = "";
  const P = (p) => `${f1(p.x - dx)} ${f1(p.y - dy)}`;
  for (const c of contours) {
    const s = c.segments;
    out += `M${P(s[0])}`;
    const seg = (a, b) => {
      if (a.cOut || b.cIn) { const c1 = a.cOut ?? a, c2 = b.cIn ?? b; out += `C${P(c1)} ${P(c2)} ${P(b)}`; }
      else out += `L${P(b)}`;
    };
    for (let i = 1; i < s.length; i++) seg(s[i - 1], s[i]);
    if (c.closed) { seg(s[s.length - 1], s[0]); out += "Z"; }
  }
  return out;
}

function bboxOf(contours) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of contours) for (const sg of c.segments) for (const p of [sg, sg.cIn, sg.cOut]) if (p) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x0, y0, x1, y1 };
}

/** One asset baked: its tight box and its layers in paint order. */
function bake(id) {
  const asset = STOCK.get(id);
  if (!asset) throw new Error(`unknown asset ${id}`);
  const svg = readFileSync(join(LIBRARY, asset.pack, asset.file), "utf8");
  let i = 0;
  let { nodes } = svgToNodes(svg, () => `${id}-${++i}`);
  const vb = /viewBox\s*=\s*"([^"]+)"/i.exec(svg)?.[1]?.trim().split(/[\s,]+/).map(Number);
  const vbW = (vb && vb[2]) || 200, vbH = (vb && vb[3]) || 200;
  const items = nodes.map((n) => ({ n, contours: contoursOf(n) })).filter((it) => it.contours.length);
  const kept = items.filter(({ n, contours }) => {
    if (n.type === "text" || n.type === "image") return false;
    if (asset.pack !== "illlustrations") return true;
    const b = bboxOf(contours);
    // The pack's bottom-strip credit marks, and the card the scene sits on
    // (whole, or as a sky and a ground band): on a slide the page is the card.
    if (b.y0 > 0.86 * vbH) return false;
    if (b.x1 - b.x0 > 0.85 * vbW && b.y1 - b.y0 > 0.85 * vbH) return false;
    if (b.x1 - b.x0 > 0.85 * vbW && b.y1 - b.y0 > 0.3 * vbH && (b.y0 < 0.05 * vbH || b.y1 > 0.95 * vbH)) return false;
    return true;
  });
  if (!kept.length) throw new Error(`${id}: nothing left after cleaning`);
  const all = bboxOf(kept.flatMap((it) => it.contours));
  precision = Math.max(all.x1 - all.x0, all.y1 - all.y0) > 600 ? 1 : 10;
  const layers = [];
  for (const { n, contours } of kept) {
    const fill = fillHex(n.fills);
    const strokeHex = n.stroke ? fillHex([n.stroke.fill]) : null;
    if (!fill && !strokeHex) continue;
    const opacity = n.opacity !== undefined && n.opacity < 1 ? Math.round(n.opacity * 100) / 100 : 1;
    const strokeW = strokeHex ? Math.max(0.5, Math.round((n.stroke.width ?? 1) * 10) / 10) : 0;
    const path = encode(contours, all.x0, all.y0);
    const last = layers[layers.length - 1];
    // Adjacent layers in one paint merge into one path node.
    if (last && last[0] === (fill ?? "") && last[2] === strokeW && last[3] === opacity && last[4] === (strokeHex ?? "")) { last[1] += path; continue; }
    layers.push([fill ?? "", path, strokeW, opacity, strokeHex ?? ""]);
  }
  const compact = layers.map(([f, p, sw, op, sc]) => {
    const l = [f, p];
    if (sw || op !== 1 || sc) l.push(sw);
    if (op !== 1 || sc) l.push(op);
    if (sc) l.push(sc);
    return l;
  });
  return { title: asset.title, w: Math.round((all.x1 - all.x0) * 10) / 10, h: Math.round((all.y1 - all.y0) * 10) / 10, layers: compact };
}

const drawings = {};
const skipped = [];
let bytes = 0;
const ids = [...new Set([...Object.values(DRAWINGS), ...PEEPS])].sort();
for (const id of ids) {
  const d = bake(id);
  const size = JSON.stringify(d).length;
  if (size > MAX_DRAWING_BYTES) { skipped.push(`${id} (${Math.round(size / 1024)} KB)`); continue; }
  drawings[id] = d;
  bytes += size;
}
const keywords = Object.fromEntries(Object.entries(DRAWINGS).filter(([, id]) => drawings[id]));
const peeps = PEEPS.filter((id) => drawings[id]);
if (skipped.length) console.log("skipped (over the byte cap):", skipped.join(", "));

const header = `// Generated by scripts/gen-kit-packset.mjs. Do not edit by hand.
//
// The AI composer's drawing pack: a curated slice of the bundled illustration
// packs (illlustrations.co, MIT; Lukasz Adam, Open Doodles and Open Peeps,
// CC0), each drawing baked as one compact path string per fill in its own
// tight box, transforms flattened and arcs converted to cubics at
// generation time. Colours are the pack's own; the composer places a drawing
// as a group of editable path nodes, in a halo, the way the signature
// templates do.

/** One layer of a drawing: its fill (empty for a stroke-only layer), its
 *  path (M/L/C/Z, absolute coordinates in the drawing's box), and optionally
 *  a stroke width, an opacity and a stroke colour. */
export type PackLayer = [string, string] | [string, string, number] | [string, string, number, number] | [string, string, number, number, string];

/** One drawing: its title, its box and its layers in paint order. */
export interface PackDrawing { title: string; w: number; h: number; layers: PackLayer[] }

export const PACK_DRAWINGS: Record<string, PackDrawing> = ${JSON.stringify(drawings)};

/** Keyword the outline may name -> drawing. Synonyms map onto one drawing. */
export const PACK_KEYWORDS: Record<string, string> = ${JSON.stringify(keywords)};

/** Drawn portraits for team and quote slots, in the order the composer
 *  cycles through them. */
export const PACK_PEEPS: string[] = ${JSON.stringify(peeps)};
`;
writeFileSync(OUT, header);
console.log(`wrote ${OUT}: ${Object.keys(drawings).length} drawings (${peeps.length} portraits), ${Object.keys(keywords).length} keywords, ${Math.round(bytes / 1024)} KB`);
