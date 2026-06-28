// Forward-only, total migration chain (FR-9, FR-10). Each feature that changes
// the schema registers one pure, idempotent step keyed by the version it bumps
// from, plus a golden fixture (see __tests__). Opening an older file always
// succeeds by composing steps from the file's version up to the target.

import { CURRENT_SCHEMA_VERSION, type DesignFile } from "./schema";

/** A pure, idempotent step upgrading a file from version `v` to `v + 1`. */
export type Migration = (file: any) => any;

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyObj = Record<string, any>;

/** Drop keys whose value is undefined so migrated output stays clean. */
function compact<T extends AnyObj>(obj: T): T {
  for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
  return obj;
}

// v1 -> v2: the flat TextNode (content: TextRun[] + align/verticalAlign/...)
// becomes the rich paragraph/run model (box + content: Paragraph[]).
function migrateTextV1toV2(node: AnyObj): AnyObj {
  const oldRuns: AnyObj[] = Array.isArray(node.content) ? node.content : [];
  const runs = oldRuns.map((r) => ({
    text: r.text ?? "",
    style: compact({
      fontFamily: r.fontId ?? "system",
      fontStyle: r.italic ? "Italic" : "Regular",
      axes: typeof r.weight === "number" ? { wght: r.weight } : undefined,
      fontSize: r.fontSize ?? 16,
      fill: { type: "solid", color: r.color ?? { space: "srgb", r: 0, g: 0, b: 0, a: 1 } },
      letterSpacing: r.letterSpacing,
      lineHeight: r.lineHeight,
      decoration: r.decoration,
      features: r.features,
    }),
  }));
  const paragraph = {
    runs,
    style: compact({ align: node.align ?? "left", direction: node.direction ?? "auto" }),
  };
  const box = compact({
    mode: node.autoFit === "grow" ? "autoHeight" : "fixed",
    width: node.size?.width ?? 0,
    height: node.size?.height ?? 0,
    autoFit: { enabled: !!node.autoFit && node.autoFit !== "none", min: 8, max: 512 },
    verticalAlign: node.verticalAlign ?? "top",
  });
  // Drop the v1-only fields; keep everything else (base fields).
  const next: AnyObj = { ...node };
  delete next.content;
  delete next.align;
  delete next.verticalAlign;
  delete next.direction;
  delete next.autoFit;
  delete next.fills;
  next.box = box;
  next.content = [paragraph];
  return next;
}

function mapNodesV2(nodes: AnyObj[]): AnyObj[] {
  return nodes.map((node) => {
    // A v1 text node has no `box`; transform it. (Idempotent: v2 nodes have box.)
    let n = node.type === "text" && node.box === undefined ? migrateTextV1toV2(node) : node;
    if (Array.isArray(n.children)) n = { ...n, children: mapNodesV2(n.children) };
    return n;
  });
}

// v2 -> v3: the flat ImageNode (assetId + pixel crop + cover/contain/fill)
// becomes the source/normalized-crop/fit model.
function migrateImageV2toV3(node: AnyObj): AnyObj {
  const next: AnyObj = { ...node };
  next.source = {
    assetId: typeof node.assetId === "string" ? node.assetId : "",
    naturalWidth: 0, // unknown from v2; resolved on load from the asset
    naturalHeight: 0,
  };
  next.fit = node.fit === "fill" ? "stretch" : node.fit === "contain" ? "contain" : "cover";
  // The v2 crop was in source pixels with no natural size recorded, so it can't
  // be normalized reliably; reset to full source.
  delete next.assetId;
  delete next.crop;
  delete next.fills;
  return next;
}

function mapNodesV3(nodes: AnyObj[]): AnyObj[] {
  return nodes.map((node) => {
    // A v2 image node has no `source`; transform it. (Idempotent: v3 has source.)
    let n = node.type === "image" && node.source === undefined ? migrateImageV2toV3(node) : node;
    if (Array.isArray(n.children)) n = { ...n, children: mapNodesV3(n.children) };
    return n;
  });
}

