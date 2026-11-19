// @hc/schema - the zod schemas for the open design file format.
//
// The runtime validator behind validate() and the JSON Schema export. Kept out
// of the package's main entry (see validation.ts) so the code that only needs
// the types and helpers does not ship zod (#77). schema.ts holds the types;
// each schema here mirrors the interface of the same name.

import { z } from "zod";
import {
  isKnownNodeType,
  type Node,
  type UnknownNode,
} from "./schema";

export const UnitSchema = z.enum(["px", "mm", "in", "pt"]);

const unit = z.number();
const channel = z.number().min(0).max(1);

const cmyk4 = z.object({ c: channel, m: channel, y: channel, k: channel });
export const ColorSchema = z.object({
  srgb: z.object({ r: channel, g: channel, b: channel, a: channel }),
  cmyk: cmyk4.optional(),
  spot: z.object({ name: z.string(), book: z.string().optional(), fallback: cmyk4 }).optional(),
});
const ImageFitSchema = z.enum(["contain", "cover", "stretch", "none"]);
// Normalized to the source (0..1, origin top-left); non-zero area.
export const CropRectSchema = z
  .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
  .refine((c) => c.width > 0 && c.height > 0, { message: "crop must have non-zero area" });
export const ClipPathSchema = z.object({
  kind: z.enum(["rect", "ellipse", "shape", "freeform"]),
  d: z.string().optional(),
  shapeRef: z.string().optional(),
});
export const ImageSourceSchema = z.object({
  assetId: z.string(),
  naturalWidth: z.number().nonnegative(),
  naturalHeight: z.number().nonnegative(),
  colorSpace: z.enum(["srgb", "display-p3", "cmyk"]).optional(),
  previewKey: z.string().optional(),
});

const focalSchema = z.object({ x: channel, y: channel });
export const ImageFillSchema = z.object({
  type: z.literal("image"),
  source: ImageSourceSchema,
  fit: ImageFitSchema,
  crop: CropRectSchema.optional(),
  focalPoint: focalSchema.optional(),
  opacity: channel.optional(),
});
export const TransformSchema = z.object({
  x: unit,
  y: unit,
  scaleX: z.number(),
  scaleY: z.number(),
  rotation: z.number(),
  skewX: z.number().optional(),
  skewY: z.number().optional(),
  origin: z.object({ x: z.number(), y: z.number() }).optional(),
});
export const SizeSchema = z.object({ width: unit, height: unit });
export const ConstraintsSchema = z.object({
  horizontal: z.enum(["left", "right", "center", "stretch", "scale"]),
  vertical: z.enum(["top", "bottom", "center", "stretch", "scale"]),
});
export const BlendModeSchema = z.enum([
  "normal", "multiply", "screen", "overlay", "darken", "lighten",
  "color-dodge", "color-burn", "hard-light", "soft-light",
  "difference", "exclusion", "hue", "saturation", "color", "luminosity",
]);
export const GradientStopSchema = z.object({ position: channel, color: ColorSchema });
export const MeshPointSchema = z.object({ x: unit, y: unit, color: ColorSchema });

export const SolidFillSchema = z.object({ type: z.literal("solid"), color: ColorSchema });
export const GradientFillSchema = z.object({
  type: z.literal("gradient"),
  gradient: z.enum(["linear", "radial", "conic", "mesh"]),
  stops: z.array(GradientStopSchema),
  angle: z.number().optional(),
  center: z.object({ x: z.number(), y: z.number() }).optional(),
  radius: z.number().optional(),
  mesh: z
    .object({
      rows: z.number().int().positive(),
      cols: z.number().int().positive(),
      points: z.array(MeshPointSchema),
    })
    .optional(),
});
export const PatternFillSchema = z.object({
  type: z.literal("pattern"),
  assetId: z.string(),
  scale: z.number(),
  rotation: z.number().optional(),
  repeat: z.enum(["tile", "mirror", "no-repeat"]),
});
export const FillSchema = z.discriminatedUnion("type", [
  SolidFillSchema,
  GradientFillSchema,
  PatternFillSchema,
  ImageFillSchema,
]);
export const StrokeSchema = z.object({
  fill: FillSchema,
  width: z.number(),
  align: z.enum(["inside", "center", "outside"]),
  cap: z.enum(["butt", "round", "square"]),
  join: z.enum(["miter", "round", "bevel"]),
  dash: z.array(z.number()).optional(),
  miterLimit: z.number().optional(),
});
const shadowFields = {
  type: z.enum(["drop", "inner"]).optional(),
  color: ColorSchema,
  offsetX: unit,
  offsetY: unit,
  blur: z.number(),
  spread: z.number(),
};
export const AdjustmentOpSchema = z.object({ name: z.string(), value: z.number() });
const duotoneFields = {
  shadows: ColorSchema,
  highlights: ColorSchema,
  intensity: z.number(),
};

