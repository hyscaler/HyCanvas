// @hc/schema - the open design file format: types and zod schemas.
//
// This is the single source of truth for the format. TypeScript interfaces are
// the public types every other package imports; the zod schemas alongside them
// power runtime validation (see validate.ts) and JSON Schema generation (see
// json-schema.ts), so the static types and the runtime validator cannot drift.
//

import { z } from "zod";

/** Bumped on any breaking change to the format; older files migrate forward.
 *  v2: rich text model (paragraphs/runs/styles) replaces the flat TextNode.
 *  v3: image model (source/normalized-crop/clip/focal) replaces the flat ImageNode.
 *  v4: unified color/fill model (Color {srgb,cmyk?,spot?}, consolidated GradientFill).
 *  v5: image effects/adjustments (duotone + extended adjustment ops; purely additive).
 *  v6: animation/interactivity (typed NodeAnimation, Interaction, PageTransition,
 *      ImageMotion; legacy single `animations[0]` lifts into `animation.entrance`).
 *  v7: chart styling (title/legend/axes/value-labels/per-series color) and table
 *      cell+header+border formatting (F27); all additive, older files open as-is.
 *  v8: whiteboard (F30) sticky node + free-form `meta.kind` document markers
 *      (whiteboard/doc/sheet/video); additive, older files open as-is.
 *  v9: per-range hyperlinks (CharStyle.link); additive, runs may omit it.
 *  v10: whiteboard board node types (F30) - ink, mindmap, boardview, diagramcode,
 *      stamp - plus additive optional fields on ConnectorNode (label/waypoints/
 *      jumpOver, EndPoint.attach.port), StickyNode (authorId/shape), and FrameNode
 *      (header/collapsed). All additive: older files omit them and open as-is.
 *  v11: presentations (F28) slide masters, layouts, placeholders, and a swappable
 *      deck Theme on DesignFile, plus Page.layoutId. All additive and optional:
 *      a v10 deck has none of them and opens unchanged. */
export const CURRENT_SCHEMA_VERSION = 11;

/** Maximum container nesting depth; guards traversal against stack overflow (FR-4). */
export const MAX_NESTING_DEPTH = 32;

// ---------------------------------------------------------------------------
// Section 6.2: shared value types
// ---------------------------------------------------------------------------

export type Unit = "px" | "mm" | "in" | "pt";
export const UnitSchema = z.enum(["px", "mm", "in", "pt"]);

// Canonical sRGB (always present) plus optional explicit print color.
export interface Color {
  srgb: { r: number; g: number; b: number; a: number }; // 0..1 each
  cmyk?: { c: number; m: number; y: number; k: number }; // 0..1 each
  spot?: { name: string; book?: string; fallback: { c: number; m: number; y: number; k: number } };
}

const unit = z.number();
const channel = z.number().min(0).max(1);

const cmyk4 = z.object({ c: channel, m: channel, y: channel, k: channel });
export const ColorSchema = z.object({
  srgb: z.object({ r: channel, g: channel, b: channel, a: channel }),
  cmyk: cmyk4.optional(),
  spot: z.object({ name: z.string(), book: z.string().optional(), fallback: cmyk4 }).optional(),
});

// --- image value types (defined here so the Fill union can include
// ImageFill; the ImageNode below reuses these). ---------------------------

export type ImageFit = "contain" | "cover" | "stretch" | "none";
const ImageFitSchema = z.enum(["contain", "cover", "stretch", "none"]);

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
// Normalized to the source (0..1, origin top-left); non-zero area.
export const CropRectSchema = z
  .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
  .refine((c) => c.width > 0 && c.height > 0, { message: "crop must have non-zero area" });

export interface ClipPath {
  kind: "rect" | "ellipse" | "shape" | "freeform";
  d?: string;
  shapeRef?: string;
}
export const ClipPathSchema = z.object({
  kind: z.enum(["rect", "ellipse", "shape", "freeform"]),
  d: z.string().optional(),
  shapeRef: z.string().optional(),
});

export interface ImageSource {
  assetId: string;
  naturalWidth: number;
  naturalHeight: number;
  colorSpace?: "srgb" | "display-p3" | "cmyk";
  previewKey?: string;
}
export const ImageSourceSchema = z.object({
  assetId: z.string(),
  naturalWidth: z.number().nonnegative(),
  naturalHeight: z.number().nonnegative(),
  colorSpace: z.enum(["srgb", "display-p3", "cmyk"]).optional(),
  previewKey: z.string().optional(),
});

const focalSchema = z.object({ x: channel, y: channel });

export interface ImageFill {
  type: "image";
  source: ImageSource;
  fit: ImageFit;
  crop?: CropRect;
  focalPoint?: { x: number; y: number };
  opacity?: number;
}
export const ImageFillSchema = z.object({
  type: z.literal("image"),
  source: ImageSourceSchema,
  fit: ImageFitSchema,
  crop: CropRectSchema.optional(),
  focalPoint: focalSchema.optional(),
  opacity: channel.optional(),
});

export interface Transform {
  x: number;
  y: number;
  scaleX: number; // negative encodes a horizontal flip
  scaleY: number; // negative encodes a vertical flip
  rotation: number;
  skewX?: number;
  skewY?: number;
  // Pivot for rotation/scale, normalized 0..1 within the untransformed box.
  origin?: { x: number; y: number };
}
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

export interface Size {
  width: number;
  height: number;
}
export const SizeSchema = z.object({ width: unit, height: unit });

export interface Constraints {
  horizontal: "left" | "right" | "center" | "stretch" | "scale";
  vertical: "top" | "bottom" | "center" | "stretch" | "scale";
}
export const ConstraintsSchema = z.object({
  horizontal: z.enum(["left", "right", "center", "stretch", "scale"]),
  vertical: z.enum(["top", "bottom", "center", "stretch", "scale"]),
});

export type BlendMode =
  | "normal" | "multiply" | "screen" | "overlay" | "darken" | "lighten"
  | "color-dodge" | "color-burn" | "hard-light" | "soft-light"
  | "difference" | "exclusion" | "hue" | "saturation" | "color" | "luminosity";
export const BlendModeSchema = z.enum([
  "normal", "multiply", "screen", "overlay", "darken", "lighten",
  "color-dodge", "color-burn", "hard-light", "soft-light",
  "difference", "exclusion", "hue", "saturation", "color", "luminosity",
]);

// --- unified fill model ---------------------------------------------

