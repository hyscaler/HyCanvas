// Compile compact template specs (scripts/templates/*.json) into the embedded
// template seed (backend/internal/templates/seed.json). The specs are the
// source of truth: hex colors, plain text blocks and button primitives compile
// deterministically into schema-valid design files, so template authors never
// hand-write srgb runs or worry about optically centering a CTA label.
//
//   node scripts/build-templates.mjs            # compile + validate + write seed
//   node scripts/build-templates.mjs --check    # compile + validate only
//
// Validation: every compiled file passes @hc/schema validate() (build the
// packages first), node ids are unique, and all geometry sits inside the page
// unless the node opts into bleed ("bleed": true).

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// TEMPLATE_SPECS / TEMPLATE_SEED override the spec dir and output (used by the
// authoring pipeline to compile candidate specs to a scratch seed for review).
const SPEC_DIR = process.env.TEMPLATE_SPECS || join(ROOT, "scripts", "templates");
const SEED = process.env.TEMPLATE_SEED || join(ROOT, "backend", "internal", "templates", "seed.json");
const { validate, createNode } = await import(join(ROOT, "packages", "schema", "dist", "index.js"));
const { composeDeckFile } = await import(join(ROOT, "packages", "aistudio", "dist", "index.js"));
const { svgToNodes } = await import(join(ROOT, "packages", "stock", "dist", "index.js"));

// Bundled illustration packs (for "illustrations" page entries): asset id ->
// pack dir, svg file, title, and the pack license for provenance stamping.
const LIBRARY = join(ROOT, "backend", "internal", "stock", "library");
const STOCK = (() => {
  const m = new Map();
  for (const pack of ["illlustrations", "lukaszadam", "opendoodles", "openpeeps"]) {
    const idx = JSON.parse(readFileSync(join(LIBRARY, pack, "index.json"), "utf8"));
    for (const a of idx.assets) m.set(a.id, { pack, file: a.file, title: a.title, license: idx.license });
  }
  return m;
})();

// --- primitives ------------------------------------------------------------

function srgb(hex) {
  const h = hex.replace("#", "");
  // Alpha hex is rejected (see lint below): translucency comes from node
  // opacity, which every renderer applies; per-color alpha does not.
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  const n = (i) => parseInt(full.slice(i, i + 2), 16) / 255;
  return { srgb: { r: n(0), g: n(2), b: n(4), a: 1 } };
}

const isAlphaHex = (c) => typeof c === "string" && c.replace("#", "").length === 8;

/** Palette entries must be 6-digit hex: the backend's colorMatches parses them. */
function hex6(hex) {
  const h = hex.replace("#", "");
  return "#" + (h.length === 3 ? [...h].map((c) => c + c).join("") : h.slice(0, 6)).toLowerCase();
}

function fillOf(f) {
  if (typeof f === "string") return { type: "solid", color: srgb(f) };
  // { angle, stops: [["#hex", position], ...], radial?: true }
  return {
    type: "gradient",
    gradient: f.radial ? "radial" : "linear",
    angle: f.angle ?? 90,
    stops: f.stops.map(([hex, position]) => ({ position, color: srgb(hex) })),
  };
}

const radius = (r) => ({ topLeft: r, topRight: r, bottomRight: r, bottomLeft: r });

function baseNode(id, n) {
  return {
    id,
    transform: { x: n.x, y: n.y, scaleX: 1, scaleY: 1, rotation: n.rotation ?? 0 },
    size: { width: n.w, height: n.h },
    opacity: n.opacity ?? 1,
    blendMode: "normal",
  };
}

function shapeNode(id, n, shape) {
  const out = { ...baseNode(id, n), type: "shape", shape, fills: n.fill === undefined ? [] : [fillOf(n.fill)] };
  if (n.radius) out.cornerRadius = radius(n.radius);
  if (n.stroke) out.strokes = [{ ...fillOf(n.stroke), width: n.strokeWidth ?? 2 }];
  return out;
}

function textNode(id, n) {
  const style = {
    fontFamily: n.family,
    fontStyle: "Regular",
    fontSize: n.size,
    axes: { wght: n.weight ?? 400 },
    fill: fillOf(n.color ?? "#111111"),
  };
  if (n.letterSpacing) style.letterSpacing = n.letterSpacing;
  if (n.upper) style.case = "upper";
  if (n.lineHeight) style.lineHeight = { mode: "multiple", value: n.lineHeight };
  // "spans" mixes styles within one line (e.g. an accent-colored word);
  // otherwise "text" splits on newlines into single-style paragraphs.
  const paragraphs = n.spans
    ? [{
        runs: n.spans.map((sp) => ({
          text: sp.text,
          style: { ...style, ...(sp.color ? { fill: fillOf(sp.color) } : {}), ...(sp.weight ? { axes: { wght: sp.weight } } : {}) },
        })),
        style: { align: n.align ?? "left", direction: "auto" },
      }]
    : String(n.text).split("\n").map((line) => ({
        runs: [{ text: line, style }],
        style: { align: n.align ?? "left", direction: "auto" },
      }));
  return {
    ...baseNode(id, n),
    type: "text",
    box: {
      mode: "fixed",
      width: n.w,
      height: n.h,
      autoFit: { enabled: false, min: 8, max: 512 },
      verticalAlign: n.vAlign ?? "top",
    },
    content: paragraphs,
  };
}

