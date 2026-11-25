// @hc/schema - the open design file format: types and format constants.
//
// This is the single source of truth for the format. TypeScript interfaces are
// the public types every other package imports. The zod schemas that mirror
// them live in schemas.ts and power runtime validation (validate.ts) and JSON
// Schema generation (json-schema.ts); the schema tests hold the two together.
// They are kept out of this module so importing a type or a constant never
// pulls in zod (#77).

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
 *      a v10 deck has none of them and opens unchanged.
 *  v12: accessibility (F28 FR-29): NodeBase.altText/decorative and
 *      Page.readingOrder. All additive and optional: a v11 file omits them,
 *      alt text falls back to ImageNode.alt, and reading order falls back to
 *      z-order, exactly as before.
 *  v13: presentations (F28 FR-5) slide sections: a DesignFile.sections registry
 *      and Page.sectionId membership. Additive and optional: a v12 deck has no
 *      sections, every page stands alone, and it opens unchanged.
 *  v14: effect normalization: Shadow.type becomes optional (absence means
 *      "drop", healing shadows early panels wrote without a type), and the
 *      migration stamps it plus bakes never-rendered text-shadow opacity to 1
 *      so existing designs keep their exact published appearance.
 *  v15: compound paths: PathNode gains optional `contours` (extra subpaths,
 *      filled together with the first under the even-odd rule) so imported
 *      vector line art keeps its interior holes. Additive: older files omit
 *      it and open unchanged.
 *  v16: chart text size: ChartStyle gains optional `fontSize` (base size in px;
 *      all chart text scales from it, absence means the built-in 11). Additive:
 *      older files omit it and render unchanged.
 *  v17: QR center logo size: QRNode gains optional `logoScale` (logo size as a
 *      fraction of the QR, absence means the default 0.22). Additive: a v16 file
 *      omits it and its QR logo renders at the default size unchanged.
 *  v18: document language (F38 FR-8): DesignFile gains optional `language`
 *      (a BCP 47 tag) naming the document's primary language for assistive
 *      technology and the tagged-PDF /Lang. Additive: a v17 file omits it and
 *      exports fall back to en-US as before. The migration copies a legacy
 *      `meta.language` up (importers wrote it there); meta keeps its copy.
 *  v19: per-effect enable. `Effect` and `TextEffect` each gain an optional
 *      `enabled`, so an effect can be switched off in the reorderable stack
 *      without losing its parameters. ABSENT MEANS ENABLED: every effect
 *      written before this omits the field and must keep rendering, so the
 *      flag can only ever turn something off. Spelled `enabled` rather than
 *      `disabled` because the Go renderers already honoured exactly this check
 *      before the schema declared it.
 *  v20: non-destructive background removal. `ImageNode` gains optional
 *      `alphaMask`, a grayscale asset reference applied over `source`.
 *      Removal previously overwrote `source` with the flattened cutout, which
 *      discarded the original pixels; keeping both makes the cutout a view
 *      rather than a replacement, and therefore undoable and refinable.
 *      Additive: a v19 file has no mask and renders exactly as before.
 *  v21: placeholder capacities. `Placeholder` gains optional `maxChars`,
 *      `minChars`, `minItems`, `maxItems` - hints telling layout-grounded
 *      generation how much text a slot comfortably holds (F28 T11). Rendering
 *      never reads them, so a v20 file (no capacities) and a v21 file render
 *      identically; older clients preserve the unknown keys end to end.
 *  v22: transition polish. `PageTransition` gains optional `easing` (a plain
 *      string clamped by the engine, so unknown future values keep validating
 *      everywhere) and `Page` gains optional `transitionOut`, an exit
 *      transition composited with the arriving page's own (F28 completion
 *      C02+C03). Both additive: a v21 file renders exactly as before.
 *  v23: animation depth. `Keyframe` gains optional `color`/`width`/`height`
 *      channels, `KeyframeTrack` gains optional `path`/`orient` (motion
 *      paths), `AnimationClip` gains optional `spring` parameters, and
 *      `NodeAnimation` gains an optional media `trigger` (F28 completion
 *      C11/C12/C13/C15). All additive: a v22 file animates exactly as
 *      before, and older clients preserve the unknown keys end to end.
 *  v24: interaction actions. `Interaction` gains optional `actionV2` (a
 *      plain-string kind + optional target node), carrying play/pause/toggle
 *      media and run-animation without widening the legacy action enum, so
 *      older clients keep validating and fall back to the legacy `action`
 *      (F28 completion C16). Additive.
 *  v25: photo-grid track sizes. `GridNode` gains optional `colWidths` and
 *      `rowHeights`, relative weights that let one cell take more of the grid
 *      than its neighbours instead of every cell splitting the space evenly.
 *      Omitted means equal tracks, which is exactly how every existing grid
 *      already lays out, so an older file needs no conversion and an older
 *      client keeps laying the grid out the way it always did. Additive.
 *  v26: masonry collages. `GridNode` gains optional `masonry`, which packs the
 *      grid's images into `cols` columns sized to each image's own aspect
 *      ratio instead of a fixed row/column lattice, so a collage of mixed
 *      shapes packs without cropping or gaps.
 *
 *      A FLAG on the existing node, deliberately, not a new node type and not
 *      a new member of an existing enum. A new enum member would fail both the
 *      grid's own schema branch and the unknown-node fallback on an older
 *      client, taking the whole file down with it; a new node type would need
 *      a baked raster fallback to avoid leaving a hole. An optional flag makes
 *      an older client lay the very same cells out on its regular lattice: a
 *      different arrangement of the same images, never a loss, and `cells`
 *      stays authoritative for both so nothing has to be recomputed to open
 *      the file either way. Additive. */