export interface GradientStop {
  position: number; // 0..1
  color: Color; // per-stop alpha via color.srgb.a
}
export const GradientStopSchema = z.object({ position: channel, color: ColorSchema });

export interface MeshPoint {
  x: number;
  y: number;
  color: Color;
}
export const MeshPointSchema = z.object({ x: unit, y: unit, color: ColorSchema });

export type GradientType = "linear" | "radial" | "conic" | "mesh";

export interface SolidFill {
  type: "solid";
  color: Color;
}
export interface GradientFill {
  type: "gradient";
  gradient: GradientType;
  stops: GradientStop[]; // 2..N for linear/radial/conic
  angle?: number; // degrees, linear/conic
  center?: { x: number; y: number }; // normalized, radial/conic
  radius?: number; // normalized, radial
  mesh?: { rows: number; cols: number; points: MeshPoint[] };
}
export interface PatternFill {
  type: "pattern";
  assetId: string;
  scale: number;
  rotation?: number;
  repeat: "tile" | "mirror" | "no-repeat";
}

export type Fill = SolidFill | GradientFill | PatternFill | ImageFill;

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

export interface Stroke {
  fill: Fill;
  width: number;
  align: "inside" | "center" | "outside";
  cap: "butt" | "round" | "square";
  join: "miter" | "round" | "bevel";
  dash?: number[];
  miterLimit?: number;
}
export const StrokeSchema = z.object({
  fill: FillSchema,
  width: z.number(),
  align: z.enum(["inside", "center", "outside"]),
  cap: z.enum(["butt", "round", "square"]),
  join: z.enum(["miter", "round", "bevel"]),
  dash: z.array(z.number()).optional(),
  miterLimit: z.number().optional(),
});

export interface Shadow {
  type: "drop" | "inner";
  color: Color;
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
}
const shadowFields = {
  type: z.enum(["drop", "inner"]),
  color: ColorSchema,
  offsetX: unit,
  offsetY: unit,
  blur: z.number(),
  spread: z.number(),
};

export interface AdjustmentOp {
  name: string;
  value: number;
}
export const AdjustmentOpSchema = z.object({ name: z.string(), value: z.number() });

// Duotone (F24): maps image luminance to a two-color gradient, dark pixels to
// `shadows` and light pixels to `highlights`, blended by `intensity` (0..1).
// Rendered by the engine to a cached offscreen buffer, not as a CSS filter.
export interface Duotone {
  shadows: Color;
  highlights: Color;
  intensity: number;
}
const duotoneFields = {
  shadows: ColorSchema,
  highlights: ColorSchema,
  intensity: z.number(),
};

export type Effect =
  | (Shadow & { kind: "shadow" })
  | { kind: "blur"; radius: number }
  | { kind: "glow"; color: Color; radius: number }
  | { kind: "outline"; color: Color; width: number }
  | { kind: "adjustment"; ops: AdjustmentOp[] }
  | (Duotone & { kind: "duotone" });
export const EffectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("shadow"), ...shadowFields }),
  z.object({ kind: z.literal("blur"), radius: z.number() }),
  z.object({ kind: z.literal("glow"), color: ColorSchema, radius: z.number() }),
  z.object({ kind: z.literal("outline"), color: ColorSchema, width: z.number() }),
  z.object({ kind: z.literal("adjustment"), ops: z.array(AdjustmentOpSchema) }),
  z.object({ kind: z.literal("duotone"), ...duotoneFields }),
]);

export interface CornerRadius {
  topLeft: number;
  topRight: number;
  bottomRight: number;
  bottomLeft: number;
}
export const CornerRadiusSchema = z.object({
  topLeft: z.number(),
  topRight: z.number(),
  bottomRight: z.number(),
  bottomLeft: z.number(),
});

export interface ElementLink {
  kind: "url" | "page" | "anchor" | "email";
  target: string;
}
export const ElementLinkSchema = z.object({
  kind: z.enum(["url", "page", "anchor", "email"]),
  target: z.string(),
});

// --- animation, interactivity, page transition, photo motion --------
// Additive in schema v6. NodeBase gains an optional typed `animation`
// (entrance/exit/emphasis), `interaction`, and keeps `link` (folded into the
// interaction model at runtime). Page gains an optional `transition`, ImageNode
// an optional `motion`. Older files validate unchanged; the v5 -> v6 migration
// lifts the legacy single-entry `animations[0]` shape into `animation.entrance`.

/** Named easing curves shared by the playback engine (engine `evalEasing`). */
export type Easing = "linear" | "ease-in" | "ease-out" | "ease-in-out" | "spring" | "ease-in-cubic" | "ease-out-cubic" | "ease-out-back" | "bounce";
export const EasingSchema = z.enum(["linear", "ease-in", "ease-out", "ease-in-out", "spring", "ease-in-cubic", "ease-out-cubic", "ease-out-back", "bounce"]);

export type EntrancePreset = "fade" | "rise" | "pan" | "pop" | "drift" | "breathe-in" | "typewriter" | "word-wipe" | "tumble" | "stomp" | "zoom-in";
export type ExitPreset = "fade-out" | "sink" | "pop-out" | "drift-out" | "tumble-out" | "zoom-out";
export type EmphasisPreset = "pulse" | "wiggle" | "spin" | "breathe" | "tada" | "flicker" | "jiggle" | "bob";
/** Any animation preset across the three triggers (used by the timeline). */
export type AnimationPreset = EntrancePreset | ExitPreset | EmphasisPreset;

export const EntrancePresetSchema = z.enum(["fade", "rise", "pan", "pop", "drift", "breathe-in", "typewriter", "word-wipe", "tumble", "stomp", "zoom-in"]);
export const ExitPresetSchema = z.enum(["fade-out", "sink", "pop-out", "drift-out", "tumble-out", "zoom-out"]);
export const EmphasisPresetSchema = z.enum(["pulse", "wiggle", "spin", "breathe", "tada", "flicker", "jiggle", "bob"]);

/** How a clip's start is timed relative to the preceding animated sibling
 *  (entrance sequencing): an explicit delay, together with the previous element,
 *  or after the previous element finishes. */
