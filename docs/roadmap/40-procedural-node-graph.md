# F40: Procedural node graph and non-destructive editing

| Field | Value |
| --- | --- |
| Feature ID | F40 |
| Phase | 5 Creation depth |
| Sequence | 40 |
| Status | Not started |
| Depends on | `@hc/schema` (open file format, forward migration, `UnknownNode` round-trip), `@hc/engine` (framework-agnostic Canvas2D scene renderer, `scene.ts`/`render2d.ts`/`spatial.ts`/`tiles.ts`), F16 (realtime/CRDT: graph edits must converge like every other scene edit), F38 (accessibility/i18n/NFR: the graph panel is the hardest a11y surface in the product), F39 (AI Creative Studio / `@hc/aistudio` BYO-key layer, for graph generation and assist), F41 (vector authoring: the geometry ops the graph schedules), F42 (raster and painting: the pixel ops and the tile/buffer model), F43 (motion graphics: time as a graph input and per-frame evaluation), F44 (GPU rendering: the accelerated execution backend for raster and instancer kernels), F45 (interop and colour: SVG-filter/format mapping and the colour space evaluation runs in) |

A procedural node graph turns HyCanvas from an editor that mutates artwork into an editor that records how artwork is made. Every edit becomes an operation with live parameters instead of a destructive change to pixels or points, so a design is a recipe that re-renders at any zoom, any export size, and any colour space, and any decision in its history stays editable. This is the core of the F40 to F45 capability set that takes HyCanvas from a strong layout and collaboration product to a comprehensive 2D content-creation platform covering graphic design, digital art, and motion graphics. The hard constraint that shapes every decision here is that HyCanvas already ships real documents to real self-hosted instances: the graph is added alongside the existing scene tree, never in place of it, and a document carrying a graph must still open, render, and save correctly on a binary that has never heard of graphs.

## Current state

Audited against the code: `packages/schema/src/{schema,migrate,validate,factory,visitor,yjs,unknown-nodes}.ts` (schema v17); `packages/engine/src/{render2d,scene,effects,duotone,fills,pathclip,spatial,tiles,hit,renderer,image,color,math,animation,pose,transition,bench}.ts`; `packages/geometry/src/{boolean,stroke,flatten,simplify,shapes,query}.ts`; `packages/formula/src/graph.ts`; `packages/editor/src/{commands,registry,history,expression,clipboard,arrange,grouping,layers}.ts`; `packages/realtime/src/reconcile.ts`; `frontend/src/components/editor/{LayerPanel,PropertiesPanel,Canvas,PathEditor,EditorPanels}.tsx`; `frontend/src/store/editor.ts`; `backend/internal/render/{render,raster,svg,pdf,nodes_extra,anim,timeline,video,fonts}.go`, `backend/internal/persistence/{file,validate,migrate}.go`, `backend/internal/{crdt,jobs}`.

What exists today that this builds on. The file format already carries several proto-non-destructive constructs. `NodeBase` (`schema.ts:642-670`) has an optional `effects?: Effect[]` stack, where `Effect` is a discriminated union of `shadow` / `blur` / `glow` / `outline` / `adjustment` / `duotone` (`schema.ts:317-331`), and `adjustment` carries an ordered `ops: AdjustmentOp[]` list whose `name` is an unconstrained string with its vocabulary defined only in the renderer (`engine/src/effects.ts` `adjustmentOpToFilters`), so unrecognized ops are silently dropped. `TextNode` has a parallel `textEffects?: TextEffect[]` (`schema.ts:864-891`) with nine kinds, deliberately named apart to avoid clashing with `NodeBase.effects`. `BooleanNode` (`schema.ts:1514-1530`) is the closest thing to a graph node in the format today: it keeps its `operands` alongside an optional pre-evaluated `result?: VectorPath`, which is exactly the recipe-plus-bake shape this spec generalizes. `MaskNode` (`schema.ts:1498-1512`) is a single-child wrapper with its own `maskShape`. `PathNode` gained compound `contours?` at v15, and `GroupNode` (`schema.ts:1059-1073`) is a recursive container with `clip` and `isolation`. `Page.timelineDuration` and `BooleanNode.result` are the format's only two precedents for a persisted derived value. `NodeBase.data?: Record<string, unknown>` (`schema.ts:669`) is a documented, lossless per-node extension slot, explicitly protected from the v3-to-v4 deep colour rewrite alongside `UnknownNode.raw` (`migrate.ts:176`), and `packages/schema/src/yjs.ts` states the CRDT bridge is lossless including both. Migrations register as `export const migrations: Record<number, Migration>` keyed by SOURCE version, with `migrate(file, toVersion)` composing them forward-only.

The evaluation machinery has a real, shipped precedent that is not in the engine: `packages/formula/src/graph.ts` implements a dependency graph over sheet cells with `DependencyGraph { dependents, precedents }`, `buildDependencyGraph`, and `recompute(cells, changedKeys, getLiteral)`, which computes a transitive dirty set, topologically sorts it, detects cycles by back-edge, poisons every cell downstream of a cycle with `#CIRCULAR!`, and evaluates only the dirty set in order. That is the exact algorithm shape a node-graph evaluator needs, proven in production against the sheets surface. `packages/editor/src/expression.ts` is a hand-written recursive-descent arithmetic parser used for numeric property fields, explicitly never `eval`, and is the starting point for parameter expressions.

The renderer is framework-agnostic as required, and that is the engine's best asset for this work: `@hc/engine` depends on exactly `@hc/color`, `@hc/schema`, and `@hc/text`, with no React and no DOM in the hot path. `createScene(file, pageIndex)` (`scene.ts:445`) builds a parallel `SceneNode` tree over the open format, `renderScene(scene, ctx, viewport, opts)` (`render2d.ts:1969`) paints it against the hand-written structural `CanvasLike` interface (`types.ts:78-160`) whose optional members are capability-probed at every call site so a partial context degrades instead of throwing, `effectBleed(node)` (`scene.ts:44`) computes how far effects extend a node's bounds (`BLUR_HALO = 3`, `SHADOW_HALO = 1.5`), `effects.ts` maps `Effect[]` onto one CSS filter string plus separately stroked outlines, and `duotone.ts` holds the engine's only real cache, a 24-entry LRU keyed by a content string of asset id, size, colours, and intensity, which is the one existing precedent for cache-key-by-content. `RenderTarget.kind: "canvas" | "offscreen" | "node"` and `RenderContextKind = "2d" | "webgl2" | "webgpu"` declare the seams; `gpuAvailable()` returns false today. The Go export path (`backend/internal/render/{raster,svg,pdf,nodes_extra}.go`) is a second, independent tree walker over the same format, built on `golang.org/x/image/vector` with hand-rolled PDF and SVG writers and no third-party graphics dependency. `persistence/file.go` declares `type DesignFile map[string]any` with no Go node structs at all, so unknown node types and unknown fields round-trip through the backend automatically; `persistence/validate.go` enforces structural bounds (`maxNodeDepth = 64`, `maxNodeCount = 100000`, `schemaVersion` range-checked against `currentSchemaVersion = 17`) and returns `ErrInvalidFile`, mapped to 422 in `httpapi/persistence.go`. `backend/internal/crdt` proves the single Go binary can execute an embedded JavaScript bundle deterministically: `//go:embed fold.js` (a committed esbuild IIFE of the client fold, regenerated by `npm run gen:crdt-fold`) compiled once under goja, a fresh VM per call, bounded by `maxFoldFrames`, `maxFoldBytes`, and a 30-second `foldTimeout` enforced by a watchdog calling `vm.Interrupt`. That is the only hard wall-clock bound on any compute path in the backend, and it is directly relevant to running one evaluator implementation on both sides.

What does not exist. There is no graph anywhere in the file format, no evaluator in the engine, and no graph UI. Worse for this feature than the plain absence, most of what looks like non-destructive infrastructure is not:
- Booleans are baked, not live. `render2d.ts` case `"boolean"` (line 1100) reads the cached `node.result` and traces it with `moveTo`/`lineTo` only, so anchor handles are ignored and a curved boolean result renders as a polyline; absent a result it draws a placeholder box. `booleanOp(op, paths)` lives in `packages/geometry/src/boolean.ts` over `polygon-clipping`, and `@hc/engine` does not depend on `@hc/geometry` at all: the op is invoked from `frontend/src/store/editor.ts` (around line 3217), which bakes `node.result` into the document. Re-homing the geometry ops so the engine can evaluate them is a prerequisite, not a detail. `BooleanNode.operands` is typed `ShapeNode[]` rather than `Node[]`, so booleans cannot nest today.
- Masks do not render at all. `isContainer` (`packages/schema/src/visitor.ts`) covers only `group | frame | grid`, so `scene.ts` never builds a `SceneNode` for a `MaskNode.child`: the masked child is invisible to render, hit-test, bounds, and the spatial index, and the mask node itself falls through to `placeholderBox`. The Go side matches: raster has no mask case, SVG emits an unsupported-type comment, PDF drops it silently. The only working masking anywhere is hard-edged frame clipping. The same walker gap means `walkNodes`, `collectIds`, and `maxDepth` skip mask children and boolean operands, and Go's `walkNodes`/`collectNodes` recurse only into `children`, so ids nested elsewhere are invisible to comment anchoring and version diffs.
- Effects are one flat CSS filter string applied at exactly two sites in `paint`, set before the node's own content and cleared before children, so an effect can never apply to a subtree, never be interleaved with masks or fills, and never be individually enabled or blended. Inner shadow is unimplemented, outlines stroke the axis-aligned box rather than the geometry, and the extended adjustment ops (exposure, vibrance, warmth, tint, highlights, shadows) are documented approximations composed from native filters with no colour-managed path. `ImageEffectsSection` (`PropertiesPanel.tsx:2649`) surfaces them as three fixed tabs, not a reorderable stack. The Go RASTER renderer (PNG/JPEG, and the video frame path) now implements blend modes, drop shadows, shape strokes, and the effect kinds the browser supports (adjustments, blur, glow, outline, duotone) through isolated-layer compositing (`backend/internal/render/composite.go`, `effects.go`). `svg.go` and `pdf.go` still implement none of it, so vector export remains the divergent path. Two known Go-side deltas: an effect applies to the node's whole subtree where the browser resets before children, and shadow `spread` is ignored.
- Group opacity multiplies down per child (`parentAlpha * node.opacity`) instead of compositing the group as a layer, so a semi-transparent group of overlapping children shows overlap seams, and a group blend mode does not isolate because children re-set their own composite operation. There are no isolation groups and no offscreen group buffers.
- There is no caching of rendered subtrees and no dirty-subtree recompute. `bumpTextLayout()` is a no-op whose comment records that a text-layout cache was written and then reverted, so `layoutText(autoFitNode(...))` runs per text node per frame, and `buildBoxMap` reallocates a full node-id box map every frame. The `Scene` interface exposes `markDirty`/`invalidateRegion`/`dirtyRegion`/`clearDirty` and `SceneNode.dirty`, but `renderScene` never reads any of it and the frontend never mounts `RendererImpl`, so the dirty API is dead code; `tiles.ts` is imported only by tests. `SpatialIndex` is a uniform grid hash rather than a quadtree, `queryViewport` builds it lazily over selectable leaves once and never updates it, and the render path culls by linear tree walk instead. The frontend's only cache is `useEditorCanvas.ts`, a map of scenes keyed on the store's monotonic `rev` and cleared wholesale on any edit. `poseDesignAt` and `morphDesignAt` materialize an entire new `DesignFile` per animation frame and every caller then rebuilds the whole scene from it, which is the strongest existing motivation for a cached evaluation graph.
- There is no components/instances/symbols model (no `componentId`, `instanceOf`, or `boundVariables` anywhere in the repo), no user presets, no array or repeat operation, no scatter, no noise generator, no seeded randomization, no property bindings or expressions beyond the one-shot numeric field parser, and no subgraph or exposed parameter. The nearest existing reuse precedents are text style refs with `overrides?: Partial<CharStyle>`, whose `TextStyleSheet` is not even reachable from `DesignFile`, and the slide master/layout/placeholder cascade in `theme.ts`, which is the only working inheritance mechanism in the format.
- The format carries two incompatible geometry representations: `PathNode` uses `PathSegment`/`PathContour`, while `MaskNode`, `BooleanNode`, and connectors use `VectorAnchor`/`SubPath`/`VectorPath`. A graph needs one canonical geometry value type. `DesignFile` also has no `defs` dictionary: `assets`, `fonts`, `palette`, `masters`, `layouts`, and `sections` are arrays resolved by linear find, with no schema-level referential integrity.
- `LayerPanel.tsx` renders only `page.children` in reverse z-order with drag reorder and does not show nesting at all, so "the layer panel is a view of the structure" is currently true of one flat level.
- Node-type coverage diverges across the three Go backends (raster covers the most, then SVG, then PDF), the render entry points `ToPNG`/`ToSVG`/`ToPDF` take no `context.Context` and have no timeout, and there is no memory bound on stored designs (`maxRenderSide = 16384` is applied to inline, never-persisted files only). `render2d.ts` is 2067 lines with one large `drawNodeContent` switch and no per-type renderer registry, which is the main structural obstacle to adding evaluated node types.