/** A button compiles to a pill rect + a label the box centers both ways, so
 *  the label cannot drift off-center the way hand-placed CTA text does. */
function buttonNodes(id, n) {
  const rect = shapeNode(id + "-bg", { ...n, fill: n.fill, radius: n.radius ?? n.h / 2 }, "rect");
  const label = textNode(id + "-label", {
    x: n.x, y: n.y, w: n.w, h: n.h,
    text: n.label, family: n.family, size: n.size ?? 28, weight: n.weight ?? 700,
    color: n.color, align: "center", vAlign: "middle",
    letterSpacing: n.letterSpacing, upper: n.upper,
  });
  return [rect, label];
}

// --- illustrations -----------------------------------------------------------

// True bounds from path geometry (converted paths keep transform at 0,0).
function nodeBBox(n) {
  if (n.segments?.length) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of n.segments) for (const p of [s, s.cIn, s.cOut]) if (p) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    return { x0, y0, x1, y1 };
  }
  const x = n.transform?.x ?? 0, y = n.transform?.y ?? 0;
  return { x0: x, y0: y, x1: x + (n.size?.width ?? 0), y1: y + (n.size?.height ?? 0) };
}

const roundTo = (v, p) => Math.round(v * p) / p;
function roundDeep(v, k) {
  if (typeof v === "number") return roundTo(v, k === "r" || k === "g" || k === "b" || k === "a" ? 1e4 : 1e2);
  if (Array.isArray(v)) return v.map((x) => roundDeep(x, k));
  if (v && typeof v === "object") { const o = {}; for (const [kk, vv] of Object.entries(v)) o[kk] = roundDeep(vv, kk); return o; }
  return v;
}

/** Compile one page-level illustration entry into an editable vector group,
 *  provenance-stamped like an editor stock insert. illlustrations-pack assets
 *  get their baked bottom-strip credit marks stripped, and optionally the
 *  baked background card too (cleanCard), refitting to the remaining art. */
function illustrationGroup(specId, k, il, pageW, pageH, errors) {
  const asset = STOCK.get(il.asset);
  if (!asset) { errors.push(`${specId} il${k}: unknown illustration asset ${il.asset}`); return null; }
  const cx = il.x + il.w / 2, cy = il.y + il.h / 2;
  if (cx < 0 || cy < 0 || cx > pageW || cy > pageH) { errors.push(`${specId} il${k}: center off page`); return null; }
  const svg = readFileSync(join(LIBRARY, asset.pack, asset.file), "utf8");
  let i = 0;
  let { nodes } = svgToNodes(svg, () => `${specId}-il${k}-n${++i}`);
  if (!nodes.length) { errors.push(`${specId} il${k}: empty svg parse`); return null; }
  const vb = /viewBox\s*=\s*"([^"]+)"/i.exec(svg)?.[1]?.trim().split(/[\s,]+/).map(Number);
  const vbW = (vb && vb[2]) || 200, vbH = (vb && vb[3]) || 200;
  let bx = 0, by = 0, bw = vbW, bh = vbH;
  if (asset.pack === "illlustrations") {
    nodes = nodes.filter((n) => {
      const b = nodeBBox(n);
      if (b.y0 > 0.86 * vbH) return false; // bottom-strip credit marks
      if (il.cleanCard && (b.x1 - b.x0) > 0.85 * vbW && (b.y1 - b.y0) > 0.85 * vbH) return false; // baked card
      return true;
    });
    if (!nodes.length) { errors.push(`${specId} il${k}: nothing left after cleaning`); return null; }
    if (il.cleanCard) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const n of nodes) { const b = nodeBBox(n); x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1); }
      bx = x0; by = y0; bw = x1 - x0; bh = y1 - y0;
    }
  }
  const s = Math.min(il.w / bw, il.h / bh);
  return roundDeep(createNode("group", {
    id: `${specId}-il${k}`,
    name: asset.title,
    children: nodes,
    transform: { x: il.x + (il.w - bw * s) / 2 - bx * s, y: il.y + (il.h - bh * s) / 2 - by * s, scaleX: s, scaleY: s, rotation: il.rotation ?? 0 },
    size: { width: bw, height: bh },
    ...(il.opacity !== undefined && il.opacity !== 1 ? { opacity: il.opacity } : {}),
    data: { provenance: { origin: "stock", stockAssetId: il.asset, license: asset.license } },
  }), "");
}