export type AnimationStartMode = "delay" | "with-previous" | "after-previous";
/** A single element animation clip: a preset plus timing + easing. */
export interface AnimationClip<P extends string = AnimationPreset> {
  preset: P;
  durationMs: number;
  delayMs: number;
  easing: Easing;
  /** Entrance sequencing across siblings (default "delay"). */
  startMode?: AnimationStartMode;
  /** Optional custom cubic-bezier timing [x1,y1,x2,y2] (CSS-style). When present
   *  it overrides `easing`, enabling a freeform curve editor. */
  bezier?: [number, number, number, number];
}
function animationClipSchema<P extends string>(preset: z.ZodType<P>) {
  return z.object({
    preset,
    durationMs: z.number().nonnegative(),
    delayMs: z.number().nonnegative(),
    easing: EasingSchema,
    startMode: z.enum(["delay", "with-previous", "after-previous"]).optional(),
    bezier: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  });
}

/** A single keyframe on the custom timeline (F25 FR-3). Channels are deltas over
 *  the node's resting pose (matching the engine AnimPatch): dx/dy in px, scale
 *  multiplier, rotate in degrees, opacity 0..1 multiplier. `t` is ms from the
 *  track start; `easing` is the curve to the NEXT keyframe. Omitted channels keep
 *  the identity (dx/dy/rotate 0, scale/opacity 1). */
export interface Keyframe {
  t: number;
  dx?: number;
  dy?: number;
  scale?: number;
  rotate?: number;
  opacity?: number;
  easing?: Easing;
}
export const KeyframeSchema = z.object({
  t: z.number().nonnegative(),
  dx: z.number().optional(),
  dy: z.number().optional(),
  scale: z.number().optional(),
  rotate: z.number().optional(),
  opacity: z.number().optional(),
  easing: EasingSchema.optional(),
});

/** A per-element keyframe timeline (F25 FR-1/3): an ordered set of keyframes
 *  evaluated over `durationMs`, optionally looping. */
export interface KeyframeTrack {
  durationMs: number;
  loop?: boolean;
  keyframes: Keyframe[];
}
export const KeyframeTrackSchema = z.object({
  durationMs: z.number().positive(),
  loop: z.boolean().optional(),
  keyframes: z.array(KeyframeSchema),
});

/** Per-node animation set: an entrance (slide-enter), an exit (slide-leave),
 *  an emphasis (loops while idle), and an optional custom keyframe timeline. All
 *  slots optional and additive. */
export interface NodeAnimation {
  entrance?: AnimationClip<EntrancePreset>;
  exit?: AnimationClip<ExitPreset>;
  emphasis?: AnimationClip<EmphasisPreset>;
  custom?: KeyframeTrack;
}
export const NodeAnimationSchema = z.object({
  entrance: animationClipSchema(EntrancePresetSchema).optional(),
  exit: animationClipSchema(ExitPresetSchema).optional(),
  emphasis: animationClipSchema(EmphasisPresetSchema).optional(),
  custom: KeyframeTrackSchema.optional(),
});

/** What an interaction trigger does. `openLink` reuses the node's ElementLink
 *  shape so the legacy hyperlink folds in without a second URL store. */
export type InteractionAction =
  | { kind: "none" }
  | { kind: "navigate"; to: "next" | "prev" | "first" | "last" | "page"; pageId?: string }
  | { kind: "open-link"; link: ElementLink };
export const InteractionActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("navigate"),
    to: z.enum(["next", "prev", "first", "last", "page"]),
    pageId: z.string().optional(),
  }),
  z.object({ kind: z.literal("open-link"), link: ElementLinkSchema }),
]);

/** A node interaction: a pointer trigger bound to an action. */
export interface Interaction {
  trigger: "click" | "hover";
  action: InteractionAction;
}
export const InteractionSchema = z.object({
  trigger: z.enum(["click", "hover"]),
  action: InteractionActionSchema,
});

/** Per-page slide transition, applied when advancing to this page (FR-6). */
export interface PageTransition {
  type: "none" | "fade" | "slide" | "push" | "dissolve" | "morph-lite" | "wipe" | "flip" | "zoom" | "morph";
  direction?: "left" | "right" | "up" | "down";
  durationMs: number;
}
export const PageTransitionSchema = z.object({
  type: z.enum(["none", "fade", "slide", "push", "dissolve", "morph-lite", "wipe", "flip", "zoom", "morph"]),
  direction: z.enum(["left", "right", "up", "down"]).optional(),
  durationMs: z.number().nonnegative(),
});

/** Photo motion on an ImageNode: a slow zoom/pan during present-mode display. */
export interface ImageMotion {
  kind: "kenburns" | "parallax";
  intensity: number; // 0..1
}
export const ImageMotionSchema = z.object({
  kind: z.enum(["kenburns", "parallax"]),
  intensity: z.number().min(0).max(1),
});

// --- vector path (shared by booleans, masks, connectors) ------------
// The path anchor is `VectorAnchor` (not "PathNode") to avoid clashing with the
// doc-02 `PathNode` scene node (type: "path").

export interface VectorAnchor {
  x: number;
  y: number;
  inHandle?: { x: number; y: number };
  outHandle?: { x: number; y: number };
  corner?: boolean;
}
const handle = z.object({ x: z.number(), y: z.number() });
export const VectorAnchorSchema = z.object({
  x: unit,
  y: unit,
  inHandle: handle.optional(),
  outHandle: handle.optional(),
  corner: z.boolean().optional(),
});

export interface SubPath {
  closed: boolean;
  anchors: VectorAnchor[];
}
export const SubPathSchema = z.object({
  closed: z.boolean(),
  anchors: z.array(VectorAnchorSchema),
});

export interface VectorPath {
  subpaths: SubPath[];
  fillRule: "nonzero" | "evenodd";
}
export const VectorPathSchema = z.object({
  subpaths: z.array(SubPathSchema),
  fillRule: z.enum(["nonzero", "evenodd"]),
});

// ---------------------------------------------------------------------------
// Section 6.1: file-level resources
// ---------------------------------------------------------------------------

export interface Guide {
  axis: "x" | "y";
  position: number;
}
export const GuideSchema = z.object({ axis: z.enum(["x", "y"]), position: z.number() });

export interface AssetRef {
  id: string;
  kind: "image" | "video" | "audio" | "svg" | "lottie" | "model3d" | "font";
  url: string;
  mime: string;
  width?: number;
  height?: number;
  durationMs?: number;
  checksum?: string;
}
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

export interface FontRef {
  id: string;
  family: string;
  source: "system" | "google" | "upload" | "library";
  url?: string;
  axes?: Record<string, number>; // variable-font axis defaults
  // additions (optional, additive): per-style files and axis ranges.
  files?: { style: string; url: string; format: "ttf" | "otf" | "woff" | "woff2"; variable?: boolean }[];
  variableAxes?: { tag: string; min: number; max: number; default: number }[];
}
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