Status legend: **Built** (ships today, code-referenced), **Partial** (some of it ships, gaps noted), **Not started**. Priorities are marked P0 (required for the phase to be usable), P1 (expected), P2 (later).

## Sequencing

**F38 (accessibility, i18n, security, compliance, self-host, NFR) precedes this spec.** That ordering was set in August 2026 on adoption evidence: internationalisation and accessibility show more evidence of blocking adoption than creative depth does, and both are axes a desktop-native incumbent cannot follow the product onto. The reasoning is recorded in `README.md` under "Why F38 precedes the creation-depth set" and in F38's own Priority section.

This does not reduce the value of the work below; it places it second, and it means the parts worth pulling forward early are the ones that serve the existing audience. For this spec that is non-destructive BEHAVIOUR (a re-editable effect stack presented as an ordinary list), not the graph panel. Note also that no demand evidence for a surfaced node graph was found from a template-first audience, which is why FR-3's progressive-disclosure rule is a hard contract rather than a preference.

## 1. Context and Goal

Professional 2D tooling has converged on the same idea from three directions. Compositing and VFX tools have been node graphs for decades because a shot is re-graded, re-timed, and re-delivered constantly and nobody can afford to re-do the work. Photo and raster tools moved to non-destructive adjustment layers and smart objects for the same reason. Motion tools express an animation as a graph of effects over time. What every one of them shares is that the artwork is data and the render is a consequence, so changing a decision from three hours ago costs one parameter edit. What almost none of them share is that the graph is also approachable: in most of these products the graph is either the only way to work (which excludes most designers) or a bolted-on expert mode disconnected from the layer view (which means the two views drift).

HyCanvas ships none of this today. Every edit is a destructive mutation of the scene tree, the one exception being the boolean node's preserved operands, which the renderer cannot even recompute. That is fine for layout work and it is why the product is fast and simple, but it is the ceiling on graphic design, digital art, and motion graphics: a designer cannot change the corner radius that a boolean consumed, cannot re-run a repeat with different spacing, cannot reorder a blur against a mask, and cannot resize a poster from A4 to a billboard without artefacts wherever a raster step was baked in.

The structural opening is the same one the rest of the roadmap exploits. The design file is an open, forward-migrating format with lossless round-trip of unknown content, so a graph can be added as data rather than as a proprietary side-channel, and it exports, self-hosts, and versions like everything else. The engine is already free of React and the DOM, so an evaluator placed correctly runs in the browser, in a worker, and in the Go headless export path. The CRDT is generic over the document shape, so graph edits converge without a bespoke protocol. And the sheets formula engine already proves the recompute algorithm in this codebase.

Intended outcome: a designer draws a shape, adds a blur, notices the blur should sit under the mask, drags it in the effect stack, turns the shape into a radial repeat of twelve, scrubs the count to nine and the angle offset to 4 degrees, exports the result at 300 ppi for print and at 4x for a billboard with no resampling artefacts, and never opens the graph panel. A second designer opens the same document, switches the panel to the graph view, sees exactly the structure the first designer built by direct manipulation, wires a noise generator into the repeat's rotation parameter with a stable seed, groups the whole thing into a subgraph, exposes `count`, `spacing`, and `seed` as three sliders, and saves it as a preset the team reuses. A third opens the document on a self-hosted instance running last month's binary, sees the artwork render correctly, edits the text beside it, saves, and loses nothing.

## 2. Scope

In scope:
- A graph runtime and evaluator (`@hc/procgraph`, pure, no React and no DOM) with dependency-ordered evaluation, incremental dirty-subgraph recompute, content-addressed result caching, cycle detection with diagnostics, and a stated determinism contract.
- Non-destructive editing as the default authoring model: an edit becomes a graph operation with live parameters, and the artwork stays resolution-independent data rather than baked pixels.
- Effect and adjustment stacks on any node or group: the pragmatic entry point, and the first surface where a graph exists at all.
- The dual view: the layer tree and the node graph as two projections of one structure, with a defined lowering (tree to graph) and lifting (graph to tree) contract, and write-back from either view.
- Procedural generators and instancers: linear/grid/radial repeats, path repeats, scatter, patterns, value and gradient noise, and seeded randomization with stable per-instance seeds.
- Node library organization, subgraphs (group a selection of ops into one collapsible node), exposed parameters on a subgraph, and reusable node presets shared through the existing template/asset surfaces.
- Parameter expressions and drivers: a safe expression language over parameters, other node properties, and graph inputs, built on `packages/editor/src/expression.ts`.
- Deterministic parity between the browser evaluator, the worker evaluator, and the Go headless export path, with a golden-fixture conformance suite.
- The schema, migration, degradation, and bake model that makes all of the above safe on a live instance.

Out of scope (owned elsewhere):
- The vector geometry operations themselves (offset, boolean, stroke-to-path, corner treatments, path effects) are F41; this spec schedules and caches them.
- Raster and painting kernels, brush engines, and the pixel buffer/tile model are F42; this spec owns their place in the graph and their cache keys.
- Time, keyframes, and per-frame playback are F43; this spec defines time as a graph input and the per-frame evaluation contract.
- The GPU execution backend is F44; this spec defines the backend-agnostic op interface and requires that the CPU path produce the same result within a stated tolerance.
- Colour spaces, ICC, and format interop mapping are F45; this spec requires that evaluation happen in a declared working space and that ops be colour-space aware.
- The CRDT protocol, presence, locks, and history are F16; this spec adds the graph's convergence and undo requirements on top.
- SSO, audit, observability, and compliance are F38; this spec adds the resource-bound and untrusted-evaluation posture.

Deferred:
- A data panel for graphical introspection (inspecting the actual list/geometry values flowing along an edge, not just the rendered result). Valuable for debugging a graph and cheap next to the evaluator itself, but it needs the list data model below to settle first.
- First-class custom attributes on list data (user-named per-instance fields carried alongside geometry). The instancer already varies parameters per instance; arbitrary attributes are the general form and should follow real usage rather than precede it.
- A node-graph outliner (a tree view of the graph itself). The LAYER tree view is P1 in the matrix above; a second tree over the graph is a different panel and is not committed.
- Compiling a graph to a standalone parametric program that runs outside the editor. The evaluator is already pure and portable, so this is reachable, but it is a distribution and sandboxing question rather than an evaluation one.
- Procedural PBR material generation. It presumes a lighting and shading model this product does not have, and adding one to serve a texture generator is the wrong order.
- User-authored custom nodes (JavaScript/WASM op definitions). Specified here for the sandbox and threat model so the earlier phases do not paint us into a corner, but not committed before Phase 5.
- Simulation domains (particles, softbody, fluid-like advection, physics-driven layout), which require a stateful, frame-ordered evaluation model that the stateless pull-based evaluator deliberately does not have.
- Graph-first documents, where a page has no tree at all and is only a graph. Specified as the migration target in section 18, not built.
- A public op-plugin marketplace, which depends on custom nodes plus the ecosystem work outside this spec.

## 3. User Stories

- As a designer, I want to change the blur radius I set an hour ago without undoing everything after it, so exploration is cheap.
- As a designer, I want to reorder a blur, a mask, and a colour adjustment against each other and see the difference immediately, so I can get the look right instead of approximating it.
- As a designer, I want a poster I built at A4 to export at billboard size with no soft edges or resampling, because nothing in it was ever baked to pixels.
- As an artist, I want to place twelve copies of a shape around a circle, scrub the count and the radius, and have every copy stay live, so a pattern is a parameter and not a chore.
- As an artist, I want randomization that is stable: the same seed gives the same scatter on my machine, my colleague's machine, and the export server.
- As a motion designer, I want an effect stack whose parameters can be keyframed and whose evaluation is identical in preview and in the rendered file.
- As an advanced user, I want to open a graph view of what I built by direct manipulation, wire one parameter into another, group it into a subgraph, expose three sliders, and save it as a preset.
- As a team, I want to share a preset that other documents instantiate, and have an update to the preset be an explicit, reviewable action rather than a silent change to shipped work.
- As a casual user, I want to never see a node graph, and to still get non-destructive behaviour by default.
- As a self-hoster, I want a document containing graphs to open on the binary I have not upgraded yet, render correctly, and save without losing the graph.
- As an operator, I want a hostile or accidentally enormous graph to be rejected or bounded rather than to consume the export worker.
- As a screen-reader user, I want the graph to be fully operable and comprehensible without seeing the node-link diagram.

## 4. Feature matrix / scope

Status values: **Built**, **Partial**, **Not started**.