/** Per-effect enable, for the reorderable effect stack.
 *
 *  ABSENT MEANS ENABLED. Every effect written before this field existed omits
 *  it and must keep rendering, so the flag can only ever turn something off.
 *
 *  Spelled `enabled` rather than `disabled` because the Go renderers already
 *  implemented exactly this check, in `effectsOf` and in both shadow paths of
 *  `composite.go`, before the schema ever declared the field. Introducing the
 *  opposite polarity would have left two conventions for one idea and a silent
 *  browser/server divergence the first time anything wrote one of them. */
const effectEnabled = { enabled: z.boolean().optional() };
export const EffectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("shadow"), ...shadowFields, ...effectEnabled }),
  z.object({ kind: z.literal("blur"), radius: z.number(), ...effectEnabled }),
  z.object({ kind: z.literal("glow"), color: ColorSchema, radius: z.number(), ...effectEnabled }),
  z.object({ kind: z.literal("outline"), color: ColorSchema, width: z.number(), ...effectEnabled }),
  z.object({ kind: z.literal("adjustment"), ops: z.array(AdjustmentOpSchema), ...effectEnabled }),
  z.object({ kind: z.literal("duotone"), ...duotoneFields, ...effectEnabled }),
]);
export const CornerRadiusSchema = z.object({
  topLeft: z.number(),
  topRight: z.number(),
  bottomRight: z.number(),
  bottomLeft: z.number(),
});
export const ElementLinkSchema = z.object({
  kind: z.enum(["url", "page", "anchor", "email"]),
  target: z.string(),
});
export const EasingSchema = z.enum(["linear", "ease-in", "ease-out", "ease-in-out", "spring", "ease-in-cubic", "ease-out-cubic", "ease-out-back", "bounce"]);