export interface ColorSwatch {
  id: string;
  name?: string;
  color: Color;
}
export const ColorSwatchSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  color: ColorSchema,
});

// ---------------------------------------------------------------------------
// Section 6.3: node base + node union
// ---------------------------------------------------------------------------

export type NodeType =
  | "text" | "image" | "shape" | "line" | "path" | "icon" | "sticker"
  | "group" | "frame" | "grid" | "video" | "audio" | "table" | "chart"
  | "embed" | "qr" | "model3d"
  | "connector" | "mask" | "boolean" // (additive)
  | "sticky" // (additive)
  | "ink" | "mindmap" | "boardview" | "diagramcode" | "stamp"; // F30 (additive)

// Node types with a concrete schema today. `model3d` is reserved/deferred
// (Section 2), so it is intentionally absent here and is validated by its base
// alone, like any newer/unknown type.
export const KNOWN_NODE_TYPES: readonly NodeType[] = [
  "text", "image", "shape", "line", "path", "icon", "sticker",
  "group", "frame", "grid", "video", "audio", "table", "chart",
  "embed", "qr", "connector", "mask", "boolean", "sticky",
  "ink", "mindmap", "boardview", "diagramcode", "stamp",
] as const;

const KNOWN_NODE_TYPE_SET = new Set<string>(KNOWN_NODE_TYPES);
export function isKnownNodeType(type: string): type is NodeType {
  return KNOWN_NODE_TYPE_SET.has(type);
}

export interface NodeBase {
  id: string;
  type: NodeType;
  transform: Transform;
  size: Size;
  opacity: number;
  blendMode: BlendMode;
  effects?: Effect[];
  constraints?: Constraints;
  locked?: boolean;
  hidden?: boolean;
  name?: string;
  link?: ElementLink;
  animations?: unknown[];
  // typed per-node animation set + interaction (additive, optional).
  animation?: NodeAnimation;
  interaction?: Interaction;
  // Manipulation metadata; optional and non-geometric.
  aspectLocked?: boolean;
  opticalAlign?: boolean;
  data?: Record<string, unknown>;
}

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
  aspectLocked: z.boolean().optional(),
  opticalAlign: z.boolean().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
};

/** Base fields common to every node, with `type` left open (used to validate
 *  unknown/newer node types by their base alone; see validate.ts, FR-3). */
export const NodeBaseSchema = z.object({ ...nodeBaseFields, type: z.string() });

// ---------------------------------------------------------------------------
// Section 6.4: concrete node types
// ---------------------------------------------------------------------------

export interface TextRun {
  text: string;
  fontId: string;
  fontSize: number;
  weight: number;
  italic?: boolean;
  letterSpacing?: number;
  lineHeight?: number;
  color?: Color;
  decoration?: ("underline" | "strikethrough")[];
  features?: Record<string, number>;
}
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

// --- rich text model (schema v2) -----------------------------------
// A text node is a paragraph/run tree so it round-trips losslessly and maps to
// the CRDT. Note: text-specific effects are stored as `textEffects` to avoid
// clashing with NodeBase.effects (the generic doc-03 node effect slot).

export type StyleId = string;

export interface CharStyle {
  fontFamily: string;
  fontStyle: string;
  axes?: Record<string, number>;
  fontSize: number;
  fill: Fill;
  letterSpacing?: number;
  kerning?: "auto" | "optical" | "metric" | number;
  lineHeight?: number | { mode: "auto" | "multiple" | "absolute"; value: number };
  baselineShift?: number;
  case?: "none" | "upper" | "lower" | "title" | "smallcaps";
  decoration?: ("underline" | "strikethrough")[];
  script?: "normal" | "sub" | "super";
  language?: string;
  features?: Record<string, number>;
  /** Hyperlink target for this run (per-range link). Absolute URL or anchor. */
  link?: string;
}
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

export interface Run {
  text: string;
  style: CharStyle;
  charStyleId?: StyleId;
  overrides?: Partial<CharStyle>;
}
export const RunSchema = z.object({
  text: z.string(),
  style: CharStyleSchema,
  charStyleId: z.string().optional(),
  overrides: CharStyleSchema.partial().optional(),
});

export interface ParagraphStyle {
  align: "left" | "center" | "right" | "justify";
  direction: "ltr" | "rtl" | "auto";
  indentStart?: number;
  indentEnd?: number;
  firstLineIndent?: number;
  spaceBefore?: number;
  spaceAfter?: number;
  list?: { type: "bullet" | "number" | "checklist"; level: number; marker?: string };
  tabStops?: number[];
  baseChar?: Partial<CharStyle>;
}
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

export interface Paragraph {
  runs: Run[];
  style: ParagraphStyle;
  paraStyleId?: StyleId;
  overrides?: Partial<ParagraphStyle>;
}
export const ParagraphSchema = z.object({
  runs: z.array(RunSchema),
  style: ParagraphStyleSchema,
  paraStyleId: z.string().optional(),
  overrides: ParagraphStyleSchema.partial().optional(),
});

export interface TextBox {
  mode: "fixed" | "autoHeight" | "autoWidth";
  width: number;
  height: number;
  columns?: { count: number; gutter: number };
  padding?: { t: number; r: number; b: number; l: number };
  autoFit?: { enabled: boolean; min: number; max: number };
  verticalAlign?: "top" | "middle" | "bottom";
}
export const TextBoxSchema = z.object({
  mode: z.enum(["fixed", "autoHeight", "autoWidth"]),
  width: unit,
  height: unit,
  columns: z.object({ count: z.number().int().positive(), gutter: z.number() }).optional(),
  padding: z.object({ t: z.number(), r: z.number(), b: z.number(), l: z.number() }).optional(),
  autoFit: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }).optional(),
  verticalAlign: z.enum(["top", "middle", "bottom"]).optional(),
});

export type TextFlow =
  | { kind: "horizontal" }
  | { kind: "vertical"; columnOrder: "rtl" | "ltr" }
  | { kind: "path"; pathRef: string; offset: number; side: "above" | "below" | "inside" | "outside"; flip?: boolean }
  | { kind: "arc"; curvature: number };
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