### Graph runtime and the dual view

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Graph data model in the open format | Not started | `packages/schema/src/schema.ts` | P0. Optional `graph?: NodeGraph` on `NodeBase`, additive, plus `GraphOp.raw` for forward-compat with ops a newer client wrote. Section 7. |
| Recipe-plus-bake node pattern | Partial | `schema.ts:1514-1530` (`BooleanNode.operands` + `result`) | P0. The pattern exists for exactly one node and the renderer cannot recompute it (`render2d.ts:1100` draws `result` or a placeholder, ignoring anchor handles). `operands: ShapeNode[]` also prevents nesting. Generalize the pattern and make recompute the norm, with the bake as the fallback rather than the source. |
| One canonical geometry value type | Not started | `schema.ts` (`PathSegment`/`PathContour` vs `VectorAnchor`/`SubPath`/`VectorPath`) | P0. Two incompatible path representations exist in the format today; a graph passing geometry between ops needs one. Additive: define the canonical type for graph values, leave both node representations untouched. |
| Per-node extension slot for prototyping | Built | `schema.ts:669` (`NodeBase.data`), `packages/schema/src/yjs.ts` | P0 enabler. Lossless through the CRDT bridge and the opaque Go `map[string]any`. Phase 1 can carry an experimental graph in `data` with no version bump before the typed field lands. |
| Tree-to-graph lowering (every subtree has a canonical graph form) | Not started | n/a | P0. Groups lower to merge ops, masks to mask ops, `boolean` to a boolean op, `effects[]` to an effect chain, leaf nodes to source ops. Section 5. |
| Graph-to-tree lifting with write-back | Not started | n/a | P0. Graph edits expressible as a tree write straight back into the tree; edits that are not get persisted as an explicit `graph` payload on the owning node. |
| Layer panel as a real tree view | Partial | `LayerPanel.tsx` | P1. Today it lists `page.children` flat in reverse z-order with drag reorder; it shows no nesting at all, so it is not yet a view of the structure. Nesting, effect-stack rows, and graph rows all land here. |
| Graph panel (node-link editing surface) | Not started | n/a | P1. Optional advanced view, never required (FR-3). |
| Subgraphs / grouping ops into one collapsible node | Not started | n/a | P1. |
| Exposed parameters on a subgraph | Not started | n/a | P1. The mechanism that makes a subgraph reusable and keeps the graph out of the casual user's way. |
| Node presets / reusable graph fragments | Not started | n/a | P2. Reuses `@hc/templates` and the asset surfaces rather than a new store. |
| Components / instances / symbols | Not started | n/a | P2. Nothing in the schema today (no component, instance, or symbol type). A subgraph preset is the nearest neighbour and should be designed so a component model can be built on it rather than beside it. |

### Evaluation engine

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Dependency graph with precedents/dependents | Partial (precedent) | `packages/formula/src/graph.ts` (`buildDependencyGraph`) | P0. The exact structure needed exists for sheet cells. Generalize it into `@hc/procgraph` rather than writing a second one. |
| Dirty-set computation and topological evaluation | Partial (precedent) | `formula/src/graph.ts` (`recompute`) | P0. Transitive dirty set, topological sort restricted to intra-dirty edges, evaluation in order. Same algorithm, different node payloads. |
| Cycle detection and poisoning | Partial (precedent) | `formula/src/graph.ts` (back-edge detection, `#CIRCULAR!`) | P0. Graphs need a diagnostic on the offending op plus a fall back to the last good bake, not an exception and not a blank node. |
| Content-addressed result cache | Not started | n/a | P0. No caching of rendered subtrees exists anywhere in the engine today (`render2d.ts` has an explicitly reverted text-layout cache and a duotone offscreen cache; nothing else). |
| Incremental recompute on parameter change | Not started | n/a | P0. Store-level invalidation today is a coarse `rev` counter in `frontend/src/store/editor.ts`; `useEditorCanvas.ts` clears its whole scene map on any bump and the canvas fully repaints. |
| Scene dirty-tracking API | Partial (dead) | `engine/src/types.ts` (`markDirty`/`invalidateRegion`/`dirtyRegion`/`clearDirty`, `SceneNode.dirty`) | P1. The interface exists and is honest about intent, but `renderScene` never reads it, `SceneNode.dirty` is written and never read, and the frontend never mounts `RendererImpl`, so it is dead code. Either wire it to the evaluator or delete it; leaving a dead invalidation API next to a real one is the worse outcome. |
| Preview-quality vs final-quality evaluation | Not started | n/a | P1. One evaluation mode is not enough: a scrub must be cheap and an export must be exact. |
| Worker-offloaded evaluation | Not started | n/a | P1. The engine is already framework-agnostic and DOM-free, so the constraint is the transport of buffers, not the code. |
| Viewport-scoped and tile-scoped evaluation | Partial (substrate) | `engine/src/spatial.ts` (`SpatialIndex`), `engine/src/tiles.ts` (`tilesForRegion`) | P1. Culling and tiling exist for rendering; the evaluator must consume them so an off-screen instancer branch is not evaluated. |
| Determinism contract (browser / worker / Go) | Not started | n/a | P0. Section 6, determinism group. `backend/internal/crdt` proves the single Go binary can run an embedded JS bundle deterministically. |
| Golden-fixture conformance suite across runtimes | Not started | n/a | P0. The only defence against silent browser/server divergence. |
| Evaluation diagnostics surfaced in the UI | Not started | n/a | P1. Per-op error, timing, cache hit/miss, and output size, readable without a debugger. |

### Effect and adjustment stacks

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Node effect array | Built | `schema.ts:317-331` (`Effect`), `schema.ts:649`; `engine/src/effects.ts`; `PropertiesPanel.tsx:1356` (`NodeEffects`) | Six kinds (shadow, blur, glow, outline, adjustment, duotone) collapsed into one CSS filter string at one fixed point in the node's paint. Inner shadow unimplemented; outlines stroke the box, not the geometry; `AdjustmentOp.name` is an open string whose vocabulary lives only in the renderer, so unknown ops are silently dropped. |
| Image adjust/filter/effect UI | Built | `PropertiesPanel.tsx:2649` (`ImageEffectsSection`), `store/editor.ts` `setEffects`/`commitEffects` | Three fixed tabs, presets and auto-enhance, one undo step per commit. Not an ordered, reorderable stack. |
| Text effect array | Built | `schema.ts:864-891` (`TextEffect`, `textEffects`) | A parallel stack kept separate to avoid clashing with `NodeBase.effects`; the graph must unify their evaluation without merging their storage. |
| Reorderable effect stack (drag to reorder ops) | Not started | n/a | P0. The single highest-value entry point: it is a graph the user can understand as a list. |
| Effects interleaved with masks, fills, and geometry | Not started | n/a | P0. Today an effect cannot sit under a mask or between two fills, because there is no ordering model that spans them. |
| Live (non-baked) adjustment layers over a group | Not started | n/a | P1. A group-scoped adjustment op that reads its downstream composite. |
| Effect stack on any node type, not only images | Partial | `NodeBase.effects` applies to any node; the UI mostly does not | P1. The schema is general; the surfaces are not. |
| Effect-driven bounds (bleed) | Built | `engine/src/scene.ts:44` (`effectBleed`) | Already computes how far effects extend a node's bounds; the evaluator must keep this correct as the stack becomes arbitrary. |
| Blend modes as graph composite ops | Partial | `schema.ts:179-187` (`BlendMode`), `NodeBase.blendMode`, `render2d.ts` `blendToComposite` | P1. Blend exists per node; the graph needs it per composite edge. |
| Group isolation / offscreen layer compositing | Not started | `render2d.ts` `paint` (`parentAlpha * node.opacity`) | P0. Group opacity multiplies down per child instead of compositing the group as a layer, so overlapping children in a semi-transparent group show seams, and a group blend mode does not isolate. A graph that composites correctly requires the offscreen group buffer this never had. |
| Masks as a live composite op | Not started | `schema.ts:1498-1512` (`MaskNode`); `engine/src/scene.ts` `isContainer`; Go `render/*.go` | P0. `MaskNode` is unrendered in every backend: the engine never builds a `SceneNode` for its child (invisible to render, hit-test, bounds, and the spatial index) and draws a placeholder; Go raster has no case, SVG emits an unsupported comment, PDF drops it. Only hard-edged frame clipping works today. Prerequisite work, not incidental. |
| Geometry ops reachable from the engine | Not started | `packages/geometry/src/boolean.ts`; `frontend/src/store/editor.ts` (bakes `node.result`) | P0. `@hc/engine` does not depend on `@hc/geometry`; boolean and stroke-to-outline run in the frontend store and bake their result. Re-homing the geometry kernels behind the evaluator is a prerequisite for any live geometry op. |

### Generators, instancers, and randomization

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Linear / grid repeat | Not started | n/a | P0. Nothing in the schema or engine repeats anything; `duplicateOps` in `packages/editor/src/clipboard.ts` copies nodes destructively. |
| Radial repeat | Not started | n/a | P0. |
| Repeat along a path | Not started | n/a | P1. Depends on F41 path sampling. |
| Scatter with density and collision avoidance | Not started | n/a | P1. |
| Seeded pseudo-random parameter variation per instance | Not started | n/a | P0. A named, stable PRNG keyed on `(graph seed, op id, instance index)`. Stability across runtimes is a determinism requirement, not an implementation detail. |
| Value / gradient / fractal noise generators | Not started | n/a | P1. |
| Pattern fills as a live graph output | Partial | `schema.ts` pattern `Fill` (`repeat: tile/mirror/no-repeat`), `render2d.ts:154-185` | P1. A pattern fill references a raster asset and tiles it; it cannot reference a live procedural output. |
| Instance overrides (per-instance parameter edits) | Not started | n/a | P2. The feature that makes instancers usable for real work and the hardest to keep stable under a changing instance count. |
| Instance culling and lazy evaluation | Not started | n/a | P0 for scale. Rides `SpatialIndex`/`tiles.ts`. |

### Parameters, expressions, and drivers

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Safe arithmetic on numeric property fields | Built | `packages/editor/src/expression.ts` | Recursive-descent parser, explicitly never `eval`, relative (`+10`, `*2`) and absolute forms. The seed of the expression language. |
| Named parameters with type, range, and default | Not started | n/a | P0. |
| Expressions referencing other parameters and node properties | Not started | n/a | P1. Must extend the existing parser, not introduce a second language or a sandboxed `eval`. |
| Drivers (one parameter animates or derives another) | Not started | n/a | P2. Overlaps F43 for time-based drivers. |
| Parameter keyframing | Not started (F43) | `schema.ts` `KeyframeTrack`, `engine/src/pose.ts` | P1 for F43. The keyframe model exists for transform/opacity channels; graph parameters must become a channel rather than a parallel system. |
| Unit-aware parameters (px/mm/in/pt) | Partial | `schema.ts` `Unit` | P1. Units exist in the format; parameters must carry them so a graph is resolution and medium independent. |

### Node library and authoring

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Op catalog with stable ids, versions, and metadata | Not started | n/a | P0. Op ids are never localized; display names are (section 12). |
| Searchable node library with categories | Not started | n/a | P1. |
| Node presets shipped with the product | Not started | n/a | P1. |
| User-saved presets shared in a workspace | Not started | n/a | P2. Reuses `@hc/templates` plus the existing asset/permission surfaces. |
| Custom node authoring (user code) | Not started | n/a | P2, deferred. Sandbox and threat model specified in section 11 so earlier phases do not preclude it. |
| Simulation domains | Not started | n/a | Deferred. Requires stateful frame-ordered evaluation the pull-based evaluator does not have. |