export const currentSchemaVersion = 26;

/** Maximum container nesting depth; guards traversal against stack overflow (FR-4). */
export const maxNestingDepth = 32;

// ---------------------------------------------------------------------------
// Section 6.2: shared value types
// ---------------------------------------------------------------------------

export type Unit = "px" | "mm" | "in" | "pt";

// Canonical sRGB (always present) plus optional explicit print color.
export interface Color {
  srgb: { r: number; g: number; b: number; a: number }; // 0..1 each
  cmyk?: { c: number; m: number; y: number; k: number }; // 0..1 each
  spot?: { name: string; book?: string; fallback: { c: number; m: number; y: number; k: number } };
}

// --- image value types (defined here so the Fill union can include
// ImageFill; the ImageNode below reuses these). ---------------------------

export type ImageFit = "contain" | "cover" | "stretch" | "none";

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ClipPath {
  kind: "rect" | "ellipse" | "shape" | "freeform";
  d?: string;
  shapeRef?: string;
}

export interface ImageSource {
  assetId: string;
  naturalWidth: number;
  naturalHeight: number;
  colorSpace?: "srgb" | "display-p3" | "cmyk";
  previewKey?: string;
}

export interface ImageFill {
  type: "image";
  source: ImageSource;
  fit: ImageFit;
  crop?: CropRect;
  focalPoint?: { x: number; y: number };
  opacity?: number;
}

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

export interface Size {
  width: number;
  height: number;
}

export interface Constraints {
  horizontal: "left" | "right" | "center" | "stretch" | "scale";
  vertical: "top" | "bottom" | "center" | "stretch" | "scale";
}

export type BlendMode =
  | "normal" | "multiply" | "screen" | "overlay" | "darken" | "lighten"
  | "color-dodge" | "color-burn" | "hard-light" | "soft-light"
  | "difference" | "exclusion" | "hue" | "saturation" | "color" | "luminosity";

// --- unified fill model ---------------------------------------------

export interface GradientStop {
  position: number; // 0..1
  color: Color; // per-stop alpha via color.srgb.a
}

export interface MeshPoint {
  x: number;
  y: number;
  color: Color;
}

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

export interface Stroke {
  fill: Fill;
  width: number;
  align: "inside" | "center" | "outside";
  cap: "butt" | "round" | "square";
  join: "miter" | "round" | "bevel";
  dash?: number[];
  miterLimit?: number;
}

