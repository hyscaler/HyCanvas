// Default-instance factory (FR-14). Editor tools and importers create nodes
// here so every default lives in one place and `validate` accepts each one.

import {
  CURRENT_SCHEMA_VERSION,
  type Color,
  type DesignFile,
  type Fill,
  type Node,
  type NodeBase,
  type NodeType,
  type Stroke,
  type Transform,
} from "./schema";

/** Fresh UUID v4 for node and file ids (FR-11). */
export function newId(): string {
  return globalThis.crypto.randomUUID();
}

const BLACK: Color = { srgb: { r: 0, g: 0, b: 0, a: 1 } };
const WHITE: Color = { srgb: { r: 1, g: 1, b: 1, a: 1 } };

function identityTransform(): Transform {
  return { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
}

function baseDefaults(): Omit<NodeBase, "type"> {
  return {
    id: newId(),
    transform: identityTransform(),
    size: { width: 100, height: 100 },
    opacity: 1,
    blendMode: "normal",
  };
}

const solidBlack: Fill = { type: "solid", color: BLACK };
function defaultStroke(): Stroke {
  return { fill: solidBlack, width: 1, align: "center", cap: "butt", join: "miter" };
}

// Type-specific default bodies (everything beyond NodeBase) for each known type.
const NODE_DEFAULTS: { [K in Exclude<NodeType, "model3d">]: () => object } = {
  text: () => ({
    box: {
      mode: "fixed",
      width: 100,
      height: 100,
      autoFit: { enabled: false, min: 8, max: 512 },
      verticalAlign: "top",
    },
    content: [{ runs: [], style: { align: "left", direction: "auto" } }],
  }),
  image: () => ({
    source: { assetId: "", naturalWidth: 0, naturalHeight: 0 },
    fit: "cover",
  }),
  shape: () => ({ shape: "rect", fills: [solidBlack] }),
  line: () => ({
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ],
    stroke: defaultStroke(),
  }),
  path: () => ({ segments: [], closed: false }),
  icon: () => ({ assetId: "" }),
  sticker: () => ({ assetId: "" }),
  group: () => ({ children: [] }),
  frame: () => ({ children: [], clip: true }),
  grid: () => ({ rows: 1, cols: 1, gap: 0, cells: [], children: [] }),
  video: () => ({ assetId: "", volume: 1 }),
  audio: () => ({ assetId: "", volume: 1 }),
  table: () => ({ rows: 0, cols: 0, colWidths: [], rowHeights: [], cells: [] }),
  chart: () => ({ chartType: "bar", series: [], categories: [], options: {} }),
  embed: () => ({ provider: "iframe", src: "" }),
  qr: () => ({ value: "", ecLevel: "M", foreground: BLACK, background: WHITE }),
  connector: () => ({
    route: "straight",
    start: { point: { x: 0, y: 0 } },
    end: { point: { x: 100, y: 0 } },
    stroke: defaultStroke(),
  }),
  mask: () => ({ maskShape: { subpaths: [], fillRule: "nonzero" }, child: createNode("shape") }),
  boolean: () => ({ op: "union", operands: [] }),
  sticky: () => ({
    text: "",
    // Classic yellow card with dark text.
    fill: { type: "solid", color: { srgb: { r: 1, g: 0.898, b: 0.4, a: 1 } } },
    textColor: BLACK,
    align: "left",
    fontScale: 1,
    autoSize: true,
  }),
};

/**
 * Create a valid default instance of any concrete node type. `init` shallow-
 * overrides the defaults (including `id`). The reserved `model3d` type has no
 * concrete shape yet and is not constructable here.
 */
export function createNode<T extends Exclude<NodeType, "model3d">>(
  type: T,
  init?: Partial<Node>,
): Extract<Node, { type: T }> {
  const make = NODE_DEFAULTS[type];
  if (!make) {
    throw new Error(`createNode: unsupported or reserved node type "${type}"`);
  }
  const node = {
    ...baseDefaults(),
    type,
    ...make(),
    ...init,
  };
  return node as Extract<Node, { type: T }>;
}

/** Create a blank, valid single-page design. */
export function createBlankDesign(
  init?: Partial<Pick<DesignFile, "id" | "title" | "unit" | "dpi">> & {
    width?: number;
    height?: number;
  },
): DesignFile {
  return {
    format: "hycanvas.design",
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: init?.id ?? newId(),
    title: init?.title ?? "Untitled design",
    unit: init?.unit ?? "px",
    dpi: init?.dpi ?? 96,
    pages: [
      {
        id: newId(),
        name: "Page 1",
        width: init?.width ?? 1080,
        height: init?.height ?? 1080,
        // A white page surface by default (Canva-style), so a new design shows a
        // sized white artboard rather than the empty pasteboard.
        background: { type: "solid", color: { srgb: { r: 1, g: 1, b: 1, a: 1 } } },
        children: [],
      },
    ],
    assets: [],
    fonts: [],
    meta: {},
  };
}