### Rendering, export, and the headless path

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Framework-agnostic renderer (browser/worker/server) | Built | `engine/src/renderer.ts`, `render2d.ts`, `scene.ts`; no React or DOM dependency | The constraint this spec must not break: the evaluator goes in a pure package the engine consumes. |
| Independent Go tree walker for export | Built | `backend/internal/render/{raster,svg,pdf,nodes_extra}.go` | A second full implementation of the format, on `golang.org/x/image/vector` with hand-rolled PDF and SVG writers. Every graph op needs a matching Go path or an explicit documented fallback. |
| Consistent node coverage across raster/SVG/PDF | Partial | `render/raster.go`, `svg.go`, `pdf.go` | P0 for FR-13. Coverage diverges (raster is the most complete, then SVG, then PDF): `boolean` is raster-only, `table` and `chart` are raster-only, `mask` is nowhere. "Renders identically" has to name which backend is normative before the conformance suite means anything. |
| Go evaluation of non-destructive nodes | Not started | `render/raster.go:753` (`case "boolean"`) | Reads the cached result, like the browser. Honest today, unacceptable once graphs are the norm. |
| Bounded, cancellable server render | Not started | `render.ToPNG`/`ToSVG`/`ToPDF` (no `context.Context`); `httpapi/export.go` (`maxRenderSide` inline-only) | P0 for section 11. No timeout, no memory bound, and no concurrency cap on render today; the page-size guard applies to inline files only, so a stored design is unbounded. Procedural evaluation cannot ship on that. |
| Embedded JS execution in the Go binary | Built (precedent) | `backend/internal/crdt` (client bundle under a pure-Go JS engine, byte-identical output) | P0 enabler. The same technique gives one evaluator implementation instead of two that drift. Cost and the native-kernel split are section 18. |
| Bake maintained for every graph-bearing node | Not started | n/a | P0. The mechanism that makes graphs safe on an older client and gives export a guaranteed fallback. |
| Resolution-independent re-render at export size | Partial | Vector nodes already re-render; raster and baked steps do not | P0 outcome. The point of the whole feature set. |

## 5. UX and interaction behavior

The interaction model, not restated from the shipped editor (selection, transforms, panels, undo) or from F16 (presence, locks, connection state).

- Progressive disclosure is a hard product rule, not a preference. Direct manipulation stays the default and every ordinary edit silently writes into the graph. Drawing a shape, adding a blur, applying a mask, and duplicating with an offset all produce graph operations without the user ever seeing a node. The graph panel is an optional advanced view behind a toggle in the right rail. If the graph is ever REQUIRED to complete an ordinary design task, the platform's accessible positioning is lost and the design is wrong; FR-3 states this as a testable contract and AC-3 tests it.
- Two views of one structure. The layer panel and the graph panel read the same evaluated structure. Selecting a layer highlights its op in the graph; selecting an op highlights its layer. Reordering rows in the layer panel reorders ops; reordering ops reorders rows. There is no "convert to graph" action, because there is nothing to convert: the graph is a rendering of what already exists, plus whatever the user has added that the tree cannot express.
- The effect stack is the on-ramp. On any node, the properties panel shows an ordered, drag-reorderable list of operations: fills, strokes, masks, adjustments, blurs, shadows, and repeats, each with an eye toggle, a collapse arrow, and its parameters inline. This list IS a linear graph, and it is the linear view that section 12 requires for accessibility. Most users will never need more.
- Parameters are always live. Every op parameter is a normal editor control (number field, slider, colour, curve, enum) that respects the existing numeric-expression syntax (`+10`, `*2`, `100/2`). Scrubbing a parameter recomputes only its dirty subgraph at preview quality and repaints in the same frame budget; releasing commits one undoable command through the `@hc/editor` command framework, exactly like every other edit.
- Instancers read as one object. A radial repeat of twelve is one layer row with a count of 12, not twelve rows. Selecting it selects the instancer; entering it (the same gesture that enters a group) selects the source. Per-instance overrides, when they land, are a badge on the row and an override list, never twelve rows.
- Subgraphs collapse. Selecting several ops and grouping them yields one node with named input and output sockets and an exposed-parameter list. Collapsed, it is a single layer row with sliders. Expanded, it is a graph.
- Diagnostics are visible, not hidden. An op that fails, cycles, or exceeds a resource bound shows an inline error on its row and on its node, the node renders its last good bake with a distinct outline, and the document stays editable. A graph never renders a blank node and never throws away the user's work.
- Bake divergence is surfaced, never resolved silently. If a document's baked output does not match what the graph evaluates to (because an older client edited the baked children, section 7), the affected node is flagged on open with two explicit choices: keep the older client's edit and detach the graph (the graph payload is retained, not deleted), or re-evaluate and discard the edit. Neither happens without the user choosing.
- Performance is legible. A graph node shows its last evaluation time and whether it was a cache hit, and the panel can sort by cost, so a slow graph is diagnosable by the person who built it.

## 6. Functional requirements

Grouped by theme. These FR ids are the durable contract referenced by the acceptance criteria and the feature matrix.

Structure and the dual view:
- FR-1: A node may carry an optional graph. The graph is additive to the scene tree and never replaces it: a page is still an ordered tree of nodes, and a graph is scoped to the node or group that owns it. Every existing traversal, hit test, spatial index entry, export walk, animation pose, and CRDT reconciliation keeps working on documents that contain graphs.
- FR-2: Every scene subtree has a canonical lowering to a graph (leaves become source ops, groups become merge ops, `mask` becomes a mask op, `boolean` becomes a boolean op, `effects[]` becomes an ordered effect chain, `blendMode` and `opacity` become composite parameters), and every graph whose result is expressible as a tree has a lifting back to one. Editing either view mutates the same underlying structure: an edit expressible in the tree writes to the tree, and an edit that is not writes to the owning node's `graph`. The two views are never separately authoritative and never require a sync step.
- FR-3: The graph is never required. Every capability reachable through the graph panel that a non-expert would reasonably expect (add and reorder effects, repeat an object, adjust colour, mask, combine shapes, randomize with a seed) is also reachable through direct manipulation and the properties panel, and direct manipulation writes the same graph operations. A task that can only be completed by opening the graph panel is a defect.
- FR-4: A graph carries an ordered list of ops, typed sockets, and edges, plus a designated output op. An op the client does not recognize is preserved verbatim in `GraphOp.raw` and passed through on save, mirroring `UnknownNode.raw` for node types, so a newer client's ops survive an older client's round-trip.
- FR-5: Ops can be grouped into a subgraph with named input and output sockets and a list of exposed parameters. A subgraph is instantiable as a preset; instantiating a preset copies it by value, and updating a preset never silently changes documents that already instantiated it.

Evaluation:
- FR-6: Evaluation is dependency-ordered: an op runs only after every op it depends on has produced a result, computed by the same precedents/dependents structure used by `packages/formula/src/graph.ts`.
- FR-7: Evaluation is incremental. A parameter change marks the transitively dependent subgraph dirty and recomputes only that subgraph; clean results are reused from cache. Changing a leaf parameter of a 500-op graph must not re-run 500 ops.
- FR-8: Results are cached content-addressed. A cache key is a hash of the op id, the op's declared version, the canonically serialized resolved parameters, the hashes of its input results, and the evaluation environment (quality, working colour space, output resolution class). Identical subgraphs, including identical instances of the same preset in different documents, share cache entries. The cache is bounded by a byte budget with LRU eviction and is never load-bearing for correctness.
- FR-9: Cycles are detected, reported per op, and contained. The evaluator marks the cycle and everything downstream of it as unevaluable, surfaces a diagnostic on the offending ops, renders the affected node from its last good bake, and leaves the rest of the document evaluating normally. A cycle never throws, never blanks the canvas, and never blocks a save.
- FR-10: Evaluation is bounded. A graph declares (and the evaluator enforces) limits on op count, total generated instances, output node count, output pixel area, subgraph nesting depth, and wall-clock time per evaluation. Exceeding a bound produces a diagnostic and the last good bake, never an unbounded allocation. The write boundary (`persistence/validate.go`) rejects a file whose declared graph exceeds the structural bounds with 422 before any evaluator sees it.
- FR-11: The evaluator supports at least two quality modes. Preview evaluation may reduce raster resolution, instance counts above a threshold, and iteration counts, and must be visually representative. Final evaluation is exact and is the only mode used for export. The quality mode is part of the cache key, so a preview result can never be served to an export.
- FR-12: Evaluation runs off the main thread where the platform allows it, and the pure evaluator carries no React, no DOM, and no browser-only API, so the same code runs in the browser, in a worker, and headless on the server.

Determinism:
- FR-13: Evaluation is deterministic. Given the same document, the same op catalog version, the same fonts, and the same evaluation environment, the browser, the worker, and the Go headless export path produce the same result: bit-identical for geometry, parameter, and structural outputs, and within a stated, tested per-op tolerance for floating-point raster kernels.
- FR-14: Determinism is enforced by construction, not by convention. Ops may not read wall-clock time, system locale, environment, network, or an unseeded random source; iteration over unordered collections is forbidden; float-to-string conversion for hashing uses one canonical serializer; op execution order within a dependency level is fixed by a canonical sort. The op interface makes these unavailable rather than merely discouraged.
- FR-15: Randomization is seeded and stable. A named PRNG seeded from the tuple (graph seed, op id, instance index, channel) produces the same sequence in every runtime and every process. Adding an op elsewhere in the graph does not change an existing op's sequence, and re-ordering unrelated branches does not perturb it.
- FR-16: A golden-fixture conformance suite runs the same graph corpus through the browser evaluator, the worker evaluator, and the Go export path in CI and fails on any divergence beyond the declared tolerance. New ops ship with fixtures or they do not ship.

Effects, generators, and instancers:
- FR-17: Any node or group carries an ordered, reorderable stack of operations that spans fills, strokes, masks, adjustments, blurs, shadows, and geometry ops. Reordering the stack changes the rendered result accordingly, and the existing `Effect[]` and `TextEffect[]` arrays lower into this stack without changing their storage or their meaning in older files.
- FR-18: Group-scoped adjustment operations apply to the composite of everything below them within the group, non-destructively, and can be toggled, reordered, and removed without touching the content they affect.
- FR-19: Instancer ops (linear, grid, radial, along-path, scatter) generate instances of an input branch with per-instance transforms and per-instance parameter variation. Instances are lazily evaluated and viewport-culled through the existing `SpatialIndex` and tiling machinery, so an off-screen instance costs nothing to draw and, above a declared count threshold, nothing to evaluate.
- FR-20: Generators (value, gradient, and fractal noise, gradients, patterns) are resolution-independent: they are evaluated at the output resolution requested by the consumer, so the same graph exported at 1x and at 8x produces a correspondingly detailed result and never an upscaled one.
- FR-21: Artwork produced by the graph is data, not baked pixels. Exporting a document at a different size, ppi, or colour space re-evaluates the graph at that target rather than resampling a previous render, except where an op is inherently raster (an imported photo, a paint stroke), in which case the raster input is resampled and everything downstream of it is re-evaluated.