// --- compile one spec --------------------------------------------------------

function compile(spec) {
  const errors = [];
  let ilCount = 0; // illustration ids are numbered across the whole template
  const pages = spec.pages.map((p, pi) => {
    const children = [];
    (p.nodes ?? []).forEach((n, ni) => {
      const id = `${spec.id}-p${pi}-n${ni}`;
      if (n.kind === "rect") children.push(shapeNode(id, n, "rect"));
      else if (n.kind === "ellipse") children.push(shapeNode(id, n, "ellipse"));
      else if (n.kind === "text") children.push(textNode(id, n));
      else if (n.kind === "button") children.push(...buttonNodes(id, n));
      else if (n.kind === "frame") children.push({ ...baseNode(id, n), type: "frame", ...(n.fill ? { fills: [fillOf(n.fill)] } : {}) });
      else errors.push(`${spec.id} p${pi} n${ni}: unknown kind ${n.kind}`);
      // Alpha-hex lint: 8-digit colors silently lose their alpha; authors must
      // use node opacity for translucency.
      for (const c of [n.fill, n.color, n.stroke]) {
        if (isAlphaHex(c)) errors.push(`${spec.id} p${pi} n${ni}: alpha hex ${c}; use "opacity" on the node instead`);
        if (c && typeof c === "object") for (const [hex] of c.stops ?? []) {
          if (isAlphaHex(hex)) errors.push(`${spec.id} p${pi} n${ni}: alpha hex ${hex} in gradient; use node "opacity"`);
        }
      }
      // Geometry lint: everything stays on the page unless it declares bleed.
      if (!n.bleed) {
        const pad = 1;
        if (n.x < -pad || n.y < -pad || n.x + n.w > spec.size[0] + pad || n.y + n.h > spec.size[1] + pad) {
          errors.push(`${spec.id} p${pi} n${ni} (${n.kind}) out of bounds: ${n.x},${n.y} ${n.w}x${n.h}`);
        }
      }
    });
    const all = typeof p.bg === "object"
      ? [shapeNode(`${spec.id}-p${pi}-bg`, { x: 0, y: 0, w: spec.size[0], h: spec.size[1], fill: p.bg, bleed: true }, "rect"), ...children]
      : children;
    // Illustrations land after every primitive so "after:<nodeId>" anchors
    // resolve; "bottom" sits under everything, "top" (default) over.
    (p.illustrations ?? []).forEach((il) => {
      const g = illustrationGroup(spec.id, ilCount++, il, spec.size[0], spec.size[1], errors);
      if (!g) return;
      if (il.position === "bottom") all.unshift(g);
      else if (typeof il.position === "string" && il.position.startsWith("after:")) {
        const at = all.findIndex((n) => n.id === il.position.slice(6));
        if (at < 0) { errors.push(`${spec.id} p${pi} il${k}: anchor ${il.position} not found`); return; }
        all.splice(at + 1, 0, g);
      } else all.push(g);
    });
    return {
      id: `${spec.id}-page-${pi}`,
      name: p.name ?? `Page ${pi + 1}`,
      width: spec.size[0],
      height: spec.size[1],
      background: { type: "solid", color: srgb(typeof p.bg === "string" ? p.bg : "#ffffff") },
      children: all,
    };
  });

  const file = {
    id: `tpl-${spec.id}`,
    title: spec.title,
    schemaVersion: 10,
    format: "hycanvas.design",
    unit: "px",
    dpi: 96,
    fonts: [],
    assets: [],
    meta: {},
    pages,
  };

  // Palette: distinct solid hexes in author order, capped at 6.
  const palette = [];
  const seen = new Set();
  const push = (c) => { const h = hex6(c); if (!seen.has(h)) { seen.add(h); palette.push(h); } };
  for (const p of spec.pages) {
    if (typeof p.bg === "string") push(p.bg);
    if (p.bg && typeof p.bg === "object") for (const [hex] of p.bg.stops ?? []) push(hex);
    for (const n of p.nodes ?? []) {
      for (const c of [n.fill, n.color]) {
        if (typeof c === "string") push(c);
        if (c && typeof c === "object") for (const [hex] of c.stops ?? []) push(hex);
      }
    }
  }

  const template = {
    id: spec.id,
    title: spec.title,
    ownerId: "hycanvas",
    workspaceId: null,
    visibility: "public",
    categories: spec.categories,
    tags: spec.tags,
    style: { palette: palette.slice(0, 6), typography: spec.typography ?? [], styleTags: spec.styleTags ?? [] },
    format: { width: spec.size[0], height: spec.size[1], unit: "px" },
    pageCount: pages.length,
    previewUrls: [],
    fillableFields: (spec.fillable ?? []).map(({ node, ...rest }) => ({ nodeId: `${spec.id}-${node}`, ...rest })),
    attributions: [],
    version: spec.version ?? 1,
    createdAt: spec.created ?? "2026-07-04T00:00:00.000Z",
    updatedAt: spec.updated ?? spec.created ?? "2026-07-04T00:00:00.000Z",
    designFileKey: `seed:${spec.id}`,
  };
  return { entry: { template, file }, errors };
}

