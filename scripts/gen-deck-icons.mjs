// Bake the composer's icon set from the bundled Tabler filled pack.
//
// The archetype composer runs in the browser and under goja, with no file
// system and no DOM, so the icons it may place are compiled into a TypeScript
// module as path contours in the pack's own 24x24 space. This script reads
// the chosen SVGs, converts every command (arcs included, as cubics) into the
// schema's path segments, and writes packages/aistudio/src/iconset.ts.
//
// Run: node scripts/gen-deck-icons.mjs
//
// Source: Tabler Icons (https://tabler.io/icons), MIT licence, from
// backend/internal/stock/library/tabler-filled.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packDir = resolve(root, "backend/internal/stock/library/tabler-filled");
const outFile = resolve(root, "packages/aistudio/src/iconset.ts");

// Keyword -> Tabler file. The keyword is what the outline prompt shows the
// model; synonyms below map other words the model is likely to use onto the
// same file. Every file here exists in the filled pack.
const ICONS = {
  shield: "shield", clock: "clock", user: "user", team: "user", chart: "chart-pie", idea: "bulb", bulb: "bulb",
  leaf: "leaf", globe: "world", world: "world", pin: "map-pin", home: "home", heart: "heart", star: "star",
  check: "circle-check", warning: "alert-triangle", lock: "lock", key: "key", coin: "coin", card: "credit-card",
  cart: "shopping-cart", truck: "truck", plane: "plane", calendar: "calendar", mail: "mail", phone: "phone",
  message: "message", cloud: "cloud", database: "database", settings: "settings", book: "book", school: "school",
  briefcase: "briefcase", flask: "flask", sun: "sun", moon: "moon", droplet: "droplet", flame: "flame", bolt: "bolt",
  trophy: "trophy", flag: "flag", compass: "compass", scale: "scale", thumb: "thumb-up", camera: "camera",
  palette: "palette", pencil: "pencil", puzzle: "puzzle", link: "link", search: "search", filter: "filter",
  gift: "gift", eye: "eye", bell: "bell", bookmark: "bookmark", clipboard: "clipboard", file: "file", folder: "folder",
  gauge: "gauge", headphones: "headphones", microphone: "microphone", award: "award", crown: "crown",
  diamond: "diamond", car: "car", bus: "bus", bike: "bike", umbrella: "umbrella", seedling: "seedling",
  flower: "flower", mountain: "mountain", graph: "graph", presentation: "presentation", receipt: "receipt",
  calculator: "calculator", tag: "tag", badge: "badge", rosette: "rosette", pill: "pill", lungs: "lungs", bug: "bug",
  mobile: "device-mobile", desktop: "device-desktop", keyboard: "keyboard", ticket: "ticket", bed: "bed",
  dashboard: "dashboard", engine: "engine", train: "train", boat: "speedboat", hourglass: "hourglass",
  sparkles: "sparkles", confetti: "confetti", balloon: "balloon", paw: "paw", apple: "apple", pizza: "pizza",
  egg: "egg", chef: "chef-hat", battery: "battery", satellite: "satellite", zoom: "zoom", basket: "basket",
  hexagon: "hexagon", square: "square", triangle: "triangle", circle: "circle", play: "player-play", video: "video",
  photo: "photo", table: "table", list: "layout-list", grid: "layout-grid", analytics: "report-analytics",
  report: "file-analytics", document: "file-text", medal: "award", target: "circle-dot", rocket: "sparkles",
  building: "home-2", tree: "leaf", users: "user", people: "user", money: "coin", cash: "coin", growth: "graph",
  trend: "graph", time: "clock", speed: "gauge", security: "shield", safety: "shield", quality: "rosette",
  location: "map-pin", map: "map-pin", energy: "bolt", power: "bolt", water: "droplet", fire: "flame",
  nature: "leaf", planet: "world", health: "heart", medical: "pill", science: "flask", education: "school",
  learning: "book", work: "briefcase", business: "briefcase", finance: "coin", payment: "credit-card",
  shopping: "shopping-cart", delivery: "truck", travel: "plane", schedule: "calendar", email: "mail",
  chat: "message", storage: "database", data: "database", config: "settings", gear: "settings", tool: "settings",
  weather: "sun", night: "moon", win: "trophy", goal: "flag", direction: "compass", balance: "scale",
  like: "thumb-up", design: "palette", edit: "pencil", solution: "puzzle", connect: "link", discover: "search",
  reward: "gift", vision: "eye", alert: "bell", notice: "bell", save: "bookmark", task: "clipboard", docs: "file",
  files: "folder", audio: "headphones", voice: "microphone", premium: "crown", luxury: "diamond", transport: "car",
  protection: "umbrella", plant: "seedling", bloom: "flower", summit: "mountain", stats: "graph", pitch: "presentation",
  invoice: "receipt", math: "calculator", label: "tag", certified: "badge", medicine: "pill", breath: "lungs",
  issue: "bug", app: "device-mobile", computer: "device-desktop", typing: "keyboard", event: "ticket", sleep: "bed",
  metrics: "dashboard", motor: "engine", rail: "train", sail: "speedboat", wait: "hourglass", magic: "sparkles",
  party: "confetti", celebrate: "balloon", pet: "paw", food: "apple", meal: "pizza", cook: "chef-hat",
  charge: "battery", space: "satellite", focus: "zoom", groceries: "basket",
};