Parameters and expressions:
- FR-22: Parameters are typed, named, ranged, defaulted, and unit-aware, and every parameter is editable through an ordinary properties-panel control.
- FR-23: A parameter may hold a literal, a reference to an exposed parameter, or an expression over parameters and node properties. Expressions are parsed by an extension of the existing recursive-descent parser in `packages/editor/src/expression.ts`, are never evaluated with `eval` or `Function`, are pure, are bounded in depth and time, and participate in the same dependency graph and cycle detection as op edges.

Persistence, degradation, and collaboration:
- FR-24: Every graph-bearing node maintains a bake: the last evaluated output persisted as ordinary schema nodes on the owning node, plus a hash of the graph and inputs that produced it. A client that does not understand graphs renders the bake, which is correct artwork, not a placeholder.
- FR-25: A document containing graphs opens, renders, edits, and saves on a client that predates graphs, without losing the graph. The graph is carried on a node type the older client already knows, so it survives its Zod validation path, its generic CRDT reconciliation (`packages/realtime/src/reconcile.ts` iterates source keys generically), and the backend's opaque `map[string]any` document handling.
- FR-26: If the bake and the graph diverge (an older client edited the baked output), the divergence is detected on open by hash comparison, surfaced to the user, and resolved only by an explicit choice: detach the graph and keep the edit (retaining the graph payload), or re-evaluate and discard the edit. Never silently.
- FR-27: Graph edits converge under the CRDT like every other scene edit, are single undoable commands through the `@hc/editor` command framework, and fan out to peers. Two users editing different ops of the same graph converge without loss; two users editing the same parameter converge to one value by the existing last-writer-wins semantics for scalar fields.
- FR-28: Every schema change for this feature is additive-first: new optional fields and new op ids only, never a repurposed or narrowed existing field. Each bump raises `CURRENT_SCHEMA_VERSION` in `packages/schema/src/schema.ts` and the Go mirror `currentSchemaVersion` in `backend/internal/persistence/file.go` in the same change, registers a forward migration step in `migrate.ts`, and appends a line to the version-history comment.

Export and AI:
- FR-29: The Go headless export path evaluates graphs rather than only reading bakes. Where an op has no server implementation, the exporter falls back to the bake, records that fallback in the export result, and warns the user rather than silently producing different output.
- FR-30: AI graph assistance runs on `@hc/aistudio`: a model may propose a graph or a graph edit, its output is validated against the op catalog (unknown ops are rejected, not passed through as `raw`), pre-checked against the FR-10 resource bounds, and applied as one undoable command. AI never writes ops the user cannot see, inspect, and edit.

## 7. Data model / schema changes

The schema-is-contract rule applies unchanged: extend the types and Zod schemas in `packages/schema/src/schema.ts`, give new structures defaults in `factory.ts`, register a forward migration step in `migrate.ts` keyed on the source version, and bump `CURRENT_SCHEMA_VERSION` (currently 17). Two coupling rules apply to every bump: (1) raise the Go mirror `currentSchemaVersion` in `backend/internal/persistence/file.go` in the same change, or the write boundary `persistence/validate.go` rejects the newer file with 422 (`ErrInvalidFile`, the check is `schemaVersion` in `1..currentSchemaVersion`) and nothing persists; (2) append a one-line entry to the schema-version-history doc-comment above `CURRENT_SCHEMA_VERSION`.

The critical decision is where the graph lives. It goes on `NodeBase` as an optional field, NOT as a new node type. A new `procgraph` node type would be preserved losslessly by `UnknownNode.raw` on an older client, but it would render as nothing, because an older renderer has no case for it. An optional field on an existing container node means an older client sees an ordinary `group` whose `children` are the baked output, renders correct artwork, and carries the unknown `graph` field through unchanged: `validate.ts` uses `safeParse` for validation and the store keeps the raw document rather than the parsed projection, `reconcile.ts` iterates `Object.keys(source)` generically rather than against a field allowlist, `packages/schema/src/yjs.ts` states the bridge is lossless including extension slots, and `backend/internal/persistence/file.go` handles a `DesignFile` as opaque `map[string]any`. Correct rendering on an old binary beats lossless preservation of something invisible.

Phase 1 may prototype the graph inside the existing `NodeBase.data?: Record<string, unknown>` extension slot (`schema.ts:669`) with no version bump at all, then promote it to a typed optional field once the shape settles. The promotion migration reads `data.graph` and writes `graph`, leaving `data` otherwise untouched.

```ts
// The graph carried by a node. Optional and additive everywhere it appears.
interface NodeGraph {
  /** Graph payload format version, independent of CURRENT_SCHEMA_VERSION so an
   *  op-catalog change does not force a file-format bump. */
  version: number;
  ops: GraphOp[];
  edges: GraphEdge[];
  /** Op id whose result is this node's rendered content. */
  output: string;
  /** Parameters promoted to the owning node's properties panel. */
  exposed?: ExposedParam[];
  /** Root seed for every PRNG in this graph (FR-15). */
  seed?: number;
  /** Provenance of the baked output stored on the owning node (FR-24, FR-26). */
  bake?: { hash: string; opCatalogVersion: number; at: string; quality: "preview" | "final" };
  /** Declared bounds, checked at the write boundary before any evaluation (FR-10). */
  limits?: { maxOps?: number; maxInstances?: number; maxOutputNodes?: number; maxPixels?: number; maxMillis?: number };
}

interface GraphOp {
  id: string;
  /** Stable, never-localized catalog id, e.g. "effect.blur", "repeat.radial". */
  op: string;
  /** Catalog version this op was authored against; part of the cache key. */
  opVersion: number;
  params: Record<string, ParamValue>;
  disabled?: boolean;
  /** User-visible label; the op id is what the evaluator dispatches on. */
  label?: string;
  /** Forward compatibility inside the graph, mirroring UnknownNode.raw: an op
   *  this client does not know is preserved verbatim and passed through on
   *  save. The evaluator skips it and the node falls back to its bake. */
  raw?: Record<string, unknown>;
}

interface GraphEdge {
  from: { op: string; socket: string };
  to: { op: string; socket: string };
}

type ParamValue =
  | { kind: "literal"; value: number | string | boolean | Color | Unit_ }
  | { kind: "param"; name: string }              // reference to an exposed param
  | { kind: "expr"; source: string };            // parsed, never eval'd (FR-23)

interface ExposedParam {
  name: string;
  label?: string;
  type: "number" | "integer" | "boolean" | "string" | "color" | "enum" | "length";
  unit?: Unit;                 // reuses the existing Unit union
  min?: number; max?: number; step?: number;
  default: unknown;
  options?: { value: string; label: string }[]; // enum only
  /** Op + param this exposed control drives. */
  targets: { op: string; param: string }[];
}

// Additive optional field on NodeBase, so any node (in practice a group)
// can own a graph while still being a node every older client understands.
interface NodeBase {
  // ... existing fields unchanged ...
  graph?: NodeGraph;
}

// A subgraph preset: a reusable graph fragment, stored beside assets rather
// than inside a node, and copied by value on instantiation (FR-5).
interface GraphPreset {
  id: string;
  name: string;
  category?: string;
  graph: NodeGraph;
  exposed: ExposedParam[];
}
// DesignFile gains optional graphPresets?: GraphPreset[]; older files omit it.
```

Bake semantics. A graph-bearing node is an ordinary node whose visible content is the evaluated output. For a group, `children` hold the bake; for a leaf, the node's own geometry or image content is the bake. `graph.bake.hash` is the hash of the canonical graph plus the hashes of its external inputs. On open, a graph-aware client compares the stored hash against a freshly computed one: equal means the bake is trustworthy and can be used until something dirties it; unequal means either the graph changed (re-evaluate) or the bake was edited by a client that did not know about the graph (FR-26 divergence prompt). Writing a graph always writes a matching bake, so the format never contains a graph without renderable artwork.

Migration plan. Each batch is one additive bump with one registered step in `migrate.ts`, and every step is a pure, idempotent no-op on documents that have no graphs:
- v18: `NodeBase.graph` plus the effect-stack lowering. No existing field changes meaning. `Effect[]` and `TextEffect[]` stay exactly where they are and keep their current semantics; the graph reads them, it does not move them. A v17 file opens with no graphs and renders identically.
- v19: `DesignFile.graphPresets` and subgraph/exposed-parameter support. Additive.
- v20: generator and instancer op families. No schema shape change beyond new op ids, which are data rather than types, so this bump exists only to record the catalog level in the version history.
- Downgrade posture: migration is forward-only (`migrate.ts` throws `MigrationError` on a downgrade). A rollback to a previous binary is safe because the previous binary opens the file as an older-client case (FR-25): it reads the bake, ignores the `graph` field, and preserves it.

Nesting rule. Any nodes a graph produces or holds are carried under `children`, never under a new key. Four separate walkers already recurse only into `children` (`packages/schema/src/visitor.ts` `walkNodes`/`collectIds`/`maxDepth`, Go `persistence/file.go` `walkNodes`/`collectNodes`, `persistence/validate.go` `validateNodes` which type-gates its `mask`/`boolean` descent, and `httpapi/export.go` `boundedTimeline`), and `MaskNode.child` and `BooleanNode.operands` already fall through those gaps: ids nested inside them are invisible to id-uniqueness validation, comment anchoring, and version diffs. Using `children` inherits none of that. If a graph ever must nest elsewhere, all four walkers change in the same commit.

Structural bounds at the write boundary. `persistence/validate.go` already enforces `maxNodeDepth = 64` and `maxNodeCount = 100000` and rejects with 422. Graph-specific bounds are added in the same place and in the same style: maximum ops per graph, maximum total ops per document, maximum edges per op, maximum subgraph nesting, maximum declared instance count, and maximum expression source length. A hostile document is rejected before it ever reaches an evaluator, on the server and in the client's boundary validation alike. Note the existing check passes a file whose `schemaVersion` is missing or non-numeric (it short-circuits on the type assertion), so graph validation must not assume a version is present.

Per-workspace data isolation is unchanged: graphs live inside the design file, which is already isolated at the query layer; graph presets stored per workspace follow the same rule as templates and assets.

## 8. API and realtime

No new document-storage API is needed: a graph is part of the design file, so it saves, versions, branches, restores, and exports through the existing endpoints. What is new is evaluation as a server capability and presets as a workspace resource. Errors are RFC 7807 problem+json; handlers emit structured JSON logs with design id, workspace id, user id, and request id.

```
POST   /api/v1/designs/{id}/graph/evaluate        headless evaluation of one node's graph -> job (202 + job id)
GET    /api/v1/designs/{id}/graph/diagnostics     per-op status, timings, bounds usage for the last server evaluation
GET    /api/v1/workspaces/{id}/graph-presets      list workspace graph presets
POST   /api/v1/workspaces/{id}/graph-presets      create/update a preset (copy-by-value on instantiation)
GET    /api/v1/graph/catalog                      op catalog: ids, versions, sockets, params, server support flags
POST   /api/v1/designs/{id}/ai/graph              AI graph generation or edit proposal -> job
GET    /api/v1/jobs/{id}                          poll long-running ops (existing job registry)
```