export interface Shadow {
  /** Missing means "drop": early effect panels wrote shadows without a type,
   *  so those files must stay valid and render as drop shadows. */
  type?: "drop" | "inner";
  color: Color;
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
}

export interface AdjustmentOp {
  name: string;
  value: number;
}

// Duotone (F24): maps image luminance to a two-color gradient, dark pixels to
// `shadows` and light pixels to `highlights`, blended by `intensity` (0..1).
// Rendered by the engine to a cached offscreen buffer, not as a CSS filter.
export interface Duotone {
  shadows: Color;
  highlights: Color;
  intensity: number;
}

export type Effect = { enabled?: boolean } & (
  | (Shadow & { kind: "shadow" })
  | { kind: "blur"; radius: number }
  | { kind: "glow"; color: Color; radius: number }
  | { kind: "outline"; color: Color; width: number }
  | { kind: "adjustment"; ops: AdjustmentOp[] }
  | (Duotone & { kind: "duotone" })
);

/** The effects that actually render: absent `enabled` counts as enabled. */
export function enabledEffects(effects?: readonly Effect[]): Effect[] {
  return (effects ?? []).filter((e) => e.enabled !== false);
}

/** The same rule for a text node's parallel stack. */
export function enabledTextEffects(effects?: readonly TextEffect[]): TextEffect[] {
  return (effects ?? []).filter((e) => e.enabled !== false);
}

export interface CornerRadius {
  topLeft: number;
  topRight: number;
  bottomRight: number;
  bottomLeft: number;
}

export interface ElementLink {
  kind: "url" | "page" | "anchor" | "email";
  target: string;
}

// --- animation, interactivity, page transition, photo motion --------
// Additive in schema v6. NodeBase gains an optional typed `animation`
// (entrance/exit/emphasis), `interaction`, and keeps `link` (folded into the
// interaction model at runtime). Page gains an optional `transition`, ImageNode
// an optional `motion`. Older files validate unchanged; the v5 -> v6 migration
// lifts the legacy single-entry `animations[0]` shape into `animation.entrance`.

/** Named easing curves shared by the playback engine (engine `evalEasing`). */
export type Easing = "linear" | "ease-in" | "ease-out" | "ease-in-out" | "spring" | "ease-in-cubic" | "ease-out-cubic" | "ease-out-back" | "bounce";

export type EntrancePreset = "fade" | "rise" | "pan" | "pop" | "drift" | "breathe-in" | "typewriter" | "word-wipe" | "tumble" | "stomp" | "zoom-in";
export type ExitPreset = "fade-out" | "sink" | "pop-out" | "drift-out" | "tumble-out" | "zoom-out";
export type EmphasisPreset = "pulse" | "wiggle" | "spin" | "breathe" | "tada" | "flicker" | "jiggle" | "bob";
/** Any animation preset across the three triggers (used by the timeline). */
export type AnimationPreset = EntrancePreset | ExitPreset | EmphasisPreset;

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
  /** Spring parameters (v23) when `easing` is "spring": stiffness maps to the
   *  oscillation frequency and damping to the settle character. Plain numbers
   *  the ENGINE clamps into its stable range, so any stored value renders. */
  spring?: { stiffness?: number; damping?: number };
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
  /** v23 channels: an absolute fill-color override, and absolute width/height
   *  in px (the pose keeps the node's center fixed while resizing). Each
   *  channel interpolates between the keyframes that DEFINE it, independent
   *  of the others, holding at both boundaries like the transform channels;
   *  omitted everywhere means no override. */
  color?: Color;
  width?: number;
  height?: number;
}

/** A per-element keyframe timeline (F25 FR-1/3): an ordered set of keyframes
 *  evaluated over `durationMs`, optionally looping. */