// --- SVG path -> cubic segments ------------------------------------------

function tokenize(d) {
  return d.match(/[a-zA-Z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) ?? [];
}

// Endpoint arc -> centre parameterization -> cubics of at most 90 degrees.
// Straight from the SVG implementation notes (F.6.5, F.6.6).
function arcToCubics(p0, rx, ry, phiDeg, largeArc, sweep, p1) {
  if (p0.x === p1.x && p0.y === p1.y) return [];
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (rx === 0 || ry === 0) return [{ c1: p0, c2: p1, end: p1 }];
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2;
  const x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; }
  const sign = largeArc === sweep ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const coef = sign * Math.sqrt(Math.max(0, num / den));
  const cx1 = coef * ((rx * y1) / ry), cy1 = coef * (-(ry * x1) / rx);
  const cx = cos * cx1 - sin * cy1 + (p0.x + p1.x) / 2;
  const cy = sin * cx1 + cos * cy1 + (p0.y + p1.y) / 2;
  const ang = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy, len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2)));
  const step = dt / n;
  const out = [];
  const pt = (t) => ({ x: cx + cos * rx * Math.cos(t) - sin * ry * Math.sin(t), y: cy + sin * rx * Math.cos(t) + cos * ry * Math.sin(t) });
  const dpt = (t) => ({ x: -cos * rx * Math.sin(t) - sin * ry * Math.cos(t), y: -sin * rx * Math.sin(t) + cos * ry * Math.cos(t) });
  for (let i = 0; i < n; i++) {
    const a = t1 + i * step, b = a + step;
    const k = (4 / 3) * Math.tan((b - a) / 4);
    const pa = pt(a), pb = pt(b), da = dpt(a), db = dpt(b);
    out.push({ c1: { x: pa.x + k * da.x, y: pa.y + k * da.y }, c2: { x: pb.x - k * db.x, y: pb.y - k * db.y }, end: i === n - 1 ? p1 : pb });
  }
  return out;
}