Evaluation and AI graph generation go through the in-process job registry (`backend/internal/jobs`, `Registry.Start/Complete/Fail/Get`) and are polled at `GET /api/v1/jobs/{id}`, consistent with export and every other long operation. One honest caveat that this feature makes urgent: the registry is bookkeeping over work that mostly runs INLINE in the request (its own package doc says so), with the timeline video export as the sole detached `go func()`, and it is process-local, non-durable, unsupervised, and uncapped for concurrency. A procedural evaluation whose cost scales with authored data is exactly the workload that breaks that arrangement, so bounded, cancellable, concurrency-capped server evaluation (a `context.Context` threaded through the render entry points, which today have none) is a prerequisite of Phase 4 rather than a later hardening pass. `GET /api/v1/graph/catalog` matters more than it looks: it is how a client discovers which ops the server can actually evaluate, so the export dialog can warn about bake fallbacks (FR-29) before the user waits for a render.

Realtime over `/realtime` needs no new frame types. A graph is document data, so graph edits are ordinary CRDT updates on the design's `Y.Doc` and converge through the existing sync path. Three consequences are worth stating because they are where this will actually break:
- Granularity. `reconcile.ts` reconciles keyed arrays by id and plain arrays by delete-and-reinsert. `ops` and `edges` are keyed arrays (every op has an id), so two users editing different ops merge granularly. Parameter maps reconcile per key, so two users editing different parameters of the same op merge too. Same-parameter conflicts resolve last-writer-wins, matching every other scalar field in the document.
- Bake traffic. The bake is document data and therefore syncs, so a scrubbed parameter that re-bakes on every frame would flood the CRDT. The bake is written once on command commit, never during a drag, exactly as the ink-stroke commit pattern in F30 avoids per-point writes. Intermediate evaluation stays local.
- Server-side awareness. The relay is a blind relay for sync, but `backend/internal/crdt` can fold the log, so the server-authoritative snapshot already materializes graph data without special handling. No per-op server enforcement is proposed here; graph integrity is not a security boundary (section 11 covers what is).

SDK (`@hc/sdk`) gains typed methods for the catalog, evaluation jobs, diagnostics, and presets. New pure packages and package changes: `@hc/procgraph` (new: the evaluator, op catalog, cache, expression layer, determinism harness, no React and no DOM), `@hc/engine` (consumes `@hc/procgraph` at scene build time and paints its outputs; no new UI dependency), `@hc/geometry` and `@hc/text` (provide op kernels), `@hc/editor` (graph edits as commands in the existing registry so undo, redo, and CRDT fan-out come for free).

## 9. AI hooks

All graph AI builds on the shipped F39 AI Creative Studio (`@hc/aistudio`): the BYO-key, multi-model, self-hostable provider-adapter layer whose defining rule is that output is an editable native artifact. A graph is the most editable artifact the format can produce, so this is a natural fit rather than a bolt-on.

- Graph from prompt. A prompt ("a halftone dot pattern that follows the image's luminance", "twelve petals around a centre with a slight random rotation") is structured by the model into a validated graph spec, in the same shape as the existing `AiDesignSpec` pipeline in `packages/aistudio/src/spec.ts`. The spec is validated against the op catalog before anything is applied: unknown op ids are rejected outright rather than written as `GraphOp.raw`, because passing model hallucinations into the forward-compat slot would poison the very mechanism that protects real forward compatibility. Application is one undoable command.
- Explain and annotate. Given a graph, the model produces a plain-language description of what each op does and what the exposed parameters control, which becomes the graph's accessible description (section 12) and the preset's documentation. This is a read-only assist with no mutation path.
- Parameter suggestion and variation. The model proposes parameter sets ("looser", "denser", "more organic") which are applied as parameter-only edits, so the structure the user built is never rewritten by a suggestion.
- Make this editable. A flattened import (an SVG with baked filter effects, a rasterized layer) is lifted into an equivalent parametric graph where the mapping is unambiguous, and left alone where it is not. This is the strongest use of the feature: it turns a dead import into live artwork, and it is only possible because the target is an open, inspectable graph.
- Preset organization. The model names, categorizes, and describes user-saved presets, using the existing assistant tool-catalog pattern (`packages/aistudio/src/assistant.ts` `ToolDef`/`toolCatalog`) rather than a new mechanism.

Guardrails that are requirements, not aspirations: model-proposed graphs are validated against the catalog, pre-checked against the FR-10 resource bounds before evaluation (a model can trivially propose a scatter of ten million instances), applied as one undoable command, and always visible and editable afterwards. Inference routes through the workspace's own key or endpoint, so on a self-hosted instance no design data leaves the instance.

## 10. Performance and scale

Procedural means recompute, so performance is part of the design rather than a follow-up.

- Incremental evaluation is the primary mechanism. A parameter change dirties only its transitive dependents; everything else is served from cache. The committed target is that scrubbing a parameter in a 500-op graph re-runs only the dirty subgraph and holds interactive frame rate.
- The cache is content-addressed and bounded. Keys are hashes of op id, op version, canonicalized resolved parameters, input result hashes, and the evaluation environment, so identical subgraphs share entries within and across documents. The cache carries an explicit byte budget with LRU eviction, and eviction can only cost time, never correctness. Raster results are the dominant consumer and are the first eviction candidates.
- Two quality tiers. Preview evaluation reduces raster resolution, caps instance counts above a threshold, and lowers iteration counts; final evaluation is exact and is the only mode export uses. Quality is part of the cache key so the two never cross.
- Off-main-thread evaluation. The evaluator is DOM-free by construction, so it runs in a worker; the transport cost of raster buffers (transferables, not copies) is the real constraint and is designed for from the start rather than retrofitted.
- Viewport and tile scoping. `SpatialIndex` and `tilesForRegion` already exist for rendering; the evaluator consumes them so an instancer branch entirely outside the viewport is neither drawn nor evaluated, and a raster op evaluates only the tiles the viewport needs.
- The GPU path (F44) is where raster kernels and large instancer transforms eventually run. The CPU path stays the reference implementation and the correctness baseline; the GPU path must match it within the FR-13 tolerance, verified by the same golden fixtures. Canvas2D and CPU evaluation remain the graceful fallback, consistent with the existing `gpuAvailable()`/`probeContext()` degradation.
- Budgets to prove: a 500-op graph scrubs at interactive frame rate; a 5,000-instance radial repeat pans and zooms at the frame-rate target already committed for the canvas; a cold full-document evaluation of a realistic procedural poster completes within an export-acceptable wall clock; a preview-to-final quality switch never changes structure, only fidelity; and evaluation memory stays inside the declared cache budget under a soak.

## 11. Security and threat model

Graphs move a document from "data a renderer reads" toward "a program a runtime executes", which is a real change in posture even before user-authored nodes exist. Cross-cutting SSO, audit, and compliance infrastructure is F38; this section covers the graph-specific posture.

- Untrusted graph evaluation is the default assumption. Any document can arrive from an untrusted source (a share link, an import, an API upload, a peer over the CRDT), and evaluating it must not be able to hang, exhaust, or crash the client or the export worker. Enforcement is layered: structural bounds at the write boundary (`persistence/validate.go`, in the style of the existing `maxNodeDepth`/`maxNodeCount` checks) reject a pathological graph with 422 before evaluation; runtime bounds (FR-10) on op count, instance count, output pixels, nesting depth, and wall clock abort an over-budget evaluation with a diagnostic and a bake fallback; and the evaluator is re-entrant and cancellable so an abort leaves no partial state.
- The server has almost none of that today, and this feature is what forces it. `ToPNG`, `ToSVG`, and `ToPDF` take no `context.Context` and have no timeout; there is no `GOMEMLIMIT`, rlimit, or cgroup enforcement in Go; `maxRenderSide = 16384` is applied to inline files only, so a stored design with an absurd page size reaches `image.NewRGBA` unchecked; there is no concurrency cap on render or export and no rate limiting; and the one detached export goroutine has no `recover`. The working model for what a bounded embedded evaluation looks like already exists in `backend/internal/crdt`: a frame-count cap, a byte cap, a hard 30-second timeout, and a watchdog that interrupts the VM. Graph evaluation adopts that shape, and threading a context through the render entry points is part of this work rather than a separate cleanup.
- Amplification is the specific risk to design against. A small file can describe an enormous computation: nested instancers multiply, a scatter can request millions of instances, a noise generator can be asked for a gigapixel output. Bounds are therefore checked on the DECLARED product of nested instancers before evaluation begins, not merely observed while it runs, and nested instancer depth is capped independently of total op count.
- Determinism is a security property, not only a correctness one. An op that could read the clock, the locale, the environment, or the network would let a document behave differently on a server than in the author's browser, which is exactly the shape of an export-time surprise. FR-14 removes those capabilities from the op interface rather than forbidding them by policy.
- Expressions are parsed, never evaluated as code. The existing `packages/editor/src/expression.ts` is explicitly a recursive-descent parser and explicitly not `eval`; the graph expression layer extends that property. No `eval`, no `new Function`, no dynamic import, no prototype access, bounded depth, bounded source length, bounded evaluation steps.
- Custom nodes (deferred, Phase 5) are the largest new surface and are specified here so the earlier phases do not preclude a safe design. In the browser, a custom node runs in a dedicated worker with no network access, no DOM, no `SharedArrayBuffer` handed to it, a frozen realm, a deterministic-only API surface (no `Date`, no `Math.random`, no `Intl`), and CPU and allocation budgets enforced by termination. On the server, the first cut does NOT execute custom nodes at all: an export of a document containing custom nodes falls back to the bake and says so (FR-29). Running arbitrary user code inside the single Go binary that also holds the database connection and every workspace's data is a materially different risk from running it in a browser tab, and it needs process isolation or WASM with an explicit resource policy before it is worth doing. That decision is deliberately deferred rather than assumed.
- Presets are content, and shared presets are untrusted content. A workspace preset is validated on read like any other document fragment, its op ids checked against the catalog, and its bounds enforced. A preset cannot escalate: it has no capability the document it lands in does not already have.
- AI-proposed graphs are untrusted input from the model, validated against the catalog and the bounds before application (section 9), with the specific rule that unknown op ids are rejected rather than preserved as `raw`.
- Observability: evaluation emits structured JSON logs with design id, workspace id, node id, op count, evaluation duration, cache hit rate, and bound-abort reason. Success metrics are cache hit rate under normal editing, p95 parameter-scrub latency, evaluation-abort rate, browser-versus-server divergence count (target zero), and bake-fallback rate at export.

## 12. Accessibility and i18n

A node-link diagram is the least accessible interface pattern in the product, and shipping one without an equivalent is not acceptable under F38 or under the accessibility positioning.

