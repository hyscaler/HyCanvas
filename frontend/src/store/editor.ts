// Editor store: the editable design document, selection, viewport, and a local
// undo/redo stack. Geometry/structure edits go through @hc/editor commands; the
// store bumps `rev` so the canvas rebuilds the scene and panels recompute. The
// authoritative CRDT document and the global undo stack arrive with docs 16/10.

import { create } from "zustand";
import {
  createBlankDesign,
  createNode,
  type AssetRef,
  type BlendMode,
  type ChartNode,
  type DataBinding,
  type ChartStyle,
  type CharStyle,
  type Color,
  type CornerRadius,
  type CropRect,
  type DesignFile,
  type Effect,
  type Fill,
  type ImageFit,
  type ImageMotion,
  type Interaction,
  type Node,
  type KeyframeTrack,
  type NodeAnimation,
  type EntrancePreset,
  type NodeType,
  type Page,
  type PageTransition,
  type Theme,
  applyTheme,
  builtinMasterAndLayouts,
  type Paragraph,
  type ParagraphStyle,
  type Stroke,
  type TableBorderStyle,
  type TableConditionalRule,
  type TableCell,
  type TableHeaderStyle,
  type TableNode,
  type TextEffect,
  type TextNode,
  type TextFlow,
  type Transform,
  type SlideSection,
  type FontRef,
  moveInReadingOrder,
} from "@hc/schema";
import { contrastRatio, fixToAA, fromHex, nearestPaletteColor, seriesColorAt, toHex } from "@hc/color";
import {
  applyCommand,
  invertCommand,
  group as groupOp,
  ungroup as ungroupOp,
  order as orderOp,
  setLocked,
  setHidden,
  setOpacity as setOpacityOp,
  setBlend as setBlendOp,
  rename as renameOp,
  locate,
  selectionRoots,
  remapIds,
  captureStyle,
  pasteStyleOps,
  resizePage,
  worldAABB,
  worldMatrix,
  unionAABB,
  moveTransform,
  rotateAboutPoint,
  alignDeltas,
  distributeDeltas,
  tidyUpDeltas,
  type AlignEdge,
  type ArrangeItem,
  type Delta,
  type EditCommand,
  type ResizeTarget,
} from "@hc/editor";
import {
  applyToPoint,
  invert,
  entrancePatch,
  emphasisPatch,
  exitPatch,
  customPatch,
  appliedOpacity,
  sequenceStarts,
  revealEntranceText,
  type AnimPatch,
  type Mat2D,
} from "@hc/engine";
import { booleanOp, fitCubicBeziers, pathToPolylines, recognizeShape, shapeNodeToParametric, shapeToPath, simplifyPolyline, strokeToOutline, type BooleanOp } from "@hc/geometry";
import { imageAssets } from "@/lib/assetProvider";
import { measuredTextHeight } from "@/lib/textFit";
import { pageGap, pageOffsets, pageTop } from "@/lib/pageLayout";
import type { MagicDesignSpec } from "@/lib/magicDesign";
import { extractLayoutSet, layoutDesign, verifyLayoutCapacities, type AiDesignSpec, type DeckResult, type ExtractedLayoutSet, type ExtractPageLike } from "@hc/aistudio";
import { qrModules } from "@/lib/qr";
import { frameMaskFor } from "@/lib/maskPath";
import { flattenSvgToNodes } from "@/lib/svgFlatten";
import { layoutFlowchart, layoutMindMap, type DiagramSpec as WbDiagramSpec } from "@hc/whiteboard";
import { parseCsvMatrix } from "@/lib/csv";
import { tabularToChart } from "@/lib/magicDesign";
import { usePresence } from "@/store/presence";
import { useBrand } from "@/store/brand";
import { tr } from "@/lib/i18n";

// True when a node carries a collaborative lock held by ANOTHER participant
//. This is SEPARATE from the schema's static `node.locked` flag:
// it is a transient, per-user claim mirrored from the realtime server. When
// realtime is offline the lock map is empty, so this is always false (editing
// is never blocked offline). Mutation entry points consult this to refuse
// moving/resizing/deleting/restyling a node someone else holds.
function lockedByOther(id: string): boolean {
  return usePresence.getState().collabLockedByOther(id) !== null;
}

// True when a node is a brand-template locked region this caller may not edit
//. Mirrors `lockedByOther`: it gates structural/style
// mutation for non-manage-brand members; a manage-brand user (or no kit / empty
// locked set) is never blocked. Consulted alongside `lockedByOther` everywhere a
// mutation could move/restyle/delete a node.
function lockedRegion(id: string): boolean {
  return useBrand.getState().isLockedRegion(id);
}

// Combined edit-block gate: a node is uneditable when collab-locked by another
// user, a brand locked region for this caller, OR under a facilitator/protected
// lock while this client is not the facilitator (FR-16). Used by the single-node
// guards at every mutation entry point.
function editBlocked(id: string): boolean {
  return lockedByOther(id) || lockedRegion(id) || usePresence.getState().protectedByOther(id);
}

// Map a VectorPath's anchors (and handles) through an affine matrix, so a
// shape's local path becomes page-space geometry for boolean operations.
type VAnchor = { x: number; y: number; corner?: boolean; inHandle?: { x: number; y: number }; outHandle?: { x: number; y: number } };
type VPath = { fillRule: "nonzero" | "evenodd"; subpaths: { closed: boolean; anchors: VAnchor[] }[] };
function transformVectorPath(vp: VPath, m: Mat2D): VPath {
  const tp = (p: { x: number; y: number }) => applyToPoint(m, p);
  return {
    fillRule: vp.fillRule,
    subpaths: vp.subpaths.map((sp) => ({
      closed: sp.closed,
      anchors: sp.anchors.map((a) => {
        const np = tp(a);
        const na: VAnchor = { x: np.x, y: np.y, corner: a.corner };
        if (a.inHandle) na.inHandle = tp(a.inHandle);
        if (a.outHandle) na.outHandle = tp(a.outHandle);
        return na;
      }),
    })),
  };
}

// Node types whose schema carries a node-level `fills` array. Text color lives
// per-run (style.fill); image/group have no fills. Used so setFillColor never
// stamps a schema-foreign property onto a node that has no fill concept.
const FILL_CAPABLE = new Set<string>(["shape", "path", "icon", "frame"]);

// `fontStyle` values are file-format tokens, never localized: the engine
// parses weight/italic out of them by ENGLISH name and they persist into the
// design file, so a translated token corrupts the doc.
const boldFontStyle = "Bold";
const regularFontStyle = "Regular";

// Zoom is clamped to this range everywhere (matches the wheel-zoom bounds) so a
// stray 0/negative value can never reach the screen<->page math.
const MIN_ZOOM = 0.01;
const MAX_ZOOM = 64;

// Reference colors for Magic Design's readable-text-over-background heuristic.
const WHITE_COLOR: Color = { srgb: { r: 1, g: 1, b: 1, a: 1 } };
const NEAR_BLACK_COLOR: Color = { srgb: { r: 0.1, g: 0.12, b: 0.16, a: 1 } };

export interface Viewport2D {
  zoom: number;
  panX: number;
  panY: number;
}

interface UndoEntry {
  undo: () => void;
  redo: () => void;
}

type Tool = "select" | "pen" | "pencil" | "ink" | "laser" | "eraser" | "stamp" | "line" | "arrow" | "rect" | "ellipse" | "text" | "comment";

// Shared empty set returned by privateHiddenIds() when nothing is hidden, so the
// common (no-private-mode) render path allocates nothing.
const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();

/** Legacy single-entrance shape kept only so an unmigrated in-memory doc still
 *  reads (the v6 migration lifts it into `node.animation.entrance`). New code
 *  uses the schema's typed `NodeAnimation`/`Interaction`. */
export type OcAnimation = {
  preset: "fade" | "rise" | "pop" | "slideL" | "slideR";
  durationMs: number;
  delayMs: number;
};
export type OcLink = { kind: "url" | "page" | "anchor" | "email"; target: string };

/** The brand inputs a re-skin maps a design onto. `palette` is the
 *  flat list of approved brand colors; `fonts` are the approved family names
 *  (heading first by convention). Empty arrays leave that dimension untouched. */
/** A stable address for one translatable string in the design (doc 28 FR-23):
 *  a text run (so styling boundaries survive translation), a sticky note's
 *  text, or a page's speaker notes. */
export type DeckTextRef =
  | { kind: "run"; nodeId: string; para: number; run: number }
  | { kind: "sticky"; nodeId: string }
  | { kind: "notes"; page: number };
export interface DeckTextEntry {
  ref: DeckTextRef;
  text: string;
}

export type ReskinBrand = { palette: Color[]; fonts: string[] };
/** One color remap a re-skin applied (from hex -> to hex), for the override UI. */
export type ReskinColorMap = { from: string; to: string };
/** One font remap a re-skin applied (from family -> to family). */
export type ReskinFontMap = { from: string; to: string };
export type ReskinResult = { colors: ReskinColorMap[]; fonts: ReskinFontMap[] };
/** Per-mapping re-skin overrides: keyed by the source hex
 *  (lowercase #rrggbb), the value is the chosen brand hex to map that color to,
 *  or "keep" to leave the original color untouched. A color not present in the
 *  map uses the default nearest-brand-color behavior. */
export type ReskinOverrides = Record<string, string>;

/** An applyable brand-lint fix, mirroring `@hc/sdk`'s BrandLintFix
 *  union. Kept local so the store has no SDK dependency. */
export type BrandFix =
  | { kind: "snap_color"; from: string; to: Color }
  | { kind: "swap_font"; from: string; to: string }
  | { kind: "fix_contrast"; color: Color }
  | { kind: "restore_logo"; reason: string };
/** One lint fix bound to the node it corrects. */
export type BrandFixTarget = { nodeId: string; fix: BrandFix };

/** F16: a per-user collaborative undo handle, supplied by the live CRDT binding
 *  (a Yjs UndoManager scoped to this client's edits). When present, `undo`/`redo`
 *  delegate to it so a user only reverts their OWN changes and never clobbers a
 *  concurrent peer edit; absent (no live doc) the local snapshot stack is used. */
export type CollabUndo = {
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Force the next tracked edit into a NEW undo step (Yjs merges transactions
   *  within its capture window by default). */
  stopCapturing(): void;
};

/** One style-harmonization change (F22 FR-8), mirroring @/lib/assist's
 *  HarmonizeChange. Kept structurally identical so the panel can pass them
 *  straight through; the store has no dependency on the assist lib. */
export type AssistHarmonizeChange =
  | { kind: "font"; from: string; to: string; count?: number }
  | { kind: "color"; from: string; to: string; count?: number }
  | { kind: "radius"; from: number; to: number; count?: number };

/** One staggered entrance assignment (F22 FR-11), mirroring @/lib/assist's
 *  AnimateAssignment. */
export type AssistAnimateAssignment = {
  nodeId: string;
  preset: "fade" | "rise" | "pop";
  durationMs: number;
  delayMs: number;
};

// Compose an engine AnimPatch (delta/multiplier offsets) over a node's resting
// transform/opacity during a preview. A null patch restores the resting pose.
// Mutates the node in place; the caller bumps `rev` via tick(). Scale multiplies
// the resting scaleX/scaleY (preserving any flip sign), so a flipped node still
// animates correctly.
function applyPatch(node: Node, base: Transform, baseOpacity: number, patch: AnimPatch | null): void {
  if (!patch) {
    node.opacity = baseOpacity;
    node.transform = { ...base };
    return;
  }
  node.opacity = appliedOpacity(baseOpacity, patch.opacityMul);
  node.transform = {
    ...base,
    x: base.x + patch.dx,
    y: base.y + patch.dy,
    scaleX: base.scaleX * patch.scale,
    scaleY: base.scaleY * patch.scale,
    rotation: base.rotation + patch.rotate,
  };
}

// Resolve the exit patch for a node animation at local time t (null if no exit).
function exitPatchFor(anim: NodeAnimation, t: number): AnimPatch | null {
  return anim.exit ? exitPatch(anim.exit, t) : null;
}

// In-memory clipboard (copy/paste) and last-copied style (single editor instance).
let clipboardNodes: Node[] | null = null;
let styleClip: unknown = null;

// Prefix that marks design-node JSON written to the OS clipboard, so a paste can
// tell our own copied elements from arbitrary external text. Keeps copy/paste
// working across refresh and browser tabs (last copy wins, as editors conventionally do).
export const ocClipPrefix = "oc-clipboard-v1::";

/** Assign fresh ids to a node subtree (used when duplicating a page). */
function regenIds(nodes: Node[]): void {
  for (const n of nodes) {
    n.id = `n-${crypto.randomUUID()}`;
    const kids = (n as unknown as { children?: Node[] }).children;
    if (Array.isArray(kids)) regenIds(kids);
  }
}

interface EditorState {
  doc: DesignFile;
  selection: string[];
  viewport: Viewport2D;
  rev: number; // bumped on every document mutation to drive re-render
  // The `rev` value as of the last save. `rev !== savedRev` means there are
  // unsaved changes (drives the save indicator + the unload guard).
  savedRev: number;
  /** Mark the document as saved (clears the unsaved-changes indicator). */
  markClean(): void;
  /** True while a manual Save (kind "checkpoint") is in flight, so the automatic
   *  snapshot path yields instead of firing a redundant concurrent save. */
  manualSaving: boolean;
  setManualSaving(v: boolean): void;
  tool: Tool; // active canvas tool (select vs pen)
  /** Freehand brush settings used by the pencil + board ink tools. `mode` selects
   *  the ink rendering (pen / marker / highlighter) for the board `ink` tool. */
  brush: { width: number; colorHex: string; opacity: number; mode: "pen" | "marker" | "highlighter" };
  setBrush(patch: Partial<{ width: number; colorHex: string; opacity: number; mode: "pen" | "marker" | "highlighter" }>): void;
  playing: boolean; // animation preview running
  cropping: string | null; // id of the image currently in crop mode (UI only)
  maskRefining: string | null; // id of the image whose alpha mask is being brush-refined (UI only)
  editingTextId: string | null; // text node currently in the inline editor (UI only); the renderer skips it so it doesn't double up
  /** Step every run's font size by `delta` px (relative, so mixed-size boxes
   *  keep their ratios), clamped to a sane range. Undoable. */
  stepTextFontSize(id: string, delta: number): void;
  /** While the inline text editor is open: applies a char patch to its live
   *  selection, returning true when a range was styled (false = no selection,
   *  caller falls back to whole-node styling). Registered by the overlay so
   *  panel controls edit the selected range instead of clobbering the box. */
  textEditApply: ((char: Partial<CharStyle>) => boolean) | null;
  setTextEditApply(fn: ((char: Partial<CharStyle>) => boolean) | null): void;
  presenting: boolean; // fullscreen present mode is open (suppresses canvas keys)
  // View aids (UI only, not part of the document)
  showRulers: boolean;
  showGrid: boolean;
  gridSize: number; // page units between grid lines
  snapEnabled: boolean; // smart guides + grid snapping during moves
  guides: Record<string, { x: number[]; y: number[] }>; // manual guides per page id
  snapGuides: { x: number[]; y: number[] } | null; // transient smart-guide preview (shared by move/resize)
  activePage: number; // index of the page being edited
  transforming: boolean; // true while an element is being live-moved/resized (fades it so the page shows through)
  hoverId: string | null; // top-level node the select-tool pointer is idling over; the canvas reveals its off-page overflow
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];

  // selection
  select(ids: string[]): void;
  toggle(id: string): void;
  addToSelection(ids: string[]): void;
  clearSelection(): void;
  /** Select every visible, unlocked top-level node on the active page. */
  selectAll(): void;
  /** Select every node on the active page sharing the first selection's type. */
  selectSameType(): void;

  // document
  /** Replace the whole document (e.g. after loading from the backend). */
  loadDoc(file: DesignFile): void;
  /** Set the document title (used for the editor header + export filename). */
  setDocTitle(title: string): void;
  /** Set (or clear, with "") the document's primary language, a BCP 47 tag
   *  announced to assistive technology and the tagged-PDF /Lang (F38 FR-8). */
  setDocLanguage(tag: string): void;
  /**
   * Shallow-merge a patch into `doc.meta` as one undoable step. Document-type
   * surfaces (whiteboard/doc/sheet/video-32) keep their non-scene state
   * under `meta` (e.g. `meta.doc`, `meta.sheet`, `meta.video`, `meta.kind`); a
   * surface reads its sub-object and writes the next version back through here.
   */
  setDocMeta(patch: Record<string, unknown>): void;

  // history time machine: read-only preview of a past version.
  /** When set, the canvas is showing a historical version read-only; carries the
   *  banner metadata and a stashed copy of the live doc to restore on exit. */
  preview: { label: string; live: DesignFile; liveSelection: string[] } | null;
  /** True while previewing a past version: the editor is read-only (AC-6). */
  readonlyPreview(): boolean;
  /** Enter read-only preview of `file`, stashing the live doc so exit restores it
   *  exactly. Does NOT touch the undo stack or the live CRDT doc. */
  enterPreview(file: DesignFile, label: string): void;
  /** Leave preview, restoring the stashed live doc and selection. The ydoc bridge
   *  detects this exit (preview -> null) and does NOT reconcile the stash into the
   *  Y.Doc, so peer edits made during the preview are not clobbered; the shell
   *  follows with resyncFromLiveDoc() to rebuild the store from the live Y.Doc. */
  exitPreview(): void;

  // viewport
  setViewport(v: Partial<Viewport2D>): void;
  /** Canvas pixel size, reported by the renderer; drives fit/zoom-to-selection. */
  viewportSize: { width: number; height: number };
  setViewportSize(width: number, height: number): void;
  /** Fit the active page within the viewport (centered). */
  fitToScreen(): void;
  /** Page-space AABB of everything on the active page: the union of all node
   *  bounds with the page rect (the baseline artboard). Drives infinite-canvas
   *  navigation (fit-all + MiniMap) so it tracks content parked beyond the page
   *  edge (F30 FR-1), not just the fixed page size. */
  contentBounds(): { x: number; y: number; width: number; height: number } | null;
  /** Content bounds (node union ∪ page rect, page-local coords) for ANY page
   *  index, so the MiniMap can overview the page currently under the viewport
   *  even when it is not the active page (continuous scroll). */
  pageContentBounds(index: number): { x: number; y: number; width: number; height: number } | null;
  /** Zoom to frame the current selection (falls back to fit). */
  zoomToSelection(): void;
  /** Select a node and pan the viewport to center it, gently (F30 search jump):
   *  keeps the current zoom when the node fits, else zooms out to fit, capped so
   *  a tiny node is not blown up to max zoom. */
  jumpToNode(id: string): void;

  // pages
  /** Switch the active page (clamped); clears selection. */
  setActivePage(index: number): void;
  /** Navigate to a page: activate it AND scroll its band into the viewport
   *  (page top when it overflows the view, centered otherwise), so the page
   *  under the viewport center is the page just chosen. */
  goToPage(index: number): void;
  /** Mark a live move/resize gesture active so the canvas fades the selection
   *  (the page shows through it during the drag). Cleared on gesture end. */
  setTransforming(v: boolean): void;
  setHoverId(id: string | null): void;
  /** Add a blank page after the current one, undoable. Defaults to the current
   *  page's size; pass a size to add a differently-sized page. */
  addPage(size?: { width: number; height: number }): void;
  /** Duplicate a page (defaults to active) with fresh node ids after it, undoable. */
  duplicatePage(index?: number): void;
  /** Rename a page (its title in the page list / continuous-scroll header). */
  setPageName(index: number, name: string): void;
  /** Lock or unlock every element on a page in one undo step (page header lock). */
  setPageLocked(index: number, locked: boolean): void;
  /** Delete a page (keeps at least one), undoable. */
  deletePage(index?: number): void;
  /** Resize the active page, undoable. */
  setPageSize(width: number, height: number): void;
  /** Set (or clear) the active page's background fill, undoable. */
  setPageBackground(fill: Fill | undefined): void;
  /** Slide layouts (doc 28 FR-3/FR-4, materialization model): capture the
   *  ACTIVE page as a named reusable layout (background + text placeholders).
   *  Ensures a default master exists. Returns the new layout id. */
  savePageAsLayout(name: string): string | null;
  /** F28 T20 stage 1: extract a reusable layout set from EVERY page of the
   *  deck, heuristics only (largest text = title, other text = body/content
   *  with capacity hints, images/charts/media = slots, decoration ignored);
   *  near-identical pages collapse into one layout. Installs the set and
   *  links each source page that has no layout yet, as ONE undo step.
   *  Returns the counts, or null when the deck yields no layouts. Stage 2
   *  passes a precomputed set (vision-corrected off-store); without one the
   *  heuristics run right here. */
  extractLayoutsFromDeck(precomputed?: ExtractedLayoutSet): { created: number; linked: number } | null;
  /** Link a page to a layout (null unlinks) and materialize it: the layout's
   *  background applies and missing placeholders land as editable text boxes
   *  (tagged via data.placeholderId). One undo step. */
  applyLayoutToPage(layoutId: string | null, pageIndex?: number, opts?: { pruneObsolete?: boolean }): boolean;
  /** T12: write generated content into a page's materialized placeholder boxes
   *  (matched by data.placeholderId): plain text for title/body slots, one
   *  bulleted paragraph per item for content lists. One undo step; boxes not
   *  named in the fill keep their current content. */
  fillPlaceholderContent(pageIndex: number, fill: { texts: Record<string, string>; lists: Record<string, string[]> }, opts?: { styles?: Record<string, { fontFamily?: string; fill?: Fill }> }): boolean;
  /** T12/T10: place a resolved image into a picture placeholder, addressed by
   *  page id + placeholder id (late async results must not depend on the
   *  active page). Replaces the placeholder's materialized box (or a previous
   *  generated image for the slot) with an image node at the slot's rect,
   *  stamped with data.placeholderId + data.aiImagePrompt. Returns false when
   *  the page or slot no longer exists. */
  applyGeneratedImageToPlaceholder(pageId: string, placeholderId: string, url: string, prompt: string): boolean;
  /** Re-capture the layout's background + placeholders from the active page. */
  updateLayoutFromPage(layoutId: string): boolean;
  /** Re-apply a layout to EVERY page linked to it (background + missing
   *  placeholders), one undo step. Returns how many pages changed. */
  syncLayoutPages(layoutId: string): number;
  /** Bulk data-merge into slides (doc 28): duplicate the ACTIVE page once per
   *  row, replacing {{column}} tokens in text runs and sticky notes with the
   *  row's values. One undo step; returns the number of pages created. */
  bulkMergePages(rows: Record<string, string>[]): number;
  /** Reorder pages (move page at `from` to index `to`), undoable. */
  movePage(from: number, to: number): void;
  /** Start a new section at `pageIndex`, adopting the run that follows (FR-5). */
  addSection(pageIndex: number, name?: string): void;
  renameSection(sectionId: string, name: string): void;
  /** Delete the section record; its slides become unsectioned (never deleted). */
  removeSection(sectionId: string): void;
  toggleSectionCollapsed(sectionId: string): void;
  /** Assign (or clear) a slide's section. */
  setPageSection(pageIndex: number, sectionId: string | undefined): void;
  /** Re-parent top-level nodes from the active page to another page (a cross-page
   *  drag-drop), converting their coordinates into the destination page's local
   *  space and appending them as the top layers there. `before` holds each node's
   *  transform at the drag start, so undo restores the original page + position.
   *  One undo step. */
  moveNodesToPage(ids: string[], destIndex: number, before: Map<string, Transform>): void;
  /** Magic Resize (F22 FR-1/FR-2/FR-3): constraint-aware re-layout of the active
   *  page to one or more target sizes, appended as new pages after it, preserving
   *  node ids/z-order/groups. All targets land as ONE undo step. Returns the new
   *  page ids. Runs synchronously (async jobs deferred). */
  magicResizePages(targets: ResizeTarget[]): string[];
  /** Magic Design (F22 FR-4): build a finished, editable design from a parsed
   *  spec (background + fraction-positioned elements) onto the active page.
   *  Sets the page size + background and creates text/accent nodes mapped to the
   *  target size, all as ONE undo step. Returns the new node ids. */
  buildMagicDesign(spec: MagicDesignSpec, target: { width: number; height: number }): string[];

  /** F39 AI Creative Studio: build a finished, editable design from a validated
   *  AiDesignSpec (content + roles + layout intent). The @hc/aistudio layout
   *  engine owns positions, the type scale, alignment, z-order, and WCAG-readable
   *  text color, so output is consistent and never overlaps/overflows. Sets the
   *  page size + background and creates the nodes as ONE undo step. Returns ids. */
  buildAiDesign(spec: AiDesignSpec, target: { width: number; height: number }): string[];

  /** F39: apply an AI-generated design supplied as a complete SVG document onto
   *  the active page, fully editable. The SVG (from a text model such as DeepSeek)
   *  is drawn at the target size, so its flattened nodes land in page space with
   *  no scaling. Sets the page size and replaces its nodes as ONE undo step.
   *  Returns the new node ids (empty when the SVG yields no nodes). */
  buildSvgDesign(svg: string, target: { width: number; height: number }): string[];

  /** F39 Phase 2: replace the whole document with a generated multi-page design
   *  (deck/doc/social set). Each DeckResult page becomes a page sized to target,
   *  with the engine-laid-out background + nodes. Applied as ONE undo step.
   *  Returns the new page ids. */
  buildDeckFromOutline(deck: DeckResult, target: { width: number; height: number }): string[];

  /** F39 FR-4: append generated pages (e.g. one page pulled from a different
   *  style option) after the last page, as ONE undo step. Returns new page ids. */
  appendDeckPages(deck: DeckResult, target: { width: number; height: number }): string[];

  /** F39 Phase 3: run `fn` (which calls other store mutators) and collapse every
   *  undo entry it pushes into ONE undo turn, so an assistant turn reverts with a
   *  single Cmd+Z (FR-8). Returns the number of entries collapsed. */
  runAsTurn(fn: () => void): number;

  /** F39 FR-27: record generation provenance (feature, prompt, model, seed) into
   *  doc.meta.aiProvenance for reproducibility/audit. Metadata only - not an undo
   *  step. */
  recordProvenance(entry: { feature: string; prompt?: string; model?: string; seed?: string }): void;

  // tools
  setTool(tool: Tool): void;
  setCropping(id: string | null): void;
  setMaskRefining(id: string | null): void;
  setEditingText(id: string | null): void;
  setPresenting(on: boolean): void;
  toggleRulers(): void;
  toggleGrid(): void;
  toggleSnap(): void;
  setGridSize(n: number): void;
  /** Add a manual guide on the active page (x = vertical line, y = horizontal). */
  addGuide(axis: "x" | "y", pos: number): void;
  /** Move a manual guide by index; pass null pos to remove it. */
  setGuide(axis: "x" | "y", index: number, pos: number | null): void;
  setSnapGuides(g: { x: number[]; y: number[] } | null): void;
  /** Start a new vector path at a page point; returns the new node id. */
  penStart(x: number, y: number): string;
  /** Append an anchor (page coords) to the in-progress path. */
  penAdd(id: string, x: number, y: number): void;
  /** Set a smooth bezier handle on the last anchor (page coords). */
  penHandle(id: string, x: number, y: number): void;
  /** Close the path. */
  penClose(id: string): void;
  /** Start a line/arrow at a page point (both endpoints there); returns its id. */
  addLine(x: number, y: number, arrow: boolean): string;
  /** Drag a line's end endpoint to a page point. */
  updateLineEnd(id: string, x: number, y: number): void;
  /** Create a rectangle/ellipse at a page point (size 0) for drag-to-draw; returns its id. */
  addShapeAt(x: number, y: number, shape: "rect" | "ellipse"): string;
  /** Create a text box at a page point and return its id (then enter edit mode). */
  addTextAt(x: number, y: number): string;
  /** Whiteboard linking: create an arrowed elbow connector attached
   *  to two nodes (auto anchors by default) as one undo step; selects + returns
   *  it, or null if the nodes are missing/identical. */
  connectNodes(fromId: string, toId: string, fromAnchor?: string, toAnchor?: string): string | null;
  /** Materialize a diagram spec (doc 30 Phase 3: AI diagram-from-prompt or a
   *  pasted Mermaid graph) as native board nodes: one sticky per node laid out
   *  by the pure flowchart/mind-map engine, one connector per edge, all as ONE
   *  undo step. Returns false when the spec is empty. */
  insertDiagramSpec(spec: WbDiagramSpec): boolean;
  /** Every unlocked sticky on the active page (id + text), for AI clustering
   *  and summarize (doc 30 Phase 3). */
  collectBoardStickies(): { id: string; text: string }[];
  /** Cluster stickies into labeled frames (doc 30 Phase 3): one frame per
   *  cluster laid out below the existing content, member stickies arranged in
   *  a grid inside it. One undo step; unknown ids are skipped. */
  applyStickyClusters(clusters: { title: string; ids: string[] }[]): boolean;
  /** Drop an AI summary as a text note below the existing board content. */
  insertSummaryNote(text: string): boolean;
  /** Set the route style (straight/elbow/curved) on the selected connector(s),
   *  the board connector style picker (F30 FR-7). One undo step. */
  setConnectorRoute(route: "straight" | "elbow" | "curved"): void;
  /** Spawn a new shape at `point` and connect `fromId` to it as one undo step
   *  (F30 FR-7 spawn-shape-from-handle); selects + returns the new shape id. */
  spawnConnectedShape(fromId: string, fromAnchor: string, point: { x: number; y: number }): string | null;
  /** Set (or clear, when blank) a connector's label text (F30 FR-8). One undo step. */
  setConnectorLabel(id: string, text: string): void;
  /** Replace a connector's draggable bend waypoints (F30 FR-8). Empty clears them.
   *  One undo step (used for add/move/remove of bends). */
  setConnectorWaypoints(id: string, waypoints: { x: number; y: number }[]): void;
  /** Set a node's position + size directly (no undo entry); for live draw drag. */
  setNodeRect(id: string, x: number, y: number, w: number, h: number): void;
  /** Snapshot a path node's geometry for an undoable node-edit gesture. */
  snapshotPath(id: string): unknown;
  /** Move an anchor (and its handles) to a page point during a node edit. */
  editAnchor(id: string, index: number, x: number, y: number): void;
  /** Move a bezier handle of an anchor to a page point during a node edit. On a
   *  smooth anchor the opposite handle mirrors; on a corner anchor handles move
   *  independently. */
  editHandle(id: string, index: number, which: "in" | "out", x: number, y: number): void;
  /** Insert an anchor on the segment between anchors `index` and `index+1` at
   *  parametric `t` (0..1), subdividing the bezier so the curve is preserved.
   *  One undo step. */
  insertAnchor(id: string, index: number, t: number): void;
  /** Delete an anchor (rejoining its neighbours). Refuses to drop an open path
   *  below 2 anchors / a closed path below 3. One undo step. */
  deleteAnchor(id: string, index: number): void;
  /** Delete several anchors at once (e.g. a multi-selection), as one undo step. */
  deleteAnchors(id: string, indices: number[]): void;
  /** Flip an anchor between corner and smooth. A smooth anchor gains symmetric
   *  handles derived from its neighbours; a corner anchor drops its handles.
   *  One undo step. */
  convertAnchor(id: string, index: number): void;
  /** Commit a path node-edit gesture as one undo step (before = snapshotPath). */
  commitPathEdit(id: string, before: unknown): void;
  /** Create a path node from raw freehand points (page coords): simplify +
   *  bezier-fit them into smooth segments. Returns the new node id (one undo
   *  step), or null if there were too few points. */
  addPencilPath(points: { x: number; y: number }[]): string | null;
  /** Commit a board ink stroke as a dedicated `ink` node (F30 FR-5): decimate +
   *  lightly smooth the captured point stream (with optional pressure), using the
   *  current brush width/color/opacity/mode. One undo step; returns the node id. */
  addInkStroke(points: { x: number; y: number; p?: number }[]): string | null;
  /** Drop a sticky note centered on a page point as one undo step; selects and
   *  returns it (F30 sticky speed: double-click-drop and Tab-to-spawn). */
  addStickyAt(x: number, y: number): string;
  /** The active emoji/vote glyph the stamp tool places (FR-21). */
  stampGlyph: string;
  setStampGlyph(glyph: string): void;
  /** Local (per-client, never synced) private-round tracking (FR-15): the baseline
   *  of node ids that existed when the round started + the ids this client created
   *  during it. Null when no round is active. */
  privateRound: { startedAt: number; baseline: Set<string>; mine: Set<string> } | null;
  /** Reconcile the local private round to the synced `privateMode` meta: capture a
   *  fresh baseline (current node ids) when a new round starts, clear when it ends. */
  syncPrivateRound(pm: { active: boolean; revealed: boolean; startedAt: number } | undefined): void;
  /** Node ids to visually hide right now for private mode: other participants'
   *  contributions made since the round started (empty unless hiding). */
  privateHiddenIds(): ReadonlySet<string>;
  /** Drop an emoji/vote stamp centered on a page point as one undo step (FR-21);
   *  selects and returns it. `authorId` records who placed it for dot-vote tally. */
  addStampAt(x: number, y: number, authorId?: string): string;
  /** Object-eraser (F30 FR-4): remove a top-level node by id as one undo step,
   *  skipping locked / collab-locked / brand-locked nodes. No-op if not found. */
  eraseNode(id: string): void;
  /** Combine the selected shapes with a boolean op into one boolean node. */
  booleanSelection(op: BooleanOp): void;
  /** Convert the selected shape/path's stroke into a filled outline node (F26). */
  strokeToOutlineSelection(): void;
  /** Replace the selected freehand path with a recognized clean shape (F26). */
  recognizeSelectedPath(): void;
  // clipboard + quick edits
  copySelection(): void;
  cutSelection(): void;
  /** Paste the internal clipboard, nudged by `offset` px (default 24). */
  paste(offset?: number): void;
  /** Paste the internal clipboard at the copied position (Cmd+Shift+V). */
  pasteInPlace(): void;
  /** Paste design nodes pasted from the system clipboard (cross-tab/refresh, or
   *  another design): re-id, offset, insert on the active page, and select. */
  pasteNodes(nodes: Node[]): void;
  /** Insert a text box with the given content (e.g. text pasted from another
   *  app) at `at` (page coords) or centered in the viewport. */
  addTextBox(text: string, at?: { x: number; y: number }): void;
  /** Duplicate the selection on the active page (offset dx,dy); returns new ids. */
  duplicateSelection(dx?: number, dy?: number): string[];
  /** Move the selection by (dx,dy), undoable (arrow-key nudge). */
  nudge(dx: number, dy: number): void;
  /** Grow/shrink the selection's size by (dw,dh), undoable (Alt+arrow keyboard
   *  resize). Routes text/line/grid/frame through the same geometry appliers
   *  the properties panel uses so their content re-lays with the box. */
  growSelection(dw: number, dh: number): void;
  /** Rotate the selection by deltaDeg about each node's own rotation origin
   *  (center by default, mirroring the rotate handle), one undoable step
   *  (keyboard rotate: comma/period, Alt for 15 degrees). */
  rotateSelection(deltaDeg: number): void;
  /** Copy the first selected node's style; paste it onto the selection. */
  copyStyle(): void;
  pasteStyle(): void;
  /** Move a node to a new z-order index on the active page, undoable. */
  reorderLayer(id: string, toIndex: number): void;
  /** Set a single node's hidden/locked flag (no selection change), undoable. */
  setNodeHidden(id: string, hidden: boolean): void;
  setNodeLocked(id: string, locked: boolean): void;
  /** Set/replace a node's typed animation set (entrance/exit/emphasis), undoable.
   *  Pass undefined to clear all animation. Clears the legacy `animations`/`link`
   *  slots so the typed model is the single source of truth. */
  setNodeAnimation(id: string, anim: NodeAnimation | undefined): void;
  /** Apply the active page's transition to every page, one undo step (FR-10). */
  applyTransitionToAllPages(): void;
  /** Magic Animate: apply tasteful, staggered entrance animations to every
   *  top-level element on the active page in one undoable step (or clear them). */
  magicAnimatePage(clear?: boolean): void;
  /** Magic-animate EVERY slide in one undo turn (C05). Slides that already
   *  carry any node animation are skipped unless `replaceExisting`; returns
   *  how many slides were animated. */
  magicAnimateAllPages(replaceExisting?: boolean): number;
  /** Set/clear a node's custom keyframe timeline (F25), preserving presets. */
  setNodeKeyframes(id: string, track: KeyframeTrack | undefined): void;
  /** Set/clear a node's interaction (trigger + action), undoable. Mirrors the
   *  action into the legacy `link` slot for open-link so exporters that only
   *  know hyperlinks still see it. */
  setInteraction(id: string, interaction: Interaction | undefined): void;
  /** Set/clear an image node's photo motion (ken-burns/parallax), undoable. */
  setImageMotion(id: string, motion: ImageMotion | undefined): void;
  /** Set/clear the active (or given) page's slide transition, undoable. */
  setPageTransition(transition: PageTransition | undefined, pageIndex?: number): void;
  /** Set/clear how this page LEAVES when advancing away (v22 exit transition). */
  setPageTransitionOut(transition: PageTransition | undefined, pageIndex?: number): void;
  /** Set the active (or given) page's speaker notes, undoable. */
  setPageNotes(notes: string, pageIndex?: number): void;
  /** Assign (or clear) the slide layout this page inherits (doc 28 FR-3). */
  setPageLayout(layoutId: string | undefined, pageIndex?: number): void;
  /** Install the built-in master + layouts on a deck that has none (FR-3). */
  ensureSlideLayouts(size?: { width: number; height: number }): void;
  /** Adopt a theme for the whole deck in one undoable action (FR-4). By
   *  default content painted with the previous theme's exact slot colors and
   *  fonts follows the swap (T19); `restyle: false` swaps only the record -
   *  for stamping a theme onto pages ALREADY painted with its colors, where a
   *  remap from the outgoing theme would misfire. */
  setDeckTheme(theme: Theme | undefined, opts?: { restyle?: boolean }): void;
  /** Set/clear the active (or given) page's autopilot dwell in ms;
   *  pass null to clear (fall back to the global default). Undoable. */
  setPageAutoAdvance(ms: number | null, pageIndex?: number): void;
  /** Set whether the active (or given) page is hidden/skipped while presenting
   *, undoable. */
  setPageHidden(hidden: boolean, pageIndex?: number): void;
  /** Preview every node's entrance + emphasis animation on the active page
   *  (transient, no undo) using the shared engine playback math. */
  playAnimations(): void;
  /** Preview a single node's animation: play its entrance once then loop its
   *  emphasis briefly (transient, no undo). Used by the panel "Preview" button. */
  previewNodeAnimation(id: string): void;
  /** Insert a table node with sample contents. */
  insertTable(rows?: number, cols?: number): void;
  /** Insert a chart node with sample data. */
  insertChart(chartType?: ChartNode["chartType"]): void;
  /** Magic Charts (F22 FR-7): insert an editable chart node built from supplied
   *  data (categories + numeric series), seeding default series colors from
   *  @hc/color. One undo step. Returns the new node id. */
  insertChartData(data: { chartType: ChartNode["chartType"]; categories: string[]; series: { name: string; values: number[] }[] }): string;
  /** Patch a chart node's type/categories/series/style, undoable. */
  setChart(id: string, patch: { chartType?: ChartNode["chartType"]; categories?: string[]; series?: { name: string; values: number[]; color?: Color }[]; style?: ChartStyle }): void;
  /** Set the color of a single chart series, undoable. */
  setChartSeriesColor(id: string, seriesIndex: number, color: Color): void;
  /** Rebuild a table node's cells from a string grid (row 0 = header), undoable. */
  setTableData(id: string, grid: string[][]): void;
  /** Set/clear a chart or table's live data binding (F27), undoable. */
  setDataBinding(id: string, binding: DataBinding | undefined): void;
  /** Re-apply a node's bound data: re-parse inline CSV or fetch the URL, then
   *  map it into the chart/table. Returns false on no binding / fetch failure. */
  refreshBinding(id: string): Promise<boolean>;
  /** Insert a blank row at index `at` (0..rows). Undoable. */
  addTableRow(id: string, at?: number): void;
  /** Remove the row at index `at`. Undoable; a no-op below 1 row. */
  removeTableRow(id: string, at: number): void;
  /** Insert a blank column at index `at` (0..cols). Undoable. */
  addTableColumn(id: string, at?: number): void;
  /** Remove the column at index `at`. Undoable; a no-op below 1 column. */
  removeTableColumn(id: string, at: number): void;
  /** Merge the cell at (row,col) with its right or below neighbor (matching span
   *  on the shared edge). Undoable. */
  mergeTableCell(id: string, row: number, col: number, dir: "right" | "down"): void;
  /** Reset the cell at (row,col) to 1x1, re-adding the cells it covered. Undoable. */
  splitTableCell(id: string, row: number, col: number): void;
  /** Patch the table's header/border styling, undoable. */
  setTableStyle(id: string, patch: { headerStyle?: TableHeaderStyle; borderStyle?: TableBorderStyle }): void;
  /** Patch a single cell's formatting (align/fill/textColor), undoable. */
  setTableCellStyle(id: string, row: number, col: number, patch: { align?: "left" | "center" | "right"; fill?: Fill; textColor?: Color }): void;
  /** Replace a table's conditional-formatting rules (F27), undoable. */
  setTableConditional(id: string, rules: TableConditionalRule[]): void;

  // editing
  runCommand(cmd: EditCommand): void;
  /** Bump rev to repaint during a live gesture (no undo entry). */
  tick(): void;
  /** Record commands already applied live (one gesture) as a single undo step. */
  pushApplied(cmds: EditCommand[]): void;
  /** Record an already-applied transform/size/box/content change as one undo step
   *  (e.g. a text resize that also reflowed the box and scaled fonts). */
  pushNodeSnapshot(id: string, before: { transform: Transform; size: { width: number; height: number }; box?: unknown; content?: unknown; points?: unknown; children?: unknown }): void;
  addNode(type: Exclude<NodeType, "model3d">, init?: Partial<Node>): void;
  /** Place an image node from a URL, registering it as a design asset. */
  /** Add an image; `at` (page point) centers it there (e.g. a drag-drop), else viewport-centered.
   *  `provenance` (stock origin + license) rides the node for attribution credits. */
  addImage(url: string, at?: { x: number; y: number }, provenance?: Record<string, unknown>): void;
  /** F39 FR-24: place a generated/selected image as a full-page background -
   *  sized to the active page, at the back of the z-order, as ONE undo step. */
  addPageBackgroundImage(url: string): void;
  /** T10: apply a resolved AI/stock image as a page's full-bleed background,
   *  addressed BY PAGE ID (late async resolutions must not depend on the
   *  active page), stamped with the generation prompt (node.data.aiImagePrompt)
   *  so identical prompts can be diffed/reused later. Replaces a previous
   *  generated background instead of stacking. Returns false when the page no
   *  longer exists (the design changed - the guard against late results). */
  applyGeneratedBackground(pageId: string, url: string, prompt: string): boolean;
  /** Insert an SVG icon as an editable, scaled vector group, viewport-centered.
   *  `provenance` (e.g. stock asset id + license) is stamped on the group's data
   *  in the same undo step, so attribution can be compiled from the design. */
  addIconSvg(svg: string, provenance?: Record<string, unknown>): void;
  /** Insert a photo grid: a grid container whose cells are image frames you can
   *  drop photos into. `spans` overrides the default uniform one-cell-per-slot
   *  layout with an explicit cell list (row/col plus row/col spans) for feature
   *  layouts such as one large cell beside two small ones. Returns the grid
   *  node id. */
  insertPhotoGrid(rows: number, cols: number, spans?: GridSpan[]): string | null;
  /** Re-lay a grid's cells (rows/cols/gap), preserving any filled cell images.
   *  A gap-only change keeps the existing cell list (including spans); changing
   *  rows or cols rebuilds a uniform layout. */
  setGridLayout(id: string, patch: { rows?: number; cols?: number; gap?: number }): void;
  /** Append imported pages (e.g. from a PDF), each sized to the source page with
   *  its editable nodes, and switch to the first new page. Undoable. */
  importPdfPages(pages: { width: number; height: number; nodes: Node[] }[]): void;
  /** Apply a template into the CURRENT design: append its pages (fresh node and
   *  page ids, assets and uploaded-font refs merged) and switch to the first
   *  one. Pages authored at a different size are resized to the active page's
   *  dimensions on insert (the design-resize mapping), so applying any gallery
   *  template never creates a mixed-size document. Additive by design, so
   *  applying a template never destroys existing pages; one undo step. Returns
   *  false when nothing was applied (read-only session, history preview, or an
   *  empty template). */
  applyTemplateFile(file: DesignFile, title: string): boolean;
  /** Import a full SVG file (e.g. an SVG export from another design tool) as editable elements:
   *  shapes/paths/text/images, registered assets, scaled to fit the page and
   *  grouped (ungroup to edit each element). Undoable. */
  importSvg(svg: string): void;
  /** Set node-level fills to a single solid color (hex), undoable. */
  setFillColor(id: string, hex: string): void;
  /** Replace a text node's first-run text, undoable. */
  /** Every translatable string in the design with a stable address: each text
   *  run (styling boundaries preserved), each sticky note, and each page's
   *  speaker notes. Locked subtrees are skipped. Powers whole-deck translation
   *  (doc 28 FR-23): translate the strings, then applyDeckTexts the results. */
  collectDeckTexts(): DeckTextEntry[];
  /** Write translated/rewritten strings back to their collected addresses as
   *  ONE undo step. Refs that no longer resolve are skipped, never fatal. */
  applyDeckTexts(entries: DeckTextEntry[]): void;
  setText(id: string, text: string): void;
  /** Set a whiteboard sticky note's text (and optional auto-fit scale) as one
   *  undo step. */
  setStickyText(id: string, text: string, fontScale?: number): void;
  /** Replace a text node's full paragraph/run content (undoable). Used by the
   *  rich text editor so per-range styling survives a commit. `boxHeightBefore`,
   *  when given, is the height to restore on undo (the height before editing
   *  began), so transient live-grow updates don't pollute the undo baseline. */
  setContent(id: string, content: Paragraph[], boxHeight?: number, boxHeightBefore?: number): void;
  /** Grow/shrink a text node's box height to fit content WITHOUT an undo step
   *  (live feedback while typing, so the selection box tracks line wraps). The
   *  final height is recorded once, undoably, by setContent on commit. */
  /** Track the box height to the content while typing (transient, no undo
   *  entry). `fixedBase` is the height when editing began: a fixed box clamps
   *  to max(fixedBase, content) so it can shrink back as lines are deleted but
   *  never below the user's chosen height. */
  growTextBoxLive(id: string, height: number, fixedBase?: number): void;
  /** Set (or clear, with null) a text node's background highlight,
   *  a padded rounded rect filled behind the text. Undoable. */
  setTextBackground(id: string, color: Color | null, padding?: number, radius?: number): void;
  /** Set (or clear, with null) the single named text effect on a text node
   *  (shadow/lift/hollow/splice/echo/neon/glow/outline). Effects are mutually
   *  exclusive; the background highlight is kept separate. Undoable. */
  setTextEffect(id: string, effect: TextEffect | null): void;
  /** Set a text node's vertical alignment within its box (top/middle/bottom). */
  setVerticalAlign(id: string, v: "top" | "middle" | "bottom"): void;
  /** Set a text node's box sizing mode (fixed / auto-height / auto-width). */
  setTextBoxMode(id: string, mode: "fixed" | "autoHeight" | "autoWidth"): void;
  /** Toggle shrink-to-fit for a fixed text box (text scales down instead of
   *  overflowing when the content outgrows the box). */
  setTextAutoFit(id: string, enabled: boolean): void;
  /** Set a text node's column count + gutter (1 column clears it). */
  setTextColumns(id: string, count: number, gutter?: number): void;
  /** Set a text node's language tag (BCP-47) for locale-aware spellcheck; "" clears. */
  setTextLang(id: string, lang: string): void;
  /** Swap a shape node's kind in place, keeping size/fills/stroke/transform. */
  setShapeKind(id: string, shape: "rect" | "ellipse" | "triangle" | "polygon" | "star"): void;
  /** Set (or clear, with undefined) a node's rotation pivot, normalized 0..1
   *  within its box; the gizmo rotates about it. */
  setRotationOrigin(id: string, origin: { x: number; y: number } | undefined): void;
  /** Record an uploaded font in the design (cross-device): a FontRef with the
   *  asset URL so the font loads when the design opens on another device. */
  addDocFont(ref: { id: string; family: string; url: string }): void;
  /** Curve a text node's baseline along an arc ; 0 clears it. */
  setCurve(id: string, curvature: number): void;
  /** Replace all occurrences of `find` with `replace` across every text node in
   *  the document, undoable. Returns the number of text nodes changed. */
  findReplace(find: string, replace: string): number;
  /** Re-skin the whole document to a brand: remap every on-canvas
   *  color to its nearest brand-palette color and every font family to the kit's
   *  fonts, NON-destructively as ONE undoable step. Returns the color + font
   *  mappings that were applied (for the preview/override UI). A no-op (empty
   *  mappings, no undo entry) when nothing changes. An optional per-color
   *  `overrides` map (source hex -> chosen brand hex, or "keep") lets the UI
   *  re-apply with manual choices as one undo step; colors absent from the map
   *  keep the default nearest-color behavior. */
  reskinToBrand(brand: ReskinBrand, overrides?: ReskinOverrides): ReskinResult;
  /** Apply one or more brand-lint fixes to their target nodes as a
   *  SINGLE undoable step. Auto-fixable kinds (snap_color/swap_font/fix_contrast)
   *  recolor/swap the node; restore_logo carries no auto-fix and is skipped here.
   *  Returns the number of fixes actually applied. */
  applyBrandFixes(fixes: BrandFixTarget[]): number;
  /** Patch character and/or paragraph style across a whole text node, undoable. */
  setTextStyle(id: string, char?: Partial<CharStyle>, para?: Partial<ParagraphStyle>): void;
  /** Replace a node's fills (solid/gradient), undoable. */
  setFills(id: string, fills?: Fill[]): void;
  /** Set an image node's fit mode, undoable. */
  setImageFit(id: string, fit: ImageFit): void;
  setImageCrop(id: string, crop: CropRect | undefined): void;
  /** Replace an image node's source with a new URL (resets crop), undoable. */
  setImageSource(id: string, url: string): void;
  /** Attach or clear an image's alpha mask (v20), undoable. Non-destructive:
   *  the original `source` is untouched. */
  setImageAlphaMask(id: string, url: string | null, width: number, height: number): void;
  /** Set/clear an image node's accessibility alt text (F22 FR-12), undoable. */
  setImageAlt(id: string, alt: string | undefined): void;
  /** Set/clear any node's accessibility description (doc 28 FR-29), undoable. */
  setNodeAltText(id: string, altText: string | undefined): void;
  /** Mark a node presentational, so checkers and accessible exports skip it. */
  setNodeDecorative(id: string, decorative: boolean): void;
  /** Reorder a page's reading order by moving index `from` to `to` (FR-29). */
  moveReadingOrder(from: number, to: number, pageIndex?: number): void;
  /** Clear the explicit reading order, falling back to z-order (FR-29). */
  resetReadingOrder(pageIndex?: number): void;
  /** Replace an image node's source AND set its box to a known size in one
   *  undoable step (Magic Expand / outpaint: the padded result has a new aspect
   *  computed client-side, so we set it directly rather than waiting on load). */
  outpaintImage(id: string, url: string, width: number, height: number): void;
  /** Rebind a QR node's value and regenerate its module matrix, undoable. */
  setQrValue(id: string, value: string): void;
  /** Set (or clear, with assetId=null) a QR node's center logo. Adding a logo
   *  bumps error correction to "H" so the covered modules stay scannable. */
  setQrLogo(id: string, assetId: string | null, url?: string): void;
  /** Center-logo size as a fraction (0.08..0.4) of the QR's min dimension. */
  setQrLogoScale(id: string, scale: number): void;
  /** Set a video node's trim/volume/loop/mute, undoable. */
  setVideoProps(id: string, patch: Partial<{ trimStartMs: number; trimEndMs: number; volume: number; muted: boolean; loop: boolean }>): void;
  /** Place an image into a frame (clipped to the frame), undoable. */
  setFrameImage(id: string, url: string, provenance?: Record<string, unknown>): void;
  /** Drop an on-canvas IMAGE NODE onto a frame or shape: fill the target with
   *  the image's asset and remove the dragged node, as ONE undo step (undo
   *  restores the node at `restoreTransform`, its pre-drag position). Returns
   *  false when either side is locked/blocked so the caller falls back to a
   *  plain move. */
  fillWithImageNode(targetId: string, kind: "frame" | "shape", imageId: string, restoreTransform?: Transform): boolean;
  /** True when the node is an image serving as its page's background: flagged
   *  via `data.background` (set by setImageAsBackground), or a hand-built
   *  background - a bottom-of-stack, top-level image covering the whole page.
   *  Background status always requires the node to be LOCKED: unlocking a
   *  background suspends it (the image acts like a plain element and "Set as
   *  background" reappears); re-setting a still-flagged image keeps its
   *  original pre-background state for detach. */
  isBackgroundImage(id: string): boolean;
  /** Make a top-level image the page background as ONE undo step: reshape it
   *  to a page-sized box at scale 1 with the source covering it (fit "cover",
   *  flips preserved), send it to the back, lock it, and flag it via
   *  `data.background`. The prior transform/size/fit and z-index are saved in
   *  `data.backgroundRestore` so detach can put the image back. The scale-1
   *  box is what the crop overlay requires, so the background stays
   *  adjustable (pan/zoom via setImageCrop) while locked. An image currently
   *  serving as this page's background is detached in the same step, so the
   *  new background is not buried under it. */
  setImageAsBackground(id: string): void;
  /** Reverse of setImageAsBackground: unlock the image, restore the saved
   *  pre-background transform/size/fit and z-index when present (a hand-built
   *  background just unlocks in place), and clear the background flag. */
  detachImageBackground(id: string): void;
  /** Fill a shape with an image, clipped to its outline (undoable). Pass an
   *  empty url to clear the image fill back to a solid color. */
  setImageFill(id: string, url: string): void;
  /** Set (or clear, with empty url) a tiled pattern fill on a shape. */
  setPatternFill(id: string, url: string, opts?: { scale?: number; rotation?: number; repeat?: "tile" | "mirror" | "no-repeat" }): void;
  /** Adjust an existing pattern fill's scale/rotation/repeat (keeps the asset). */
  setPatternParams(id: string, patch: { scale?: number; rotation?: number; repeat?: "tile" | "mirror" | "no-repeat" }): void;
  /** Set a frame's mask shape (rectangle/rounded/ellipse), undoable. */
  setFrameShape(id: string, mask: "rect" | "ellipse", radius: number): void;
  /** Convert a shape/path node into an image frame clipped to its outline, undoable. */
  convertToFrame(id: string): void;
  /** Set/clear a node's stroke (border), undoable. */
  setStroke(id: string, stroke?: Stroke): void;
  /** Set/clear a node's effects (shadow/blur/glow), undoable. */
  setEffects(id: string, effects?: Effect[]): void;
  /** Move an effect within the stack; order is the render order. */
  moveEffect(id: string, from: number, to: number): void;
  /** Switch one effect off without losing its parameters. */
  setEffectEnabled(id: string, index: number, enabled: boolean): void;
  /** Remove one effect by position, so duplicates of a kind are addressable. */
  removeEffectAt(id: string, index: number): void;
  /** Append an effect of a kind, allowing more than one of the same kind. */
  addEffect(id: string, kind: Effect["kind"]): void;
  /** Live-preview color adjustments (brightness/contrast/...) with no undo step. */
  previewAdjustments(id: string, ops: { name: string; value: number }[]): void;
  /** Commit an effects change as one undo step (before = effects at gesture start). */
  commitEffects(id: string, before: unknown): void;
  /** Live-preview a node's whole effects array with no undo step (slider drags). */
  previewEffects(id: string, effects?: Effect[]): void;
  /** Live-preview a text node's whole textEffects array with no undo step. */
  previewTextEffects(id: string, effects?: TextEffect[]): void;
  /** Commit a textEffects change as one undo step (before = value at gesture start). */
  commitTextEffects(id: string, before: unknown): void;
  /** Set a uniform corner radius on a shape/frame node, undoable. */
  setCornerRadius(id: string, radius: number): void;
  /** Set a uniform corner radius on every rect-ish node in the selection (one undo step). */
  setCornerRadiusSel(radius: number): void;
  /** Toggle a drop shadow on every shape-like node in the selection (one undo step). */
  setShadowSel(on: boolean): void;
  deleteSelection(): void;
  group(): void;
  ungroupSelection(): void;
  orderSelection(op: "front" | "back" | "forward" | "backward"): void;
  alignSelection(edge: AlignEdge): void;
  distributeSelection(axis: "h" | "v", by: "edge" | "gap"): void;
  /** Mirror the selection horizontally/vertically about its bounding-box center. */
  flipSelection(axis: "h" | "v"): void;
  tidySelection(): void;
  setLockedSel(v: boolean): void;
  /** Lock (or unlock) every top-level element on the active page. */
  lockAllOnPage(v: boolean): void;
  setHiddenSel(v: boolean): void;
  setOpacitySel(v: number): void;
  setBlendSel(mode: BlendMode): void;
  /** Recolor every fill-bearing node in the selection (solid) as one undo step. */
  setFillColorSel(hex: string): void;
  /** Apply a fills array (e.g. gradient) to every fill-capable node in the selection. */
  setFillsSel(fills: Fill[]): void;
  /** Set a single text node's color (every run) to a hex, as one undo step. Used
   *  by the algorithmic design-critique "fix contrast" action (F22 FR-14). */
  setTextColor(id: string, hex: string): void;
  /** Move a single node by (dx,dy) in its parent space, as one undo step. Used by
   *  critique fixes that bring an off-canvas element back into bounds (F22). */
  moveNodeBy(id: string, dx: number, dy: number): void;
  /** Apply a batch of style-harmonization changes (F22 FR-8) across the active
   *  page atomically as ONE undo step: collapse fonts, snap colors to roles, and
   *  unify corner radii. Returns the number of nodes changed. */
  applyHarmonize(changes: AssistHarmonizeChange[]): number;
  /** Assign a coherent staggered entrance animation to the given nodes (F22
   *  FR-11) as ONE undo step. Each entry sets `animation.entrance`, preserving
   *  any existing exit/emphasis. */
  autoAnimate(assignments: AssistAnimateAssignment[]): number;
  /** Clear every node's animation on the active page as ONE undo step (F22). */
  clearPageAnimations(): number;
  /** Set (or clear) the stroke on every strokeable node in the selection as one undo step. */
  setStrokeSel(stroke?: Stroke): void;
  /** Commit a text node's transform + size, reflowing its layout box, as one undo step. */
  applyTextGeometry(id: string, transform: Transform, size: { width: number; height: number }): void;
  /** Apply panel-entered geometry to a line node: the polyline scales with the
   *  box (a line draws from its points, so size alone changes nothing visible).
   *  An axis the polyline doesn't span stays locked. One undo step. */
  applyLineGeometry(id: string, transform: Transform, size: { width: number; height: number }): void;
  /** Apply panel-entered geometry to a photo grid: the cell frames re-lay to
   *  the new size (spans preserved, filled images keep covering their cells).
   *  One undo step. */
  applyGridGeometry(id: string, transform: Transform, size: { width: number; height: number }): void;
  /** Frame W/H/X/Y from the properties panel: the fill image scales with the
   *  box (mirrors the resize gizmo), committed as one undo step. */
  applyFrameGeometry(id: string, transform: Transform, size: { width: number; height: number }): void;
  renameNode(id: string, name: string): void;

  undo(): void;
  redo(): void;

  /** F16 per-user collaborative undo: the live CRDT binding registers a handle
   *  here while a design is open; `undo`/`redo` delegate to it so a user reverts
   *  only their own edits. Null = use the local snapshot stack (no live doc). */
  collabUndo: CollabUndo | null;
  setCollabUndo(handle: CollabUndo | null): void;
}

/** Parse a #rrggbb hex string into a schema Color (sRGB, opaque). */
function hexToColor(hex: string): { srgb: { r: number; g: number; b: number; a: number } } {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6), 16);
  const r = Number.isNaN(n) ? 0 : (n >> 16) & 255;
  const g = Number.isNaN(n) ? 0 : (n >> 8) & 255;
  const b = Number.isNaN(n) ? 0 : n & 255;
  return { srgb: { r: r / 255, g: g / 255, b: b / 255, a: 1 } };
}

/** One photo-grid cell: its slot position plus row/col spans. */
export type GridSpan = { row: number; col: number; rowSpan: number; colSpan: number };

// The local-space box of a grid cell within a grid node's box.
export function gridCellBox(size: { width: number; height: number }, rows: number, cols: number, gap: number, s: GridSpan) {
  const cellW = (size.width - gap * (cols - 1)) / cols;
  const cellH = (size.height - gap * (rows - 1)) / rows;
  return {
    x: s.col * (cellW + gap),
    y: s.row * (cellH + gap),
    width: cellW * s.colSpan + gap * (s.colSpan - 1),
    height: cellH * s.rowSpan + gap * (s.rowSpan - 1),
  };
}

/** Re-lay a photo grid's cell frames to a new grid size: each cell keeps its
 *  span from `cells` and a filled cell's image child is resized to keep
 *  covering it. Pure mutation of the given node (callers own undo). */
export function relayGridCells(
  g: { rows: number; cols: number; gap: number; cells: { row: number; col: number; rowSpan: number; colSpan: number; childId?: string }[]; children: Node[] },
  size: { width: number; height: number },
): void {
  const byId = new Map(g.children.map((n) => [n.id, n]));
  for (const cell of g.cells) {
    const frame = (cell.childId ? byId.get(cell.childId) : undefined) as unknown as
      | { transform: Transform; size: { width: number; height: number }; children?: Node[] }
      | undefined;
    if (!frame) continue;
    const box = gridCellBox(size, g.rows, g.cols, g.gap, cell);
    // Floor at 1px: a grid dragged smaller than its gaps would otherwise
    // compute negative cell sizes.
    const bw = Math.max(1, box.width);
    const bh = Math.max(1, box.height);
    frame.transform = { x: Math.max(0, box.x), y: Math.max(0, box.y), scaleX: 1, scaleY: 1, rotation: 0 };
    frame.size = { width: bw, height: bh };
    const img = frame.children?.length === 1 && frame.children[0].type === "image"
      ? (frame.children[0] as unknown as { transform: Transform; size: { width: number; height: number } })
      : null;
    if (img) {
      img.transform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
      img.size = { width: bw, height: bh };
    }
  }
}

/** Scale a frame's IMAGE children with the frame box (from a gesture-start
 *  snapshot so repeated live updates never compound). The image box scales;
 *  the bitmap re-covers it (fit "cover"), so a grown frame stays filled and a
 *  custom pan keeps its relative framing. Non-image children are untouched. */
export function scaleFrameImageChildren(
  frame: { children?: Node[] },
  startChildren: Node[],
  startSize: { width: number; height: number },
  size: { width: number; height: number },
): void {
  const kids = frame.children ?? [];
  const kx = size.width / Math.max(1, startSize.width);
  const ky = size.height / Math.max(1, startSize.height);
  for (let i = 0; i < kids.length && i < startChildren.length; i++) {
    if (kids[i].type !== "image" || startChildren[i].type !== "image") continue;
    const s = startChildren[i];
    kids[i].transform = { ...s.transform, x: s.transform.x * kx, y: s.transform.y * ky };
    kids[i].size = { width: s.size.width * kx, height: s.size.height * ky };
  }
}

// Minimal view of a PathNode for the pen tool's in-place mutations.
type PathSeg = { x: number; y: number; cIn?: { x: number; y: number }; cOut?: { x: number; y: number }; corner?: boolean };
type PathNodeLike = {
  transform: { x: number; y: number };
  segments: PathSeg[];
  contours?: { segments: PathSeg[]; closed: boolean }[];
  size: { width: number; height: number };
  closed: boolean;
};

// Re-tighten a path node: shift its transform to the min of all anchor+handle
// points (keeping absolute position) and set size to the point bounds, so the
// node stays selectable and the gizmo box hugs the path as it grows. Extra
// contours of a compound path share the node's local space, so they take part
// in the bounds and shift with the primary contour.
function normalizePath(node: PathNodeLike): void {
  const contourSegs = (node.contours ?? []).flatMap((c) => c.segments);
  const pts: { x: number; y: number }[] = [];
  for (const s of [...node.segments, ...contourSegs]) {
    pts.push({ x: s.x, y: s.y });
    if (s.cIn) pts.push(s.cIn);
    if (s.cOut) pts.push(s.cOut);
  }
  if (!pts.length) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  node.transform.x += minX;
  node.transform.y += minY;
  for (const s of [...node.segments, ...contourSegs]) {
    s.x -= minX; s.y -= minY;
    if (s.cIn) { s.cIn.x -= minX; s.cIn.y -= minY; }
    if (s.cOut) { s.cOut.x -= minX; s.cOut.y -= minY; }
  }
  node.size = { width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

/** Apply a new table shape (rows/cols/widths/heights/cells) as one undoable
 *  step, resizing the node box to match. Shared by the row/column structural
 *  ops so cells, colWidths, and rowHeights always stay consistent (F27). */
interface TableShape {
  rows: number;
  cols: number;
  colWidths: number[];
  rowHeights: number[];
  cells: TableCell[];
}
function applyTableShape(
  id: string,
  get: () => EditorState,
  perform: (redo: () => void, undo: () => void) => void,
  shape: TableShape,
): void {
  const loc = locate(get().doc, id);
  if (!loc || loc.node.type !== "table") return;
  const t = loc.node as unknown as TableNode;
  const before = structuredClone({ rows: t.rows, cols: t.cols, colWidths: t.colWidths, rowHeights: t.rowHeights, cells: t.cells, size: loc.node.size });
  const width = shape.colWidths.reduce((a, b) => a + b, 0);
  const height = shape.rowHeights.reduce((a, b) => a + b, 0);
  const after = structuredClone({ ...shape, size: { width, height } });
  const set2 = (snap: Record<string, unknown>) => {
    const l = locate(get().doc, id);
    if (!l || l.node.type !== "table") return;
    const m = l.node as unknown as Record<string, unknown>;
    m.rows = snap.rows; m.cols = snap.cols; m.colWidths = snap.colWidths; m.rowHeights = snap.rowHeights; m.cells = snap.cells;
    l.node.size = snap.size as { width: number; height: number };
  };
  perform(() => set2(structuredClone(after)), () => set2(structuredClone(before)));
}

// The boot-time scratch document, evaluated ONCE at store creation (module
// import), before any catalog loads: a tr() here freezes to English forever,
// so the strings are deliberately plain literals. It is placeholder data the
// first loadDoc replaces; node names bake in at creation time by design.
function sampleDesign(): DesignFile {
  const d = createBlankDesign({ title: "Untitled design", width: 1080, height: 1080 }); // i18n-ignore: boot placeholder
  d.pages[0].background = { type: "solid", color: { srgb: { r: 1, g: 1, b: 1, a: 1 } } };
  d.pages[0].children = [
    createNode("shape", {
      id: "rect-1",
      name: "Rectangle", // i18n-ignore: boot placeholder
      shape: "rect",
      transform: { x: 120, y: 140, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 360, height: 240 },
      fills: [{ type: "solid", color: { srgb: { r: 0.27, g: 0.51, b: 0.96, a: 1 } } }],
    } as Partial<Node>),
    createNode("shape", {
      id: "ellipse-1",
      name: "Ellipse", // i18n-ignore: boot placeholder
      shape: "ellipse",
      transform: { x: 560, y: 380, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 300, height: 300 },
      fills: [{ type: "solid", color: { srgb: { r: 0.96, g: 0.42, b: 0.27, a: 1 } } }],
    } as Partial<Node>),
    createNode("text", {
      id: "text-1",
      name: "Heading", // i18n-ignore: boot placeholder
      transform: { x: 140, y: 460, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 520, height: 80 },
      box: { mode: "fixed", width: 520, height: 80, autoFit: { enabled: false, min: 8, max: 512 }, verticalAlign: "top" },
      content: [
        {
          runs: [
            {
              text: "HyCanvas", // i18n-ignore: boot placeholder
              style: {
                fontFamily: "system",
                fontStyle: "Bold",
                fontSize: 64,
                axes: { wght: 700 },
                fill: { type: "solid", color: { srgb: { r: 0.1, g: 0.12, b: 0.16, a: 1 } } },
              },
            },
          ],
          style: { align: "left", direction: "auto" },
        },
      ],
    } as Partial<Node>),
  ];
  return d;
}

// Make a loaded design safe to render: guarantee a `meta` object and a finite,
// positive width/height on every page. Older or template-derived files (or one
// saved before a fix) can arrive without these, which otherwise produces NaN
// page frames and a broken canvas. Returns the input unchanged when already valid.
function normalizeLoadedDoc(file: DesignFile): DesignFile {
  const pages = file.pages ?? [];
  const fin = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
  // Prefer an existing valid page size (a deck's pages share one size).
  const ref = pages.find((p) => fin(p.width) && fin(p.height));
  let fw = ref && fin(ref.width) ? ref.width : NaN;
  let fh = ref && fin(ref.height) ? ref.height : NaN;
  if (!fin(fw) || !fin(fh)) {
    // Derive one consistent size from the content extent across all pages, so a
    // file with missing dimensions still renders at the right aspect (not a
    // wrong-shaped default that pushes centered content off-canvas).
    let mw = 0;
    let mh = 0;
    for (const p of pages) {
      for (const node of (p.children ?? []) as { transform?: { x: number; y: number }; size?: { width: number; height: number } }[]) {
        const t = node.transform;
        const s = node.size;
        if (t && s && fin(t.x) && fin(t.y) && fin(s.width) && fin(s.height)) {
          mw = Math.max(mw, t.x + s.width);
          mh = Math.max(mh, t.y + s.height);
        }
      }
    }
    fw = mw > 0 ? Math.round(mw) : 1080;
    fh = mh > 0 ? Math.round(mh) : 1080;
  }
  // Guarantee the top-level collections exist so mutations (asset/font imports,
  // SVG/PDF import, image placement) never hit an undefined array.
  let changed = !file.meta || !Array.isArray(file.assets) || !Array.isArray(file.fonts);
  const normPages = pages.map((p) => {
    const w = fin(p.width) ? p.width : fw;
    const h = fin(p.height) ? p.height : fh;
    if (w === p.width && h === p.height) return p;
    changed = true;
    return { ...p, width: w, height: h };
  });
  return changed
    ? { ...file, meta: file.meta ?? {}, assets: file.assets ?? [], fonts: file.fonts ?? [], pages: normPages }
    : file;
}

/** Guarantee the top-level asset/font arrays exist before a mutation pushes to
 *  them. Most docs are normalized at load, but one can enter the store via a path
 *  that skips it (e.g. a raw preview/template file), so asset-placing actions
 *  guard defensively rather than crash on `doc.assets.push`. */
function ensureDocArrays(doc: DesignFile): void {
  if (!Array.isArray(doc.assets)) (doc as { assets: AssetRef[] }).assets = [];
  if (!Array.isArray(doc.fonts)) (doc as { fonts: DesignFile["fonts"] }).fonts = [];
}

/** Reject a "refresh" that clearly did not return data. A URL that starts
 *  serving an HTML error page, a login redirect, or a JSON blob still parses
 *  (every line becomes a row), and writing that over a chart replaces real
 *  numbers with wreckage.
 *
 *  Deliberately narrow: it only refuses content that looks like MARKUP, never
 *  judges shape. Single-column tables, one-row datasets, ragged rows, and
 *  trailing blank lines are all legitimate here (parseCsvMatrix tolerates
 *  ragged rows by design, and the UI accepts pasted TSV), so a shape rule
 *  would silently stop existing bindings from refreshing. */
function looksLikeData(matrix: string[][]): boolean {
  const cells = matrix.flat();
  if (!cells.some((c) => c.trim() !== "")) return false; // nothing at all
  const head = (matrix[0] ?? []).join(" ").trim().toLowerCase();
  if (head.startsWith("<") || head.startsWith("{") || head.startsWith("[")) return false;
  return true;
}


/**
 * Default parameters for a newly added effect.
 *
 * Values match what the fixed-tab panel used, so adding a shadow from the
 * stack produces exactly what the old button did and no document changes
 * appearance because of where it was created.
 */
function newEffectOfKind(kind: Effect["kind"]): Effect | null {
  switch (kind) {
    case "shadow":
      return { kind: "shadow", type: "drop", color: { srgb: { r: 0, g: 0, b: 0, a: 0.35 } }, offsetX: 0, offsetY: 3, blur: 6, spread: 0 };
    case "blur":
      return { kind: "blur", radius: 4 };
    case "glow":
      return { kind: "glow", color: { srgb: { r: 0.45, g: 0.5, b: 1, a: 0.9 } }, radius: 10 };
    case "outline":
      return { kind: "outline", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } }, width: 3 };
    case "adjustment":
      return { kind: "adjustment", ops: [] };
    default:
      // duotone carries an asset-derived palette and is authored by its own
      // control, not summoned blank from the stack's add menu.
      return null;
  }
}

export const useEditor = create<EditorState>((set, get) => {
  // Cache for pageContentBounds(): keyed by (rev, page index) so panning (which
  // calls it every frame via the MiniMap) is O(1) unless the scene changed.
  let cbCache: { rev: number; byPage: Map<number, { x: number; y: number; width: number; height: number } | null> } | null = null;

  // Push an undo entry and apply the forward action immediately. While a CRDT
  // undo manager is bound it owns history exclusively: local entries are NOT
  // mirrored (their closures go stale the moment applyToStore rebuilds the doc
  // tree, and replaying one against a later state re-applies old edits and can
  // clobber peer changes), so the stacks stay empty for the whole session.
  const perform = (redo: () => void, undo: () => void) => {
    redo();
    if (get().collabUndo) {
      set((s) => ({ rev: s.rev + 1 }));
      return;
    }
    set((s) => ({
      rev: s.rev + 1,
      undoStack: [...s.undoStack, { undo, redo }],
      redoStack: [],
    }));
  };

  const commandEntry = (cmd: EditCommand) => ({
    redo: () => applyCommand(get().doc, cmd),
    undo: () => applyCommand(get().doc, invertCommand(cmd)),
  });

  // Restore a page snapshot INTO the existing page object (found by id), so
  // identity survives undo/redo and other closures' captured references stay
  // live - at the NODE level too: children are matched by node id and each
  // surviving node's fields restore into the existing node object (recursively
  // through groups), because most neighboring undo closures capture NODE
  // references (page resize, sticky text, find/replace), not just pages.
  // Unknown keys ride along in the snapshots. Shared by the whole-deck
  // restyle actions (setDeckTheme, reskinToBrand).
  const restoreNodeInPlace = (live: Record<string, unknown>, snap: Record<string, unknown>): void => {
    for (const k of Object.keys(live)) if (!(k in snap) && k !== "children") delete live[k];
    for (const [k, v] of Object.entries(snap)) {
      if (k === "children") continue;
      live[k] = structuredClone(v);
    }
    const snapKids = snap.children as Record<string, unknown>[] | undefined;
    if (!snapKids) {
      if ("children" in live && !("children" in snap)) delete live.children;
      return;
    }
    const byId = new Map(((live.children as Record<string, unknown>[] | undefined) ?? []).map((n) => [n.id, n]));
    live.children = snapKids.map((sk) => {
      const ln = byId.get(sk.id);
      if (ln) {
        restoreNodeInPlace(ln, sk);
        return ln;
      }
      return structuredClone(sk); // node deleted since: the clone is all there is
    });
  };
  const restorePageSnapshot = (id: string, snap: Page) => {
    const livePage = get().doc.pages.find((p) => p.id === id) as unknown as Record<string, unknown> | undefined;
    if (!livePage) return; // page deleted since: nothing to restore
    restoreNodeInPlace(livePage, snap as unknown as Record<string, unknown>);
  };

  // Re-fit a text box to its content, with the same measurer the inline editor
  // and the resize gizmo use, after anything that changes how the text wraps
  // (restyles, content rewrites, translations). One rule everywhere: a box may
  // never LIE about containing its text. An auto-height box tracks the content
  // exactly, both directions. A fixed box CLAMPS: it grows when the content
  // needs more room and returns to the user's chosen height when the content
  // shrinks, but never drops below that choice - the render never clips text,
  // so "fixed but overflowing" only produced a selection box smaller than the
  // visible text. Auto-fit boxes are exempt: they fit by scaling the FONT
  // inside a deliberate frame, so the frame itself must not move.
  const refitTextHeight = (node: Node) => {
    const n = node as unknown as { box?: { mode?: string; height: number; autoFit?: { enabled?: boolean } }; size: { height: number } };
    const mode = n.box?.mode;
    if (mode !== "autoHeight" && mode !== "fixed") return; // autoWidth: width is the free axis
    if (mode === "fixed" && n.box?.autoFit?.enabled) return;
    const content = measuredTextHeight(node as unknown as TextNode);
    const h = mode === "autoHeight" ? content : Math.max(n.size.height, content);
    if (Math.abs(n.size.height - h) < 0.5) return;
    n.size.height = h;
    n.box!.height = h;
  };

  // Index of the page being edited, clamped to the document's page count.
  const curPageIndex = () => {
    const n = get().doc.pages.length;
    return n > 0 ? Math.min(get().activePage, n - 1) : 0;
  };

  // Index of the page whose subtree contains a node id, or -1. Used to scroll the
  // viewport into the right page's stacked band when jumping to an arbitrary node.
  const pageIndexOfNode = (doc: DesignFile, id: string): number => {
    const has = (nodes: Node[]): boolean => {
      for (const nd of nodes) {
        if (nd.id === id) return true;
        const kids = (nd as { children?: Node[] }).children;
        if (kids && has(kids)) return true;
      }
      return false;
    };
    for (let i = 0; i < doc.pages.length; i++) if (has(doc.pages[i].children)) return i;
    return -1;
  };

  // The page the user is looking at: the page whose stacked band contains the
  // viewport center (same half-gap rule as the canvas hit-testing). Null when
  // the viewport is not measured yet.
  const centeredPageIndex = (
    doc: DesignFile,
    vp: { zoom: number; panY: number },
    vs: { height: number },
  ): number | null => {
    if (vs.height <= 0 || vp.zoom <= 0 || doc.pages.length === 0) return null;
    // screen = zoom*(world - pan)  =>  world = screen/zoom + pan
    const wy = vp.panY + vs.height / 2 / vp.zoom;
    const offs = pageOffsets(doc);
    for (let i = 0; i < doc.pages.length; i++) {
      if (wy < offs[i] + doc.pages[i].height + pageGap / 2) return i;
    }
    return doc.pages.length - 1;
  };

  // Which page should a panel insert target, and where on it? A new element
  // joins the ACTIVE page, at the CENTER OF ITS ARTBOARD (not the viewport),
  // so it always lands on that page regardless of pan/zoom. Because the
  // active page follows scrolling while nothing is selected, this is normally
  // the page in view; but a page chosen explicitly (or pinned by a live
  // selection) wins over whatever the viewport happens to show. When the
  // active page is NOT the one in view, scroll it into view so the inserted
  // element is actually visible. cx/cy are the target page's own center.
  const insertContext = () => {
    const doc = get().doc;
    const index = curPageIndex();
    const page = doc.pages[index];
    if (page) {
      const vp = get().viewport;
      const vs = get().viewportSize;
      const viewed = centeredPageIndex(doc, vp, vs);
      if (viewed !== null && viewed !== index) {
        get().setViewport({
          panX: page.width / 2 - vs.width / 2 / vp.zoom,
          panY: pageTop(doc, index) + page.height / 2 - vs.height / 2 / vp.zoom,
        });
      }
    }
    return { index, page, cx: (page?.width ?? 0) / 2, cy: (page?.height ?? 0) / 2 };
  };

  // Center a new node on its target page (page-local coordinates), clamped to
  // the artboard. Returns the index of the page the node was positioned for; the
  // caller must insert it THERE (and make that page active) or the coordinates
  // land on a page they do not belong to.
  const positionInView = (n: Node): number => {
    const { index, page, cx, cy } = insertContext();
    const size = (n as unknown as { size?: { width: number; height: number } }).size;
    const t = (n as unknown as { transform: Transform }).transform;
    // Effective on-canvas footprint includes the node's own scale (icon groups
    // are inserted pre-scaled), or the clamp misjudges where the box ends.
    const w = (size?.width ?? 100) * Math.abs(t?.scaleX ?? 1);
    const h = (size?.height ?? 100) * Math.abs(t?.scaleY ?? 1);
    const x = Math.max(0, Math.min(cx - w / 2, Math.max(0, (page?.width ?? 0) - w)));
    const y = Math.max(0, Math.min(cy - h / 2, Math.max(0, (page?.height ?? 0) - h)));
    (n as unknown as { transform: Transform }).transform = { ...t, x, y };
    return index;
  };

  return {
    doc: sampleDesign(),
    selection: [],
    viewport: { zoom: 0.6, panX: -80, panY: -60 },
    rev: 0,
    savedRev: 0,
    markClean: () => set((s) => ({ savedRev: s.rev })),
    manualSaving: false,
    setManualSaving: (v) => set({ manualSaving: v }),
    tool: "select",
    brush: { width: 3, colorHex: "#1a1f29", opacity: 1, mode: "pen" },
    cropping: null,
    maskRefining: null,
    editingTextId: null,
    textEditApply: null,
    presenting: false,
    showRulers: true,
    showGrid: false,
    gridSize: 50,
    snapEnabled: true,
    guides: {},
    snapGuides: null,
    playing: false,
    activePage: 0,
    transforming: false,
    hoverId: null,
    viewportSize: { width: 0, height: 0 },
    undoStack: [],
    redoStack: [],
    collabUndo: null,
    preview: null,

    select: (ids) => {
      const doc = get().doc;
      set({ selection: [...new Set(ids)].filter((id) => !!locate(doc, id)) });
    },
    toggle: (id) =>
      set((s) => ({
        selection: s.selection.includes(id)
          ? s.selection.filter((x) => x !== id)
          : [...s.selection, id],
      })),
    addToSelection: (ids) => {
      const doc = get().doc;
      set((s) => ({
        selection: [...new Set([...s.selection, ...ids])].filter((id) => !!locate(doc, id)),
      }));
    },
    clearSelection: () => set({ selection: [] }),
    selectAll: () => {
      const page = get().doc.pages[curPageIndex()];
      if (!page) return;
      set({ selection: page.children.filter((n) => !n.locked && !n.hidden).map((n) => n.id) });
    },
    selectSameType: () => {
      const page = get().doc.pages[curPageIndex()];
      const sel = get().selection;
      if (!page || !sel.length) return;
      // Match against the type of the first selected node (a type-matched "select all").
      const first = page.children.find((n) => n.id === sel[0]);
      if (!first) return;
      const type = first.type;
      set({ selection: page.children.filter((n) => n.type === type && !n.locked && !n.hidden).map((n) => n.id) });
    },

    loadDoc: (file) =>
      set((s) => ({
        // Normalize meta + page dimensions so surface/kind reads and the page
        // frame are always valid (no NaN-size canvas on a malformed file).
        doc: normalizeLoadedDoc(file),
        selection: [],
        undoStack: [],
        redoStack: [],
        rev: s.rev + 1,
        savedRev: s.rev + 1, // a freshly loaded document starts clean
        activePage: 0,
        viewport: { zoom: 0.6, panX: -80, panY: -60 },
        guides: {}, // manual guides are per-document; drop the previous doc's
        playing: false, // stop any animation preview from the previous doc
        snapGuides: null, // clear transient smart-guide preview
        preview: null, // a fresh document ends any in-progress history preview
      })),

    readonlyPreview: () => get().preview !== null,
    enterPreview: (file, label) => {
      const { preview, doc, selection } = get();
      // Stash the live doc once (re-entering preview keeps the first stash so the
      // user always returns to their real work, never to another preview).
      const live = preview ? preview.live : structuredClone(doc);
      const liveSelection = preview ? preview.liveSelection : selection;
      set((s) => ({
        preview: { label, live, liveSelection },
        doc: normalizeLoadedDoc(file),
        selection: [],
        snapGuides: null,
        playing: false,
        rev: s.rev + 1,
        activePage: 0,
      }));
    },
    exitPreview: () => {
      const { preview } = get();
      if (!preview) return;
      set((s) => ({
        preview: null,
        doc: preview.live,
        selection: preview.liveSelection,
        rev: s.rev + 1,
        activePage: 0,
      }));
    },

    setTransforming: (v) => set((s) => (s.transforming === v ? {} : { transforming: v })),
    setHoverId: (id) => set((s) => (s.hoverId === id ? {} : { hoverId: id })),
    setActivePage: (index) =>
      set((s) => ({
        activePage: Math.max(0, Math.min(index, s.doc.pages.length - 1)),
        selection: [],
        rev: s.rev + 1,
      })),
    goToPage: (index) => {
      get().setActivePage(index);
      const doc = get().doc;
      const i = Math.max(0, Math.min(index, doc.pages.length - 1));
      const page = doc.pages[i];
      if (!page) return;
      const z = get().viewport.zoom || 1;
      const vh = get().viewportSize.height;
      const top = pageTop(doc, i);
      // Page top just below the viewport top when the page overflows the view
      // (reading position, with room for the page header row); centered when it
      // fits. Both keep the viewport center inside this page's band, so the
      // scroll-follow in setViewport agrees with the page just chosen.
      const panY = vh > 0 && page.height * z >= vh ? top - 40 / z : top + page.height / 2 - vh / 2 / z;
      get().setViewport({ panY });
    },
    movePage: (from, to) => {
      const doc = get().doc;
      const n = doc.pages.length;
      if (from < 0 || from >= n) return;
      const dest = Math.max(0, Math.min(to, n - 1));
      if (from === dest) return;
      const pageId = doc.pages[from].id;
      const activeId = doc.pages[curPageIndex()].id;
      const moveById = (id: string, target: number) => {
        const i = doc.pages.findIndex((p) => p.id === id);
        if (i < 0) return;
        const [p] = doc.pages.splice(i, 1);
        doc.pages.splice(target, 0, p);
      };
      const refocus = () => set({ activePage: Math.max(0, doc.pages.findIndex((p) => p.id === activeId)) });
      perform(
        () => { moveById(pageId, dest); refocus(); },
        () => { moveById(pageId, from); refocus(); },
      );
    },
    moveNodesToPage: (ids, destIndex, before) => {
      const doc = get().doc;
      const srcIdx = curPageIndex();
      const src = doc.pages[srcIdx];
      const dst = doc.pages[destIndex];
      if (!src || !dst || destIndex === srcIdx) return;
      // Only top-level nodes on the source page can cross pages this way.
      const moving = ids
        .map((id) => src.children.find((n) => n.id === id))
        .filter((n): n is Node => !!n);
      if (!moving.length) return;
      const movingIds = moving.map((n) => n.id);
      // Convert source-page-local Y to destination-page-local Y (pages are stacked
      // vertically and left-aligned at x=0, so only Y shifts).
      const dy = pageTop(doc, srcIdx) - pageTop(doc, destIndex);
      // Snapshot the reparented nodes (dest-local, at their final dragged spot) and
      // the originals (source-local, at drag-start) so undo restores both cleanly.
      const reparented = moving.map((n) => {
        const c = structuredClone(n) as Node;
        c.transform = { ...c.transform, y: c.transform.y + dy };
        return c;
      });
      const originals = moving.map((n) => {
        const c = structuredClone(n) as Node;
        const b = before.get(n.id);
        if (b) c.transform = structuredClone(b);
        return c;
      });
      const prevSel = get().selection;
      perform(
        () => {
          for (const id of movingIds) { const i = src.children.findIndex((n) => n.id === id); if (i >= 0) src.children.splice(i, 1); }
          dst.children.push(...(structuredClone(reparented) as never[]));
          set({ activePage: destIndex, selection: movingIds });
        },
        () => {
          for (const id of movingIds) { const i = dst.children.findIndex((n) => n.id === id); if (i >= 0) dst.children.splice(i, 1); }
          src.children.push(...(structuredClone(originals) as never[]));
          set({ activePage: srcIdx, selection: prevSel });
        },
      );
    },
    magicResizePages: (targets) => {
      const doc = get().doc;
      const idx = curPageIndex();
      const src = doc.pages[idx];
      if (!src || !targets.length) return [];

      // A single target resizes THIS page in place (keeps its id; the user stays on
      // the page they were editing). Multiple targets fan out into copies below (a
      // social / multi-format set), since one page cannot become many in place.
      if (targets.length === 1) {
        const resized = resizePage(src, targets[0]) as Page;
        resized.id = src.id;
        resized.name = src.name;
        const before = structuredClone(src) as Page;
        const after = structuredClone(resized) as Page;
        const prevSel = get().selection;
        perform(
          () => { doc.pages[idx] = structuredClone(after) as never; set({ activePage: idx, selection: prevSel }); },
          () => { doc.pages[idx] = structuredClone(before) as never; set({ activePage: idx, selection: prevSel }); },
        );
        return [src.id];
      }

      // Build the re-laid-out pages once; clone fresh per (re)do so undo/redo
      // never share a mutated reference, mirroring addPage/duplicatePage.
      const built: Page[] = targets.map((t, i) => {
        const p = resizePage(src, t) as Page;
        p.id = `page-${crypto.randomUUID()}`;
        const base = src.name ?? `Page ${idx + 1}`;
        p.name = `${base} (${Math.round(t.width)}×${Math.round(t.height)})`;
        // Regenerate node ids so the new pages are independent of the source
        // (resizePage preserves source ids by design; here each appended page is
        // its own copy). The first appended page keeps z-order/groups too.
        regenIds(p.children);
        void i;
        return p;
      });
      const fresh = structuredClone(built);
      const at = idx + 1;
      const prevPage = get().activePage;
      const prevSel = get().selection;
      const ids = fresh.map((p) => p.id);
      perform(
        () => {
          doc.pages.splice(at, 0, ...(structuredClone(fresh) as never[]));
          set({ activePage: at, selection: [] });
        },
        () => {
          for (const id of ids) {
            const i = doc.pages.findIndex((p) => p.id === id);
            if (i >= 0) doc.pages.splice(i, 1);
          }
          set({ activePage: Math.min(prevPage, doc.pages.length - 1), selection: prevSel });
        },
      );
      return ids;
    },
    buildMagicDesign: (spec, target) => {
      const doc = get().doc;
      const idx = curPageIndex();
      const page = doc.pages[idx];
      if (!page) return [];
      const w = Math.max(1, Math.round(target.width));
      const h = Math.max(1, Math.round(target.height));

      // Resolve the background fill from the spec (solid or simple gradient).
      const bgColor = fromHex(spec.background.color ?? "#ffffff") ?? { srgb: { r: 1, g: 1, b: 1, a: 1 } };
      let background: Fill;
      if (spec.background.kind === "gradient" && spec.background.color2) {
        const c2 = fromHex(spec.background.color2) ?? bgColor;
        background = {
          type: "gradient",
          gradient: "linear",
          angle: spec.background.angle ?? 90,
          stops: [
            { position: 0, color: bgColor },
            { position: 1, color: c2 },
          ],
        } as Fill;
      } else {
        background = { type: "solid", color: bgColor };
      }

      // Default text color readable against the background (WCAG-aware), unless
      // the element specifies its own color.
      const onBg = fixToAA(contrastRatio(WHITE_COLOR, bgColor) >= contrastRatio(NEAR_BLACK_COLOR, bgColor) ? WHITE_COLOR : NEAR_BLACK_COLOR, bgColor);

      // Per-kind defaults: font size is a fraction of the page's shorter side
      // when the spec gives none, plus a weight so headings read as headings.
      const baseUnit = Math.min(w, h);
      const KIND_DEFAULTS: Record<string, { size: number; wght: number }> = {
        heading: { size: baseUnit * 0.11, wght: 800 },
        subheading: { size: baseUnit * 0.055, wght: 600 },
        body: { size: baseUnit * 0.03, wght: 400 },
        accent: { size: baseUnit * 0.04, wght: 400 },
      };

      const nodes: Node[] = [];
      for (const el of spec.elements) {
        const x = el.x * w;
        const y = el.y * h;
        const bw = Math.max(1, el.w * w);
        const bh = Math.max(1, el.h * h);
        if (el.kind === "accent") {
          const fill: Fill = { type: "solid", color: fromHex(el.color ?? "") ?? bgColor };
          nodes.push(createNode("shape", {
            name: tr("app.accent"),
            shape: "rect",
            transform: { x, y, scaleX: 1, scaleY: 1, rotation: 0 },
            size: { width: bw, height: bh },
            fills: [fill],
          } as Partial<Node>));
          continue;
        }
        const def = KIND_DEFAULTS[el.kind] ?? KIND_DEFAULTS.body;
        const fontSize = Math.max(8, Math.round(el.fontSize ?? def.size));
        const fillColor = fromHex(el.color ?? "") ?? onBg;
        nodes.push(createNode("text", {
          name: el.text?.slice(0, 24) || el.kind,
          transform: { x, y, scaleX: 1, scaleY: 1, rotation: 0 },
          size: { width: bw, height: bh },
          box: { mode: "fixed", width: bw, height: bh, autoFit: { enabled: true, min: 8, max: Math.max(8, Math.round(fontSize * 1.5)) }, verticalAlign: "top" },
          content: [{
            runs: [{ text: el.text ?? "", style: { fontFamily: "system", fontStyle: "Regular", fontSize, axes: { wght: def.wght }, fill: { type: "solid", color: fillColor } } }],
            style: { align: "left", direction: "auto" },
          }],
        } as Partial<Node>));
      }

      // Snapshot the whole page once so the size + background + every node land
      // as ONE undo step (mirrors applyBrandFixes' batch pattern).
      const before = structuredClone({ width: page.width, height: page.height, background: (page as unknown as { background?: Fill }).background, children: page.children });
      const after = structuredClone({ width: w, height: h, background, children: nodes });
      const apply = (snap: { width: number; height: number; background?: Fill; children: Node[] }) => {
        const p = get().doc.pages[curPageIndex()] as unknown as { width: number; height: number; background?: Fill; children: Node[] };
        if (!p) return;
        p.width = snap.width;
        p.height = snap.height;
        p.background = snap.background;
        p.children = structuredClone(snap.children);
      };
      const ids = nodes.map((n) => n.id);
      perform(
        () => { apply(structuredClone(after)); set({ selection: [] }); },
        () => { apply(before); set({ selection: get().selection.filter((s) => !ids.includes(s)) }); },
      );
      return ids;
    },
    buildAiDesign: (spec, target) => {
      const doc = get().doc;
      const idx = curPageIndex();
      const page = doc.pages[idx];
      if (!page) return [];
      const w = Math.max(1, Math.round(target.width));
      const h = Math.max(1, Math.round(target.height));

      // The @hc/aistudio engine owns geometry, type scale, alignment, z-order and
      // WCAG-readable color; we just persist its result onto the active page.
      const { background, nodes } = layoutDesign(spec, { width: w, height: h });

      // Snapshot the whole page once so size + background + every node land as ONE
      // undo step (mirrors buildMagicDesign / applyBrandFixes' batch pattern).
      const before = structuredClone({ width: page.width, height: page.height, background: (page as unknown as { background?: Fill }).background, children: page.children });
      const after = structuredClone({ width: w, height: h, background, children: nodes });
      const apply = (snap: { width: number; height: number; background?: Fill; children: Node[] }) => {
        const p = get().doc.pages[curPageIndex()] as unknown as { width: number; height: number; background?: Fill; children: Node[] };
        if (!p) return;
        p.width = snap.width;
        p.height = snap.height;
        p.background = snap.background;
        p.children = structuredClone(snap.children);
      };
      const ids = nodes.map((n) => n.id);
      perform(
        () => { apply(structuredClone(after)); set({ selection: [] }); },
        () => { apply(before); set({ selection: get().selection.filter((s) => !ids.includes(s)) }); },
      );
      return ids;
    },
    buildSvgDesign: (svg, target) => {
      const doc = get().doc;
      const idx = curPageIndex();
      const page = doc.pages[idx];
      if (!page) return [];
      const w = Math.max(1, Math.round(target.width));
      const h = Math.max(1, Math.round(target.height));

      // The SVG is generated at exactly w x h, so its flattened nodes are already
      // in page coordinates (no group wrapper, no scaling): every element stays
      // individually selectable and editable. A full-bleed background <rect> in
      // the SVG becomes the bottom node, so the page background is left as-is.
      const { nodes, assets } = flattenSvgToNodes(svg);
      if (!nodes.length) return [];
      ensureDocArrays(doc);
      const refs: AssetRef[] = assets.map((a) => ({ id: a.assetId, kind: "image", url: a.url, mime: "image/*", checksum: "" }));

      // Snapshot page size + nodes so the whole design lands as ONE undo step
      // (mirrors buildAiDesign). Assets are added/removed in the same step.
      const before = structuredClone({ width: page.width, height: page.height, children: page.children });
      const after = structuredClone({ width: w, height: h, children: nodes });
      const apply = (snap: { width: number; height: number; children: Node[] }) => {
        const p = get().doc.pages[curPageIndex()] as unknown as { width: number; height: number; children: Node[] };
        if (!p) return;
        p.width = snap.width;
        p.height = snap.height;
        p.children = structuredClone(snap.children);
      };
      const ids = nodes.map((n) => n.id);
      perform(
        () => { get().doc.assets.push(...refs); apply(structuredClone(after)); set({ selection: [] }); },
        () => {
          apply(before);
          const live = get().doc.assets;
          for (const r of refs) { const ai = live.findIndex((a) => a.id === r.id); if (ai >= 0) live.splice(ai, 1); }
          set({ selection: get().selection.filter((s) => !ids.includes(s)) });
        },
      );
      // Load any referenced image assets so they render (data URLs or remote urls).
      if (typeof window !== "undefined") for (const a of assets) imageAssets.register(a.assetId, a.url);
      return ids;
    },
    buildDeckFromOutline: (deck, target) => {
      const doc = get().doc;
      if (!deck.pages.length) return [];
      const w = Math.max(1, Math.round(target.width));
      const h = Math.max(1, Math.round(target.height));

      // Build fully-formed pages from the engine output. Page ids are stable so
      // undo/redo can re-key selection cleanly.
      const newPages = deck.pages.map((p, i) => ({
        id: `page-${crypto.randomUUID()}`,
        name: p.name || `Page ${i + 1}`,
        width: w,
        height: h,
        background: p.background,
        children: structuredClone(p.nodes),
        ...(p.note ? { notes: p.note } : {}), // speaker notes from the outline
      }));
      const pageIds = newPages.map((p) => p.id);
      const before = structuredClone(doc.pages);
      const after = structuredClone(newPages);
      const prevActive = get().activePage;
      const prevSel = get().selection;
      const replaceAll = (pages: unknown[], activePage: number, selection: string[]) => {
        const live = get().doc.pages as unknown as unknown[];
        live.splice(0, live.length, ...(structuredClone(pages) as unknown[]));
        set({ activePage: Math.max(0, Math.min(activePage, live.length - 1)), selection });
      };
      perform(
        () => replaceAll(after, 0, []),
        () => replaceAll(before, prevActive, prevSel), // restore the user's prior view on undo
      );
      return pageIds;
    },
    appendDeckPages: (deck, target) => {
      const doc = get().doc;
      if (!deck.pages.length) return [];
      const w = Math.max(1, Math.round(target.width));
      const h = Math.max(1, Math.round(target.height));
      const base = doc.pages.length;
      const newPages = deck.pages.map((p, i) => ({
        id: `page-${crypto.randomUUID()}`,
        name: p.name || `Page ${base + i + 1}`,
        width: w,
        height: h,
        background: p.background,
        children: structuredClone(p.nodes),
        ...(p.note ? { notes: p.note } : {}), // speaker notes from the outline
      }));
      const pageIds = newPages.map((p) => p.id);
      const snapshot = structuredClone(newPages);
      const prevSel = get().selection;
      const prevActive = get().activePage;
      perform(
        () => {
          (get().doc.pages as unknown as unknown[]).push(...(structuredClone(snapshot) as unknown[]));
          set({ activePage: get().doc.pages.length - newPages.length, selection: [] });
        },
        () => {
          const live = get().doc.pages;
          for (const id of pageIds) {
            const i = live.findIndex((p) => p.id === id);
            if (i >= 0) live.splice(i, 1);
          }
          set({ activePage: Math.min(prevActive, get().doc.pages.length - 1), selection: prevSel });
        },
      );
      return pageIds;
    },
    runAsTurn: (fn) => {
      const start = get().undoStack.length;
      fn();
      const stack = get().undoStack;
      const added = stack.slice(start);
      if (added.length <= 1) return added.length;
      // Collapse: redo replays each entry forward; undo reverses them.
      const composite: UndoEntry = {
        redo: () => added.forEach((e) => e.redo()),
        undo: () => [...added].reverse().forEach((e) => e.undo()),
      };
      set({ undoStack: [...stack.slice(0, start), composite] });
      return added.length;
    },
    recordProvenance: (entry) => {
      const doc = get().doc as unknown as { meta?: Record<string, unknown> };
      if (!doc.meta) doc.meta = {};
      const list = Array.isArray(doc.meta.aiProvenance) ? (doc.meta.aiProvenance as unknown[]) : [];
      list.push({ ...entry, createdAt: new Date().toISOString() });
      doc.meta.aiProvenance = list.slice(-50); // keep the recent history bounded
      // Bump rev so the dirty/autosave path flushes this meta write (FR-27); the
      // entry itself is metadata, not an undoable document edit.
      get().tick();
    },
    setPageSize: (width, height) => {
      const page = get().doc.pages[curPageIndex()];
      if (!page) return;
      const before = { width: page.width, height: page.height };
      const w = Math.max(1, Math.round(width));
      const h = Math.max(1, Math.round(height));
      if (before.width === w && before.height === h) return;
      // Background images are PAGE-SIZED cover boxes; they follow the page so
      // a manual W/H change never leaves the background at the old bounds.
      // Only the flagged, still-locked ones move - this raw path deliberately
      // repositions no other content (the design-resize flow maps everything).
      const bgs = page.children
        .filter((n) => n.type === "image" && n.locked && (n.data as { background?: unknown } | undefined)?.background === true)
        .map((n) => ({ n, transform: { ...n.transform }, size: { ...n.size } }));
      perform(
        () => {
          page.width = w;
          page.height = h;
          for (const b of bgs) {
            b.n.transform = { ...b.n.transform, x: b.n.transform.scaleX < 0 ? w : 0, y: b.n.transform.scaleY < 0 ? h : 0 };
            b.n.size = { width: w, height: h };
          }
        },
        () => {
          page.width = before.width;
          page.height = before.height;
          for (const b of bgs) {
            b.n.transform = { ...b.transform };
            b.n.size = { ...b.size };
          }
        },
      );
    },
    savePageAsLayout: (name) => {
      const doc = get().doc as unknown as {
        masters?: { id: string; name?: string; placeholders: unknown[] }[];
        layouts?: { id: string; masterId: string; name: string; background?: Fill; placeholders: unknown[] }[];
        pages: Page[];
      };
      const page = doc.pages[curPageIndex()] as unknown as { background?: Fill; children: Node[]; layoutId?: string };
      const title = name.trim();
      if (!page || !title) return null;
      // Placeholders: every top-level text box becomes a positioned slot. The
      // largest font is the title, the rest body (a useful default; the layout
      // stays editable by re-capturing).
      const texts = (page.children as Node[]).filter((n) => n.type === "text" && !n.hidden);
      const fontOf = (n: Node) => {
        const paras = (n as unknown as { content?: { runs?: { style?: { fontSize?: number } }[] }[] }).content ?? [];
        return Math.max(0, ...paras.flatMap((pp) => (pp.runs ?? []).map((r) => r.style?.fontSize ?? 0)));
      };
      const titleNode = texts.length ? texts.reduce((a, b) => (fontOf(b) > fontOf(a) ? b : a)) : null;
      const placeholders = texts.map((n, i) => ({
        id: `ph-${i + 1}`,
        role: n === titleNode ? "title" : "body",
        rect: { x: n.transform.x, y: n.transform.y, width: Math.abs(n.size.width * n.transform.scaleX), height: Math.abs(n.size.height * n.transform.scaleY) },
      }));
      const layoutId = `layout-${crypto.randomUUID().slice(0, 8)}`;
      const layout = {
        id: layoutId,
        masterId: (doc.masters ?? [])[0]?.id ?? "master-default",
        name: title,
        ...(page.background ? { background: structuredClone(page.background) } : {}),
        placeholders,
      };
      const prevMasters = doc.masters;
      const prevLayouts = doc.layouts;
      const prevPageLayout = page.layoutId;
      perform(
        () => {
          // Re-check the DOC on every run (redo included): reading a closure
          // variable here would skip re-adding the default master on redo and
          // leave the layout pointing at a master that no longer exists.
          if (!(doc.masters ?? []).some((m) => m.id === layout.masterId)) {
            doc.masters = [...(doc.masters ?? []), { id: layout.masterId, name: tr("app.default_master"), placeholders: [] }];
          }
          doc.layouts = [...(doc.layouts ?? []), layout];
          page.layoutId = layoutId; // the source page uses its own layout
        },
        () => {
          doc.masters = prevMasters;
          doc.layouts = prevLayouts;
          page.layoutId = prevPageLayout;
        },
      );
      return layoutId;
    },

    extractLayoutsFromDeck: (precomputed) => {
      // Never mutate a version-history preview: the undo entry would capture
      // the HISTORICAL doc's layouts/masters and a later undo on the live doc
      // would overwrite current state with them.
      if (get().preview) return null;
      const doc = get().doc as unknown as {
        masters?: { id: string; name?: string; placeholders: unknown[] }[];
        layouts?: { id: string; masterId: string; name: string; background?: Fill; placeholders: unknown[] }[];
        pages: Page[];
      };
      // Named to avoid shadowing zustand's `set` parameter.
      const extracted = precomputed ?? extractLayoutSet(doc.pages as unknown as ExtractPageLike[]);
      if (!extracted.layouts.length) return null;
      const masterId = (doc.masters ?? [])[0]?.id ?? "master-default";
      const run = crypto.randomUUID().slice(0, 6);
      const records = extracted.layouts.map((l, i) => {
        // T20 stage 3: capacities are verified against the size the layout was
        // EXTRACTED at (stamped on the layout, so a document mutated since
        // extraction cannot mislead the math) - a hint that overflows at max
        // fill shrinks to what fits (or is dropped), whether the set came from
        // the heuristics here or from the vision-corrected path.
        const verified = verifyLayoutCapacities(l, l.sourcePageSize);
        return {
          id: `layout-ext-${run}-${i + 1}`,
          masterId,
          name: verified.name,
          ...(verified.background ? { background: structuredClone(verified.background) } : {}),
          placeholders: structuredClone(verified.placeholders) as unknown[],
        };
      });
      const prevMasters = doc.masters;
      const prevLayouts = doc.layouts;
      // Only pages that are not already linked adopt their extracted layout,
      // so re-running extraction never severs an existing cascade.
      const prevAssign = doc.pages.map((p) => (p as unknown as { layoutId?: string }).layoutId);
      let linked = 0;
      for (let i = 0; i < extracted.assignments.length; i++) {
        if (extracted.assignments[i] !== null && !prevAssign[i]) linked++;
      }
      perform(
        () => {
          // Re-check the DOC on every run (redo included), like savePageAsLayout:
          // the default master may need re-adding after other undo traffic.
          const live = get().doc as unknown as typeof doc;
          if (!(live.masters ?? []).some((m) => m.id === masterId)) {
            live.masters = [...(live.masters ?? []), { id: masterId, name: tr("app.default_master"), placeholders: [] }];
          }
          live.layouts = [...(live.layouts ?? []), ...structuredClone(records)];
          extracted.assignments.forEach((a, i) => {
            const pg = live.pages[i] as unknown as { layoutId?: string } | undefined;
            if (a !== null && !prevAssign[i] && pg) pg.layoutId = records[a].id;
          });
        },
        () => {
          const live = get().doc as unknown as typeof doc;
          live.masters = prevMasters;
          live.layouts = prevLayouts;
          live.pages.forEach((p, i) => {
            const pg = p as unknown as { layoutId?: string };
            // Restore exactly: a page that never had a link must not keep an
            // explicit undefined-valued key.
            if (prevAssign[i] === undefined) delete pg.layoutId;
            else pg.layoutId = prevAssign[i];
          });
        },
      );
      return { created: records.length, linked };
    },

    fillPlaceholderContent: (pageIndex, fill, opts) => {
      const doc = get().doc;
      const page = doc.pages[pageIndex] as unknown as { id: string; children: Node[] };
      if (!page) return false;
      const pageId = page.id;
      type Paragraph = { runs: { text: string; style: Record<string, unknown> }[]; style: Record<string, unknown> };
      type Textish = { id: string; type: string; data?: { placeholderId?: string }; content?: Paragraph[] };
      const targets: { nodeId: string; before: Paragraph[]; after: Paragraph[] }[] = [];
      for (const child of page.children as unknown as Textish[]) {
        const phId = child.data?.placeholderId;
        if (!phId || child.type !== "text" || !child.content?.length) continue;
        const text = fill.texts[phId];
        const list = fill.lists[phId];
        const override = opts?.styles?.[phId];
        if (text === undefined && list === undefined) {
          // Style-only pass: a slot the fill leaves alone still needs the
          // override (readable ink on a dark background, brand font) applied
          // to its EXISTING content, or its placeholder text stays unreadable.
          if (!override) continue;
          const restyled = structuredClone(child.content).map((par) => ({
            ...par,
            runs: par.runs.map((r) => ({
              ...r,
              style: {
                ...r.style,
                ...(override.fontFamily ? { fontFamily: override.fontFamily } : {}),
                ...(override.fill ? { fill: structuredClone(override.fill) } : {}),
              },
            })),
          }));
          targets.push({ nodeId: child.id, before: structuredClone(child.content), after: restyled });
          continue;
        }
        // Reuse the materialized box's own run/paragraph style so the fill
        // inherits the layout's typography, then apply any explicit override
        // (brand fonts, a readable ink for the theme background).
        const proto = child.content[0];
        const runStyle: Record<string, unknown> = {
          ...(proto.runs[0]?.style ?? {}),
          ...(override?.fontFamily ? { fontFamily: override.fontFamily } : {}),
          ...(override?.fill ? { fill: structuredClone(override.fill) } : {}),
        };
        const paraStyle = proto.style ?? {};
        const paragraphs: Paragraph[] = list !== undefined
          ? list.map((item) => ({ runs: [{ text: `\u2022  ${item}`, style: structuredClone(runStyle) }], style: structuredClone(paraStyle) }))
          : [{ runs: [{ text: text!, style: structuredClone(runStyle) }], style: structuredClone(paraStyle) }];
        targets.push({ nodeId: child.id, before: structuredClone(child.content), after: paragraphs });
      }
      if (!targets.length) return false;
      // Resolve page and nodes BY ID inside the closures: when this op shares a
      // one-undo turn with a page-replacing op, redo re-clones the pages, so a
      // captured object reference would mutate a detached copy and the redo
      // would silently drop the generated content.
      const applyContent = (which: "before" | "after") => {
        const live = get().doc.pages.find((pg) => pg.id === pageId) as unknown as { children: Textish[] } | undefined;
        if (!live) return;
        for (const t of targets) {
          const node = live.children.find((n) => n.id === t.nodeId);
          if (node) {
            node.content = structuredClone(which === "after" ? t.after : t.before);
            // Every content-mutation path clamps a fixed box to its content
            // (the render never clips text); the fill honors the same rule.
            refitTextHeight(node as unknown as Node);
          }
        }
        get().tick();
      };
      perform(
        () => applyContent("after"),
        () => applyContent("before"),
      );
      return true;
    },
    applyGeneratedImageToPlaceholder: (pageId, placeholderId, url, prompt) => {
      const doc = get().doc;
      ensureDocArrays(doc);
      const page = doc.pages.find((p) => p.id === pageId);
      if (!page) return false; // design changed: a late resolution never lands elsewhere
      type Tagged = { id: string; type: string; data?: { placeholderId?: string }; transform?: { x: number; y: number }; size?: { width: number; height: number } };
      const slot = (page.children as unknown as Tagged[]).find((n) => n.data?.placeholderId === placeholderId);
      if (!slot) return false; // slot gone (user deleted it): nothing to fill
      const rect = {
        x: slot.transform?.x ?? 0,
        y: slot.transform?.y ?? 0,
        width: slot.size?.width ?? page.width,
        height: slot.size?.height ?? page.height,
      };
      const assetId = `asset-${crypto.randomUUID()}`;
      const node = createNode("image", {
        name: tr("app.image"),
        source: { assetId, naturalWidth: 0, naturalHeight: 0 },
        fit: "cover",
        transform: { x: rect.x, y: rect.y, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: rect.width, height: rect.height },
      } as Partial<Node>);
      node.data = { placeholderId, aiImagePrompt: prompt };
      const ref: AssetRef = { id: assetId, kind: "image", url, mime: "image/*", checksum: "" };
      const replacedId = slot.id;
      const replacedSnapshot = structuredClone(slot);
      perform(
        () => {
          const live = get().doc.pages.find((p) => p.id === pageId);
          if (!live) return;
          const i = live.children.findIndex((n) => n.id === replacedId);
          get().doc.assets.push(ref);
          if (i >= 0) live.children.splice(i, 1, node as never);
          else live.children.push(node as never);
        },
        () => {
          const live = get().doc.pages.find((p) => p.id === pageId);
          if (live) {
            const i = live.children.findIndex((n) => n.id === node.id);
            if (i >= 0) live.children.splice(i, 1, structuredClone(replacedSnapshot) as never);
          }
          const assets = get().doc.assets;
          const ai = assets.findIndex((a) => a.id === assetId);
          if (ai >= 0) assets.splice(ai, 1);
        },
      );
      // Patch the real natural dimensions once loaded (same idiom as the
      // background variants).
      if (typeof window !== "undefined") {
        imageAssets.register(assetId, url);
        const off = imageAssets.onChange((changed) => {
          if (changed !== assetId) return;
          if (imageAssets.status(assetId) === "ready") {
            const img = imageAssets.image(assetId) as { naturalWidth?: number; naturalHeight?: number } | null;
            const loc = locate(get().doc, node.id);
            const n = loc?.node.type === "image" ? (loc.node as unknown as { source: { naturalWidth: number; naturalHeight: number } }) : undefined;
            if (img?.naturalWidth && n) {
              n.source.naturalWidth = img.naturalWidth;
              n.source.naturalHeight = img.naturalHeight ?? rect.height;
              get().tick();
            }
          }
          off();
        });
      }
      return true;
    },
    applyLayoutToPage: (layoutId, pageIndex, opts) => {
      const doc = get().doc as unknown as {
        masters?: { id: string; background?: Fill }[];
        layouts?: { id: string; masterId: string; background?: Fill; placeholders: { id: string; role: string; rect: { x: number; y: number; width: number; height: number } }[] }[];
        pages: Page[];
      };
      const idx = pageIndex ?? curPageIndex();
      const page = doc.pages[idx] as unknown as { id: string; background?: Fill; children: Node[]; layoutId?: string };
      if (!page) return false;
      // Resolve the page BY ID inside every closure: when this op shares a
      // one-undo turn with a page-replacing op, redo re-clones the pages, so a
      // captured object reference would mutate a detached copy (the redo would
      // silently drop the link and the materialized boxes).
      const pageId = page.id;
      const livePage = () => get().doc.pages.find((pg) => pg.id === pageId) as unknown as typeof page | undefined;
      const prevLayoutId = page.layoutId;
      if (layoutId === null) {
        // Unlink only: the materialized content stays (nothing is destroyed).
        perform(
          () => { const lp = livePage(); if (lp) delete lp.layoutId; },
          () => { const lp = livePage(); if (lp && prevLayoutId) lp.layoutId = prevLayoutId; },
        );
        return true;
      }
      const layout = (doc.layouts ?? []).find((l) => l.id === layoutId);
      if (!layout) return false;
      const master = (doc.masters ?? []).find((m) => m.id === layout.masterId);
      const bg = layout.background ?? master?.background;
      const prevBg = page.background;
      // Placeholders materialize as editable text boxes, matched by the tag so
      // re-applying never duplicates one that already exists on the page.
      const have = new Set(
        (page.children as Node[])
          .map((n) => (n.data as { placeholderId?: string } | undefined)?.placeholderId)
          .filter((v): v is string => !!v),
      );
      // Layout rects are absolute, authored for some page size; on a page of a
      // DIFFERENT size (mixed-size documents) materializing them verbatim
      // overflows, so scale the rects down proportionally when the layout's
      // extent exceeds this page. A same-size page scales by exactly 1.
      const pageDims = doc.pages[idx] as unknown as { width: number; height: number };
      let extentW = 0;
      let extentH = 0;
      for (const ph of layout.placeholders ?? []) {
        extentW = Math.max(extentW, ph.rect.x + ph.rect.width);
        extentH = Math.max(extentH, ph.rect.y + ph.rect.height);
      }
      const scaleX = extentW > pageDims.width && extentW > 0 ? pageDims.width / extentW : 1;
      const scaleY = extentH > pageDims.height && extentH > 0 ? pageDims.height / extentH : 1;
      const made: Node[] = [];
      for (const ph of layout.placeholders ?? []) {
        if (have.has(ph.id)) continue;
        const r = { x: ph.rect.x * scaleX, y: ph.rect.y * scaleY, width: ph.rect.width * scaleX, height: ph.rect.height * scaleY };
        made.push(createNode("text", {
          name: ph.role === "title" ? tr("app.title") : tr("app.text"),
          transform: { x: r.x, y: r.y, scaleX: 1, scaleY: 1, rotation: 0 },
          size: { width: r.width, height: r.height },
          box: { mode: "fixed", width: r.width, height: r.height, autoFit: { enabled: false, min: 8, max: 512 }, verticalAlign: "top" },
          data: { placeholderId: ph.id },
          content: [{
            runs: [{ text: ph.role === "title" ? tr("app.title") : tr("app.text"), style: { fontFamily: "system", fontStyle: ph.role === "title" ? boldFontStyle : regularFontStyle, fontSize: ph.role === "title" ? 44 : 20, fill: { type: "solid", color: { srgb: { r: 0.12, g: 0.14, b: 0.18, a: 1 } } } } }],
            style: { align: "left", direction: "auto" },
          }],
        } as Partial<Node>));
      }
      // Prune (T14 relayout): placeholder-tagged nodes whose slot is absent
      // from the NEW layout are removed, so a layout switch does not leave the
      // old layout's boxes overlapping the new ones. Untagged nodes are never
      // touched. Snapshots + indexes captured now for a faithful undo.
      const slotIds = new Set((layout.placeholders ?? []).map((ph) => ph.id));
      const pruned: { snapshot: Node; index: number }[] = [];
      if (opts?.pruneObsolete) {
        (page.children as Node[]).forEach((n, i) => {
          const phId = (n.data as { placeholderId?: string } | undefined)?.placeholderId;
          if (phId && !slotIds.has(phId)) pruned.push({ snapshot: structuredClone(n), index: i });
        });
      }
      const prunedIds = new Set(pruned.map((x) => x.snapshot.id));
      perform(
        () => {
          const lp = livePage();
          if (!lp) return;
          lp.layoutId = layoutId;
          if (bg) lp.background = structuredClone(bg);
          if (prunedIds.size) {
            for (let i = lp.children.length - 1; i >= 0; i--) {
              if (prunedIds.has((lp.children[i] as Node).id)) lp.children.splice(i, 1);
            }
          }
          lp.children.push(...(structuredClone(made) as never[]));
        },
        () => {
          const lp = livePage();
          if (!lp) return;
          if (prevLayoutId) lp.layoutId = prevLayoutId; else delete lp.layoutId;
          lp.background = prevBg;
          for (const n of made) {
            const i = lp.children.findIndex((c) => c.id === n.id);
            if (i >= 0) lp.children.splice(i, 1);
          }
          for (const x of pruned) {
            lp.children.splice(Math.min(x.index, lp.children.length), 0, structuredClone(x.snapshot) as never);
          }
        },
      );
      return true;
    },

    updateLayoutFromPage: (layoutId) => {
      const doc = get().doc as unknown as {
        layouts?: { id: string; background?: Fill; placeholders: unknown[] }[];
        pages: Page[];
      };
      const layout = (doc.layouts ?? []).find((l) => l.id === layoutId);
      const page = doc.pages[curPageIndex()] as unknown as { background?: Fill; children: Node[] };
      if (!layout || !page) return false;
      const texts = (page.children as Node[]).filter((n) => n.type === "text" && !n.hidden);
      const nextPh = texts.map((n, i) => ({
        id: (n.data as { placeholderId?: string } | undefined)?.placeholderId ?? `ph-${i + 1}`,
        role: i === 0 ? "title" : "body",
        rect: { x: n.transform.x, y: n.transform.y, width: Math.abs(n.size.width * n.transform.scaleX), height: Math.abs(n.size.height * n.transform.scaleY) },
      }));
      const prevBg = layout.background;
      const prevPh = layout.placeholders;
      const nextBg = page.background ? structuredClone(page.background) : undefined;
      perform(
        () => {
          if (nextBg) layout.background = nextBg; else delete layout.background;
          layout.placeholders = nextPh;
        },
        () => {
          if (prevBg) layout.background = prevBg; else delete layout.background;
          layout.placeholders = prevPh;
        },
      );
      return true;
    },

    syncLayoutPages: (layoutId) => {
      const doc = get().doc as unknown as { pages: (Page & { layoutId?: string })[] };
      const targets = doc.pages
        .map((pg, i) => ({ pg, i }))
        .filter(({ pg }) => pg.layoutId === layoutId);
      let changed = 0;
      // One gesture, one undo step. Each applyLayoutToPage is its own perform,
      // so without the fold "Update + sync" would need N undos to walk back a
      // single click (collab mode only hid this because the Yjs capture window
      // merged them).
      get().runAsTurn(() => {
        for (const { i } of targets) {
          if (get().applyLayoutToPage(layoutId, i)) changed++;
        }
      });
      return changed;
    },

    bulkMergePages: (rows) => {
      const doc = get().doc;
      ensureDocArrays(doc);
      const idx = curPageIndex();
      const template = doc.pages[idx];
      if (!template || !rows.length) return 0;
      const capped = rows.slice(0, 100); // one deck stays navigable
      const idGen = () => `n_${crypto.randomUUID().slice(0, 12)}`;
      const madePages: Page[] = [];
      for (const row of capped) {
        const clone = structuredClone(template) as Page & { name?: string };
        clone.id = `page_${crypto.randomUUID().slice(0, 12)}`;
        const remapped = remapIds(structuredClone(template.children ?? []) as Node[], idGen);
        clone.children = remapped.nodes as never[];
        const sub = (text: string) => text.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (m, key: string) => (Object.hasOwn(row, key) ? row[key] : m));
        const walk = (nodes: Node[]) => {
          for (const n of nodes) {
            if (n.type === "text") {
              const paras = (n as unknown as { content?: { runs?: { text?: string }[] }[] }).content ?? [];
              for (const pp of paras) for (const r of pp.runs ?? []) if (typeof r.text === "string") r.text = sub(r.text);
            } else if (n.type === "sticky") {
              const rec = n as unknown as { text?: string };
              if (typeof rec.text === "string") rec.text = sub(rec.text);
            }
            const kids = (n as unknown as { children?: Node[] }).children;
            if (kids?.length) walk(kids);
          }
        };
        walk(clone.children as Node[]);
        madePages.push(clone);
      }
      const at = idx + 1;
      const prevActive = get().activePage;
      perform(
        () => {
          doc.pages.splice(at, 0, ...madePages);
          set({ activePage: at });
        },
        () => {
          doc.pages.splice(at, madePages.length);
          set({ activePage: prevActive });
        },
      );
      return madePages.length;
    },

    setPageBackground: (fill) => {
      const page = get().doc.pages[curPageIndex()] as unknown as { background?: Fill };
      if (!page) return;
      const before = page.background;
      perform(
        () => { page.background = fill; },
        () => { page.background = before; },
      );
    },
    addSection: (pageIndex, name) => {
      const doc = get().doc as unknown as { sections?: SlideSection[]; pages: { sectionId?: string }[] };
      const pages = doc.pages;
      if (!pages[pageIndex]) return;
      const id = `sec-${Math.random().toString(36).slice(2, 10)}`;
      const section: SlideSection = { id, name: name?.trim() || `Section ${(doc.sections?.length ?? 0) + 1}` };
      // The new section owns this slide and every following one up to the next
      // sectioned slide, which is what "start a section here" means in a deck.
      const adopt: number[] = [];
      const startedIn = pages[pageIndex].sectionId;
      for (let i = pageIndex; i < pages.length; i++) {
        if (i > pageIndex && pages[i].sectionId !== startedIn) break;
        adopt.push(i);
      }
      const before = adopt.map((i) => pages[i].sectionId);
      const beforeSections = doc.sections;
      perform(
        () => {
          doc.sections = [...(beforeSections ?? []), section];
          adopt.forEach((i) => { pages[i].sectionId = id; });
        },
        () => {
          doc.sections = beforeSections;
          adopt.forEach((i, k) => { pages[i].sectionId = before[k]; });
        },
      );
    },
    renameSection: (sectionId, name) => {
      const doc = get().doc as unknown as { sections?: SlideSection[] };
      const sec = doc.sections?.find((x) => x.id === sectionId);
      const next = name.trim();
      if (!sec || !next || sec.name === next) return;
      const before = sec.name;
      perform(
        () => { sec.name = next; },
        () => { sec.name = before; },
      );
    },
    removeSection: (sectionId) => {
      const doc = get().doc as unknown as { sections?: SlideSection[]; pages: { sectionId?: string }[] };
      if (!doc.sections?.some((x) => x.id === sectionId)) return;
      const beforeSections = doc.sections;
      const members = doc.pages.map((p, i) => (p.sectionId === sectionId ? i : -1)).filter((i) => i >= 0);
      perform(
        () => {
          // Removing a section never removes slides; they become unsectioned.
          doc.sections = beforeSections.filter((x) => x.id !== sectionId);
          members.forEach((i) => { doc.pages[i].sectionId = undefined; });
        },
        () => {
          doc.sections = beforeSections;
          members.forEach((i) => { doc.pages[i].sectionId = sectionId; });
        },
      );
    },
    toggleSectionCollapsed: (sectionId) => {
      const doc = get().doc as unknown as { sections?: SlideSection[] };
      const sec = doc.sections?.find((x) => x.id === sectionId);
      if (!sec) return;
      const before = sec.collapsed;
      perform(
        () => { sec.collapsed = !before || undefined; },
        () => { sec.collapsed = before; },
      );
    },
    setPageSection: (pageIndex, sectionId) => {
      const page = get().doc.pages[pageIndex] as unknown as { sectionId?: string };
      if (!page) return;
      const before = page.sectionId;
      if (before === sectionId) return;
      perform(
        () => { page.sectionId = sectionId; },
        () => { page.sectionId = before; },
      );
    },
    addPage: (size) => {
      const doc = get().doc;
      const cur = doc.pages[curPageIndex()];
      const w = size && size.width > 0 ? Math.round(size.width) : cur.width;
      const h = size && size.height > 0 ? Math.round(size.height) : cur.height;
      const tmpl = createBlankDesign({ width: w, height: h });
      const seed = tmpl.pages[0];
      seed.name = `Page ${doc.pages.length + 1}`;
      seed.background = structuredClone(cur.background) as never;
      // Insert a fresh clone each (re)do so undo/redo never share a mutated ref.
      const fresh = structuredClone(seed);
      const at = curPageIndex() + 1;
      const prevPage = get().activePage;
      const prevSel = get().selection;
      perform(
        () => {
          doc.pages.splice(at, 0, structuredClone(fresh) as never);
          set({ activePage: at, selection: [] });
        },
        () => {
          const i = doc.pages.findIndex((p) => p.id === fresh.id);
          if (i >= 0) doc.pages.splice(i, 1);
          set({ activePage: Math.min(prevPage, doc.pages.length - 1), selection: prevSel });
        },
      );
    },
    duplicatePage: (index) => {
      const doc = get().doc;
      const idx = index ?? curPageIndex();
      const copy = structuredClone(doc.pages[idx]);
      copy.id = `page-${crypto.randomUUID()}`;
      copy.name = `${doc.pages[idx].name ?? `Page ${idx + 1}`} copy`;
      regenIds(copy.children);
      const fresh = structuredClone(copy); // pristine snapshot, re-cloned per redo
      const at = idx + 1;
      const prevSel = get().selection;
      perform(
        () => {
          doc.pages.splice(at, 0, structuredClone(fresh) as never);
          set({ activePage: at, selection: [] });
        },
        () => {
          const i = doc.pages.findIndex((p) => p.id === fresh.id);
          if (i >= 0) doc.pages.splice(i, 1);
          set({ activePage: idx, selection: prevSel });
        },
      );
    },
    deletePage: (index) => {
      const doc = get().doc;
      if (doc.pages.length <= 1) return; // always keep one page
      const idx = index ?? curPageIndex();
      if (idx < 0 || idx >= doc.pages.length) return;
      const removed = structuredClone(doc.pages[idx]);
      const prevPage = get().activePage;
      const prevSel = get().selection;
      perform(
        () => {
          const i = doc.pages.findIndex((p) => p.id === removed.id);
          if (i >= 0) doc.pages.splice(i, 1);
          set((s) => ({ activePage: Math.min(s.activePage, doc.pages.length - 1), selection: [] }));
        },
        () => {
          doc.pages.splice(idx, 0, structuredClone(removed) as never);
          set({ activePage: prevPage, selection: prevSel });
        },
      );
    },

    setDocLanguage: (tag) => {
      // Honor access the same way setDocMeta does.
      if (!usePresence.getState().canEdit() || get().readonlyPreview()) return;
      if (tag) get().doc.language = tag;
      else delete get().doc.language;
      set((s) => ({ rev: s.rev + 1 }));
    },

    setDocTitle: (title) => {
      get().doc.title = title;
      set((s) => ({ rev: s.rev + 1 }));
    },

    setDocMeta: (patch) => {
      // Honor access the same way the canvas does: read-only (viewer/comment)
      // users and the history-preview state cannot mutate document-type content
      // (whiteboard/doc/sheet/video state all flows through here).
      if (!usePresence.getState().canEdit() || get().readonlyPreview()) return;
      // Deep-clone the captured previous meta so undo restores an independent
      // snapshot even if a surface later mutates a nested meta object in place;
      // build `next` from a fresh clone too. One undoable step.
      const prev = structuredClone(get().doc.meta);
      const next = { ...structuredClone(get().doc.meta), ...patch };
      perform(
        () => {
          get().doc.meta = next;
        },
        () => {
          get().doc.meta = structuredClone(prev);
        },
      );
    },

    setViewport: (v) =>
      set((s) => {
        const merged = { ...s.viewport, ...v };
        const viewport = { ...merged, zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, merged.zoom)) };
        // The edited page follows the scroll: the page under the viewport
        // center becomes active, so the page indicator, header highlight, and
        // panel inserts agree with what the user is looking at. Only while
        // nothing is selected or in progress: the gizmo, crop, and text-edit
        // overlays all measure in ACTIVE-page space and every selection path
        // activates the selection's page first, so re-targeting activePage
        // under a live selection would shift their coordinate origin.
        const follow =
          s.selection.length === 0 && !s.transforming && s.editingTextId === null && s.cropping === null && s.maskRefining === null;
        const idx = follow ? centeredPageIndex(s.doc, viewport, s.viewportSize) : null;
        return {
          viewport,
          ...(idx !== null && idx !== s.activePage ? { activePage: idx } : {}),
        };
      }),
    setViewportSize: (width, height) =>
      set((s) => (s.viewportSize.width === width && s.viewportSize.height === height ? {} : { viewportSize: { width, height } })),
    contentBounds: () => get().pageContentBounds(curPageIndex()),
    pageContentBounds: (index) => {
      const rev = get().rev;
      if (!cbCache || cbCache.rev !== rev) cbCache = { rev, byPage: new Map() };
      if (cbCache.byPage.has(index)) return cbCache.byPage.get(index) ?? null;
      const page = get().doc.pages[index];
      if (!page) {
        cbCache.byPage.set(index, null);
        return null;
      }
      const pageRect = { x: 0, y: 0, width: page.width, height: page.height };
      const ids = page.children.map((c) => c.id);
      const nodes = ids.length ? unionAABB(get().doc, ids) : null;
      let bounds: { x: number; y: number; width: number; height: number };
      if (!nodes) {
        bounds = pageRect;
      } else {
        // Union node bounds with the page rect so fit/overview frame content parked
        // outside the page edge while still including the artboard as a baseline.
        const minX = Math.min(nodes.x, pageRect.x);
        const minY = Math.min(nodes.y, pageRect.y);
        const maxX = Math.max(nodes.x + nodes.width, pageRect.x + pageRect.width);
        const maxY = Math.max(nodes.y + nodes.height, pageRect.y + pageRect.height);
        bounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
      }
      cbCache.byPage.set(index, bounds);
      return bounds;
    },
    fitToScreen: () => {
      const { width: vw, height: vh } = get().viewportSize;
      const b = get().contentBounds();
      if (!vw || !vh || !b || b.width <= 0 || b.height <= 0) return;
      // contentBounds is in the active page's LOCAL space (y from 0); shift it into
      // the page's stacked band so Fit frames the page being viewed, not page 1.
      const offY = pageTop(get().doc, curPageIndex());
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(vw / b.width, vh / b.height) * 0.9));
      get().setViewport({ zoom, panX: b.x + b.width / 2 - vw / 2 / zoom, panY: b.y + offY + b.height / 2 - vh / 2 / zoom });
    },
    zoomToSelection: () => {
      const { doc, selection, viewportSize } = get();
      const { width: vw, height: vh } = viewportSize;
      if (!selection.length) return get().fitToScreen();
      const b = unionAABB(doc, selection);
      if (!b || !vw || !vh) return;
      const offY = pageTop(doc, curPageIndex());
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(vw / b.width, vh / b.height) * 0.8));
      get().setViewport({ zoom, panX: b.x + b.width / 2 - vw / 2 / zoom, panY: b.y + offY + b.height / 2 - vh / 2 / zoom });
    },
    jumpToNode: (id) => {
      const { doc, viewportSize } = get();
      const { width: vw, height: vh } = viewportSize;
      const b = unionAABB(doc, [id]);
      if (!b || !vw || !vh) return;
      // Activate and offset into the page that holds the node so the jump lands on
      // it across a multi-page document (not page 1's coordinates).
      const pi = pageIndexOfNode(doc, id);
      set({ selection: [id], ...(pi >= 0 ? { activePage: pi } : {}) });
      const offY = pageTop(doc, pi >= 0 ? pi : curPageIndex());
      const cur = get().viewport.zoom;
      // Fit the node at 0.8, but never zoom IN past the current zoom or 1.5x (so a
      // small note is centered and readable, not magnified to MAX_ZOOM).
      const fit = Math.min(vw / b.width, vh / b.height) * 0.8;
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(fit, Math.max(cur, 1.5))));
      get().setViewport({ zoom, panX: b.x + b.width / 2 - vw / 2 / zoom, panY: b.y + offY + b.height / 2 - vh / 2 / zoom });
    },

    setSnapGuides: (g) => set({ snapGuides: g }),
    setTool: (tool) => set({ tool }),
    setBrush: (patch) => set((s) => ({ brush: { ...s.brush, ...patch } })),
    setCropping: (id) => set({ cropping: id }),
    setMaskRefining: (id) => set({ maskRefining: id }),
    setEditingText: (id) => set({ editingTextId: id }),
    setTextEditApply: (fn) => set({ textEditApply: fn }),
    setPresenting: (on) => set({ presenting: on }),
    toggleRulers: () => set((s) => ({ showRulers: !s.showRulers })),
    toggleGrid: () => set((s) => ({ showGrid: !s.showGrid })),
    toggleSnap: () => set((s) => ({ snapEnabled: !s.snapEnabled })),
    setGridSize: (n) => set({ gridSize: Math.max(2, Math.round(n)) }),
    addGuide: (axis, pos) => {
      const pid = get().doc.pages[curPageIndex()]?.id;
      if (!pid) return;
      set((s) => {
        const g = s.guides[pid] ?? { x: [], y: [] };
        return { guides: { ...s.guides, [pid]: { ...g, [axis]: [...g[axis], Math.round(pos)] } }, rev: s.rev + 1 };
      });
    },
    setGuide: (axis, index, pos) => {
      const pid = get().doc.pages[curPageIndex()]?.id;
      if (!pid) return;
      set((s) => {
        const g = s.guides[pid] ?? { x: [], y: [] };
        const arr = [...g[axis]];
        if (pos === null) arr.splice(index, 1);
        else if (index >= 0 && index < arr.length) arr[index] = Math.round(pos);
        return { guides: { ...s.guides, [pid]: { ...g, [axis]: arr } }, rev: s.rev + 1 };
      });
    },

    penStart: (x, y) => {
      const node = createNode("path", {
        segments: [{ x: 0, y: 0 }],
        closed: false,
        fills: [{ type: "solid", color: { srgb: { r: 0.38, g: 0.22, b: 0.86, a: 0.15 } } }],
        stroke: { fill: { type: "solid", color: { srgb: { r: 0.38, g: 0.22, b: 0.86, a: 1 } } }, width: 2, align: "center", cap: "round", join: "round" },
        transform: { x, y, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 1, height: 1 },
      } as Partial<Node>);
      const page = get().doc.pages[curPageIndex()];
      const prevSelection = get().selection;
      perform(
        () => {
          page.children.push(node);
          set({ selection: [node.id] });
        },
        () => {
          const i = page.children.findIndex((n) => n.id === node.id);
          if (i >= 0) page.children.splice(i, 1);
          set({ selection: prevSelection });
        },
      );
      return node.id;
    },
    penAdd: (id, x, y) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "path") return;
      const node = loc.node as unknown as PathNodeLike;
      node.segments.push({ x: x - node.transform.x, y: y - node.transform.y });
      normalizePath(node);
      get().tick();
    },
    penHandle: (id, x, y) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "path") return;
      const node = loc.node as unknown as PathNodeLike;
      const seg = node.segments[node.segments.length - 1];
      if (!seg) return;
      const lx = x - node.transform.x;
      const ly = y - node.transform.y;
      seg.cOut = { x: lx, y: ly };
      seg.cIn = { x: 2 * seg.x - lx, y: 2 * seg.y - ly };
      normalizePath(node);
      get().tick();
    },
    penClose: (id) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "path") return;
      (loc.node as unknown as PathNodeLike).closed = true;
      get().tick();
    },

    addLine: (x, y, arrow) => {
      const node = createNode("line", {
        points: [{ x: 0, y: 0 }, { x: 0, y: 0 }],
        stroke: { fill: { type: "solid", color: { srgb: { r: 0.1, g: 0.12, b: 0.16, a: 1 } } }, width: 4, align: "center", cap: arrow ? "butt" : "round", join: "round" },
        startCap: "none",
        endCap: arrow ? "arrow" : "none",
        transform: { x, y, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 1, height: 1 },
      } as Partial<Node>);
      const page = get().doc.pages[curPageIndex()];
      const prev = get().selection;
      perform(
        () => { page.children.push(node); set({ selection: [node.id] }); },
        () => { const i = page.children.findIndex((n) => n.id === node.id); if (i >= 0) page.children.splice(i, 1); set({ selection: prev }); },
      );
      return node.id;
    },
    updateLineEnd: (id, x, y) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "line") return;
      const node = loc.node as unknown as { transform: { x: number; y: number }; points: { x: number; y: number }[]; size: { width: number; height: number } };
      node.points[1] = { x: x - node.transform.x, y: y - node.transform.y };
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of node.points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
      node.transform.x += minX; node.transform.y += minY;
      for (const p of node.points) { p.x -= minX; p.y -= minY; }
      node.size = { width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
      get().tick();
    },
    addShapeAt: (x, y, shape) => {
      const node = createNode("shape", {
        name: shape === "rect" ? tr("app.rectangle") : tr("app.ellipse"),
        shape,
        transform: { x, y, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 1, height: 1 },
        fills: [{ type: "solid", color: { srgb: { r: 0.38, g: 0.22, b: 0.86, a: 1 } } }],
      } as Partial<Node>);
      const page = get().doc.pages[curPageIndex()];
      const prev = get().selection;
      perform(
        () => { page.children.push(node); set({ selection: [node.id] }); },
        () => { const i = page.children.findIndex((n) => n.id === node.id); if (i >= 0) page.children.splice(i, 1); set({ selection: prev }); },
      );
      return node.id;
    },
    addTextAt: (x, y) => {
      const node = createNode("text", {
        name: tr("app.text"),
        transform: { x, y, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 240, height: 44 },
        // Auto-height by default the box grows with the typed text;
        // dragging the top/bottom handle switches it to a fixed height.
        box: { mode: "autoHeight", width: 240, height: 44, autoFit: { enabled: false, min: 8, max: 512 }, verticalAlign: "top" },
        content: [{ runs: [{ text: tr("app.text"), style: { fontFamily: "system", fontStyle: "Regular", fontSize: 32, fill: { type: "solid", color: { srgb: { r: 0.1, g: 0.12, b: 0.16, a: 1 } } } } }], style: { align: "left", direction: "auto" } }],
      } as Partial<Node>);
      const page = get().doc.pages[curPageIndex()];
      const prev = get().selection;
      perform(
        () => { page.children.push(node); set({ selection: [node.id] }); },
        () => { const i = page.children.findIndex((n) => n.id === node.id); if (i >= 0) page.children.splice(i, 1); set({ selection: prev }); },
      );
      get().privateRound?.mine.add(node.id); // private mode: my own text (FR-15)
      return node.id;
    },
    insertDiagramSpec: (spec) => {
      if (!spec.nodes.length) return false;
      const doc = get().doc;
      ensureDocArrays(doc);
      const page = doc.pages[curPageIndex()];
      if (!page) return false;
      // Positions from the pure layout engine (page-local, around the origin).
      const graph = { nodes: spec.nodes.map((n) => n.id), edges: spec.edges.map((e) => [e.from, e.to] as [string, string]) };
      const pos = spec.kind === "mindmap"
        ? layoutMindMap(spec.nodes[0].id, graph, { radiusStep: 240 })
        : layoutFlowchart(graph, { direction: spec.direction ?? "down", layerGap: 220, nodeGap: 210 });
      // Anchor the diagram below existing content (or at the page origin area
      // on an empty board), normalized so the layout's min corner starts there.
      const STICKY = 170;
      let minX = Infinity;
      let minY = Infinity;
      for (const id of graph.nodes) {
        const p = pos[id] ?? { x: 0, y: 0 };
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
      }
      if (!Number.isFinite(minX)) { minX = 0; minY = 0; }
      let baseY = 80;
      for (const n of page.children as Node[]) {
        const t = n.transform;
        baseY = Math.max(baseY, t.y + Math.abs(n.size.height * t.scaleY) + 120);
      }
      const baseX = 120;
      const idMap = new Map<string, string>();
      const made: Node[] = [];
      for (const dn of spec.nodes) {
        const p = pos[dn.id] ?? { x: 0, y: 0 };
        const node = createNode("sticky", {
          text: dn.label,
          transform: { x: baseX + (p.x - minX), y: baseY + (p.y - minY), scaleX: 1, scaleY: 1, rotation: 0 },
          size: { width: STICKY, height: STICKY },
        } as Partial<Node>);
        idMap.set(dn.id, node.id);
        made.push(node);
      }
      for (const e of spec.edges) {
        const fromId = idMap.get(e.from);
        const toId = idMap.get(e.to);
        if (!fromId || !toId) continue;
        made.push(createNode("connector", {
          route: spec.kind === "mindmap" ? "curved" : "elbow",
          start: { attach: { nodeId: fromId, anchor: "auto" } },
          end: { attach: { nodeId: toId, anchor: "auto" } },
          ...(e.label ? { label: e.label } : {}),
          transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
          stroke: {
            fill: { type: "solid", color: { srgb: { r: 0.28, g: 0.33, b: 0.41, a: 1 } } },
            width: 3,
            align: "center",
            cap: "round",
            join: "round",
          },
          endCap: { kind: "arrow", size: 12 },
        } as Partial<Node>));
      }
      const prevSel = get().selection;
      perform(
        () => {
          page.children.push(...(made as never[]));
          set({ selection: made.filter((n) => n.type === "sticky").map((n) => n.id) });
        },
        () => {
          for (const n of made) {
            const i = page.children.findIndex((c) => c.id === n.id);
            if (i >= 0) page.children.splice(i, 1);
          }
          set({ selection: prevSel });
        },
      );
      return true;
    },

    collectBoardStickies: () => {
      const page = get().doc.pages[curPageIndex()];
      const out: { id: string; text: string }[] = [];
      if (!page) return out;
      for (const n of page.children as Node[]) {
        if (n.type !== "sticky" || n.locked) continue;
        const text = (n as unknown as { text?: string }).text ?? "";
        if (text.trim()) out.push({ id: n.id, text: text.trim() });
      }
      return out;
    },

    applyStickyClusters: (clusters) => {
      const doc = get().doc;
      const page = doc.pages[curPageIndex()];
      if (!page) return false;
      const STICKY = 170;
      const GAP = 24;
      const COLS = 3;
      const PAD = 28;
      const TITLE = 44;
      // Lay clusters in a row below the existing content extent.
      let baseY = 80;
      for (const n of page.children as Node[]) {
        const t = n.transform;
        baseY = Math.max(baseY, t.y + Math.abs(n.size.height * t.scaleY) + 140);
      }
      let x = 120;
      const moves: { node: Node; to: { x: number; y: number }; from: { x: number; y: number } }[] = [];
      const frames: Node[] = [];
      for (const cluster of clusters) {
        const members = cluster.ids
          .map((id) => (page.children as Node[]).find((n) => n.id === id && n.type === "sticky" && !n.locked))
          .filter((n): n is Node => !!n);
        if (!members.length) continue;
        const cols = Math.min(COLS, members.length);
        const rows = Math.ceil(members.length / cols);
        const w = PAD * 2 + cols * STICKY + (cols - 1) * GAP;
        const h = PAD * 2 + TITLE + rows * STICKY + (rows - 1) * GAP;
        frames.push(createNode("frame", {
          name: (cluster.title || tr("app.theme")).slice(0, 80),
          transform: { x, y: baseY, scaleX: 1, scaleY: 1, rotation: 0 },
          size: { width: w, height: h },
        } as Partial<Node>));
        members.forEach((m, i) => {
          const col = i % cols;
          const row = Math.floor(i / cols);
          moves.push({
            node: m,
            from: { x: m.transform.x, y: m.transform.y },
            to: { x: x + PAD + col * (STICKY + GAP), y: baseY + PAD + TITLE + row * (STICKY + GAP) },
          });
        });
        x += w + 60;
      }
      if (!frames.length) return false;
      perform(
        () => {
          // Frames go BEHIND the stickies they group (start of the paint order).
          page.children.unshift(...(frames as never[]));
          for (const mv of moves) {
            mv.node.transform.x = mv.to.x;
            mv.node.transform.y = mv.to.y;
          }
        },
        () => {
          for (const f of frames) {
            const i = page.children.findIndex((c) => c.id === f.id);
            if (i >= 0) page.children.splice(i, 1);
          }
          for (const mv of moves) {
            mv.node.transform.x = mv.from.x;
            mv.node.transform.y = mv.from.y;
          }
        },
      );
      return true;
    },

    insertSummaryNote: (text) => {
      const t = text.trim();
      if (!t) return false;
      const doc = get().doc;
      const page = doc.pages[curPageIndex()];
      if (!page) return false;
      let baseY = 80;
      for (const n of page.children as Node[]) {
        const tr = n.transform;
        baseY = Math.max(baseY, tr.y + Math.abs(n.size.height * tr.scaleY) + 120);
      }
      const node = createNode("text", {
        name: tr("app.summary"),
        transform: { x: 120, y: baseY, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 520, height: 200 },
        box: { mode: "fixed", width: 520, height: 200, autoFit: { enabled: false, min: 8, max: 512 }, verticalAlign: "top" },
        content: t.split("\n").map((line) => ({
          runs: [{ text: line, style: { fontFamily: "system", fontStyle: "Regular", fontSize: 18, fill: { type: "solid", color: { srgb: { r: 0.12, g: 0.14, b: 0.18, a: 1 } } } } }],
          style: { align: "left", direction: "auto" },
        })),
      } as Partial<Node>);
      const prevSel = get().selection;
      perform(
        () => {
          page.children.push(node as never);
          set({ selection: [node.id] });
        },
        () => {
          const i = page.children.findIndex((c) => c.id === node.id);
          if (i >= 0) page.children.splice(i, 1);
          set({ selection: prevSel });
        },
      );
      return true;
    },

    connectNodes: (fromId, toId, fromAnchor = "auto", toAnchor = "auto") => {
      if (fromId === toId) return null;
      const d = get().doc;
      if (!locate(d, fromId) || !locate(d, toId)) return null;
      const node = createNode("connector", {
        route: "elbow",
        start: { attach: { nodeId: fromId, anchor: fromAnchor } },
        end: { attach: { nodeId: toId, anchor: toAnchor } },
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        // A visible directed link (the 1px default is nearly invisible on a board).
        stroke: {
          fill: { type: "solid", color: { srgb: { r: 0.28, g: 0.33, b: 0.41, a: 1 } } },
          width: 3,
          align: "center",
          cap: "round",
          join: "round",
        },
        endCap: { kind: "arrow", size: 12 },
      } as Partial<Node>);
      const page = get().doc.pages[curPageIndex()];
      const prev = get().selection;
      perform(
        () => { page.children.push(node); set({ selection: [node.id] }); },
        () => { const i = page.children.findIndex((n) => n.id === node.id); if (i >= 0) page.children.splice(i, 1); set({ selection: prev }); },
      );
      return node.id;
    },
    addStickyAt: (x, y) => {
      const w = 180;
      const h = 180;
      const node = createNode("sticky", {
        size: { width: w, height: h },
        transform: { x: x - w / 2, y: y - h / 2, scaleX: 1, scaleY: 1, rotation: 0 },
      } as Partial<Node>);
      const page = get().doc.pages[curPageIndex()];
      const prev = get().selection;
      perform(
        () => { page.children.push(node); set({ selection: [node.id] }); },
        () => { const i = page.children.findIndex((n) => n.id === node.id); if (i >= 0) page.children.splice(i, 1); set({ selection: prev }); },
      );
      get().privateRound?.mine.add(node.id); // private mode: this is my own contribution (FR-15)
      return node.id;
    },
    stampGlyph: "👍",
    setStampGlyph: (glyph) => set({ stampGlyph: glyph }),
    privateRound: null,
    syncPrivateRound: (pm) => {
      const cur = get().privateRound;
      if (!pm || !pm.active) {
        if (cur) set({ privateRound: null });
        return;
      }
      if (cur && cur.startedAt === pm.startedAt) return; // same round: keep baseline + mine
      // New round: snapshot every existing node id (everything from before stays visible).
      const baseline = new Set<string>();
      const walk = (nodes: Node[]) => {
        for (const nd of nodes) {
          baseline.add(nd.id);
          const kids = (nd as { children?: Node[] }).children;
          if (kids) walk(kids);
        }
      };
      for (const pg of get().doc.pages) walk(pg.children);
      set({ privateRound: { startedAt: pm.startedAt, baseline, mine: new Set() } });
    },
    privateHiddenIds: () => {
      const pr = get().privateRound;
      const pm = (get().doc.meta as { whiteboard?: { privateMode?: { active?: boolean; revealed?: boolean; startedAt?: number } } } | undefined)
        ?.whiteboard?.privateMode;
      // Tie the hide strictly to the captured round's baseline: if the local round
      // hasn't reconciled to the meta's current round yet, hide nothing (avoids a
      // one-frame stale-baseline hide when a new round starts).
      if (!pr || !pm?.active || pm.revealed || pr.startedAt !== pm.startedAt) return EMPTY_ID_SET;
      // Hide nodes that appeared this round and aren't mine (i.e. others' new work).
      const hidden = new Set<string>();
      const walk = (nodes: Node[]) => {
        for (const nd of nodes) {
          if (!pr.baseline.has(nd.id) && !pr.mine.has(nd.id)) hidden.add(nd.id);
          const kids = (nd as { children?: Node[] }).children;
          if (kids) walk(kids);
        }
      };
      for (const pg of get().doc.pages) walk(pg.children);
      return hidden;
    },
    addStampAt: (x, y, authorId) => {
      const size = 40;
      const glyph = get().stampGlyph || "👍";
      const node = createNode("stamp", {
        size: { width: size, height: size },
        transform: { x: x - size / 2, y: y - size / 2, scaleX: 1, scaleY: 1, rotation: 0 },
        kind: "emoji",
        glyph,
        ...(authorId ? { authorId } : {}),
      } as Partial<Node>);
      const page = get().doc.pages[curPageIndex()];
      const prev = get().selection;
      perform(
        () => { page.children.push(node); set({ selection: [node.id] }); },
        () => { const i = page.children.findIndex((n) => n.id === node.id); if (i >= 0) page.children.splice(i, 1); set({ selection: prev }); },
      );
      get().privateRound?.mine.add(node.id); // private mode: my own stamp (FR-15)
      return node.id;
    },
    eraseNode: (id) => {
      const page = get().doc.pages[curPageIndex()];
      const index = page.children.findIndex((n) => n.id === id);
      if (index < 0) return;
      const node = page.children[index];
      if (node.locked || editBlocked(id)) return;
      const prev = get().selection;
      perform(
        () => {
          const j = page.children.findIndex((n) => n.id === id);
          if (j >= 0) page.children.splice(j, 1);
          set({ selection: prev.filter((s) => s !== id) });
        },
        () => { page.children.splice(index, 0, node); set({ selection: prev }); },
      );
    },
    setConnectorLabel: (id, text) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "connector") return;
      const n = loc.node as unknown as { label?: { text: string; position?: number } };
      const before = n.label ? { ...n.label } : undefined;
      const trimmed = text.trim();
      const after = trimmed ? { text: trimmed, position: before?.position ?? 0.5 } : undefined;
      perform(
        () => { if (after) n.label = after; else delete n.label; },
        () => { if (before) n.label = before; else delete n.label; },
      );
    },
    setConnectorWaypoints: (id, waypoints) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "connector") return;
      const n = loc.node as unknown as { waypoints?: { x: number; y: number }[] };
      const before = n.waypoints ? n.waypoints.map((p) => ({ ...p })) : undefined;
      const after = waypoints.length ? waypoints.map((p) => ({ x: p.x, y: p.y })) : undefined;
      perform(
        () => { if (after) n.waypoints = after; else delete n.waypoints; },
        () => { if (before) n.waypoints = before; else delete n.waypoints; },
      );
    },
    setConnectorRoute: (route) => {
      const { doc, selection } = get();
      const conns = selection
        .map((id) => locate(doc, id)?.node)
        .filter((n): n is Node => !!n && n.type === "connector") as unknown as { route: string }[];
      if (conns.length === 0) return;
      const before = conns.map((n) => n.route);
      perform(
        () => { for (const c of conns) c.route = route; },
        () => { conns.forEach((c, i) => { c.route = before[i]; }); },
      );
    },
    spawnConnectedShape: (fromId, fromAnchor, point) => {
      const d = get().doc;
      if (!locate(d, fromId)) return null;
      // A small rounded card centered on the release point (FigJam-style: drag out
      // of a node and drop to grow a connected next step).
      const w = 140;
      const h = 80;
      const shape = createNode("shape", {
        shape: "rect",
        fills: [{ type: "solid", color: { srgb: { r: 0.96, g: 0.97, b: 0.99, a: 1 } } }],
        cornerRadius: { topLeft: 10, topRight: 10, bottomRight: 10, bottomLeft: 10 },
        transform: { x: point.x - w / 2, y: point.y - h / 2, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: w, height: h },
      } as Partial<Node>);
      const connector = createNode("connector", {
        route: "elbow",
        start: { attach: { nodeId: fromId, anchor: fromAnchor } },
        end: { attach: { nodeId: shape.id, anchor: "auto" } },
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        stroke: { fill: { type: "solid", color: { srgb: { r: 0.28, g: 0.33, b: 0.41, a: 1 } } }, width: 3, align: "center", cap: "round", join: "round" },
        endCap: { kind: "arrow", size: 12 },
      } as Partial<Node>);
      const page = get().doc.pages[curPageIndex()];
      const prev = get().selection;
      perform(
        () => { page.children.push(shape, connector); set({ selection: [shape.id] }); },
        () => {
          for (const id of [connector.id, shape.id]) {
            const i = page.children.findIndex((n) => n.id === id);
            if (i >= 0) page.children.splice(i, 1);
          }
          set({ selection: prev });
        },
      );
      return shape.id;
    },
    setNodeRect: (id, x, y, w, h) => {
      const loc = locate(get().doc, id);
      if (!loc) return;
      const n = loc.node as unknown as { transform: Transform; size: { width: number; height: number } };
      n.transform = { ...n.transform, x, y };
      n.size = { width: Math.max(1, w), height: Math.max(1, h) };
      get().tick();
    },
    snapshotPath: (id) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "path") return null;
      const n = loc.node as unknown as { segments: unknown; contours?: unknown; transform: unknown; size: unknown };
      return structuredClone({ segments: n.segments, contours: n.contours, transform: n.transform, size: n.size });
    },
    editAnchor: (id, index, x, y) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "path" || loc.node.locked || editBlocked(id)) return;
      const node = loc.node as unknown as PathNodeLike;
      const seg = node.segments[index];
      if (!seg) return;
      // Map the page-space pointer into the node's local space through the full
      // world matrix, so dragging works on rotated/scaled paths, not just translated ones.
      const wm = worldMatrix(get().doc, id);
      const inv = wm ? invert(wm) : null;
      const local = inv ? applyToPoint(inv, { x, y }) : { x: x - node.transform.x, y: y - node.transform.y };
      const dx = local.x - seg.x;
      const dy = local.y - seg.y;
      seg.x = local.x;
      seg.y = local.y;
      if (seg.cIn) { seg.cIn.x += dx; seg.cIn.y += dy; } // handles travel with the anchor
      if (seg.cOut) { seg.cOut.x += dx; seg.cOut.y += dy; }
      normalizePath(node);
      get().tick();
    },
    editHandle: (id, index, which, x, y) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "path" || loc.node.locked || editBlocked(id)) return;
      const node = loc.node as unknown as PathNodeLike;
      const seg = node.segments[index];
      if (!seg) return;
      const wm = worldMatrix(get().doc, id);
      const inv = wm ? invert(wm) : null;
      const local = inv ? applyToPoint(inv, { x, y }) : { x: x - node.transform.x, y: y - node.transform.y };
      if (which === "out") seg.cOut = { x: local.x, y: local.y };
      else seg.cIn = { x: local.x, y: local.y };
      // Smooth anchors keep their handles colinear and mirror-length: dragging
      // one handle reflects the other through the anchor point. Corner anchors
      // (corner === true) move handles independently. A segment without an
      // explicit corner flag and with both handles is treated as smooth.
      const isSmooth = seg.corner !== true;
      if (isSmooth) {
        const opp = which === "out" ? "cIn" : "cOut";
        if (seg[opp]) {
          seg[opp] = { x: 2 * seg.x - local.x, y: 2 * seg.y - local.y };
        }
      }
      normalizePath(node);
      get().tick();
    },
    commitPathEdit: (id, before) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "path" || loc.node.locked || editBlocked(id) || !before) return;
      const n = loc.node as unknown as { segments: unknown; transform: unknown; size: unknown };
      const after = structuredClone({ segments: n.segments, contours: (n as { contours?: unknown }).contours, transform: n.transform, size: n.size });
      const apply = (snap: { segments: unknown; contours?: unknown; transform: unknown; size: unknown }) => {
        const l = locate(get().doc, id);
        if (!l) return;
        const m = l.node as unknown as { segments: unknown; contours?: unknown; transform: Record<string, unknown>; size: unknown };
        m.segments = structuredClone(snap.segments);
        // normalizePath shifts contours together with the primary contour, so
        // undo/redo must restore them together too.
        if (snap.contours === undefined) delete m.contours;
        else m.contours = structuredClone(snap.contours);
        Object.assign(m.transform, structuredClone(snap.transform));
        m.size = structuredClone(snap.size);
      };
      set((s) => ({
        rev: s.rev + 1,
        undoStack: [...s.undoStack, { undo: () => apply(before as never), redo: () => apply(after) }],
        redoStack: [],
      }));
    },

    insertAnchor: (id, index, t) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "path" || loc.node.locked || editBlocked(id)) return;
      const node = loc.node as unknown as PathNodeLike;
      const segs = node.segments;
      const n = segs.length;
      if (n < 2 || index < 0 || index >= n) return;
      // The segment runs from anchor `index` to its successor (wrapping on a
      // closed path). Nothing to split if it would point past the end on an
      // open path.
      const j = (index + 1) % n;
      if (!node.closed && j === 0) return;
      const a = segs[index];
      const b = segs[j];
      const before = get().snapshotPath(id);
      // Cubic control points (absolute, local space): missing handles collapse to
      // the anchor, so a straight segment subdivides into two straight segments.
      const p0 = { x: a.x, y: a.y };
      const p1 = a.cOut ? { x: a.cOut.x, y: a.cOut.y } : p0;
      const p3 = { x: b.x, y: b.y };
      const p2 = b.cIn ? { x: b.cIn.x, y: b.cIn.y } : p3;
      const tt = Math.max(0, Math.min(1, t));
      // De Casteljau subdivision at tt -> left and right cubics sharing the new
      // on-curve point, so the visual curve is preserved exactly.
      const lerp = (u: { x: number; y: number }, v: { x: number; y: number }) => ({ x: u.x + (v.x - u.x) * tt, y: u.y + (v.y - u.y) * tt });
      const q0 = lerp(p0, p1);
      const q1 = lerp(p1, p2);
      const q2 = lerp(p2, p3);
      const r0 = lerp(q0, q1);
      const r1 = lerp(q1, q2);
      const mid = lerp(r0, r1); // the new anchor position
      const curved = !!(a.cOut || b.cIn);
      // Rewrite a's outgoing handle, insert the new smooth anchor, and rewrite
      // b's incoming handle so the two halves reproduce the original curve.
      a.cOut = curved ? { x: q0.x, y: q0.y } : undefined;
      const mSeg: PathSeg = curved
        ? { x: mid.x, y: mid.y, cIn: { x: r0.x, y: r0.y }, cOut: { x: r1.x, y: r1.y } }
        : { x: mid.x, y: mid.y, corner: true };
      b.cIn = curved ? { x: q2.x, y: q2.y } : undefined;
      segs.splice(index + 1, 0, mSeg);
      normalizePath(node);
      get().commitPathEdit(id, before);
      set({ selection: [id] });
    },
    deleteAnchor: (id, index) => {
      get().deleteAnchors(id, [index]);
    },
    deleteAnchors: (id, indices) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "path" || loc.node.locked || editBlocked(id)) return;
      const node = loc.node as unknown as PathNodeLike;
      const minCount = node.closed ? 3 : 2;
      // Whether the original first/last anchors are being removed, so an open
      // path can shed the handle that would otherwise dangle off the new
      // endpoint (closed paths have no endpoints, so they are unaffected).
      const removingFirst = indices.includes(0);
      const removingLast = indices.includes(node.segments.length - 1);
      // Drop in descending order so earlier indices stay valid; never let the
      // path fall below a renderable anchor count.
      const sorted = [...new Set(indices)].filter((i) => i >= 0 && i < node.segments.length).sort((p, q) => q - p);
      if (!sorted.length) return;
      const before = get().snapshotPath(id);
      let removed = 0;
      for (const i of sorted) {
        if (node.segments.length - 1 < minCount) break;
        // The neighbours simply rejoin; their existing handles are kept, which
        // is the least-surprising refit for a hand edit.
        node.segments.splice(i, 1);
        removed++;
      }
      if (!removed) return;
      // On an open path, an endpoint anchor has no curve on its outer side, so
      // the handle facing the (now removed) old endpoint is orphaned. Strip the
      // new first anchor's incoming handle and the new last anchor's outgoing
      // handle so no dangling control point remains.
      if (!node.closed && node.segments.length) {
        if (removingFirst) node.segments[0].cIn = undefined;
        if (removingLast) node.segments[node.segments.length - 1].cOut = undefined;
      }
      normalizePath(node);
      get().commitPathEdit(id, before);
      set({ selection: [id] });
    },
    convertAnchor: (id, index) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "path" || loc.node.locked || editBlocked(id)) return;
      const node = loc.node as unknown as PathNodeLike;
      const seg = node.segments[index];
      if (!seg) return;
      const before = get().snapshotPath(id);
      const n = node.segments.length;
      const wasSmooth = seg.corner !== true && (!!seg.cIn || !!seg.cOut);
      if (wasSmooth) {
        // Smooth -> corner: drop both handles so the joins become hard.
        seg.cIn = undefined;
        seg.cOut = undefined;
        seg.corner = true;
      } else {
        // Corner -> smooth: derive symmetric, colinear handles from the chord
        // between the neighbouring anchors (the classic auto-smooth tangent).
        const prev = node.segments[(index - 1 + n) % n];
        const next = node.segments[(index + 1) % n];
        const usePrev = node.closed || index > 0;
        const useNext = node.closed || index < n - 1;
        let tx = (useNext ? next.x : seg.x) - (usePrev ? prev.x : seg.x);
        let ty = (useNext ? next.y : seg.y) - (usePrev ? prev.y : seg.y);
        const len = Math.hypot(tx, ty);
        if (len < 1e-6) { tx = 1; ty = 0; }
        const ux = tx / (len || 1);
        const uy = ty / (len || 1);
        // Handle length: a third of the shorter adjacent chord, for a natural curve.
        const dPrev = usePrev ? Math.hypot(seg.x - prev.x, seg.y - prev.y) : 0;
        const dNext = useNext ? Math.hypot(next.x - seg.x, next.y - seg.y) : 0;
        const h = Math.max(8, (Math.min(dPrev || dNext, dNext || dPrev) || 40) / 3);
        seg.cIn = { x: seg.x - ux * h, y: seg.y - uy * h };
        seg.cOut = { x: seg.x + ux * h, y: seg.y + uy * h };
        seg.corner = false;
      }
      normalizePath(node);
      get().commitPathEdit(id, before);
      set({ selection: [id] });
    },
    addPencilPath: (points) => {
      if (!points || points.length < 2) return null;
      // Simplify the raw stroke, then fit smooth cubics. Tolerances are in page
      // units; the values give a forgiving but faithful trace of a hand stroke.
      const simplified = simplifyPolyline(points, 1.5);
      const beziers = fitCubicBeziers(simplified.length >= 2 ? simplified : points, 2.5);
      if (!beziers.length) return null;
      // Bezier sequence -> path segments. N cubics yield N+1 on-curve anchors;
      // anchor i carries an outgoing handle from cubic[i].c1 and an incoming
      // handle from cubic[i-1].c2 (absolute local coords, per the PathSegment
      // convention), so the fitted curve renders identically.
      const segs: PathSeg[] = [];
      for (let i = 0; i <= beziers.length; i++) {
        const here = beziers[i]; // cubic starting at this anchor (undefined at the end)
        const prevCubic = beziers[i - 1]; // cubic ending at this anchor (undefined at the start)
        const at = here ? here.p0 : prevCubic.p3;
        const seg: PathSeg = { x: at.x, y: at.y };
        if (prevCubic) seg.cIn = { x: prevCubic.c2.x, y: prevCubic.c2.y };
        if (here) seg.cOut = { x: here.c1.x, y: here.c1.y };
        segs.push(seg);
      }
      const brush = get().brush;
      const bh = brush.colorHex.replace("#", "");
      const bn = parseInt(bh.length === 3 ? bh.split("").map((c) => c + c).join("") : bh, 16) || 0;
      const brushColor = { srgb: { r: ((bn >> 16) & 255) / 255, g: ((bn >> 8) & 255) / 255, b: (bn & 255) / 255, a: Math.max(0, Math.min(1, brush.opacity)) } };
      const node = createNode("path", {
        name: tr("app.pencil"),
        segments: segs,
        closed: false,
        stroke: { fill: { type: "solid", color: brushColor }, width: Math.max(0.5, brush.width), align: "center", cap: "round", join: "round" },
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 1, height: 1 },
      } as Partial<Node>);
      normalizePath(node as unknown as PathNodeLike);
      const page = get().doc.pages[curPageIndex()];
      const prev = get().selection;
      perform(
        () => { page.children.push(node); set({ selection: [node.id] }); },
        () => { const i = page.children.findIndex((nn) => nn.id === node.id); if (i >= 0) page.children.splice(i, 1); set({ selection: prev }); },
      );
      return node.id;
    },

    addInkStroke: (points) => {
      if (!points || points.length < 1) return null;
      const brush = get().brush;
      // Decimate by distance (keeping pressure), then one light smoothing pass so
      // the stored stream is bounded but faithful (the heavy-ink mitigation: a
      // stroke is one array insert, not N rewrites). First/last are always kept.
      const minDist = 1.2;
      const kept: { x: number; y: number; p?: number }[] = [points[0]];
      for (let i = 1; i < points.length; i++) {
        const last = kept[kept.length - 1];
        const pt = points[i];
        if (i === points.length - 1 || Math.hypot(pt.x - last.x, pt.y - last.y) >= minDist) kept.push(pt);
      }
      const s = 0.5; // smoothing factor (also recorded on the node)
      const pts = kept.map((p, i) => {
        if (i === 0 || i === kept.length - 1) return { x: p.x, y: p.y, p: p.p };
        const a = kept[i - 1];
        const b = kept[i + 1];
        return { x: p.x + ((a.x + b.x) / 2 - p.x) * s, y: p.y + ((a.y + b.y) / 2 - p.y) * s, p: p.p };
      });
      // Local-space the points: offset by the bbox origin (padded by the brush
      // radius) so the node transform carries position and `points` stay small.
      const width = Math.max(0.5, brush.width);
      const pad = width / 2 + 2;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of pts) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      const ox = minX - pad;
      const oy = minY - pad;
      const local = pts.map((p) => {
        const out: { x: number; y: number; p?: number } = { x: p.x - ox, y: p.y - oy };
        if (typeof p.p === "number") out.p = Math.max(0, Math.min(1, p.p));
        return out;
      });
      const bh = brush.colorHex.replace("#", "");
      const bn = parseInt(bh.length === 3 ? bh.split("").map((c) => c + c).join("") : bh, 16) || 0;
      const brushColor = { srgb: { r: ((bn >> 16) & 255) / 255, g: ((bn >> 8) & 255) / 255, b: (bn & 255) / 255, a: 1 } };
      const node = createNode("ink", {
        name: brush.mode === "highlighter" ? tr("app.highlighter") : brush.mode === "marker" ? tr("app.marker") : tr("app.ink"),
        points: local,
        smoothing: s,
        brush: { width, opacity: Math.max(0, Math.min(1, brush.opacity)), color: brushColor, mode: brush.mode },
        transform: { x: ox, y: oy, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: Math.max(1, maxX - minX + pad * 2), height: Math.max(1, maxY - minY + pad * 2) },
      } as Partial<Node>);
      const page = get().doc.pages[curPageIndex()];
      const prev = get().selection;
      perform(
        () => { page.children.push(node); set({ selection: [node.id] }); },
        () => { const i = page.children.findIndex((nn) => nn.id === node.id); if (i >= 0) page.children.splice(i, 1); set({ selection: prev }); },
      );
      get().privateRound?.mine.add(node.id); // private mode: my own ink stroke (FR-15)
      return node.id;
    },

    booleanSelection: (op) => {
      const { doc, selection } = get();
      const page = doc.pages[curPageIndex()];
      const shapes = selection
        .map((id) => locate(doc, id))
        .filter((l): l is NonNullable<typeof l> => !!l && l.node.type === "shape")
        .map((l) => l.node);
      if (shapes.length < 2) return;

      // Each shape -> its page-space path; combine with the clipper.
      const paths: VPath[] = [];
      for (const n of shapes) {
        const para = shapeNodeToParametric(n as never);
        if (!para) continue;
        const local = shapeToPath(para) as unknown as VPath;
        const wm = worldMatrix(doc, n.id);
        paths.push(wm ? transformVectorPath(local, wm) : local);
      }
      if (paths.length < 2) return;
      const result = booleanOp(op, paths as never) as unknown as VPath;
      if (!result.subpaths.length) return;

      // Normalize the result to a tight box (node at the bounds min).
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const sp of result.subpaths) for (const a of sp.anchors) {
        minX = Math.min(minX, a.x); minY = Math.min(minY, a.y);
        maxX = Math.max(maxX, a.x); maxY = Math.max(maxY, a.y);
      }
      if (!Number.isFinite(minX)) return;
      for (const sp of result.subpaths) for (const a of sp.anchors) { a.x -= minX; a.y -= minY; }

      const firstFill = (shapes[0] as unknown as { fills?: Fill[] }).fills?.[0] ?? {
        type: "solid", color: { srgb: { r: 0.38, g: 0.22, b: 0.86, a: 1 } },
      };
      const node = createNode("boolean", {
        op,
        operands: shapes.map((n) => structuredClone(n)),
        result,
        fills: [firstFill],
        transform: { x: minX, y: minY, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) },
      } as unknown as Partial<Node>);

      const ids = new Set(shapes.map((n) => n.id));
      const removed = page.children.map((n, i) => ({ n, i })).filter((x) => ids.has(x.n.id));
      perform(
        () => {
          for (const id of ids) {
            const i = page.children.findIndex((n) => n.id === id);
            if (i >= 0) page.children.splice(i, 1);
          }
          page.children.push(node);
          set({ selection: [node.id] });
        },
        () => {
          const i = page.children.findIndex((n) => n.id === node.id);
          if (i >= 0) page.children.splice(i, 1);
          for (const r of [...removed].sort((a, b) => a.i - b.i)) page.children.splice(r.i, 0, r.n);
          set({ selection: [...ids] });
        },
      );
    },

    strokeToOutlineSelection: () => {
      const { doc, selection } = get();
      if (selection.length !== 1) return;
      const loc = locate(doc, selection[0]);
      if (!loc) return;
      const n = loc.node as unknown as { type: string; stroke?: { fill: Fill; width: number }; transform: Transform; size: { width: number; height: number }; closed?: boolean; segments?: PathSeg[] };
      const stroke = n.stroke;
      if (!stroke || (n.type !== "shape" && n.type !== "path")) return;
      let path: VPath | null = null;
      if (n.type === "shape") {
        const para = shapeNodeToParametric(loc.node as never);
        if (para) path = shapeToPath(para) as unknown as VPath;
      } else {
        path = { subpaths: [{ closed: !!n.closed, anchors: (n.segments ?? []).map((s) => ({ x: s.x, y: s.y, inHandle: s.cIn, outHandle: s.cOut, corner: s.corner })) }], fillRule: "nonzero" } as VPath;
      }
      if (!path) return;
      const outline = strokeToOutline(path as never, stroke.width || 1) as unknown as VPath;
      if (!outline.subpaths.length) return;
      const page = doc.pages[curPageIndex()];
      const node = createNode("boolean", {
        name: tr("app.outline"), op: "union", operands: [], result: outline, fills: [stroke.fill],
        transform: { ...n.transform }, size: { ...n.size },
      } as unknown as Partial<Node>);
      const before = structuredClone(stroke);
      const prev = get().selection;
      perform(
        () => { delete (n as { stroke?: unknown }).stroke; page.children.push(node); set({ selection: [node.id] }); },
        () => { (n as { stroke?: unknown }).stroke = before; const i = page.children.findIndex((c) => c.id === node.id); if (i >= 0) page.children.splice(i, 1); set({ selection: prev }); },
      );
    },

    recognizeSelectedPath: () => {
      const { doc, selection } = get();
      if (selection.length !== 1) return;
      const loc = locate(doc, selection[0]);
      if (!loc || loc.node.type !== "path") return;
      const n = loc.node as unknown as { id: string; transform: Transform; closed?: boolean; segments?: PathSeg[]; stroke?: unknown; fills?: Fill[] };
      const vp: VPath = { subpaths: [{ closed: !!n.closed, anchors: (n.segments ?? []).map((s) => ({ x: s.x, y: s.y, inHandle: s.cIn, outHandle: s.cOut })) }], fillRule: "nonzero" } as VPath;
      const pts = (pathToPolylines(vp as never)[0] ?? []) as { x: number; y: number }[];
      const rec = recognizeShape(pts as never);
      if (!rec) return;
      const baseT = n.transform;
      const stroke = n.stroke;
      const fills = n.fills ?? [];
      let node: Node;
      if (rec.kind === "line") {
        node = createNode("path", {
          name: tr("app.line"), closed: false,
          segments: [{ x: rec.from.x, y: rec.from.y }, { x: rec.to.x, y: rec.to.y }],
          stroke: stroke ?? { fill: { type: "solid", color: { srgb: { r: 0.1, g: 0.12, b: 0.16, a: 1 } } }, width: 2, align: "center", cap: "round", join: "round" },
          transform: { ...baseT },
          size: { width: Math.max(1, Math.abs(rec.to.x - rec.from.x)), height: Math.max(1, Math.abs(rec.to.y - rec.from.y)) },
        } as unknown as Partial<Node>);
      } else {
        const shape = rec.kind; // rect | ellipse | triangle | polygon
        node = createNode("shape", {
          name: shape, shape,
          sides: rec.kind === "polygon" ? rec.sides : undefined,
          fills: fills.length ? fills : (stroke ? [] : [{ type: "solid", color: { srgb: { r: 0.38, g: 0.22, b: 0.86, a: 1 } } }]),
          stroke,
          transform: { x: baseT.x + rec.bbox.x, y: baseT.y + rec.bbox.y, scaleX: baseT.scaleX, scaleY: baseT.scaleY, rotation: baseT.rotation },
          size: { width: rec.bbox.width, height: rec.bbox.height },
        } as unknown as Partial<Node>);
      }
      const page = doc.pages[curPageIndex()];
      const original = loc.node;
      const prevSel = get().selection;
      perform(
        () => { const i = page.children.findIndex((c) => c.id === original.id); if (i >= 0) page.children.splice(i, 1, node); set({ selection: [node.id] }); },
        () => { const i = page.children.findIndex((c) => c.id === node.id); if (i >= 0) page.children.splice(i, 1, original); set({ selection: prevSel }); },
      );
    },

    applyTransitionToAllPages: () => {
      const doc = get().doc;
      const src = doc.pages[curPageIndex()] as unknown as { transition?: PageTransition };
      const transition = src?.transition;
      const pages = doc.pages as unknown as { transition?: PageTransition }[];
      const before = pages.map((p) => p.transition);
      // A transition plays when advancing TO a page, so the first slide never
      // shows one; setting it there anyway would be a silent no-op, not a bug.
      if (before.every((t) => JSON.stringify(t) === JSON.stringify(transition))) return;
      perform(
        () => { pages.forEach((p) => { p.transition = transition ? { ...transition } : undefined; }); },
        () => { pages.forEach((p, i) => { p.transition = before[i]; }); },
      );
    },
    setNodeAnimation: (id, anim) => {
      const loc = locate(get().doc, id);
      if (!loc || editBlocked(id)) return;
      const rec = loc.node as unknown as { animation?: NodeAnimation; animations?: unknown[] };
      const before = { animation: rec.animation, animations: rec.animations };
      const clean = anim && (anim.entrance || anim.exit || anim.emphasis || anim.custom) ? anim : undefined;
      perform(
        () => { rec.animation = clean; delete rec.animations; },
        () => { rec.animation = before.animation; rec.animations = before.animations; },
      );
    },
    magicAnimatePage: (clear) => {
      const page = get().doc.pages[curPageIndex()];
      if (!page || !page.children.length) return;
      // Vary the entrance by node kind for a lively but coherent build-in, and
      // stagger the delay down the stacking order so elements cascade in.
      const presetFor = (n: Node): EntrancePreset =>
        n.type === "text" ? "rise" : n.type === "image" || n.type === "frame" || n.type === "grid" ? "pop" : "fade";
      const nodes = page.children as Node[];
      const before = nodes.map((n) => (n as unknown as { animation?: NodeAnimation }).animation);
      perform(
        () => {
          nodes.forEach((n, i) => {
            const rec = n as unknown as { animation?: NodeAnimation; animations?: unknown[] };
            if (clear) { rec.animation = undefined; }
            else {
              rec.animation = { entrance: { preset: presetFor(n), durationMs: 500, delayMs: Math.min(i * 120, 1500), easing: "ease-out" } };
              delete rec.animations;
            }
          });
        },
        () => { nodes.forEach((n, i) => { (n as unknown as { animation?: NodeAnimation }).animation = before[i]; }); },
      );
    },
    magicAnimateAllPages: (replaceExisting) => {
      const doc = get().doc;
      const presetFor = (n: Node): EntrancePreset =>
        n.type === "text" ? "rise" : n.type === "image" || n.type === "frame" || n.type === "grid" ? "pop" : "fade";
      let animated = 0;
      get().runAsTurn(() => {
        for (const page of doc.pages) {
          const nodes = page.children as Node[];
          if (!nodes.length) continue;
          const hasAny = nodes.some((n) => !!(n as unknown as { animation?: NodeAnimation }).animation);
          if (hasAny && !replaceExisting) continue; // hand-authored builds win by default
          const before = nodes.map((n) => (n as unknown as { animation?: NodeAnimation }).animation);
          perform(
            () => {
              nodes.forEach((n, i) => {
                const rec = n as unknown as { animation?: NodeAnimation; animations?: unknown[] };
                rec.animation = { entrance: { preset: presetFor(n), durationMs: 500, delayMs: Math.min(i * 120, 1500), easing: "ease-out" } };
                delete rec.animations;
              });
            },
            () => { nodes.forEach((n, i) => { (n as unknown as { animation?: NodeAnimation }).animation = before[i]; }); },
          );
          animated++;
        }
      });
      return animated;
    },
    setNodeKeyframes: (id, track) => {
      const loc = locate(get().doc, id);
      if (!loc || editBlocked(id)) return;
      const rec = loc.node as unknown as { animation?: NodeAnimation };
      const before = rec.animation ? structuredClone(rec.animation) : undefined;
      const next: NodeAnimation = { ...(rec.animation ?? {}) };
      if (track && track.keyframes.length) next.custom = track; else delete next.custom;
      const clean = (next.entrance || next.exit || next.emphasis || next.custom) ? next : undefined;
      perform(
        () => { rec.animation = clean; },
        () => { rec.animation = before; },
      );
    },
    setInteraction: (id, interaction) => {
      const loc = locate(get().doc, id);
      if (!loc || editBlocked(id)) return;
      const rec = loc.node as unknown as { interaction?: Interaction; link?: OcLink };
      const before = { interaction: rec.interaction, link: rec.link };
      // Mirror an open-link action into the legacy `link` slot (so exporters that
      // only understand hyperlinks still see it); clear it otherwise.
      const link = interaction?.action.kind === "open-link" ? (interaction.action.link as OcLink) : undefined;
      perform(
        () => { rec.interaction = interaction; rec.link = link; },
        () => { rec.interaction = before.interaction; rec.link = before.link; },
      );
    },
    setImageMotion: (id, motion) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "image" || editBlocked(id)) return;
      const rec = loc.node as unknown as { motion?: ImageMotion };
      const before = rec.motion;
      perform(
        () => { rec.motion = motion; },
        () => { rec.motion = before; },
      );
    },
    setPageTransition: (transition, pageIndex) => {
      const idx = pageIndex ?? curPageIndex();
      const page = get().doc.pages[idx] as unknown as { transition?: PageTransition };
      if (!page) return;
      const before = page.transition;
      perform(
        () => { page.transition = transition; },
        () => { page.transition = before; },
      );
    },
    setPageTransitionOut: (transition, pageIndex) => {
      const idx = pageIndex ?? curPageIndex();
      const page = get().doc.pages[idx] as unknown as { transitionOut?: PageTransition };
      if (!page) return;
      const before = page.transitionOut;
      perform(
        () => { page.transitionOut = transition; },
        () => { page.transitionOut = before; },
      );
    },
    setPageLayout: (layoutId, pageIndex) => {
      const idx = pageIndex ?? curPageIndex();
      const page = get().doc.pages[idx] as unknown as { layoutId?: string };
      if (!page) return;
      const before = page.layoutId;
      if (before === layoutId) return;
      perform(
        () => { page.layoutId = layoutId; },
        () => { page.layoutId = before; },
      );
    },
    ensureSlideLayouts: (size) => {
      const doc = get().doc as unknown as { masters?: unknown[]; layouts?: unknown[]; pages: { width: number; height: number }[] };
      if (doc.layouts?.length) return; // already installed
      // Size the built-ins to the caller's target page (generation runs at the
      // ACTIVE page size, which in a mixed-size document may differ from
      // pages[0]); rects and capacities are derived from this size.
      const { master, layouts } = builtinMasterAndLayouts(size ?? doc.pages[0] ?? { width: 1920, height: 1080 });
      const beforeM = doc.masters;
      const beforeL = doc.layouts;
      perform(
        () => { doc.masters = [...(beforeM ?? []), master]; doc.layouts = layouts; },
        () => { doc.masters = beforeM; doc.layouts = beforeL; },
      );
    },
    setDeckTheme: (theme, opts) => {
      const doc = get().doc as unknown as {
        theme?: Theme;
        masters?: { theme?: string; placeholders?: { id: string; role: string }[] }[];
        layouts?: { id: string; placeholders: { id: string; role: string }[] }[];
      };
      const before = doc.theme;
      const beforeMasters = doc.masters?.map((m) => m.theme);
      if (before?.id === theme?.id) return;
      const restyle = opts?.restyle !== false;

      // T19: adopting a theme also restyles what the OLD theme painted - an
      // exact slot-by-slot color remap (alpha preserved) plus the font-pair
      // swap - and master-linked text (placeholder-materialized nodes) adopts
      // the new fonts by role. Exact matches only: a user's own colors and
      // fonts never match a theme slot and never move. Clearing the theme
      // leaves content untouched.
      //
      // Everything mutates IN PLACE, preserving page/node/fill identity: many
      // other undo closures capture page or node references, and replacing
      // doc.pages with clones would detach them (their undo/redo would then
      // mutate dead objects). Undo/redo of THIS action restores per-page
      // snapshots by page id, field-by-field into the existing page object.
      const pages = get().doc.pages;
      const pageDiffs: { id: string; before: Page; after: Page }[] = [];
      let pagesChanged = false; // per-page flag, reset per page below
      if (theme && restyle) {
        const rgbKey = (c: Color) => toHex({ srgb: { ...c.srgb, a: 1 } });
        const colorMap = new Map<string, Color>();
        const slots = Math.min(before?.colors.length ?? 0, theme.colors.length);
        for (let i = 0; i < slots; i++) {
          const from = before?.colors[i]?.color;
          const to = theme.colors[i]?.color;
          if (!from || !to) continue;
          const key = rgbKey(from);
          // First slot wins when two slots share a color (a generated theme's
          // primary and paper are both the page background).
          if (key !== rgbKey(to) && !colorMap.has(key)) colorMap.set(key, to);
        }
        const fontMap = new Map<string, string>();
        if (before?.fontHeading && theme.fontHeading && before.fontHeading !== theme.fontHeading)
          fontMap.set(before.fontHeading.toLowerCase(), theme.fontHeading);
        if (before?.fontBody && theme.fontBody && before.fontBody !== theme.fontBody)
          fontMap.set(before.fontBody.toLowerCase(), theme.fontBody);

        // Returns the replacement color, or null when the color maps to
        // nothing (leave it untouched - identity preserved).
        const mapColor = (c: Color | undefined): Color | null => {
          if (!c) return null;
          const to = colorMap.get(rgbKey(c));
          if (!to) return null;
          pagesChanged = true;
          return { srgb: { ...to.srgb, a: c.srgb.a } }; // keep the painted alpha
        };
        // Remap a fill's colors IN PLACE (object identity preserved).
        const mapFillInPlace = (fill: Fill | undefined): void => {
          if (!fill) return;
          const f = fill as unknown as { type?: string; color?: Color; stops?: { color: Color }[] };
          if (f.type === "solid" && f.color) {
            const to = mapColor(f.color);
            if (to) f.color = to;
          } else if (Array.isArray(f.stops)) {
            for (const st of f.stops) {
              const to = mapColor(st.color);
              if (to) st.color = to;
            }
          }
        };

        // Placeholder roles per page (ids repeat across layouts, so resolve
        // against each page's OWN layout, master placeholders included).
        const layoutById = new Map((doc.layouts ?? []).map((l) => [l.id, l]));
        for (const page of pages) {
          const beforeSnap = structuredClone(page);
          pagesChanged = false;
          const layout = layoutById.get((page as unknown as { layoutId?: string }).layoutId ?? "");
          const roleById = new Map<string, string>();
          if (layout) {
            const master = doc.masters?.find((m) => (m as { id?: string }).id === (layout as unknown as { masterId?: string }).masterId);
            for (const ph of master?.placeholders ?? []) roleById.set(ph.id, ph.role);
            for (const ph of layout.placeholders) roleById.set(ph.id, ph.role);
          }
          const pg = page as unknown as { background?: Fill };
          mapFillInPlace(pg.background);
          const applyNode = (n: Node) => {
            if (n.locked || editBlocked(n.id)) return;
            const rec = n as unknown as {
              fills?: Fill[];
              stroke?: { fill?: Fill; color?: Color };
              data?: { placeholderId?: string };
              content?: { runs: { style: { fill?: Fill; color?: Color; fontFamily?: string } }[] }[];
              children?: Node[];
            };
            for (const f of rec.fills ?? []) mapFillInPlace(f);
            if (rec.stroke) {
              mapFillInPlace(rec.stroke.fill);
              if (rec.stroke.color) {
                const to = mapColor(rec.stroke.color);
                if (to) rec.stroke.color = to;
              }
            }
            // Master-linked text adopts the new pair by role - but only where
            // the run still wears the OLD theme's font for that role (or none
            // at all). A font the user picked by hand matches neither and
            // stays. Non-placeholder text only follows an exact pair match.
            const role = rec.data?.placeholderId ? roleById.get(rec.data.placeholderId) : undefined;
            const roleFont = role ? (role === "title" ? theme.fontHeading : theme.fontBody) : undefined;
            const oldRoleFont = role ? (role === "title" ? before?.fontHeading : before?.fontBody) : undefined;
            let fontChanged = false;
            for (const para of rec.content ?? [])
              for (const run of para.runs) {
                mapFillInPlace(run.style.fill);
                if (run.style.color) {
                  const to = mapColor(run.style.color);
                  if (to) run.style.color = to;
                }
                const wearsOldRole = !run.style.fontFamily ||
                  (!!oldRoleFont && run.style.fontFamily.toLowerCase() === oldRoleFont.toLowerCase());
                const target = (roleFont && wearsOldRole ? roleFont : undefined) ??
                  (run.style.fontFamily ? fontMap.get(run.style.fontFamily.toLowerCase()) : undefined);
                if (target && run.style.fontFamily !== target) {
                  run.style.fontFamily = target;
                  fontChanged = true;
                  pagesChanged = true;
                }
              }
            if (fontChanged) refitTextHeight(n);
            for (const kid of rec.children ?? []) applyNode(kid);
          };
          for (const n of page.children) applyNode(n);
          if (pagesChanged) {
            pageDiffs.push({ id: (page as unknown as { id: string }).id, before: beforeSnap, after: structuredClone(page) });
          }
        }
      }

      // The pages are ALREADY in their after state (mutated in place above);
      // the first forward run must not re-clone them, only redo does.
      let firstRun = true;
      perform(
        () => {
          // Reuse the pure helper so the file-level swap (and master repointing)
          // stays in one place; then mirror it onto the live mutable doc.
          const live = get().doc as unknown as { theme?: Theme; masters?: { theme?: string }[] };
          if (theme) {
            const next = applyTheme(get().doc, theme);
            live.theme = next.theme;
            if (next.masters && live.masters) next.masters.forEach((m, i) => { if (live.masters![i]) live.masters![i].theme = m.theme; });
          } else {
            live.theme = undefined;
          }
          if (!firstRun) for (const d of pageDiffs) restorePageSnapshot(d.id, d.after);
          firstRun = false;
        },
        () => {
          const live = get().doc as unknown as { theme?: Theme; masters?: { theme?: string }[] };
          live.theme = before;
          if (beforeMasters && live.masters) live.masters.forEach((m, i) => { m.theme = beforeMasters[i]; });
          for (const d of pageDiffs) restorePageSnapshot(d.id, d.before);
        },
      );
    },
    setPageNotes: (notes, pageIndex) => {
      const idx = pageIndex ?? curPageIndex();
      const page = get().doc.pages[idx] as unknown as { notes?: string };
      if (!page) return;
      const before = page.notes;
      const next = notes.length > 0 ? notes : undefined;
      if (before === next) return;
      perform(
        () => { page.notes = next; },
        () => { page.notes = before; },
      );
    },
    setPageAutoAdvance: (ms, pageIndex) => {
      const idx = pageIndex ?? curPageIndex();
      const page = get().doc.pages[idx] as unknown as { autoAdvanceMs?: number };
      if (!page) return;
      const before = page.autoAdvanceMs;
      const next = ms === null ? undefined : Math.max(0, Math.round(ms));
      if (before === next) return;
      perform(
        () => { page.autoAdvanceMs = next; },
        () => { page.autoAdvanceMs = before; },
      );
    },
    setPageHidden: (hidden, pageIndex) => {
      const idx = pageIndex ?? curPageIndex();
      const page = get().doc.pages[idx] as unknown as { hidden?: boolean };
      if (!page) return;
      const before = page.hidden;
      const next = hidden ? true : undefined;
      if (before === next) return;
      perform(
        () => { page.hidden = next; },
        () => { page.hidden = before; },
      );
    },
    setPageName: (index, name) => {
      const page = get().doc.pages[index] as unknown as { name?: string };
      if (!page) return;
      const before = page.name;
      const next = name.trim() || undefined;
      if (before === next) return;
      perform(
        () => { page.name = next; },
        () => { page.name = before; },
      );
    },
    setPageLocked: (index, locked) => {
      const doc = get().doc;
      const page = doc.pages[index];
      if (!page) return;
      // Toggle every top-level element on the page directly (no selectAll, which
      // would skip already-locked nodes and make unlocking impossible).
      const cmds = page.children.map((c) => setLocked(doc, c.id, locked)).filter(Boolean) as EditCommand[];
      if (cmds.length) registerApplied(set, get, cmds);
    },
    playAnimations: () => {
      if (get().playing || typeof window === "undefined") return;
      // Collect every node carrying a typed animation on the active page, stash
      // its resting opacity/transform, then drive entrance + emphasis through the
      // shared engine patch math. Restore exactly when done or stopped.
      // Resolve cross-element sequencing across the page's top-level children so
      // the preview matches present mode / export exactly.
      const starts = sequenceStarts(get().doc.pages[curPageIndex()].children);
      const animated: { id: string; anim: NodeAnimation; opacity: number; transform: Transform; entStart: number; baseContent?: unknown }[] = [];
      const walk = (nodes: Node[]) => {
        for (const n of nodes) {
          const a = (n as unknown as { animation?: NodeAnimation }).animation;
          if (a && (a.entrance || a.emphasis)) {
            const entStart = a.entrance ? (starts.get(n.id) ?? a.entrance.delayMs) : 0;
            const reveal = a.entrance && (a.entrance.preset === "typewriter" || a.entrance.preset === "word-wipe") && n.type === "text";
            animated.push({ id: n.id, anim: a, opacity: n.opacity, transform: { ...n.transform }, entStart, baseContent: reveal ? structuredClone((n as unknown as { content: unknown }).content) : undefined });
          }
          const kids = (n as unknown as { children?: Node[] }).children;
          if (Array.isArray(kids)) walk(kids);
        }
      };
      walk(get().doc.pages[curPageIndex()].children);
      if (!animated.length) return;
      set({ playing: true });
      // Run entrances to completion (honoring sequenced starts), then loop emphasis.
      const entranceTotal = Math.max(0, ...animated.map((x) => (x.anim.entrance ? x.entStart + x.anim.entrance.durationMs : 0)));
      const hasEmphasis = animated.some((x) => x.anim.emphasis);
      const total = entranceTotal + (hasEmphasis ? 2400 : 200);
      const restore = () => {
        for (const x of animated) {
          const loc = locate(get().doc, x.id);
          if (loc) {
            loc.node.opacity = x.opacity;
            loc.node.transform = x.transform;
            if (x.baseContent !== undefined) (loc.node as unknown as { content: unknown }).content = structuredClone(x.baseContent);
          }
        }
      };
      const start = performance.now();
      const step = () => {
        if (!get().playing) { restore(); return; }
        const t = performance.now() - start;
        for (const x of animated) {
          const loc = locate(get().doc, x.id);
          if (!loc) continue;
          // Effective entrance clip with the sequenced start applied.
          const ent = x.anim.entrance ? { ...x.anim.entrance, delayMs: x.entStart } : undefined;
          const entEnd = ent ? ent.delayMs + ent.durationMs : 0;
          // Entrance leads; once it has finished, the resting pose is the base
          // for a looping emphasis. Compose the active patch over the resting node.
          let patch: AnimPatch | null = null;
          if (ent && t <= entEnd) {
            patch = entrancePatch(ent, t);
          } else if (x.anim.emphasis) {
            patch = emphasisPatch(x.anim.emphasis, t - entranceTotal);
          } else if (ent) {
            patch = entrancePatch(ent, entEnd);
          }
          applyPatch(loc.node, x.transform, x.opacity, patch);
          // Typewriter / word-wipe content reveal: restore full text then truncate.
          if (ent && x.baseContent !== undefined) {
            (loc.node as unknown as { content: unknown }).content = structuredClone(x.baseContent);
            revealEntranceText(loc.node, ent, t);
          }
        }
        get().tick();
        if (t < total) requestAnimationFrame(step);
        else { restore(); set({ playing: false }); get().tick(); }
      };
      requestAnimationFrame(step);
    },
    previewNodeAnimation: (id) => {
      if (get().playing || typeof window === "undefined") return;
      const loc = locate(get().doc, id);
      const anim = loc && (loc.node as unknown as { animation?: NodeAnimation }).animation;
      if (!loc || !anim || (!anim.entrance && !anim.emphasis && !anim.exit && !anim.custom)) return;
      set({ playing: true });
      const opacity = loc.node.opacity;
      const transform = { ...loc.node.transform };
      const entEnd = anim.entrance ? anim.entrance.delayMs + anim.entrance.durationMs : 0;
      const customDur = anim.custom ? anim.custom.durationMs : 0;
      const emphEnd = Math.max(anim.emphasis ? 2000 : 0, customDur);
      const exitDelay = entEnd + emphEnd + 200;
      const total = exitDelay + (anim.exit ? anim.exit.delayMs + anim.exit.durationMs : 300);
      const restore = () => {
        const l = locate(get().doc, id);
        if (l) { l.node.opacity = opacity; l.node.transform = transform; }
      };
      const start = performance.now();
      const step = () => {
        if (!get().playing) { restore(); return; }
        const t = performance.now() - start;
        const l = locate(get().doc, id);
        if (l) {
          let patch: AnimPatch | null = null;
          if (anim.entrance && t <= entEnd) patch = entrancePatch(anim.entrance, t);
          else if (anim.emphasis && t < entEnd + emphEnd) patch = emphasisPatch(anim.emphasis, t - entEnd);
          else if (anim.exit && t >= exitDelay) patch = exitPatchFor(anim, t - exitDelay);
          // Custom keyframe track plays over the active window (after entrance).
          if (anim.custom && t >= entEnd && t < exitDelay) {
            const c = customPatch(anim.custom, t - entEnd);
            const base = patch ?? { dx: 0, dy: 0, scale: 1, rotate: 0, opacityMul: 1 };
            patch = { dx: base.dx + c.dx, dy: base.dy + c.dy, scale: base.scale * c.scale, rotate: base.rotate + c.rotate, opacityMul: base.opacityMul * c.opacityMul };
          }
          applyPatch(l.node, transform, opacity, patch);
        }
        get().tick();
        if (t < total) requestAnimationFrame(step);
        else { restore(); set({ playing: false }); get().tick(); }
      };
      requestAnimationFrame(step);
    },

    insertTable: (rows = 3, cols = 3) => {
      const colW = 120, rowH = 40;
      const cells = [];
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++)
          cells.push({ row: r, col: c, rowSpan: 1, colSpan: 1, align: "left", content: [{ text: r === 0 ? `Column ${c + 1}` : "", fontId: "system", fontSize: 14, weight: r === 0 ? 700 : 400 }] });
      get().addNode("table", {
        rows, cols,
        colWidths: Array(cols).fill(colW),
        rowHeights: Array(rows).fill(rowH),
        cells,
        transform: { x: 200, y: 200, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: cols * colW, height: rows * rowH },
      } as unknown as Partial<Node>);
    },
    insertChart: (chartType = "bar") => {
      get().addNode("chart", {
        chartType,
        categories: ["A", "B", "C", "D"],
        series: [{ name: tr("app.series_1"), values: [12, 19, 8, 15], color: seriesColorAt(0) }],
        options: {},
        style: { legend: { show: true, position: "bottom" }, valueLabels: false },
        transform: { x: 200, y: 200, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 360, height: 240 },
      } as unknown as Partial<Node>);
    },
    insertChartData: (data) => {
      const series = data.series.length
        ? data.series.map((s, i) => ({ name: s.name, values: s.values, color: seriesColorAt(i) }))
        : [{ name: tr("app.series_1"), values: [], color: seriesColorAt(0) }];
      const node = createNode("chart", {
        chartType: data.chartType,
        categories: data.categories,
        series,
        options: {},
        style: { legend: { show: true, position: "bottom" }, valueLabels: false },
        transform: { x: 200, y: 200, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 480, height: 320 },
      } as unknown as Partial<Node>);
      const pageIndex = positionInView(node);
      const page = get().doc.pages[pageIndex];
      const prev = get().selection;
      const prevActive = get().activePage;
      perform(
        () => { page.children.push(node); set({ activePage: pageIndex, selection: [node.id] }); },
        () => { const i = page.children.findIndex((n) => n.id === node.id); if (i >= 0) page.children.splice(i, 1); set({ activePage: prevActive, selection: prev }); },
      );
      return node.id;
    },
    setChart: (id, patch) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "chart") return;
      const rec = loc.node as unknown as { chartType: unknown; categories: unknown; series: unknown; style: unknown };
      const before = { chartType: rec.chartType, categories: rec.categories, series: rec.series, style: rec.style };
      const after = structuredClone({ ...before, ...patch });
      perform(
        () => Object.assign(rec, after),
        () => Object.assign(rec, before),
      );
    },
    setChartSeriesColor: (id, seriesIndex, color) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "chart") return;
      const ch = loc.node as unknown as ChartNode;
      const series = (ch.series ?? []).map((s, i) => (i === seriesIndex ? { ...s, color } : { ...s }));
      get().setChart(id, { series });
    },
    setDataBinding: (id, binding) => {
      const loc = locate(get().doc, id);
      if (!loc || (loc.node.type !== "chart" && loc.node.type !== "table")) return;
      const rec = loc.node as unknown as { binding?: DataBinding };
      const before = rec.binding ? structuredClone(rec.binding) : undefined;
      const after = binding ? structuredClone(binding) : undefined;
      perform(
        () => { if (after) rec.binding = after; else delete rec.binding; },
        () => { if (before) rec.binding = before; else delete rec.binding; },
      );
    },
    refreshBinding: async (id) => {
      const loc = locate(get().doc, id);
      if (!loc) return false;
      const node = loc.node as unknown as { type: string; binding?: DataBinding; chartType?: ChartNode["chartType"] };
      const b = node.binding;
      if (!b) return false;
      let csv = b.csv ?? "";
      if (b.kind === "url" && b.url) {
        // Direct fetch first (works for CORS-enabled hosts and same-origin
        // files); fall back to the server's SSRF-guarded data proxy, which
        // covers the common case of a source with no CORS headers.
        let text: string | null = null;
        try {
          const res = await fetch(b.url);
          if (res.ok) text = await res.text();
        } catch {
          text = null;
        }
        if (text === null) {
          try {
            const { oc } = await import("@/lib/sdk");
            text = (await oc.dataFetch({ url: b.url })).text;
          } catch {
            return false;
          }
        }
        csv = text;
      }
      const matrix = parseCsvMatrix(csv);
      if (!looksLikeData(matrix)) return false; // markup in: keep the stored data
      if (node.type === "chart") {
        const cd = tabularToChart(matrix, node.chartType ?? "bar");
        get().setChart(id, { chartType: cd.chartType, categories: cd.categories, series: cd.series });
        return true;
      }
      if (node.type === "table") {
        get().setTableData(id, matrix);
        return true;
      }
      return false;
    },
    setTableData: (id, grid) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "table") return;
      const rec = loc.node as unknown as Record<string, unknown>;
      const before = structuredClone({ rows: rec.rows, cols: rec.cols, colWidths: rec.colWidths, rowHeights: rec.rowHeights, cells: rec.cells, size: loc.node.size });
      const rows = Math.max(1, grid.length);
      const cols = Math.max(1, ...grid.map((r) => r.length));
      const cells = [];
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++)
          cells.push({ row: r, col: c, rowSpan: 1, colSpan: 1, align: "left", content: [{ text: grid[r]?.[c] ?? "", fontId: "system", fontSize: 14, weight: r === 0 ? 700 : 400 }] });
      const colW = 120, rowH = 40;
      const after = structuredClone({ rows, cols, colWidths: Array(cols).fill(colW), rowHeights: Array(rows).fill(rowH), cells, size: { width: cols * colW, height: rows * rowH } });
      const set2 = (snap: Record<string, unknown>) => {
        const l = locate(get().doc, id);
        if (!l) return;
        const m = l.node as unknown as Record<string, unknown>;
        m.rows = snap.rows; m.cols = snap.cols; m.colWidths = snap.colWidths; m.rowHeights = snap.rowHeights; m.cells = snap.cells;
        l.node.size = snap.size as { width: number; height: number };
      };
      perform(() => set2(structuredClone(after)), () => set2(structuredClone(before)));
    },
    addTableRow: (id, at) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "table") return;
      const t = loc.node as unknown as TableNode;
      const idx = at === undefined ? t.rows : Math.max(0, Math.min(at, t.rows));
      const rowH = t.rowHeights[Math.min(idx, t.rowHeights.length - 1)] ?? 40;
      const cells = t.cells.map((c) => (c.row >= idx ? { ...c, row: c.row + 1 } : { ...c }));
      for (let c = 0; c < t.cols; c++)
        cells.push({ row: idx, col: c, rowSpan: 1, colSpan: 1, align: "left" as const, content: [{ text: "", fontId: "system", fontSize: 14, weight: 400 }] });
      const rowHeights = [...t.rowHeights];
      rowHeights.splice(idx, 0, rowH);
      applyTableShape(id, get, perform, { rows: t.rows + 1, cols: t.cols, colWidths: t.colWidths, rowHeights, cells });
    },
    removeTableRow: (id, at) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "table") return;
      const t = loc.node as unknown as TableNode;
      if (t.rows <= 1 || at < 0 || at >= t.rows) return;
      const cells = t.cells
        .filter((c) => c.row !== at)
        .map((c) => {
          // Cell above the removed row that spans across it: shrink its rowSpan.
          if (c.row < at && c.row + (c.rowSpan || 1) > at) {
            return { ...c, rowSpan: Math.max(1, (c.rowSpan || 1) - 1) };
          }
          return c.row > at ? { ...c, row: c.row - 1 } : { ...c };
        });
      const rowHeights = [...t.rowHeights];
      rowHeights.splice(at, 1);
      applyTableShape(id, get, perform, { rows: t.rows - 1, cols: t.cols, colWidths: t.colWidths, rowHeights, cells });
    },
    addTableColumn: (id, at) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "table") return;
      const t = loc.node as unknown as TableNode;
      const idx = at === undefined ? t.cols : Math.max(0, Math.min(at, t.cols));
      const colW = t.colWidths[Math.min(idx, t.colWidths.length - 1)] ?? 120;
      const cells = t.cells.map((c) => (c.col >= idx ? { ...c, col: c.col + 1 } : { ...c }));
      for (let r = 0; r < t.rows; r++)
        cells.push({ row: r, col: idx, rowSpan: 1, colSpan: 1, align: "left" as const, content: [{ text: "", fontId: "system", fontSize: 14, weight: r === 0 ? 700 : 400 }] });
      const colWidths = [...t.colWidths];
      colWidths.splice(idx, 0, colW);
      applyTableShape(id, get, perform, { rows: t.rows, cols: t.cols + 1, colWidths, rowHeights: t.rowHeights, cells });
    },
    removeTableColumn: (id, at) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "table") return;
      const t = loc.node as unknown as TableNode;
      if (t.cols <= 1 || at < 0 || at >= t.cols) return;
      const cells = t.cells
        .filter((c) => c.col !== at)
        .map((c) => {
          // Cell left of the removed column that spans across it: shrink colSpan.
          if (c.col < at && c.col + (c.colSpan || 1) > at) {
            return { ...c, colSpan: Math.max(1, (c.colSpan || 1) - 1) };
          }
          return c.col > at ? { ...c, col: c.col - 1 } : { ...c };
        });
      const colWidths = [...t.colWidths];
      colWidths.splice(at, 1);
      applyTableShape(id, get, perform, { rows: t.rows, cols: t.cols - 1, colWidths, rowHeights: t.rowHeights, cells });
    },
    mergeTableCell: (id, row, col, dir) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "table") return;
      const t = loc.node as unknown as TableNode;
      const cell = t.cells.find((c) => c.row === row && c.col === col);
      if (!cell) return;
      let neighbor: TableCell | undefined;
      let merged: TableCell;
      if (dir === "right") {
        const nCol = col + (cell.colSpan || 1);
        if (nCol >= t.cols) return;
        neighbor = t.cells.find((c) => c.row === row && c.col === nCol);
        if (!neighbor || (neighbor.rowSpan || 1) !== (cell.rowSpan || 1)) return;
        merged = { ...cell, colSpan: (cell.colSpan || 1) + (neighbor.colSpan || 1) };
      } else {
        const nRow = row + (cell.rowSpan || 1);
        if (nRow >= t.rows) return;
        neighbor = t.cells.find((c) => c.col === col && c.row === nRow);
        if (!neighbor || (neighbor.colSpan || 1) !== (cell.colSpan || 1)) return;
        merged = { ...cell, rowSpan: (cell.rowSpan || 1) + (neighbor.rowSpan || 1) };
      }
      const cells = t.cells.filter((c) => c !== neighbor).map((c) => (c === cell ? merged : c));
      applyTableShape(id, get, perform, { rows: t.rows, cols: t.cols, colWidths: t.colWidths, rowHeights: t.rowHeights, cells });
    },
    splitTableCell: (id, row, col) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "table") return;
      const t = loc.node as unknown as TableNode;
      const cell = t.cells.find((c) => c.row === row && c.col === col);
      if (!cell || ((cell.rowSpan || 1) <= 1 && (cell.colSpan || 1) <= 1)) return;
      const cells = t.cells.map((c) => (c === cell ? { ...c, rowSpan: 1, colSpan: 1 } : c));
      // Re-add the cells the span used to cover (all but the top-left corner).
      for (let r = row; r < row + (cell.rowSpan || 1); r++) {
        for (let cc = col; cc < col + (cell.colSpan || 1); cc++) {
          if (r === row && cc === col) continue;
          cells.push({ row: r, col: cc, rowSpan: 1, colSpan: 1, align: "left" as const, content: [{ text: "", fontId: "system", fontSize: 14, weight: r === 0 ? 700 : 400 }] } as unknown as TableCell);
        }
      }
      applyTableShape(id, get, perform, { rows: t.rows, cols: t.cols, colWidths: t.colWidths, rowHeights: t.rowHeights, cells });
    },
    setTableStyle: (id, patch) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "table") return;
      const rec = loc.node as unknown as { headerStyle: unknown; borderStyle: unknown };
      const before = { headerStyle: rec.headerStyle, borderStyle: rec.borderStyle };
      const after = structuredClone({ ...before, ...patch });
      perform(() => Object.assign(rec, after), () => Object.assign(rec, before));
    },
    setTableConditional: (id, rules) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "table") return;
      const rec = loc.node as unknown as { conditional?: unknown };
      const before = { conditional: rec.conditional };
      const after = structuredClone({ conditional: rules.length ? rules : undefined });
      perform(() => Object.assign(rec, after), () => Object.assign(rec, before));
    },
    setTableCellStyle: (id, row, col, patch) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "table") return;
      const t = loc.node as unknown as TableNode;
      const before = structuredClone(t.cells);
      const after = before.map((c) =>
        c.row === row && c.col === col ? structuredClone({ ...c, ...patch }) : structuredClone(c),
      );
      const setCells = (cells: TableCell[]) => {
        const l = locate(get().doc, id);
        if (l && l.node.type === "table") (l.node as unknown as TableNode).cells = structuredClone(cells);
      };
      perform(() => setCells(after), () => setCells(before));
    },

    copySelection: () => {
      const { doc, selection } = get();
      const nodes = selectionRoots(doc, selection)
        .map((id) => locate(doc, id)?.node)
        .filter((n): n is Node => !!n)
        .map((n) => structuredClone(n));
      if (!nodes.length) return;
      clipboardNodes = nodes;
      // Mirror to the OS clipboard so paste survives refresh/other tabs and so
      // the native paste handler treats the freshest copy as the source.
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(ocClipPrefix + JSON.stringify(nodes)).catch(() => {});
      }
    },
    cutSelection: () => {
      get().copySelection();
      if (get().selection.length) get().deleteSelection();
    },
    paste: (offset = 24) => {
      if (!clipboardNodes?.length) return;
      const { nodes } = remapIds(structuredClone(clipboardNodes));
      if (offset) nodes.forEach((n) => { n.transform = { ...n.transform, x: n.transform.x + offset, y: n.transform.y + offset }; });
      const page = get().doc.pages[curPageIndex()];
      const ids = nodes.map((n) => n.id);
      const prev = get().selection;
      perform(
        () => { page.children.push(...nodes); set({ selection: ids }); },
        () => {
          for (const id of ids) { const i = page.children.findIndex((n) => n.id === id); if (i >= 0) page.children.splice(i, 1); }
          set({ selection: prev });
        },
      );
      { const pr = get().privateRound; if (pr) ids.forEach((id) => pr.mine.add(id)); } // private mode: my paste (FR-15)
    },
    pasteInPlace: () => get().paste(0),
    pasteNodes: (incoming) => {
      // Clipboard JSON is user-controlled; keep only node-like objects with a
      // string type so a malformed paste can't corrupt the page.
      const safe = (incoming ?? []).filter((n): n is Node => !!n && typeof (n as { type?: unknown }).type === "string");
      if (!safe.length) return;
      const { nodes } = remapIds(structuredClone(safe));
      nodes.forEach((n) => { n.transform = { ...n.transform, x: n.transform.x + 24, y: n.transform.y + 24 }; });
      const page = get().doc.pages[curPageIndex()];
      const ids = nodes.map((n) => n.id);
      const prev = get().selection;
      perform(
        () => { page.children.push(...nodes); set({ selection: ids }); },
        () => {
          for (const id of ids) { const i = page.children.findIndex((n) => n.id === id); if (i >= 0) page.children.splice(i, 1); }
          set({ selection: prev });
        },
      );
      { const pr = get().privateRound; if (pr) ids.forEach((id) => pr.mine.add(id)); } // private mode: my paste (FR-15)
    },
    addTextBox: (text, at) => {
      const node = createNode("text", {
        name: text.slice(0, 24) || tr("app.text"),
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 360, height: 80 },
        box: { mode: "fixed", width: 360, height: 80, autoFit: { enabled: false, min: 8, max: 512 }, verticalAlign: "top" },
        content: [{ runs: [{ text, style: { fontFamily: "system", fontStyle: "Regular", fontSize: 24, fill: { type: "solid", color: { srgb: { r: 0.1, g: 0.12, b: 0.16, a: 1 } } } } }], style: { align: "left", direction: "auto" } }],
      } as Partial<Node>);
      // A pointer-derived position is already in the ACTIVE page's local space
      // (the pointer flow activates the page under the cursor first); a panel
      // insert centers on the page under the viewport instead.
      let pageIndex = curPageIndex();
      if (at) (node as unknown as { transform: Transform }).transform = { x: at.x, y: at.y, scaleX: 1, scaleY: 1, rotation: 0 };
      else pageIndex = positionInView(node);
      const page = get().doc.pages[pageIndex];
      const prev = get().selection;
      const prevActive = get().activePage;
      perform(
        () => { page.children.push(node); set({ activePage: pageIndex, selection: [node.id] }); },
        () => { const i = page.children.findIndex((n) => n.id === node.id); if (i >= 0) page.children.splice(i, 1); set({ activePage: prevActive, selection: prev }); },
      );
      get().privateRound?.mine.add(node.id); // private mode: my text (FR-15)
    },
    duplicateSelection: (dx = 24, dy = 24) => {
      const { doc, selection } = get();
      const src = selectionRoots(doc, selection)
        .map((id) => locate(doc, id)?.node)
        .filter((n): n is Node => !!n);
      if (!src.length) return [];
      const { nodes } = remapIds(structuredClone(src));
      nodes.forEach((n) => { n.transform = { ...n.transform, x: n.transform.x + dx, y: n.transform.y + dy }; });
      const page = get().doc.pages[curPageIndex()];
      const ids = nodes.map((n) => n.id);
      perform(
        () => { page.children.push(...nodes); set({ selection: ids }); },
        () => {
          for (const id of ids) { const i = page.children.findIndex((n) => n.id === id); if (i >= 0) page.children.splice(i, 1); }
          set({ selection });
        },
      );
      { const pr = get().privateRound; if (pr) ids.forEach((id) => pr.mine.add(id)); } // private mode: my duplicates (FR-15)
      return ids;
    },
    nudge: (dx, dy) => {
      const { doc, selection } = get();
      const nodes: string[] = [];
      const before: Transform[] = [];
      const after: Transform[] = [];
      for (const id of selection) {
        const loc = locate(doc, id);
        if (!loc || loc.node.locked || editBlocked(id)) continue; // skip collab-locked + brand locked regions
        nodes.push(id);
        before.push({ ...loc.node.transform });
        after.push(moveTransform(loc.node.transform, dx, dy));
      }
      if (nodes.length) get().runCommand({ kind: "transform", nodes, before, after });
    },
    rotateSelection: (deltaDeg) => {
      const { doc, selection } = get();
      const nodes: string[] = [];
      const before: Transform[] = [];
      const after: Transform[] = [];
      for (const id of selection) {
        const loc = locate(doc, id);
        if (!loc || loc.node.locked || editBlocked(id)) continue; // skip collab-locked + brand locked regions
        const sz = (loc.node as { size?: { width: number; height: number } }).size;
        if (!sz) continue; // no box, no pivot (e.g. connectors follow their endpoints)
        nodes.push(id);
        before.push({ ...loc.node.transform });
        after.push(rotateAboutPoint(loc.node.transform, sz, deltaDeg, loc.node.transform.origin ?? { x: 0.5, y: 0.5 }));
      }
      if (nodes.length) get().runCommand({ kind: "transform", nodes, before, after });
    },
    growSelection: (dw, dh) => {
      // One keypress = ONE undo step, even for a mixed selection whose
      // text/line/grid/frame members each commit through their own geometry
      // applier: runAsTurn collapses everything this adds into a composite.
      get().runAsTurn(() => {
        const { doc, selection } = get();
        const nodes: string[] = [];
        const before: Transform[] = [];
        const after: Transform[] = [];
        const beforeSizes: { width: number; height: number }[] = [];
        const afterSizes: { width: number; height: number }[] = [];
        for (const id of selection) {
          const loc = locate(doc, id);
          if (!loc || loc.node.locked || editBlocked(id)) continue; // skip collab-locked + brand locked regions
          const sz = (loc.node as { size?: { width: number; height: number } }).size;
          if (!sz) continue; // nodes without a box (e.g. connectors) have nothing to grow
          const next = { width: Math.max(1, sz.width + dw), height: Math.max(1, sz.height + dh) };
          if (next.width === sz.width && next.height === sz.height) continue;
          const t = { ...loc.node.transform };
          // Content that lays out from its box must re-lay when the box changes
          // (mirrors the properties panel's W/H commit path).
          if (loc.node.type === "text") { get().applyTextGeometry(id, t, next); continue; }
          if (loc.node.type === "line") { get().applyLineGeometry(id, t, next); continue; }
          if (loc.node.type === "grid") { get().applyGridGeometry(id, t, next); continue; }
          if (loc.node.type === "frame") { get().applyFrameGeometry(id, t, next); continue; }
          nodes.push(id);
          before.push({ ...loc.node.transform });
          after.push(t);
          beforeSizes.push({ ...sz });
          afterSizes.push(next);
        }
        if (nodes.length) get().runCommand({ kind: "transform", nodes, before, after, beforeSizes, afterSizes });
      });
    },
    reorderLayer: (id, toIndex) => {
      if (editBlocked(id)) return; // a filler may not restack a brand locked region
      const page = get().doc.pages[curPageIndex()];
      const from = page.children.findIndex((n) => n.id === id);
      if (from < 0) return;
      const to = Math.max(0, Math.min(toIndex, page.children.length - 1));
      if (from === to) return;
      perform(
        () => { const [n] = page.children.splice(from, 1); page.children.splice(to, 0, n); },
        () => { const i = page.children.findIndex((x) => x.id === id); if (i >= 0) { const [n] = page.children.splice(i, 1); page.children.splice(from, 0, n); } },
      );
    },
    setNodeHidden: (id, hidden) => {
      const cmd = setHidden(get().doc, id, hidden);
      if (cmd) registerApplied(set, get, [cmd]);
    },
    setNodeLocked: (id, locked) => {
      const cmd = setLocked(get().doc, id, locked);
      if (cmd) registerApplied(set, get, [cmd]);
    },
    copyStyle: () => {
      const { doc, selection } = get();
      if (selection[0]) styleClip = captureStyle(doc, selection[0]);
    },
    pasteStyle: () => {
      const { doc } = get();
      // Never restyle a brand locked-region (or collab-locked) node.
      const selection = get().selection.filter((id) => !editBlocked(id));
      if (!styleClip || !selection.length) return;
      const { ops } = pasteStyleOps(doc, selection, styleClip as Parameters<typeof pasteStyleOps>[2]);
      if (!ops.length) return;
      for (const op of ops) applyCommand(doc, op);
      get().pushApplied(ops);
    },

    runCommand: (cmd) => {
      const e = commandEntry(cmd);
      perform(e.redo, e.undo);
    },

    tick: () => set((s) => ({ rev: s.rev + 1 })),
    pushApplied: (cmds) => {
      if (cmds.length) registerApplied(set, get, cmds);
      // Private mode (FR-15): command-based inserts (toolbar create, templates,
      // paste) are MY contributions this round, so they stay visible to me.
      const pr = get().privateRound;
      if (pr) for (const c of cmds) if (c.kind === "insert" && c.node) pr.mine.add(c.node.id);
    },
    pushNodeSnapshot: (id, before) => {
      type Snap = { transform: Transform; size: { width: number; height: number }; box?: unknown; content?: unknown; points?: unknown; children?: unknown };
      const apply = (snap: Snap) => {
        const l = locate(get().doc, id);
        if (!l) return;
        const n = l.node as unknown as Snap;
        n.transform = { ...snap.transform };
        n.size = { ...snap.size };
        if (snap.box !== undefined) n.box = structuredClone(snap.box);
        if (snap.content !== undefined) n.content = structuredClone(snap.content);
        if (snap.points !== undefined) n.points = structuredClone(snap.points);
        if (snap.children !== undefined) n.children = structuredClone(snap.children);
      };
      const l = locate(get().doc, id);
      if (!l) return;
      const cur = l.node as unknown as Snap;
      const after: Snap = { transform: { ...cur.transform }, size: { ...cur.size }, box: cur.box !== undefined ? structuredClone(cur.box) : undefined, content: cur.content !== undefined ? structuredClone(cur.content) : undefined, points: cur.points !== undefined ? structuredClone(cur.points) : undefined, children: before.children !== undefined ? structuredClone(cur.children) : undefined };
      const b: Snap = { transform: { ...before.transform }, size: { ...before.size }, box: before.box !== undefined ? structuredClone(before.box) : undefined, content: before.content !== undefined ? structuredClone(before.content) : undefined, points: before.points !== undefined ? structuredClone(before.points) : undefined, children: before.children !== undefined ? structuredClone(before.children) : undefined };
      // Same invariant as perform(): while a CRDT undo manager is bound the
      // local stacks stay EMPTY - replaying a stale snapshot against a later
      // collaborative state would clobber peer edits.
      if (get().collabUndo) {
        set((s) => ({ rev: s.rev + 1 }));
        return;
      }
      set((s) => ({ rev: s.rev + 1, undoStack: [...s.undoStack, { undo: () => apply(b), redo: () => apply(after) }], redoStack: [] }));
    },

    addNode: (type, init) => {
      const node = createNode(type, init);
      const pageIndex = positionInView(node);
      const page = get().doc.pages[pageIndex];
      const prevSelection = get().selection;
      const prevActive = get().activePage;
      perform(
        () => {
          page.children.push(node);
          set({ activePage: pageIndex, selection: [node.id] });
        },
        () => {
          const i = page.children.findIndex((n) => n.id === node.id);
          if (i >= 0) page.children.splice(i, 1);
          set({ activePage: prevActive, selection: prevSelection });
        },
      );
    },

    addIconSvg: (svg, provenance) => {
      // Same resolver as Import SVG (resolves <style> classes, currentColor, and
      // gradient url() fills), but keeps the catalog default: a shape with no
      // resolvable fill falls back to black (so a bare monochrome icon still paints).
      const { nodes } = flattenSvgToNodes(svg, { fallbackFill: true });
      if (!nodes.length) return;
      // The parsed nodes are in the SVG viewBox space (e.g. 0..24); scale the
      // whole group up to a sensible on-canvas size and center it in the view.
      const vb = /viewBox\s*=\s*"([^"]+)"/i.exec(svg)?.[1]?.trim().split(/[\s,]+/).map(Number);
      const vbW = (vb && vb[2]) || 24;
      const vbH = (vb && vb[3]) || 24;
      const scale = 200 / Math.max(vbW, vbH);
      const group = createNode("group", {
        name: tr("app.icon"),
        children: nodes,
        transform: { x: 0, y: 0, scaleX: scale, scaleY: scale, rotation: 0 },
        size: { width: vbW, height: vbH },
        // Provenance (stock asset id + license) rides in the same undo step so
        // the attribution compiler can derive credits from the design itself.
        ...(provenance ? { data: { provenance } } : {}),
      } as Partial<Node>);
      const pageIndex = positionInView(group);
      const page = get().doc.pages[pageIndex];
      const prev = get().selection;
      const prevActive = get().activePage;
      perform(
        () => { page.children.push(group); set({ activePage: pageIndex, selection: [group.id] }); },
        () => { const i = page.children.findIndex((n) => n.id === group.id); if (i >= 0) page.children.splice(i, 1); set({ activePage: prevActive, selection: prev }); },
      );
    },
    insertPhotoGrid: (rows, cols, spans) => {
      const r = Math.max(1, Math.min(6, Math.round(rows)));
      const c = Math.max(1, Math.min(6, Math.round(cols)));
      // Size against the page under the viewport (the page the grid will join).
      const { index: pageIndex, page } = insertContext();
      if (!page) return null;
      const gap = 8;
      // Size the grid to a comfortable square-ish box within the page.
      const gw = Math.min(page.width * 0.8, 720);
      const gh = Math.min(page.height * 0.8, 720);
      // Feature layouts pass an explicit cell list (with spans); default is one
      // cell per row/col slot. Out-of-bounds spans are clamped to the grid.
      const slots: GridSpan[] = spans?.length
        ? spans.map((s) => ({
            row: Math.max(0, Math.min(r - 1, s.row)),
            col: Math.max(0, Math.min(c - 1, s.col)),
            rowSpan: Math.max(1, Math.min(r - Math.max(0, Math.min(r - 1, s.row)), s.rowSpan)),
            colSpan: Math.max(1, Math.min(c - Math.max(0, Math.min(c - 1, s.col)), s.colSpan)),
          }))
        : Array.from({ length: r * c }, (_, i) => ({ row: Math.floor(i / c), col: i % c, rowSpan: 1, colSpan: 1 }));
      const children: Node[] = [];
      const cells: { row: number; col: number; rowSpan: number; colSpan: number; childId: string }[] = [];
      for (const s of slots) {
        const box = gridCellBox({ width: gw, height: gh }, r, c, gap, s);
        const cell = createNode("frame", {
          name: tr("app.photo"),
          transform: { x: box.x, y: box.y, scaleX: 1, scaleY: 1, rotation: 0 },
          size: { width: box.width, height: box.height },
          clip: true,
          children: [],
          maskShape: "rect",
          fills: [{ type: "solid", color: { srgb: { r: 0.9, g: 0.91, b: 0.93, a: 1 } } }],
        } as Partial<Node>);
        children.push(cell);
        cells.push({ ...s, childId: cell.id });
      }
      const grid = createNode("grid", {
        name: tr("app.photo_grid"),
        rows: r, cols: c, gap,
        cells, children,
        size: { width: gw, height: gh },
      } as Partial<Node>);
      positionInView(grid);
      const prev = get().selection;
      const prevActive = get().activePage;
      perform(
        () => { page.children.push(grid); set({ activePage: pageIndex, selection: [grid.id] }); },
        () => { const i = page.children.findIndex((n) => n.id === grid.id); if (i >= 0) page.children.splice(i, 1); set({ activePage: prevActive, selection: prev }); },
      );
      return grid.id;
    },
    setGridLayout: (id, patch) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "grid" || loc.node.locked || editBlocked(id)) return;
      const g = loc.node as unknown as { rows: number; cols: number; gap: number; size: { width: number; height: number }; cells: { row: number; col: number; rowSpan: number; colSpan: number; childId?: string }[]; children: Node[] };
      const before = structuredClone({ rows: g.rows, cols: g.cols, gap: g.gap, cells: g.cells, children: g.children });
      const r = Math.max(1, Math.min(6, Math.round(patch.rows ?? g.rows)));
      const c = Math.max(1, Math.min(6, Math.round(patch.cols ?? g.cols)));
      const gap = Math.max(0, patch.gap ?? g.gap);
      // Lay a frame into its cell box, and keep a filled cell's image covering
      // the whole cell (the image child is sized to the frame at fill time).
      const layout = (frame: { transform: Transform; size: { width: number; height: number }; children?: Node[] }, s: GridSpan, rr: number, cc: number) => {
        const box = gridCellBox(g.size, rr, cc, gap, s);
        frame.transform = { x: box.x, y: box.y, scaleX: 1, scaleY: 1, rotation: 0 };
        frame.size = { width: box.width, height: box.height };
        const img = frame.children?.length === 1 && frame.children[0].type === "image" ? (frame.children[0] as unknown as { transform: Transform; size: { width: number; height: number } }) : null;
        if (img) {
          img.transform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
          img.size = { width: box.width, height: box.height };
        }
      };
      if (r === g.rows && c === g.cols) {
        // Gap-only change: keep the existing cell list (including feature-layout
        // spans) and just re-lay every frame. Frames are mutated here, once;
        // the undo/redo closures only swap the arrays (before holds pre-change
        // clones), matching the rebuild path below.
        const byId = new Map(g.children.map((n) => [n.id, n]));
        for (const cell of g.cells) {
          const frame = cell.childId ? byId.get(cell.childId) : undefined;
          if (frame) layout(frame as never, cell, r, c);
        }
        const afterChildren = g.children;
        const afterCells = g.cells;
        perform(
          () => { g.gap = gap; g.cells = afterCells; g.children = afterChildren; },
          () => { g.gap = before.gap; g.cells = before.cells as never; g.children = before.children as never; },
        );
        return;
      }
      // Row/col change: rebuild a uniform layout, preserving existing cell
      // frames where the grid keeps that position; create fresh empty frames
      // for new cells; drop frames outside the new bounds.
      const old = g.children as Node[];
      const byPos = new Map<string, Node>();
      for (const cell of g.cells) if (cell.childId) { const ch = old.find((n) => n.id === cell.childId); if (ch) byPos.set(`${cell.row},${cell.col}`, ch); }
      const nextChildren: Node[] = [];
      const nextCells: typeof g.cells = [];
      const cellW = (g.size.width - gap * (c - 1)) / c;
      const cellH = (g.size.height - gap * (r - 1)) / r;
      for (let row = 0; row < r; row++) {
        for (let col = 0; col < c; col++) {
          const keep = byPos.get(`${row},${col}`) as unknown as { id: string; transform: Transform; size: { width: number; height: number }; children?: Node[] } | undefined;
          const frame = keep ?? (createNode("frame", {
            name: tr("app.photo"), transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: cellW, height: cellH }, clip: true, children: [], maskShape: "rect", fills: [{ type: "solid", color: { srgb: { r: 0.9, g: 0.91, b: 0.93, a: 1 } } }],
          } as Partial<Node>) as unknown as { id: string; transform: Transform; size: { width: number; height: number }; children?: Node[] });
          layout(frame, { row, col, rowSpan: 1, colSpan: 1 }, r, c);
          nextChildren.push(frame as unknown as Node);
          nextCells.push({ row, col, rowSpan: 1, colSpan: 1, childId: frame.id });
        }
      }
      perform(
        () => { g.rows = r; g.cols = c; g.gap = gap; g.cells = nextCells; g.children = nextChildren; },
        () => { g.rows = before.rows; g.cols = before.cols; g.gap = before.gap; g.cells = before.cells as never; g.children = before.children as never; },
      );
    },
    importPdfPages: (imported) => {
      if (!imported.length) return;
      const doc = get().doc;
      const made = imported.map((p, i) => {
        const seed = structuredClone(createBlankDesign({ width: Math.max(1, Math.round(p.width)), height: Math.max(1, Math.round(p.height)) }).pages[0]) as unknown as { id: string; name: string; children: Node[] };
        seed.name = `PDF page ${i + 1}`;
        seed.children = p.nodes;
        return seed;
      });
      const at = doc.pages.length;
      const prevPage = get().activePage;
      const prevSel = get().selection;
      perform(
        () => { doc.pages.push(...(made.map((m) => structuredClone(m)) as never[])); set({ activePage: at, selection: [] }); },
        () => { doc.pages.splice(at, made.length); set({ activePage: Math.min(prevPage, doc.pages.length - 1), selection: prevSel }); },
      );
    },
    applyTemplateFile: (file, title) => {
      // Same gate as setDocMeta: read-only (viewer/comment) sessions and the
      // read-only history preview must not mutate the document. The Templates
      // rail stays clickable during a preview, so this is load-bearing.
      if (!usePresence.getState().canEdit() || get().readonlyPreview()) return false;
      const pages = (file.pages ?? []) as Page[];
      if (!pages.length) return false;
      const doc = get().doc;
      ensureDocArrays(doc);
      // Fresh ids everywhere: the module counter used by paste could collide
      // with ids already persisted in this doc, and applying the same template
      // twice must never mint duplicates.
      const idGen = () => `n_${crypto.randomUUID().slice(0, 12)}`;
      // A template authored at a different size is resized to the ACTIVE
      // page's dimensions on insert (the same smart mapping as the design
      // resize feature), so applying any gallery template never creates a
      // mixed-size document.
      const cur = doc.pages[Math.min(get().activePage, Math.max(0, doc.pages.length - 1))];
      const target = cur && cur.width > 0 && cur.height > 0 ? { width: cur.width, height: cur.height } : null;
      const made = pages.map((p, i) => {
        const page = structuredClone(p) as Page & { name?: string; readingOrder?: string[] };
        page.id = `page_${crypto.randomUUID().slice(0, 12)}`;
        page.name = pages.length > 1 ? `${title} ${i + 1}` : title;
        const remapped = remapIds(structuredClone(p.children ?? []) as Node[], idGen);
        page.children = remapped.nodes as never[];
        // The authored screen-reader order references the ORIGINAL node ids;
        // carry it across the remap (dropping any id that no longer resolves)
        // or the appended page would silently fall back to z-order.
        if (Array.isArray(page.readingOrder)) {
          const ro = page.readingOrder
            .map((id) => remapped.idMap.get(id))
            .filter((id): id is string => !!id);
          if (ro.length) page.readingOrder = ro;
          else delete page.readingOrder;
        }
        if (
          target &&
          page.width > 0 &&
          page.height > 0 &&
          (Math.round(page.width) !== Math.round(target.width) || Math.round(page.height) !== Math.round(target.height))
        ) {
          return resizePage(page, target) as typeof page;
        }
        return page;
      });
      // Merge the template's asset refs (images render from doc.assets, which
      // re-registers on every rev); refs the doc already has are skipped so a
      // re-apply cannot duplicate them.
      const have = new Set(doc.assets.map((a) => a.id));
      const newAssets = structuredClone(((file.assets ?? []) as AssetRef[]).filter((a) => a?.id && !have.has(a.id)));
      // Uploaded custom fonts ride doc.fonts (data-URL refs so they load
      // cross-device); without the merge the appended text would render in a
      // fallback face everywhere but the template author's browser. Same
      // family dedupe as addDocFont.
      const docFonts = (doc as unknown as { fonts: FontRef[] }).fonts;
      const haveFamily = new Set(docFonts.map((f) => f.family.toLowerCase()));
      const newFonts = structuredClone(
        ((file.fonts ?? []) as FontRef[]).filter((f) => f?.family && !haveFamily.has(f.family.toLowerCase())),
      );
      const at = doc.pages.length;
      const prevPage = get().activePage;
      const prevSel = get().selection;
      perform(
        () => {
          doc.assets.push(...newAssets);
          docFonts.push(...newFonts);
          doc.pages.push(...(made.map((m) => structuredClone(m)) as never[]));
          set({ activePage: at, selection: [] });
        },
        () => {
          doc.pages.splice(at, made.length);
          for (const a of newAssets) {
            const i = doc.assets.findIndex((x) => x.id === a.id);
            if (i >= 0) doc.assets.splice(i, 1);
          }
          for (const f of newFonts) {
            const i = docFonts.findIndex((x) => x.id === f.id && x.family === f.family);
            if (i >= 0) docFonts.splice(i, 1);
          }
          set({ activePage: Math.min(prevPage, doc.pages.length - 1), selection: prevSel });
        },
      );
      return true;
    },
    importSvg: (svg) => {
      // Flatten group transforms first so positions/scales/rotations are correct.
      const { nodes, assets } = flattenSvgToNodes(svg);
      if (!nodes.length) return;
      // viewBox (or width/height) defines the source coordinate space.
      const vb = /viewBox\s*=\s*"([^"]+)"/i.exec(svg)?.[1]?.trim().split(/[\s,]+/).map(Number);
      const wAttr = parseFloat(/<svg[^>]*\bwidth\s*=\s*"([\d.]+)/i.exec(svg)?.[1] ?? "");
      const hAttr = parseFloat(/<svg[^>]*\bheight\s*=\s*"([\d.]+)/i.exec(svg)?.[1] ?? "");
      const minX = vb && vb.length === 4 ? vb[0] : 0;
      const minY = vb && vb.length === 4 ? vb[1] : 0;
      const vbW = (vb && vb.length === 4 ? vb[2] : wAttr) || 100;
      const vbH = (vb && vb.length === 4 ? vb[3] : hAttr) || 100;
      const page = get().doc.pages[curPageIndex()];
      // Fit within the page without upscaling, centered (keeps native size when it
      // already matches the page, e.g. a same-size export from another design tool).
      const scale = Math.min(page.width / vbW, page.height / vbH, 1);
      const gx = (page.width - vbW * scale) / 2 - minX * scale;
      const gy = (page.height - vbH * scale) / 2 - minY * scale;
      const doc = get().doc;
      ensureDocArrays(doc);
      const refs: AssetRef[] = assets.map((a) => ({ id: a.assetId, kind: "image", url: a.url, mime: "image/*", checksum: "" }));
      const group = createNode("group", {
        name: tr("app.imported_svg"),
        children: nodes,
        transform: { x: gx, y: gy, scaleX: scale, scaleY: scale, rotation: 0 },
        size: { width: vbW, height: vbH },
      } as Partial<Node>);
      const prev = get().selection;
      perform(
        () => { doc.assets.push(...refs); page.children.push(group); set({ selection: [group.id] }); },
        () => {
          const i = page.children.findIndex((n) => n.id === group.id);
          if (i >= 0) page.children.splice(i, 1);
          for (const r of refs) { const ai = doc.assets.findIndex((a) => a.id === r.id); if (ai >= 0) doc.assets.splice(ai, 1); }
          set({ selection: prev });
        },
      );
      // Load referenced image assets so they render (data URLs or remote urls).
      if (typeof window !== "undefined") for (const a of assets) imageAssets.register(a.assetId, a.url);
    },
    addImage: (url, at, provenance) => {
      const assetId = `asset-${crypto.randomUUID()}`;
      const node = createNode("image", {
        source: { assetId, naturalWidth: 0, naturalHeight: 0 },
        fit: "cover",
        transform: { x: 260, y: 260, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 320, height: 240 },
        // Stock provenance rides the node so CC-BY photos compile into the
        // design's credits, in the same undo step as the insert.
        ...(provenance ? { data: { provenance } } : {}),
      } as Partial<Node>);
      // Center on the drop point if given (drag-drop, already in the active
      // page's local space), else on the page under the viewport center.
      let pageIndex = curPageIndex();
      if (at) (node as unknown as { transform: Transform }).transform = { x: at.x - 160, y: at.y - 120, scaleX: 1, scaleY: 1, rotation: 0 };
      else pageIndex = positionInView(node);
      const doc = get().doc;
      ensureDocArrays(doc);
      const page = doc.pages[pageIndex];
      // checksum is a real content hash once ingested; placement does
      // not have the bytes, so leave it empty rather than faking it with the id.
      const ref: AssetRef = { id: assetId, kind: "image", url, mime: "image/*", checksum: "" };
      const prevSelection = get().selection;
      const prevActive = get().activePage;
      perform(
        () => {
          doc.assets.push(ref);
          page.children.push(node);
          set({ activePage: pageIndex, selection: [node.id] });
        },
        () => {
          const i = page.children.findIndex((n) => n.id === node.id);
          if (i >= 0) page.children.splice(i, 1);
          const ai = doc.assets.findIndex((a) => a.id === assetId);
          if (ai >= 0) doc.assets.splice(ai, 1);
          set({ activePage: prevActive, selection: prevSelection });
        },
      );

      // Patch the real natural dimensions and box aspect once the image loads,
      // so crop/fit/export-PPI math never divides by a 0x0 source.
      if (typeof window !== "undefined") {
        imageAssets.register(assetId, url);
        const off = imageAssets.onChange((changed) => {
          if (changed !== assetId) return;
          const status = imageAssets.status(assetId);
          if (status === "loading") return;
          const loc = locate(get().doc, node.id);
          const img = imageAssets.image(assetId) as { naturalWidth?: number; naturalHeight?: number } | null;
          if (loc && loc.node.type === "image" && status === "ready" && img?.naturalWidth) {
            const n = loc.node as unknown as {
              source: { naturalWidth: number; naturalHeight: number };
              size: { width: number; height: number };
            };
            n.source.naturalWidth = img.naturalWidth;
            n.source.naturalHeight = img.naturalHeight ?? n.size.height;
            // A node made the page background while its image was still loading
            // keeps its page-sized box: the aspect snap below would pull it off
            // the page. Stock photos load through the proxy (slow), so that
            // race is easy to hit; the natural size above is still patched.
            if ((loc.node.data as { background?: unknown } | undefined)?.background !== true) {
              const aspect = img.naturalWidth / (img.naturalHeight || img.naturalWidth);
              n.size = { width: n.size.width, height: Math.max(1, Math.round(n.size.width / aspect)) };
            }
            get().tick();
          }
          off(); // ready or missing: stop listening either way
        });
      }
    },

    applyGeneratedBackground: (pageId, url, prompt) => {
      const doc = get().doc;
      ensureDocArrays(doc);
      const page = doc.pages.find((p) => p.id === pageId);
      if (!page) return false; // design changed: a late resolution never lands elsewhere
      const assetId = `asset-${crypto.randomUUID()}`;
      const node = createNode("image", {
        name: tr("app.background"),
        source: { assetId, naturalWidth: 0, naturalHeight: 0 },
        fit: "cover",
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: page.width, height: page.height },
      } as Partial<Node>);
      node.data = { aiImagePrompt: prompt };
      const ref: AssetRef = { id: assetId, kind: "image", url, mime: "image/*", checksum: "" };
      // A retry or regeneration replaces the previous generated background
      // rather than stacking: remove any existing prompt-stamped background.
      const prevNode = page.children.find((n) => {
        const d = n.data as { aiImagePrompt?: string; placeholderId?: string } | undefined;
        // Only a previous generated BACKGROUND qualifies: a picture-slot image
        // also carries aiImagePrompt but belongs to its placeholder.
        return n.type === "image" && !!d?.aiImagePrompt && !d?.placeholderId;
      });
      const prevId = prevNode?.id;
      const prevSnapshot = prevNode ? structuredClone(prevNode) : null;
      perform(
        () => {
          const live = get().doc.pages.find((p) => p.id === pageId);
          if (!live) return;
          if (prevId) {
            const i = live.children.findIndex((n) => n.id === prevId);
            if (i >= 0) live.children.splice(i, 1);
          }
          get().doc.assets.push(ref);
          live.children.unshift(node); // back of the z-order, full bleed
        },
        () => {
          const live = get().doc.pages.find((p) => p.id === pageId);
          if (live) {
            const i = live.children.findIndex((n) => n.id === node.id);
            if (i >= 0) live.children.splice(i, 1);
            if (prevSnapshot) live.children.unshift(structuredClone(prevSnapshot));
          }
          const assets = get().doc.assets;
          const ai = assets.findIndex((a) => a.id === assetId);
          if (ai >= 0) assets.splice(ai, 1);
        },
      );
      // Patch the real natural dimensions once loaded so PPI/fit math is exact
      // (same idiom as addPageBackgroundImage: resolve via the LIVE doc).
      if (typeof window !== "undefined") {
        imageAssets.register(assetId, url);
        const off = imageAssets.onChange((changed) => {
          if (changed !== assetId) return;
          if (imageAssets.status(assetId) === "ready") {
            const img = imageAssets.image(assetId) as { naturalWidth?: number; naturalHeight?: number } | null;
            const loc = locate(get().doc, node.id);
            const n = loc?.node.type === "image" ? (loc.node as unknown as { source: { naturalWidth: number; naturalHeight: number } }) : undefined;
            if (img?.naturalWidth && n) {
              n.source.naturalWidth = img.naturalWidth;
              n.source.naturalHeight = img.naturalHeight ?? page.height;
              get().tick();
            }
          }
          off();
        });
      }
      return true;
    },
    addPageBackgroundImage: (url) => {
      const doc = get().doc;
      ensureDocArrays(doc);
      const page = doc.pages[curPageIndex()];
      if (!page) return;
      const pageId = page.id;
      const assetId = `asset-${crypto.randomUUID()}`;
      const node = createNode("image", {
        name: tr("app.background"),
        source: { assetId, naturalWidth: 0, naturalHeight: 0 },
        fit: "cover",
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: page.width, height: page.height },
      } as Partial<Node>);
      const ref: AssetRef = { id: assetId, kind: "image", url, mime: "image/*", checksum: "" };
      const prevSelection = get().selection;
      // Resolve the target page by id from the LIVE doc on each (re)apply, not by
      // closing over the page object: when this op shares a one-undo turn with a
      // page-replacing op (buildDeckFromOutline/appendDeckPages re-clone pages on
      // redo), a captured reference would be orphaned and the image would land in
      // a page no longer in the document.
      perform(
        () => {
          const live = get().doc.pages.find((p) => p.id === pageId);
          if (!live) return;
          get().doc.assets.push(ref);
          live.children.unshift(node); // back of the z-order
          set({ selection: [node.id] });
        },
        () => {
          const live = get().doc.pages.find((p) => p.id === pageId);
          if (live) {
            const i = live.children.findIndex((n) => n.id === node.id);
            if (i >= 0) live.children.splice(i, 1);
          }
          const assets = get().doc.assets;
          const ai = assets.findIndex((a) => a.id === assetId);
          if (ai >= 0) assets.splice(ai, 1);
          set({ selection: prevSelection });
        },
      );
      // Patch the real natural dimensions once loaded so PPI/fit math is exact;
      // the box stays at page size (full bleed).
      if (typeof window !== "undefined") {
        imageAssets.register(assetId, url);
        const off = imageAssets.onChange((changed) => {
          if (changed !== assetId) return;
          if (imageAssets.status(assetId) === "ready") {
            const img = imageAssets.image(assetId) as { naturalWidth?: number; naturalHeight?: number } | null;
            // Resolve via the LIVE doc (not the closed-over page) so the patch
            // lands even if the active page changed while the image loaded.
            const loc = locate(get().doc, node.id);
            const n = loc?.node.type === "image" ? (loc.node as unknown as { source: { naturalWidth: number; naturalHeight: number } }) : undefined;
            if (img?.naturalWidth && n) {
              n.source.naturalWidth = img.naturalWidth;
              n.source.naturalHeight = img.naturalHeight ?? page.height;
              get().tick();
            }
          }
          off();
        });
      }
    },

    /**
     * Attach an alpha mask WITHOUT touching the image.
     *
     * Background removal used to call `setImageSource` with the flattened
     * cutout, which threw the original pixels out of the document: the result
     * could not be meaningfully undone, and there was nothing left to refine.
     * Storing the alpha separately makes the cutout a view of the image rather
     * than a replacement for it.
     *
     * The mask is registered as an ordinary asset, so it travels the same
     * upload, storage and export path as any other. Passing null removes it,
     * which is what "restore background" is: one field cleared, no pixels
     * touched.
     */
    setImageAlphaMask: (id, url, width, height) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "image" || loc.node.locked || editBlocked(id)) return;
      const node = loc.node as unknown as { alphaMask?: { assetId: string; width: number; height: number } };
      const doc = get().doc;
      ensureDocArrays(doc);
      const before = node.alphaMask ? { ...node.alphaMask } : undefined;
      if (url === null) {
        perform(
          () => { delete node.alphaMask; },
          () => { if (before) node.alphaMask = { ...before }; },
        );
        return;
      }
      const assetId = `asset-${crypto.randomUUID()}`;
      const ref: AssetRef = { id: assetId, kind: "image", url, mime: "image/png", checksum: "" };
      perform(
        () => {
          doc.assets.push(ref);
          node.alphaMask = { assetId, width, height };
        },
        () => {
          const at = doc.assets.findIndex((a) => a.id === assetId);
          if (at >= 0) doc.assets.splice(at, 1);
          if (before) node.alphaMask = { ...before };
          else delete node.alphaMask;
        },
      );
    },
    setImageSource: (id, url) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "image" || loc.node.locked || editBlocked(id)) return;
      const node = loc.node as unknown as { source: { assetId: string; naturalWidth: number; naturalHeight: number }; crop?: CropRect };
      const doc = get().doc;
      ensureDocArrays(doc);
      const assetId = `asset-${crypto.randomUUID()}`;
      const ref: AssetRef = { id: assetId, kind: "image", url, mime: "image/*", checksum: "" };
      const beforeSource = { ...node.source };
      const beforeCrop = node.crop;
      perform(
        () => {
          doc.assets.push(ref);
          node.source = { assetId, naturalWidth: 0, naturalHeight: 0 };
          node.crop = undefined; // a new image invalidates the old crop
        },
        () => {
          const ai = doc.assets.findIndex((a) => a.id === assetId);
          if (ai >= 0) doc.assets.splice(ai, 1);
          node.source = beforeSource;
          node.crop = beforeCrop;
        },
      );
      // Patch the real natural size once the new image loads (keeps box width,
      // adjusts height to the new aspect) so crop/fit/PPI math stays valid.
      if (typeof window !== "undefined") {
        imageAssets.register(assetId, url);
        const off = imageAssets.onChange((changed) => {
          if (changed !== assetId) return;
          if (imageAssets.status(assetId) === "loading") return;
          const l = locate(get().doc, id);
          const img = imageAssets.image(assetId) as { naturalWidth?: number; naturalHeight?: number } | null;
          // Only patch if this node still points at the asset we set (the user
          // may have undone the replace before the image finished loading).
          const stillOurs = l?.node.type === "image" && (l.node as unknown as { source: { assetId: string } }).source.assetId === assetId;
          if (l && stillOurs && img?.naturalWidth) {
            const n = l.node as unknown as { source: { naturalWidth: number; naturalHeight: number }; size: { width: number; height: number } };
            n.source.naturalWidth = img.naturalWidth;
            n.source.naturalHeight = img.naturalHeight ?? n.size.height;
            // Keep a page background's page-sized box; see addImage above.
            if ((l.node.data as { background?: unknown } | undefined)?.background !== true) {
              const aspect = img.naturalWidth / (img.naturalHeight || img.naturalWidth);
              n.size = { width: n.size.width, height: Math.max(1, Math.round(n.size.width / aspect)) };
            }
            get().tick();
          }
          off();
        });
      }
    },
    outpaintImage: (id, url, width, height) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "image" || loc.node.locked || editBlocked(id)) return;
      const node = loc.node as unknown as {
        source: { assetId: string; naturalWidth: number; naturalHeight: number };
        crop?: CropRect;
        size: { width: number; height: number };
      };
      const doc = get().doc;
      ensureDocArrays(doc);
      const assetId = `asset-${crypto.randomUUID()}`;
      const ref: AssetRef = { id: assetId, kind: "image", url, mime: "image/png", checksum: "" };
      const beforeSource = { ...node.source };
      const beforeCrop = node.crop;
      const beforeSize = { ...node.size };
      const w = Math.max(1, Math.round(width));
      const h = Math.max(1, Math.round(height));
      // The padded result's pixel dimensions are known up front, so set the
      // natural size + box together (no async load patch). One undo step covers
      // the source swap and the box grow.
      perform(
        () => {
          doc.assets.push(ref);
          node.source = { assetId, naturalWidth: w, naturalHeight: h };
          node.crop = undefined;
          node.size = { width: w, height: h };
        },
        () => {
          const ai = doc.assets.findIndex((a) => a.id === assetId);
          if (ai >= 0) doc.assets.splice(ai, 1);
          node.source = beforeSource;
          node.crop = beforeCrop;
          node.size = beforeSize;
        },
      );
      if (typeof window !== "undefined") imageAssets.register(assetId, url);
    },
    setVideoProps: (id, patch) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "video" || loc.node.locked || editBlocked(id)) return;
      const n = loc.node as unknown as { trimStartMs?: number; trimEndMs?: number; volume: number; muted?: boolean; loop?: boolean };
      const before = { trimStartMs: n.trimStartMs, trimEndMs: n.trimEndMs, volume: n.volume, muted: n.muted, loop: n.loop };
      perform(
        () => {
          if (patch.trimStartMs != null) n.trimStartMs = Math.max(0, patch.trimStartMs);
          if (patch.trimEndMs != null) n.trimEndMs = Math.max(0, patch.trimEndMs);
          if (patch.volume != null) n.volume = Math.max(0, Math.min(1, patch.volume));
          if (patch.muted != null) n.muted = patch.muted;
          if (patch.loop != null) n.loop = patch.loop;
        },
        () => { n.trimStartMs = before.trimStartMs; n.trimEndMs = before.trimEndMs; n.volume = before.volume; n.muted = before.muted; n.loop = before.loop; },
      );
    },
    setQrValue: (id, value) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "qr") return;
      const node = loc.node as unknown as { value: string; ecLevel: "L" | "M" | "Q" | "H"; modules?: boolean[][] };
      const beforeV = node.value;
      const beforeM = node.modules;
      const modules = qrModules(value, node.ecLevel ?? "M");
      perform(
        () => { node.value = value; node.modules = modules; },
        () => { node.value = beforeV; node.modules = beforeM; },
      );
    },
    setQrLogo: (id, assetId, url) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "qr") return;
      const node = loc.node as unknown as { logoAssetId?: string; ecLevel?: "L" | "M" | "Q" | "H"; value?: string; modules?: boolean[][] };
      const doc = get().doc;
      ensureDocArrays(doc);
      const beforeLogo = node.logoAssetId;
      const beforeEc = node.ecLevel;
      const beforeM = node.modules;
      if (assetId) {
        // A center logo covers modules; bump error correction to "H" (30%) and
        // regenerate the matrix so the code stays scannable under the logo.
        const modules = qrModules(node.value ?? "", "H");
        const ref: AssetRef | null = url && !doc.assets.some((a) => a.id === assetId) ? { id: assetId, kind: "image", url, mime: "image/*", checksum: "" } : null;
        perform(
          () => { node.logoAssetId = assetId; node.ecLevel = "H"; node.modules = modules; if (ref) doc.assets.push(ref); },
          () => { node.logoAssetId = beforeLogo; node.ecLevel = beforeEc; node.modules = beforeM; if (ref) { const i = doc.assets.findIndex((a) => a.id === assetId); if (i >= 0) doc.assets.splice(i, 1); } },
        );
        if (url && typeof window !== "undefined") imageAssets.register(assetId, url);
      } else {
        perform(
          () => { node.logoAssetId = undefined; },
          () => { node.logoAssetId = beforeLogo; },
        );
      }
    },
    setQrLogoScale: (id, scale) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "qr") return;
      const node = loc.node as unknown as { logoScale?: number };
      const before = node.logoScale;
      const v = Math.min(0.4, Math.max(0.08, scale));
      perform(() => { node.logoScale = v; }, () => { node.logoScale = before; });
    },
    setFrameShape: (id, mask, radius) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "frame") return;
      const n = loc.node as unknown as { maskShape?: string; cornerRadius?: CornerRadius; clip?: boolean };
      const beforeMask = n.maskShape;
      const beforeR = n.cornerRadius;
      const r = Math.max(0, radius);
      perform(
        () => {
          n.clip = true;
          n.maskShape = mask;
          n.cornerRadius = mask === "ellipse" ? undefined : { topLeft: r, topRight: r, bottomRight: r, bottomLeft: r };
        },
        () => { n.maskShape = beforeMask; n.cornerRadius = beforeR; },
      );
    },
    convertToFrame: (id) => {
      const loc = locate(get().doc, id);
      if (!loc || (loc.node.type !== "shape" && loc.node.type !== "path")) return;
      const mask = frameMaskFor(loc.node);
      if (!mask) return;
      const src = loc.node as unknown as { transform: Transform; size: { width: number; height: number }; opacity?: number; fills?: Fill[]; name?: string };
      const frame = createNode("frame", {
        id, // keep the id so selection/undo stay anchored to it
        name: src.name ?? tr("app.frame"),
        transform: { ...src.transform },
        size: { ...src.size },
        opacity: src.opacity ?? 1,
        fills: src.fills && src.fills.length ? src.fills : [{ type: "solid", color: { srgb: { r: 0.9, g: 0.91, b: 0.93, a: 1 } } }],
        clip: true,
        children: [],
        maskShape: mask.maskShape,
        ...(mask.maskPath ? { maskPath: mask.maskPath } : {}),
        ...(mask.cornerRadius ? { cornerRadius: mask.cornerRadius } : {}),
      } as Partial<Node>);
      const arr = loc.siblings;
      const idx = loc.index;
      const before = arr[idx];
      perform(
        () => { arr[idx] = frame; },
        () => { arr[idx] = before; },
      );
    },
    setImageFill: (id, url) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "shape" || loc.node.locked || editBlocked(id)) return;
      const node = loc.node as unknown as { fills?: Fill[] };
      const doc = get().doc;
      ensureDocArrays(doc);
      const before = node.fills;
      if (!url.trim()) {
        // Clear the image fill back to a neutral solid.
        perform(
          () => { node.fills = [{ type: "solid", color: { srgb: { r: 0.85, g: 0.86, b: 0.88, a: 1 } } }] as Fill[]; },
          () => { node.fills = before; },
        );
        return;
      }
      const assetId = `asset-${crypto.randomUUID()}`;
      const ref: AssetRef = { id: assetId, kind: "image", url, mime: "image/*", checksum: "" };
      const fill = { type: "image", source: { assetId, naturalWidth: 0, naturalHeight: 0 }, fit: "cover" } as unknown as Fill;
      perform(
        () => { doc.assets.push(ref); node.fills = [fill]; },
        () => { node.fills = before; const ai = doc.assets.findIndex((a) => a.id === assetId); if (ai >= 0) doc.assets.splice(ai, 1); },
      );
      // Register the asset; once it loads, patch the fill's natural size (the
      // crop overlay needs real dimensions) and repaint.
      if (typeof window !== "undefined") {
        imageAssets.register(assetId, url);
        const off = imageAssets.onChange((changed) => {
          if (changed !== assetId) return;
          if (imageAssets.status(assetId) === "loading") return;
          const img = imageAssets.image(assetId) as { naturalWidth?: number; naturalHeight?: number } | null;
          const l = locate(get().doc, id);
          const f = l?.node.type === "shape" ? (l.node as unknown as { fills?: Fill[] }).fills?.[0] : undefined;
          if (f?.type === "image" && img?.naturalWidth) {
            const src = (f as unknown as { source: { assetId: string; naturalWidth: number; naturalHeight: number } }).source;
            if (src.assetId === assetId) {
              src.naturalWidth = img.naturalWidth;
              src.naturalHeight = img.naturalHeight ?? img.naturalWidth;
            }
          }
          get().tick();
          off();
        });
      }
    },
    setPatternFill: (id, url, opts) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "shape" || loc.node.locked || editBlocked(id)) return;
      const node = loc.node as unknown as { fills?: Fill[] };
      const doc = get().doc;
      ensureDocArrays(doc);
      const before = node.fills;
      if (!url.trim()) {
        perform(
          () => { node.fills = [{ type: "solid", color: { srgb: { r: 0.85, g: 0.86, b: 0.88, a: 1 } } }] as Fill[]; },
          () => { node.fills = before; },
        );
        return;
      }
      const assetId = `asset-${crypto.randomUUID()}`;
      const ref: AssetRef = { id: assetId, kind: "image", url, mime: "image/*", checksum: "" };
      const fill = { type: "pattern", assetId, scale: opts?.scale ?? 1, rotation: opts?.rotation ?? 0, repeat: opts?.repeat ?? "tile" } as unknown as Fill;
      perform(
        () => { doc.assets.push(ref); node.fills = [fill]; },
        () => { node.fills = before; const ai = doc.assets.findIndex((a) => a.id === assetId); if (ai >= 0) doc.assets.splice(ai, 1); },
      );
      if (typeof window !== "undefined") {
        imageAssets.register(assetId, url);
        const off = imageAssets.onChange((changed) => {
          if (changed !== assetId) return;
          if (imageAssets.status(assetId) === "loading") return;
          get().tick();
          off();
        });
      }
    },
    setPatternParams: (id, patch) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "shape" || loc.node.locked || editBlocked(id)) return;
      const node = loc.node as unknown as { fills?: Fill[] };
      const cur = node.fills?.[0] as unknown as { type: string; scale: number; rotation?: number; repeat: string } | undefined;
      if (!cur || cur.type !== "pattern") return;
      const before = { scale: cur.scale, rotation: cur.rotation, repeat: cur.repeat };
      perform(
        () => { if (patch.scale != null) cur.scale = patch.scale; if (patch.rotation != null) cur.rotation = patch.rotation; if (patch.repeat != null) cur.repeat = patch.repeat; },
        () => { cur.scale = before.scale; cur.rotation = before.rotation; cur.repeat = before.repeat; },
      );
    },
    setFrameImage: (id, url, provenance) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "frame" || loc.node.locked || editBlocked(id)) return;
      const frame = loc.node as unknown as { size: { width: number; height: number }; children: Node[]; clip?: boolean };
      const doc = get().doc;
      ensureDocArrays(doc);
      const assetId = `asset-${crypto.randomUUID()}`;
      const ref: AssetRef = { id: assetId, kind: "image", url, mime: "image/*", checksum: "" };
      const child = createNode("image", {
        source: { assetId, naturalWidth: 0, naturalHeight: 0 },
        fit: "cover",
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: frame.size.width, height: frame.size.height },
        // Same stamp as addImage: the credit follows the image into the frame.
        ...(provenance ? { data: { provenance } } : {}),
      } as Partial<Node>);
      const before = frame.children;
      perform(
        () => { doc.assets.push(ref); frame.children = [child]; frame.clip = true; },
        () => {
          frame.children = before;
          const ai = doc.assets.findIndex((a) => a.id === assetId);
          if (ai >= 0) doc.assets.splice(ai, 1);
        },
      );
      // Patch the child's natural size once loaded so "cover" fills the frame.
      if (typeof window !== "undefined") {
        imageAssets.register(assetId, url);
        const off = imageAssets.onChange((changed) => {
          if (changed !== assetId) return;
          if (imageAssets.status(assetId) === "loading") return;
          const img = imageAssets.image(assetId) as { naturalWidth?: number; naturalHeight?: number } | null;
          const l = locate(get().doc, child.id);
          if (l && l.node.type === "image" && img?.naturalWidth) {
            const n = l.node as unknown as { source: { naturalWidth: number; naturalHeight: number } };
            n.source.naturalWidth = img.naturalWidth;
            n.source.naturalHeight = img.naturalHeight ?? img.naturalWidth;
            get().tick();
          }
          off();
        });
      }
    },
    fillWithImageNode: (targetId, kind, imageId, restoreTransform) => {
      const doc = get().doc;
      const imgLoc = locate(doc, imageId);
      const tLoc = locate(doc, targetId);
      if (!imgLoc || !tLoc || imgLoc.node.type !== "image") return false;
      if (imgLoc.node.locked || editBlocked(imageId)) return false;
      if (tLoc.node.locked || editBlocked(targetId)) return false;
      if (kind === "frame" ? tLoc.node.type !== "frame" : tLoc.node.type !== "shape") return false;
      const img = imgLoc.node as unknown as { source: { assetId: string; naturalWidth: number; naturalHeight: number }; data?: Record<string, unknown> };
      // The asset ref already lives in doc.assets (added when the image was
      // placed) and stays there, exactly like deleting the node would leave it;
      // the fill just references the same assetId.
      const siblings = imgLoc.siblings;
      const removeIndex = imgLoc.index;
      const removed = imgLoc.node;
      const prevTransform = removed.transform;
      const prevSelection = get().selection;
      const takeOut = () => {
        const i = siblings.indexOf(removed);
        if (i >= 0) siblings.splice(i, 1);
        set({ selection: [targetId] });
      };
      const putBack = () => {
        removed.transform = restoreTransform ? { ...restoreTransform } : prevTransform;
        siblings.splice(Math.min(removeIndex, siblings.length), 0, removed);
        set({ selection: prevSelection });
      };
      if (kind === "frame") {
        const frame = tLoc.node as unknown as { size: { width: number; height: number }; children: Node[]; clip?: boolean };
        const beforeChildren = frame.children;
        const beforeClip = frame.clip;
        const child = createNode("image", {
          source: { ...img.source },
          fit: "cover",
          transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
          size: { width: frame.size.width, height: frame.size.height },
          // The credit follows the image into the frame, like drop-to-fill.
          ...(img.data?.provenance ? { data: { provenance: img.data.provenance } } : {}),
        } as Partial<Node>);
        perform(
          () => { takeOut(); frame.children = [child]; frame.clip = true; },
          () => { frame.children = beforeChildren; frame.clip = beforeClip; putBack(); },
        );
      } else {
        const shape = tLoc.node as unknown as { fills?: Fill[] };
        const beforeFills = shape.fills;
        const fill = { type: "image", source: { ...img.source }, fit: "cover" } as unknown as Fill;
        perform(
          () => { takeOut(); shape.fills = [fill]; },
          () => { shape.fills = beforeFills; putBack(); },
        );
      }
      return true;
    },

    isBackgroundImage: (id) => {
      const doc = get().doc;
      const loc = locate(doc, id);
      // Background status always requires the lock: unlocking a background
      // (panel/menu lock toggle) suspends it, so the freed image acts like a
      // plain element again and "Set as background" reappears. The flag stays
      // on the node, so re-setting it keeps the original pre-background state.
      if (!loc || loc.node.type !== "image" || loc.parent || !loc.node.locked) return false;
      if ((loc.node.data as { background?: unknown } | undefined)?.background === true) return true;
      // Hand-built background (no flag): a locked, bottom-of-stack image
      // covering the whole page, i.e. what "set as background" produces when
      // done by hand. Detach then simply unlocks it.
      if (loc.index !== 0) return false;
      const box = worldAABB(doc, id);
      const eps = 1;
      return (
        !!box &&
        box.x <= eps &&
        box.y <= eps &&
        box.x + box.width >= loc.page.width - eps &&
        box.y + box.height >= loc.page.height - eps
      );
    },

    setImageAsBackground: (id) => {
      const doc = get().doc;
      const loc = locate(doc, id);
      if (!loc || loc.node.type !== "image" || loc.parent || editBlocked(id)) return;
      if (get().isBackgroundImage(id)) return;
      const node = loc.node;
      const page = loc.page;
      if (node.size.width <= 0 || node.size.height <= 0 || page.width <= 0 || page.height <= 0) return;
      // The background is a PAGE-SIZED box at scale 1 with the source covering
      // it (fit "cover"), not a scaled-up transform: that is how every other
      // image box is modeled, and it is the shape the crop overlay requires,
      // so the background stays adjustable (pan/zoom via crop) while locked.
      // A negative scale (flip) keeps its sign so the background stays
      // mirrored; the box still spans the page exactly.
      const sx = node.transform.scaleX < 0 ? -1 : 1;
      const sy = node.transform.scaleY < 0 ? -1 : 1;
      const cover: Transform = {
        x: sx < 0 ? page.width : 0,
        y: sy < 0 ? page.height : 0,
        scaleX: sx,
        scaleY: sy,
        rotation: 0,
      };
      const img = node as unknown as { fit: ImageFit };
      const prevTransform = { ...node.transform };
      const prevSize = { ...node.size };
      const prevFit = img.fit;
      const prevIndex = loc.index;
      const prevLocked = !!node.locked;
      const prevData = node.data;
      // Re-setting a still-flagged image (its background status was suspended
      // by an unlock, never detached) keeps the ORIGINAL pre-background state,
      // so a later detach restores the true pre-background spot instead of the
      // suspended cover box.
      const dataRec = prevData as { background?: unknown; backgroundRestore?: unknown } | undefined;
      const keptRestore =
        dataRec?.background === true && typeof dataRec.backgroundRestore === "object" && dataRec.backgroundRestore !== null
          ? dataRec.backgroundRestore
          : null;
      // The image currently serving as this page's background is detached in
      // the same undo step; otherwise it would sit full-page directly above
      // the new background and hide it. A stale-flagged bottom image (its
      // background suspended by an unlock) is cleaned up the same way.
      const bottom = page.children[0];
      const oldBg =
        bottom &&
        bottom.id !== id &&
        bottom.type === "image" &&
        (get().isBackgroundImage(bottom.id) || (bottom.data as { background?: unknown } | undefined)?.background === true)
          ? bottom
          : null;
      const oldBgPrev = oldBg
        ? {
            locked: !!oldBg.locked,
            data: oldBg.data,
            transform: { ...oldBg.transform },
            size: { ...oldBg.size },
            fit: (oldBg as unknown as { fit: ImageFit }).fit,
          }
        : null;
      perform(
        () => {
          if (oldBg) applyBackgroundDetach(oldBg, page);
          const i = page.children.indexOf(node);
          if (i > 0) {
            page.children.splice(i, 1);
            page.children.unshift(node);
          }
          node.transform = { ...cover };
          node.size = { width: page.width, height: page.height };
          img.fit = "cover";
          node.locked = true;
          node.data = {
            ...(prevData ?? {}),
            background: true,
            backgroundRestore: keptRestore ?? { transform: prevTransform, size: prevSize, fit: prevFit, index: prevIndex },
          };
        },
        () => {
          // Re-bottom the old background FIRST: prevIndex was measured while it
          // sat at index 0, so the new node's slot is only correct after it is back.
          if (oldBg && oldBgPrev) {
            oldBg.locked = oldBgPrev.locked;
            oldBg.data = oldBgPrev.data;
            oldBg.transform = oldBgPrev.transform;
            oldBg.size = oldBgPrev.size;
            (oldBg as unknown as { fit: ImageFit }).fit = oldBgPrev.fit;
            const j = page.children.indexOf(oldBg);
            if (j > 0) {
              page.children.splice(j, 1);
              page.children.unshift(oldBg);
            }
          }
          node.data = prevData;
          node.locked = prevLocked;
          node.transform = { ...prevTransform };
          node.size = { ...prevSize };
          img.fit = prevFit;
          const i = page.children.indexOf(node);
          if (i >= 0) page.children.splice(i, 1);
          page.children.splice(Math.min(prevIndex, page.children.length), 0, node);
        },
      );
    },

    detachImageBackground: (id) => {
      const doc = get().doc;
      const loc = locate(doc, id);
      if (!loc || loc.node.type !== "image" || loc.parent || editBlocked(id)) return;
      if (!get().isBackgroundImage(id)) return;
      const node = loc.node;
      const page = loc.page;
      const prevLocked = !!node.locked;
      const prevData = node.data;
      const prevTransform = { ...node.transform };
      const prevSize = { ...node.size };
      const prevFit = (node as unknown as { fit: ImageFit }).fit;
      const prevIndex = loc.index;
      perform(
        () => {
          applyBackgroundDetach(node, page);
        },
        () => {
          node.locked = prevLocked;
          node.data = prevData;
          node.transform = { ...prevTransform };
          node.size = { ...prevSize };
          (node as unknown as { fit: ImageFit }).fit = prevFit;
          const i = page.children.indexOf(node);
          if (i >= 0) page.children.splice(i, 1);
          page.children.splice(Math.min(prevIndex, page.children.length), 0, node);
        },
      );
    },
    setFillColor: (id, hex) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.locked || editBlocked(id)) return;
      const node = loc.node;
      const fill = { type: "solid", color: hexToColor(hex) } as unknown as Fill;

      if (node.type === "text") {
        // Text has no node-level fills; color is per-run (style.fill). Recolor
        // every run, snapshotting each run's prior fill for undo.
        const paras = (node as unknown as { content: { runs: { style: { fill?: Fill } }[] }[] }).content;
        const before = paras.map((p) => p.runs.map((r) => r.style.fill));
        perform(
          () => {
            paras.forEach((p) => p.runs.forEach((r) => (r.style.fill = fill)));
          },
          () => {
            paras.forEach((p, pi) => p.runs.forEach((r, ri) => (r.style.fill = before[pi][ri])));
          },
        );
        return;
      }

      // Only nodes whose schema has a `fills` array get a node-level fill.
      if (!FILL_CAPABLE.has(node.type)) return;
      const rec = node as unknown as { fills?: Fill[] };
      const before = rec.fills;
      const after = [fill];
      perform(
        () => {
          rec.fills = after;
        },
        () => {
          rec.fills = before;
        },
      );
    },

    collectDeckTexts: () => {
      const { doc } = get();
      const out: DeckTextEntry[] = [];
      const walk = (nodes: Node[]) => {
        for (const n of nodes) {
          if (n.locked) continue; // a locked subtree is not editable; skip whole branch
          if (n.type === "text") {
            const paras = (n as unknown as { content?: { runs?: { text?: string }[] }[] }).content ?? [];
            paras.forEach((p, pi) =>
              (p.runs ?? []).forEach((r, ri) => {
                if (typeof r.text === "string" && r.text.trim()) {
                  out.push({ ref: { kind: "run", nodeId: n.id, para: pi, run: ri }, text: r.text });
                }
              }),
            );
          } else if (n.type === "sticky") {
            const t = (n as unknown as { text?: string }).text;
            if (typeof t === "string" && t.trim()) out.push({ ref: { kind: "sticky", nodeId: n.id }, text: t });
          }
          const kids = (n as unknown as { children?: Node[] }).children;
          if (kids?.length) walk(kids);
        }
      };
      doc.pages.forEach((pg, i) => {
        walk(pg.children as Node[]);
        const notes = (pg as unknown as { notes?: string }).notes;
        if (typeof notes === "string" && notes.trim()) out.push({ ref: { kind: "notes", page: i }, text: notes });
      });
      return out;
    },

    applyDeckTexts: (entries) => {
      const { doc } = get();
      // Resolve every target up front and snapshot its prior value; the whole
      // batch then applies (and reverts) as ONE undo step. Refs that no longer
      // resolve (node deleted since collection, run gone after an edit) are
      // skipped rather than failing the batch.
      const changes: { apply: () => void; revert: () => void }[] = [];
      // Text nodes whose runs get replaced, each with its pre-batch height:
      // translations routinely run longer than the source and rewrap, so every
      // touched auto-height box is re-fitted after the batch (and its height
      // reverts with it).
      const touchedText = new Map<string, { node: Node; h: number; bh: number }>();
      for (const e of entries) {
        const next = e.text;
        if (typeof next !== "string") continue;
        if (e.ref.kind === "notes") {
          const pg = doc.pages[e.ref.page] as unknown as { notes?: string } | undefined;
          if (!pg) continue;
          const before = pg.notes;
          changes.push({ apply: () => { pg.notes = next; }, revert: () => { pg.notes = before; } });
        } else {
          const loc = locate(doc, e.ref.nodeId);
          if (!loc || loc.node.locked || editBlocked(e.ref.nodeId)) continue;
          if (e.ref.kind === "sticky" && loc.node.type === "sticky") {
            const rec = loc.node as unknown as { text?: string };
            const before = rec.text;
            changes.push({ apply: () => { rec.text = next; }, revert: () => { rec.text = before; } });
          } else if (e.ref.kind === "run" && loc.node.type === "text") {
            const paras = (loc.node as unknown as { content?: { runs?: { text?: string }[] }[] }).content;
            const run = paras?.[e.ref.para]?.runs?.[e.ref.run];
            if (!run || typeof run.text !== "string") continue;
            const before = run.text;
            changes.push({ apply: () => { run.text = next; }, revert: () => { run.text = before; } });
            if (!touchedText.has(e.ref.nodeId)) {
              // Defensive reads: schema guarantees size+box on text nodes, but
              // this must not be the line that fails an otherwise valid batch.
              const sized = loc.node as unknown as { size?: { height: number }; box?: { height: number } };
              touchedText.set(e.ref.nodeId, { node: loc.node, h: sized.size?.height ?? 0, bh: sized.box?.height ?? sized.size?.height ?? 0 });
            }
          }
        }
      }
      if (!changes.length) return;
      perform(
        () => {
          for (const c of changes) c.apply();
          for (const t of touchedText.values()) refitTextHeight(t.node);
        },
        () => {
          for (const c of [...changes].reverse()) c.revert();
          for (const t of touchedText.values()) {
            const sized = t.node as unknown as { size?: { height: number }; box?: { height: number } };
            if (sized.size) sized.size.height = t.h;
            if (sized.box) sized.box.height = t.bh;
          }
        },
      );
    },

    setText: (id, text) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "text" || loc.node.locked || editBlocked(id)) return;
      const node = loc.node as unknown as {
        content: { runs: { text: string; style: unknown }[]; style: unknown }[];
      };
      const old = node.content;
      const firstStyle = old[0]?.runs?.[0]?.style;
      if (!firstStyle) return; // no run to inherit style from; never write a styleless run
      const before = structuredClone(old);
      // Each text line becomes its own paragraph, inheriting that paragraph's
      // prior style where it existed (else the first paragraph's). Styles are
      // cloned per paragraph/run so later per-paragraph edits don't alias.
      const lines = text.split("\n");
      const after = lines.map((line, i) => ({
        runs: [{ text: line, style: structuredClone(old[i]?.runs?.[0]?.style ?? firstStyle) }],
        style: structuredClone(old[i]?.style ?? old[0].style),
      }));
      const sized = loc.node as unknown as { size: { height: number }; box: { height: number } };
      const hBefore = sized.size.height;
      const boxHBefore = sized.box.height;
      perform(
        () => {
          node.content = after;
          // New text wraps to a different line count; keep the box on it.
          refitTextHeight(loc.node);
        },
        () => {
          node.content = structuredClone(before);
          sized.size.height = hBefore;
          sized.box.height = boxHBefore;
        },
      );
    },

    setStickyText: (id, text, fontScale) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "sticky" || loc.node.locked || editBlocked(id)) return;
      const node = loc.node as unknown as { text: string; fontScale: number };
      const beforeText = node.text;
      const beforeScale = node.fontScale;
      const nextScale = fontScale ?? beforeScale;
      perform(
        () => {
          node.text = text;
          node.fontScale = nextScale;
        },
        () => {
          node.text = beforeText;
          node.fontScale = beforeScale;
        },
      );
    },
    findReplace: (find, replace) => {
      if (!find || find === replace) return 0; // nothing to do (avoid a no-op undo step)
      const doc = get().doc;
      type TextLike = { type: string; content?: { runs: { text: string }[] }[]; children?: TextLike[] };
      const texts: TextLike[] = [];
      const walk = (nodes: TextLike[] | undefined) => {
        for (const n of nodes ?? []) {
          if (n.type === "text" && n.content) texts.push(n);
          if (n.children) walk(n.children);
        }
      };
      for (const p of doc.pages) walk(p.children as unknown as TextLike[]);
      const changed = texts.filter((n) => n.content!.some((p) => p.runs.some((r) => r.text.includes(find))));
      if (!changed.length) return 0;
      const before = changed.map((n) => structuredClone(n.content));
      const after = changed.map((n) =>
        n.content!.map((p) => ({ ...p, runs: p.runs.map((r) => ({ ...r, text: r.text.split(find).join(replace) })) })),
      );
      // Replaced text wraps differently; re-fit each auto-height box with the
      // swap and take the heights back on undo.
      const heights = changed.map((n) => {
        const s = n as unknown as { size: { height: number }; box?: { height: number } };
        return { h: s.size.height, bh: s.box?.height ?? s.size.height };
      });
      perform(
        () => changed.forEach((n, i) => {
          n.content = structuredClone(after[i]) as never;
          refitTextHeight(n as unknown as Node);
        }),
        () => changed.forEach((n, i) => {
          n.content = structuredClone(before[i]) as never;
          const s = n as unknown as { size: { height: number }; box?: { height: number } };
          s.size.height = heights[i].h;
          if (s.box) s.box.height = heights[i].bh;
        }),
      );
      return changed.length;
    },
    reskinToBrand: (brand, overrides) => {
      const doc = get().doc;
      const colors: ReskinColorMap[] = [];
      const fonts: ReskinFontMap[] = [];
      const colorSeen = new Set<string>();
      const fontSeen = new Set<string>();
      const lcFonts = brand.fonts.map((f) => f.toLowerCase());
      // Normalize override keys to lowercase hex so lookups are case-insensitive.
      const ov: ReskinOverrides = {};
      for (const [k, v] of Object.entries(overrides ?? {})) ov[k.toLowerCase()] = v;

      // Map one color to its target: an explicit override (a chosen brand hex, or
      // "keep" to leave it) when present, else its nearest brand color. Records
      // the mapping once per distinct source color. Returns the replacement, or
      // null when the color stays - the caller mutates IN PLACE only on a real
      // change, so page/node/fill identity survives (other undo entries hold
      // references into these objects).
      let pageChanged = false; // per page, reset in the page loop below
      const mapColor = (c: Color | undefined): Color | null => {
        if (!c || brand.palette.length === 0) return null;
        const from = toHex(c);
        const override = ov[from.toLowerCase()];
        let to: string;
        if (override !== undefined) {
          if (override === "keep") return null; // user chose to keep the original
          to = override;
        } else {
          const m = nearestPaletteColor(c, brand.palette);
          if (!m) return null;
          to = toHex(m.color);
        }
        if (from !== to && !colorSeen.has(from)) {
          colorSeen.add(from);
          colors.push({ from, to });
        }
        if (from === to) return null;
        const toColor = fromHex(to);
        if (!toColor) return null; // malformed override hex: leave the color untouched
        pageChanged = true;
        // Preserve the original alpha so a re-skin never makes a color opaque.
        return { srgb: { ...toColor.srgb, a: c.srgb.a } };
      };
      // Remap a fill's colors IN PLACE (object identity preserved).
      const mapFillInPlace = (fill: Fill | undefined): void => {
        if (!fill) return;
        const f = fill as unknown as { type?: string; color?: Color; stops?: { color: Color }[] };
        if (f.type === "solid" && f.color) {
          const to = mapColor(f.color);
          if (to) f.color = to;
        } else if (Array.isArray(f.stops)) {
          for (const stop of f.stops) {
            const to = mapColor(stop.color);
            if (to) stop.color = to;
          }
        }
      };
      // Map a font family to the kit's first font (heading/body convention).
      const mapFont = (fam: string | undefined): string | undefined => {
        if (!fam || brand.fonts.length === 0) return fam;
        if (lcFonts.includes(fam.toLowerCase())) return fam; // already on-brand
        const to = brand.fonts[0];
        if (!fontSeen.has(fam)) {
          fontSeen.add(fam);
          fonts.push({ from: fam, to });
        }
        return to;
      };

      // Mutate a node tree in place: fills, stroke, and text run color/font.
      const applyNode = (n: Node) => {
        if (n.locked || editBlocked(n.id)) return; // never restyle a locked node or a brand locked region
        const rec = n as unknown as {
          fills?: Fill[];
          stroke?: { fill?: Fill; color?: Color };
          content?: { runs: { style: { fill?: Fill; color?: Color; fontFamily?: string } }[] }[];
          children?: Node[];
        };
        for (const f of rec.fills ?? []) mapFillInPlace(f);
        if (rec.stroke) {
          mapFillInPlace(rec.stroke.fill);
          if (rec.stroke.color) {
            const to = mapColor(rec.stroke.color);
            if (to) rec.stroke.color = to;
          }
        }
        let fontChanged = false;
        for (const para of rec.content ?? [])
          for (const run of para.runs) {
            mapFillInPlace(run.style.fill);
            if (run.style.color) {
              const to = mapColor(run.style.color);
              if (to) run.style.color = to;
            }
            const swapped = mapFont(run.style.fontFamily);
            if (swapped !== run.style.fontFamily) {
              fontChanged = true;
              pageChanged = true;
              run.style.fontFamily = swapped;
            }
          }
        // A swapped family wraps differently; keep the box on the text. Only
        // when a font actually changed, so a color-only re-skin can't fold
        // unrelated height corrections into its undo step.
        if (fontChanged) refitTextHeight(n);
        for (const kid of rec.children ?? []) applyNode(kid);
      };

      // One undo step built from per-page diffs. Mutation is strictly in place
      // (nothing changed = nothing touched, no identity churn to revert), and
      // undo/redo restore snapshots BY PAGE ID into the existing page objects,
      // never replacing them with clones - the old whole-array clone swap
      // detached every page reference other undo entries had captured, so a
      // neighboring entry's undo/redo mutated dead objects.
      const pageDiffs: { id: string; before: Page; after: Page }[] = [];
      for (const page of doc.pages) {
        const beforeSnap = structuredClone(page);
        pageChanged = false;
        const pg = page as unknown as { background?: Fill };
        mapFillInPlace(pg.background);
        for (const n of page.children) applyNode(n);
        if (pageChanged) pageDiffs.push({ id: page.id, before: beforeSnap, after: structuredClone(page) });
      }
      if (pageDiffs.length === 0) {
        // Nothing was actually mutated (either nothing mapped, or the only
        // recorded mapping was a malformed override that could not apply);
        // skip the undo entry so the history holds no dead step.
        return { colors, fonts };
      }
      // The pages are ALREADY in their after state; the first forward run must
      // not re-clone them, only redo does.
      let firstRun = true;
      perform(
        () => {
          if (!firstRun) for (const d of pageDiffs) restorePageSnapshot(d.id, d.after);
          firstRun = false;
        },
        () => {
          for (const d of pageDiffs) restorePageSnapshot(d.id, d.before);
        },
      );
      // Preload any brand fonts now in use so the canvas reflows to them.
      return { colors, fonts };
    },
    applyBrandFixes: (fixes) => {
      const doc = get().doc;
      // Snapshot every distinct target node's full state once (before), mutate it
      // in place for each fix, then register the whole batch as ONE undo step.
      const before = new Map<string, Node>();
      let applied = 0;

      const snapshot = (id: string): Node | null => {
        const loc = locate(doc, id);
        if (!loc) return null;
        if (!before.has(id)) before.set(id, structuredClone(loc.node));
        return loc.node;
      };

      for (const { nodeId, fix } of fixes) {
        if (!nodeId || fix.kind === "restore_logo") continue; // no auto-fix for logos
        const node = snapshot(nodeId);
        if (!node) continue;

        if (fix.kind === "snap_color") {
          const target: Fill = { type: "solid", color: fix.to };
          if (node.type === "text") {
            const paras = (node as unknown as { content: { runs: { style: { fill?: Fill } }[] }[] }).content;
            paras.forEach((p) => p.runs.forEach((r) => (r.style.fill = target)));
          } else {
            const rec = node as unknown as { fills?: Fill[]; stroke?: { fill?: Fill } };
            // Recolor whichever channel carried the off-brand color; default to fill.
            const strokeHexMatches =
              rec.stroke?.fill && rec.stroke.fill.type === "solid"
                ? toHex((rec.stroke.fill as unknown as { color: Color }).color) === fix.from
                : false;
            if (strokeHexMatches && rec.stroke) rec.stroke.fill = target;
            else rec.fills = [target];
          }
          applied++;
        } else if (fix.kind === "swap_font") {
          if (node.type !== "text") continue;
          const paras = (node as unknown as { content: { runs: { style: { fontFamily?: string } }[] }[] }).content;
          paras.forEach((p) => p.runs.forEach((r) => (r.style.fontFamily = fix.to)));
          // The brand font wraps differently than the off-brand one; the
          // per-node before/after snapshots capture the height with the swap.
          refitTextHeight(node);
          applied++;
        } else if (fix.kind === "fix_contrast") {
          if (node.type !== "text") continue;
          const target: Fill = { type: "solid", color: fix.color };
          const paras = (node as unknown as { content: { runs: { style: { fill?: Fill } }[] }[] }).content;
          paras.forEach((p) => p.runs.forEach((r) => (r.style.fill = target)));
          applied++;
        }
      }

      if (applied === 0) return 0;
      const after = new Map<string, Node>();
      for (const id of before.keys()) {
        const loc = locate(doc, id);
        if (loc) after.set(id, structuredClone(loc.node));
      }
      // Write a snapshot back onto a live node, preserving its identity (mutate in
      // place so selection/refs survive undo/redo).
      const restore = (snaps: Map<string, Node>) => {
        const d = get().doc;
        for (const [id, snap] of snaps) {
          const loc = locate(d, id);
          if (!loc) continue;
          const live = loc.node as unknown as Record<string, unknown>;
          const src = snap as unknown as Record<string, unknown>;
          // size + box travel with the snapshot because a swap_font fix re-fits
          // an auto-height box; without them undo restores the font but leaves
          // the re-fitted height behind.
          for (const k of ["fills", "stroke", "content", "size", "box"]) {
            if (k in src) live[k] = structuredClone(src[k]);
            else delete live[k];
          }
        }
      };
      set((s) => ({
        rev: s.rev + 1,
        undoStack: [...s.undoStack, { undo: () => restore(before), redo: () => restore(after) }],
        redoStack: [],
      }));
      return applied;
    },
    setContent: (id, content, boxHeight, boxHeightBefore) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "text" || loc.node.locked || editBlocked(id)) return;
      const node = loc.node as unknown as { content: Paragraph[]; size: { width: number; height: number }; box: { height: number; mode?: string } };
      if (!content.length) return; // never leave a text node with zero paragraphs
      const before = structuredClone(node.content);
      const after = structuredClone(content);
      // Auto-height boxes track the content exactly. A fixed box CLAMPS: the
      // height the user chose (the height when editing began) is the floor,
      // and the box grows past it only while the text needs the room - the
      // render never clips, so a shorter box only produced a selection box
      // that lied about the text's extent. Auto-fit frames keep their height
      // (the font scales to fit instead). The undo baseline is the height
      // before editing began (boxHeightBefore) when known, so transient
      // live-grow during typing reverts cleanly.
      const box = node.box as { mode?: string; height: number; autoFit?: { enabled?: boolean } };
      const hBefore = boxHeightBefore ?? node.size.height;
      let hNext = hBefore;
      if (boxHeight != null) {
        if (box.mode === "autoHeight") hNext = boxHeight;
        else if (box.mode === "fixed" && !box.autoFit?.enabled) hNext = Math.max(hBefore, boxHeight);
      }
      if (Math.abs(hNext - hBefore) <= 0.5) hNext = hBefore;
      perform(
        () => { node.content = structuredClone(after); node.size.height = hNext; node.box.height = hNext; },
        () => { node.content = structuredClone(before); node.size.height = hBefore; node.box.height = hBefore; },
      );
    },
    growTextBoxLive: (id, height, fixedBase) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "text" || loc.node.locked || editBlocked(id)) return;
      const node = loc.node as unknown as { size: { width: number; height: number }; box: { height: number; mode?: string; autoFit?: { enabled?: boolean } } };
      let h: number;
      if (node.box.mode === "autoHeight") {
        h = Math.max(1, height);
      } else if (node.box.mode === "fixed" && !node.box.autoFit?.enabled) {
        // A fixed box clamps while typing: it grows past the height it had
        // when editing began only while the text needs the room, and deleting
        // lines lets it shrink back to that height - never below it. Auto-fit
        // frames are exempt (the font scales to fit instead).
        h = Math.max(1, Math.max(fixedBase ?? node.size.height, height));
      } else {
        return;
      }
      if (Math.abs(node.size.height - h) < 0.5) return; // no meaningful change
      // Transient: mutate the box + bump rev for a re-render, but do NOT push an
      // undo entry. The undoable height write happens once, on commit.
      node.size.height = h;
      node.box.height = h;
      set((s) => ({ rev: s.rev + 1 }));
    },
    setTextBackground: (id, color, padding = 8, radius = 8) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "text" || loc.node.locked || editBlocked(id)) return;
      const node = loc.node as unknown as { textEffects?: { kind: string }[] };
      const before = node.textEffects;
      const rest = (before ?? []).filter((e) => e.kind !== "highlight");
      const next: unknown[] = color
        ? [...rest, { kind: "highlight", color: { type: "solid", color }, padding, radius }]
        : rest;
      perform(
        () => { node.textEffects = (next.length ? next : undefined) as never; },
        () => { node.textEffects = before; },
      );
    },

    setTextEffect: (id, effect) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "text" || loc.node.locked || editBlocked(id)) return;
      const node = loc.node as unknown as { textEffects?: TextEffect[]; effects?: unknown };
      const before = node.textEffects;
      const beforeEffects = node.effects;
      // Effects are exclusive; keep only the background highlight, then add the
      // chosen one (if any).
      const kept = (before ?? []).filter((e) => e.kind === "highlight");
      const next = effect ? [...kept, effect] : kept;
      perform(
        () => {
          node.textEffects = (next.length ? next : undefined) as never;
          // Text uses this named textEffects system, not the generic node.effects
          // outline/shadow/glow that shapes/images use (the panel no longer offers
          // it on text). Strip any legacy node.effects so the two systems can't
          // both render (e.g. a double outline) and stale effects from the old
          // control are cleaned up the moment the user touches text effects.
          node.effects = undefined;
        },
        () => {
          node.textEffects = before;
          node.effects = beforeEffects as never;
        },
      );
    },

    setVerticalAlign: (id, v) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "text" || loc.node.locked || editBlocked(id)) return;
      const box = (loc.node as unknown as { box: { verticalAlign?: "top" | "middle" | "bottom" } }).box;
      const before = box.verticalAlign;
      if (before === v) return;
      perform(
        () => { box.verticalAlign = v; },
        () => { box.verticalAlign = before; },
      );
    },

    setTextBoxMode: (id, mode) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "text" || loc.node.locked || editBlocked(id)) return;
      const node = loc.node as unknown as { box: { mode: "fixed" | "autoHeight" | "autoWidth"; height: number }; size: { height: number } };
      const before = node.box.mode;
      if (before === mode) return;
      const hBefore = node.size.height;
      const boxHBefore = node.box.height;
      perform(
        () => {
          node.box.mode = mode;
          // Switching TO auto-height snaps the box to its content immediately,
          // so the toggle doubles as "fit the box to the text" for a box whose
          // stored height drifted while it was fixed.
          refitTextHeight(loc.node);
        },
        () => {
          node.box.mode = before;
          node.size.height = hBefore;
          node.box.height = boxHBefore;
        },
      );
      get().tick();
    },

    setTextAutoFit: (id, enabled) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "text" || loc.node.locked || editBlocked(id)) return;
      const box = (loc.node as unknown as { box: { autoFit?: { enabled: boolean; min: number; max: number } } }).box;
      const before = box.autoFit ? { ...box.autoFit } : undefined;
      if ((before?.enabled ?? false) === enabled) return;
      perform(
        () => { box.autoFit = { min: 8, max: 512, ...(before ?? {}), enabled }; },
        () => { box.autoFit = before; },
      );
    },
    setShapeKind: (id, shape) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "shape" || loc.node.locked || editBlocked(id)) return;
      const n = loc.node as unknown as { shape: string; sides?: number; innerRadius?: number; cornerRadius?: unknown };
      const before = { shape: n.shape, sides: n.sides, innerRadius: n.innerRadius, cornerRadius: n.cornerRadius };
      if (before.shape === shape) return;
      perform(
        () => {
          n.shape = shape;
          // Give polygon/star sensible parameters if missing; clear corner radius
          // when leaving rect so it does not linger as an unused field.
          if (shape === "polygon") n.sides = n.sides ?? 6;
          if (shape === "star") { n.sides = n.sides ?? 5; n.innerRadius = n.innerRadius ?? 0.5; }
          if (shape !== "rect") n.cornerRadius = undefined;
        },
        () => { n.shape = before.shape; n.sides = before.sides; n.innerRadius = before.innerRadius; n.cornerRadius = before.cornerRadius; },
      );
    },

    setTextLang: (id, lang) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "text" || loc.node.locked || editBlocked(id)) return;
      const n = loc.node as unknown as { data?: Record<string, unknown> };
      const before = n.data;
      const next = { ...(n.data ?? {}) };
      if (lang.trim()) next.lang = lang.trim(); else delete next.lang;
      perform(
        () => { n.data = next; },
        () => { n.data = before; },
      );
    },

    setTextColumns: (id, count, gutter) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "text" || loc.node.locked || editBlocked(id)) return;
      const box = (loc.node as unknown as { box: { columns?: { count: number; gutter: number } } }).box;
      const before = box.columns;
      const n = Math.max(1, Math.min(4, Math.round(count)));
      const next = n <= 1 ? undefined : { count: n, gutter: Math.max(0, gutter ?? before?.gutter ?? 16) };
      perform(
        () => { box.columns = next; },
        () => { box.columns = before; },
      );
      get().tick();
    },

    addDocFont: (ref) => {
      const doc = get().doc;
      ensureDocArrays(doc);
      const fonts = (doc as unknown as { fonts: { id: string; family: string; source: string; url: string }[] }).fonts;
      if (fonts.some((f) => f.family.toLowerCase() === ref.family.toLowerCase())) return;
      // Not an undo-worthy content edit; record it and mark the doc dirty.
      fonts.push({ id: ref.id, family: ref.family, source: "upload", url: ref.url });
      set((s) => ({ rev: s.rev + 1, savedRev: -1 }));
    },

    setRotationOrigin: (id, origin) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.locked || editBlocked(id)) return;
      const t = loc.node.transform as unknown as { origin?: { x: number; y: number } };
      const before = t.origin;
      perform(
        () => { t.origin = origin; },
        () => { t.origin = before; },
      );
    },

    setCurve: (id, curvature) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "text" || loc.node.locked || editBlocked(id)) return;
      const node = loc.node as unknown as { flow?: TextFlow };
      const before = node.flow;
      const next: TextFlow | undefined = Math.abs(curvature) < 0.001 ? undefined : { kind: "arc", curvature };
      perform(
        () => { node.flow = next; },
        () => { node.flow = before; },
      );
    },

    stepTextFontSize: (id, delta) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "text" || loc.node.locked || editBlocked(id)) return;
      const node = loc.node as unknown as { content: { runs: { style: { fontSize: number } }[] }[]; size: { height: number }; box: { height: number } };
      const before = structuredClone(node.content);
      const hBefore = node.size.height;
      const boxHBefore = node.box.height;
      perform(
        () => {
          node.content.forEach((p) => p.runs.forEach((r) => {
            r.style.fontSize = Math.max(4, Math.min(512, Math.round(r.style.fontSize + delta)));
          }));
          refitTextHeight(loc.node);
        },
        () => {
          node.content = structuredClone(before);
          node.size.height = hBefore;
          node.box.height = boxHBefore;
        },
      );
    },
    setTextStyle: (id, char, para) => {
      if (!char && !para) return;
      // While this node is open in the inline editor with a text selection,
      // char-only patches restyle the selection (what the user expects from
      // panel controls mid-edit) instead of every run in the box.
      if (char && !para) {
        const s = get();
        if (s.editingTextId === id && s.textEditApply && s.textEditApply(char)) return;
      }
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "text" || loc.node.locked || editBlocked(id)) return;
      const node = loc.node as unknown as {
        content: { runs: { style: Record<string, unknown> }[]; style: Record<string, unknown> }[];
        size: { height: number };
        box: { height: number };
      };
      const before = structuredClone(node.content);
      const hBefore = node.size.height;
      const boxHBefore = node.box.height;
      perform(
        () => {
          node.content.forEach((p) => {
            if (para) Object.assign(p.style, para);
            if (char) p.runs.forEach((r) => Object.assign(r.style, char));
          });
          refitTextHeight(loc.node);
        },
        () => {
          node.content = structuredClone(before);
          node.size.height = hBefore;
          node.box.height = boxHBefore;
        },
      );
    },

    setFills: (id, fills) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.locked || editBlocked(id)) return;
      const before = (loc.node as unknown as { fills?: Fill[] }).fills;
      get().runCommand({ kind: "setFills", node: id, before, after: fills });
    },
    previewAdjustments: (id, ops) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.locked || editBlocked(id)) return;
      const rec = loc.node as unknown as { effects?: { kind: string }[] };
      const rest = (rec.effects ?? []).filter((e) => e.kind !== "adjustment");
      const next = ops.length ? [...rest, { kind: "adjustment", ops }] : rest;
      rec.effects = (next.length ? next : undefined) as never;
      get().tick();
    },
    commitEffects: (id, before) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.locked || editBlocked(id)) return;
      const rec = loc.node as unknown as { effects?: unknown };
      const after = structuredClone(rec.effects ?? null);
      const beforeSnap = structuredClone((before ?? null) as never);
      // A pointer-down/up with no slider move leaves effects unchanged; don't
      // push an empty undo step in that case.
      if (JSON.stringify(after) === JSON.stringify(beforeSnap)) return;
      const set2 = (snap: unknown) => {
        const l = locate(get().doc, id);
        if (l) (l.node as unknown as { effects?: unknown }).effects = (structuredClone(snap) ?? undefined) as never;
      };
      set((s) => ({
        rev: s.rev + 1,
        undoStack: [...s.undoStack, { undo: () => set2(beforeSnap), redo: () => set2(after) }],
        redoStack: [],
      }));
    },
    previewEffects: (id, effects) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.locked || editBlocked(id)) return;
      (loc.node as unknown as { effects?: Effect[] }).effects = (effects?.length ? effects : undefined) as never;
      get().tick();
    },
    previewTextEffects: (id, effects) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "text" || loc.node.locked || editBlocked(id)) return;
      (loc.node as unknown as { textEffects?: TextEffect[] }).textEffects = (effects?.length ? effects : undefined) as never;
      get().tick();
    },
    commitTextEffects: (id, before) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "text" || loc.node.locked || editBlocked(id)) return;
      const rec = loc.node as unknown as { textEffects?: unknown };
      const after = structuredClone(rec.textEffects ?? null);
      const beforeSnap = structuredClone((before ?? null) as never);
      if (JSON.stringify(after) === JSON.stringify(beforeSnap)) return;
      const set2 = (snap: unknown) => {
        const l = locate(get().doc, id);
        if (l) (l.node as unknown as { textEffects?: unknown }).textEffects = (structuredClone(snap) ?? undefined) as never;
      };
      set((s) => ({
        rev: s.rev + 1,
        undoStack: [...s.undoStack, { undo: () => set2(beforeSnap), redo: () => set2(after) }],
        redoStack: [],
      }));
    },
    setImageFit: (id, fit) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "image" || loc.node.locked || editBlocked(id)) return;
      const rec = loc.node as unknown as { fit: ImageFit };
      const before = rec.fit;
      perform(
        () => {
          rec.fit = fit;
        },
        () => {
          rec.fit = before;
        },
      );
    },
    setNodeAltText: (id, altText) => {
      const loc = locate(get().doc, id);
      if (!loc) return;
      const rec = loc.node as unknown as { altText?: string };
      const before = rec.altText;
      const next = altText && altText.trim().length ? altText : undefined;
      if (before === next) return;
      perform(
        () => { rec.altText = next; },
        () => { rec.altText = before; },
      );
    },
    moveReadingOrder: (from, to, pageIndex) => {
      const idx = pageIndex ?? curPageIndex();
      const page = get().doc.pages[idx] as unknown as { readingOrder?: string[] };
      if (!page) return;
      const next = moveInReadingOrder(get().doc.pages[idx], from, to);
      const before = page.readingOrder;
      if (before && before.join() === next.join()) return;
      perform(
        () => { page.readingOrder = next; },
        () => { page.readingOrder = before; },
      );
    },
    resetReadingOrder: (pageIndex) => {
      const idx = pageIndex ?? curPageIndex();
      const page = get().doc.pages[idx] as unknown as { readingOrder?: string[] };
      if (!page?.readingOrder) return;
      const before = page.readingOrder;
      perform(
        () => { page.readingOrder = undefined; },
        () => { page.readingOrder = before; },
      );
    },
    setNodeDecorative: (id, decorative) => {
      const loc = locate(get().doc, id);
      if (!loc) return;
      const rec = loc.node as unknown as { decorative?: boolean; altText?: string };
      const before = rec.decorative;
      const beforeAlt = rec.altText;
      if (!!before === decorative) return;
      perform(
        () => {
          rec.decorative = decorative || undefined;
          // A decorative node needs no description; clear a stale one so the
          // two flags cannot contradict each other.
          if (decorative) rec.altText = undefined;
        },
        () => { rec.decorative = before; rec.altText = beforeAlt; },
      );
    },
    setImageAlt: (id, alt) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "image" || loc.node.locked || editBlocked(id)) return;
      const rec = loc.node as unknown as { alt?: string };
      const next = alt?.trim() ? alt.trim() : undefined;
      const before = rec.alt;
      if (before === next) return;
      perform(
        () => {
          rec.alt = next;
        },
        () => {
          rec.alt = before;
        },
      );
    },
    setImageCrop: (id, crop) => {
      const loc = locate(get().doc, id);
      if (!loc || editBlocked(id)) return;
      // A background image is locked by design (it must not catch canvas
      // drags), but the crop overlay is exactly how it is adjusted: pan/zoom
      // within the page box. Only the static lock is bypassed for it;
      // collab/brand/facilitator locks above still block.
      if (loc.node.locked && !get().isBackgroundImage(id)) return;
      // The crop lives on the image node itself, or on a shape's image fill
      // (fills[0]) - the same normalized-crop model either way, so the crop
      // overlay serves both.
      let rec: { crop?: CropRect; fit: ImageFit } | null = null;
      if (loc.node.type === "image") {
        rec = loc.node as unknown as { crop?: CropRect; fit: ImageFit };
      } else if (loc.node.type === "shape") {
        const fill = (loc.node as unknown as { fills?: Fill[] }).fills?.[0];
        if (fill?.type === "image") rec = fill as unknown as { crop?: CropRect; fit: ImageFit };
      }
      if (!rec) return;
      // Clamp to a valid sub-rectangle (CropRectSchema requires non-zero area,
      // within [0,1]); float math in the overlay can drift past the edge.
      let next: CropRect | undefined = crop;
      if (crop) {
        const width = Math.min(1, Math.max(0.001, crop.width));
        const height = Math.min(1, Math.max(0.001, crop.height));
        const x = Math.min(1 - width, Math.max(0, crop.x));
        const y = Math.min(1 - height, Math.max(0, crop.y));
        next = { x, y, width, height };
      }
      const beforeCrop = rec.crop;
      const beforeFit = rec.fit;
      perform(
        () => {
          rec.crop = next;
          // The crop overlay always selects a region matching the frame aspect,
          // so "cover" reproduces the chosen region exactly. Resetting crop
          // (undefined) leaves the fit unchanged.
          if (next) rec.fit = "cover";
        },
        () => {
          rec.crop = beforeCrop;
          rec.fit = beforeFit;
        },
      );
    },
    setStroke: (id, stroke) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.locked || editBlocked(id)) return;
      const before = (loc.node as unknown as { stroke?: Stroke }).stroke;
      get().runCommand({ kind: "setStroke", node: id, before, after: stroke });
    },
    setEffects: (id, effects) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.locked || editBlocked(id)) return;
      const before = loc.node.effects;
      get().runCommand({ kind: "setEffects", node: id, before, after: effects });
    },
    /**
     * The effect stack.
     *
     * All four route through `setEffects`, which is already one undoable
     * command and already fans out over the CRDT. Writing fresh `perform`
     * closures for each would duplicate that plumbing and give the stack
     * subtly different undo behaviour from every other effect edit.
     *
     * They address effects BY INDEX rather than by kind. The old panel was
     * built on `find(kind)`/`has(kind)`, which silently caps a node at one
     * blur and cannot express order at all; two blurs at different radii is an
     * ordinary thing to want and was simply unreachable.
     */
    moveEffect: (id, from, to) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.locked || editBlocked(id)) return;
      const eff = [...(loc.node.effects ?? [])];
      if (from === to || from < 0 || to < 0 || from >= eff.length || to >= eff.length) return;
      const [moved] = eff.splice(from, 1);
      eff.splice(to, 0, moved);
      get().setEffects(id, eff);
    },
    setEffectEnabled: (id, index, enabled) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.locked || editBlocked(id)) return;
      const eff = [...(loc.node.effects ?? [])];
      if (index < 0 || index >= eff.length) return;
      // Absent means enabled, so switching ON clears the key rather than
      // writing `true`. That keeps a file that never touched the stack
      // byte-identical to one that toggled an effect off and back on.
      const next = { ...eff[index] } as Effect & { enabled?: boolean };
      if (enabled) delete next.enabled;
      else next.enabled = false;
      eff[index] = next;
      get().setEffects(id, eff);
    },
    removeEffectAt: (id, index) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.locked || editBlocked(id)) return;
      const eff = [...(loc.node.effects ?? [])];
      if (index < 0 || index >= eff.length) return;
      eff.splice(index, 1);
      get().setEffects(id, eff.length ? eff : undefined);
    },
    addEffect: (id, kind) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.locked || editBlocked(id)) return;
      const made = newEffectOfKind(kind);
      if (!made) return;
      get().setEffects(id, [...(loc.node.effects ?? []), made]);
    },
    setCornerRadius: (id, radius) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.locked || editBlocked(id)) return;
      const rec = loc.node as unknown as { cornerRadius?: CornerRadius };
      const before = rec.cornerRadius;
      const r = Math.max(0, radius);
      const after: CornerRadius = { topLeft: r, topRight: r, bottomRight: r, bottomLeft: r };
      perform(
        () => {
          rec.cornerRadius = after;
        },
        () => {
          rec.cornerRadius = before;
        },
      );
    },

    setCornerRadiusSel: (radius) => {
      const { doc, selection } = get();
      const r = Math.max(0, radius);
      const acts: { do: () => void; undo: () => void }[] = [];
      for (const id of selection) {
        const loc = locate(doc, id);
        if (!loc || loc.node.locked || editBlocked(id)) continue;
        const n = loc.node as unknown as { type: string; shape?: string; cornerRadius?: CornerRadius };
        const isRectish = (n.type === "shape" && (n.shape === "rect" || n.shape === undefined)) || n.type === "frame";
        if (!isRectish) continue;
        const before = n.cornerRadius;
        const after: CornerRadius = { topLeft: r, topRight: r, bottomRight: r, bottomLeft: r };
        acts.push({ do: () => (n.cornerRadius = after), undo: () => (n.cornerRadius = before) });
      }
      if (!acts.length) return;
      perform(() => acts.forEach((a) => a.do()), () => acts.forEach((a) => a.undo()));
    },
    setShadowSel: (on) => {
      const SKIP = new Set(["text", "image", "group"]);
      const { doc, selection } = get();
      const acts: { do: () => void; undo: () => void }[] = [];
      for (const id of selection) {
        const loc = locate(doc, id);
        if (!loc || loc.node.locked || editBlocked(id) || SKIP.has(loc.node.type)) continue;
        const rec = loc.node as unknown as { effects?: Effect[] };
        const before = rec.effects;
        const rest = (before ?? []).filter((e) => e.kind !== "shadow");
        const after = on
          ? ([...rest, { kind: "shadow", type: "drop", color: { srgb: { r: 0, g: 0, b: 0, a: 0.25 } }, offsetX: 0, offsetY: 4, blur: 8, spread: 0 }] as unknown as Effect[])
          : (rest.length ? (rest as Effect[]) : undefined);
        acts.push({ do: () => (rec.effects = after), undo: () => (rec.effects = before) });
      }
      if (!acts.length) return;
      perform(() => acts.forEach((a) => a.do()), () => acts.forEach((a) => a.undo()));
    },

    deleteSelection: () => {
      const { doc, selection } = get();
      const page = doc.pages[curPageIndex()];
      const removed = selection
        .map((id) => {
          const i = page.children.findIndex((n) => n.id === id);
          const node = i >= 0 ? page.children[i] : null;
          // Skip statically-locked nodes, collab-locked-by-others, and brand locked regions.
          return node && !node.locked && !editBlocked(id) ? { node, index: i } : null;
        })
        .filter(Boolean) as { node: Node; index: number }[];
      if (removed.length === 0) return;
      const ids = removed.map((r) => r.node.id);
      const prevSelection = selection;
      perform(
        () => {
          for (const id of ids) {
            const i = page.children.findIndex((n) => n.id === id);
            if (i >= 0) page.children.splice(i, 1);
          }
          set({ selection: [] });
        },
        () => {
          for (const r of [...removed].sort((a, b) => a.index - b.index)) {
            page.children.splice(r.index, 0, r.node);
          }
          set({ selection: prevSelection });
        },
      );
    },

    group: () => {
      const { doc } = get();
      // Never pull a brand locked-region (or collab-locked) node into a group.
      const selection = get().selection.filter((id) => !editBlocked(id));
      if (selection.length < 2) return;
      const res = groupOp(doc, selection);
      if (!res) return;
      // groupOp already mutated the doc; register reversible entry.
      set((s) => ({
        rev: s.rev + 1,
        selection: [res.groupId],
        undoStack: [
          ...s.undoStack,
          {
            undo: () => ungroupOp(doc, res.groupId),
            redo: () => groupOp(doc, selection, res.groupId),
          },
        ],
        redoStack: [],
      }));
    },

    ungroupSelection: () => {
      const { doc, selection } = get();
      const groupId = selection.find((id) => locate(doc, id)?.node.type === "group");
      if (!groupId) return;
      const loc = locate(doc, groupId);
      if (!loc) return;
      // Snapshot the exact group node BEFORE dissolving it, so undo restores the
      // original group (including any scale/rotation) instead of re-deriving an
      // identity-transform group via groupOp.
      const groupSnapshot = structuredClone(loc.node);
      const res = ungroupOp(doc, groupId);
      if (!res) return;
      const restoredSnapshot = res.members
        .map((mid) => locate(get().doc, mid)?.node)
        .filter(Boolean)
        .map((n) => structuredClone(n as Node));
      set((s) => ({
        rev: s.rev + 1,
        selection: res.members,
        undoStack: [
          ...s.undoStack,
          {
            // Re-resolve the live container each time instead of capturing the
            // siblings array by reference (which detaches if the parent's
            // children array is replaced by an intervening edit/undo).
            undo: () => {
              const d = get().doc;
              let container: Node[] | null = null;
              let insertAt = Infinity;
              for (const mid of res.members) {
                const l = locate(d, mid);
                if (!l) continue;
                container = l.siblings;
                insertAt = Math.min(insertAt, l.index);
              }
              if (!container) return;
              for (const mid of res.members) {
                const i = container.findIndex((n) => n.id === mid);
                if (i >= 0) container.splice(i, 1);
              }
              container.splice(Number.isFinite(insertAt) ? Math.min(insertAt, container.length) : container.length, 0, structuredClone(groupSnapshot));
            },
            redo: () => {
              const l = locate(get().doc, groupId);
              if (!l) return;
              l.siblings.splice(l.index, 1, ...restoredSnapshot.map((n) => structuredClone(n)));
            },
          },
        ],
        redoStack: [],
      }));
    },

    orderSelection: (op) => {
      const { doc } = get();
      // Reordering a brand locked-region node changes its z-stack, which is a
      // layout mutation a filler may not perform; filter those out.
      const selection = get().selection.filter((id) => !editBlocked(id));
      if (!selection.length) return;
      const page = doc.pages[curPageIndex()];
      const before = page.children.map((n) => n.id);
      perform(
        () => {
          page.children = orderOp(page.children, selection, op);
        },
        () => {
          page.children.sort((a, b) => before.indexOf(a.id) - before.indexOf(b.id));
        },
      );
    },

    alignSelection: (edge) => {
      const { doc, selection } = get();
      if (selection.length === 0) return;
      const items = arrangeItems(doc, selection);
      const page = doc.pages[curPageIndex()];
      const target =
        selection.length > 1
          ? (unionAABB(doc, selection) ?? { x: 0, y: 0, width: page.width, height: page.height })
          : { x: 0, y: 0, width: page.width, height: page.height };
      applyDeltas(set, get, alignDeltas(items, edge, target));
    },
    flipSelection: (axis) => {
      const { doc, selection } = get();
      if (!selection.length) return;
      const box = unionAABB(doc, selection);
      if (!box) return;
      const targets = selection
        .map((id) => locate(doc, id))
        .filter((l): l is NonNullable<typeof l> => !!l && !l.node.locked);
      if (!targets.length) return;
      // For one node, mirror about its OWN center (correct in its parent space
      // even when nested in a group). For many, mirror about the union center
      // (page space; assumes top-level, which is the common case).
      const single = targets.length === 1;
      const before = targets.map((l) => ({ ...l.node.transform }));
      const after = targets.map((l) => {
        const t = { ...l.node.transform };
        const w = l.node.size.width, h = l.node.size.height;
        if (axis === "h") {
          const c = single ? t.x + (t.scaleX * w) / 2 : box.x + box.width / 2;
          t.x = 2 * c - t.x;
          t.scaleX = -t.scaleX;
        } else {
          const c = single ? t.y + (t.scaleY * h) / 2 : box.y + box.height / 2;
          t.y = 2 * c - t.y;
          t.scaleY = -t.scaleY;
        }
        return t;
      });
      const apply = (arr: Transform[]) => targets.forEach((l, i) => { l.node.transform = { ...arr[i] }; });
      perform(() => apply(after), () => apply(before));
    },
    distributeSelection: (axis, by) => {
      const { doc, selection } = get();
      if (selection.length < 3) return;
      applyDeltas(set, get, distributeDeltas(arrangeItems(doc, selection), axis, by));
    },
    tidySelection: () => {
      const { doc, selection } = get();
      if (selection.length === 0) return;
      applyDeltas(set, get, tidyUpDeltas(arrangeItems(doc, selection)));
    },

    setLockedSel: (v) => {
      const { doc, selection } = get();
      const cmds = selection.map((id) => setLocked(doc, id, v)).filter(Boolean) as EditCommand[];
      if (cmds.length) registerApplied(set, get, cmds);
    },
    lockAllOnPage: (v) => {
      const doc = get().doc;
      const page = doc.pages[curPageIndex()];
      if (!page) return;
      const cmds = page.children.map((n) => setLocked(doc, n.id, v)).filter(Boolean) as EditCommand[];
      if (cmds.length) registerApplied(set, get, cmds);
      if (v) set({ selection: [] });
    },
    setHiddenSel: (v) => {
      const { doc, selection } = get();
      const cmds = selection.map((id) => setHidden(doc, id, v)).filter(Boolean) as EditCommand[];
      if (cmds.length) registerApplied(set, get, cmds);
    },
    setOpacitySel: (v) => {
      const { doc, selection } = get();
      const cmds = selection
        .filter((id) => !locate(doc, id)?.node.locked && !editBlocked(id))
        .map((id) => setOpacityOp(doc, id, v))
        .filter(Boolean) as EditCommand[];
      if (cmds.length) registerApplied(set, get, cmds);
    },
    setBlendSel: (mode) => {
      const { doc, selection } = get();
      const cmds = selection
        .filter((id) => !locate(doc, id)?.node.locked && !editBlocked(id))
        .map((id) => setBlendOp(doc, id, mode))
        .filter(Boolean) as EditCommand[];
      if (cmds.length) registerApplied(set, get, cmds);
    },
    // Recolor every fill-bearing node in the selection (solid), text included, as
    // one undo step. Locked nodes are skipped.
    setFillColorSel: (hex) => {
      const { doc, selection } = get();
      const fill = { type: "solid", color: hexToColor(hex) } as unknown as Fill;
      const acts: { do: () => void; undo: () => void }[] = [];
      for (const id of selection) {
        const loc = locate(doc, id);
        if (!loc || loc.node.locked || editBlocked(id)) continue;
        const node = loc.node;
        if (node.type === "text") {
          const paras = (node as unknown as { content: { runs: { style: { fill?: Fill } }[] }[] }).content;
          const before = paras.map((p) => p.runs.map((r) => r.style.fill));
          acts.push({
            do: () => paras.forEach((p) => p.runs.forEach((r) => (r.style.fill = fill))),
            undo: () => paras.forEach((p, pi) => p.runs.forEach((r, ri) => (r.style.fill = before[pi][ri]))),
          });
        } else if (FILL_CAPABLE.has(node.type)) {
          const rec = node as unknown as { fills?: Fill[] };
          const before = rec.fills;
          acts.push({ do: () => (rec.fills = [fill]), undo: () => (rec.fills = before) });
        }
      }
      if (!acts.length) return;
      perform(() => acts.forEach((a) => a.do()), () => acts.forEach((a) => a.undo()));
    },
    // Apply a full fills array (e.g. a gradient) to every fill-capable node in the
    // selection as one undo step. Text is skipped (no node-level fills).
    setFillsSel: (fills) => {
      const { doc, selection } = get();
      const acts: { do: () => void; undo: () => void }[] = [];
      for (const id of selection) {
        const loc = locate(doc, id);
        if (!loc || loc.node.locked || editBlocked(id) || !FILL_CAPABLE.has(loc.node.type)) continue;
        const rec = loc.node as unknown as { fills?: Fill[] };
        const before = rec.fills;
        const after = structuredClone(fills);
        acts.push({ do: () => (rec.fills = after), undo: () => (rec.fills = before) });
      }
      if (!acts.length) return;
      perform(() => acts.forEach((a) => a.do()), () => acts.forEach((a) => a.undo()));
    },
    setTextColor: (id, hex) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "text" || loc.node.locked || editBlocked(id)) return;
      const fill = { type: "solid", color: hexToColor(hex) } as unknown as Fill;
      const paras = (loc.node as unknown as { content: { runs: { style: { fill?: Fill } }[] }[] }).content;
      const before = paras.map((p) => p.runs.map((r) => r.style.fill));
      perform(
        () => paras.forEach((p) => p.runs.forEach((r) => (r.style.fill = fill))),
        () => paras.forEach((p, pi) => p.runs.forEach((r, ri) => (r.style.fill = before[pi][ri]))),
      );
    },
    moveNodeBy: (id, dx, dy) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.locked || editBlocked(id)) return;
      if (dx === 0 && dy === 0) return;
      const before = { ...loc.node.transform };
      const after = moveTransform(loc.node.transform, dx, dy);
      get().runCommand({ kind: "transform", nodes: [id], before: [before], after: [after] });
    },
    // Apply font/color/radius harmonization across the active page as one undo
    // step. Snapshots each touched node once (mirrors applyBrandFixes' batch).
    applyHarmonize: (changes) => {
      if (!changes.length) return 0;
      const doc = get().doc;
      const page = doc.pages[curPageIndex()];
      if (!page) return 0;
      const fontMap = new Map<string, string>();
      const colorMap = new Map<string, string>();
      const radiusMap = new Map<number, number>();
      for (const c of changes) {
        if (c.kind === "font") fontMap.set(c.from, c.to);
        else if (c.kind === "color") colorMap.set(c.from.toLowerCase(), c.to);
        else radiusMap.set(c.from, c.to);
      }
      const before = new Map<string, Node>();
      const touched = new Set<string>();
      const snapshot = (id: string, node: Node) => {
        if (!before.has(id)) before.set(id, structuredClone(node));
        touched.add(id);
      };
      for (const node of page.children) {
        if (node.hidden || node.locked || editBlocked(node.id)) continue;
        if (node.type === "text") {
          const content = (node as unknown as { content: { runs: { style: { fontFamily?: string; fill?: Fill } }[] }[] }).content;
          let changed = false;
          for (const p of content) for (const r of p.runs) {
            const fam = r.style.fontFamily;
            if (fam && fontMap.has(fam)) changed = true;
            const f = r.style.fill;
            if (f && f.type === "solid" && colorMap.has(toHex(f.color).toLowerCase())) changed = true;
          }
          if (!changed) continue;
          snapshot(node.id, node);
          let fontChanged = false;
          for (const p of content) for (const r of p.runs) {
            if (r.style.fontFamily && fontMap.has(r.style.fontFamily)) {
              r.style.fontFamily = fontMap.get(r.style.fontFamily)!;
              fontChanged = true;
            }
            const f = r.style.fill;
            if (f && f.type === "solid") {
              const to = colorMap.get(toHex(f.color).toLowerCase());
              if (to) r.style.fill = { type: "solid", color: hexToColor(to) };
            }
          }
          // Font harmonization rewraps the text; color-only changes do not.
          if (fontChanged) refitTextHeight(node);
        } else {
          const rec = node as unknown as { fills?: Fill[]; cornerRadius?: CornerRadius };
          let changed = false;
          if (rec.fills) for (const f of rec.fills) if (f.type === "solid" && colorMap.has(toHex(f.color).toLowerCase())) changed = true;
          const cr = rec.cornerRadius;
          const uniform = cr && cr.topLeft === cr.topRight && cr.topRight === cr.bottomRight && cr.bottomRight === cr.bottomLeft ? cr.topLeft : null;
          if (uniform !== null && radiusMap.has(uniform)) changed = true;
          if (!changed) continue;
          snapshot(node.id, node);
          if (rec.fills) rec.fills = rec.fills.map((f) => {
            if (f.type === "solid") {
              const to = colorMap.get(toHex(f.color).toLowerCase());
              if (to) return { type: "solid", color: hexToColor(to) };
            }
            return f;
          });
          if (uniform !== null && radiusMap.has(uniform)) {
            const r = radiusMap.get(uniform)!;
            rec.cornerRadius = { topLeft: r, topRight: r, bottomRight: r, bottomLeft: r };
          }
        }
      }
      if (!touched.size) return 0;
      const after = new Map<string, Node>();
      for (const id of touched) {
        const loc = locate(doc, id);
        if (loc) after.set(id, structuredClone(loc.node));
      }
      const restore = (snaps: Map<string, Node>) => {
        const d = get().doc;
        for (const [id, snap] of snaps) {
          const loc = locate(d, id);
          if (!loc) continue;
          const live = loc.node as unknown as Record<string, unknown>;
          const src = snap as unknown as Record<string, unknown>;
          // size + box travel with the snapshot: a font harmonization re-fits
          // an auto-height box, and undo must take the height back with it.
          for (const k of ["fills", "cornerRadius", "content", "size", "box"]) {
            if (k in src) live[k] = structuredClone(src[k]);
            else delete live[k];
          }
        }
      };
      set((s) => ({
        rev: s.rev + 1,
        undoStack: [...s.undoStack, { undo: () => restore(before), redo: () => restore(after) }],
        redoStack: [],
      }));
      return touched.size;
    },
    autoAnimate: (assignments) => {
      if (!assignments.length) return 0;
      const doc = get().doc;
      const before = new Map<string, { animation?: NodeAnimation; animations?: unknown }>();
      const after = new Map<string, NodeAnimation | undefined>();
      for (const a of assignments) {
        const loc = locate(doc, a.nodeId);
        if (!loc || editBlocked(a.nodeId)) continue;
        const rec = loc.node as unknown as { animation?: NodeAnimation; animations?: unknown };
        before.set(a.nodeId, { animation: rec.animation, animations: rec.animations });
        const next: NodeAnimation = {
          ...(rec.animation ?? {}),
          entrance: { preset: a.preset, durationMs: a.durationMs, delayMs: a.delayMs, easing: a.preset === "pop" ? "spring" : "ease-out" },
        };
        after.set(a.nodeId, next);
      }
      if (!before.size) return 0;
      const apply = (snaps: Map<string, NodeAnimation | undefined>, drop: boolean) => {
        const d = get().doc;
        for (const [id, anim] of snaps) {
          const loc = locate(d, id);
          if (!loc) continue;
          const rec = loc.node as unknown as { animation?: NodeAnimation; animations?: unknown };
          rec.animation = anim;
          if (drop) delete rec.animations;
        }
      };
      const undo = () => {
        const d = get().doc;
        for (const [id, snap] of before) {
          const loc = locate(d, id);
          if (!loc) continue;
          const rec = loc.node as unknown as { animation?: NodeAnimation; animations?: unknown };
          rec.animation = snap.animation;
          rec.animations = snap.animations;
        }
      };
      perform(() => apply(after, true), undo);
      return before.size;
    },
    clearPageAnimations: () => {
      const doc = get().doc;
      const page = doc.pages[curPageIndex()];
      if (!page) return 0;
      const before = new Map<string, { animation?: NodeAnimation; animations?: unknown }>();
      for (const node of page.children) {
        if (editBlocked(node.id)) continue;
        const rec = node as unknown as { animation?: NodeAnimation; animations?: unknown };
        if (rec.animation || rec.animations) before.set(node.id, { animation: rec.animation, animations: rec.animations });
      }
      if (!before.size) return 0;
      const setAll = (fn: (rec: { animation?: NodeAnimation; animations?: unknown }, snap?: { animation?: NodeAnimation; animations?: unknown }) => void) => {
        const d = get().doc;
        for (const id of before.keys()) {
          const loc = locate(d, id);
          if (loc) fn(loc.node as unknown as { animation?: NodeAnimation; animations?: unknown }, before.get(id));
        }
      };
      perform(
        () => setAll((rec) => { delete rec.animation; delete rec.animations; }),
        () => setAll((rec, snap) => { rec.animation = snap?.animation; rec.animations = snap?.animations; }),
      );
      return before.size;
    },
    applyTextGeometry: (id, transform, size) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "text" || loc.node.locked) return;
      const node = loc.node as unknown as { transform: Transform; size: { width: number; height: number }; box: { width: number; height: number } };
      const before = { transform: { ...node.transform }, size: { ...node.size }, box: structuredClone(node.box) };
      node.transform = { ...transform };
      node.size = { ...size };
      node.box = { ...node.box, width: size.width, height: size.height };
      get().pushNodeSnapshot(id, before);
    },
    applyLineGeometry: (id, transform, size) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "line" || loc.node.locked || editBlocked(id)) return;
      const node = loc.node as unknown as { transform: Transform; size: { width: number; height: number }; points: { x: number; y: number }[] };
      const before = { transform: { ...node.transform }, size: { ...node.size }, points: structuredClone(node.points) };
      const xs = node.points.map((p) => p.x);
      const ys = node.points.map((p) => p.y);
      const degX = Math.max(...xs) - Math.min(...xs) < 0.5;
      const degY = Math.max(...ys) - Math.min(...ys) < 0.5;
      const next = { ...size };
      if (degX) next.width = node.size.width;
      if (degY) next.height = node.size.height;
      const kx = degX || node.size.width <= 0 ? 1 : next.width / node.size.width;
      const ky = degY || node.size.height <= 0 ? 1 : next.height / node.size.height;
      node.points = node.points.map((p) => ({ ...p, x: p.x * kx, y: p.y * ky }));
      node.transform = { ...transform };
      node.size = next;
      get().pushNodeSnapshot(id, before);
    },
    applyGridGeometry: (id, transform, size) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "grid" || loc.node.locked || editBlocked(id)) return;
      const node = loc.node as unknown as { transform: Transform; size: { width: number; height: number }; rows: number; cols: number; gap: number; cells: { row: number; col: number; rowSpan: number; colSpan: number; childId?: string }[]; children: Node[] };
      const before = { transform: { ...node.transform }, size: { ...node.size }, children: structuredClone(node.children) };
      node.transform = { ...transform };
      node.size = { width: Math.max(1, size.width), height: Math.max(1, size.height) };
      relayGridCells(node, node.size);
      get().pushNodeSnapshot(id, before);
    },
    applyFrameGeometry: (id, transform, size) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "frame" || loc.node.locked || editBlocked(id)) return;
      const node = loc.node as unknown as { transform: Transform; size: { width: number; height: number }; children?: Node[] };
      const before = { transform: { ...node.transform }, size: { ...node.size }, children: structuredClone(node.children ?? []) };
      const startSize = { ...node.size };
      const startChildren = structuredClone(node.children ?? []);
      node.transform = { ...transform };
      node.size = { width: Math.max(1, size.width), height: Math.max(1, size.height) };
      scaleFrameImageChildren(node, startChildren, startSize, node.size);
      get().pushNodeSnapshot(id, before);
    },
    setStrokeSel: (stroke) => {
      const { doc, selection } = get();
      const STROKEABLE = new Set(["shape", "path", "frame", "line", "connector", "vector"]);
      const acts: { do: () => void; undo: () => void }[] = [];
      for (const id of selection) {
        const loc = locate(doc, id);
        if (!loc || loc.node.locked || editBlocked(id) || !STROKEABLE.has(loc.node.type)) continue;
        const rec = loc.node as unknown as { stroke?: Stroke };
        const before = rec.stroke;
        const after = stroke ? (structuredClone(stroke) as Stroke) : undefined;
        acts.push({ do: () => (rec.stroke = after), undo: () => (rec.stroke = before) });
      }
      if (!acts.length) return;
      perform(() => acts.forEach((a) => a.do()), () => acts.forEach((a) => a.undo()));
    },
    renameNode: (id, name) => {
      const cmd = renameOp(get().doc, id, name);
      if (cmd) registerApplied(set, get, [cmd]);
    },

    // Binding a CRDT manager clears the local stacks: entries recorded before
    // the bind reference pre-session state and must never replay into a live
    // doc (perform() keeps the stacks empty for the rest of the session).
    setCollabUndo: (handle) =>
      set(handle ? { collabUndo: handle, undoStack: [], redoStack: [] } : { collabUndo: handle }),
    undo: () => {
      // F16: in a live collaborative session, delegate EXCLUSIVELY to the CRDT
      // undo manager so this client reverts only its OWN edits. Never fall back
      // to the local stacks while a manager is bound: local entries are not
      // consumed by CRDT undo, so any leftover would replay a stale inverse
      // against a newer doc (re-applying old edits and clobbering peer changes),
      // and the replay's reconcile would itself be tracked, making the next
      // undo revert the undo. perform() keeps the stacks empty while bound.
      const cu = get().collabUndo;
      if (cu) {
        if (cu.canUndo()) cu.undo();
        return;
      }
      const { undoStack } = get();
      if (undoStack.length === 0) return;
      const entry = undoStack[undoStack.length - 1];
      entry.undo();
      set((s) => ({
        rev: s.rev + 1,
        undoStack: s.undoStack.slice(0, -1),
        redoStack: [...s.redoStack, entry],
      }));
    },
    redo: () => {
      const cu = get().collabUndo;
      if (cu) {
        if (cu.canRedo()) cu.redo();
        return;
      }
      const { redoStack } = get();
      if (redoStack.length === 0) return;
      const entry = redoStack[redoStack.length - 1];
      entry.redo();
      set((s) => ({
        rev: s.rev + 1,
        redoStack: s.redoStack.slice(0, -1),
        undoStack: [...s.undoStack, entry],
      }));
    },
  };
});

function arrangeItems(doc: DesignFile, ids: string[]): ArrangeItem[] {
  const items: ArrangeItem[] = [];
  for (const id of ids) {
    if (locate(doc, id)?.node.locked || editBlocked(id)) continue; // align/distribute leave locked + brand locked-region nodes put
    const b = worldAABB(doc, id);
    if (b) items.push({ id, bounds: b });
  }
  return items;
}

// Turn per-id position deltas into one transform command and run it (undoable).
function applyDeltas(
  set: (fn: (s: EditorState) => Partial<EditorState>) => void,
  get: () => EditorState,
  deltas: Map<string, Delta>,
): void {
  const doc = get().doc;
  const nodes: string[] = [];
  const before: Transform[] = [];
  const after: Transform[] = [];
  for (const [id, d] of deltas) {
    if (d.dx === 0 && d.dy === 0) continue;
    const loc = locate(doc, id);
    if (!loc) continue;
    nodes.push(id);
    before.push({ ...loc.node.transform });
    after.push(moveTransform(loc.node.transform, d.dx, d.dy));
  }
  if (nodes.length) get().runCommand({ kind: "transform", nodes, before, after });
  void set;
}

// Forward mutation shared by "detach from background" and the auto-detach a
// new background applies to the previous one: unlock the image, restore the
// pre-background transform and z-index saved by setImageAsBackground (values
// are validated first - `data` round-trips through saved files, so it is
// untrusted), and strip the background keys from `data`. A hand-built
// background carries no saved state and just unlocks in place. Callers own
// the undo closure.
function applyBackgroundDetach(node: Node, page: Page): void {
  const data = (node.data ?? {}) as Record<string, unknown>;
  const saved = data.backgroundRestore as
    | { transform?: Partial<Transform>; size?: Partial<{ width: number; height: number }>; fit?: string; index?: number }
    | undefined;
  const t = saved?.transform;
  if (t && [t.x, t.y, t.scaleX, t.scaleY, t.rotation].every((v) => Number.isFinite(v))) {
    node.transform = { x: t.x!, y: t.y!, scaleX: t.scaleX!, scaleY: t.scaleY!, rotation: t.rotation! };
  }
  const sz = saved?.size;
  if (sz && Number.isFinite(sz.width) && Number.isFinite(sz.height) && sz.width! > 0 && sz.height! > 0) {
    node.size = { width: sz.width!, height: sz.height! };
  }
  if (saved?.fit === "cover" || saved?.fit === "contain" || saved?.fit === "stretch" || saved?.fit === "none") {
    (node as unknown as { fit: ImageFit }).fit = saved.fit;
  }
  if (typeof saved?.index === "number" && Number.isInteger(saved.index) && saved.index >= 0) {
    const i = page.children.indexOf(node);
    if (i >= 0) {
      page.children.splice(i, 1);
      page.children.splice(Math.min(saved.index, page.children.length), 0, node);
    }
  }
  node.locked = false;
  const rest = { ...data };
  delete rest.background;
  delete rest.backgroundRestore;
  node.data = Object.keys(rest).length ? rest : undefined;
}

// Register commands that were already applied (the layer ops mutate as they
// build the command), wrapping them as a single reversible undo entry.
function registerApplied(
  set: (fn: (s: EditorState) => Partial<EditorState>) => void,
  get: () => EditorState,
  cmds: EditCommand[],
): void {
  set((s) => ({
    rev: s.rev + 1,
    undoStack: [
      ...s.undoStack,
      {
        undo: () => {
          const doc = get().doc;
          for (const c of [...cmds].reverse()) applyCommand(doc, invertCommand(c));
        },
        redo: () => {
          const doc = get().doc;
          for (const c of cmds) applyCommand(doc, c);
        },
      },
    ],
    redoStack: [],
  }));
}