export const EntrancePresetSchema = z.enum(["fade", "rise", "pan", "pop", "drift", "breathe-in", "typewriter", "word-wipe", "tumble", "stomp", "zoom-in"]);
export const ExitPresetSchema = z.enum(["fade-out", "sink", "pop-out", "drift-out", "tumble-out", "zoom-out"]);
export const EmphasisPresetSchema = z.enum(["pulse", "wiggle", "spin", "breathe", "tada", "flicker", "jiggle", "bob"]);
function animationClipSchema<P extends string>(preset: z.ZodType<P>) {
  return z.object({
    preset,
    durationMs: z.number().nonnegative(),
    delayMs: z.number().nonnegative(),
    easing: EasingSchema,
    startMode: z.enum(["delay", "with-previous", "after-previous"]).optional(),
    bezier: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
    spring: z.object({ stiffness: z.number().optional(), damping: z.number().optional() }).optional(),
  });
}
export const KeyframeSchema = z.object({
  t: z.number().nonnegative(),
  dx: z.number().optional(),
  dy: z.number().optional(),
  scale: z.number().optional(),
  rotate: z.number().optional(),
  opacity: z.number().optional(),
  easing: EasingSchema.optional(),
  color: ColorSchema.optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
});
export const KeyframeTrackSchema = z.object({
  durationMs: z.number().positive(),
  loop: z.boolean().optional(),
  keyframes: z.array(KeyframeSchema),
  path: z.array(z.object({ x: z.number(), y: z.number() })).optional(),
  orient: z.boolean().optional(),
});
export const NodeAnimationSchema = z.object({
  entrance: animationClipSchema(EntrancePresetSchema).optional(),
  exit: animationClipSchema(ExitPresetSchema).optional(),
  emphasis: animationClipSchema(EmphasisPresetSchema).optional(),
  custom: KeyframeTrackSchema.optional(),
  trigger: z.object({ mediaNodeId: z.string(), atMs: z.number().nonnegative() }).optional(),
});
export const InteractionActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("navigate"),
    to: z.enum(["next", "prev", "first", "last", "page"]),
    pageId: z.string().optional(),
  }),
  z.object({ kind: z.literal("open-link"), link: ElementLinkSchema }),
]);
export const InteractionSchema = z.object({
  trigger: z.enum(["click", "hover"]),
  action: InteractionActionSchema,
  actionV2: z.object({ kind: z.string(), targetNodeId: z.string().optional() }).optional(),
});
export const PageTransitionSchema = z.object({
  type: z.enum(["none", "fade", "slide", "push", "dissolve", "morph-lite", "wipe", "flip", "zoom", "morph"]),
  direction: z.enum(["left", "right", "up", "down"]).optional(),
  durationMs: z.number().nonnegative(),
  easing: z.string().optional(),
});
export const ImageMotionSchema = z.object({
  kind: z.enum(["kenburns", "parallax"]),
  intensity: z.number().min(0).max(1),
});
const handle = z.object({ x: z.number(), y: z.number() });
export const VectorAnchorSchema = z.object({
  x: unit,
  y: unit,
  inHandle: handle.optional(),
  outHandle: handle.optional(),
  corner: z.boolean().optional(),
});
export const SubPathSchema = z.object({
  closed: z.boolean(),
  anchors: z.array(VectorAnchorSchema),
});
export const VectorPathSchema = z.object({
  subpaths: z.array(SubPathSchema),
  fillRule: z.enum(["nonzero", "evenodd"]),
});
export const GuideSchema = z.object({ axis: z.enum(["x", "y"]), position: z.number() });
export const AssetRefSchema = z.object({
  id: z.string(),
  kind: z.enum(["image", "video", "audio", "svg", "lottie", "model3d", "font"]),
  url: z.string(),
  mime: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  durationMs: z.number().optional(),
  checksum: z.string().optional(),
});
export const FontRefSchema = z.object({
  id: z.string(),
  family: z.string(),
  source: z.enum(["system", "google", "upload", "library"]),
  url: z.string().optional(),
  axes: z.record(z.string(), z.number()).optional(),
  files: z
    .array(
      z.object({
        style: z.string(),
        url: z.string(),
        format: z.enum(["ttf", "otf", "woff", "woff2"]),
        variable: z.boolean().optional(),
      }),
    )
    .optional(),
  variableAxes: z
    .array(z.object({ tag: z.string(), min: z.number(), max: z.number(), default: z.number() }))
    .optional(),
});
export const ColorSwatchSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  color: ColorSchema,
});

// Field map shared by every concrete node schema (excluding the `type` literal,
// which each node fixes itself so the union can discriminate on it).
const nodeBaseFields = {
  id: z.string(),
  transform: TransformSchema,
  size: SizeSchema,
  opacity: channel,
  blendMode: BlendModeSchema,
  effects: z.array(EffectSchema).optional(),
  constraints: ConstraintsSchema.optional(),
  locked: z.boolean().optional(),
  hidden: z.boolean().optional(),
  name: z.string().optional(),
  link: ElementLinkSchema.optional(),
  animations: z.array(z.unknown()).optional(),
  animation: NodeAnimationSchema.optional(),
  interaction: InteractionSchema.optional(),
  altText: z.string().optional(),
  decorative: z.boolean().optional(),
  aspectLocked: z.boolean().optional(),
  opticalAlign: z.boolean().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
};

/** Base fields common to every node, with `type` left open (used to validate
 *  unknown/newer node types by their base alone; see validate.ts, FR-3). */