export type TextEffect =
  | { kind: "shadow"; dx: number; dy: number; blur: number; color: Fill; opacity: number }
  | { kind: "outline"; width: number; color: Fill; join: "miter" | "round" | "bevel" }
  | { kind: "glow"; radius: number; color: Fill; intensity: number }
  | { kind: "echo"; offset: number; count: number; color: Fill }
  | { kind: "neon"; color: Fill; intensity: number }
  | { kind: "splice"; thickness: number; offset: number; color: Fill }
  | { kind: "highlight"; color: Fill; padding: number; radius: number }
  | { kind: "lift"; intensity: number }
  | { kind: "hollow"; thickness: number };
export const TextEffectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("shadow"), dx: z.number(), dy: z.number(), blur: z.number(), color: FillSchema, opacity: channel }),
  z.object({ kind: z.literal("outline"), width: z.number(), color: FillSchema, join: z.enum(["miter", "round", "bevel"]) }),
  z.object({ kind: z.literal("glow"), radius: z.number(), color: FillSchema, intensity: z.number() }),
  z.object({ kind: z.literal("echo"), offset: z.number(), count: z.number().int(), color: FillSchema }),
  z.object({ kind: z.literal("neon"), color: FillSchema, intensity: z.number() }),
  z.object({ kind: z.literal("splice"), thickness: z.number(), offset: z.number(), color: FillSchema }),
  z.object({ kind: z.literal("highlight"), color: FillSchema, padding: z.number(), radius: z.number() }),
  z.object({ kind: z.literal("lift"), intensity: z.number() }),
  z.object({ kind: z.literal("hollow"), thickness: z.number() }),
]);

export interface TextNode extends NodeBase {
  type: "text";
  box: TextBox;
  content: Paragraph[];
  flow?: TextFlow;
  textEffects?: TextEffect[]; // "effects"; renamed to avoid NodeBase.effects clash
  styleRefs?: { defaultParagraph?: StyleId };
}
export const TextNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("text"),
  box: TextBoxSchema,
  content: z.array(ParagraphSchema),
  flow: TextFlowSchema.optional(),
  textEffects: z.array(TextEffectSchema).optional(),
  styleRefs: z.object({ defaultParagraph: z.string().optional() }).optional(),
});

export interface TextStyleSheet {
  paragraphStyles: Record<StyleId, { name: string; style: ParagraphStyle; basedOn?: StyleId }>;
  charStyles: Record<StyleId, { name: string; style: CharStyle; basedOn?: StyleId }>;
}

const cropSchema = z.object({ x: unit, y: unit, width: unit, height: unit }); // pixel crop (video)

// ImageNode uses the image value types (ImageFit/CropRect/ClipPath/ImageSource,
// and ImageFill in the Fill union) defined near the Fill model above.

export interface ImageNode extends NodeBase {
  type: "image";
  source: ImageSource;
  fit: ImageFit;
  crop?: CropRect;
  clip?: ClipPath;
  focalPoint?: { x: number; y: number };
  flipX?: boolean;
  flipY?: boolean;
  effectivePpi?: number;
  motion?: ImageMotion; // photo motion (ken-burns/parallax)
  /** Accessibility alt text (F22 FR-12). Optional + additive, so older files
   *  still validate with no migration; AI alt-text and a11y export read it. */
  alt?: string;
}
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
  alt: z.string().optional(),
});

export interface ShapeNode extends NodeBase {
  type: "shape";
  shape: "rect" | "ellipse" | "polygon" | "star" | "triangle" | "custom";
  cornerRadius?: CornerRadius;
  sides?: number;
  innerRadius?: number;
  pathData?: string;
  fills: Fill[];
  stroke?: Stroke;
}
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

export interface LineNode extends NodeBase {
  type: "line";
  points: { x: number; y: number }[];
  stroke: Stroke;
  startCap?: "none" | "arrow" | "circle" | "diamond";
  endCap?: "none" | "arrow" | "circle" | "diamond";
}
const capSchema = z.enum(["none", "arrow", "circle", "diamond"]);
export const LineNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("line"),
  points: z.array(z.object({ x: unit, y: unit })).min(2),
  stroke: StrokeSchema,
  startCap: capSchema.optional(),
  endCap: capSchema.optional(),
});

export interface PathSegment {
  x: number;
  y: number;
  cIn?: { x: number; y: number };
  cOut?: { x: number; y: number };
  /** True when this anchor is a hard corner (handles, if any, move
   *  independently). Smooth anchors keep their in/out handles mirrored while
   *  dragging. Optional and additive: an older file omits it, and the node
   *  editor infers corner-ness from the absence of handles. */
  corner?: boolean;
}
const pointSchema = z.object({ x: unit, y: unit });
export const PathSegmentSchema = z.object({
  x: unit,
  y: unit,
  cIn: pointSchema.optional(),
  cOut: pointSchema.optional(),
  corner: z.boolean().optional(),
});

export interface PathNode extends NodeBase {
  type: "path";
  segments: PathSegment[];
  closed: boolean;
  fills?: Fill[];
  stroke?: Stroke;
}
export const PathNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("path"),
  segments: z.array(PathSegmentSchema),
  closed: z.boolean(),
  fills: z.array(FillSchema).optional(),
  stroke: StrokeSchema.optional(),
});

export interface IconNode extends NodeBase {
  type: "icon";
  assetId: string;
  fills?: Fill[];
}
export const IconNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("icon"),
  assetId: z.string(),
  fills: z.array(FillSchema).optional(),
});

export interface StickerNode extends NodeBase {
  type: "sticker";
  assetId: string;
  animated?: boolean;
}
export const StickerNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("sticker"),
  assetId: z.string(),
  animated: z.boolean().optional(),
});

export interface GroupNode extends NodeBase {
  type: "group";
  children: Node[];
  clip?: boolean;
  isolation?: boolean; // transient editor hint; not required to persist
}
export const GroupNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("group"),
  isolation: z.boolean().optional(),
  get children() {
    return z.array(NodeSchema);
  },
  clip: z.boolean().optional(),
});

export interface AutoLayout {
  direction: "row" | "column";
  gap: number;
  padding: { top: number; right: number; bottom: number; left: number };
  align: "start" | "center" | "end" | "stretch";
}
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

// A board section header: a title-bar slot turning a plain layout/clip frame
// into a named, colored region (FR-12). Additive and optional.
export interface FrameHeader {
  title: string;
  fill?: Fill;
  textColor?: Color;
}
export const FrameHeaderSchema = z.object({
  title: z.string(),
  fill: FillSchema.optional(),
  textColor: ColorSchema.optional(),
});