- The linear stack view is a first-class editing surface, not a read-only shadow of the graph. Every graph is presentable as an ordered, nestable list of operations with their parameters, and every graph edit (add, remove, reorder, connect, disconnect, group into a subgraph, expose a parameter) is performable from it. Because the effect stack (FR-17) is exactly this list, the accessible view is the same view most users see anyway, which is the reason it will stay maintained.
- Full keyboard operation of the node-link view where it is shown: move focus between ops, traverse along an edge in either direction, jump to an op's inputs or outputs, create and delete ops, start and complete a connection, and reach every parameter. No pointer-only gesture.
- Screen-reader semantics: each op announces its name, its type, its enabled state, its input and output sockets with what is connected to them, its diagnostic state, and its position in the evaluation order. Connections announce both endpoints. A graph announces its op count and its output. Diagnostics are live-region announcements, not colour changes on a canvas.
- No colour-only encoding. Socket types, connection validity, disabled state, and error state each carry a shape, label, or text cue in addition to colour, and the graph respects the high-contrast theme tracked in F38.
- Reduced motion: graph layout changes, edge animations, and evaluation progress indicators honour the app-wide reduced-motion preference already shipped.
- i18n: op ids are stable ASCII identifiers and are never localized (they are the dispatch key and part of the cache key); display names, categories, parameter labels, units, and diagnostics are localized. Parameter number formatting follows the user's locale for display while canonical serialization for hashing stays locale-independent (FR-14). Graph panel layout and the linear stack view work under RTL. User-authored op labels and preset names are arbitrary user text and must handle CJK, RTL, and combining marks in measurement and truncation.
- The graph and its exposed parameters carry an accessible description (authored, or generated per section 9) so a screen-reader user understands what a collapsed subgraph does without expanding it.

## 13. Import / export and interop

- Export always works, because a bake always exists (FR-24). PNG, JPG, PDF, PPTX, and video export flatten the evaluated result exactly as they flatten anything else; the difference is that a graph-aware exporter re-evaluates at the target size and colour space instead of resampling (FR-21).
- SVG export of a procedural node emits the evaluated geometry. Where an effect stack maps onto SVG filter primitives the mapping is used; where it does not, the region is rasterized at the export resolution and the lossy step is recorded in the export result rather than silently applied. The reverse direction (SVG filters and clip paths lifted into an effect graph on import) is the highest-value interop win and is owned jointly with F45.
- Round-trip through the open format is exact: a graph written by HyCanvas and re-read by HyCanvas is byte-equivalent after canonicalization, and a graph written by a newer client and re-saved by an older one preserves every op through `GraphOp.raw` and the untouched `graph` field (FR-4, FR-25).
- Layered-format import (multi-layer raster formats, layered vector formats) maps adjustment layers, layer effects, and clipping masks onto effect-stack ops where the semantics match, and onto a baked layer where they do not, with the mismatch documented rather than approximated silently.
- The graph payload is documented as part of the open file format specification, including the op catalog with each op's id, version, sockets, parameters, and determinism notes, so a third-party tool can read a HyCanvas graph without reverse engineering it. This is the interop position no closed procedural tool can match.
- Export-time honesty is a requirement: if any node fell back to its bake because the server could not evaluate an op (FR-29), the export result says so, names the nodes, and the export dialog surfaces it before the user ships the file.

## 14. Phasing / milestones

Dependency-ordered; each phase is independently shippable and each leaves the product in a state where nothing regresses.

Phase 1: the evaluation core and the effect stack (the pragmatic entry point).
- Groundwork first, each landing and verified on its own before the evaluator depends on it: re-home the geometry kernels so `@hc/engine` can call `booleanOp` and stroke-to-outline instead of the frontend store baking `node.result`; implement mask rendering in the engine and in the Go backends (and make `isContainer`, `walkNodes`, `collectIds`, and `maxDepth` see the masked child); and composite groups as offscreen layers so group opacity and blend isolate correctly. Define the one canonical geometry value type graph ops pass between them.
- `@hc/procgraph`: op catalog, typed sockets, dependency graph, dirty-set recompute, topological evaluation, cycle detection with per-op diagnostics, content-addressed cache with a byte budget, resource bounds, and the determinism harness. Generalized from the algorithm shape proven in `packages/formula/src/graph.ts`, not written from scratch.
- The effect stack: `Effect[]` and `TextEffect[]` lower into an ordered op chain; the properties panel becomes a drag-reorderable stack with per-op enable, collapse, and inline parameters; effects can be interleaved with masks and fills.
- The bake model, the divergence hash, and the older-client degradation path, proven against a database seeded with pre-change documents.
- Schema v18 (`NodeBase.graph`) with the Go mirror bump and the forward migration, or the `NodeBase.data` prototype route first if the shape is still moving.
- `boolean` becomes recomputable in the engine rather than a cached-result-only node, which retires the placeholder-box fallback at `render2d.ts:1100`.

Phase 2: the dual view.
- Tree-to-graph lowering and graph-to-tree lifting with write-back from either view; the layer panel becomes a real nested tree and shows effect-stack and graph rows.
- The graph panel: node-link editing, selection sync with the canvas and the layer panel, diagnostics, and per-op cost display.
- Subgraphs, exposed parameters, and the linear stack view as the accessible equivalent (section 12), keyboard operation, and screen-reader semantics.
- Parameter types, units, ranges, and the expression layer extended from `packages/editor/src/expression.ts`, participating in the same dependency graph and cycle detection.
- Graph edits as `@hc/editor` commands, so undo and CRDT fan-out work with no bespoke plumbing; CRDT convergence tests for concurrent op and parameter edits.

Phase 3: generators and instancers.
- Linear, grid, and radial repeats; repeat along a path; scatter with density; instancer culling and lazy evaluation through `SpatialIndex` and tiling.
- Seeded PRNG with stable per-instance sequences; value, gradient, and fractal noise; procedural patterns as live graph outputs.
- Preview versus final quality tiers, worker-offloaded evaluation, and the performance budgets in section 10 measured rather than asserted.
- Node library organization, shipped presets, and workspace-saved presets (schema v19 for `graphPresets`).

Phase 4: parity, export, and AI.
- Deterministic parity on the Go headless export path: the evaluator available server-side (the `backend/internal/crdt` embedded-bundle technique is the leading candidate for having one implementation instead of two), the golden-fixture conformance suite in CI, and the catalog endpoint reporting server support so the export dialog can warn about bake fallbacks.
- Resolution-independent re-evaluation at export size, ppi, and colour space; SVG filter mapping in both directions with F45.
- AI graph generation, explain, parameter variation, and make-this-editable on `@hc/aistudio`, with catalog validation and bounds pre-checks.

Phase 5 (later, not committed): custom nodes and simulation.
- User-authored op definitions in a sandboxed worker with a deterministic-only API surface and enforced budgets; server-side execution deliberately withheld in the first cut (section 11).
- Simulation domains, which need a stateful, frame-ordered evaluation model the pull-based evaluator does not have and should not be bent into.
- Graph-first documents (a page that is only a graph, with the tree as a projection) as the endpoint of the lowering/lifting work, revisited only once the scoped model has proven itself in production.

## 15. Acceptance criteria

These sample representative, testable criteria; a requirement not pinned to a numbered AC here is verified by the section 16 test plan.

- AC-1: A blur added an hour and fifty edits ago can be changed to a different radius by editing one parameter, with no undo and no re-doing of the intervening work, and the result matches what building it in that order from scratch would produce (FR-1, FR-7).
- AC-2: Reordering a blur, a mask, and a colour adjustment in the stack changes the rendered result correspondingly, and each ordering is stable across save, reload, and export (FR-17).
- AC-3: Every capability listed in FR-3 is completed end to end using only direct manipulation and the properties panel, with the graph panel disabled for the whole run, and the resulting document contains the same graph operations that graph-panel authoring would have produced (FR-3, FR-2).
- AC-4: Selecting a layer row highlights its op in the graph panel and vice versa; reordering rows in the layer panel reorders the corresponding ops; neither view requires a sync or refresh action (FR-2).
- AC-5: Changing one leaf parameter of a 500-op graph re-evaluates only its transitive dependents, verified by an evaluation trace, and holds interactive frame rate while scrubbing (FR-7, section 10).
- AC-6: Two structurally identical subgraphs in different documents produce the same cache key and the second is served from cache; changing the evaluation quality or output resolution class produces a different key and is never served the other's result (FR-8, FR-11).
- AC-7: A graph containing a cycle reports the cycle on the offending ops, renders the affected node from its last good bake with a distinct outline, leaves the rest of the document evaluating normally, and saves without error (FR-9).
- AC-8: A graph declaring nested instancers whose product exceeds the instance bound is rejected at the write boundary with a 422 problem+json, and a graph that exceeds a runtime bound during evaluation aborts with a diagnostic and a bake fallback rather than exhausting memory (FR-10, section 11).
- AC-9: The same document evaluated in the browser, in a worker, and by the Go export path produces bit-identical geometry and structure and raster output within the declared per-op tolerance; the conformance suite fails CI on any divergence beyond it (FR-13, FR-16).
- AC-10: A scatter with a fixed seed produces the same instance placement in all three runtimes, and adding an unrelated op elsewhere in the graph does not change any existing instance (FR-15).
- AC-11: A radial repeat of twelve appears as one layer row with a count parameter; scrubbing the count to nine updates the canvas live, and the repeat survives save, reload, and export as a live parameter rather than nine copies (FR-19).
- AC-12: A poster built at A4 exports at 8x and at 300 ppi with geometry and generator detail re-evaluated at the target, showing no resampling artefacts, except downstream of an inherently raster input which is documented as resampled (FR-20, FR-21).
- AC-13: A document containing graphs opens on a build that predates graphs, renders the correct artwork (not a placeholder), can be edited elsewhere in the document, and after save and reload on the current build the graph is intact and unchanged (FR-24, FR-25).
- AC-14: If that older build edits the baked output of a graph node, the current build detects the divergence by hash on open, prompts, and applies only the choice the user makes; neither branch loses data without an explicit confirmation (FR-26).
- AC-15: Two users editing different ops of the same graph converge with both edits present; two users editing different parameters of the same op converge with both present; two users editing the same parameter converge to one value; a parameter scrub produces no CRDT traffic until the command commits (FR-27, section 8).
- AC-16: A schema bump for this feature raises `CURRENT_SCHEMA_VERSION` and the Go `currentSchemaVersion` in the same change, registers a migration step, appends a version-history line, and a corpus of pre-change documents opens, edits, saves, exports, and restores from version history unchanged (FR-28).
- AC-17: An expression parameter referencing another parameter recomputes when its reference changes, participates in cycle detection, and is rejected with a diagnostic (not executed) if it exceeds the depth, length, or step bound; no code path reaches `eval` or `Function` (FR-23, section 11).
- AC-18: A subgraph collapses to one layer row with its exposed parameters as ordinary controls, is saved as a preset, is instantiated in another document by value, and editing the original preset afterwards does not alter the instantiated copy (FR-5).
- AC-19: The entire graph, including creating an op, connecting it, reordering the stack, grouping a subgraph, and exposing a parameter, is operable by keyboard alone in the linear stack view and in the node-link view; a screen reader announces every op, socket, connection, and diagnostic (section 12).
- AC-20: An AI-proposed graph containing an unrecognized op id is rejected with a clear message rather than applied or preserved as `raw`; an AI proposal exceeding the resource bounds is refused before evaluation; an accepted proposal is one undo step and every op it created is visible and editable (FR-30).
- AC-21: An export in which any node fell back to its bake because the server could not evaluate an op names those nodes in the export result and surfaces the warning in the export dialog before download (FR-29).
- AC-22: A graph written by HyCanvas, opened by a newer client that adds an unrecognized op, and re-saved by the current client preserves that op verbatim and re-evaluates correctly when reopened on the newer client (FR-4).