// v3 -> v4: unified color/fill model. A generic deep walk converts every old
// Color ({space:...}) and old Fill ({type:'solid'|'linear'|...}) into the new
// shapes. Nodes are excluded from fill-detection (they carry id/transform), and
// `raw`/`data` slots are passed through untouched (lossless, FR-12).
const FILL_TYPES = new Set(["solid", "linear", "radial", "conic", "mesh", "pattern", "image", "gradient"]);
const COLOR_SPACES = new Set(["srgb", "p3", "cmyk", "spot"]);

function cmykToSrgb(c: number, m: number, y: number, k: number, a = 1): AnyObj {
  return { r: (1 - c) * (1 - k), g: (1 - m) * (1 - k), b: (1 - y) * (1 - k), a };
}
function srgbToCmyk(s: AnyObj): AnyObj {
  const k = 1 - Math.max(s.r, s.g, s.b);
  if (k >= 1) return { c: 0, m: 0, y: 0, k: 1 };
  return { c: (1 - s.r - k) / (1 - k), m: (1 - s.g - k) / (1 - k), y: (1 - s.b - k) / (1 - k), k };
}

function convertColor(c: AnyObj): AnyObj {
  if (c.srgb) return c; // already v4
  if (c.space === "srgb" || c.space === "p3") return { srgb: { r: c.r, g: c.g, b: c.b, a: c.a } };
  if (c.space === "cmyk") {
    return { srgb: cmykToSrgb(c.c, c.m, c.y, c.k, c.a), cmyk: { c: c.c, m: c.m, y: c.y, k: c.k } };
  }
  if (c.space === "spot") {
    const fb = convertColor(c.fallback ?? {});
    return { srgb: fb.srgb, spot: { name: c.name, fallback: fb.cmyk ?? srgbToCmyk(fb.srgb) } };
  }
  return c;
}

function convStops(stops: AnyObj[] = []): AnyObj[] {
  return stops.map((s) => ({ position: s.position ?? s.offset ?? 0, color: convertColor(s.color) }));
}

function convertFill(f: AnyObj): AnyObj {
  switch (f.type) {
    case "solid":
      return { type: "solid", color: convertColor(f.color) };
    case "linear":
      return { type: "gradient", gradient: "linear", stops: convStops(f.stops), angle: f.angle };
    case "radial":
      return { type: "gradient", gradient: "radial", stops: convStops(f.stops), center: { x: f.cx, y: f.cy }, radius: f.r };
    case "conic":
      return { type: "gradient", gradient: "conic", stops: convStops(f.stops), center: { x: f.cx, y: f.cy }, angle: f.angle };
    case "mesh":
      return {
        type: "gradient",
        gradient: "mesh",
        stops: [],
        mesh: { rows: f.rows, cols: f.cols, points: (f.points ?? []).map((p: AnyObj) => ({ x: p.x, y: p.y, color: convertColor(p.color) })) },
      };
    case "pattern":
      return compact({ type: "pattern", assetId: f.assetId, scale: f.scale, rotation: f.rotation, repeat: f.repeat === "none" ? "no-repeat" : f.repeat });
    case "image":
      if (f.source) return f; // already a v4 ImageFill
      return { type: "image", source: { assetId: f.assetId ?? "", naturalWidth: 0, naturalHeight: 0 }, fit: f.fit === "fill" ? "stretch" : f.fit === "tile" ? "cover" : (f.fit ?? "cover") };
    case "gradient": // already v4; convert nested colors idempotently
      return compact({ ...f, stops: convStops(f.stops), mesh: f.mesh ? { ...f.mesh, points: f.mesh.points.map((p: AnyObj) => ({ ...p, color: convertColor(p.color) })) } : undefined });
    default:
      return f;
  }
}