export interface KeyframeTrack {
  durationMs: number;
  loop?: boolean;
  keyframes: Keyframe[];
  /** Motion path (v23): node-relative offsets sampled over the track. When
   *  present (2+ points) it drives dx/dy INSTEAD of the keyframes' dx/dy
   *  channels; the other channels keep evaluating from the keyframes. */
  path?: { x: number; y: number }[];
  /** Rotate the node along the path's tangent (v23, orient-to-path). */
  orient?: boolean;
}

/** Per-node animation set: an entrance (slide-enter), an exit (slide-leave),
 *  an emphasis (loops while idle), and an optional custom keyframe timeline. All
 *  slots optional and additive. */
export interface NodeAnimation {
  entrance?: AnimationClip<EntrancePreset>;
  exit?: AnimationClip<ExitPreset>;
  emphasis?: AnimationClip<EmphasisPreset>;
  custom?: KeyframeTrack;
  /** Media trigger (v23): hold the ENTRANCE until the referenced video/audio
   *  node's playback reaches `atMs`, then play it (F25 media bookmarks). A
   *  dangling id or a surface with no live media simply never fires - the
   *  node then behaves as if it had no entrance hold. */
  trigger?: { mediaNodeId: string; atMs: number };
}

/** What an interaction trigger does. `openLink` reuses the node's ElementLink
 *  shape so the legacy hyperlink folds in without a second URL store. */
export type InteractionAction =
  | { kind: "none" }
  | { kind: "navigate"; to: "next" | "prev" | "first" | "last" | "page"; pageId?: string }
  | { kind: "open-link"; link: ElementLink };

/** A node interaction: a pointer trigger bound to an action. */
export interface Interaction {
  trigger: "click" | "hover";
  action: InteractionAction;
  /** Newer interaction actions (v24). A SEPARATE optional field, never a
   *  widening of the `action` enum: widening looks additive but breaks every
   *  older client's whole-file validation (CLAUDE.md). `kind` is a PLAIN
   *  string ("play-media" | "pause-media" | "toggle-media" | "run-animation"
   *  today); a runtime that does not recognize it simply falls back to the
   *  legacy `action`. When set, a capable runtime prefers it. */
  actionV2?: { kind: string; targetNodeId?: string };
}

/** Per-page slide transition, applied when advancing to this page (FR-6). */
export interface PageTransition {
  type: "none" | "fade" | "slide" | "push" | "dissolve" | "morph-lite" | "wipe" | "flip" | "zoom" | "morph";
  direction?: "left" | "right" | "up" | "down";
  durationMs: number;
  /** Easing curve name (v22). A PLAIN string, never an enum: an unknown value
   *  must keep validating on every client (the engine clamps unknowns to its
   *  default), so future easings can ship without a schema change. */
  easing?: string;
}

/** Photo motion on an ImageNode: a slow zoom/pan during present-mode display. */
export interface ImageMotion {
  kind: "kenburns" | "parallax";
  intensity: number; // 0..1
}

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

export interface SubPath {
  closed: boolean;
  anchors: VectorAnchor[];
}

export interface VectorPath {
  subpaths: SubPath[];
  fillRule: "nonzero" | "evenodd";
}

// ---------------------------------------------------------------------------
// Section 6.1: file-level resources
// ---------------------------------------------------------------------------

export interface Guide {
  axis: "x" | "y";
  position: number;
}

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

export interface ColorSwatch {
  id: string;
  name?: string;
  color: Color;
}

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
export const knownNodeTypes: readonly NodeType[] = [
  "text", "image", "shape", "line", "path", "icon", "sticker",
  "group", "frame", "grid", "video", "audio", "table", "chart",
  "embed", "qr", "connector", "mask", "boolean", "sticky",
  "ink", "mindmap", "boardview", "diagramcode", "stamp",
] as const;

const KNOWN_NODE_TYPE_SET = new Set<string>(knownNodeTypes);
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
  /** Accessibility (doc 28 FR-29). `altText` describes the node for assistive
   *  technology; `decorative` marks it as presentational, so a checker and an
   *  accessible export skip it instead of demanding a description. Both are
   *  additive and optional: older files omit them. `ImageNode.alt` predates
   *  this and remains the image-specific field; `altText` generalizes it. */
  altText?: string;
  decorative?: boolean;
  // Manipulation metadata; optional and non-geometric.
  aspectLocked?: boolean;
  opticalAlign?: boolean;
  data?: Record<string, unknown>;
}

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

