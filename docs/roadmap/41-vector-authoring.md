# F41: Vector authoring depth

| Field | Value |
| --- | --- |
| Feature ID | F41 |
| Phase | 5 Creation depth |
| Sequence | 41 |
| Status | Not started |
| Depends on | F40 (procedural node graph and non-destructive evaluation: this spec's live booleans and path effects are procedural operators owned there), F44 (GPU rendering path, for tessellation and hit-testing at anchor scale; Canvas2D stays the always-available baseline), F16 (realtime/CRDT: anchor-level concurrent edits), F38 (accessibility/i18n/NFR), `@hc/schema` (open file format + forward migration), `@hc/engine` (framework-agnostic Canvas2D scene graph), `@hc/geometry` (framework-agnostic path math) |

HyCanvas ships vector primitives (a pen tool, editable bezier anchors, compound paths, boolean combine, stroke-to-outline) but it is a layout tool that can draw curves, not a tool a designer or a digital artist can build finished artwork in. This spec closes that gap: a pen and direct-selection model with real handle semantics, live boolean operations whose operands stay editable, parametric path effects that never bake until the user says so, a shape builder, text as vector (on a path, in a shape, and converted to outlines), gradient meshes, image trace, a geometric constraint solver for technical drawing, and the precision layer (anchor snapping, angle and length readouts, numeric entry, measurement) that separates an illustration tool from a shape editor. Every capability lands as editable nodes in the open file format, renders identically in the browser and in the Go headless export path, and is added additively so a design authored by any earlier version keeps opening.

## Current state

Audited against the code: `packages/schema/src/schema.ts` (`Stroke`/`StrokeSchema` 259-276, `VectorAnchor`/`SubPath`/`VectorPath` 504-545, `ShapeNode` 944-970, `LineNode` 972-990, `PathSegment`/`PathContour`/`PathNode` 992-1038, `MaskNode` 1497-1512, `BooleanNode` 1514-1531, `KNOWN_NODE_TYPES` 630-636, `UnknownNodeSchema` 1712-1718, `KnownNodeSchema`/`NodeSchema` 1759-1771, `CURRENT_SCHEMA_VERSION = 17`) + `packages/schema/src/migrate.ts` (the `migrations` map keyed by source version) + `packages/schema/src/validate.ts` (`validate`, `SHALLOW_NODE_SCHEMAS`); `packages/geometry/src/{types,shapes,flatten,query,boolean,simplify,stroke,connector}.ts`; `packages/engine/src/{render2d,scene,hit,spatial,pathclip}.ts`; `packages/editor/src/{snapping,arrange,transform,resize}.ts`; `frontend/src/components/editor/{Canvas,PathEditor,PropertiesPanel,CommandMenu,SelectionToolbar}.tsx`; `frontend/src/store/editor.ts`; `frontend/src/lib/{maskPath,svgFlatten}.ts` + `packages/stock/src/svg.ts` (`svgToNodes`); `packages/export/src/svg.ts`; backend `internal/render/{raster,nodes_extra,svg,pdf,pdfttf}.go` and `internal/persistence/{file,validate}.go`.

What ships. The schema carries two independent path representations. `VectorPath` (`subpaths[]` of `VectorAnchor` with `inHandle`/`outHandle`/`corner`, plus a `fillRule`) is the shared geometry type used by `MaskNode.maskShape`, `BooleanNode.result`, and the connector router. `PathNode` uses a different one: a flat `segments: PathSegment[]` (`x`/`y`/`cIn`/`cOut`/`corner`) plus `closed`, plus an optional `contours: PathContour[]` for compound paths (schema v15, filled together under even-odd so imported line art keeps its counters). Nothing converts between the two centrally; each call site hand-rolls it (`store/editor.ts` `strokeToOutlineSelection` and `recognizeSelectedPath`, `lib/maskPath.ts` `frameMaskFor`).

`@hc/geometry` is a real, pure, framework-agnostic core: `shapes.ts` turns a `ShapeNode` into a `VectorPath` (`shapeNodeToParametric` + `shapeToPath`, rounded rect / ellipse / regular polygon / star / line, `KAPPA` circle fitting); `flatten.ts` samples cubics to polylines at a fixed 16 steps; `query.ts` gives `bounds` and `pointInPath` (nonzero winding and even-odd parity); `simplify.ts` ships Douglas-Peucker `simplifyPolyline` and a Schneider-style `fitCubicBeziers` with recursive error subdivision; `stroke.ts` ships `strokeToOutline` (polyline offsetting with disc joins) and `recognizeShape` (freehand to line/rect/ellipse/triangle/polygon); `boolean.ts` wraps `polygon-clipping` for union/subtract/intersect/exclude.

The editor already has a pen and a node editor. `Canvas.tsx` carries a `pen` tool (`onPenDown` at 1438-1463) with a rubber-band preview to the cursor, visible committed anchors, a highlighted first anchor that closes the path on click, and drag-to-pull-handles; `store/editor.ts` implements `penStart`/`penAdd`/`penHandle`/`penClose` (2392-2440). `PathEditor.tsx` is a real direct-selection overlay: drag anchors and handles through the node's full world matrix, click a segment to insert an anchor at the hovered parameter, double-click to convert corner and smooth, shift-click to multi-select anchors, Delete to remove them, Alt-click to delete one. It is backed by `snapshotPath`/`editAnchor`/`editHandle`/`insertAnchor`/`deleteAnchor`/`deleteAnchors`/`convertAnchor`/`commitPathEdit` (2899-3095), each gesture committing as one undo step. `addPencilPath` (3096) fits freehand input to smooth beziers. Boolean combine (`booleanSelection`, 3198-3260) and `strokeToOutlineSelection` (3261-3291) exist. Object-level precision ships: rulers and draggable guides in `Canvas.tsx`, `@hc/editor` `snapping.ts` (`snap`, `spacingSnap`, `resizeSpacingSnap`, `detectEqualSpacing`) and `arrange.ts` (`alignDeltas`, `distributeDeltas`, `tidyUpDeltas`), an Alt-hover distance measurement overlay, and arrow-key nudge.

The honest gaps, which is most of what an illustration tool is.

Pen. `penHandle` (2424-2434) unconditionally mirrors: it writes `cOut` from the cursor and sets `cIn` to the exact reflection. There is no modifier to break the pair, no asymmetric mode, no way to retract a handle to make the next segment straight, and no way to resume drawing from an open path's endpoint (`penStart` always creates a fresh node). The live preview shows a straight rubber band, not the actual curve the pending handle would produce. There is no rubber-band marquee over anchors: `PathEditor.tsx` selects only by click and shift-click.

Direct editing. There is no anchor nudge, no anchor align/distribute, no average or merge points, no join of two open endpoints, no split at an anchor, no simplify-with-tolerance on an existing path (`simplifyPolyline` and `fitCubicBeziers` are only reachable through the pencil), and no editing of `contours` beyond the primary one (`PathEditor.tsx` reads `node.segments` only, so a compound path's holes are not editable).

Booleans. `booleanSelection` accepts only `shape` operands (it filters `l.node.type === "shape"`), so a path, a boolean result, or a text node cannot participate. It flattens every operand through `pathToPolylines` at 16 fixed steps and stores the clipper's output as straight-line anchors, so all curvature is destroyed: `boolean.ts` says so in its header, and `multiPolyToPath` emits `corner: true` polyline anchors. `pathToMultiPoly` treats every subpath as a disjoint polygon rather than outer-plus-holes, so a boolean result reused as an operand loses its holes (documented at `boolean.ts:16-19`). The node is only nominally live: it clones the operands into `BooleanNode.operands` and bakes `result` once, and nothing ever re-reads or re-evaluates the operands, so editing an operand is impossible in the UI and would not repaint if it were. There are only four ops; divide, trim, merge, crop, and outline are absent. The only entry point is the command palette (`CommandMenu.tsx:75-78`); there is no shape builder and no on-canvas boolean affordance.

Path effects. None are parametric. `strokeToOutlineSelection` destroys the stroke and emits a baked `boolean` node. There is no offset path, no corner rounding on an arbitrary path (`cornerRadius` exists only on `ShapeNode`/`FrameNode`), no roughen or zigzag, no warp or envelope, no variable-width strokes (`Stroke.width` is a single scalar), no arrowhead system on paths (`startCap`/`endCap` exist only on `LineNode` and `ConnectorNode`), and dashes are a raw `number[]` with no pattern UI, no phase, and no dash alignment.

Text as vector. No text on a path, no text flowed into a shape, and no convert-to-outlines. `@hc/text` does layout and shaping but exposes no glyph outlines; the Go side reads the `glyf` table only to decide embeddability (`pdfttf.go` `hasTrueTypeOutlines`), never to extract contours.

Meshes, trace, constraints. No gradient or vector mesh of any kind (`Fill` covers solid, linear/radial gradient, pattern, image). No image trace. No geometric constraint solver, no dimension or constraint annotations.

Rendering and hit testing. `render2d.ts` `case "path"` (1064-1098) is solid: it traces cubics and compound contours and fills even-odd when contours exist. `case "boolean"` (1100-1119) draws only the pre-baked `result` with `lineTo`, and falls back to a placeholder box when `result` is absent. There is no `case "mask"` at all: `MaskNode` is a schema type that renders nowhere, in any renderer; the clipping that actually ships is the frame-level `maskShape`/`maskPath` pair consumed at `render2d.ts:1888-1900` through `pathclip.ts` `buildClipFromPathData`. `hit.ts` `pointInLocalShape` has precise cases for ellipse, triangle, polygon, star, line, and ink, and falls through to `inBox` for everything else, so `path` and `boolean` are selectable only by their bounding box even though `@hc/geometry` `pointInPath` exists.

Export parity. `raster.go` `rasterNode` (736-780) handles `path` and `boolean` (the latter through `nodes_extra.go` `rasterBoolean`, which traces the editor-baked `result` polyline and explicitly notes the editor already resolved the op). `svg.go` `emitNode` (650-685) and `pdf.go` (460-485) handle `path` but have no `boolean` and no `mask` case, so a boolean node exports to PNG and silently emits an "unsupported node type" comment in SVG and nothing in PDF. Nothing on the Go side can evaluate a boolean or a path effect itself; it can only draw what the browser baked.

Status legend: **Built** (ships today, code-referenced), **Partial** (some of it ships, gaps noted), **Planned (doc 40)** (the mechanism is owned by the procedural-core spec), **Planned (doc 44)** (depends on the GPU path), **Not started**.

## Sequencing

**F38 (accessibility, i18n, security, compliance, self-host, NFR) precedes this spec.** That ordering was set in August 2026 on adoption evidence: internationalisation and accessibility show more evidence of blocking adoption than creative depth does, and both are axes a desktop-native incumbent cannot follow the product onto. The reasoning is recorded in `README.md` under "Why F38 precedes the creation-depth set" and in F38's own Priority section.

This does not reduce the value of the work below; it places it second, and it means the parts worth pulling forward early are the ones that serve the existing audience. Measured demand from a template-first audience for pen and path authoring is very low; the exceptions with real pull are text on a simple arc and ingesting vector assets a user already owns. Treat the full authoring toolset as a deliberate move toward a different, more professional audience, made with open eyes, rather than as a natural continuation of the current product.

## 1. Context and Goal

The market bar for professional vector authoring is well established and has been stable for years: a pen tool with three handle modes and endpoint continuation; direct selection with marquee, nudge, align, join, split, average, and simplify; live booleans whose operands remain editable indefinitely; a stack of parametric path effects (offset, outline, corner, roughen, warp, variable width) that can be reordered and re-tuned at any time and expanded to plain geometry only on demand; a shape builder for drawing regions in and out of overlapping art; text on a path, text in a shape, and text converted to outlines; gradient meshes; raster-to-vector tracing with tunable parameters; and, in the technical-drawing corner of the market, a constraint solver that holds parallel, perpendicular, equal-length, tangent, and coincident relations while the rest of the drawing moves. Free and open tools cover parts of this; the complete set, in one tool, with a documented file format, does not exist for free.

HyCanvas's opening is structural rather than featural. The design file is the open `@hc/schema` format with forward-only migrations and a lossless `UnknownNode` round-trip, so parametric geometry can be a first-class, inspectable, scriptable part of the document instead of a proprietary blob. `@hc/geometry` is already a pure, dependency-light path core that runs in the browser, in a worker, and (once ported or shared) informs the headless server path. F40 is building a general non-destructive evaluation model, which means this spec does not need to invent a second one: a live boolean and an offset-path effect are the same thing, a procedural operator with typed parameters and a cached evaluated result, and they should be expressed that way. And because everything ships free and self-hostable, the parametric layer is not a paid tier.

Intended outcome: an illustrator draws a logo with the pen tool, snapping anchors to existing geometry with live angle and length readouts and typing exact coordinates when needed; converts the wordmark to outlines and unions it with a badge shape while both operands stay editable behind the union; adds a 2px offset-path effect and a variable-width profile that stay parametric so the weight can be re-tuned a week later; traces a scanned sketch into editable curves with a tolerance slider; constrains the technical inset so its rails stay parallel and equal length as the artwork is resized; exports the whole thing to SVG and PDF with the same geometry the browser drew; and hands the file to a colleague still running last month's binary, who opens it, sees the correct artwork, and does not corrupt it.

## 2. Scope

In scope:
- The pen and curvature tooling: anchor placement, handle drag with mirrored/asymmetric/broken modes, handle retraction, path closing, continuation from an existing endpoint, and a live preview of the pending segment as an actual curve.
- Direct path editing: marquee anchor selection, keyboard nudge, align and distribute anchors, corner and smooth conversion, insert and delete on a segment, join and split, simplify with a tolerance, average and merge points, and editing every contour of a compound path.
- Live boolean operations (union, subtract, intersect, exclude, divide, trim, merge, crop, outline) whose operands remain individually editable, expressed as F40 procedural operators.
- Parametric path effects: offset path, outline (stroke to path), corner rounding, roughen and zigzag, warp and envelope distortion, variable-width profiles, and a dash and arrowhead system, all reorderable in a stack, all re-tunable, all expandable to plain geometry on demand.
- The shape builder: drag across overlapping art to add or subtract regions interactively.
- Text as vector: text on a path, text flowed into a shape, and conversion of text to editable outlines with glyph contours available to both renderers.
- Vector mesh and gradient mesh: a new node type, its editing model, and its rendering (browser and headless).
- Image trace: raster to editable vector with tunable thresholding, path fitting, colour quantization, and corner handling.
- A geometric constraint solver (parallel, perpendicular, equal length, tangent, coincident, horizontal, vertical, fixed distance, fixed angle) over anchors and segments, with a documented failure mode when a system is over-constrained.
- Precision aids specific to geometry: snapping to anchors, segments, intersections, tangents, and midpoints; live angle and length readouts; numeric entry of coordinates, angles, lengths, and radii; and geometry-aware measurement.
- The rendering, hit-testing, and export-parity work each of the above requires, in `@hc/engine` and in `backend/internal/render`.

Out of scope (owned elsewhere):
- The procedural graph itself: the operator model, the evaluation and caching strategy, the dependency graph, the layers-and-graph dual view, invalidation, and the UI for editing an operator stack (F40). This spec defines the geometry operators and the authoring gestures; F40 defines how they are stored, evaluated, and re-evaluated.
- The GPU rendering backend, tessellation, and the general large-scene render budget (F44). This spec states the anchor-scale requirements that ride on it and the Canvas2D fallback each feature must have.
- Raster imaging and painting on the same canvas (F42). Image trace consumes a raster; it does not own raster editing.
- Motion and animation over vector geometry (F43). Animating a path effect's parameters is F43 plus F40; this spec only requires that parameters be plain animatable scalars.
- Professional file interop breadth and colour management (F45). This spec owns SVG fidelity for the geometry it introduces; AI/EPS/PDF-as-source ingestion and ICC/CMYK are F45.
- The base CRDT, presence, and lock mechanics (F16). This spec specifies how anchor-level edits behave under merge and what F16 must expose to make that work.
- Cross-cutting a11y, i18n, security, and self-host infrastructure (F38).

Deferred:
- Full-document parametric symmetry and pattern-along-path (repeat an object along a curve with spacing and rotation rules). It is a natural F40 operator but adds a second dependent-instances model; revisit after the effect stack ships.
- Live corner and fillet editing driven by on-canvas handles inside the shape builder (as opposed to a corner-rounding effect with a numeric radius).
- Perspective and isometric grids with automatic plane projection. The constraint solver covers most technical-drawing needs; a projection model is a separate coordinate concern.
- Mesh-to-mesh morphing and mesh warp of raster content (belongs with F42/F43 once meshes exist).
- Auto-tracing of video frames (an AI-media concern, `23-ai-media.md`).

## 3. User Stories

- As an illustrator, I want a pen tool where I can break a handle mid-draw, retract a handle to start a straight run, and pick a path back up from its open end, so I can draw a finished curve in one pass instead of drawing and then repairing.
- As a designer, I want to union two shapes and still be able to move, rotate, and reshape each original afterwards, so combining is a decision I can revise instead of a commitment.
- As a designer, I want an offset path and a corner rounding that stay as parameters I can re-tune, and a single command that expands them to plain geometry when I need to hand the file to something dumber.
- As a logo designer, I want to convert type to outlines and then edit the letterforms as curves, and I want the outlines to render identically in the browser preview and in the exported PDF.
- As a digital artist, I want to drag the shape builder across overlapping circles and pull out the exact regions I want as new filled shapes, without setting up boolean operands first.
- As an illustrator, I want a gradient mesh so I can shade a form smoothly instead of stacking twenty gradient-filled shapes.
- As anyone with a scan or a screenshot, I want to trace it into editable curves and tune the tolerance until the result is clean, with the result landing as ordinary editable path nodes.
- As a technical drawer, I want to declare that two segments stay parallel and equal in length, and have that hold while I drag the rest of the drawing.
- As a precise worker, I want to snap an anchor to another path's intersection, see the angle and length while I drag, and type an exact value instead of nudging.
- As a keyboard and screen-reader user, I want to select, move, add, and delete anchors without a pointer, and hear where I am on the path.
- As a collaborator, I want two people editing different anchors of the same path to converge, and I want to know when we are editing the same one.
- As a self-hoster, I want everything above to export from the headless Go renderer with the same geometry the browser drew, with no paid tier and no watermark.

## 4. Feature matrix / scope

Status values: **Built**, **Partial**, **Planned (doc 40)**, **Planned (doc 44)**, **Not started**. Priority: P0 is required for the feature to be credible, P1 completes the professional set, P2 is depth.

### Pen and path creation

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Pen tool: place anchors, live preview, close on first anchor | Built | `Canvas.tsx` `onPenDown` (1438-1463), pen overlay (3267-3294); `store/editor.ts` `penStart`/`penAdd`/`penClose` (2392-2440) | Rubber band is a straight line to the cursor, not the pending curve. Fix as part of FR-2. |
| Drag to pull bezier handles while placing | Partial | `store/editor.ts` `penHandle` (2424-2434) | Always mirrors: writes `cOut` and reflects it into `cIn`. No modifier breaks the pair. P0. |
| Handle modes: mirrored / asymmetric / broken | Not started | n/a | Alt (or Option) while dragging breaks the pair; a per-anchor `handleMode` records the intent so it survives reload. P0, FR-3. |
| Handle retraction (zero-length handle for a straight next segment) | Not started | n/a | Click the just-placed anchor to drop its out-handle. P0. |
| Continue an existing open path from an endpoint | Not started | n/a | `penStart` always creates a new node. Hovering an open endpoint with the pen must resume that path. P0, FR-4. |
| Curvature (smooth-through) pen mode | Not started | n/a | Place points and let the tool solve tangents for a G1-continuous curve. P1. |
| Freehand pencil with bezier fitting | Built | `store/editor.ts` `addPencilPath` (3096); `@hc/geometry` `fitCubicBeziers` | Fit tolerance is fixed; expose it (FR-11 shares the control). |
| Freehand-to-shape recognition | Built | `store/editor.ts` `recognizeSelectedPath` (3292); `@hc/geometry` `recognizeShape` | Manual panel button only. |
| Draw straight segments with angle constraint (Shift) during pen | Not started | n/a | 15-degree increments with a live readout. P1, pairs with FR-40. |

### Direct path editing

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Drag anchors and handles on a selected path | Built | `PathEditor.tsx`; `store/editor.ts` `editAnchor`/`editHandle` (2905-2949) | Works through the full world matrix, so rotated and scaled paths edit correctly. |
| Click-select and shift-multi-select anchors | Built | `PathEditor.tsx` `begin`/`setSelAnchors` | No marquee. |
| Marquee (rubber-band) anchor selection | Not started | n/a | Drag on empty canvas in node mode selects every anchor inside. P0, FR-6. |
| Nudge selected anchors with arrow keys | Not started | n/a | Arrow keys currently nudge the whole node (`Canvas.tsx` 2664-2666). In node mode they must nudge anchors. P0, FR-7. |
| Align / distribute selected anchors | Not started | n/a | Reuse the `@hc/editor` `arrange.ts` deltas model over points instead of rects. P1, FR-8. |
| Convert corner and smooth | Built | `store/editor.ts` `convertAnchor` (3057-3095); `PathEditor.tsx` double-click | Marker shape already distinguishes them. |
| Insert an anchor on a segment | Built | `store/editor.ts` `insertAnchor` (2974-3017); `PathEditor.tsx` segment hit-lines | De Casteljau split preserving the curve. |
| Delete anchors, rejoining neighbours | Built | `store/editor.ts` `deleteAnchor`/`deleteAnchors` (3018-3056) | No curve-preserving delete (refit the remaining span). P2. |
| Join two open endpoints | Not started | n/a | Both within one path (close) and across two paths (merge into one node). P0, FR-9. |
| Split a path at an anchor or a segment point | Not started | n/a | Produces two nodes (or two contours). P0, FR-9. |
| Simplify a path with a tolerance | Partial | `@hc/geometry` `simplifyPolyline` + `fitCubicBeziers` exist | Not reachable for an existing path, and there is no tolerance UI or live preview. P1, FR-11. |
| Average points / merge coincident points | Not started | n/a | Average on one or both axes; merge collapses to a single anchor. P1, FR-10. |
| Edit every contour of a compound path | Not started | `PathEditor.tsx` reads `node.segments` only | Holes added by the v15 `contours` field are invisible to the node editor. P0, FR-12. |
| Reverse path direction | Not started | n/a | Matters for even-odd holes, arrowheads, and text-on-path direction. P1. |
| Anchor-precise hit testing | Not started | `engine/src/hit.ts` `pointInLocalShape` default branch | `path` and `boolean` hit-test as bounding boxes; `@hc/geometry` `pointInPath` is already available. P0, FR-43. |

### Booleans and shape building

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Union / subtract / intersect / exclude | Built | `store/editor.ts` `booleanSelection` (3198-3260); `@hc/geometry` `booleanOp`; `CommandMenu.tsx:75-78` | Shape operands only, curves flattened to polylines, result baked once. |
| Operands stay editable after the operation | Not started | `BooleanNode.operands` is a dead clone | Nothing re-evaluates. This is the headline gap; owned by F40's evaluation model. P0, FR-13. |
| Any node as an operand (path, boolean, text outline, group) | Not started | filter at `booleanSelection` | Restricting to `shape` makes booleans unusable for real artwork. P0, FR-14. |
| Curve-preserving boolean results | Not started | `@hc/geometry` `boolean.ts` header and `multiPolyToPath` | Flatten-clip-refit: run the clipper on a dense flattening, then refit each output run with `fitCubicBeziers` against the original operand curves. P0, FR-15. |
| Correct hole nesting in results | Not started | `boolean.ts:16-19` (documented limitation) | Ring-nesting analysis so a result reused as an operand keeps its holes. P0, FR-15. |
| Divide / trim / merge / crop / outline | Not started | n/a | Divide splits every overlap into separate faces; trim and merge are the paint-order pair; outline turns the arrangement into stroked segments. P1, FR-16. |
| Shape builder (drag to add or subtract regions) | Not started | n/a | Requires the planar arrangement (faces and edges) that divide already needs. P1, FR-17. |
| On-canvas boolean affordance (not palette-only) | Not started | `CommandMenu.tsx` is the only entry | Put the ops on the selection toolbar with modifier variants. P0. |
| Boolean rendering in the browser | Partial | `render2d.ts` `case "boolean"` (1100-1119) | Draws the baked `result` with `lineTo` only; must trace beziers once results keep curvature. P0. |
| Boolean rendering in headless export | Partial | `raster.go` -> `nodes_extra.go` `rasterBoolean` (122-140) | PNG works from the baked result; `svg.go` and `pdf.go` have no `boolean` case at all, so SVG emits an unsupported-node comment and PDF emits nothing. P0, FR-53. |
| `MaskNode` rendering anywhere | Not started | `MaskNode` (schema 1497-1512) has no case in `render2d.ts`, `raster.go`, `svg.go`, or `pdf.go` | A schema type that renders nowhere. Either implement it against the frame `maskShape`/`pathclip.ts` machinery or state it as reserved. P1, FR-52. |

### Parametric path effects

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Effect stack on a path (ordered, re-tunable, per-effect enable) | Not started | n/a | Stored as an F40 operator chain; the geometry operators are defined here. P0, FR-18. |
| Offset path (inside / outside / both, join style, miter limit) | Not started | n/a | Needs a real offsetting routine; `strokeToOutline` is a polyline-plus-disc approximation, not an offsetter. P0, FR-19. |
| Outline / stroke to path (parametric) | Partial | `store/editor.ts` `strokeToOutlineSelection` (3261-3291) | Destroys the stroke and emits a baked boolean node. Reimplement as an effect with correct caps, joins, miter limit, and dash awareness. P0, FR-20. |
| Corner rounding on an arbitrary path | Not started | `cornerRadius` exists only on `ShapeNode`/`FrameNode` | Per-corner radius with a global default; must handle short adjacent segments. P1, FR-21. |
| Roughen / zigzag | Not started | n/a | Deterministic from a stored seed so the same file always renders the same. P1, FR-22. |
| Warp / envelope distortion (mesh or preset warps) | Not started | n/a | Envelope defined by a control mesh; shares the mesh math with gradient mesh. P1, FR-23. |
| Variable-width strokes (width profiles) | Not started | `Stroke.width` is a scalar | Profile as a list of `{t, width}` stops with interpolation; the renderer must emit a ribbon, not a stroked line. P1, FR-24. |
| Dash patterns with phase and alignment | Partial | `Stroke.dash?: number[]` exists (schema 265) | No phase, no UI, no dash-to-corner alignment, and no dash on `PathNode` in the Go SVG/PDF writers. P1, FR-27. |
| Arrowheads / markers on a path | Partial | `startCap`/`endCap` on `LineNode` and `ConnectorNode` only; `render2d.ts` `arrowhead` (1337-1350); Go `board.go` `arrowHead` (266-280) | No arrowheads on `PathNode`, no marker library, no per-end scale or alignment. P1, FR-28. |
| Expand appearance (bake the stack to plain geometry) | Not started | n/a | The escape hatch, and the mechanism that guarantees old-client fidelity. P0, FR-25. |
| Baked-geometry fallback stored alongside parameters | Not started | n/a | The zero-data-loss mechanism (section 7). P0, FR-26. |

### Text as vector

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Text on a path | Not started | n/a | Baseline follows a path with offset, alignment, flip, and spacing controls; text stays editable. P1, FR-29. |
| Text in a shape (area type) | Not started | `TextNode` is a rectangle box | Flow text into an arbitrary closed path with correct line-length solving per line box. P1, FR-30. |
| Convert text to outlines | Not started | `@hc/text` exposes no glyph outlines; Go `pdfttf.go` `hasTrueTypeOutlines` only checks the `glyf` table exists | Needs a real `glyf` and CFF outline extractor usable by both `@hc/text` and the Go renderer, or the export path diverges. P0, FR-31. |
| Outlined text keeps alt text and reading order | Not started | `NodeBase.altText` / `Page.readingOrder` ship (schema v12) | Conversion must carry the original string forward or accessibility silently regresses. P0, FR-31. |

### Meshes and advanced fills

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Gradient mesh node (grid of colour-carrying control points) | Not started | `Fill` covers solid / gradient / pattern / image only | New node type (`mesh`), old clients preserve it via `UnknownNode.raw`. P1, FR-32. |
| Mesh editing (add/remove rows and columns, move points, set colours, edit tangents) | Not started | n/a | A direct-selection model close to `PathEditor.tsx` but two-dimensional. P1, FR-32. |
| Mesh rendering on Canvas2D | Not started | n/a | Canvas2D has no mesh primitive: subdivide to Gouraud-shaded triangles or bilinear patches and draw them. Quality and cost both scale with subdivision. P1, FR-33. |
| Mesh rendering on the GPU path | Planned (doc 44) | n/a | The natural target; Canvas2D subdivision stays the fallback. |
| Mesh rendering in headless export | Not started | `backend/internal/render` has no mesh path | Same subdivision in Go for raster; SVG has no native mesh, so emit the subdivided triangles or an embedded raster with a documented resolution. P1, FR-33. |

### Image trace

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Raster to editable vector | Not started | n/a | Runs as a job, never inline in a handler. P1, FR-34. |
| Tunable parameters (threshold, colour count, path fit, corner angle, noise, min area) | Not started | n/a | Preview at low resolution, commit at full. P1, FR-34. |
| Modes: black and white, greyscale, limited colour, full colour, line art, sketch | Not started | n/a | Colour modes need quantization plus per-region tracing. P1, FR-34. |
| Result lands as ordinary editable path nodes | Not started | n/a | Compound paths through the v15 `contours` field, so counters survive. P0 of the feature, FR-35. |
| Trace parameters retained for re-run | Not started | n/a | Store them on the produced group as an F40 operator so the trace can be re-tuned. P2, FR-35. |

### Constraints and precision drawing

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Constraint types: coincident, horizontal, vertical, parallel, perpendicular, tangent, equal length, fixed distance, fixed angle, concentric | Not started | n/a | Declared on anchors and segments within one path or across paths in a group. P2, FR-36. |
| Solver | Not started | n/a | Iterative least-squares over the constrained degrees of freedom, deterministic and bounded (fixed iteration cap) so it cannot stall the frame. P2, FR-37. |
| Over-constrained and conflicting-system reporting | Not started | n/a | Must fail visibly and reversibly: flag the conflicting constraints, keep the last valid geometry, never silently move artwork. P2, FR-37. |
| Constraint display and editing | Not started | n/a | Glyphs on canvas, a list panel, per-constraint enable and delete. P2, FR-38. |
| Constraints under CRDT merge | Not started | n/a | Constraints are declarative, so they merge as a set; the solver re-runs locally after merge (section 8). P2. |

### Precision aids, guides, and measurement

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Rulers and draggable guides | Built | `Canvas.tsx` `Ruler` (51-70), guide drag (1317+), `showRulers` | Object-level. |
| Object snapping and smart guides | Built | `@hc/editor` `snapping.ts` (`snap`, `spacingSnap`, `resizeSpacingSnap`, `detectEqualSpacing`) | Operates on AABBs only; no geometry snapping. |
| Equal-spacing guides | Built | `snapping.ts` `detectEqualSpacing` | |
| Hover distance measurement | Built | `Canvas.tsx` (1356, 2501: Alt reveals it) | Box-to-box distance, not geometry-to-geometry. |
| Snap to anchor / segment / intersection / midpoint / tangent / centre | Not started | n/a | The core precision gap. Needs a geometry snap index alongside the AABB one. P0, FR-39. |
| Live angle and length readout while drawing or dragging | Not started | n/a | Shown at the cursor during pen, anchor drag, and handle drag. P0, FR-40. |
| Numeric entry (coordinates, length, angle, radius, offset) | Partial | `PropertiesPanel.tsx` has X/Y/W/H fields | No anchor-level or during-gesture numeric entry. P0, FR-41. |
| Measurement tool (point to point, along a path, area) | Not started | n/a | Reports length along curves, not chord length. P1, FR-42. |
| Dimension annotations that update with the geometry | Not started | n/a | Pairs with the constraint solver. P2, FR-42. |

### Rendering, hit testing, and export parity

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Cubic path rendering with compound contours | Built | `render2d.ts` `case "path"` (1064-1098) | Even-odd fill when contours are present. |
| Adaptive flattening | Not started | `@hc/geometry` `flatten.ts` `DEFAULT_STEPS = 16` | A fixed 16 steps under-tessellates a large curve at high zoom and over-tessellates a tiny one. Flatness-based subdivision, zoom-aware. P0, FR-44. |
| Precise path and boolean hit testing | Not started | `hit.ts` default branch | Use `@hc/geometry` `pointInPath` for fills and a distance test against the flattened outline for strokes. P0, FR-43. |
| Spatial index over anchors for node-mode picking | Partial | `engine/src/spatial.ts` `SpatialIndex` indexes nodes | Extend to anchors for paths past a threshold count. P1, FR-45. |
| Go headless render of every new geometry type | Not started | `raster.go` / `svg.go` / `pdf.go` gaps listed above | Export parity is a product promise; each feature must render or the doc must say how it degrades. P0, FR-53. |
| GPU tessellation and stroke expansion | Planned (doc 44) | n/a | Canvas2D remains the always-available baseline. |

### AI hooks

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| AI Creative Studio core (BYO key, multi-model, editable output) | Built | `@hc/aistudio` (`docs/shipped/39-ai-creative-studio.md`) | The layer to build on; not geometry-aware. |
| AI-assisted image trace parameter selection | Not started | n/a | Suggest a mode and tolerance from the source image; deterministic tracer still does the work. P2, FR-46. |
| Prompt to editable vector artwork | Not started | n/a | Must land as native path nodes, never an embedded raster or an opaque blob. P2, FR-46. |
| Path cleanup (redundant anchors, near-duplicate points, self-intersections) | Not started | n/a | Deterministic analysis first, model only for ranking suggestions. P2, FR-47. |

### Accessibility and i18n

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Keyboard path editing (select, traverse, move, add, delete anchors) | Not started | `PathEditor.tsx` handles only Delete and Backspace | Node mode must be fully operable without a pointer. P0, FR-50. |
| Screen-reader semantics for anchors and effects | Not started | `@hc/a11y` covers design-level checks | Announce anchor index, type, coordinates, and the effect stack. P0, FR-51. |
| Alt text preserved through outline conversion and boolean operations | Not started | `NodeBase.altText` ships (schema v12) | Silent regression risk; see the text-as-vector row. P0, FR-31/FR-51. |
| Localized readouts, numeric entry, and units | Partial | `Unit` type ships (`px`/`mm`/`in`/`pt`) | Decimal separators, RTL layout of readouts, and unit-aware parsing all need doing under F38. P1. |

## 5. UX and interaction behavior

The vector authoring model rests on two tool modes and one selection mode, all of which must coexist with the existing select/pen/pencil/shape tools without changing their behavior for users who never touch a curve.

- Tool modality. Three modes: object mode (today's `select`, operating on whole nodes), node mode (direct selection, operating on anchors and handles inside one or more paths), and pen mode (creation). Node mode is entered by pressing `A`, by double-clicking a path with the select tool, or implicitly today by selecting a single path (which is how `PathEditor.tsx` mounts). Escape steps out one level: handle to anchor, anchor to path, path to object. Pen mode is `P` and stays active across strokes, which matches the current behavior.
- Pen gestures. Click places a corner anchor. Click and drag pulls a mirrored handle pair, with a live preview of the actual curve the pending handle produces, not a straight rubber band. Alt (Option) during that drag breaks the pair and moves only the out-handle, recording `handleMode: "broken"`. Alt-clicking the just-placed anchor retracts its out-handle so the next segment leaves straight. Hovering the first anchor shows a close affordance (already implemented, `Canvas.tsx` 1449-1458). Hovering an open endpoint of an existing path shows a continue affordance and the next click resumes that path rather than starting a new node. Shift constrains the new anchor to 15-degree increments from the previous one. Enter or Escape or a double-click ends the path open (double-click already does, `Canvas.tsx` 1465-1470).
- Node-mode gestures. Drag on empty canvas rubber-bands a marquee that selects every anchor inside it (additive with Shift). Click selects one; Shift-click toggles. Arrow keys nudge the selected anchors by the grid step, Shift-arrow by the large step; in node mode the arrow keys never move the whole node. Drag an anchor to move it, with geometry snapping and a live coordinate readout. Drag a handle to reshape; Alt breaks a mirrored pair, Shift constrains the handle angle. Double-click an anchor toggles corner and smooth (already implemented). Click a segment inserts an anchor at the hovered parameter (already implemented); Alt-click a segment with the delete modifier removes the segment, splitting the path. Delete removes the selected anchors and rejoins their neighbours (already implemented).
- Hit targets. Anchors are 8 CSS px squares (corner) or 10 px circles (smooth); handles are 8 px circles; segments carry a 10 px invisible hit stroke. These are the values `PathEditor.tsx` uses today and they must stay constant in screen space at every zoom level, which they already do because the overlay works in screen coordinates. Handle hit targets take priority over anchors, and anchors over segments, so a handle sitting on top of its anchor is still grabbable. Below a 6 px on-screen inter-anchor distance the overlay clusters markers and shows a count badge rather than stacking unclickable dots.
- Shape builder. Selecting two or more overlapping objects and pressing `Shift+M` enters shape-builder mode: the arrangement's faces highlight on hover, dragging across faces merges them into one new object, and Alt-dragging deletes the faces it crosses. Releasing commits one undoable operation. Escape leaves the mode with no change.
- Effect stack. A path's effects appear as an ordered list in the properties panel, each with an enable toggle, its parameters, and a drag handle for reordering. The stack renders live; there is no apply step. "Expand appearance" is an explicit command that replaces the parametric stack with the geometry it currently produces, as one undo step.
- Precision overlays. During any geometry gesture, a readout follows the cursor showing the values that matter for that gesture (dx/dy and absolute coordinates for an anchor move; length and angle for a handle drag or a pen segment; radius for corner rounding). Typing a number while the readout is visible opens inline numeric entry for the highlighted field; Tab cycles fields; Enter commits.
- Constraints. Selecting two anchors or two segments reveals the applicable constraint buttons; applying one solves immediately and draws a small glyph near the constrained geometry. A conflicting system flags the offending glyphs in the warning colour and leaves the geometry where it was.

## 6. Functional requirements

Grouped by theme. These FR ids are the durable contract referenced by the acceptance criteria.

Pen and path creation:
- FR-1: A pen mode places anchors, drags handles, closes on the first anchor, and ends a path open by Enter, Escape, or double-click, staying active across consecutive paths.
- FR-2: The pen's live preview renders the pending segment as the actual cubic the current handle would produce, not a straight rubber band.
- FR-3: Handle pairs support three modes: mirrored (equal length and opposite direction), asymmetric (opposite direction, independent length), and broken (fully independent). The mode is recorded per anchor so it survives save, reload, and a round trip through an older client; a modifier during a handle drag switches it.
- FR-4: Hovering an open endpoint of an existing path with the pen resumes that path; the resulting anchors join the existing node rather than creating a new one.
- FR-5: A handle can be retracted to zero length so the adjoining segment renders straight, and re-extended later without losing the anchor's other handle.

Direct path editing:
- FR-6: A rubber-band marquee in node mode selects every anchor whose position falls inside it, additive with a modifier, across every contour of a compound path and across multiple selected paths.
- FR-7: Arrow keys nudge the selected anchors (not the node) by the grid step, and by the large step with a modifier; the whole gesture commits as one undo step.
- FR-8: Selected anchors can be aligned (left, right, top, bottom, horizontal centre, vertical centre) and distributed evenly on either axis.
- FR-9: Two open endpoints can be joined, whether they belong to the same path (which closes it) or to two different paths (which merges them into one node preserving both sets of handles); a path can be split at a selected anchor or at a point on a segment, producing two contours or two nodes as the user chooses.
- FR-10: Selected anchors can be averaged onto their mean x, mean y, or both, and coincident-within-tolerance anchors can be merged into one.
- FR-11: A path can be simplified with a user-controlled tolerance and an optional angle threshold, with a live preview of the resulting anchor count, reusing `@hc/geometry` `simplifyPolyline` and `fitCubicBeziers`.
- FR-12: The node editor operates on every contour of a compound path, not only the primary `segments` array, including inserting, deleting, and reversing individual contours.

Booleans and shape building:
- FR-13: A boolean operation keeps every operand individually selectable and editable after the fact; editing an operand re-evaluates the result. The operator, its parameters, its operand references, and its cached result are stored and evaluated through the F40 procedural model, not through a mechanism invented here.
- FR-14: Any geometry-producing node can be an operand: shape, path, boolean result, outlined text, and a group of those.
- FR-15: Boolean results preserve curvature (curved operands do not become polylines) and preserve hole nesting, so a result reused as an operand behaves identically to a hand-drawn compound path.
- FR-16: The operation set is union, subtract, intersect, exclude, divide, trim, merge, crop, and outline, all live under FR-13.
- FR-17: A shape-builder mode lets the user drag across the faces of an arrangement of overlapping objects to merge them into one object, or with a modifier to delete them, committing as one undoable operation.

Path effects:
- FR-18: A path carries an ordered, individually toggleable stack of parametric effects. Reordering or re-tuning any effect re-renders without a rebuild step and without touching the source geometry.
- FR-19: Offset path takes a distance (positive, negative, or both sides), a join style (miter, round, bevel) and a miter limit, and produces correct self-intersection-free geometry for both convex and concave inputs.
- FR-20: Outline (stroke to path) is an effect, not a destructive command: it converts the stroke to filled geometry with correct caps, joins, miter limit, and dash pattern, while the underlying path and stroke parameters remain editable.
- FR-21: Corner rounding takes a global radius and per-corner overrides, and degrades predictably when adjacent segments are shorter than twice the radius (clamp to the largest feasible radius rather than producing self-intersections).
- FR-22: Roughen and zigzag take a size, a detail density, a smooth-or-corner switch, and a seed; the same file always renders the same geometry, in every renderer.
- FR-23: Warp takes either a set of preset distortions with a bend and distortion amount, or a user-editable envelope mesh, and applies to paths, groups, and text.
- FR-24: A stroke can carry a width profile: an ordered list of `{t, width}` stops along the path with an interpolation mode, rendered as a filled ribbon. Absence of a profile renders exactly as today's uniform stroke.
- FR-25: "Expand appearance" replaces a path's effect stack with the plain geometry it currently produces, as one undoable operation, with no visual change at the moment of expansion.
- FR-26: Every parametric effect stores a baked-geometry fallback alongside its parameters so a client that does not understand the effect renders the correct artwork (section 7).
- FR-27: Dash patterns carry a pattern array, a phase, a cap style, and an alignment mode (stretch to fit corners and endpoints), and render identically in the browser and in every export encoder.
- FR-28: Arrowheads and markers apply to any path end, drawn from a built-in marker set plus user-defined markers, with per-end scale, alignment, and a flag to shorten the path so the marker tip lands on the original endpoint.

Text as vector:
- FR-29: Text can be placed on a path, with a start offset, alignment along the path (start, centre, end), baseline offset, flip-to-other-side, and per-glyph spacing; the text stays editable and re-flows when the path changes.
- FR-30: Text can be flowed into a closed path, solving each line's available width against the shape's outline, with configurable inset and vertical alignment.
- FR-31: Text converts to editable outlines as a compound path preserving counters, carrying the original string forward as alt text so accessibility and search do not regress, and the glyph outlines used are the same ones the headless renderer uses.

Meshes:
- FR-32: A mesh node stores a grid of control points, each with a position, optional tangent handles, and a colour, supports adding and removing rows and columns and editing points individually, and is edited with the same direct-selection idioms as a path.
- FR-33: Meshes render in the browser on Canvas2D by adaptive subdivision (with the GPU path as the accelerated route under F44) and in the Go headless renderer by the same subdivision, so a mesh exports to PNG and PDF; SVG, which has no portable mesh primitive, receives either the subdivided triangle fan or an embedded raster at a documented resolution, and the choice is recorded in the export options.

Image trace:
- FR-34: Image trace converts a raster node to vector geometry with tunable threshold, colour count, path fitting tolerance, corner angle threshold, noise floor, and minimum region area, offering a low-resolution live preview and running the full trace as a job through the existing job registry.
- FR-35: Trace output is ordinary editable path nodes (compound paths where the source has holes), grouped, with the trace parameters retained as an F40 operator so the trace can be re-run at a different tolerance without re-importing the image.

Constraints:
- FR-36: The constraint set is coincident, horizontal, vertical, parallel, perpendicular, tangent, equal length, fixed distance, fixed angle, and concentric, declarable on anchors and segments within a path or across paths inside one group.
- FR-37: The solver is deterministic and bounded: it runs a fixed maximum number of iterations, converges to a documented tolerance, and on an over-constrained or conflicting system leaves the geometry unchanged and reports which constraints conflict rather than moving artwork unpredictably.
- FR-38: Constraints are visible on canvas as glyphs, listed in a panel, individually disableable and deletable, and survive save, reload, and export (as inert metadata in formats that cannot express them).

Precision:
- FR-39: Snapping extends beyond bounding boxes to geometry: anchors, segment points, path intersections, midpoints, centres, and tangent points, with per-target-type toggles and a screen-space threshold that is constant across zoom levels.
- FR-40: A live readout follows the cursor during pen placement, anchor drags, and handle drags, showing delta and absolute coordinates, segment length, and angle, in the document's unit.
- FR-41: Any value shown in a readout or a geometry field can be typed exactly: anchor coordinates, segment length and angle, corner radius, offset distance, and effect parameters, with unit-aware parsing.
- FR-42: A measurement tool reports point-to-point distance, cumulative length along a path (arc length, not chord length), and enclosed area; dimension annotations optionally persist and update as the geometry changes.

Rendering, hit testing, and parity:
- FR-43: Hit testing for `path` and `boolean` nodes uses true geometry (`@hc/geometry` `pointInPath` for fills, a distance test against the flattened outline plus half the stroke width for strokes) rather than the bounding box.
- FR-44: Curve flattening is adaptive: subdivision is driven by a flatness tolerance in device pixels and the current zoom, replacing the fixed 16-step sampling in `@hc/geometry` `flatten.ts`, and the same tolerance model is used by the Go renderer so browser and export tessellation match.
- FR-45: The spatial index extends to anchors for paths above a threshold anchor count so node-mode picking stays responsive on large artwork.
- FR-46: AI hooks suggest image-trace parameters from the source image and generate vector artwork from a prompt; all output is native editable path nodes routed through the editor command framework as undoable operations, and all inference runs on the workspace's own key or endpoint.
- FR-47: A deterministic path-cleanup pass detects redundant anchors, near-duplicate points, tiny segments, and self-intersections, and offers each as an individually applicable fix.

Accessibility:
- FR-50: Node mode is fully operable by keyboard: enter and leave node mode, traverse anchors along and across contours, extend the anchor selection, move anchors by a step and by a typed value, and insert, convert, and delete anchors.
- FR-51: Every anchor, handle, effect, and constraint exposes a screen-reader label, role, and value (anchor index of total, corner or smooth, coordinates, effect name and parameters), and geometry-mutating operations that could lose semantics (outline conversion, boolean combine, expand appearance) carry alt text and reading-order membership forward.

Data and parity:
- FR-52: Every geometry type this spec introduces either renders in `backend/internal/render` for PNG, SVG, and PDF, or the export path documents an explicit, visible degradation (never a silent hole). The existing gaps this spec inherits (`boolean` missing from `svg.go` and `pdf.go`, `mask` missing everywhere) are closed or explicitly reserved as part of it.
- FR-53: No schema change introduced by this spec may prevent any earlier version of HyCanvas from opening a file: new node types only (preserved by `UnknownNode.raw`) and new optional fields only, never a widened enum or a changed field meaning on an existing node type (section 7 explains why).

## 7. Data model / schema changes

Everything here follows the schema-is-contract rule in the root `CLAUDE.md`: extend the `NodeType` union and `KNOWN_NODE_TYPES` in `packages/schema/src/schema.ts`, define the interface plus Zod schema with `...nodeBaseFields, type: z.literal("...")`, add it to `KNOWN_NODE_SCHEMAS`, `KnownNodeSchema`, and the discriminated `NodeSchema`, give it a default in `factory.ts`, register a forward step in `migrate.ts` keyed on the source version, append a line to the version-history doc-comment above `CURRENT_SCHEMA_VERSION`, and raise both `CURRENT_SCHEMA_VERSION` in `schema.ts` and the Go mirror `currentSchemaVersion` in `backend/internal/persistence/file.go` in the same change. If only one of the two moves, `persistence/validate.go` rejects the file with a 422 (`ErrInvalidFile`, the `schemaVersion 1..N` range check at validate.go:47) and nothing persists. Current state at the time of writing: `CURRENT_SCHEMA_VERSION = 17`, Go mirror `currentSchemaVersion = 17`.

One rule matters more here than in any previous spec, because vector authoring is full of tempting one-word enum extensions. **Widening an enum on an existing node type is not additive and must not be done.** `packages/schema/src/validate.ts` validates each node against its precise schema from `KNOWN_NODE_SCHEMAS`, and `UnknownNodeSchema` (schema.ts:1712-1718) explicitly refuses any value whose `type` is a known node type. So a `boolean` node carrying `op: "divide"` fails its own branch on an older client and cannot fall back to `UnknownNode`: `validate()` returns `ok: false` for the whole file. The Go write boundary is structural (ids, depth, count) and would happily persist such a file, which makes the failure worse, not better: the file saves and then an older binary cannot open it. New operations therefore go into new node types, and new per-anchor or per-node behavior goes into new optional fields. Optional fields are safe in both directions: an older client's Zod object ignores the unknown key, and `validate()` discards the parsed value rather than replacing the node, so the field survives the round trip untouched.

New node types (each additive, each preserved losslessly by an older client through `UnknownNode.raw`):

```ts
// A live geometry operator: booleans and path effects are the same thing, a
// typed operation over operand geometry with a cached result. Storage,
// evaluation, invalidation, and the graph/layers dual view are owned by F40;
// this spec owns `op`, the parameter shapes, and the geometry semantics.
interface VectorOpNode extends NodeBase {
  type: "vectorop";
  op:
    | "union" | "subtract" | "intersect" | "exclude"
    | "divide" | "trim" | "merge" | "crop" | "outline"
    | "offset" | "stroke-to-path" | "corner" | "roughen" | "zigzag" | "warp" | "width-profile";
  params: Record<string, number | string | boolean | number[]>;
  /** Live operands; each stays an ordinary, individually editable node. */
  operands: Node[];
  /** Evaluated geometry, cached so a cold open paints without re-evaluating. */
  result?: VectorPath;
  /** Baked fallback for any reader that cannot evaluate `op` (see below). */
  baked?: VectorPath;
  fills?: Fill[];
  stroke?: Stroke;
}

// A gradient / vector mesh: a grid of colour-carrying control points.
interface MeshNode extends NodeBase {
  type: "mesh";
  rows: number;
  cols: number;
  points: {
    x: number; y: number;
    color: Color;
    /** Optional Coons-patch tangents; absence means a bilinear patch. */
    up?: { x: number; y: number }; down?: { x: number; y: number };
    left?: { x: number; y: number }; right?: { x: number; y: number };
  }[];               // row-major, length === rows * cols
  patch: "bilinear" | "coons";
}

// Text bound to a path or flowed into a shape. A separate node type rather than
// a widened TextNode, so an older client shows the text at its box position via
// UnknownNode preservation instead of failing to parse a TextNode it half knows.
interface TextGeometryNode extends NodeBase {
  type: "textgeometry";
  mode: "on-path" | "in-shape";
  text: TextNode;              // the editable source text, unchanged
  path: VectorPath;            // baseline path, or the container outline
  offset?: number;             // start offset along the path (0..1)
  align?: "start" | "center" | "end";
  side?: "left" | "right";     // which side of the baseline
  inset?: number;              // in-shape only
  baked?: VectorPath;          // outlines as rendered, for a reader that cannot lay out
}

// A declared geometric relation, held by the solver.
interface GeometricConstraint {
  id: string;
  kind:
    | "coincident" | "horizontal" | "vertical" | "parallel" | "perpendicular"
    | "tangent" | "equal-length" | "distance" | "angle" | "concentric";
  /** Targets addressed as {nodeId, contour, index} for anchors, or
   *  {nodeId, contour, segment} for segments. */
  targets: { nodeId: string; contour?: number; index?: number; segment?: number }[];
  value?: number;   // distance / angle constraints only
  enabled?: boolean;
}
```

Additive optional fields on existing node types (no widened enums, no changed meanings):

- `PathSegment` (schema.ts:992-1010) gains `handleMode?: "mirrored" | "asymmetric" | "broken"`. Absence keeps today's inference exactly: `corner === true` or no handles means corner, otherwise the editor mirrors, which is what `penHandle` and `editHandle` already do. This is the one place where a new optional field on a nested value type is the right call rather than a new node type, because `PathSegment` has no discriminant of its own and the field only records editor intent.
- `PathNode` (1012-1038) gains `pathEffects?: VectorEffect[]` (NOT `effects`: `NodeBase.effects?: Effect[]` is already on every node through `nodeBaseFields`, so a `VectorEffect[]` under that name fails `EffectSchema` and the whole file is rejected on new and old clients alike. `TextNode.textEffects` exists for exactly this reason and is the precedent followed here.) (an inline effect stack for the common single-path case, each entry mirroring `VectorOpNode`'s `op`/`params`/`baked`), `widthProfile?: { t: number; width: number }[]`, `markers?: { start?: MarkerSpec; end?: MarkerSpec }`, and `constraints?: GeometricConstraint[]`. All optional; a reader that ignores them draws the base geometry, which is why `baked` matters.
- `Stroke` (259-276) gains `dashPhase?: number`, `dashAlign?: "none" | "corners" | "ends"`, and `profileId?: string` (referencing a named profile in the file's resources). `dash` already exists and stays a plain `number[]`.
- `BooleanNode` (1514-1531) is frozen. It keeps its four ops and its baked `result` forever, so every existing file keeps rendering. New work uses `VectorOpNode`. A one-way, user-invoked, non-automatic upgrade converts a `BooleanNode` to a live `VectorOpNode`; nothing rewrites an existing document silently.
- `MaskNode` (1497-1512) is either implemented against the `pathclip.ts` clipping machinery that already serves frame masks, or explicitly documented as reserved-and-unrendered. It is not extended while it renders nowhere.

How a parametric effect degrades on an older client. Every `VectorOpNode`, every entry in `PathNode.pathEffects`, and every `TextGeometryNode` carries a `baked` `VectorPath`: the geometry the effect currently produces, written on every commit alongside the parameters. Three readers, three behaviors, no data loss in any of them:

1. A current client evaluates `op` against `operands` and `params`, ignores `baked`, and renders live.
2. A client one version behind that knows `VectorOpNode` but not this particular `op` renders `baked`, shows the node as an uneditable "unsupported operation" in the layer panel, and refuses to mutate its parameters. The artwork is correct; only the tuning is unavailable.
3. A client from before `VectorOpNode` existed preserves the whole node through `UnknownNode.raw` (byte-for-byte on save) and renders the placeholder box that `render2d.ts` already draws for unknown types. The node is not editable and not visible, but it is also not damaged: saving from that client and reopening in a current one restores the full live operator.

Case 3 is a visible degradation and must be stated plainly rather than papered over. The mitigation that keeps it rare is that `PathNode.pathEffects` is preferred over a wrapping `VectorOpNode` whenever the effect applies to a single path, because an old client seeing a `PathNode` with an unknown `pathEffects` key still renders the base path geometry correctly (it simply renders it un-effected) instead of rendering nothing. The wrapping node type is reserved for multi-operand operations (booleans, shape builder output) where there is no single base path to fall back to.

Go mirror obligations. Each version bump raises `currentSchemaVersion` in `backend/internal/persistence/file.go` in the same commit. Purely additive bumps need no new Go migration step (`persistence/migrate.go` walks steps only where one is registered). The Go renderer additionally needs, per feature: a `vectorop` case in `raster.go`, `svg.go`, and `pdf.go` that draws `result` if present and `baked` otherwise; a `mesh` case; a `textgeometry` case; and the missing `boolean` and `mask` cases in `svg.go` and `pdf.go` that this spec inherits as debt.

Persistence. Named width profiles and user-defined markers live in the file's resource section next to the existing shared resources, not duplicated per node. Trace parameters live on the produced group as an F40 operator. Nothing in this spec requires a new Postgres table; if a shared marker or profile library is later scoped to a workspace, it follows the existing per-workspace query-layer isolation rule.

## 8. API and realtime

No new REST surface is required for the interactive editing itself, which is entirely client-side geometry over the existing document. Two operations are heavy enough to need the job registry, and neither runs inline in a handler:

```
POST   /api/v1/designs/{id}/trace        image trace -> job (202 + job id)
POST   /api/v1/designs/{id}/vectorize    AI vectorize / cleanup -> job (202 + job id)
GET    /api/v1/jobs/{id}                 poll (existing registry)
```

Both return RFC 7807 problem+json on error and emit structured JSON logs keyed by design id, workspace id, user id, and request id. Trace output is validated at the write boundary before it persists; a malformed result returns 422 rather than corrupting a document. `@hc/sdk` gains typed methods for both.

Anchor-level edits under CRDT merge. This is the part that needs care, because the existing reconciler is coarse. `packages/realtime/src/reconcile.ts` `reconcilePlainArray` delete-and-reinserts a whole array on any edit, and `fromDoc` rebuilds the entire `DesignFile` per delta. A path's `segments` is exactly such a plain array, so today two users dragging two different anchors of the same path produce two whole-array rewrites and last-writer-wins on the array, silently discarding the other user's anchor move. That is acceptable for the current usage (paths are rarely co-edited) and unacceptable once node mode is a real workflow.

The model this spec requires:

- Anchor identity. Anchors are addressed positionally today (`editAnchor(id, index, ...)`), and positional addressing does not survive a concurrent insert. Anchors gain a stable optional `aid` (a short id, additive, absent on every existing file and generated lazily on first structural edit) so an insert by one user and a move by another commute. Position remains the fallback when `aid` is absent, matching today's behavior exactly for untouched files.
- Granularity. A path's contours map to a CRDT array of anchor maps rather than an opaque plain array, so a move touches one anchor map and merges cleanly against a concurrent move of a different anchor. Two users moving the *same* anchor still resolve last-writer-wins per field, which is correct and expected.
- Gesture batching. A drag already commits as one undo step through `snapshotPath`/`commitPathEdit`. It must also commit as one CRDT transaction: the intermediate frames of a 60fps drag are local-only, and only the committed state is published. Without this, a drag publishes hundreds of updates and the update log grows without bound. This mirrors the resolution F30 reached for ink strokes (commit once on stroke end, carry the in-progress state as ephemeral presence).
- Live gesture presence. The in-progress anchor or handle position broadcasts over presence (like the laser and cursor channels), so a peer sees the drag happening without it entering the document. Presence fields are added to the `sanitizePresence` allowlist in `backend/internal/realtime/presence.go`, consistent with the existing ephemeral channels.
- Locks. The existing per-element lock is node-granular, which is the right granularity here: a user editing a path's anchors holds the path. A sub-node lock model is not proposed; a peer attempting to enter node mode on a locked path gets the existing lock-denied affordance.
- Operator evaluation. A `VectorOpNode`'s `result` is derived, not authored. It must not be treated as authoritative content in the merge: whichever client last evaluated writes it, and any client may recompute it from `operands` and `params`. F40 owns the invalidation rule; this spec requires only that `result` never be the sole source of truth while `operands` exist, and that `baked` is written by the same commit that writes `result`.
- Constraints. Constraints are a declarative set, so they merge as a set (add and remove commute). The solver runs locally after any merge; because it is deterministic and bounded (FR-37), two clients that converge on the same constraint set and the same input geometry converge on the same solved geometry.

## 9. AI hooks

All AI here builds on the shipped AI Creative Studio (`@hc/aistudio`, `docs/shipped/39-ai-creative-studio.md`): the BYO-key, multi-model, self-hostable provider-adapter layer. Design content never leaves a self-hosted instance because inference routes through the workspace's own key or endpoint. Three rules apply to every hook below: the deterministic algorithm does the geometry, the model only chooses parameters or ranks suggestions; every result lands as native editable nodes, never a rasterized or opaque result; and every insertion goes through the `@hc/editor` command framework as one undoable operation that fans out over the CRDT.

- Image trace assist. The tracer itself (thresholding, region extraction, curve fitting) is deterministic and reproducible. The model's job is parameter selection: given the source image, propose a mode (line art, limited colour, full colour), a colour count, and a fitting tolerance, which the user then adjusts on the same sliders. This keeps trace output reproducible across runs and across models, which a purely generative approach cannot promise.
- Prompt to vector artwork. A prompt produces geometry, not a picture: the model emits a structured description that is materialized into `PathNode`s, `VectorOpNode`s, and fills, laid out and inserted as editable nodes. Output that fails boundary schema validation is rejected before it reaches the document. This is the same "editable native nodes, no rasterized dead ends" contract the AI diagram work in F30 holds itself to.
- Vectorize and clean up. A deterministic analysis pass finds redundant anchors, near-coincident points, sub-pixel segments, self-intersections, and open paths that were meant to be closed; the model ranks the findings and drafts a short explanation per fix. Each fix is applied individually and is individually undoable. Nothing is auto-applied.
- Trace and vectorize both run as jobs (section 8) because they are long relative to a request, and their parameters are retained as an F40 operator so a run can be re-tuned rather than repeated from scratch.
- Not in scope for AI: the boolean clipper, the offsetter, the constraint solver, and the flattener. These are correctness-critical geometry and stay deterministic.

## 10. Performance and scale

The scale unit here is anchors, not nodes, and it is a different problem from the object-count scale F30 and F44 address.

- Target workloads. A single path with 10,000 anchors (a detailed trace result) must pan, zoom, and render at 60fps and must enter node mode without a visible stall. A document with 500 paths averaging 200 anchors each (100,000 anchors total) must render at 60fps. A live boolean over 20 operands must re-evaluate within one frame budget for interactive dragging, or fall back to a deferred re-evaluation with the previous result shown meanwhile.
- Adaptive flattening (FR-44) is the largest single win and the largest current risk. The fixed 16 steps in `@hc/geometry` `flatten.ts` is simultaneously too coarse for a large curve at high zoom (visible faceting) and too fine for a tiny one (wasted work). Flatness-tolerance subdivision, with the tolerance derived from device pixels and the current zoom, fixes both. The Go renderer must use the same tolerance model or export and preview diverge visibly at curve edges.
- Hit testing. Precise path hit testing (FR-43) is more expensive than the current bounding-box test, so it runs only after the existing `SpatialIndex` narrows candidates, and it reuses a cached flattening keyed by the node revision and the current zoom bucket rather than re-flattening per pointer move. In node mode, anchor picking uses a per-path anchor index (FR-45) built once when node mode is entered and invalidated on structural edits, not on every anchor move.
- Node-mode overlay cost. `PathEditor.tsx` currently renders one SVG element group per segment plus per anchor, which is fine at tens of anchors and untenable at thousands. The overlay must virtualize to the visible viewport and cluster markers below a minimum on-screen separation (section 5), so overlay cost tracks visible anchors rather than total anchors.
- Operator evaluation cost. Boolean and effect evaluation is pure geometry over plain arrays, so it is a worker candidate: `@hc/geometry` has no DOM or React dependency and can be moved off the main thread. F40 owns the caching and invalidation policy; this spec requires that an operator's evaluation be cancellable and that a stale cached `result` be rendered while a re-evaluation is in flight rather than blanking the node.
- Mesh rendering on Canvas2D is the known soft spot: subdivision cost grows with the square of the subdivision level and Canvas2D has no mesh primitive. The Canvas2D path caps subdivision at a level chosen from the mesh's on-screen size and accepts visible banding on very large meshes, with the GPU path (F44) as the quality route. This is stated as a documented limitation, not hidden.
- Budgets. Local geometry edits apply in the same frame. Remote deltas apply without a full document rebuild. Trace and AI vectorize are jobs and never block a frame or a request handler.

## 11. Security and threat model

Vector authoring adds little network surface but a meaningful amount of untrusted-input parsing, which is where the risk sits.

- Untrusted geometry parsing. SVG and path-data ingestion (`packages/stock/src/svg.ts` `svgToNodes`, `frontend/src/lib/svgFlatten.ts` `flattenSvgToNodes`, `packages/engine/src/pathclip.ts` `parsePathCommands`) parses attacker-controllable strings. Every parser must be bounded: a cap on command count, on coordinate magnitude, and on nesting depth, with malformed input rejected rather than partially applied. `flattenSvgToNodes` mounts the SVG in a real offscreen DOM to resolve computed styles, so it must keep skipping script-bearing and external-reference elements (it already restricts to a `LEAF`/`CONTAINER` allowlist) and must never fetch external references.
- Algorithmic denial of service. The boolean clipper, the offsetter, and the constraint solver are all superlinear in the pathological case, and all can be reached from an imported file. Each needs an input-size cap and an iteration or time budget, after which it fails cleanly (leaving the previous geometry and reporting the failure) rather than hanging the tab or, in the export path, the server. This applies with particular force to the Go renderer, where an unbounded evaluation is a server-side hang triggerable by uploading a file.
- Export-path evaluation. If the Go renderer ever evaluates operators itself rather than drawing the baked result, it inherits every one of those budgets. The safer default this spec adopts is that the server draws `result` or `baked` and does not evaluate; server-side evaluation is a deliberate later decision, not an accident.
- Image trace resource use. Trace is CPU and memory heavy and is reachable by any authenticated user. It runs through the job registry with a per-workspace concurrency cap, a source-image pixel cap, and an output-complexity cap (anchor count) so a single request cannot exhaust an instance. Trace input is an existing asset in the workspace, resolved through the existing storage layer; no user-supplied URL is fetched, so there is no new SSRF surface.
- AI inference. Trace assist, vectorize, and cleanup route through the workspace's own key or endpoint via `@hc/aistudio`; no design geometry egresses to a third party by default on a self-hosted instance.
- Per-workspace isolation. Any new persisted resource (a shared marker or width-profile library, should it become workspace-scoped) is isolated at the query layer, consistent with every existing service.
- Font licensing on outline conversion. Converting text to outlines embeds glyph geometry in the document. That is normal and expected, but it means the geometry travels where the font may not be licensed to. The product records the source font family and the fact of conversion in the node so a user can audit it; it does not attempt to enforce licence terms.

Observability. Geometry operations emit no per-operation logs (they are client-side and high frequency), but the trace and vectorize job handlers emit structured JSON logs with design id, workspace id, user id, request id, source pixel count, output anchor count, and duration. Success metrics: node-mode entry latency on a large path, frame time during an anchor drag on the target workloads, boolean re-evaluation time by operand count, trace job duration and failure rate, and export-parity diff rate between browser and headless renders.

## 12. Accessibility and i18n

Direct manipulation of geometry is the hardest thing in a design tool to make accessible, and it is exactly where most tools give up. This spec does not.

- Keyboard path editing (FR-50). Every node-mode operation has a keyboard route: `A` enters node mode on the selected path and focuses its first anchor; Tab and Shift+Tab traverse anchors in path order; Ctrl+Tab moves between contours of a compound path; Space toggles the focused anchor's selection; arrow keys move the selection by the grid step and Shift+arrow by the large step; a typed value opens numeric entry for the focused anchor's coordinates; Enter converts corner and smooth; Delete removes; Insert splits the segment ahead of the focused anchor at its midpoint. Handles are reachable as focusable siblings of their anchor, with the same movement and numeric-entry model.
- Screen-reader semantics (FR-51). The a11y layer over the scene graph gains anchor-level nodes: an anchor announces its index and total ("anchor 4 of 17"), its type ("smooth" or "corner"), its coordinates in the document unit, and whether it is selected; a handle announces which side it belongs to, its length, and its angle; an effect announces its name, its enabled state, and its parameters; a constraint announces its kind and its targets. Structural operations announce their result ("joined, path now closed, 24 anchors").
- Semantics preservation. Outline conversion, boolean combine, and expand appearance all destroy the semantic identity of their inputs. Each must carry alt text forward (the text string for outlined type, the concatenated operand names for a boolean) and preserve reading-order membership (`Page.readingOrder`, schema v12), or the accessibility model silently degrades every time someone finishes a logo. This is a hard requirement, not a nicety.
- Contrast and the a11y checker. `@hc/a11y` extends to the new node types so a low-contrast traced result or an outlined headline is flagged at authoring time exactly as a text node is.
- Reduced motion. Live previews (the pen's pending curve, the shape builder's face highlight, the solver's settle) are geometry, not animation, and are unaffected by reduced motion; any easing on the constraint solver's visual settle is suppressed under the app-wide reduced-motion preference.
- i18n. Every readout, numeric field, and unit is localized: decimal separators follow the locale, units follow the document's `Unit` setting (`px`/`mm`/`in`/`pt`), angles follow the locale's convention, and readout overlays lay out correctly in RTL. Effect and constraint names are translatable strings, not hardcoded English, from the first commit.

## 13. Import / export and interop

SVG is the interop contract for vector geometry in both directions, and the honest position today is that HyCanvas reads more SVG than it writes.

- SVG import. `svgToNodes` (`packages/stock/src/svg.ts`) plus `flattenSvgToNodes` (`frontend/src/lib/svgFlatten.ts`) already resolve group transforms, computed CSS styles, gradients, and container opacity into native nodes, and the v15 `contours` field means compound paths keep their counters. What is dropped: clip paths, SVG masks, markers, dash phase, `textPath`, mesh gradients, and filters. Each maps to something this spec introduces, so import fidelity improves as a side effect: `textPath` to `TextGeometryNode`, markers to FR-28, clip paths to a real `MaskNode` implementation or a `VectorOpNode` crop, mesh gradients to `MeshNode`.
- SVG export. Two writers exist and neither covers the vector set: `packages/export/src/svg.ts` (client) handles `path` but not `boolean` or `mask`, and `backend/internal/render/svg.go` `emitNode` does the same and emits a literal "unsupported node type" comment for the rest. Every geometry type introduced here must serialize: paths with correct fill rules, `VectorOpNode` as its evaluated `result` (with the operator recorded in a private namespaced attribute so a HyCanvas re-import can restore liveness), width profiles as filled outlines, dashes with phase, markers as SVG `<marker>` elements, text on a path as `<textPath>` where the geometry allows and as outlines where it does not, and meshes as subdivided triangles or an embedded raster (FR-33).
- PDF export. `pdf.go` handles `path` but not `boolean` or `mask`, so a boolean node currently exports as nothing. PDF has native path, clipping, and dash support, so booleans, offsets, corner rounding, and outlined text all map cleanly once they produce ordinary geometry. Meshes map to PDF shading types where feasible and to an embedded raster otherwise. Outlined text is a genuine improvement for PDF: it removes the font-embedding question entirely for the outlined runs, though it also removes selectable text, so it must not be applied automatically to a tagged-PDF export (F28's tagged PDF work depends on real text runs).
- PNG export. `raster.go` already draws `path` and baked `boolean`; the new types need cases, and the shared flattening tolerance (FR-44) is what keeps the raster output matching the browser at curve edges.
- Round-trip promise. A file that leaves HyCanvas as SVG and comes back should return editable geometry with the same shape. Liveness (operators, constraints, effect parameters) does not survive a round trip through a foreign tool and is not claimed to; it survives a HyCanvas-to-HyCanvas round trip through the namespaced attributes, and the baked geometry is what any other tool sees. That distinction is stated in the export dialog rather than left for the user to discover.
- Out of scope here: AI/EPS/PDF-as-source ingestion, colour management, and asset libraries (F45).

## 14. Phasing / milestones

Dependency-ordered. Each phase is independently shippable and leaves the product in a coherent state.

Phase 1: make the existing vector primitives correct and precise (the credibility floor).
- Pen handle modes (mirrored, asymmetric, broken), handle retraction, true curve preview, continue from an endpoint.
- Node-mode marquee selection, anchor nudge, join, split, average, merge, simplify with tolerance, compound-contour editing.
- Precise hit testing for `path` and `boolean` (FR-43), adaptive flattening (FR-44) shared with the Go renderer.
- Geometry snapping (anchors, segments, intersections, midpoints), live angle and length readouts, numeric entry during a gesture.
- Close the inherited export gaps: `boolean` in `svg.go` and `pdf.go`; decide `MaskNode`'s fate.
- Schema: `PathSegment.handleMode`, anchor `aid`, `Stroke.dashPhase`/`dashAlign`. Two additive version bumps at most, both mirrored in Go.

Phase 2: live operators (the structural leap, and the phase most coupled to F40).
- `VectorOpNode` with live booleans over any operand type, curve-preserving results, correct hole nesting, and the full nine-operation set.
- Shape builder over the planar arrangement that divide already requires.
- The path effect stack: offset, stroke-to-path, corner rounding, roughen and zigzag, with baked fallbacks and expand-appearance.
- CRDT anchor granularity, gesture batching, and live-gesture presence (section 8).
- Anchor-level accessibility: keyboard node mode and screen-reader semantics.

Phase 3: type and appearance depth.
- Glyph outline extraction usable by both `@hc/text` and the Go renderer; text to outlines with alt text carried forward.
- Text on a path and text in a shape (`TextGeometryNode`).
- Variable-width strokes, the dash system with phase and alignment, arrowheads and markers with a user-definable set.
- Warp and envelope distortion.
- Full SVG export coverage for everything above, plus PDF and PNG parity.

Phase 4: meshes, trace, and constraints (the depth tail).
- `MeshNode` with editing, Canvas2D subdivision rendering, Go headless rendering, and the documented SVG degradation.
- Image trace with the full parameter set, live preview, job execution, and retained parameters.
- The geometric constraint solver, its glyphs and panel, and its over-constrained reporting.
- AI hooks: trace parameter assist, prompt to vector, deterministic cleanup with model-ranked suggestions.

## 15. Acceptance criteria

Representative and testable; a requirement not pinned to a numbered AC here is verified by the section 16 test plan.

- AC-1: Drawing with the pen, holding the break modifier during a handle drag moves only one handle, the other stays put, the anchor renders as broken, and the mode survives save, reload, and a round trip through a client that does not know `handleMode` (FR-3).
- AC-2: Hovering the open endpoint of an existing path with the pen and clicking appends to that path; the document contains one path node afterwards, not two (FR-4).
- AC-3: In node mode, dragging a marquee across a compound path selects anchors from every contour, arrow keys move exactly those anchors, and the whole drag is a single undo step (FR-6, FR-7, FR-12).
- AC-4: Two open paths are joined into one node, the join point keeps both incoming handles, and splitting at that anchor returns two paths with the original geometry (FR-9).
- AC-5: Simplifying a 2,000-anchor traced path at a stated tolerance reduces the anchor count, previews the count before committing, and keeps the visible outline within the tolerance (FR-11).
- AC-6: A union of a curved shape and a path stays live: selecting and dragging one operand re-evaluates the result on the next frame, the result retains curvature (no polyline faceting at any zoom), and interior holes are preserved when the result is used as an operand in a second boolean (FR-13, FR-14, FR-15).
- AC-7: Divide splits an arrangement of three overlapping shapes into its distinct faces as separate editable nodes; the shape builder produces the same faces by dragging, in one undo step (FR-16, FR-17).
- AC-8: An offset-path effect on a concave path produces self-intersection-free geometry at both positive and negative distances, the distance is re-tunable a week later, and expand-appearance produces geometry pixel-identical to the live render at the moment of expansion (FR-19, FR-25).
- AC-9: A path with a roughen effect renders byte-identically in the browser, in the PNG export, and after a reload, because the seed is stored (FR-22).
- AC-10: A path with a width profile renders as a variable-width ribbon in the browser and in PNG, SVG, and PDF export, and a client that does not understand `widthProfile` renders the base path with its uniform stroke rather than nothing (FR-24, FR-26).
- AC-11: A file containing a `VectorOpNode` is opened by a binary from before that node type existed, renders a placeholder, is saved from that binary, is reopened in a current binary, and the live operator, its operands, and its parameters are all intact (FR-53, section 7 case 3).
- AC-12: Raising `CURRENT_SCHEMA_VERSION` without raising the Go `currentSchemaVersion` causes the write boundary to return 422 and nothing to persist; the test asserts this explicitly so the coupling cannot silently break.
- AC-13: Text converted to outlines produces a compound path with correct counters, carries the original string as alt text, keeps its place in `Page.readingOrder`, and renders identically in the browser and in the headless PDF (FR-31).
- AC-14: Text on a path re-flows when the path is reshaped, and the text remains editable as text throughout (FR-29).
- AC-15: A gradient mesh renders with smooth interpolation in the browser and in the PNG export; the SVG export contains either subdivided geometry or an embedded raster, and the export dialog states which (FR-32, FR-33).
- AC-16: Tracing a scanned line drawing at two different tolerances produces two different anchor counts, both as editable compound path nodes with holes preserved, and the trace runs as a job that can be polled (FR-34, FR-35).
- AC-17: Declaring parallel and equal-length on two segments holds both relations while a third point is dragged; adding a conflicting constraint leaves the geometry untouched and flags the conflict (FR-36, FR-37).
- AC-18: Dragging an anchor snaps to another path's intersection with a live length and angle readout, and typing an exact coordinate places it exactly there (FR-39, FR-40, FR-41).
- AC-19: A path is fully editable by keyboard alone (enter node mode, traverse, select, move, insert, convert, delete), and a screen reader announces the anchor index, type, and coordinates at every step (FR-50, FR-51).
- AC-20: Two users drag two different anchors of the same path concurrently; both moves survive the merge. Two users drag the same anchor; one wins cleanly and neither client is left with a corrupt path (section 8).
- AC-21: A 10,000-anchor path enters node mode without a visible stall and pans and zooms at 60fps; a 100,000-anchor document renders at 60fps (section 10).
- AC-22: A boolean node, a mesh node, a text-on-path node, and an effected path all export to PNG, SVG, and PDF from the Go renderer with geometry matching the browser within the stated flattening tolerance, and no export path emits a silent hole (FR-52, FR-53).
- AC-23: An SVG containing `textPath`, markers, dashes with a phase, and a compound path imports to native editable nodes, and re-exporting yields an SVG that re-imports to equivalent geometry (section 13).
- AC-24: No vector authoring capability (booleans, effects, meshes, trace, constraints) is gated behind a tier, watermarked, or unavailable on a self-hosted instance.

## 16. Test plan

- Unit, pure cores (`@hc/geometry`, the largest share of the testing here because the geometry is the product): boolean correctness against golden fixtures including curved operands, nested holes, coincident edges, and degenerate zero-area inputs; offsetting on convex, concave, and self-intersecting inputs at positive, negative, and zero distances; corner rounding with radii exceeding the adjacent segment lengths; adaptive flattening error bounds versus analytic curve points; simplify round-trips (simplify then measure maximum deviation); join, split, average, and merge as pure array transforms; the constraint solver's convergence, determinism (same input, same output, every run), iteration cap, and conflict detection; roughen determinism from a seed.
- Unit, schema: a forward migration step per version bump; an older-format fixture opening unchanged; `UnknownNode.raw` preserving a `VectorOpNode`, a `MeshNode`, and a `TextGeometryNode` byte-for-byte through a save cycle; an assertion that no existing enum was widened (a test that enumerates the enum members of the pre-change node schemas and fails if any grew).
- Unit, engine: precise hit testing for filled and stroked paths, compound paths, and boolean results, including points inside a hole (must miss); overlay virtualization and marker clustering thresholds.
- Backend (Go): a render test per new node type for raster, SVG, and PDF; a byte-comparison harness asserting that browser and headless flattening agree within the stated tolerance; the 422 path when a file's `schemaVersion` exceeds the Go mirror; job-registry execution and cancellation for trace; input caps and time budgets on every superlinear routine, asserted by feeding a pathological fixture and requiring a clean failure rather than a hang; RFC 7807 problem+json on every error path; structured-log assertions.
- Integration: CRDT convergence for concurrent anchor moves, concurrent insert plus move, and concurrent structural edits (join on one client, split on another); gesture batching (a 200-frame drag produces one document update); presence fan-out of the live gesture channel.
- Frontend and E2E (compose stack, real browsers): the full pen gesture matrix including every modifier; node-mode marquee, nudge, align, join, split; the shape builder; the effect stack (add, reorder, disable, re-tune, expand); text on a path and outline conversion; image trace end to end from an uploaded raster to editable nodes; the constraint panel.
- Visual regression: a fixture document exercising every new geometry type, rendered in the browser and in each export encoder, diffed against golden images, with the diff threshold tied to the flattening tolerance rather than an arbitrary number.
- Performance: the section 10 target workloads measured (10,000-anchor path, 100,000-anchor document, 20-operand boolean), plus node-mode entry latency and anchor-drag frame time, run as a repeatable bench alongside the existing paint bench.
- Accessibility: keyboard-only completion of a full path-editing task; screen-reader output captured and asserted for anchors, handles, effects, and constraints; an audit that outline conversion and boolean combine preserve alt text and reading order.
- AI eval: a golden set scoring trace parameter suggestions against human-chosen parameters, prompt-to-vector output validity (parses, is editable, contains no rasters), and cleanup suggestion precision, run across multiple models for reproducibility.
- Manual: a "draw a real logo" runbook exercised end to end by someone who uses a professional vector tool daily; a self-host smoke test proving trace and AI hooks work with a BYO key and no data egress; an old-binary compatibility drill (author with the new binary, open with the previous release, save, reopen).

## 17. Differentiators

- Vector depth that is normally the whole product of a paid tool, shipped free, unwatermarked, and self-hostable, inside a platform that also does presentations, whiteboard, video, docs, and sheets (differentiators 1 and 5).
- Parametric geometry in an open, documented, forward-migrating file format. Effect stacks, operator parameters, constraints, and trace settings are inspectable and scriptable rather than sealed in a proprietary blob, which is the structural argument no closed tool can answer (differentiator 6).
- One geometry core, three renderers. `@hc/geometry` is pure and framework-agnostic, so the same math runs in the browser, in a worker, and (through a shared tolerance model) matches the Go headless renderer. Export parity is a tested property, not a hope (differentiators 2 and 6).
- Booleans and effects that never dead-end. Operands stay editable indefinitely, effects stay tunable, expand-appearance is an explicit choice rather than an implicit one, and a baked fallback means an older client still renders the right artwork (differentiator 5).
- Accessible geometry editing. Full keyboard path editing and anchor-level screen-reader semantics are, as far as the category goes, absent everywhere; making direct manipulation of curves operable without a pointer is a genuine category lead rather than a checkbox (differentiator 7).
- Real-time collaborative vector editing. Anchor-granular CRDT merge means two people can edit one path at once, which the offline-first core makes possible and which no mainstream vector tool offers (differentiator 3).
- Deterministic AI. Trace and cleanup keep the geometry deterministic and use the model only for parameter selection and ranking, so results are reproducible across runs and across models, on the user's own key (differentiator 4).

## 18. Open questions and risks

- The two path representations. `VectorPath` (anchors with `inHandle`/`outHandle`) and `PathNode.segments` (`cIn`/`cOut`) coexist, and every feature here has to bridge them, currently by hand at each call site. Unifying them is the clean answer and is also a breaking schema change, which the zero-data-loss rule forbids. The proposed resolution is a single conversion pair in `@hc/geometry` that every call site uses, with both representations kept on disk forever. Risk: the conversion becomes a hot path and a source of precision drift. Needs measurement before Phase 2.
- Boolean curve preservation. Refitting clipper output back to beziers is genuinely hard: the clipper works on polylines and loses the correspondence between output edges and input curves. The proposed flatten-clip-refit approach (dense flattening, then refit each output run against the originating operand curves) is a known technique but is approximate at intersection points. Risk: visible deviation at boolean seams. Mitigation: keep the flattening tolerance far below the refit tolerance, and hold a golden-image test at high zoom. This is the single biggest technical unknown in the spec.
- Glyph outline extraction. Text to outlines needs real `glyf` and CFF contour extraction, and it needs it in two languages: TypeScript for `@hc/text` and Go for the headless renderer. The Go side today only checks that a `glyf` table exists (`pdfttf.go` `hasTrueTypeOutlines`). Writing and maintaining two independent extractors that agree glyph-for-glyph is a real maintenance liability. Options: extract in the browser and store the outlines in the document (simple, but bloats the file and breaks server-side re-layout), or extract in Go and expose it to the browser (impossible in the static-export architecture), or maintain both with a shared conformance fixture set. The third is the likely answer and the cost should be acknowledged up front.
- Constraint solver scope creep. A general constraint solver is a CAD-scale project. The risk is building a weak version that satisfies nobody: too limited for technical drawing, too complex for illustration. Mitigation: hold the constraint set to the ten kinds in FR-36, keep the solver local to one group, cap iterations hard, and treat over-constrained systems as a first-class reported state rather than an edge case. If it cannot ship well within Phase 4, it should be cut rather than shipped weak.
- Mesh rendering on Canvas2D. There is no mesh primitive, so quality is bounded by subdivision cost. A large mesh will band. This is stated as a documented limitation with the GPU path (F44) as the fix, but if F44 slips, meshes ship with a visible quality ceiling. Open question: whether to ship meshes at all before the GPU path exists, or to gate the feature on it.
- CRDT granularity change. Moving a path's anchors from an opaque plain array to a per-anchor CRDT map is a change to how the document maps into the shared doc. F16 explicitly rejected per-page subdocuments on the grounds that a room-protocol change is something old clients sharing a live room cannot survive. This change is smaller (it is per-node, not per-room) but it is the same class of problem: an old client and a new client editing the same path in the same live room must both survive. Mitigation: the anchor `aid` is optional and absent files behave exactly as today, so a room containing any old client can fall back to the current whole-array reconciliation. This needs a spike before Phase 2 and it must not be assumed to be free.
- Coupling to F40. Almost everything structural here (live booleans, effect stacks, retained trace parameters) depends on F40's evaluation model landing first and landing in a shape that suits geometry. If F40's operator model turns out to be tuned for a different domain, this spec either waits or duplicates the mechanism, and duplicating it is explicitly the wrong answer. Phase 1 is deliberately independent of F40 so there is useful work to do while that settles.
- Server-side operator evaluation. The spec's default is that the Go renderer draws `result` or `baked` and never evaluates. That keeps export cheap and safe, but it means a document whose operator was never evaluated by a browser (imported through the API, generated by a script) exports as nothing. Open question: whether to accept that, to reject such documents at the write boundary, or to eventually port the operator evaluation to Go and inherit its resource-budget obligations.
- Effect stack placement. `PathNode.pathEffects` (inline, better old-client degradation) and `VectorOpNode` (wrapping, needed for multi-operand ops) are two mechanisms for one concept, chosen by arity. Risk: users see two different UIs for what feels like one feature, and the code maintains two evaluation entry points. Mitigation: one evaluation path in `@hc/geometry`, two storage shapes, one properties-panel presentation. Revisit if the split leaks into the UI.