function isColorObj(v: AnyObj): boolean {
  if (typeof v.space === "string" && COLOR_SPACES.has(v.space)) return true;
  return typeof v.srgb === "object" && v.srgb !== null && "r" in v.srgb && !("type" in v);
}
function isFillObj(v: AnyObj): boolean {
  return typeof v.type === "string" && FILL_TYPES.has(v.type) && !("id" in v) && !("transform" in v);
}

function deepConvertColors(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepConvertColors);
  if (value && typeof value === "object") {
    const v = value as AnyObj;
    if (isColorObj(v)) return convertColor(v);
    if (isFillObj(v)) return convertFill(v);
    const out: AnyObj = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = k === "raw" || k === "data" ? val : deepConvertColors(val); // preserve lossless slots
    }
    return out;
  }
  return value;
}

// v5 -> v6: animation/interactivity (F25). Additive: new readers understand the
// typed `animation`/`interaction`/`transition`/`motion` fields, and a v5 file has
// none of them so it is already structurally valid v6. The one transformation is
// lifting the LEGACY single-entry `animations` array (the v5 entrance-only shape
// { preset: 'fade'|'rise'|'pop'|'slideL'|'slideR', durationMs, delayMs }) into the
// new `animation.entrance` slot so older entrance presets keep playing. The raw
// `animations` array is preserved untouched for lossless round-trips.
const LEGACY_ENTRANCE: Record<string, string> = {
  fade: "fade",
  rise: "rise",
  pop: "pop",
  slideL: "pan",
  slideR: "pan",
};

function migrateAnimationsV5toV6(node: AnyObj): AnyObj {
  // Only act when the typed slot is absent and a legacy entry exists (idempotent).
  if (node.animation !== undefined) return node;
  const legacy = Array.isArray(node.animations) ? node.animations[0] : undefined;
  if (!legacy || typeof legacy !== "object") return node;
  const preset = LEGACY_ENTRANCE[legacy.preset as string];
  if (!preset) return node;
  return {
    ...node,
    animation: {
      entrance: {
        preset,
        durationMs: typeof legacy.durationMs === "number" ? legacy.durationMs : 500,
        delayMs: typeof legacy.delayMs === "number" ? legacy.delayMs : 0,
        easing: "ease-out",
      },
    },
  };
}

function mapNodesV6(nodes: AnyObj[]): AnyObj[] {
  return nodes.map((node) => {
    let n = migrateAnimationsV5toV6(node);
    if (Array.isArray(n.children)) n = { ...n, children: mapNodesV6(n.children) };
    if (n.child && typeof n.child === "object") n = { ...n, child: mapNodesV6([n.child])[0] };
    return n;
  });
}

/**
 * Migration steps keyed by their SOURCE version. `migrations[n]` upgrades a
 * version-`n` file to version `n + 1`.
 */