export interface FrameNode extends NodeBase {
  type: "frame";
  children: Node[];
  clip: boolean;
  maskShape?: "rect" | "ellipse" | "custom";
  maskPath?: string;
  fills?: Fill[];
  cornerRadius?: CornerRadius;
  autoLayout?: AutoLayout;
  // Board-section semantics (F30 FR-12): a header title-bar and a collapse
  // state so a frame can act as a FigJam Section / Mural Area. Additive.
  header?: FrameHeader;
  collapsed?: boolean;
}
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

export interface GridCell {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  childId?: string;
}
export const GridCellSchema = z.object({
  row: z.number().int(),
  col: z.number().int(),
  rowSpan: z.number().int(),
  colSpan: z.number().int(),
  childId: z.string().optional(),
});

export interface GridNode extends NodeBase {
  type: "grid";
  rows: number;
  cols: number;
  gap: number;
  cells: GridCell[];
  children: Node[];
}
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
});

export interface VideoNode extends NodeBase {
  type: "video";
  assetId: string;
  trimStartMs?: number;
  trimEndMs?: number;
  volume: number;
  muted?: boolean;
  loop?: boolean;
  crop?: { x: number; y: number; width: number; height: number };
}
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

export interface AudioNode extends NodeBase {
  type: "audio";
  assetId: string;
  trimStartMs?: number;
  trimEndMs?: number;
  volume: number;
  fadeInMs?: number;
  fadeOutMs?: number;
}
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

export interface TableCell {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  content: TextRun[];
  fill?: Fill;
  align?: "left" | "center" | "right";
  /** v7 (F27): optional explicit text color, overriding the run/default color. */
  textColor?: Color;
}
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

/** v7 (F27): a styled header row (filled + bold first row) and simple table-wide
 *  border styling (color/width/visibility). All optional and additive. */
export interface TableHeaderStyle {
  enabled: boolean;
  fill?: Fill;
  textColor?: Color;
  bold?: boolean;
}
export const TableHeaderStyleSchema = z.object({
  enabled: z.boolean(),
  fill: FillSchema.optional(),
  textColor: ColorSchema.optional(),
  bold: z.boolean().optional(),
});

export interface TableBorderStyle {
  show: boolean;
  color?: Color;
  width?: number;
}
export const TableBorderStyleSchema = z.object({
  show: z.boolean(),
  color: ColorSchema.optional(),
  width: z.number().nonnegative().optional(),
});

/** v8 (F27): a live data binding for a chart or table. `inline` re-parses the
 *  stored CSV/TSV; `url` re-fetches it. Refresh updates the node's data from the
 *  source. Additive + optional. */
export interface DataBinding {
  kind: "inline" | "url";
  csv?: string;
  url?: string;
  hasHeaderRow?: boolean;
  refreshedAt?: string;
}
export const DataBindingSchema = z.object({
  kind: z.enum(["inline", "url"]),
  csv: z.string().optional(),
  url: z.string().optional(),
  hasHeaderRow: z.boolean().optional(),
  refreshedAt: z.string().optional(),
});

/** v8 (F27): conditional formatting rules for a table. Each rule targets a
 *  column (`column`) or the whole data area (undefined), and derives per-cell
 *  styling from the cell's numeric value. Evaluated in order; later rules win
 *  for overlapping cells. Header row (when enabled) is excluded. Additive. */
export type TableConditionalRule =
  | { kind: "highlight"; op: ">" | "<" | ">=" | "<=" | "==" | "!="; value: number; fill?: Fill; textColor?: Color; column?: number }
  | { kind: "colorScale"; min: Color; max: Color; column?: number }
  | { kind: "dataBar"; color: Color; column?: number };
export const TableConditionalRuleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("highlight"), op: z.enum([">", "<", ">=", "<=", "==", "!="]), value: z.number(), fill: FillSchema.optional(), textColor: ColorSchema.optional(), column: z.number().int().optional() }),
  z.object({ kind: z.literal("colorScale"), min: ColorSchema, max: ColorSchema, column: z.number().int().optional() }),
  z.object({ kind: z.literal("dataBar"), color: ColorSchema, column: z.number().int().optional() }),
]);

export interface TableNode extends NodeBase {
  type: "table";
  rows: number;
  cols: number;
  colWidths: number[];
  rowHeights: number[];
  cells: TableCell[];
  borders?: Stroke;
  /** v7 (F27): header-row styling and border styling. */
  headerStyle?: TableHeaderStyle;
  borderStyle?: TableBorderStyle;
  /** v8 (F27): conditional formatting rules. */
  conditional?: TableConditionalRule[];
  /** v8 (F27): live data binding. */
  binding?: DataBinding;
}
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

export interface ChartSeries {
  name: string;
  values: number[];
  color?: Color;
}
export const ChartSeriesSchema = z.object({
  name: z.string(),
  values: z.array(z.number()),
  color: ColorSchema.optional(),
});

// v7 (F27): `barStacked`/`barGrouped` are additive bar variants; `scatter` and
// `radar` already existed in the union and now have real engine renderers.
export type ChartType =
  | "bar" | "barStacked" | "barGrouped" | "line" | "pie" | "donut" | "area"
  | "scatter" | "radar" | "gauge" | "funnel" | "progress";
export const ChartTypeSchema = z.enum([
  "bar", "barStacked", "barGrouped", "line", "pie", "donut", "area",
  "scatter", "radar", "gauge", "funnel", "progress",
]);

/** v7 (F27): additive chart styling. All fields optional so older charts (no
 *  `style`) keep rendering with engine defaults; per-series color also still
 *  honors `ChartSeries.color`. */
export type LegendPosition = "top" | "right" | "bottom" | "left";
export interface ChartStyle {
  title?: string;
  legend?: { show: boolean; position: LegendPosition };
  valueLabels?: boolean;
  axes?: {
    showX?: boolean;
    showY?: boolean;
    xLabel?: string;
    yLabel?: string;
  };
}
export const ChartStyleSchema = z.object({
  title: z.string().optional(),
  legend: z.object({ show: z.boolean(), position: z.enum(["top", "right", "bottom", "left"]) }).optional(),
  valueLabels: z.boolean().optional(),
  axes: z
    .object({
      showX: z.boolean().optional(),
      showY: z.boolean().optional(),
      xLabel: z.string().optional(),
      yLabel: z.string().optional(),
    })
    .optional(),
});

