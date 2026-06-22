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
  type NodeType,
  type Page,
  type PageTransition,
  type Paragraph,
  type ParagraphStyle,
  type Stroke,
  type TableBorderStyle,
  type TableConditionalRule,
  type TableCell,
  type TableHeaderStyle,
  type TableNode,
  type TextEffect,
  type TextFlow,
  type Transform,
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
  type AnimPatch,
  type Mat2D,
} from "@hc/engine";
import { booleanOp, fitCubicBeziers, pathToPolylines, recognizeShape, shapeNodeToParametric, shapeToPath, simplifyPolyline, strokeToOutline, type BooleanOp } from "@hc/geometry";
import { imageAssets } from "@/lib/assetProvider";
import type { MagicDesignSpec } from "@/lib/magicDesign";
import { qrModules } from "@/lib/qr";
import { frameMaskFor } from "@/lib/maskPath";
import { svgToNodes } from "@hc/stock";
import { flattenSvgToNodes } from "@/lib/svgFlatten";
import { parseCsvMatrix } from "@/lib/csv";
import { tabularToChart } from "@/lib/magicDesign";
import { usePresence } from "@/store/presence";
import { useBrand } from "@/store/brand";

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
// user OR a brand locked region for this caller. Used by the single-node guards.
function editBlocked(id: string): boolean {
  return lockedByOther(id) || lockedRegion(id);
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

type Tool = "select" | "pen" | "pencil" | "line" | "arrow" | "rect" | "ellipse" | "text" | "comment";

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
// working across refresh and browser tabs (last copy wins, same as Canva).
export const OC_CLIP_PREFIX = "oc-clipboard-v1::";

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
  tool: Tool; // active canvas tool (select vs pen)
  playing: boolean; // animation preview running
  cropping: string | null; // id of the image currently in crop mode (UI only)
  editingTextId: string | null; // text node currently in the inline editor (UI only); the renderer skips it so it doesn't double up
  presenting: boolean; // fullscreen present mode is open (suppresses canvas keys)
  // View aids (UI only, not part of the document)
  showRulers: boolean;
  showGrid: boolean;
  gridSize: number; // page units between grid lines
  snapEnabled: boolean; // smart guides + grid snapping during moves
  guides: Record<string, { x: number[]; y: number[] }>; // manual guides per page id
  snapGuides: { x: number[]; y: number[] } | null; // transient smart-guide preview (shared by move/resize)
  activePage: number; // index of the page being edited
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];

  // selection
  select(ids: string[]): void;
  toggle(id: string): void;
  addToSelection(ids: string[]): void;
  clearSelection(): void;
  /** Select every visible, unlocked top-level node on the active page. */
  selectAll(): void;

  // document
  /** Replace the whole document (e.g. after loading from the backend). */
  loadDoc(file: DesignFile): void;
  /** Set the document title (used for the editor header + export filename). */
  setDocTitle(title: string): void;
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
  /** Zoom to frame the current selection (falls back to fit). */
  zoomToSelection(): void;

  // pages
  /** Switch the active page (clamped); clears selection. */
  setActivePage(index: number): void;
  /** Add a blank page (same size as the current one) after it, undoable. */
  addPage(): void;
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
  /** Reorder pages (move page at `from` to index `to`), undoable. */
  movePage(from: number, to: number): void;
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

  // tools
  setTool(tool: Tool): void;
  setCropping(id: string | null): void;
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
  /** Combine the selected shapes with a boolean op into one boolean node. */
  booleanSelection(op: BooleanOp): void;
  /** Convert the selected shape/path's stroke into a filled outline node (F26). */
  strokeToOutlineSelection(): void;
  /** Replace the selected freehand path with a recognized clean shape (F26). */
  recognizeSelectedPath(): void;
  // clipboard + quick edits
  copySelection(): void;
  cutSelection(): void;
  paste(): void;
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
  /** Set the active (or given) page's speaker notes, undoable. */
  setPageNotes(notes: string, pageIndex?: number): void;
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
  pushNodeSnapshot(id: string, before: { transform: Transform; size: { width: number; height: number }; box?: unknown; content?: unknown }): void;
  addNode(type: Exclude<NodeType, "model3d">, init?: Partial<Node>): void;
  /** Place an image node from a URL, registering it as a design asset. */
  /** Add an image; `at` (page point) centers it there (e.g. a drag-drop), else viewport-centered. */
  addImage(url: string, at?: { x: number; y: number }): void;
  /** Insert an SVG icon as an editable, scaled vector group, viewport-centered. */
  addIconSvg(svg: string): void;
  /** Append imported pages (e.g. from a PDF), each sized to the source page with
   *  its editable nodes, and switch to the first new page. Undoable. */
  importPdfPages(pages: { width: number; height: number; nodes: Node[] }[]): void;
  /** Import a full SVG file (e.g. a Canva SVG export) as editable elements:
   *  shapes/paths/text/images, registered assets, scaled to fit the page and
   *  grouped (ungroup to edit each element). Undoable. */
  importSvg(svg: string): void;
  /** Set node-level fills to a single solid color (hex), undoable. */
  setFillColor(id: string, hex: string): void;
  /** Replace a text node's first-run text, undoable. */
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
  growTextBoxLive(id: string, height: number): void;
  /** Set (or clear, with null) a text node's background highlight (Canva-style),
   *  a padded rounded rect filled behind the text. Undoable. */
  setTextBackground(id: string, color: Color | null, padding?: number, radius?: number): void;
  /** Set (or clear, with null) the single named text effect on a text node
   *  (shadow/lift/hollow/splice/echo/neon/glow/outline). Effects are mutually
   *  exclusive (Canva-style); the background highlight is kept separate. Undoable. */
  setTextEffect(id: string, effect: TextEffect | null): void;
  /** Set a text node's vertical alignment within its box (top/middle/bottom). */
  setVerticalAlign(id: string, v: "top" | "middle" | "bottom"): void;
  /** Curve a text node's baseline along an arc (Canva "Curve"); 0 clears it. */
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
  /** Set/clear an image node's accessibility alt text (F22 FR-12), undoable. */
  setImageAlt(id: string, alt: string | undefined): void;
  /** Replace an image node's source AND set its box to a known size in one
   *  undoable step (Magic Expand / outpaint: the padded result has a new aspect
   *  computed client-side, so we set it directly rather than waiting on load). */
  outpaintImage(id: string, url: string, width: number, height: number): void;
  /** Rebind a QR node's value and regenerate its module matrix, undoable. */
  setQrValue(id: string, value: string): void;
  /** Place an image into a frame (clipped to the frame), undoable. */
  setFrameImage(id: string, url: string): void;
  /** Fill a shape with an image, clipped to its outline (undoable). Pass an
   *  empty url to clear the image fill back to a solid color. */
  setImageFill(id: string, url: string): void;
  /** Set a frame's mask shape (rectangle/rounded/ellipse), undoable. */
  setFrameShape(id: string, mask: "rect" | "ellipse", radius: number): void;
  /** Convert a shape/path node into an image frame clipped to its outline, undoable. */
  convertToFrame(id: string): void;
  /** Set/clear a node's stroke (border), undoable. */
  setStroke(id: string, stroke?: Stroke): void;
  /** Set/clear a node's effects (shadow/blur/glow), undoable. */
  setEffects(id: string, effects?: Effect[]): void;
  /** Live-preview color adjustments (brightness/contrast/...) with no undo step. */
  previewAdjustments(id: string, ops: { name: string; value: number }[]): void;
  /** Commit an effects change as one undo step (before = effects at gesture start). */
  commitEffects(id: string, before: unknown): void;
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
  renameNode(id: string, name: string): void;

  undo(): void;
  redo(): void;
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