## 16. Test plan

- Unit (pure cores): `@hc/procgraph` dependency-graph construction, dirty-set derivation, topological order, cycle detection and downstream poisoning (ported directly from the `packages/formula/src/graph.ts` test shape), cache key derivation and stability, LRU eviction correctness, bound enforcement, expression parsing and rejection cases, PRNG sequence stability across seeds and insertion order, and the tree-to-graph lowering plus graph-to-tree lifting round-trip on a corpus of real documents.
- Schema and migration: each new version step is pure and idempotent; golden fixtures for v17 to v18 and onward; a v17 corpus opens, renders, saves, and exports byte-identically after a no-op migration; `GraphOp.raw` preservation through save and reload; `NodeBase.data` prototype promotion.
- Zero-data-loss verification against a seeded database: pre-change documents (designs, decks, boards, docs, sheets, video projects) open, edit, save, export, and restore from version history on the new build; a graph-bearing document round-trips through the previous binary with the graph intact; a rollback to the previous binary leaves every document openable. This is the gate, not a nice-to-have, and a pure-code change with no schema or SQL impact says so explicitly.
- Determinism conformance: a growing golden-fixture corpus evaluated in Node, in a browser worker, and by the Go path, asserting bit-identical structural output and per-op raster tolerance, run in CI on every op addition. New ops without fixtures fail the build.
- Backend (Go): evaluation jobs through the job registry, RFC 7807 on every error path, structured-log assertions, catalog endpoint accuracy against the actual server op coverage, 422 on graphs exceeding the structural bounds, preset isolation per workspace at the query layer, and bake-fallback reporting in export results.
- Integration and CRDT: concurrent op edits, concurrent parameter edits, concurrent same-parameter edits, an op deleted on one peer while edited on another, offline edits reconverging, and no CRDT traffic during a parameter scrub before commit.
- Frontend and E2E (compose stack, real browsers): the AC-3 no-graph-panel run end to end; effect stack reordering; instancer scrubbing; subgraph creation and preset instantiation; the divergence prompt path with a genuinely older client; export with a bake fallback and its warning.
- Performance: the section 10 budgets measured, not asserted, extending the existing `npm run bench:paint` harness and `packages/engine/src/bench.ts`; a 500-op scrub, a 5,000-instance repeat, a cold full-document evaluation, cache hit rate under a realistic editing session, and a memory soak against the cache budget.
- Security: adversarial graph corpus (deep nesting, nested instancer amplification, gigapixel generator requests, expression bombs, self-referential presets, malformed `raw` payloads) asserting rejection at the write boundary or a bounded abort, never a hang, an OOM, or a crashed export worker.
- Accessibility: keyboard-only completion of every graph task, screen-reader transcript review of the node-link and linear views, high-contrast and reduced-motion verification, RTL layout, and an audit against WCAG 2.2 AA for both views.
- Manual: a designer runbook building a real procedural poster end to end; a self-host smoke test with a BYO key proving no design data egress during AI graph generation.

## 17. Differentiators

- Non-destructive by default without a mode switch. Direct manipulation writes graph operations silently, so a casual user gets resolution-independent, re-editable artwork without learning anything, and an expert gets the graph. Professional procedural tools generally make you choose between an approachable layer model and a powerful graph model; making them two views of one structure is the thing worth building.
- The graph is in the open file format. It is documented, inspectable, forward-migrating, losslessly round-tripped, exportable, and readable by third-party tools, with the op catalog published alongside it. No closed procedural tool can offer that, and it is the same structural advantage the rest of the roadmap runs on.
- Deterministic across browser, worker, and headless server, with a golden-fixture conformance suite enforcing it in CI. Procedural tooling that renders differently on the render farm than in the artist's viewport is a familiar and expensive failure mode; treating determinism as a tested contract with the capability removed from the op interface, rather than a convention, is a category-level position.
- Free and self-hostable in full. Every generator, instancer, effect op, preset, and the graph panel itself ship ungated, with no tiers, no watermarks, and no per-seat procedural upcharge, on an instance the user runs.
- Zero-data-loss procedural adoption. A graph-bearing document renders correctly on a binary that has never heard of graphs, because the bake is real artwork rather than a placeholder and the graph rides on a node type every client already understands. Adopting a procedural model without stranding existing documents or forcing a synchronized upgrade is unusual and is what makes this shippable to self-hosters at all.
- Accessible procedural editing. A keyboard-operable, screen-reader-comprehensible node graph with a first-class linear equivalent that is the same surface most users already use, on an axis where every comparable tool is weak.
- AI that produces graphs, not pixels. A model proposal lands as visible, inspectable, editable operations validated against a published catalog, on the workspace's own key, so AI output is a starting point that stays editable rather than a flattened result.

## 18. Open questions and risks

- Prerequisites that are larger than they look. Three pieces of groundwork sit between today's code and Phase 1, and none of them is optional: `@hc/geometry` must become reachable from the engine so geometry ops can be evaluated rather than baked in the frontend store; masks must actually render (they are unimplemented in the engine and in all three Go backends, and the masked child is currently invisible to render, hit-test, bounds, and the spatial index), because a compositing graph without masking is not a compositing graph; and groups must composite as offscreen layers rather than multiplying opacity down per child, or every graph result involving a semi-transparent group will show overlap seams. Each is a self-contained fix with its own regression risk on existing documents, and each should land and be verified before the evaluator depends on it. Whether they belong inside Phase 1 or in a Phase 0 is an open scheduling question; the honest read is that Phase 1 is bigger than its description.
- Which backend is normative. FR-13 requires the browser, the worker, and the Go path to agree, but the three Go backends do not agree with each other today: `boolean`, `table`, and `chart` are raster-only, `mask` is nowhere, and raster covers materially more node types than SVG or PDF. "Identical output" needs a named reference implementation (raster is the obvious candidate) and an explicit, documented statement of what SVG and PDF are permitted to do differently, or the conformance suite will encode whichever inconsistency happened to exist when it was written.
- One evaluator or two. The strongest correctness story is a single implementation running in the browser and, via the embedded-JS-bundle technique already proven by `backend/internal/crdt`, inside the Go binary. The strongest performance story is native Go kernels for the heavy geometry and raster ops. Proposed resolution: start with the shared bundle for the scheduling, parameter, expression, and structural layers so there is exactly one source of truth for evaluation semantics, and allow native Go kernels only for ops that have golden-fixture conformance proving bit-identical or in-tolerance output. Risk: the goja-equivalent path is slow for pixel work and the conformance suite becomes the critical path for every new op. Needs a spike measuring a realistic graph on the export path before Phase 4 commits.
- Scoped graph versus graph-first documents. This spec deliberately scopes graphs to a node or group rather than replacing the document model, and that choice is load-bearing rather than conservative. Replacing the scene tree would require rewriting `render2d.ts`, `scene.ts`, `hit.ts`, `spatial.ts`, the entire Go export walker, the CRDT reconciler's keyed-array assumptions, the animation poser, every importer and exporter, and every panel, and it would break every existing document and every older client at once, which the zero-data-loss rule forbids outright. The scoped model gets the capability with an additive optional field, a bake that older clients render correctly, and no change to any existing traversal. Open question: whether graph-first pages are ever worth the migration once the lowering and lifting contract is proven, or whether the scoped model plus a page-level root graph is simply the better end state. Not decided, and nothing in this spec depends on deciding it.
- Where exactly the graph field lives. `NodeBase.graph` is the proposal, but putting it on every node when in practice groups own graphs may be needlessly permissive and may make the bake rule harder to state for leaf nodes. The alternative is to restrict it to `GroupNode` and require a wrapping group, which is stricter and simpler but adds a group to the user's tree for every procedural leaf. Leaning toward `NodeBase` with a documented rule about what the bake is for each node kind; worth revisiting after Phase 1.
- Bake cost. Maintaining a bake means every graph-bearing node stores its evaluated output in the document, which grows the file and the CRDT payload, potentially a lot for an instancer that produces thousands of nodes. Mitigations to evaluate: bake at a bounded fidelity (store the instancer's parameters plus a representative rasterized bake rather than every instance), bake only what an older client needs to render rather than the full structure, and skip the structural bake entirely above a size threshold in favour of a single rasterized fallback. This is the most likely place for the design to need a second pass, and it interacts directly with the FR-25 degradation guarantee.
- Instance overrides under a changing count. Per-instance edits are what make instancers usable for real work, and they are notoriously fragile: changing the count, the seed, or the source invalidates the identity that an override was keyed to. Options are index keying (simple, breaks on reorder), stable generated ids (robust, grows with instance count), and content keying (elegant, ambiguous with duplicates). Deferred to P2 deliberately so the answer is informed by real instancer usage rather than guessed.
- Undo granularity during a scrub. A parameter drag is one command on commit, which is right for undo and right for CRDT traffic, but it means a long exploratory drag is a single undo entry and intermediate states are unrecoverable. The existing `commitEffects`/`setEffects` pair in `frontend/src/store/editor.ts` already handles this shape for effects and is the model to follow, but it is worth checking whether procedural scrubs want a coarser or finer granularity than effects do.
- Effect and text-effect unification. `NodeBase.effects` and `TextNode.textEffects` are two arrays kept separate specifically to avoid a name clash, and they have different semantics. The graph must evaluate them coherently without merging their storage, which the zero-data-loss rule forbids. The plan is to lower both into one op chain with a declared ordering rule; the risk is that the declared ordering does not match what today's renderer actually does for some combination, which would change existing documents' appearance. Every combination needs a rendered-output regression test before v18 ships.
- Colour space of evaluation. Ops must be colour-space aware and evaluation must happen in a declared working space, or a blur in sRGB and the same blur in linear light produce visibly different results. This is F45's domain but it blocks correctness here: an op catalog that does not declare its working space is unfinishable later. Needs the F45 decision before generator and raster ops land in Phase 3.
- Custom nodes on the server. Executing user-authored code inside the single Go binary that holds the database connection and every workspace's data is a materially larger risk than executing it in a browser tab, and the honest first answer is not to. That means a document using custom nodes exports from its bake, which is a real functional gap the moment custom nodes exist. Process isolation or WASM with an explicit resource policy is the likely path, and it should be settled before custom nodes ship rather than after.
- Discoverability versus the progressive-disclosure rule. FR-3 forbids requiring the graph, but a capability nobody discovers is a capability nobody has, and the graph panel is easy to hide so thoroughly that the feature never gets used. The tension is real and is resolved by making the effect stack (which everyone sees) genuinely be the graph, so the concept is learned incidentally rather than taught.