export interface Run {
  text: string;
  style: CharStyle;
  charStyleId?: StyleId;
  overrides?: Partial<CharStyle>;
}

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

export interface Paragraph {
  runs: Run[];
  style: ParagraphStyle;
  paraStyleId?: StyleId;
  overrides?: Partial<ParagraphStyle>;
}

export interface TextBox {
  mode: "fixed" | "autoHeight" | "autoWidth";
  width: number;
  height: number;
  columns?: { count: number; gutter: number };
  padding?: { t: number; r: number; b: number; l: number };
  autoFit?: { enabled: boolean; min: number; max: number };
  verticalAlign?: "top" | "middle" | "bottom";
}

export type TextFlow =
  | { kind: "horizontal" }
  | { kind: "vertical"; columnOrder: "rtl" | "ltr" }
  | { kind: "path"; pathRef: string; offset: number; side: "above" | "below" | "inside" | "outside"; flip?: boolean }
  | { kind: "arc"; curvature: number };

/** Text effects take the same per-effect enable, with the same polarity and the
 *  same absent-means-enabled rule, so the two stacks behave identically to a
 *  user who does not know they are stored apart. */
export type TextEffect = { enabled?: boolean } & (
  | { kind: "shadow"; dx: number; dy: number; blur: number; color: Fill; opacity: number }
  | { kind: "outline"; width: number; color: Fill; join: "miter" | "round" | "bevel" }
  | { kind: "glow"; radius: number; color: Fill; intensity: number }
  | { kind: "echo"; offset: number; count: number; color: Fill }
  | { kind: "neon"; color: Fill; intensity: number }
  | { kind: "splice"; thickness: number; offset: number; color: Fill }
  | { kind: "highlight"; color: Fill; padding: number; radius: number }
  | { kind: "lift"; intensity: number }
  | { kind: "hollow"; thickness: number }
);

export interface TextNode extends NodeBase {
  type: "text";
  box: TextBox;
  content: Paragraph[];
  flow?: TextFlow;
  textEffects?: TextEffect[]; // "effects"; renamed to avoid NodeBase.effects clash
  styleRefs?: { defaultParagraph?: StyleId };
}

export interface TextStyleSheet {
  paragraphStyles: Record<StyleId, { name: string; style: ParagraphStyle; basedOn?: StyleId }>;
  charStyles: Record<StyleId, { name: string; style: CharStyle; basedOn?: StyleId }>;
} // pixel crop (video)

// ImageNode uses the image value types (ImageFit/CropRect/ClipPath/ImageSource,
// and ImageFill in the Fill union) defined near the Fill model above.

/** A grayscale alpha mask stored as an ordinary workspace asset (see
 *  `ImageNode.alphaMask`). Dimensions are recorded so a renderer can scale the
 *  mask onto the image without decoding it first. */
export interface ImageAlphaMask {
  assetId: string;
  width: number;
  height: number;
}

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
  /** Per-pixel transparency applied over `source`, as a grayscale asset:
   *  white keeps, black hides.
   *
   *  This is what makes background removal NON-DESTRUCTIVE. Removal used to
   *  overwrite `source` with the flattened cutout, so the original pixels left
   *  the document and the result could be neither undone meaningfully nor
   *  refined. Keeping the original and storing the alpha separately means the
   *  cutout is a view of the image rather than a replacement for it.
   *
   *  An assetId, never inline pixel data. A data URL here would land in the
   *  CRDT, every snapshot, and IndexedDB, and be re-sent to every collaborator
   *  on load; a mask that a brush revises repeatedly would make that acute. */
  alphaMask?: ImageAlphaMask;
  /** Accessibility alt text (F22 FR-12). Optional + additive, so older files
   *  still validate with no migration; AI alt-text and a11y export read it. */
  alt?: string;
}

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