export const NodeBaseSchema = z.object({ ...nodeBaseFields, type: z.string() });
export const TextRunSchema = z.object({
  text: z.string(),
  fontId: z.string(),
  fontSize: z.number(),
  weight: z.number().min(100).max(900),
  italic: z.boolean().optional(),
  letterSpacing: z.number().optional(),
  lineHeight: z.number().optional(),
  color: ColorSchema.optional(),
  decoration: z.array(z.enum(["underline", "strikethrough"])).optional(),
  features: z.record(z.string(), z.number()).optional(),
});
export const CharStyleSchema = z.object({
  fontFamily: z.string(),
  fontStyle: z.string(),
  axes: z.record(z.string(), z.number()).optional(),
  fontSize: z.number(),
  fill: FillSchema,
  letterSpacing: z.number().optional(),
  kerning: z.union([z.enum(["auto", "optical", "metric"]), z.number()]).optional(),
  lineHeight: z
    .union([z.number(), z.object({ mode: z.enum(["auto", "multiple", "absolute"]), value: z.number() })])
    .optional(),
  baselineShift: z.number().optional(),
  case: z.enum(["none", "upper", "lower", "title", "smallcaps"]).optional(),
  decoration: z.array(z.enum(["underline", "strikethrough"])).optional(),
  script: z.enum(["normal", "sub", "super"]).optional(),
  language: z.string().optional(),
  features: z.record(z.string(), z.number()).optional(),
  link: z.string().optional(),
});
export const RunSchema = z.object({
  text: z.string(),
  style: CharStyleSchema,
  charStyleId: z.string().optional(),
  overrides: CharStyleSchema.partial().optional(),
});
export const ParagraphStyleSchema = z.object({
  align: z.enum(["left", "center", "right", "justify"]),
  direction: z.enum(["ltr", "rtl", "auto"]),
  indentStart: z.number().optional(),
  indentEnd: z.number().optional(),
  firstLineIndent: z.number().optional(),
  spaceBefore: z.number().optional(),
  spaceAfter: z.number().optional(),
  list: z
    .object({ type: z.enum(["bullet", "number", "checklist"]), level: z.number().int(), marker: z.string().optional() })
    .optional(),
  tabStops: z.array(z.number()).optional(),
  baseChar: CharStyleSchema.partial().optional(),
});
export const ParagraphSchema = z.object({
  runs: z.array(RunSchema),
  style: ParagraphStyleSchema,
  paraStyleId: z.string().optional(),
  overrides: ParagraphStyleSchema.partial().optional(),
});
export const TextBoxSchema = z.object({
  mode: z.enum(["fixed", "autoHeight", "autoWidth"]),
  width: unit,
  height: unit,
  columns: z.object({ count: z.number().int().positive(), gutter: z.number() }).optional(),
  padding: z.object({ t: z.number(), r: z.number(), b: z.number(), l: z.number() }).optional(),
  autoFit: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }).optional(),
  verticalAlign: z.enum(["top", "middle", "bottom"]).optional(),
});
export const TextFlowSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("horizontal") }),
  z.object({ kind: z.literal("vertical"), columnOrder: z.enum(["rtl", "ltr"]) }),
  z.object({
    kind: z.literal("path"),
    pathRef: z.string(),
    offset: z.number(),
    side: z.enum(["above", "below", "inside", "outside"]),
    flip: z.boolean().optional(),
  }),
  z.object({ kind: z.literal("arc"), curvature: z.number() }),
]);
export const TextEffectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("shadow"), dx: z.number(), dy: z.number(), blur: z.number(), color: FillSchema, opacity: channel, ...effectEnabled }),
  z.object({ kind: z.literal("outline"), width: z.number(), color: FillSchema, join: z.enum(["miter", "round", "bevel"]), ...effectEnabled }),
  z.object({ kind: z.literal("glow"), radius: z.number(), color: FillSchema, intensity: z.number(), ...effectEnabled }),
  z.object({ kind: z.literal("echo"), offset: z.number(), count: z.number().int(), color: FillSchema, ...effectEnabled }),
  z.object({ kind: z.literal("neon"), color: FillSchema, intensity: z.number(), ...effectEnabled }),
  z.object({ kind: z.literal("splice"), thickness: z.number(), offset: z.number(), color: FillSchema, ...effectEnabled }),
  z.object({ kind: z.literal("highlight"), color: FillSchema, padding: z.number(), radius: z.number(), ...effectEnabled }),
  z.object({ kind: z.literal("lift"), intensity: z.number(), ...effectEnabled }),
  z.object({ kind: z.literal("hollow"), thickness: z.number(), ...effectEnabled }),
]);
export const TextNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("text"),
  box: TextBoxSchema,
  content: z.array(ParagraphSchema),
  flow: TextFlowSchema.optional(),
  textEffects: z.array(TextEffectSchema).optional(),
  styleRefs: z.object({ defaultParagraph: z.string().optional() }).optional(),
});