export interface ChartNode extends NodeBase {
  type: "chart";
  chartType: ChartType;
  series: ChartSeries[];
  categories: string[];
  options: Record<string, unknown>;
  dataSourceId?: string;
  /** v7 (F27): title/legend/axes/value-label styling. */
  style?: ChartStyle;
  /** v8 (F27): live data binding. */
  binding?: DataBinding;
}
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

export interface EmbedNode extends NodeBase {
  type: "embed";
  provider: "youtube" | "vimeo" | "maps" | "iframe" | string;
  src: string;
  poster?: string;
}
export const EmbedNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("embed"),
  provider: z.string(),
  src: z.string(),
  poster: z.string().optional(),
});

export interface QRNode extends NodeBase {
  type: "qr";
  value: string;
  ecLevel: "L" | "M" | "Q" | "H";
  foreground: Color;
  background: Color;
  logoAssetId?: string;
  /** Scannable module bit-matrix (row-major, true = dark). Derived from `value`
   *  by the editor; the renderer draws it. Absent until generated. */
  modules?: boolean[][];
}
export const QRNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("qr"),
  value: z.string(),
  ecLevel: z.enum(["L", "M", "Q", "H"]),
  foreground: ColorSchema,
  background: ColorSchema,
  logoAssetId: z.string().optional(),
  modules: z.array(z.array(z.boolean())).optional(),
});

// --- structural node types (additive) -------------------------------

export type Cap = { kind: "none" | "arrow" | "triangle" | "dot"; size: number };
const CapSchema = z.object({ kind: z.enum(["none", "arrow", "triangle", "dot"]), size: z.number() });

export interface EndPoint {
  point?: { x: number; y: number };
  // `anchor` stays an opaque string; the optional `port` names a per-side slot
  // so multiple connectors on one node do not stack on a single midpoint (F30
  // FR-8). Purely additive: older files omit it.
  attach?: { nodeId: string; anchor: string; port?: string };
}
const EndPointSchema = z.object({
  point: z.object({ x: unit, y: unit }).optional(),
  attach: z.object({ nodeId: z.string(), anchor: z.string(), port: z.string().optional() }).optional(),
});

// A text label riding a connector, positioned 0..1 along its path (F30 FR-8).
export interface ConnectorLabel {
  text: string;
  position?: number;
}
const ConnectorLabelSchema = z.object({
  text: z.string(),
  position: z.number().min(0).max(1).optional(),
});

export interface ConnectorNode extends NodeBase {
  type: "connector";
  route: "straight" | "elbow" | "curved";
  start: EndPoint;
  end: EndPoint;
  stroke: Stroke;
  startCap?: Cap;
  endCap?: Cap;
  // Diagramming enrichments (F30 FR-8), all additive: a label, draggable
  // multi-bend waypoints, and a jump-over hop at line crossings.
  label?: ConnectorLabel;
  waypoints?: { x: number; y: number }[];
  jumpOver?: boolean;
}
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

export interface MaskNode extends NodeBase {
  type: "mask";
  maskShape: VectorPath;
  child: Node;
  childInner?: Transform;
}
export const MaskNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("mask"),
  maskShape: VectorPathSchema,
  get child() {
    return NodeSchema;
  },
  childInner: TransformSchema.optional(),
});

export interface BooleanNode extends NodeBase {
  type: "boolean";
  op: "union" | "subtract" | "intersect" | "exclude";
  operands: ShapeNode[];
  result?: VectorPath;
  fills?: Fill[];
  stroke?: Stroke;
}
export const BooleanNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("boolean"),
  op: z.enum(["union", "subtract", "intersect", "exclude"]),
  operands: z.array(ShapeNodeSchema),
  result: VectorPathSchema.optional(),
  fills: z.array(FillSchema).optional(),
  stroke: StrokeSchema.optional(),
});

// --- whiteboard (additive) ------------------------------------------

// A sticky note (FR-3): constrained text on a colored card that auto-fits its
// font and can grow vertically. `fontScale` is the auto-fit multiplier applied
// to a base size; `frameId` records the owning frame/section when parented.
export interface StickyNode extends NodeBase {
  type: "sticky";
  text: string;
  fill: Fill;
  textColor: Color;
  fontFamily?: string;
  align?: "left" | "center" | "right";
  fontScale: number;
  autoSize: boolean;
  frameId?: string;
  // Author attribution for color-by-author / sort-by-author (F30), and a
  // non-square silhouette. Both additive and optional.
  authorId?: string;
  shape?: "square" | "rectangle" | "circle";
}
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

// --- F30 board node types (additive) --------------------------------
// Each is a board-native scene node: older files never contain them, newer
// clients preserve them via UnknownNode, so the v9 -> v10 bump is additive.

// Ink/draw stroke: a raw point stream with optional pressure (`p`) and time
// (`t`) samples, distinct from PathNode's bezier anchors and decimated/smoothed
// for performance (FR-5). `mode` selects pen / marker / highlighter rendering.
export interface InkPoint {
  x: number;
  y: number;
  p?: number;
  t?: number;
}
export interface InkNode extends NodeBase {
  type: "ink";
  points: InkPoint[];
  smoothing: number;
  seed?: number;
  brush: { width: number; opacity: number; color: Color; mode: "pen" | "marker" | "highlighter" };
}
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

// Mind-map node capturing parent/child branch topology so radial/balanced
// layout is first-class (FR-11), rather than inferred from connectors.
export interface MindMapBranch {
  id: string;
  parentId: string | null;
  label: string;
  childIds: string[];
}
export interface MindMapNode extends NodeBase {
  type: "mindmap";
  rootId: string;
  branches: MindMapBranch[];
  direction: "radial" | "right" | "balanced";
}
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

// Kanban / multi-view dataset node: columns + cards rendered as a board widget
// (kanban now, table/timeline later) over one dataset.
export interface BoardViewColumn {
  id: string;
  title: string;
  cardIds: string[];
}
export interface BoardViewCard {
  id: string;
  title: string;
  tags?: string[];
  estimate?: number;
}
export interface BoardViewNode extends NodeBase {
  type: "boardview";
  view: "kanban" | "table" | "timeline";
  columns: BoardViewColumn[];
  cards: BoardViewCard[];
}
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