export interface LineNode extends NodeBase {
  type: "line";
  points: { x: number; y: number }[];
  stroke: Stroke;
  startCap?: "none" | "arrow" | "circle" | "diamond";
  endCap?: "none" | "arrow" | "circle" | "diamond";
}

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

export interface PathContour {
  segments: PathSegment[];
  closed: boolean;
}

export interface PathNode extends NodeBase {
  type: "path";
  segments: PathSegment[];
  closed: boolean;
  /** Additional subpaths of a compound path (`segments`/`closed` hold the
   *  first). All contours are filled together under the even-odd rule, so
   *  interior contours cut holes: this is how imported vector line art keeps
   *  its counters instead of flooding solid. Optional and additive: an older
   *  file omits it, and an older reader still draws the first contour. */
  contours?: PathContour[];
  fills?: Fill[];
  stroke?: Stroke;
}

export interface IconNode extends NodeBase {
  type: "icon";
  assetId: string;
  fills?: Fill[];
}

export interface StickerNode extends NodeBase {
  type: "sticker";
  assetId: string;
  animated?: boolean;
}

export interface GroupNode extends NodeBase {
  type: "group";
  children: Node[];
  clip?: boolean;
  isolation?: boolean; // transient editor hint; not required to persist
}

export interface AutoLayout {
  direction: "row" | "column";
  gap: number;
  padding: { top: number; right: number; bottom: number; left: number };
  align: "start" | "center" | "end" | "stretch";
}

// A board section header: a title-bar slot turning a plain layout/clip frame
// into a named, colored region (FR-12). Additive and optional.
export interface FrameHeader {
  title: string;
  fill?: Fill;
  textColor?: Color;
}

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

export interface GridCell {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  childId?: string;
}

export interface GridNode extends NodeBase {
  type: "grid";
  rows: number;
  cols: number;
  gap: number;
  cells: GridCell[];
  children: Node[];
  /** Relative track sizes, one weight per column/row. Omitted means every track
   *  is equal, which is what every grid was before these existed, so an older
   *  file needs no conversion.
   *
   *  WEIGHTS, not pixels: a grid is resized freely on the canvas, and absolute
   *  widths would either overflow it or leave a gap the moment it changed size.
   *  Only the ratios between entries matter; the layout normalizes them against
   *  the grid's current size. A length that disagrees with `cols`/`rows` is
   *  ignored rather than honored in part, so a stale array cannot silently
   *  lay out half a grid. */
  colWidths?: number[];
  rowHeights?: number[];
  /** Pack the grid's images into `cols` columns sized to each image's own
   *  aspect ratio, rather than onto the fixed row/column lattice (#39).
   *
   *  The column COUNT is the grid's existing `cols`, so the author controls it
   *  with the control that already exists and no second one contradicts it.
   *  `rows` and the track weights are ignored while this is on: rows have no
   *  meaning once each column advances independently. They are kept rather
   *  than cleared so turning masonry off returns the grid exactly as it was. */
  masonry?: boolean;
}

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

export interface AudioNode extends NodeBase {
  type: "audio";
  assetId: string;
  trimStartMs?: number;
  trimEndMs?: number;
  volume: number;
  fadeInMs?: number;
  fadeOutMs?: number;
}

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

/** v7 (F27): a styled header row (filled + bold first row) and simple table-wide
 *  border styling (color/width/visibility). All optional and additive. */
export interface TableHeaderStyle {
  enabled: boolean;
  fill?: Fill;
  textColor?: Color;
  bold?: boolean;
}

export interface TableBorderStyle {
  show: boolean;
  color?: Color;
  width?: number;
}

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

/** v8 (F27): conditional formatting rules for a table. Each rule targets a
 *  column (`column`) or the whole data area (undefined), and derives per-cell
 *  styling from the cell's numeric value. Evaluated in order; later rules win
 *  for overlapping cells. Header row (when enabled) is excluded. Additive. */