const cropSchema = z.object({ x: unit, y: unit, width: unit, height: unit });
export const ImageAlphaMaskSchema = z.object({
  assetId: z.string(),
  width: z.number(),
  height: z.number(),
});
export const ImageNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("image"),
  source: ImageSourceSchema,
  fit: ImageFitSchema,
  crop: CropRectSchema.optional(),
  clip: ClipPathSchema.optional(),
  focalPoint: focalSchema.optional(),
  flipX: z.boolean().optional(),
  flipY: z.boolean().optional(),
  effectivePpi: z.number().optional(),
  motion: ImageMotionSchema.optional(),
  alphaMask: ImageAlphaMaskSchema.optional(),
  alt: z.string().optional(),
});
export const ShapeNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("shape"),
  shape: z.enum(["rect", "ellipse", "polygon", "star", "triangle", "custom"]),
  cornerRadius: CornerRadiusSchema.optional(),
  sides: z.number().optional(),
  innerRadius: z.number().optional(),
  pathData: z.string().optional(),
  fills: z.array(FillSchema),
  stroke: StrokeSchema.optional(),
});
const capSchema = z.enum(["none", "arrow", "circle", "diamond"]);
export const LineNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("line"),
  points: z.array(z.object({ x: unit, y: unit })).min(2),
  stroke: StrokeSchema,
  startCap: capSchema.optional(),
  endCap: capSchema.optional(),
});
const pointSchema = z.object({ x: unit, y: unit });
export const PathSegmentSchema = z.object({
  x: unit,
  y: unit,
  cIn: pointSchema.optional(),
  cOut: pointSchema.optional(),
  corner: z.boolean().optional(),
});
export const PathContourSchema = z.object({
  segments: z.array(PathSegmentSchema),
  closed: z.boolean(),
});
export const PathNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("path"),
  segments: z.array(PathSegmentSchema),
  closed: z.boolean(),
  contours: z.array(PathContourSchema).optional(),
  fills: z.array(FillSchema).optional(),
  stroke: StrokeSchema.optional(),
});
export const IconNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("icon"),
  assetId: z.string(),
  fills: z.array(FillSchema).optional(),
});
export const StickerNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("sticker"),
  assetId: z.string(),
  animated: z.boolean().optional(),
});
export const GroupNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("group"),
  isolation: z.boolean().optional(),
  get children() {
    return z.array(NodeSchema);
  },
  clip: z.boolean().optional(),
});
export const AutoLayoutSchema = z.object({
  direction: z.enum(["row", "column"]),
  gap: z.number(),
  padding: z.object({
    top: z.number(),
    right: z.number(),
    bottom: z.number(),
    left: z.number(),
  }),
  align: z.enum(["start", "center", "end", "stretch"]),
});
export const FrameHeaderSchema = z.object({
  title: z.string(),
  fill: FillSchema.optional(),
  textColor: ColorSchema.optional(),
});
export const FrameNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("frame"),
  get children() {
    return z.array(NodeSchema);
  },
  clip: z.boolean(),
  maskShape: z.enum(["rect", "ellipse", "custom"]).optional(),
  maskPath: z.string().optional(),
  fills: z.array(FillSchema).optional(),
  cornerRadius: CornerRadiusSchema.optional(),
  autoLayout: AutoLayoutSchema.optional(),
  header: FrameHeaderSchema.optional(),
  collapsed: z.boolean().optional(),
});
export const GridCellSchema = z.object({
  row: z.number().int(),
  col: z.number().int(),
  rowSpan: z.number().int(),
  colSpan: z.number().int(),
  childId: z.string().optional(),
});
export const GridNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("grid"),
  rows: z.number().int().positive(),
  cols: z.number().int().positive(),
  gap: z.number(),
  cells: z.array(GridCellSchema),
  get children() {
    return z.array(NodeSchema);
  },
  // Positive: a zero or negative weight would collapse a track to nothing or
  // invert it, and neither is reachable from the UI.
  colWidths: z.array(z.number().positive()).optional(),
  rowHeights: z.array(z.number().positive()).optional(),
  masonry: z.boolean().optional(),
});
export const VideoNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("video"),
  assetId: z.string(),
  trimStartMs: z.number().optional(),
  trimEndMs: z.number().optional(),
  volume: channel,
  muted: z.boolean().optional(),
  loop: z.boolean().optional(),
  crop: cropSchema.optional(),
});
export const AudioNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("audio"),
  assetId: z.string(),
  trimStartMs: z.number().optional(),
  trimEndMs: z.number().optional(),
  volume: channel,
  fadeInMs: z.number().optional(),
  fadeOutMs: z.number().optional(),
});
export const TableCellSchema = z.object({
  row: z.number().int(),
  col: z.number().int(),
  rowSpan: z.number().int(),
  colSpan: z.number().int(),
  content: z.array(TextRunSchema),
  fill: FillSchema.optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  textColor: ColorSchema.optional(),
});
export const TableHeaderStyleSchema = z.object({
  enabled: z.boolean(),
  fill: FillSchema.optional(),
  textColor: ColorSchema.optional(),
  bold: z.boolean().optional(),
});
export const TableBorderStyleSchema = z.object({
  show: z.boolean(),
  color: ColorSchema.optional(),
  width: z.number().nonnegative().optional(),
});
export const DataBindingSchema = z.object({
  kind: z.enum(["inline", "url"]),
  csv: z.string().optional(),
  url: z.string().optional(),
  hasHeaderRow: z.boolean().optional(),
  refreshedAt: z.string().optional(),
});
export const TableConditionalRuleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("highlight"), op: z.enum([">", "<", ">=", "<=", "==", "!="]), value: z.number(), fill: FillSchema.optional(), textColor: ColorSchema.optional(), column: z.number().int().optional() }),
  z.object({ kind: z.literal("colorScale"), min: ColorSchema, max: ColorSchema, column: z.number().int().optional() }),
  z.object({ kind: z.literal("dataBar"), color: ColorSchema, column: z.number().int().optional() }),
]);
export const TableNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("table"),
  rows: z.number().int().nonnegative(),
  cols: z.number().int().nonnegative(),
  colWidths: z.array(z.number()),
  rowHeights: z.array(z.number()),
  cells: z.array(TableCellSchema),
  borders: StrokeSchema.optional(),
  headerStyle: TableHeaderStyleSchema.optional(),
  borderStyle: TableBorderStyleSchema.optional(),
  conditional: z.array(TableConditionalRuleSchema).optional(),
  binding: DataBindingSchema.optional(),
});
export const ChartSeriesSchema = z.object({
  name: z.string(),
  values: z.array(z.number()),
  color: ColorSchema.optional(),
});
export const ChartTypeSchema = z.enum([
  "bar", "barStacked", "barGrouped", "line", "pie", "donut", "area",
  "scatter", "radar", "gauge", "funnel", "progress",
]);
export const ChartStyleSchema = z.object({
  title: z.string().optional(),
  legend: z.object({ show: z.boolean(), position: z.enum(["top", "right", "bottom", "left"]) }).optional(),
  valueLabels: z.boolean().optional(),
  fontSize: z.number().positive().optional(),
  axes: z
    .object({
      showX: z.boolean().optional(),
      showY: z.boolean().optional(),
      xLabel: z.string().optional(),
      yLabel: z.string().optional(),
    })
    .optional(),
});
export const ChartNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("chart"),
  chartType: ChartTypeSchema,
  series: z.array(ChartSeriesSchema),
  categories: z.array(z.string()),
  options: z.record(z.string(), z.unknown()),
  dataSourceId: z.string().optional(),
  style: ChartStyleSchema.optional(),
  binding: DataBindingSchema.optional(),
});
export const EmbedNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("embed"),
  provider: z.string(),
  src: z.string(),
  poster: z.string().optional(),
});
export const QRNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("qr"),
  value: z.string(),
  ecLevel: z.enum(["L", "M", "Q", "H"]),
  foreground: ColorSchema,
  background: ColorSchema,
  logoAssetId: z.string().optional(),
  logoScale: z.number().optional(),
  modules: z.array(z.array(z.boolean())).optional(),
});
const CapSchema = z.object({ kind: z.enum(["none", "arrow", "triangle", "dot"]), size: z.number() });
const EndPointSchema = z.object({
  point: z.object({ x: unit, y: unit }).optional(),
  attach: z.object({ nodeId: z.string(), anchor: z.string(), port: z.string().optional() }).optional(),
});
const ConnectorLabelSchema = z.object({
  text: z.string(),
  position: z.number().min(0).max(1).optional(),
});
export const ConnectorNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("connector"),
  route: z.enum(["straight", "elbow", "curved"]),
  start: EndPointSchema,
  end: EndPointSchema,
  stroke: StrokeSchema,
  startCap: CapSchema.optional(),
  endCap: CapSchema.optional(),
  label: ConnectorLabelSchema.optional(),
  waypoints: z.array(z.object({ x: unit, y: unit })).optional(),
  jumpOver: z.boolean().optional(),
});
export const MaskNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("mask"),
  maskShape: VectorPathSchema,
  get child() {
    return NodeSchema;
  },
  childInner: TransformSchema.optional(),
});
export const BooleanNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("boolean"),
  op: z.enum(["union", "subtract", "intersect", "exclude"]),
  operands: z.array(ShapeNodeSchema),
  result: VectorPathSchema.optional(),
  fills: z.array(FillSchema).optional(),
  stroke: StrokeSchema.optional(),
});
export const StickyNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("sticky"),
  text: z.string(),
  fill: FillSchema,
  textColor: ColorSchema,
  fontFamily: z.string().optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  fontScale: z.number().positive(),
  autoSize: z.boolean(),
  frameId: z.string().optional(),
  authorId: z.string().optional(),
  shape: z.enum(["square", "rectangle", "circle"]).optional(),
});
const InkPointSchema = z.object({
  x: unit,
  y: unit,
  p: z.number().min(0).max(1).optional(),
  t: z.number().optional(),
});
export const InkNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("ink"),
  points: z.array(InkPointSchema),
  smoothing: channel,
  seed: z.number().optional(),
  brush: z.object({
    width: z.number().positive(),
    opacity: channel,
    color: ColorSchema,
    mode: z.enum(["pen", "marker", "highlighter"]),
  }),
});
const MindMapBranchSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  label: z.string(),
  childIds: z.array(z.string()),
});
export const MindMapNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("mindmap"),
  rootId: z.string(),
  branches: z.array(MindMapBranchSchema),
  direction: z.enum(["radial", "right", "balanced"]),
});
const BoardViewColumnSchema = z.object({
  id: z.string(),
  title: z.string(),
  cardIds: z.array(z.string()),
});
const BoardViewCardSchema = z.object({
  id: z.string(),
  title: z.string(),
  tags: z.array(z.string()).optional(),
  estimate: z.number().optional(),
});
export const BoardViewNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("boardview"),
  view: z.enum(["kanban", "table", "timeline"]),
  columns: z.array(BoardViewColumnSchema),
  cards: z.array(BoardViewCardSchema),
});
export const DiagramCodeNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("diagramcode"),
  lang: z.enum(["mermaid", "plantuml", "dot"]),
  source: z.string(),
  materializedIds: z.array(z.string()).optional(),
});
export const StampNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("stamp"),
  kind: z.enum(["emoji", "vote"]),
  glyph: z.string(),
  authorId: z.string().optional(),
});
export const UnknownNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.string().refine((t) => !isKnownNodeType(t), {
    message: "UnknownNode.type must not be a known node type",
  }),
  raw: z.record(z.string(), z.unknown()),
}) as unknown as z.ZodType<UnknownNode>;