export const migrations: Record<number, Migration> = {
  // v1 -> v2: rich text model.
  1: (file: AnyObj) => ({
    ...file,
    schemaVersion: 2,
    pages: (file.pages ?? []).map((p: AnyObj) => ({ ...p, children: mapNodesV2(p.children ?? []) })),
  }),
  // v2 -> v3: image model.
  2: (file: AnyObj) => ({
    ...file,
    schemaVersion: 3,
    pages: (file.pages ?? []).map((p: AnyObj) => ({ ...p, children: mapNodesV3(p.children ?? []) })),
  }),
  // v3 -> v4: unified color/fill model (deep color+fill conversion across the file).
  3: (file: AnyObj) => ({ ...(deepConvertColors(file) as AnyObj), schemaVersion: 4 }),
  // v4 -> v5: image effects and adjustments (F24). The `duotone` effect kind and
  // the extended adjustment ops (exposure/warmth/tint/vibrance/...) are purely
  // additive to the Effect union, so existing nodes need no transformation: a
  // v4 file's effects array is already valid v5. Bump the version so newer
  // readers know the file may carry the new kinds. Opening an older file always
  // succeeds because no existing field is changed or removed.
  4: (file: AnyObj) => ({ ...file, schemaVersion: 5 }),
  // v5 -> v6: animation/interactivity (F25). Lift any legacy entrance animation
  // into the typed `animation.entrance` slot across every page; everything else
  // is additive so older files open unchanged.
  5: (file: AnyObj) => ({
    ...file,
    schemaVersion: 6,
    pages: (file.pages ?? []).map((p: AnyObj) => ({ ...p, children: mapNodesV6(p.children ?? []) })),
  }),
  // v6 -> v7: chart styling and table cell/header/border formatting (F27). Every
  // new field (ChartNode.style, the `barStacked`/`barGrouped` chartType variants,
  // TableCell.textColor, TableNode.headerStyle/borderStyle) is additive: a v6 file
  // simply omits them and stays structurally valid v7, so no node transformation
  // is needed and older files always open. Bump the version so newer readers know
  // the file may carry the new chart/table styling fields.
  6: (file: AnyObj) => ({ ...file, schemaVersion: 7 }),
  // v7 -> v8: whiteboard (F30). Adds the `sticky` scene-node type and the
  // free-form `meta.kind` document markers (whiteboard/doc/sheet/video) used by
  // the new document surfaces. Both are additive: a v7 file has no sticky nodes
  // and an absent/`design` meta.kind, so it stays structurally valid v8 and
  // always opens. Bump the version so newer readers know it may carry them.
  7: (file: AnyObj) => ({ ...file, schemaVersion: 8 }),
  // v8 -> v9: per-range hyperlinks (CharStyle.link). Purely additive: a v8 file's
  // runs simply omit the optional `link`, so they stay structurally valid v9 and
  // always open. Bump the version so newer readers know runs may carry a link.
  8: (file: AnyObj) => ({ ...file, schemaVersion: 9 }),
  // v9 -> v10: whiteboard board node types (F30) - ink, mindmap, boardview,
  // diagramcode, stamp - plus additive optional fields on ConnectorNode
  // (label/waypoints/jumpOver, EndPoint.attach.port), StickyNode (authorId/shape),
  // and FrameNode (header/collapsed). All additive: a v9 file contains none of the
  // new node types and omits the new fields, so it stays structurally valid v10
  // and always opens. Bump the version so newer readers know it may carry them.
  9: (file: AnyObj) => ({ ...file, schemaVersion: 10 }),
};

export class MigrationError extends Error {
  constructor(
    message: string,
    readonly from: number,
    readonly to: number,
  ) {
    super(message);
    this.name = "MigrationError";
  }
}

/**
 * Forward-migrate a file to `toVersion` (default: current). Throws a structured
 * `MigrationError` rather than partially upgrading if a step is missing or a
 * downgrade is requested (FR-10). Running on an already-current file is a no-op
 * and never mutates the input.
 */
export function migrate(
  file: DesignFile,
  toVersion: number = CURRENT_SCHEMA_VERSION,
): DesignFile {
  const from = file.schemaVersion;

  if (from > toVersion) {
    throw new MigrationError(
      `cannot downgrade a v${from} file to v${toVersion}; migration is forward-only`,
      from,
      toVersion,
    );
  }
  if (from === toVersion) {
    return file; // no-op; do not clone or mutate
  }

  let current: any = file;
  for (let v = from; v < toVersion; v++) {
    const step = migrations[v];
    if (!step) {
      throw new MigrationError(
        `no migration registered from v${v} to v${v + 1}`,
        from,
        toVersion,
      );
    }
    current = step(current);
    if (current.schemaVersion !== v + 1) {
      // Defensive: a step must advance the version exactly one step.
      current = { ...current, schemaVersion: v + 1 };
    }
  }
  return current as DesignFile;
}

/** True when the file needs a forward migration before it can be hydrated. */
export function needsMigration(
  file: Pick<DesignFile, "schemaVersion">,
  toVersion: number = CURRENT_SCHEMA_VERSION,
): boolean {
  return file.schemaVersion < toVersion;
}