// Diagram-as-code node: the source text is the source of truth, with the ids of
// the materialized child nodes recorded so it can re-flow on source edit (FR-9).
export interface DiagramCodeNode extends NodeBase {
  type: "diagramcode";
  lang: "mermaid" | "plantuml" | "dot";
  source: string;
  materializedIds?: string[];
}
export const DiagramCodeNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("diagramcode"),
  lang: z.enum(["mermaid", "plantuml", "dot"]),
  source: z.string(),
  materializedIds: z.array(z.string()).optional(),
});

// Emoji-stamp / vote-marker placed primitive (FR-21), distinct from asset-id
// stickers; `kind: "vote"` backs dot-vote placement.
export interface StampNode extends NodeBase {
  type: "stamp";
  kind: "emoji" | "vote";
  glyph: string;
  authorId?: string;
}
export const StampNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.literal("stamp"),
  kind: z.enum(["emoji", "vote"]),
  glyph: z.string(),
  authorId: z.string().optional(),
});

// Forward-compat placeholder for node types written by a newer client (FR-3).
// Its `type` is any string that is NOT a known type; the original node is
// preserved verbatim in `raw` for lossless round-trips (FR-12, AC-5).
export interface UnknownNode extends NodeBase {
  type: NodeType;
  raw: Record<string, unknown>;
}
export const UnknownNodeSchema = z.object({
  ...nodeBaseFields,
  type: z.string().refine((t) => !isKnownNodeType(t), {
    message: "UnknownNode.type must not be a known node type",
  }),
  raw: z.record(z.string(), z.unknown()),
}) as unknown as z.ZodType<UnknownNode>;

export type KnownNode =
  | TextNode | ImageNode | ShapeNode | LineNode | PathNode | IconNode
  | StickerNode | GroupNode | FrameNode | GridNode | VideoNode | AudioNode
  | TableNode | ChartNode | EmbedNode | QRNode
  | ConnectorNode | MaskNode | BooleanNode | StickyNode
  | InkNode | MindMapNode | BoardViewNode | DiagramCodeNode | StampNode;

export type Node = KnownNode | UnknownNode;

/** Per-type schemas for every known node type, keyed by discriminator. */
export const KNOWN_NODE_SCHEMAS = {
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

// ---------------------------------------------------------------------------
// Section 6.1: slide masters, layouts, and themes (doc 28 FR-3, FR-4)
// ---------------------------------------------------------------------------

/** A named region a layout reserves for content. `role` gives the region its
 *  meaning: the `title` placeholder is what makes a slide's name a real,
 *  screen-reader-navigable slide title (FR-3, FR-29). */
export type PlaceholderRole = "title" | "body" | "content" | "picture" | "chart" | "media" | "footer";
export const PlaceholderRoleSchema = z.enum(["title", "body", "content", "picture", "chart", "media", "footer"]);

export interface Placeholder {
  id: string;
  role: PlaceholderRole;
  rect: { x: number; y: number; width: number; height: number };
}
export const PlaceholderSchema = z.object({
  id: z.string(),
  role: PlaceholderRoleSchema,
  rect: z.object({ x: z.number(), y: z.number(), width: unit, height: unit }),
});

/** A slide master: the root of a style cascade (background + shared
 *  placeholders) that its layouts, and the pages using them, inherit. */
export interface SlideMaster {
  id: string;
  name?: string;
  /** Theme id this master styles against; falls back to the file theme. */
  theme?: string;
  background?: Fill;
  placeholders: Placeholder[];
}
export const SlideMasterSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  theme: z.string().optional(),
  background: FillSchema.optional(),
  placeholders: z.array(PlaceholderSchema),
});

/** A layout under a master (title, title+content, two-content, ...). A `Page`
 *  points at one via `layoutId`; the cascade is page -> layout -> master. */
export interface SlideLayout {
  id: string;
  masterId: string;
  name: string;
  background?: Fill;
  placeholders: Placeholder[];
}
export const SlideLayoutSchema = z.object({
  id: z.string(),
  masterId: z.string(),
  name: z.string(),
  background: FillSchema.optional(),
  placeholders: z.array(PlaceholderSchema),
});

/** A swappable deck theme: a color palette plus the heading/body font pair.
 *  Adopting a different theme restyles the whole deck in one action (FR-4). */
export interface Theme {
  id: string;
  name?: string;
  /** Ordered palette slots (PowerPoint-style 12; any length validates). */
  colors: ColorSwatch[];
  fontHeading?: string;
  fontBody?: string;
  effects?: Record<string, unknown>;
  variants?: { id: string; name?: string; colors: ColorSwatch[] }[];
}
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

// ---------------------------------------------------------------------------
// Section 6.1: page and file
// ---------------------------------------------------------------------------

export interface Page {
  id: string;
  name?: string;
  width: number;
  height: number;
  background?: Fill;
  bleed?: number;
  children: Node[];
  guides?: Guide[];
  notes?: string;
  transition?: PageTransition; // applied when advancing to this page
  // presentations (additive, optional; older files still validate):
  layoutId?: string; // slide layout this page inherits from (doc 28 FR-3)
  autoAdvanceMs?: number; // autopilot dwell before auto-advancing this slide (FR-14)
  hidden?: boolean; // slide is skipped while presenting / in autopilot (FR-1)
  timelineDuration?: number; // derived/cached total ms for this page (optional)
  data?: Record<string, unknown>;
}
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
  layoutId: z.string().optional(),
  autoAdvanceMs: z.number().optional(),
  hidden: z.boolean().optional(),
  timelineDuration: z.number().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export interface DesignFile {
  // "hycanvas.design" is the current id; "opencanva.design" is the legacy id and
  // is still accepted on load so designs saved before the rename open unchanged.
  format: "hycanvas.design" | "opencanva.design";
  schemaVersion: number;
  id: string;
  title: string;
  unit: Unit;
  dpi: number;
  colorProfile?: string;
  pages: Page[];
  assets: AssetRef[];
  fonts: FontRef[];
  palette?: ColorSwatch[];
  // Presentations (doc 28 FR-3, FR-4). All optional and additive: a deck with
  // no masters/layouts/theme behaves exactly as before, and every page whose
  // `layoutId` is absent (or dangling) renders standalone.
  masters?: SlideMaster[];
  layouts?: SlideLayout[];
  theme?: Theme;
  meta: Record<string, unknown>;
}
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
  assets: z.array(AssetRefSchema),
  fonts: z.array(FontRefSchema),
  palette: z.array(ColorSwatchSchema).optional(),
  meta: z.record(z.string(), z.unknown()),
});
