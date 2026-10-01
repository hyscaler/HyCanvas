// Bake the composer's illustration set from the bundled ManyPixels pack.
//
// The archetype composer runs in the browser and under goja, with no file
// system, no DOM and no SVG parser, so the illustrations it may place are
// compiled into a TypeScript module. Every drawing is stored as a compact
// string per fill: the path segments of every element carrying that fill,
// already flattened (the pack uses translate transforms only) and with every
// arc converted to cubics, so nothing is parsed or approximated at run time.
//
// The pack draws in one flat palette (a near-black line, white, two greys,
// and one cyan accent). The composer recolors by role, so a drawing takes the
// deck's ink and accent instead of the pack's, and reads as part of the deck.
//
// Run: node scripts/gen-deck-illustrations.mjs
//
// Source: ManyPixels illustrations (https://www.manypixels.co/gallery), MIT
// licence, from backend/internal/stock/library/manypixels.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packDir = resolve(root, "backend/internal/stock/library/manypixels");
const outFile = resolve(root, "packages/aistudio/src/illustrationset.ts");

// Keyword -> file. The keyword is what the outline prompt shows the model;
// synonyms map onto the same drawing. Chosen for what a deck talks about:
// growth, teams, plans, money, product, data, people, places.
// Keyword -> file. The keyword is what the outline prompt shows the model;
// synonyms map onto the same drawing. Curated to what a business deck talks
// about and to the pack's lighter drawings: every drawing here compiles to
// under thirty kilobytes of paths, so the whole set stays well under a megabyte in
// the composer bundle that ships inside the binary and the editor.
const ILLUSTRATIONS = {
  startup: "CampaignLaunch", launch: "CampaignLaunch", rocket: "CampaignLaunch", growth: "Growth", success: "Success", winner: "Winner", achievement: "Achievement",
  target: "Target", goal: "Target", progress: "Progress", plan: "Checklist", checklist: "Checklist", timeline: "Timeline", roadmap: "Timeline",
  team: "TeamWork", teamwork: "TeamWork", meeting: "TeamWork", presentation: "TeamPresentation", handshake: "Handshake", partnership: "Handshake",
  idea: "GreatIdea", innovation: "Innovation", brainstorm: "Brainstorming", thinking: "Thinking", problem: "ProblemSolving", question: "Question",
  analysis: "Analysis", analytics: "DataAnalytics", data: "DataVisualization", chart: "Chart", report: "ReportAnalysis", research: "Science",
  revenue: "Revenue", money: "Coins", finance: "PiggyBank", savings: "PiggyBank", payment: "OnlinePayment", wallet: "Wallet", investment: "Revenue",
  product: "UIDesign", design: "Designer", code: "Coding", software: "CodeDevelopment", app: "MobilePhone", website: "LandingPage",
  security: "Security", privacy: "Password", cloud: "DataStorage", storage: "DataStorage", server: "DataStorage",
  customer: "CustomerService", support: "CustomerService", chat: "Chat", email: "SendingEmails", marketing: "Marketing", campaign: "CampaignLaunch",
  shopping: "ShoppingCart", cart: "ShoppingCart", logistics: "Logistics", delivery: "Logistics", travel: "Traveling", map: "Map", navigation: "Navigation", city: "CityBuildings",
  health: "Health", doctor: "Doctor", fitness: "Fitness", food: "HealthyMeal", coffee: "Coffee",
  education: "OnlineLesson", learning: "Knowledge", teacher: "Teacher", book: "ReadingABook",
  ecology: "Ecology", nature: "WateringPlant", recycling: "Recycling", weather: "Weather", mountain: "Mountain",
  time: "Time", calendar: "Calendar", schedule: "Calendar", work: "OfficeWork", remote: "DigitalNomad", focus: "FocusedWorking",
  career: "Career", hiring: "JobInterview", manager: "Manager", celebration: "Party", vote: "Voting", voting: "Voting", election: "Voting", motivation: "Motivation",
  video: "VideoCall", podcast: "Podcast", quality: "QualityCheck", share: "Share", profile: "UserProfile",
};
const MAX_DRAWING_BYTES = 28 * 1024;