function parsePath(d) {
  const tokens = tokenize(d);
  const contours = [];
  let cur = null, pos = { x: 0, y: 0 }, start = { x: 0, y: 0 }, i = 0, cmd = "", prevCubic = null, prevQuad = null;
  const num = () => Number(tokens[i++]);
  const begin = (p) => { cur = { segments: [{ x: p.x, y: p.y }], closed: false }; contours.push(cur); start = p; };
  const last = () => cur.segments[cur.segments.length - 1];
  const line = (p) => { cur.segments.push({ x: p.x, y: p.y }); pos = p; };
  const cubic = (c1, c2, end) => { last().cOut = c1; cur.segments.push({ x: end.x, y: end.y, cIn: c2 }); pos = end; };
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[a-zA-Z]$/.test(t)) { cmd = t; i++; if (cmd === "Z" || cmd === "z") { if (cur) cur.closed = true; pos = { ...start }; prevCubic = prevQuad = null; continue; } }
    const rel = cmd === cmd.toLowerCase();
    const R = (x, y) => (rel ? { x: pos.x + x, y: pos.y + y } : { x, y });
    switch (cmd.toUpperCase()) {
      case "M": { const p = R(num(), num()); begin(p); pos = p; cmd = rel ? "l" : "L"; prevCubic = prevQuad = null; break; }
      case "L": { line(R(num(), num())); prevCubic = prevQuad = null; break; }
      case "H": { const x = num(); line({ x: rel ? pos.x + x : x, y: pos.y }); prevCubic = prevQuad = null; break; }
      case "V": { const y = num(); line({ x: pos.x, y: rel ? pos.y + y : y }); prevCubic = prevQuad = null; break; }
      case "C": { const c1 = R(num(), num()), c2 = R(num(), num()), e = R(num(), num()); cubic(c1, c2, e); prevCubic = c2; prevQuad = null; break; }
      case "S": { const c1 = prevCubic ? { x: 2 * pos.x - prevCubic.x, y: 2 * pos.y - prevCubic.y } : { ...pos }; const c2 = R(num(), num()), e = R(num(), num()); cubic(c1, c2, e); prevCubic = c2; prevQuad = null; break; }
      case "Q": { const q = R(num(), num()), e = R(num(), num()); const c1 = { x: pos.x + (2 / 3) * (q.x - pos.x), y: pos.y + (2 / 3) * (q.y - pos.y) }, c2 = { x: e.x + (2 / 3) * (q.x - e.x), y: e.y + (2 / 3) * (q.y - e.y) }; cubic(c1, c2, e); prevQuad = q; prevCubic = null; break; }
      case "T": { const q = prevQuad ? { x: 2 * pos.x - prevQuad.x, y: 2 * pos.y - prevQuad.y } : { ...pos }; const e = R(num(), num()); const c1 = { x: pos.x + (2 / 3) * (q.x - pos.x), y: pos.y + (2 / 3) * (q.y - pos.y) }, c2 = { x: e.x + (2 / 3) * (q.x - e.x), y: e.y + (2 / 3) * (q.y - e.y) }; cubic(c1, c2, e); prevQuad = q; prevCubic = null; break; }
      case "A": { const rx = num(), ry = num(), phi = num(), large = num() !== 0, sweep = num() !== 0; const e = R(num(), num()); for (const s of arcToCubics(pos, rx, ry, phi, large, sweep, e)) cubic(s.c1, s.c2, s.end); prevCubic = prevQuad = null; break; }
      default: i++;
    }
  }
  return contours.filter((c) => c.segments.length >= 2);
}

const r3 = (n) => Math.round(n * 1000) / 1000;
const seg = (s) => {
  const o = { x: r3(s.x), y: r3(s.y) };
  if (s.cIn) o.cIn = { x: r3(s.cIn.x), y: r3(s.cIn.y) };
  if (s.cOut) o.cOut = { x: r3(s.cOut.x), y: r3(s.cOut.y) };
  return o;
};

const files = Array.from(new Set(Object.values(ICONS))).sort();
const glyphs = {};
for (const f of files) {
  const svg = readFileSync(resolve(packDir, `${f}.svg`), "utf8");
  const ds = [...svg.matchAll(/<path\b([^>]*)\/?>/g)]
    .filter((m) => !/fill="none"/.test(m[1]))
    .map((m) => /\sd="([^"]+)"/.exec(m[1])?.[1])
    .filter(Boolean);
  const contours = ds.flatMap(parsePath).map((c) => ({ segments: c.segments.map(seg), closed: c.closed }));
  if (!contours.length) throw new Error(`${f}: no filled path`);
  glyphs[f] = contours;
}

const header = `// Generated by scripts/gen-deck-icons.mjs. Do not edit by hand.
//
// The composer's icon set: a curated slice of Tabler Icons (MIT licence,
// https://tabler.io/icons), each baked as path contours in the pack's own
// 24 x 24 space so the composer can place an icon in the browser and under
// goja with no file system, no DOM and no parsing at run time. Arcs were
// converted to cubics at generation time, so the geometry is exact.

import type { PathContour } from "@hc/schema";

/** Contours per glyph file, in a 24 x 24 box, filled under the even-odd rule
 *  (interior contours cut holes). */
export const ICON_GLYPHS: Record<string, PathContour[]> = ${JSON.stringify(glyphs)};

/** Keyword the outline may name -> glyph. Synonyms map onto the same glyph so
 *  a model that writes "security" or "finance" still gets a picture. */
export const ICON_KEYWORDS: Record<string, string> = ${JSON.stringify(ICONS)};

/** The glyph box every ICON_GLYPHS contour is drawn in. */
export const ICON_BOX = 24;
`;
writeFileSync(outFile, header);
console.log(`wrote ${outFile}: ${files.length} glyphs, ${Object.keys(ICONS).length} keywords`);
