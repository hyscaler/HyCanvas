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
const { validate } = await import(join(ROOT, "packages", "schema", "dist", "index.js"));

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
  const paragraphs = String(n.text).split("\n").map((line) => ({
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

// --- compile one spec --------------------------------------------------------

function compile(spec) {
  const errors = [];
  const pages = spec.pages.map((p, pi) => {
    const children = [];
    (p.nodes ?? []).forEach((n, ni) => {
      const id = `${spec.id}-p${pi}-n${ni}`;
      if (n.kind === "rect") children.push(shapeNode(id, n, "rect"));
      else if (n.kind === "ellipse") children.push(shapeNode(id, n, "ellipse"));
      else if (n.kind === "text") children.push(textNode(id, n));
      else if (n.kind === "button") children.push(...buttonNodes(id, n));
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
    return {
      id: `${spec.id}-page-${pi}`,
      name: p.name ?? `Page ${pi + 1}`,
      width: spec.size[0],
      height: spec.size[1],
      background: { type: "solid", color: srgb(typeof p.bg === "string" ? p.bg : "#ffffff") },
      children: typeof p.bg === "object"
        ? [shapeNode(`${spec.id}-p${pi}-bg`, { x: 0, y: 0, w: spec.size[0], h: spec.size[1], fill: p.bg, bleed: true }, "rect"), ...children]
        : children,
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
    version: 1,
    createdAt: spec.created ?? "2026-07-04T00:00:00.000Z",
    updatedAt: spec.created ?? "2026-07-04T00:00:00.000Z",
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
  const { entry, errors } = compile(spec);
  allErrors.push(...errors);
  const v = validate(entry.file);
  if (!v.ok) allErrors.push(`${spec.id}: schema invalid: ${JSON.stringify(v.errors?.slice(0, 3))}`);
  entries.push(entry);
}
if (allErrors.length) {
  console.error(`FAIL: ${allErrors.length} error(s)`);
  for (const e of allErrors) console.error("  -", e);
  process.exit(1);
}
if (!process.argv.includes("--check")) {
  writeFileSync(SEED, JSON.stringify(entries, null, 1) + "\n");
  console.log(`wrote ${entries.length} templates -> ${SEED}`);
} else {
  console.log(`ok: ${entries.length} templates compile and validate`);
}