// --- SVG path -> cubic segments (same conversion as the icon generator) ------
function tokenize(d) { return d.match(/[a-zA-Z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) ?? []; }
function arcToCubics(p0, rx, ry, phiDeg, largeArc, sweep, p1) {
  if (p0.x === p1.x && p0.y === p1.y) return [];
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (rx === 0 || ry === 0) return [{ c1: p0, c2: p1, end: p1 }];
  const phi = (phiDeg * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2;
  const x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; }
  const sign = largeArc === sweep ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1, den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const coef = sign * Math.sqrt(Math.max(0, num / den));
  const cx1 = coef * ((rx * y1) / ry), cy1 = coef * (-(ry * x1) / rx);
  const cx = cos * cx1 - sin * cy1 + (p0.x + p1.x) / 2, cy = sin * cx1 + cos * cy1 + (p0.y + p1.y) / 2;
  const ang = (ux, uy, vx, vy) => { const dot = ux * vx + uy * vy, len = Math.hypot(ux, uy) * Math.hypot(vx, vy); let a = Math.acos(Math.min(1, Math.max(-1, dot / len))); if (ux * vy - uy * vx < 0) a = -a; return a; };
  const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI; else if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2))), step = dt / n, out = [];
  const pt = (t) => ({ x: cx + cos * rx * Math.cos(t) - sin * ry * Math.sin(t), y: cy + sin * rx * Math.cos(t) + cos * ry * Math.sin(t) });
  const dpt = (t) => ({ x: -cos * rx * Math.sin(t) - sin * ry * Math.cos(t), y: -sin * rx * Math.sin(t) + cos * ry * Math.cos(t) });
  for (let i = 0; i < n; i++) {
    const a = t1 + i * step, b = a + step, k = (4 / 3) * Math.tan((b - a) / 4), pa = pt(a), pb = pt(b), da = dpt(a), db = dpt(b);
    out.push({ c1: { x: pa.x + k * da.x, y: pa.y + k * da.y }, c2: { x: pb.x - k * db.x, y: pb.y - k * db.y }, end: i === n - 1 ? p1 : pb });
  }
  return out;
}
function parsePath(d, tx, ty) {
  const tokens = tokenize(d), contours = [];
  let cur = null, pos = { x: 0, y: 0 }, start = { x: 0, y: 0 }, i = 0, cmd = "", prevCubic = null, prevQuad = null;
  const num = () => Number(tokens[i++]);
  const begin = (p) => { cur = { segments: [{ x: p.x + tx, y: p.y + ty }], closed: false }; contours.push(cur); start = p; };
  const last = () => cur.segments[cur.segments.length - 1];
  const line = (p) => { cur.segments.push({ x: p.x + tx, y: p.y + ty }); pos = p; };
  const cubic = (c1, c2, e) => { last().cOut = { x: c1.x + tx, y: c1.y + ty }; cur.segments.push({ x: e.x + tx, y: e.y + ty, cIn: { x: c2.x + tx, y: c2.y + ty } }); pos = e; };
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
// Basic shapes as contours (the pack uses rect, circle, ellipse, polygon, line, polyline).
const K = 0.5522847498;
function ellipseContour(cx, cy, rx, ry) {
  const pts = [[cx + rx, cy], [cx, cy + ry], [cx - rx, cy], [cx, cy - ry]];
  const segs = pts.map(([x, y]) => ({ x, y }));
  const ctrl = [[[cx + rx, cy + ry * K], [cx + rx * K, cy + ry]], [[cx - rx * K, cy + ry], [cx - rx, cy + ry * K]], [[cx - rx, cy - ry * K], [cx - rx * K, cy - ry]], [[cx + rx * K, cy - ry], [cx + rx, cy - ry * K]]];
  for (let i = 0; i < 4; i++) { segs[i].cOut = { x: ctrl[i][0][0], y: ctrl[i][0][1] }; segs[(i + 1) % 4].cIn = { x: ctrl[i][1][0], y: ctrl[i][1][1] }; }
  return { segments: segs, closed: true };
}

// --- element scan (flat, with accumulated translate) --------------------------
const attr = (tag, name) => { const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag); return m ? m[1] : undefined; };
const translateOf = (tag) => { const t = attr(tag, "transform"); const m = t && /translate\(\s*([-\d.eE]+)[\s,]*([-\d.eE]*)\s*\)/.exec(t); return m ? { x: Number(m[1]), y: Number(m[2] || 0) } : { x: 0, y: 0 }; };