// --- deck-outline dialect (F40 E11) ------------------------------------------
// A presentation template authored THROUGH the product: a hand-written outline
// plus a catalog themeId, composed into a full design by the exact pipeline
// the generation API runs (composeDeckFile). Deterministic: node ids come from
// a counter shim installed around the compose (the same contract as the goja
// composer), so regenerating the seed never churns ids.

function compileDeckOutline(spec) {
  const errors = [];
  if (!spec.outline?.pages?.length) errors.push(`${spec.id}: outline.pages is required`);
  if (!spec.themeId) errors.push(`${spec.id}: themeId is required`);
  const prevCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  let uuidSeq = 0;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { randomUUID: () => `n-${++uuidSeq}` },
  });
  let file;
  try {
    file = composeDeckFile({
      outline: spec.outline,
      width: spec.size?.[0] ?? 1920,
      height: spec.size?.[1] ?? 1080,
      themeId: spec.themeId,
    });
  } catch (e) {
    errors.push(`${spec.id}: compose failed: ${e.message}`);
    return { entry: null, errors };
  } finally {
    if (prevCrypto) Object.defineProperty(globalThis, "crypto", prevCrypto);
  }
  file.id = `tpl-${spec.id}`;
  file.title = spec.title;
  file.meta = file.meta ?? {}; // the seed validator requires the record
  // Palette metadata from the catalog theme record (already stamped on file).
  const palette = (file.theme?.colors ?? [])
    .map((c) => {
      const s = c.color?.srgb;
      if (!s) return null;
      const h = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
      return `#${h(s.r)}${h(s.g)}${h(s.b)}`;
    })
    .filter(Boolean)
    .slice(0, 6);
  const template = {
    id: spec.id,
    title: spec.title,
    ownerId: "hycanvas",
    workspaceId: null,
    visibility: "public",
    categories: spec.categories,
    tags: spec.tags,
    style: {
      palette,
      typography: [
        { role: "heading", family: file.theme?.fontHeading ?? "Inter", weight: 700 },
        { role: "body", family: file.theme?.fontBody ?? "Inter", weight: 400 },
      ],
      styleTags: spec.styleTags ?? [],
    },
    format: { width: spec.size?.[0] ?? 1920, height: spec.size?.[1] ?? 1080, unit: "px" },
    pageCount: file.pages.length,
    previewUrls: [],
    fillableFields: [],
    attributions: [],
    version: spec.version ?? 1,
    createdAt: spec.created ?? "2026-08-28T00:00:00.000Z",
    updatedAt: spec.updated ?? spec.created ?? "2026-08-28T00:00:00.000Z",
    designFileKey: `seed:${spec.id}`,
  };
  return { entry: { template, file }, errors };
}

// --- run ---------------------------------------------------------------------

const specs = readdirSync(SPEC_DIR).filter((f) => f.endsWith(".json")).sort();
const entries = [];
const allErrors = [];
const ids = new Set();
for (const f of specs) {
  const spec = JSON.parse(readFileSync(join(SPEC_DIR, f), "utf8"));
  if (ids.has(spec.id)) allErrors.push(`duplicate template id: ${spec.id}`);
  ids.add(spec.id);
  if (!spec.categories?.length || !spec.tags?.length) allErrors.push(`${spec.id}: categories and tags are required`);
  const { entry, errors } = spec.kind === "deck-outline" ? compileDeckOutline(spec) : compile(spec);
  allErrors.push(...errors);
  if (!entry) continue;
  const v = validate(entry.file);
  if (!v.ok) allErrors.push(`${spec.id}: schema invalid at ${v.pointer}: ${v.message}`);
  entries.push({ entry, rank: spec.rank ?? 100, id: spec.id });
}
// The gallery serves built-ins in seed order, so seed order IS the landing
// order: curated rank first (lower leads), id as the stable tiebreak.
entries.sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : 1));
if (allErrors.length) {
  console.error(`FAIL: ${allErrors.length} error(s)`);
  for (const e of allErrors) console.error("  -", e);
  process.exit(1);
}
if (!process.argv.includes("--check")) {
  writeFileSync(SEED, JSON.stringify(entries.map((e) => e.entry), null, 1) + "\n");
  console.log(`wrote ${entries.length} templates -> ${SEED}`);
} else {
  console.log(`ok: ${entries.length} templates compile and validate`);
}