/** Per-type schemas for every known node type, keyed by discriminator. */
export const knownNodeSchemas = {
  text: TextNodeSchema,
  image: ImageNodeSchema,
  shape: ShapeNodeSchema,
  line: LineNodeSchema,
  path: PathNodeSchema,
  icon: IconNodeSchema,
  sticker: StickerNodeSchema,
  group: GroupNodeSchema,
  frame: FrameNodeSchema,
  grid: GridNodeSchema,
  video: VideoNodeSchema,
  audio: AudioNodeSchema,
  table: TableNodeSchema,
  chart: ChartNodeSchema,
  embed: EmbedNodeSchema,
  qr: QRNodeSchema,
  connector: ConnectorNodeSchema,
  mask: MaskNodeSchema,
  boolean: BooleanNodeSchema,
  sticky: StickyNodeSchema,
  ink: InkNodeSchema,
  mindmap: MindMapNodeSchema,
  boardview: BoardViewNodeSchema,
  diagramcode: DiagramCodeNodeSchema,
  stamp: StampNodeSchema,
} as const;

/** Discriminated union of all known node types (precise per-branch errors). */
export const KnownNodeSchema = z.discriminatedUnion("type", [
  TextNodeSchema, ImageNodeSchema, ShapeNodeSchema, LineNodeSchema,
  PathNodeSchema, IconNodeSchema, StickerNodeSchema, GroupNodeSchema,
  FrameNodeSchema, GridNodeSchema, VideoNodeSchema, AudioNodeSchema,
  TableNodeSchema, ChartNodeSchema, EmbedNodeSchema, QRNodeSchema,
  ConnectorNodeSchema, MaskNodeSchema, BooleanNodeSchema, StickyNodeSchema,
  InkNodeSchema, MindMapNodeSchema, BoardViewNodeSchema, DiagramCodeNodeSchema, StampNodeSchema,
]);