function extract(svg) {
  // Walk tags in order, tracking <g translate> nesting.
  const re = /<(\/?)([a-zA-Z]+)\b([^>]*?)(\/?)>/g;
  const stack = [{ x: 0, y: 0 }];
  const byFill = new Map(); // fill -> contours[]
  let m;
  while ((m = re.exec(svg))) {
    const [, close, name, rest, selfClose] = m;
    if (name === "g") {
      if (close) stack.pop(); else if (!selfClose) { const t = translateOf(rest), p = stack[stack.length - 1]; stack.push({ x: p.x + t.x, y: p.y + t.y }); }
      continue;
    }
    if (close) continue;
    const tag = rest;
    const fill = (attr(tag, "fill") ?? "").toLowerCase();
    if (fill === "none") continue;
    const stroke = attr(tag, "stroke");
    const p = stack[stack.length - 1], t = translateOf(tag), tx = p.x + t.x, ty = p.y + t.y;
    let contours = [];
    const n = (k, d = 0) => { const v = attr(tag, k); return v === undefined ? d : Number(v); };
    switch (name) {
      case "path": { const d = attr(tag, "d"); if (d) contours = parsePath(d, tx, ty); break; }
      case "rect": { const x = n("x") + tx, y = n("y") + ty, w = n("width"), h = n("height"); if (w > 0 && h > 0) contours = [{ segments: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }], closed: true }]; break; }
      case "circle": { const r = n("r"); if (r > 0) contours = [ellipseContour(n("cx") + tx, n("cy") + ty, r, r)]; break; }
      case "ellipse": { const rx = n("rx"), ry = n("ry"); if (rx > 0 && ry > 0) contours = [ellipseContour(n("cx") + tx, n("cy") + ty, rx, ry)]; break; }
      case "polygon": case "polyline": { const pts = (attr(tag, "points") ?? "").trim().split(/[\s,]+/).map(Number); const segs = []; for (let i = 0; i + 1 < pts.length; i += 2) segs.push({ x: pts[i] + tx, y: pts[i + 1] + ty }); if (segs.length >= 2) contours = [{ segments: segs, closed: name === "polygon" }]; break; }
      case "line": { if (stroke) { contours = [{ segments: [{ x: n("x1") + tx, y: n("y1") + ty }, { x: n("x2") + tx, y: n("y2") + ty }], closed: false, strokeOnly: true }]; } break; }
      default: continue;
    }
    if (!contours.length) continue;
    // A stroked line has no fill; it is drawn as a thin stroke in the line ink.
    const key = contours[0].strokeOnly ? "stroke:" + (stroke ?? "#231f20").toLowerCase() : fill || "#231f20";
    if (!byFill.has(key)) byFill.set(key, []);
    byFill.get(key).push(...contours);
  }
  return byFill;
}

// --- compact encoding: one string per fill --------------------------------------
// Segments: "M x y" begins a contour, "L x y" a line, "C c1x c1y c2x c2y x y" a
// cubic, "Z" closes. Numbers to 2 decimals, leading zeros and trailing zeros
// dropped, the way an SVG path is written, so the run-time decoder is small.
const f2 = (n) => { const s = (Math.round(n * 10) / 10).toString(); return s.replace(/^(-?)0\./, "$1."); };
function encode(contours) {
  let out = "";
  for (const c of contours) {
    const s = c.segments;
    out += `M${f2(s[0].x)} ${f2(s[0].y)}`;
    for (let i = 1; i < s.length; i++) {
      const a = s[i - 1], b = s[i];
      if (a.cOut || b.cIn) { const c1 = a.cOut ?? { x: a.x, y: a.y }, c2 = b.cIn ?? { x: b.x, y: b.y }; out += `C${f2(c1.x)} ${f2(c1.y)} ${f2(c2.x)} ${f2(c2.y)} ${f2(b.x)} ${f2(b.y)}`; }
      else out += `L${f2(b.x)} ${f2(b.y)}`;
    }
    if (c.closed) { const a = s[s.length - 1], b = s[0]; if (a.cOut || b.cIn) { const c1 = a.cOut ?? { x: a.x, y: a.y }, c2 = b.cIn ?? { x: b.x, y: b.y }; out += `C${f2(c1.x)} ${f2(c1.y)} ${f2(c2.x)} ${f2(c2.y)} ${f2(b.x)} ${f2(b.y)}`; } out += "Z"; }
  }
  return out;
}