export type TableConditionalRule =
  | { kind: "highlight"; op: ">" | "<" | ">=" | "<=" | "==" | "!="; value: number; fill?: Fill; textColor?: Color; column?: number }
  | { kind: "colorScale"; min: Color; max: Color; column?: number }
  | { kind: "dataBar"; color: Color; column?: number };

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

export interface ChartSeries {
  name: string;
  values: number[];
  color?: Color;
}

// v7 (F27): `barStacked`/`barGrouped` are additive bar variants; `scatter` and
// `radar` already existed in the union and now have real engine renderers.
export type ChartType =
  | "bar" | "barStacked" | "barGrouped" | "line" | "pie" | "donut" | "area"
  | "scatter" | "radar" | "gauge" | "funnel" | "progress";

/** v7 (F27): additive chart styling. All fields optional so older charts (no
 *  `style`) keep rendering with engine defaults; per-series color also still
 *  honors `ChartSeries.color`. */
export type LegendPosition = "top" | "right" | "bottom" | "left";
export interface ChartStyle {
  title?: string;
  legend?: { show: boolean; position: LegendPosition };
  valueLabels?: boolean;
  /** Base text size in px (v16). Every chart text (title, legend, axis and
   *  value labels) scales proportionally from it; absent means the built-in
   *  base of 11, so older files render unchanged. */
  fontSize?: number;
  axes?: {
    showX?: boolean;
    showY?: boolean;
    xLabel?: string;
    yLabel?: string;
  };
}

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

export interface EmbedNode extends NodeBase {
  type: "embed";
  provider: "youtube" | "vimeo" | "maps" | "iframe" | string;
  src: string;
  poster?: string;
}

export interface QRNode extends NodeBase {
  type: "qr";
  value: string;
  ecLevel: "L" | "M" | "Q" | "H";
  foreground: Color;
  background: Color;
  logoAssetId?: string;
  /** Center-logo size as a fraction of the QR's min(width,height). Absent means
   *  the default (0.22); renderers clamp it to a scannable range. */
  logoScale?: number;
  /** Scannable module bit-matrix (row-major, true = dark). Derived from `value`
   *  by the editor; the renderer draws it. Absent until generated. */
  modules?: boolean[][];
}

// --- structural node types (additive) -------------------------------

export type Cap = { kind: "none" | "arrow" | "triangle" | "dot"; size: number };

export interface EndPoint {
  point?: { x: number; y: number };
  // `anchor` stays an opaque string; the optional `port` names a per-side slot
  // so multiple connectors on one node do not stack on a single midpoint (F30
  // FR-8). Purely additive: older files omit it.
  attach?: { nodeId: string; anchor: string; port?: string };
}

// A text label riding a connector, positioned 0..1 along its path (F30 FR-8).
export interface ConnectorLabel {
  text: string;
  position?: number;
}

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

export interface MaskNode extends NodeBase {
  type: "mask";
  maskShape: VectorPath;
  child: Node;
  childInner?: Transform;
}

export interface BooleanNode extends NodeBase {
  type: "boolean";
  op: "union" | "subtract" | "intersect" | "exclude";
  operands: ShapeNode[];
  result?: VectorPath;
  fills?: Fill[];
  stroke?: Stroke;
}

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

// Diagram-as-code node: the source text is the source of truth, with the ids of
// the materialized child nodes recorded so it can re-flow on source edit (FR-9).
export interface DiagramCodeNode extends NodeBase {
  type: "diagramcode";
  lang: "mermaid" | "plantuml" | "dot";
  source: string;
  materializedIds?: string[];
}

// Emoji-stamp / vote-marker placed primitive (FR-21), distinct from asset-id
// stickers; `kind: "vote"` backs dot-vote placement.
export interface StampNode extends NodeBase {
  type: "stamp";
  kind: "emoji" | "vote";
  glyph: string;
  authorId?: string;
}

// Forward-compat placeholder for node types written by a newer client (FR-3).
// Its `type` is any string that is NOT a known type; the original node is
// preserved verbatim in `raw` for lossless round-trips (FR-12, AC-5).
export interface UnknownNode extends NodeBase {
  type: NodeType;
  raw: Record<string, unknown>;
}