/** Full recursive node schema (known types + unknown passthrough). */
export const NodeSchema: z.ZodType<Node> = z.lazy(() =>
  z.union([KnownNodeSchema, UnknownNodeSchema]),
) as z.ZodType<Node>;
export const PlaceholderRoleSchema = z.enum(["title", "body", "content", "picture", "chart", "media", "footer"]);
export const PlaceholderSchema = z.object({
  id: z.string(),
  role: PlaceholderRoleSchema,
  rect: z.object({ x: z.number(), y: z.number(), width: unit, height: unit }),
  maxChars: z.number().int().positive().optional(),
  minChars: z.number().int().nonnegative().optional(),
  minItems: z.number().int().nonnegative().optional(),
  maxItems: z.number().int().positive().optional(),
});
export const SlideMasterSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  theme: z.string().optional(),
  background: FillSchema.optional(),
  placeholders: z.array(PlaceholderSchema),
});
export const SlideLayoutSchema = z.object({
  id: z.string(),
  masterId: z.string(),
  name: z.string(),
  background: FillSchema.optional(),
  placeholders: z.array(PlaceholderSchema),
});
export const ThemeSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  colors: z.array(ColorSwatchSchema),
  fontHeading: z.string().optional(),
  fontBody: z.string().optional(),
  effects: z.record(z.string(), z.unknown()).optional(),
  variants: z
    .array(z.object({ id: z.string(), name: z.string().optional(), colors: z.array(ColorSwatchSchema) }))
    .optional(),
});
export const SlideSectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().optional(),
  collapsed: z.boolean().optional(),
});
export const PageSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  width: unit,
  height: unit,
  background: FillSchema.optional(),
  bleed: z.number().optional(),
  children: z.array(NodeSchema),
  guides: z.array(GuideSchema).optional(),
  notes: z.string().optional(),
  transition: PageTransitionSchema.optional(),
  transitionOut: PageTransitionSchema.optional(),
  layoutId: z.string().optional(),
  sectionId: z.string().optional(),
  readingOrder: z.array(z.string()).optional(),
  autoAdvanceMs: z.number().optional(),
  hidden: z.boolean().optional(),
  timelineDuration: z.number().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export const DesignFileSchema = z.object({
  format: z.union([z.literal("hycanvas.design"), z.literal("opencanva.design")]),
  schemaVersion: z.number().int().nonnegative(),
  id: z.string(),
  title: z.string(),
  unit: UnitSchema,
  dpi: z.number().positive(),
  colorProfile: z.string().optional(),
  pages: z.array(PageSchema),
  masters: z.array(SlideMasterSchema).optional(),
  layouts: z.array(SlideLayoutSchema).optional(),
  theme: ThemeSchema.optional(),
  sections: z.array(SlideSectionSchema).optional(),
  language: z.string().optional(),
  assets: z.array(AssetRefSchema),
  fonts: z.array(FontRefSchema),
  palette: z.array(ColorSwatchSchema).optional(),
  meta: z.record(z.string(), z.unknown()),
});