// The pack's palette by role. Anything else is kept as its own hex.
const ROLE = { "#231f20": "line", "#fff": "white", "#ffffff": "white", "#d1d3d4": "grey", "#e6e7e8": "grey2", "#68e1fd": "accent", "#939598": "grey3", "#f1f2f2": "white", "#fdffff": "white" };

const files = Array.from(new Set(Object.values(ILLUSTRATIONS))).sort();
const drawings = {};
const skipped = [];
const backdrops = [];
let bytes = 0;
for (const f of files) {
  const svg = readFileSync(resolve(packDir, `${f}.svg`), "utf8");
  const vb = /viewBox="([^"]+)"/.exec(svg)[1].split(/\s+/).map(Number);
  const byFill = extract(svg);
  const layers = [];
  // A contour that lies wholly outside the drawing's box is a scrap the
  // pack's own viewBox clips away; on a slide it would show as a stray mark.
  const inBox = (c) => c.segments.some((sg) => sg.x >= -1 && sg.y >= -1 && sg.x <= vb[2] + 1 && sg.y <= vb[3] + 1);
  // A contour that spans most of the box (seven tenths of both sides) is the
  // drawing's own backdrop, the inset card some scenes sit on, or the outline
  // of that card. On a slide the page is the backdrop, and a recolored card
  // with an outline reads as a framed picture, so it is dropped in every
  // role. No figure in the pack comes near that size.
  const backdrop = (c) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const sg of c.segments) { x0 = Math.min(x0, sg.x); y0 = Math.min(y0, sg.y); x1 = Math.max(x1, sg.x); y1 = Math.max(y1, sg.y); }
    return x1 - x0 >= vb[2] * 0.7 && y1 - y0 >= vb[3] * 0.7;
  };
  for (const [key, contours] of byFill) {
    const strokeOnly = key.startsWith("stroke:");
    const hex = strokeOnly ? key.slice(7) : key;
    const role = ROLE[hex] ?? hex;
    const kept = contours.filter((c) => inBox(c) && !backdrop(c));
    const dropped = contours.length - kept.length - contours.filter((c) => !inBox(c)).length;
    if (dropped > 0) backdrops.push(`${f}:${strokeOnly ? "stroke" : role} x${dropped}`);
    if (!kept.length) continue;
    layers.push([strokeOnly ? "stroke" : role, encode(kept)]);
  }
  const drawing = { w: vb[2], h: vb[3], layers };
  const size = JSON.stringify(drawing).length;
  if (size > MAX_DRAWING_BYTES) { skipped.push(`${f} (${Math.round(size / 1024)} KB)`); continue; }
  drawings[f] = drawing;
  bytes += size;
}
const keywords = Object.fromEntries(Object.entries(ILLUSTRATIONS).filter(([, f]) => drawings[f]));
if (skipped.length) console.log("skipped (over the byte cap):", skipped.join(", "));
if (backdrops.length) console.log("backdrop contours dropped:", backdrops.join(", "));

const header = `// Generated by scripts/gen-deck-illustrations.mjs. Do not edit by hand.
//
// The composer's illustration set: a curated slice of the ManyPixels pack
// (MIT licence, https://www.manypixels.co/gallery), each drawing baked as
// one path string per fill role in the pack's own 400 x 300 space, with its
// group transforms flattened and every arc converted to cubics at generation
// time. The composer decodes a drawing into path nodes when it places it and
// recolors the roles (line, accent, greys) to the deck's own system, so the
// drawing reads as part of the deck rather than as clip art.

/** One drawing: its box and its layers in paint order, each a fill role
 *  ("line", "white", "grey", "grey2", "grey3", "accent", "stroke", or a hex)
 *  and a compact path string (M/L/C/Z with absolute coordinates). */
export interface IllustrationDrawing { w: number; h: number; layers: [string, string][] }

export const ILLUSTRATIONS: Record<string, IllustrationDrawing> = ${JSON.stringify(drawings)};

/** Keyword the outline may name -> drawing. Synonyms map onto one drawing so
 *  a model that writes "partnership" or "finance" still gets a picture. */
export const ILLUSTRATION_KEYWORDS: Record<string, string> = ${JSON.stringify(keywords)};
`;
writeFileSync(outFile, header);
console.log(`wrote ${outFile}: ${Object.keys(drawings).length} drawings, ${Object.keys(keywords).length} keywords, ${Math.round(bytes / 1024)} KB of paths`);