// Minimal view of a PathNode for the pen tool's in-place mutations.
type PathSeg = { x: number; y: number; cIn?: { x: number; y: number }; cOut?: { x: number; y: number }; corner?: boolean };
type PathNodeLike = {
  transform: { x: number; y: number };
  segments: PathSeg[];
  size: { width: number; height: number };
  closed: boolean;
};

// Re-tighten a path node: shift its transform to the min of all anchor+handle
// points (keeping absolute position) and set size to the point bounds, so the
// node stays selectable and the gizmo box hugs the path as it grows.
function normalizePath(node: PathNodeLike): void {
  const pts: { x: number; y: number }[] = [];
  for (const s of node.segments) {
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
  for (const s of node.segments) {
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

function sampleDesign(): DesignFile {
  const d = createBlankDesign({ title: "Untitled design", width: 1080, height: 1080 });
  d.pages[0].background = { type: "solid", color: { srgb: { r: 1, g: 1, b: 1, a: 1 } } };
  d.pages[0].children = [
    createNode("shape", {
      id: "rect-1",
      name: "Rectangle",
      shape: "rect",
      transform: { x: 120, y: 140, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 360, height: 240 },
      fills: [{ type: "solid", color: { srgb: { r: 0.27, g: 0.51, b: 0.96, a: 1 } } }],
    } as Partial<Node>),
    createNode("shape", {
      id: "ellipse-1",
      name: "Ellipse",
      shape: "ellipse",
      transform: { x: 560, y: 380, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 300, height: 300 },
      fills: [{ type: "solid", color: { srgb: { r: 0.96, g: 0.42, b: 0.27, a: 1 } } }],
    } as Partial<Node>),
    createNode("text", {
      id: "text-1",
      name: "Heading",
      transform: { x: 140, y: 460, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 520, height: 80 },
      box: { mode: "fixed", width: 520, height: 80, autoFit: { enabled: false, min: 8, max: 512 }, verticalAlign: "top" },
      content: [
        {
          runs: [
            {
              text: "HyCanvas",
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
  let changed = !file.meta;
  const normPages = pages.map((p) => {
    const w = fin(p.width) ? p.width : fw;
    const h = fin(p.height) ? p.height : fh;
    if (w === p.width && h === p.height) return p;
    changed = true;
    return { ...p, width: w, height: h };
  });
  return changed ? { ...file, meta: file.meta ?? {}, pages: normPages } : file;
}

export const useEditor = create<EditorState>((set, get) => {
  // Push an undo entry and apply the forward action immediately.
  const perform = (redo: () => void, undo: () => void) => {
    redo();
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

  // Index of the page being edited, clamped to the document's page count.
  const curPageIndex = () => {
    const n = get().doc.pages.length;
    return n > 0 ? Math.min(get().activePage, n - 1) : 0;
  };

  // Center a new node in the visible viewport (in page coordinates), clamped to
  // the page artboard, so added elements appear where the user is looking rather
  // than at the page's top-left corner.
  const positionInView = (n: Node) => {
    const { zoom, panX, panY } = get().viewport;
    const vs = get().viewportSize;
    const page = get().doc.pages[curPageIndex()];
    const size = (n as unknown as { size?: { width: number; height: number } }).size;
    const w = size?.width ?? 100;
    const h = size?.height ?? 100;
    // screen = zoom*(page - pan)  =>  page = screen/zoom + pan
    const cx = vs.width > 0 && zoom > 0 ? panX + vs.width / 2 / zoom : page.width / 2;
    const cy = vs.height > 0 && zoom > 0 ? panY + vs.height / 2 / zoom : page.height / 2;
    const x = Math.max(0, Math.min(cx - w / 2, Math.max(0, page.width - w)));
    const y = Math.max(0, Math.min(cy - h / 2, Math.max(0, page.height - h)));
    const t = (n as unknown as { transform: Transform }).transform;
    (n as unknown as { transform: Transform }).transform = { ...t, x, y };
  };

  return {
    doc: sampleDesign(),
    selection: [],
    viewport: { zoom: 0.6, panX: -80, panY: -60 },
    rev: 0,
    savedRev: 0,
    markClean: () => set((s) => ({ savedRev: s.rev })),
    tool: "select",
    cropping: null,
    editingTextId: null,
    presenting: false,
    showRulers: true,
    showGrid: false,
    gridSize: 50,
    snapEnabled: true,
    guides: {},
    snapGuides: null,
    playing: false,
    activePage: 0,
    viewportSize: { width: 0, height: 0 },
    undoStack: [],
    redoStack: [],
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
        doc: file,
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

    setActivePage: (index) =>
      set((s) => ({
        activePage: Math.max(0, Math.min(index, s.doc.pages.length - 1)),
        selection: [],
        rev: s.rev + 1,
      })),
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
    magicResizePages: (targets) => {
      const doc = get().doc;
      const idx = curPageIndex();
      const src = doc.pages[idx];
      if (!src || !targets.length) return [];
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
            name: "Accent",
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
    setPageSize: (width, height) => {
      const page = get().doc.pages[curPageIndex()];
      if (!page) return;
      const before = { width: page.width, height: page.height };
      const w = Math.max(1, Math.round(width));
      const h = Math.max(1, Math.round(height));
      if (before.width === w && before.height === h) return;
      perform(
        () => { page.width = w; page.height = h; },
        () => { page.width = before.width; page.height = before.height; },
      );
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
    addPage: () => {
      const doc = get().doc;
      const cur = doc.pages[curPageIndex()];
      const tmpl = createBlankDesign({ width: cur.width, height: cur.height });
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
        return { viewport: { ...merged, zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, merged.zoom)) } };
      }),
    setViewportSize: (width, height) =>
      set((s) => (s.viewportSize.width === width && s.viewportSize.height === height ? {} : { viewportSize: { width, height } })),
    fitToScreen: () => {
      const { width: vw, height: vh } = get().viewportSize;
      const page = get().doc.pages[curPageIndex()];
      if (!vw || !vh || !page) return;
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(vw / page.width, vh / page.height) * 0.9));
      get().setViewport({ zoom, panX: page.width / 2 - vw / 2 / zoom, panY: page.height / 2 - vh / 2 / zoom });
    },
    zoomToSelection: () => {
      const { doc, selection, viewportSize } = get();
      const { width: vw, height: vh } = viewportSize;
      if (!selection.length) return get().fitToScreen();
      const b = unionAABB(doc, selection);
      if (!b || !vw || !vh) return;
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(vw / b.width, vh / b.height) * 0.8));
      get().setViewport({ zoom, panX: b.x + b.width / 2 - vw / 2 / zoom, panY: b.y + b.height / 2 - vh / 2 / zoom });
    },

    setSnapGuides: (g) => set({ snapGuides: g }),
    setTool: (tool) => set({ tool }),
    setCropping: (id) => set({ cropping: id }),
    setEditingText: (id) => set({ editingTextId: id }),
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
        name: shape === "rect" ? "Rectangle" : "Ellipse",
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
        name: "Text",
        transform: { x, y, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 240, height: 44 },
        // Auto-height by default (Canva-style): the box grows with the typed text;
        // dragging the top/bottom handle switches it to a fixed height.
        box: { mode: "autoHeight", width: 240, height: 44, autoFit: { enabled: false, min: 8, max: 512 }, verticalAlign: "top" },
        content: [{ runs: [{ text: "Text", style: { fontFamily: "system", fontStyle: "Regular", fontSize: 32, fill: { type: "solid", color: { srgb: { r: 0.1, g: 0.12, b: 0.16, a: 1 } } } } }], style: { align: "left", direction: "auto" } }],
      } as Partial<Node>);
      const page = get().doc.pages[curPageIndex()];
      const prev = get().selection;
      perform(
        () => { page.children.push(node); set({ selection: [node.id] }); },
        () => { const i = page.children.findIndex((n) => n.id === node.id); if (i >= 0) page.children.splice(i, 1); set({ selection: prev }); },
      );
      return node.id;
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
      const n = loc.node as unknown as { segments: unknown; transform: unknown; size: unknown };
      return structuredClone({ segments: n.segments, transform: n.transform, size: n.size });
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
      const after = structuredClone({ segments: n.segments, transform: n.transform, size: n.size });
      const apply = (snap: { segments: unknown; transform: unknown; size: unknown }) => {
        const l = locate(get().doc, id);
        if (!l) return;
        const m = l.node as unknown as { segments: unknown; transform: Record<string, unknown>; size: unknown };
        m.segments = structuredClone(snap.segments);
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
      const node = createNode("path", {
        name: "Pencil",
        segments: segs,
        closed: false,
        stroke: { fill: { type: "solid", color: { srgb: { r: 0.1, g: 0.12, b: 0.16, a: 1 } } }, width: 3, align: "center", cap: "round", join: "round" },
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
        name: "Outline", op: "union", operands: [], result: outline, fills: [stroke.fill],
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
          name: "Line", closed: false,
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
      const animated: { id: string; anim: NodeAnimation; opacity: number; transform: Transform }[] = [];
      const walk = (nodes: Node[]) => {
        for (const n of nodes) {
          const a = (n as unknown as { animation?: NodeAnimation }).animation;
          if (a && (a.entrance || a.emphasis)) animated.push({ id: n.id, anim: a, opacity: n.opacity, transform: { ...n.transform } });
          const kids = (n as unknown as { children?: Node[] }).children;
          if (Array.isArray(kids)) walk(kids);
        }
      };
      walk(get().doc.pages[curPageIndex()].children);
      if (!animated.length) return;
      set({ playing: true });
      // Run entrances to completion, then loop emphasis for a short window.
      const entranceTotal = Math.max(0, ...animated.map((x) => (x.anim.entrance ? x.anim.entrance.delayMs + x.anim.entrance.durationMs : 0)));
      const hasEmphasis = animated.some((x) => x.anim.emphasis);
      const total = entranceTotal + (hasEmphasis ? 2400 : 200);
      const restore = () => {
        for (const x of animated) {
          const loc = locate(get().doc, x.id);
          if (loc) { loc.node.opacity = x.opacity; loc.node.transform = x.transform; }
        }
      };
      const start = performance.now();
      const step = () => {
        if (!get().playing) { restore(); return; }
        const t = performance.now() - start;
        for (const x of animated) {
          const loc = locate(get().doc, x.id);
          if (!loc) continue;
          // Entrance leads; once it has finished, the resting pose is the base
          // for a looping emphasis. Compose the active patch over the resting node.
          let patch: AnimPatch | null = null;
          if (x.anim.entrance && t <= x.anim.entrance.delayMs + x.anim.entrance.durationMs) {
            patch = entrancePatch(x.anim.entrance, t);
          } else if (x.anim.emphasis) {
            patch = emphasisPatch(x.anim.emphasis, t - entranceTotal);
          } else if (x.anim.entrance) {
            patch = entrancePatch(x.anim.entrance, x.anim.entrance.delayMs + x.anim.entrance.durationMs);
          }
          applyPatch(loc.node, x.transform, x.opacity, patch);
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
        series: [{ name: "Series 1", values: [12, 19, 8, 15], color: seriesColorAt(0) }],
        options: {},
        style: { legend: { show: true, position: "bottom" }, valueLabels: false },
        transform: { x: 200, y: 200, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 360, height: 240 },
      } as unknown as Partial<Node>);
    },
    insertChartData: (data) => {
      const series = data.series.length
        ? data.series.map((s, i) => ({ name: s.name, values: s.values, color: seriesColorAt(i) }))
        : [{ name: "Series 1", values: [], color: seriesColorAt(0) }];
      const node = createNode("chart", {
        chartType: data.chartType,
        categories: data.categories,
        series,
        options: {},
        style: { legend: { show: true, position: "bottom" }, valueLabels: false },
        transform: { x: 200, y: 200, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 480, height: 320 },
      } as unknown as Partial<Node>);
      positionInView(node);
      const page = get().doc.pages[curPageIndex()];
      const prev = get().selection;
      perform(
        () => { page.children.push(node); set({ selection: [node.id] }); },
        () => { const i = page.children.findIndex((n) => n.id === node.id); if (i >= 0) page.children.splice(i, 1); set({ selection: prev }); },
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
        try {
          const res = await fetch(b.url);
          if (!res.ok) return false;
          csv = await res.text();
        } catch {
          return false;
        }
      }
      const matrix = parseCsvMatrix(csv);
      if (!matrix.length) return false;
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
        navigator.clipboard.writeText(OC_CLIP_PREFIX + JSON.stringify(nodes)).catch(() => {});
      }
    },
    cutSelection: () => {
      get().copySelection();
      if (get().selection.length) get().deleteSelection();
    },
    paste: () => {
      if (!clipboardNodes?.length) return;
      const { nodes } = remapIds(structuredClone(clipboardNodes));
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
    },
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
    },
    addTextBox: (text, at) => {
      const node = createNode("text", {
        name: text.slice(0, 24) || "Text",
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 360, height: 80 },
        box: { mode: "fixed", width: 360, height: 80, autoFit: { enabled: false, min: 8, max: 512 }, verticalAlign: "top" },
        content: [{ runs: [{ text, style: { fontFamily: "system", fontStyle: "Regular", fontSize: 24, fill: { type: "solid", color: { srgb: { r: 0.1, g: 0.12, b: 0.16, a: 1 } } } } }], style: { align: "left", direction: "auto" } }],
      } as Partial<Node>);
      if (at) (node as unknown as { transform: Transform }).transform = { x: at.x, y: at.y, scaleX: 1, scaleY: 1, rotation: 0 };
      else positionInView(node);
      const page = get().doc.pages[curPageIndex()];
      const prev = get().selection;
      perform(
        () => { page.children.push(node); set({ selection: [node.id] }); },
        () => { const i = page.children.findIndex((n) => n.id === node.id); if (i >= 0) page.children.splice(i, 1); set({ selection: prev }); },
      );
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
    },
    pushNodeSnapshot: (id, before) => {
      type Snap = { transform: Transform; size: { width: number; height: number }; box?: unknown; content?: unknown };
      const apply = (snap: Snap) => {
        const l = locate(get().doc, id);
        if (!l) return;
        const n = l.node as unknown as Snap;
        n.transform = { ...snap.transform };
        n.size = { ...snap.size };
        if (snap.box !== undefined) n.box = structuredClone(snap.box);
        if (snap.content !== undefined) n.content = structuredClone(snap.content);
      };
      const l = locate(get().doc, id);
      if (!l) return;
      const cur = l.node as unknown as Snap;
      const after: Snap = { transform: { ...cur.transform }, size: { ...cur.size }, box: cur.box !== undefined ? structuredClone(cur.box) : undefined, content: cur.content !== undefined ? structuredClone(cur.content) : undefined };
      const b: Snap = { transform: { ...before.transform }, size: { ...before.size }, box: before.box !== undefined ? structuredClone(before.box) : undefined, content: before.content !== undefined ? structuredClone(before.content) : undefined };
      set((s) => ({ rev: s.rev + 1, undoStack: [...s.undoStack, { undo: () => apply(b), redo: () => apply(after) }], redoStack: [] }));
    },

    addNode: (type, init) => {
      const node = createNode(type, init);
      positionInView(node);
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
    },

    addIconSvg: (svg) => {
      const { nodes } = svgToNodes(svg, () => `ic-${crypto.randomUUID()}`);
      if (!nodes.length) return;
      // The parsed nodes are in the SVG viewBox space (e.g. 0..24); scale the
      // whole group up to a sensible on-canvas size and center it in the view.
      const vb = /viewBox\s*=\s*"([^"]+)"/i.exec(svg)?.[1]?.trim().split(/[\s,]+/).map(Number);
      const vbW = (vb && vb[2]) || 24;
      const vbH = (vb && vb[3]) || 24;
      const scale = 200 / Math.max(vbW, vbH);
      const { zoom, panX, panY } = get().viewport;
      const vs = get().viewportSize;
      const page = get().doc.pages[curPageIndex()];
      const cx = vs.width > 0 && zoom > 0 ? panX + vs.width / 2 / zoom : page.width / 2;
      const cy = vs.height > 0 && zoom > 0 ? panY + vs.height / 2 / zoom : page.height / 2;
      const group = createNode("group", {
        name: "Icon",
        children: nodes,
        transform: { x: cx - (scale * vbW) / 2, y: cy - (scale * vbH) / 2, scaleX: scale, scaleY: scale, rotation: 0 },
        size: { width: vbW, height: vbH },
      } as Partial<Node>);
      const prev = get().selection;
      perform(
        () => { page.children.push(group); set({ selection: [group.id] }); },
        () => { const i = page.children.findIndex((n) => n.id === group.id); if (i >= 0) page.children.splice(i, 1); set({ selection: prev }); },
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
      // already matches the page, e.g. a same-size Canva export).
      const scale = Math.min(page.width / vbW, page.height / vbH, 1);
      const gx = (page.width - vbW * scale) / 2 - minX * scale;
      const gy = (page.height - vbH * scale) / 2 - minY * scale;
      const doc = get().doc;
      const refs: AssetRef[] = assets.map((a) => ({ id: a.assetId, kind: "image", url: a.url, mime: "image/*", checksum: "" }));
      const group = createNode("group", {
        name: "Imported SVG",
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
    addImage: (url, at) => {
      const assetId = `asset-${crypto.randomUUID()}`;
      const node = createNode("image", {
        source: { assetId, naturalWidth: 0, naturalHeight: 0 },
        fit: "cover",
        transform: { x: 260, y: 260, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 320, height: 240 },
      } as Partial<Node>);
      // Center on the drop point if given (drag-drop), else in the viewport.
      if (at) (node as unknown as { transform: Transform }).transform = { x: at.x - 160, y: at.y - 120, scaleX: 1, scaleY: 1, rotation: 0 };
      else positionInView(node);
      const doc = get().doc;
      const page = doc.pages[curPageIndex()];
      // checksum is a real content hash once ingested; placement does
      // not have the bytes, so leave it empty rather than faking it with the id.
      const ref: AssetRef = { id: assetId, kind: "image", url, mime: "image/*", checksum: "" };
      const prevSelection = get().selection;
      perform(
        () => {
          doc.assets.push(ref);
          page.children.push(node);
          set({ selection: [node.id] });
        },
        () => {
          const i = page.children.findIndex((n) => n.id === node.id);
          if (i >= 0) page.children.splice(i, 1);
          const ai = doc.assets.findIndex((a) => a.id === assetId);
          if (ai >= 0) doc.assets.splice(ai, 1);
          set({ selection: prevSelection });
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
            const aspect = img.naturalWidth / (img.naturalHeight || img.naturalWidth);
            n.size = { width: n.size.width, height: Math.max(1, Math.round(n.size.width / aspect)) };
            get().tick();
          }
          off(); // ready or missing: stop listening either way
        });
      }
    },

    setImageSource: (id, url) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "image" || loc.node.locked || editBlocked(id)) return;
      const node = loc.node as unknown as { source: { assetId: string; naturalWidth: number; naturalHeight: number }; crop?: CropRect };
      const doc = get().doc;
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
            const aspect = img.naturalWidth / (img.naturalHeight || img.naturalWidth);
            n.size = { width: n.size.width, height: Math.max(1, Math.round(n.size.width / aspect)) };
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
        name: src.name ?? "Frame",
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
      // Register the asset and repaint once it loads (cover-fit reads natural dims).
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
    setFrameImage: (id, url) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "frame") return;
      const frame = loc.node as unknown as { size: { width: number; height: number }; children: Node[]; clip?: boolean };
      const doc = get().doc;
      const assetId = `asset-${crypto.randomUUID()}`;
      const ref: AssetRef = { id: assetId, kind: "image", url, mime: "image/*", checksum: "" };
      const child = createNode("image", {
        source: { assetId, naturalWidth: 0, naturalHeight: 0 },
        fit: "cover",
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: frame.size.width, height: frame.size.height },
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
      perform(
        () => {
          node.content = after;
        },
        () => {
          node.content = structuredClone(before);
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
      perform(
        () => changed.forEach((n, i) => { n.content = structuredClone(after[i]) as never; }),
        () => changed.forEach((n, i) => { n.content = structuredClone(before[i]) as never; }),
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
      // the mapping once per distinct source color.
      const mapColor = (c: Color | undefined): Color | undefined => {
        if (!c || brand.palette.length === 0) return c;
        const from = toHex(c);
        const override = ov[from.toLowerCase()];
        let to: string;
        if (override !== undefined) {
          if (override === "keep") return c; // user chose to keep the original
          to = override;
        } else {
          const m = nearestPaletteColor(c, brand.palette);
          if (!m) return c;
          to = toHex(m.color);
        }
        if (from !== to && !colorSeen.has(from)) {
          colorSeen.add(from);
          colors.push({ from, to });
        }
        if (from === to) return c;
        const toColor = fromHex(to);
        if (!toColor) return c; // malformed override hex: leave the color untouched
        // Preserve the original alpha so a re-skin never makes a color opaque.
        return { srgb: { ...toColor.srgb, a: c.srgb.a } };
      };
      const mapFill = (fill: Fill | undefined): Fill | undefined => {
        if (!fill) return fill;
        const f = fill as unknown as { type?: string; color?: Color; stops?: { color: Color }[] };
        if (f.type === "solid" && f.color) return { ...fill, color: mapColor(f.color) } as Fill;
        if (Array.isArray(f.stops))
          return { ...fill, stops: f.stops.map((s) => ({ ...s, color: mapColor(s.color)! })) } as Fill;
        return fill;
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
        if (rec.fills) rec.fills = rec.fills.map((f) => mapFill(f)!) as Fill[];
        if (rec.stroke) {
          if (rec.stroke.fill) rec.stroke.fill = mapFill(rec.stroke.fill);
          if (rec.stroke.color) rec.stroke.color = mapColor(rec.stroke.color);
        }
        for (const para of rec.content ?? [])
          for (const run of para.runs) {
            if (run.style.fill) run.style.fill = mapFill(run.style.fill);
            if (run.style.color) run.style.color = mapColor(run.style.color);
            run.style.fontFamily = mapFont(run.style.fontFamily);
          }
        for (const kid of rec.children ?? []) applyNode(kid);
      };

      // One undo step over the whole pages array (before/after deep clones), so
      // re-skin + every individual remap is a single reversible operation.
      const before = structuredClone(doc.pages);
      for (const page of doc.pages) {
        const pg = page as unknown as { background?: Fill };
        if (pg.background) pg.background = mapFill(pg.background);
        for (const n of page.children) applyNode(n);
      }
      if (colors.length === 0 && fonts.length === 0) {
        // Nothing changed; revert any structural identity churn and skip the
        // undo entry so the history stays clean.
        doc.pages = structuredClone(before) as never;
        return { colors, fonts };
      }
      const after = structuredClone(doc.pages);
      perform(
        () => { get().doc.pages = structuredClone(after) as never; },
        () => { get().doc.pages = structuredClone(before) as never; },
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
          for (const k of ["fills", "stroke", "content"]) {
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
      // Auto-grow height (Canva-style) ONLY for auto-height boxes; a fixed box
      // keeps the user's chosen height (text overflows / auto-fits instead). The
      // undo baseline is the height before editing began (boxHeightBefore) when
      // known, so transient live-grow during typing reverts cleanly.
      const autoHeight = node.box.mode === "autoHeight";
      const hBefore = boxHeightBefore ?? node.size.height;
      const hNext = autoHeight && boxHeight != null && Math.abs(boxHeight - hBefore) > 0.5 ? boxHeight : hBefore;
      perform(
        () => { node.content = structuredClone(after); node.size.height = hNext; node.box.height = hNext; },
        () => { node.content = structuredClone(before); node.size.height = hBefore; node.box.height = hBefore; },
      );
    },
    growTextBoxLive: (id, height) => {
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "text" || loc.node.locked || editBlocked(id)) return;
      const node = loc.node as unknown as { size: { width: number; height: number }; box: { height: number; mode?: string } };
      if (node.box.mode !== "autoHeight") return; // fixed boxes keep the user's height
      const h = Math.max(1, height);
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
      const node = loc.node as unknown as { textEffects?: TextEffect[] };
      const before = node.textEffects;
      // Effects are exclusive; keep only the background highlight, then add the
      // chosen one (if any).
      const kept = (before ?? []).filter((e) => e.kind === "highlight");
      const next = effect ? [...kept, effect] : kept;
      perform(
        () => { node.textEffects = (next.length ? next : undefined) as never; },
        () => { node.textEffects = before; },
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

    setTextStyle: (id, char, para) => {
      if (!char && !para) return;
      const loc = locate(get().doc, id);
      if (!loc || loc.node.type !== "text" || loc.node.locked || editBlocked(id)) return;
      const node = loc.node as unknown as {
        content: { runs: { style: Record<string, unknown> }[]; style: Record<string, unknown> }[];
      };
      const before = structuredClone(node.content);
      perform(
        () => {
          node.content.forEach((p) => {
            if (para) Object.assign(p.style, para);
            if (char) p.runs.forEach((r) => Object.assign(r.style, char));
          });
        },
        () => {
          node.content = structuredClone(before);
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
      if (!loc || loc.node.type !== "image" || loc.node.locked || editBlocked(id)) return;
      const rec = loc.node as unknown as { crop?: CropRect; fit: ImageFit };
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
          for (const p of content) for (const r of p.runs) {
            if (r.style.fontFamily && fontMap.has(r.style.fontFamily)) r.style.fontFamily = fontMap.get(r.style.fontFamily)!;
            const f = r.style.fill;
            if (f && f.type === "solid") {
              const to = colorMap.get(toHex(f.color).toLowerCase());
              if (to) r.style.fill = { type: "solid", color: hexToColor(to) };
            }
          }
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
          for (const k of ["fills", "cornerRadius", "content"]) {
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

    undo: () => {
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