export type KnownNode =
  | TextNode | ImageNode | ShapeNode | LineNode | PathNode | IconNode
  | StickerNode | GroupNode | FrameNode | GridNode | VideoNode | AudioNode
  | TableNode | ChartNode | EmbedNode | QRNode
  | ConnectorNode | MaskNode | BooleanNode | StickyNode
  | InkNode | MindMapNode | BoardViewNode | DiagramCodeNode | StampNode;

export type Node = KnownNode | UnknownNode;

// ---------------------------------------------------------------------------
// Section 6.1: slide masters, layouts, and themes (doc 28 FR-3, FR-4)
// ---------------------------------------------------------------------------

/** A named region a layout reserves for content. `role` gives the region its
 *  meaning: the `title` placeholder is what makes a slide's name a real,
 *  screen-reader-navigable slide title (FR-3, FR-29). */
export type PlaceholderRole = "title" | "body" | "content" | "picture" | "chart" | "media" | "footer";

export interface Placeholder {
  id: string;
  role: PlaceholderRole;
  rect: { x: number; y: number; width: number; height: number };
  /** Capacity hints for layout-grounded generation (v21, all optional): how
   *  much text this slot comfortably holds. maxChars is the hard fit ceiling,
   *  minChars (about half of max) the floor below which the slot looks empty;
   *  minItems/maxItems bound list-capable roles (content). Rendering ignores
   *  them entirely - they only shape generated content. */
  maxChars?: number;
  minChars?: number;
  minItems?: number;
  maxItems?: number;
}

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

/** A layout under a master (title, title+content, two-content, ...). A `Page`
 *  points at one via `layoutId`; the cascade is page -> layout -> master. */
export interface SlideLayout {
  id: string;
  masterId: string;
  name: string;
  background?: Fill;
  placeholders: Placeholder[];
}

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

/** A named, colored group of consecutive slides (doc 28 FR-5). Membership is
 *  carried by `Page.sectionId`, so `pages` order remains the single source of
 *  truth for the deck's sequence and a section can never disagree with it. */
export interface SlideSection {
  id: string;
  name: string;
  /** Swatch hex for the divider row; the UI supplies a default when absent. */
  color?: string;
  /** Collapsed in the slide bar / overview. Purely a view preference, stored so
   *  it survives a reload; never affects presenting or export. */
  collapsed?: boolean;
}

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
  /** Exit transition (v22): how THIS page leaves when advancing away from it.
   *  Composited simultaneously with the arriving page's own transition; absent
   *  means today's behavior (only the arriving page's transition plays). */
  transitionOut?: PageTransition;
  // presentations (additive, optional; older files still validate):
  layoutId?: string; // slide layout this page inherits from (doc 28 FR-3)
  sectionId?: string; // the section this slide belongs to (doc 28 FR-5)
  /** Node ids in the order assistive technology should traverse them, which is
   *  independent of z-order (doc 28 FR-29). Absent = fall back to z-order, the
   *  behavior before this field existed. Ids not on the page are ignored, and
   *  nodes missing from the list follow in z-order, so the field can never
   *  hide content. */
  readingOrder?: string[];
  autoAdvanceMs?: number; // autopilot dwell before auto-advancing this slide (FR-14)
  hidden?: boolean; // slide is skipped while presenting / in autopilot (FR-1)
  timelineDuration?: number; // derived/cached total ms for this page (optional)
  data?: Record<string, unknown>;
}

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
  /** Slide sections (doc 28 FR-5). Order here is presentational only; the deck
   *  sequence is `pages`. A section with no pages is legal (just empty). */
  sections?: SlideSection[];
  /** Document's primary language as a BCP 47 tag (F38 FR-8), announced to
   *  assistive technology and written as the tagged-PDF /Lang. Absent means
   *  unset; exports fall back to en-US. */
  language?: string;
  meta: Record<string, unknown>;
}
