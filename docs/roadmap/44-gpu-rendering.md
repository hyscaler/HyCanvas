# F44: GPU-accelerated rendering

| Field | Value |
| --- | --- |
| Feature ID | F44 |
| Phase | 5 Creation depth |
| Sequence | 44 |
| Status | Not started |
| Depends on | `@hc/engine` (the Canvas2D scene-graph renderer this extends, plus its spatial index, dirty-rect tiling math, and benchmark harness), `@hc/schema` (open file format; this spec must not change it), F40 (procedural graph core, the first consumer that cannot run on CPU alone), F41 (vector authoring, which raises path counts and stroke quality demands), F42 (raster and painting, which needs per-stroke GPU compositing), F43 (motion graphics, which needs a real-time effect stack), F38 (accessibility, i18n, security, and non-functional requirements) |

An accelerated render path for `@hc/engine` that keeps one scene graph, one open file format, and one set of pixels: a WebGPU backend with a WebGL2 fallback and the shipped Canvas2D path as the always-available baseline, GPU vector rasterization and effect evaluation, tiling and caching for very large documents and deep zoom, and colour-accurate compositing, all bound by a golden-image parity contract with the Go headless export so a design that looks right in the browser exports byte-comparably right. HyCanvas already renders correctly; this spec makes it render fast enough that procedural graphs, vector authoring, painting, and motion graphics are usable at professional scale, and it does so without ever making the GPU a requirement for opening, editing, or exporting a document.

## Current state

Audited against the code: `packages/engine/src/{renderer,render2d,scene,spatial,tiles,hit,bench,types,viewport,color,effects,duotone,fills,image,transition,animation}.ts`; `packages/engine/src/__tests__/{perf,spatial,engine,effects}.test.ts`; `frontend/src/lib/useEditorCanvas.ts`; `frontend/src/pages/bench/paint.tsx` + `scripts/bench-paint.mjs` (`npm run bench:paint`); `frontend/src/components/{SharedViewer,DeckPlayer}.tsx`, `frontend/src/components/editor/{MiniMap,SlideThumb,PresentMode,AudienceStage,ExportDialog,PrintDialog}.tsx`, `frontend/src/components/dashboard/DesignThumb.tsx`, `frontend/src/lib/video/playback.ts`; `backend/internal/render/{raster,svg,pdf,board,anim,video,gradient,nodes_extra,fonts,pdffont}.go`; `packages/schema/src/schema.ts` (`Color`, `ImageSource.colorSpace`, `BlendMode`, `CURRENT_SCHEMA_VERSION = 17`) and its Go mirror `backend/internal/persistence/file.go` (`currentSchemaVersion = 17`); `packages/color/src/{convert,gamut}.ts`; `packages/print/src/{types,preflight,catalog}.ts`.

The GPU seam already exists and is deliberately inert. `types.ts:64` declares `RenderContextKind = "2d" | "webgl2" | "webgpu"`, `RenderTarget.context` carries it, and `EngineConfig` (`types.ts:188-214`) declares `preferGpu: true`, `tileSize: 256`, `maxTextureSize: 4096`, and `interactionQuality: "adaptive"`. Only `preferGpu` is ever read, and only by `probeContext` in `renderer.ts:35`; `gpuAvailable()` (`renderer.ts:30`) returns `false` unconditionally with the comment that GPU paths are deferred. `tileSize`, `maxTextureSize`, and `interactionQuality` are declared and unconsumed. `mountRenderer` and the `Renderer` lifecycle (viewport, `renderFrame`, `pageToScreen`, dirty-driven asset invalidation, `renderMiniMap`) exist but are exercised only by `packages/engine/src/__tests__/engine.test.ts`: every real surface in the app bypasses the lifecycle and calls `createScene` + `renderScene` directly against a `canvas.getContext("2d")` (`useEditorCanvas.ts`, `MiniMap.tsx`, `SlideThumb.tsx`, `PresentMode.tsx`, `DeckPlayer.tsx`, `SharedViewer.tsx`, `AudienceStage.tsx`, `ExportDialog.tsx`, `PrintDialog.tsx`, `DesignThumb.tsx`, `lib/video/playback.ts`, `pages/bench/paint.tsx`). Wiring the GPU behind `mountRenderer` alone would therefore change nothing; adopting the lifecycle at the call sites is part of the work.

`render2d.ts` is the whole renderer: roughly 2,100 lines and 94KB, one recursive `paint()` (line 1852) dispatching per node type through `drawNodeContent` (line 680), with `renderScene` (line 1969) resetting `globalCompositeOperation`, computing the page-space cull rect from the viewport, and painting page children with optional clipping. Viewport culling and level-of-detail already ship and are cheap and effective: `paint()` (lines 1864-1871) skips any non-container, non-connector leaf whose `worldBounds` fall wholly outside the cull rect, and drops leaves whose `max(width, height) * zoom < 0.5`; `opts.cull === false` disables both for export and thumbnails. Blend modes map through `blendToComposite()` (line 100) onto `globalCompositeOperation`. Effects map through `effects.ts` onto CSS `filter` strings (blur, glow, drop shadow, and the extended adjustment ops approximated from native filters) plus `outlineSpecs`; `duotone.ts` runs a per-pixel luminance-to-gradient LUT into a cached `OffscreenCanvas`. `color.ts` resolves `Color.srgb` to an `rgba()` CSS string and states outright that ICC soft-proofing is a later render-time transform.

Scene-scale machinery is half-built. `spatial.ts` ships a `SpatialIndex` uniform grid hash (default cell 512) with `insert`/`remove`/`queryRect`, built lazily in `scene.ts:412` `queryViewport()` over selectable leaves; it powers presence interest management and off-screen context, not the render cull, which is still a per-node AABB test during traversal. `tiles.ts` ships pure dirty-rect tiling math (`tileSizePage`, `tilesForRegion`, `tileCountForRegion`) that no renderer calls. `Scene.markDirty`/`invalidateRegion`/`dirtyRegion`/`clearDirty` exist and `RendererImpl` clears dirty state after each frame, but `renderScene` unconditionally repaints the entire surface: there is no partial repaint, no tile cache, and no retained GPU or CPU raster cache anywhere in the engine.

Performance is measured, not guessed, and the numbers are good. `bench.ts` provides `benchmarkRender` against `createNullContext()` (a no-op `CanvasLike`, so it isolates CPU traversal and draw-call dispatch from rasterization) and `benchmarkSceneBuild`; its header comment already frames itself as "a yardstick for the future WebGL/WebGPU path". `perf.test.ts` logs roughly 2ms/frame for a 1000-node page and builds a 50-page deck in tens of milliseconds, guarding a 16ms frame budget loosely to stay CI-stable. `frontend/src/pages/bench/paint.tsx`, driven headless by `npm run bench:paint` (puppeteer-core against system Chrome), paints the 50-page x 1000-node deck on a real canvas at devicePixelRatio 2 under continuous pan/zoom with a page flip every 30 frames, and the recorded AC-10 result in `docs/roadmap/16-realtime-collaboration.md` is **p50 120.5fps, p95-slow 111fps, worst frame 9.3ms, scene build 0.51ms/page**. Canvas2D is not the bottleneck for today's documents, and this spec must not pretend otherwise.

Render parity with the server is the real problem, and it is currently unmet. `backend/internal/render/raster.go` rasterizes through `golang.org/x/image/vector` and its own header documents the deltas: shape strokes are not stroked at all (line nodes are drawn as thick quads), unregistered text falls back to an Arial-metric font positioned by translate and scale with rotation not applied to glyphs, and gradients are per-pixel objectBoundingBox approximations. Grepping the whole `backend/internal/render` package finds no blend-mode handling and no node-effect handling: `blendMode`, blur, glow, drop shadow, and duotone are simply not applied on the server. `svg.go` is the highest-fidelity output and `pdf.go` shares its geometry, so the three server outputs do not agree with each other either. There is no golden-image suite and no cross-renderer comparison test anywhere in the repository. Adding a third rasterizer to that situation without first defining and enforcing parity would multiply an existing correctness gap by two.

Prior scope decisions bound this document. F30 section 18 records "WebGL/WebGPU timing: RESOLVED by scope. The GPU path is out of scope (former Phase 5, dropped)" and commits the board to Canvas2D plus the spatial index and LOD; F28 section 10 lists a GPU path as a Phase 5 leap-ahead for cinematic transitions. Neither is re-opened here. F44 exists because the unbuilt creation specs (F40 procedural graphs, F41 vector authoring, F42 painting, F43 motion graphics) have interactive-latency requirements that a single-threaded CPU rasterizer cannot meet, not because existing documents are slow.

Status legend: **Built** (ships today, code-referenced), **Partial** (some of it ships, gaps noted), **Seam only** (a type, config field, or stub exists but nothing consumes it), **Not started**.

## 1. Context and Goal

HyCanvas renders every document type through one Canvas2D scene-graph renderer that runs unchanged in the browser, in a worker, and headless. That uniformity is the reason the animation core, present mode, and animated export agree, and it is worth defending. The measured browser paint proof says Canvas2D comfortably clears 60fps on a 1000-node page at devicePixelRatio 2, so nothing that ships today needs a GPU.

The unbuilt creation capabilities do. A procedural graph (F40) re-evaluates a node network on every parameter drag; each evaluation is a chain of per-pixel image operations over a full-resolution buffer, and doing that on the CPU means either a coarse proxy or a frame-rate collapse the moment a user touches a slider. Vector authoring (F41) pushes path counts from hundreds to tens of thousands and makes stroke quality visible at every zoom level, where the Canvas2D path is bound by the browser's own rasterizer and cannot cache tessellated geometry between frames. Painting (F42) needs sub-frame brush-dab compositing onto a large layer buffer, which is a per-pixel write loop the CPU loses on by an order of magnitude. Motion graphics (F43) needs an effect stack evaluated per frame at playback rate, not per export frame. Each of those is a real-time image-processing workload, and the only way to run image-processing workloads at interactive rates in a browser is on the GPU.

The cost is honest and permanent. A second renderer means two implementations of every draw path, two sets of device-specific bugs, and a class of failure the Canvas2D path never had: drivers that lie about capability, contexts that are lost when a laptop switches GPUs, shader compilers that reject valid code on one vendor, and colour that differs between machines. It also means the parity surface triples, because the browser preview, the worker, and the Go export must all agree. The mitigation is to make parity a tested contract rather than an aspiration, to keep the GPU path a strictly optional accelerator behind an unchanged public engine API, and to hold the minimum viable scope to exactly what the dependent specs need: composited effect and procedural-graph evaluation first, vector rasterization second, everything else only if measurement demands it.

Intended outcome: a user drags a blur radius on a procedural graph over a 4000 x 3000 canvas and the preview tracks the pointer; opens a 50,000-path illustration and pans it at full frame rate; zooms to 6400% and sees clean curves rather than a resampled tile; paints with a large brush and sees no lag between the stylus and the stroke; and, on a locked-down machine with no WebGPU and no WebGL2, opens the same documents, edits them, and exports them with identical pixels, slower but never wrong.

## 2. Scope

In scope:
- A WebGPU render backend for `@hc/engine` behind the existing `RenderContextKind` seam, with a WebGL2 backend covering the same feature surface at reduced precision, and the shipped Canvas2D path as the always-available baseline.
- Runtime capability detection, adapter and feature probing, backend selection policy, mid-session context-loss recovery, and per-feature graceful degradation with a user-visible explanation of what was lost.
- GPU vector rasterization: fills (non-zero and even-odd), strokes with joins and caps and dash patterns, linear/radial/conic gradients, image and pattern fills, and analytic or multi-sample antialiasing at high path counts.
- GPU evaluation of image effects and procedural graph nodes (blur, glow, shadow, adjustment stacks, duotone, blend/composite nodes), with a CPU fallback that produces a result within the parity threshold.
- Tiling, retained tile caches, viewport culling, level-of-detail, and geometry/raster caching for very large documents and deep zoom, consuming the existing `tiles.ts` math and `SpatialIndex`.
- Colour-accurate compositing: a defined working colour space, premultiplied-alpha discipline, blend-mode semantics that match the Canvas2D and Go paths, and a stated position on wide-gamut and HDR output.
- Text rendering on the GPU path: glyph atlas, hinting and subpixel-position policy, and the quality/parity rules that keep GPU text comparable to Canvas2D text.
- The headless server story: a decision, with reasoning, on whether the Go export renderer gains GPU acceleration, plus the parity requirements that bind whichever answer is taken.
- A cross-renderer golden-image parity suite and a perceptual-difference threshold, extending the existing benchmark harness with GPU-aware measurement.

Out of scope (owned elsewhere):
- The procedural graph model, the vector authoring tools, the painting tools, and the motion-graphics timeline (F40 to F43 own their semantics and their node types; this spec owns only how their output is evaluated and drawn).
- The open file format. No node type, property, or version bump belongs to this spec (section 7).
- Realtime, CRDT, presence, and history (F16), and the board-specific scale work F30 deliberately dropped.
- Export encoders and container formats (`@hc/export`, the PDF/SVG/PPTX/video writers); this spec constrains their pixel output, it does not rewrite them.
- Cross-cutting accessibility, i18n, observability, and compliance programmes (F38); this spec states the rendering-specific obligations that hook into them.
- On-device AI inference (section 9).

Deferred:
- WebGPU compute-shader paths for anything other than image effects and procedural evaluation. Compute-based path tessellation and compute-based text rasterization are known techniques and both are deferred until the render path is stable and measured.
- HDR output beyond a tone-mapped SDR presentation of wide-gamut content (section 4, colour). Real HDR authoring needs a schema-level colour model, which this spec explicitly refuses to open.
- A GPU-accelerated Go export renderer (section 4, headless). Deferred with a documented reason, not silently dropped.
- Multi-GPU, GPU selection policy, and colour-managed multi-monitor handling.
- Replacing the Canvas2D path. It is the baseline forever, not a transitional stage.

## 3. User Stories

- As an illustrator, I want a 50,000-path drawing to pan and zoom at the same frame rate as an empty document, so document size stops being something I have to think about.
- As a motion designer, I want an effect stack to play back at the timeline's frame rate in the editor, so I can judge timing without rendering a preview first.
- As someone building a procedural graph, I want the preview to update while I drag a parameter, not after I release it, so the graph is something I explore rather than something I submit.
- As a painter, I want a large soft brush to keep up with my stylus with no visible lag between the tip and the paint.
- As a detail-oriented designer, I want to zoom to 6400% and see a crisp curve rather than a magnified tile, and I want a hairline stroke to stay a hairline at every zoom.
- As anyone who exports, I want the exported PNG, PDF, and video to look like what I saw on screen, and I want to be told, not surprised, when something cannot be reproduced exactly.
- As someone on a five-year-old work laptop with GPU acceleration disabled by policy, I want to open, edit, and export the same documents my colleagues do, and I want the app to tell me plainly that it is running in compatibility mode rather than silently dropping effects.
- As someone whose GPU driver crashed mid-session, I want the canvas to come back without losing my work.
- As a self-hoster, I want the export a server produces to match the editor regardless of whether that server has a GPU at all.

## 4. Feature matrix / scope

Status values: **Built**, **Partial**, **Seam only**, **Not started**. Priority is P0 (minimum viable, blocks F40 to F43), P1 (needed for the full promise), P2 (measurement-gated).

### Render backends and capability detection

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| `RenderContextKind` union and `RenderTarget.context` | Built | `packages/engine/src/types.ts:64-73` | `"2d" \| "webgl2" \| "webgpu"` already typed; nothing constructs a non-2d target. |
| Backend probe and fallback seam | Seam only | `renderer.ts:30-40` (`gpuAvailable`, `probeContext`) | `gpuAvailable()` hardcodes `false`. Replace with a real adapter/feature probe returning a capability record, not a boolean. P0. |
| `EngineConfig` GPU knobs | Seam only | `types.ts:188-214` | `preferGpu` read once; `tileSize`, `maxTextureSize`, `interactionQuality` unconsumed. Give each a consumer or delete it. P0. |
| WebGPU backend | Not started | n/a | Device/queue lifecycle, pipeline cache, bind-group layout, surface configuration, `GPUDevice.lost` handling. P0. |
| WebGL2 backend | Not started | n/a | Same feature surface at reduced precision (no compute, no storage textures, fewer render targets). P1; P0 only if the measured WebGPU availability floor is too low at build time. |
| Backend selection policy | Not started | n/a | Ordered probe (WebGPU -> WebGL2 -> Canvas2D) with an allow/deny list for known-bad adapter strings, a user override in settings, and a `?render=2d` escape hatch. P0. |
| Context-loss recovery | Not started | n/a | Rebuild device, pipelines, atlases, and tile caches on loss; repaint from the scene graph, which is the source of truth and lives in CPU memory. Never lose document state. P0. |
| Renderer lifecycle adopted by app surfaces | Partial | `useEditorCanvas.ts` and 11 other call sites call `renderScene` directly | `mountRenderer` is test-only today. Backends must be selectable behind one lifecycle or the GPU path reaches nothing. P0. |
| Per-surface backend choice | Not started | n/a | Editor canvas, minimap, thumbnails, present mode, and the video preview have different budgets; thumbnails and minimaps should stay on Canvas2D rather than contend for the device. P1. |

### Vector rasterization

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Canvas2D fills/strokes/gradients/patterns | Built | `render2d.ts` `drawShape` (182), `paintPattern` (152), `fills.ts`, `drawInk` (609) | The correctness reference. Every GPU output is compared against it. |
| Path tessellation and cache | Not started | n/a | CPU tessellation to triangle buffers keyed by node id plus a flatness tolerance bucket, invalidated on geometry change, reused across frames and zoom steps within a bucket. P0. |
| GPU fill (non-zero and even-odd) | Not started | n/a | Stencil-then-cover or an analytic coverage approach; even-odd is required by `PathNode`/`ShapeNode` and by clip paths. P0. |
| GPU stroke (joins, caps, dashes, alignment) | Not started | n/a | Stroke expansion to geometry, honoring the schema's `align` (`inside`/`center`/`outside`), `cap`, `join`, and miter limit. P0, and the highest-risk parity surface. |
| Gradients (linear, radial, conic) and mesh | Not started | n/a | Evaluated in the fragment shader in the working colour space, not by baking a ramp texture in sRGB, or gradients will band and hue-shift relative to Canvas2D. P0 for the three analytic kinds; mesh gradients P2. |
| Antialiasing quality | Not started | n/a | Analytic coverage where the geometry allows, MSAA elsewhere; a documented quality floor at every zoom level. Hairlines must not disappear at low zoom or fatten at high zoom. P0. |
| Large path counts | Not started | n/a | Batch by pipeline and paint state, instance repeated geometry, and sort to minimize state changes. The target is 50,000 visible paths (section 10). P0. |
| Clipping and masks | Partial | `render2d.ts` clip paths; `pathclip.ts` | Canvas2D uses `clip()`; the GPU path needs stencil or scissor for rect clips and a mask texture for shape/freeform clips. P1. |

### Effects, procedural evaluation, and image operations

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Effect to CSS-filter mapping | Built | `effects.ts` (`effectsFilter`, `adjustmentOpToFilters`, `outlineSpecs`) | Blur, glow, and drop shadow map to `filter`; several adjustment ops are documented approximations combined from native filters. |
| Duotone | Built | `duotone.ts` (`duotoneCanvas`, cached `OffscreenCanvas` LUT) | Already an offscreen per-pixel pass; the natural first effect to port, and a clean parity test case. |
| GPU effect graph executor | Not started | n/a | A small DAG of render passes over ping-pong textures with a texture pool, evaluated at the node's resolved resolution. This is the piece F40 to F43 actually need. P0. |
| Separable and downsampled blur | Not started | n/a | Two-pass Gaussian with mip-based downsampling for large radii; must match the CSS `blur()` sigma convention within the parity threshold or every existing document changes appearance. P0. |
| Adjustment stack on GPU | Not started | n/a | The extended ops in `adjustmentOpToFilters` are approximations; the GPU path must reproduce the same approximations, not a more correct formula, or existing documents shift. Correctness improvements are a separate, versioned decision. P0. |
| Blend modes as shader ops | Partial | `blendToComposite()` (`render2d.ts:100`) | Canvas2D delegates to `globalCompositeOperation`; the GPU path implements each mode explicitly, which is where premultiplication mistakes surface. P0. |
| CPU fallback for every effect node | Partial | `effects.ts` + `duotone.ts` today | Every GPU effect needs a CPU implementation within the parity threshold, so a no-GPU machine gets the same picture, slower. Non-negotiable. P0. |
| Effect result caching | Not started | n/a | Cache by (node id, input hash, resolution, parameter hash); a parameter drag re-runs only the dirty subgraph. P1. |

### Scene scale: tiling, culling, level-of-detail, caching

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Viewport culling | Built | `render2d.ts` `paint()` 1864-1871; `renderScene` cull rect 2003-2010 | Leaf AABB test against the page-space viewport rect; containers and connectors exempt. Works; reused by both backends. |
| Sub-pixel LOD | Built | `render2d.ts:1871` | Leaves with `max(w,h) * zoom < 0.5` are skipped. |
| Spatial index | Built | `spatial.ts` `SpatialIndex`; `scene.ts:412` `queryViewport` | Uniform grid, 512px cells, lazily built over leaves. Currently powers interest management, not the render cull. P1: drive the cull from the index so cull cost is sublinear in total node count. |
| Dirty-rect tiling math | Seam only | `tiles.ts` (`tilesForRegion`, `tileSizePage`, `tileCountForRegion`) | Pure functions with no caller. P0 for the GPU path: this is the tile grid. |
| Partial repaint | Not started | `Scene.dirtyRegion()` exists; `renderScene` ignores it | Full-surface repaint every frame today. GPU tile caching makes partial repaint the default. P0. |
| Retained tile cache | Not started | n/a | Rendered tiles kept as GPU textures keyed by (tile, zoom bucket, scene revision), with an LRU bound derived from `maxTextureSize` and a memory budget. P0. |
| Deep zoom | Partial | Zoom clamped 0.02-64x in `Canvas.tsx` | Canvas2D re-rasterizes vectors at every zoom, which is correct but expensive. Tiles need zoom-bucketed re-rasterization so a zoom-in shows a resampled tile for one frame and a re-rasterized tile the next, never a permanently blurry one. P1. |
| Static-content layer separation | Not started | n/a | Split the scene into a rarely-changing background layer and an actively-edited foreground so a drag repaints one small layer. P1. |
| Per-page scene cache | Built | `useEditorCanvas.ts` scene cache keyed on doc `rev` | Only visible pages build scenes; keep this and key GPU caches off the same revision. |

### Colour and compositing

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Colour model in the file format | Built | `schema.ts:64-77` (`Color {srgb, cmyk?, spot?}`) | Canonical sRGB with optional CMYK/spot for print. Unchanged by this spec. |
| Wide-gamut hook | Seam only | `schema.ts:112` `ImageSource.colorSpace?: "srgb" \| "display-p3" \| "cmyk"` | Declared on image sources; nothing in `@hc/engine` reads it. The only existing wide-gamut affordance in the format. |
| Working colour space | Not started | `color.ts` resolves to `rgba()` CSS strings | Define one: composite in linear-light extended sRGB internally, present in sRGB by default. Must be a deliberate decision, because compositing in linear changes the appearance of existing gradients and blends versus Canvas2D. P0, and the single largest parity risk in the spec. |
| Premultiplied alpha discipline | Not started | n/a | Every texture, every render target, every blend equation stated as premultiplied or not, once, and enforced by tests. Most cross-renderer halo and dark-fringe bugs originate here. P0. |
| Blend-mode parity | Partial | `blendToComposite()`; Go has none | Each of the schema's blend modes needs a defined formula agreeing across Canvas2D, GPU, and Go. Today the Go path applies none. P0. |
| Gradient interpolation space | Not started | `fills.ts` + Canvas2D gradient objects | Canvas2D interpolates gradients in non-linear sRGB; a linear-light GPU path will not match unless it deliberately reproduces that. Pick one and document it. P0. |
| Wide-gamut display output | Not started | n/a | Position: configure the presentation surface as extended-sRGB/P3 when the display supports it, keep authoring in sRGB, and never let a P3 display change stored colour values. P2. |
| HDR | Not started | n/a | Explicitly deferred. Tone-map wide-gamut content to SDR for presentation; real HDR authoring needs a schema colour model this spec will not open. |
| ICC and soft-proofing | Not started | `color.ts` header notes it as a later transform; `@hc/print` preflight handles CMYK rules | Soft-proofing is a presentation-time LUT on the GPU path once the working space exists. P2. |

### Text

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Canvas2D text layout and paint | Built | `render2d.ts` text path; `fonts.ts`; `@hc/text` metrics | Layout and wrapping are shared; only rasterization differs per backend. |
| Glyph atlas | Not started | n/a | Per (family, style, size bucket, subpixel-x bucket) atlas pages with LRU eviction; a shared atlas across tiles so a text-heavy page does not thrash. P1. |
| Deep-zoom text quality | Not started | n/a | Above the atlas size ceiling, fall back to path rendering for the glyph rather than magnifying an atlas entry. P1. |
| Subpixel positioning and hinting policy | Not started | n/a | Text must not shift horizontally between backends. Quantize glyph origins the same way on both, or accept a stated sub-pixel tolerance in the parity threshold. P1. |
| Text as the parity escape hatch | Not started | n/a | Simplest safe option for phase 1: keep text on the Canvas2D path composited over the GPU surface, so text parity is unchanged while vector and effects move. Documented as a deliberate hybrid, not an accident. P0. |
| RTL, CJK, and complex shaping | Built | `@hc/text` measured metrics | Shaping is upstream of rasterization and unaffected; the GPU path must not regress it. |

### Headless, export, and parity

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Go raster export | Built | `render/raster.go` (`golang.org/x/image/vector`) | Documented deltas in its own header: shape strokes not stroked, line nodes as thick quads, fallback-font glyphs not rotated, gradients as per-pixel approximations. |
| Go SVG and PDF export | Built | `render/svg.go`, `render/pdf.go` | SVG is the highest-fidelity output; PDF shares its geometry. The three server outputs do not currently agree with each other. |
| Go blend modes | Not started | grep of `backend/internal/render` finds none | `blendMode` is not applied on the server at all. A document using multiply exports wrong today. P0 for parity. |
| Go node effects | Not started | grep of `backend/internal/render` finds none | Blur, glow, shadow, and duotone are not applied on the server. P0 for parity. |
| Go shape strokes | Not started | `raster.go` header states strokes are not drawn | A stroked rectangle exports without its stroke. P0 for parity. |
| GPU acceleration for the Go renderer | Not started | n/a | **Position: the Go export renderer stays CPU.** A self-hosted single binary must run on a headless VM, a container, and a Raspberry Pi with no GPU, no driver stack, and no display server; adding a GPU dependency would make export environment-dependent and non-reproducible, which is the opposite of what an export must be. Export speed is bounded by the job registry, not by frame budgets. Deferred permanently unless a measured export-throughput problem appears, and then only as an optional accelerator behind identical golden tests. |
| Golden-image parity suite | Not started | no `golden` fixtures exist in the repo | The keystone deliverable. Fixture documents rendered by Canvas2D, each GPU backend, and the Go path, compared under a perceptual threshold, run in CI. P0. |
| Perceptual difference metric | Not started | n/a | A defined metric and threshold, not "looks the same" (section 10). P0. |

### Benchmarks and instrumentation

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| CPU render harness | Built | `bench.ts` (`benchmarkRender`, `createNullContext`, `benchmarkSceneBuild`) | Isolates traversal and dispatch from rasterization; explicitly positioned as the yardstick for a GPU path. |
| CPU perf regression guard | Built | `packages/engine/src/__tests__/perf.test.ts` | ~2ms/frame for 1000 nodes; loose 50ms ceiling to stay CI-stable; 16ms budget logged. |
| Browser paint benchmark | Built | `frontend/src/pages/bench/paint.tsx`; `npm run bench:paint` | Real canvas, dpr 2, continuous pan/zoom, page flips. Recorded: p50 120.5fps, p95-slow 111fps, worst 9.3ms, 0.51ms/page scene build. |
| GPU-aware benchmark scenarios | Not started | n/a | New scenarios the current harness does not cover: 50k paths, a deep effect stack, a procedural-graph parameter drag, deep zoom, and a paint stroke. Same page shape and the same `window.__benchResult` contract so `bench:paint` can drive them. P0. |
| Backend comparison mode | Not started | n/a | Run each scenario on every available backend on the same machine and emit one table; this is how a device-specific regression becomes visible. P0. |
| GPU timing and memory instrumentation | Not started | n/a | Timestamp queries where available, texture-memory accounting, tile-cache hit rate, pipeline-compilation stalls, all surfaced as structured JSON in the bench output. P1. |

## 5. UX and interaction behavior

The GPU path is an implementation detail that the user should notice only as speed. It becomes visible in exactly four situations, and each needs a defined behaviour.

- **No accelerated backend available.** The editor opens on Canvas2D with no modal, no blocking dialog, and no degraded-looking canvas. A quiet, dismissible indicator in the status area reads "Compatibility rendering" and links to a panel listing what is unavailable and why (adapter missing, blocked by policy, denied adapter, or user override). Every tool remains available. Features that are genuinely impossible on CPU at interactive rates degrade to an explicit preview contract rather than disappearing: a procedural graph previews at reduced resolution while a parameter is being dragged and resolves to full resolution on release; a motion preview drops to a lower playback frame rate and says so; a large brush shows a proxy stroke that resolves on stroke-end. The full-quality result is always computed for export.
- **Backend selection and override.** Settings expose Rendering: Automatic (default), Accelerated, Compatibility. Automatic probes and picks. Compatibility pins Canvas2D permanently for that user, which is both an accessibility affordance and the first support step for a rendering complaint. A `?render=2d` query parameter forces compatibility for one session without changing the stored preference, so a support conversation can isolate a bug in one message.
- **Context lost mid-session.** A lost device is not a data event: the scene graph and the document live in CPU memory and the CRDT. The canvas shows a brief, non-modal "Restoring graphics" state, the renderer rebuilds device, pipelines, atlases, and tile caches, and repaints. If restoration fails twice within a session, the renderer falls back to Canvas2D permanently for that session, tells the user once, and records the adapter string in the structured log. No edit is ever lost to a context loss, and no in-flight edit is discarded during restoration; input continues to mutate the store while the surface is dark.
- **Silent quality differences must not be silent.** If a specific effect cannot be reproduced on the active backend within the parity threshold, the renderer uses the CPU implementation for that node rather than drawing something different. A node that had to fall back is not visually flagged in the canvas (the canvas must show the document, not diagnostics), but the render diagnostics panel lists it, and the export path always uses the reference implementation, so an export is never worse than the preview.

Interaction quality is adaptive by default (the unconsumed `interactionQuality: "adaptive"` in `EngineConfig` finally gets a consumer). During a continuous gesture (pan, zoom, drag, brush) the renderer may reduce effect resolution, defer tile re-rasterization, and use cached tiles at the wrong zoom bucket; when the gesture settles, it re-renders at full quality within one frame budget. `interactionQuality: "full"` disables all of it for screenshots, recordings, and parity tests.

## 6. Functional requirements

Backends and capability:
- FR-1: `@hc/engine` exposes at least two accelerated backends behind the existing `RenderContextKind` seam, WebGPU and WebGL2, and always retains the Canvas2D path; no build configuration removes the Canvas2D path.
- FR-2: `gpuAvailable()` is replaced by a capability probe returning a structured record (backend, adapter description, feature flags, texture limits, timestamp-query support), and the probe never throws, never blocks first paint, and completes or times out within a stated budget.
- FR-3: Backend selection follows an ordered policy (WebGPU, then WebGL2, then Canvas2D) filtered by a maintained deny list of known-bad adapter identifiers, overridable by a user setting and by a per-session URL parameter.
- FR-4: Losing an accelerated context never loses document state; the renderer rebuilds all device resources from the scene graph and repaints, and after two failures in one session pins Canvas2D for the remainder of the session.
- FR-5: All app render surfaces select their backend through one renderer lifecycle, replacing the direct `renderScene` calls in `useEditorCanvas.ts` and the eleven other call sites, without changing their public behaviour.
- FR-6: `EngineConfig.tileSize`, `maxTextureSize`, and `interactionQuality` each acquire a real consumer, or are removed from the public type.

Vector rasterization:
- FR-7: The GPU path rasterizes fills under both non-zero and even-odd winding, strokes with the schema's alignment, cap, join, and miter-limit semantics, dash patterns, and linear, radial, and conic gradients.
- FR-8: Tessellated geometry is cached per node keyed by a flatness bucket and invalidated on geometry change, so a pan or a repeated frame does not re-tessellate.
- FR-9: Antialiasing quality meets a stated floor at every zoom level in the supported range; hairline strokes remain visible at minimum zoom and do not thicken at maximum zoom.
- FR-10: Rect clips use scissor or stencil and shape/freeform clips use a mask texture; clipped output matches the Canvas2D `clip()` result within the parity threshold.

Effects and procedural evaluation:
- FR-11: An effect executor evaluates a DAG of image operations as GPU render passes over pooled textures at the node's resolved resolution, with results cached by input hash, resolution, and parameter hash.
- FR-12: Every GPU effect has a CPU implementation whose output is within the parity threshold; a machine with no accelerated backend produces the same picture, more slowly.
- FR-13: GPU implementations reproduce the existing documented approximations in `effects.ts` rather than a differently-correct formula, so no existing document changes appearance when the backend changes. Any deliberate correctness improvement is a separate change with its own before/after golden set.
- FR-14: Every blend mode in the schema has one defined formula implemented identically in the Canvas2D path, both GPU backends, and the Go export renderer.

Scale and caching:
- FR-15: Rendering is tile-based on the GPU path, consuming `tiles.ts`, with a retained tile cache keyed by tile, zoom bucket, and scene revision, bounded by an explicit memory budget with LRU eviction.
- FR-16: A repaint touches only tiles intersecting the dirty region reported by `Scene.dirtyRegion()`; a full-surface repaint happens only on viewport change or cache invalidation.
- FR-17: The render cull is driven by the `SpatialIndex` rather than by a full traversal, so cull cost is sublinear in total node count; the existing sub-pixel LOD rule is preserved.
- FR-18: Zoom transitions show a resampled tile for at most one frame before a re-rasterized tile at the new zoom bucket replaces it.

Colour and compositing:
- FR-19: One working colour space is defined for the accelerated path and documented, including whether compositing is linear-light and which space gradients interpolate in; the choice is applied identically by both GPU backends.
- FR-20: Premultiplied-alpha handling is stated once for textures, render targets, and blend equations, and is enforced by a test that catches halo and dark-fringe regressions on a transparent-edge fixture.
- FR-21: Wide-gamut displays receive a correctly configured presentation surface where supported; stored colour values are never modified by the display's gamut, and a document authored on a P3 display opens identically on an sRGB display.

Text:
- FR-22: Text on the accelerated path renders through a glyph atlas with LRU eviction, falling back to path rendering above the atlas size ceiling so deep zoom stays crisp.
- FR-23: Glyph positioning is quantized identically across backends, or the residual difference is inside a stated sub-pixel tolerance in the parity threshold; text never reflows or shifts between backends.
- FR-24: Until FR-22 and FR-23 are proven by the parity suite, text may be composited from the Canvas2D path over the accelerated surface; this hybrid is a documented, tested configuration, not a temporary hack.

Parity:
- FR-25: A golden-image suite renders a fixture corpus through the Canvas2D path, each available GPU backend, and the Go export renderer, and compares every pair under the section 10 perceptual metric; the suite runs in CI and blocks merge on regression.
- FR-26: The fixture corpus covers every node type, every fill kind, every blend mode, every effect, stroke alignment and joins, clipping, text in Latin/CJK/RTL, transparency edges, gradient banding, and deep zoom, and includes at least one real design file per document type.
- FR-27: The Go export renderer closes its known parity gaps: shape strokes are stroked, blend modes are applied, and node effects are applied, or each remaining gap is recorded as an explicit, tested, user-visible export limitation rather than an undocumented difference.
- FR-28: The Go export renderer remains CPU-only; export output is bit-reproducible for a given input on a given binary version, independent of host hardware.

Measurement:
- FR-29: The benchmark harness gains GPU-aware scenarios (50k paths, deep effect stack, procedural parameter drag, deep zoom, paint stroke) reachable through the existing `bench:paint` driver and the `window.__benchResult` contract, plus a backend comparison mode that runs every available backend on one machine.
- FR-30: The renderer emits structured JSON diagnostics (selected backend, adapter, fallback reasons, tile-cache hit rate, texture memory, frame time percentiles) consumable by the F38 observability work and visible in a developer diagnostics panel.

## 7. Data model / schema changes

**None. This spec introduces no node types, no properties, and no schema version bump, and that is a design position, not an omission.**

Rendering is a function from a document to pixels. If the accelerated path required a field in the file, then a document authored on a GPU machine would carry state a Canvas2D machine could not interpret, and the fallback promise would be false. Worse, under the zero-data-loss rules a rendering-driven field would still have to be preserved forever by every future version, so a temporary implementation detail would become a permanent contract. Tile sizes, cache keys, atlas parameters, backend preference, and working-colour-space handling are all runtime concerns and belong in `EngineConfig`, in per-user settings, and in the renderer's own memory, never in `DesignFile`.

Consequences of that position, stated so they are not rediscovered later:
- `CURRENT_SCHEMA_VERSION` stays at 17 and the Go mirror `currentSchemaVersion` in `backend/internal/persistence/file.go` stays at 17. No migration step is registered, and `packages/schema/src/migrate.ts` is untouched. This is a pure code change touching no schema and no SQL.
- The backend preference (Automatic / Accelerated / Compatibility) is a per-user application setting alongside the existing theme preference, not document data. Two collaborators on the same document may be on different backends, which is precisely what the parity contract exists to make safe.
- `ImageSource.colorSpace` (`schema.ts:112`) already exists and is currently unread by the engine. The accelerated path may begin honoring it for image decode, which is a rendering improvement to an existing declared field, not a schema change. Honoring it must be gated by the golden suite, because it changes how existing P3-tagged images appear.
- If a future creation spec genuinely needs persisted render state (a baked cache, a resolution hint on a procedural node), that field belongs to that spec, is additive and optional, and follows the two-file bump rule. F44 does not pre-emptively add it.
- No SQL migration. No table gains a column. The export job schema and the job registry are unchanged.

## 8. API and realtime

No new REST endpoints and no new realtime frame types. Rendering is client-side and export already runs through the shipped job registry (`POST` an export, poll `GET /api/v1/jobs/{id}`); nothing about a GPU path changes that shape, and the export path stays CPU (FR-28), so the server contract is untouched.

The architectural work is inside the engine, and it is a worker and offscreen-canvas story.

- **Engine boundary stays framework-free.** `@hc/engine` gains a `backends/` directory (`webgpu/`, `webgl2/`, and the existing 2D path factored behind the same interface). No backend imports React, the store, or anything in `frontend`. Every backend is constructed from a `RenderTarget` plus an `EngineConfig` and speaks only the existing `Renderer` interface, so the browser, a worker, and a headless Node context construct them identically.
- **One renderer lifecycle, adopted everywhere.** `mountRenderer` becomes the single entry point that all twelve current `renderScene` call sites use. `renderScene` remains exported and unchanged for one-shot rendering (thumbnails, export, tests), because the Go export, `bench.ts`, and every parity fixture depend on a synchronous, target-agnostic one-shot path.
- **Worker execution model.** The editor canvas transfers control to an `OffscreenCanvas` and runs the renderer on a dedicated worker, so tessellation, tile rasterization, and effect evaluation never contend with React, input handling, or CRDT application on the main thread. `OffscreenCanvas` is already used by `duotone.ts` and by `renderMiniMap`, so the primitive is proven in this codebase; what is new is transferring the primary canvas and keeping the scene in sync.
- **Scene transport.** The worker needs the scene, and structured-cloning a large `DesignFile` every frame would cost more than it saves. The protocol is delta-based: the main thread sends the initial document once, then per-edit patches keyed by node id (the same granularity the editor's command framework and the CRDT projection already produce), plus viewport updates as small messages. Scene-graph construction and world-transform computation move to the worker. Hit-testing stays on the main thread against a mirrored scene, because selection must answer within the same input frame and must never wait on a worker round trip.
- **Graceful worker degradation.** Where `OffscreenCanvas` transfer is unavailable, the renderer runs on the main thread with the same backend. Worker execution is an optimization layered on top of backend selection, not a prerequisite for it, and each combination (worker + WebGPU, main + WebGPU, worker + 2D, main + 2D) is a supported, tested configuration.
- **Headless and Node.** The one-shot `render()` path must keep working with no `window`, no worker, and no GPU: this is how the CPU benchmark, the parity fixtures, and any Node-side rendering run today, and the backend refactor must not couple `renderScene` to a device.
- **`@hc/sdk` is unchanged.** No client method is added or altered.

## 9. AI hooks

**Out of scope, deliberately.** This spec renders pixels; it does not run models.

There is a real technical adjacency worth naming so nobody rediscovers it as an opportunity: WebGPU exposes compute shaders, and browser on-device inference runtimes use exactly that capability, so a machine with a working WebGPU device is also a machine that could run small models locally. HyCanvas does not pursue that here, for three reasons. First, the AI layer is a provider-adapter model with bring-your-own keys and encrypted per-workspace storage; a local inference path is a different trust, distribution, and reproducibility model and belongs to the AI roadmap, not the render roadmap. Second, an inference workload would contend with the renderer for the same device, memory budget, and queue, which is the fastest way to turn a smooth editor into a stuttering one. Third, coupling the two would mean a GPU regression becomes an AI outage and an AI regression becomes a render outage, which is a maintenance trade nobody wants.

Two narrow, non-committal touchpoints are acknowledged and nothing more:
- If AI-generated content (procedural graphs, generated images, generated motion) becomes heavy enough that its preview needs GPU evaluation, it uses the FR-11 effect executor like any other content. The executor is content-agnostic; it does not know or care that a graph came from a model.
- The renderer's structured diagnostics (FR-30) include enough device information that an AI feature which later wants to make a local-versus-remote decision could consume it. Exposing that record is free; acting on it is not this spec's business.

## 10. Performance and scale

Targets are stated against a defined reference machine and are measured by the harness, not asserted. Reference: a 2020-or-later laptop-class integrated GPU at devicePixelRatio 2, 1920 x 1080 logical viewport. A discrete-GPU tier and a low-end tier are measured and recorded but do not define pass/fail.

Frame budgets:
- Interactive gestures (pan, zoom, marquee, drag, brush) hold a 16.7ms frame budget at p95, not merely at the mean; the existing browser benchmark already reports p50, p95-slow, and worst frame, so the harness shape is right.
- Worst frame under a sustained gesture stays under 33ms. A single dropped frame is acceptable; a visible hitch is not.
- Pipeline compilation never blocks a user-visible frame: pipelines are compiled during startup or asynchronously, and a not-yet-ready pipeline falls back to Canvas2D for that node in that frame.

Scale targets:
- 50,000 visible vector paths pan and zoom within the interactive frame budget. Today's measured baseline is 1000 nodes per page at p50 120.5fps on Canvas2D; the GPU path must clear the 50x scale-up, not merely beat Canvas2D at 1000 nodes.
- A 200-page document opens and navigates without materializing every page (the per-page scene cache and page-granular projection already ensure this; the GPU path must not regress it by caching tiles for pages that are not visible).
- An effect stack of 10 chained operations over a 4000 x 3000 buffer evaluates within one interactive frame budget during a parameter drag at preview resolution, and within 500ms at full resolution on release.
- A brush stroke shows paint within 2 frames of the pointer sample that produced it.
- Zoom range 0.02x to 64x (the shipped clamp) with no rendering artefact at either end and no permanently blurry tile at any step.
- Texture memory stays under an explicit budget with LRU eviction; exceeding the budget degrades cache hit rate, never correctness, and never crashes the tab.

Parity metric (the definition FR-25 depends on):
- Comparison is per-pixel in linear light after both images are converted to a common space, scored with a perceptual metric rather than a raw difference, so a sub-pixel antialiasing difference does not fail a build while a wrong blend mode does.
- Thresholds: no pixel exceeds a hard per-pixel ceiling, and the fraction of pixels exceeding a smaller soft ceiling stays under a stated percentage of the image. Text-bearing fixtures carry a slightly looser soft threshold covering sub-pixel glyph positioning (FR-23); geometry, fill, blend, and effect fixtures carry the strict threshold.
- Thresholds are constants in the test harness, reviewed as code. Raising one is a reviewed change with a stated reason, never an incidental edit to make a build pass.
- A fixture that cannot meet the threshold on a given backend is recorded as a known limitation with an owner and a linked issue, and the suite asserts the limitation still holds, so a silent drift becomes a test failure in either direction.

Measurement:
- The existing `npm run bench:paint` driver, the `window.__benchResult` contract, and the `bench.ts` CPU harness are reused rather than replaced; new scenarios are additional pages behind the same driver.
- Every scenario runs on every backend available on the machine and emits one comparison table, so "faster on my machine" is never the evidence.
- CI runs the CPU harness and the golden suite headlessly; GPU frame-rate numbers are recorded on known reference hardware, because a CI runner's software rasterizer cannot answer a frame-rate question and pretending otherwise produces meaningless gates.

## 11. Security and threat model

An accelerated renderer hands document-derived data to a driver stack that is outside the browser's usual memory-safety story. The posture below is rendering-specific; cross-cutting infrastructure is F38's.

- **No shader compilation from untrusted content.** This is the hard rule. Procedural graph nodes, effects, and blends are drawn from a fixed, finite catalogue of shader programs authored in this repository; a document supplies parameters into uniforms and bind groups, never source text, never a program identifier that is not in the catalogue, and never string-concatenated shader code. If a future spec wants user-authored shaders, it is a separate feature with its own sandbox, its own review, and its own threat model, and it does not arrive as a side effect of F44.
- **Parameter validation at the boundary.** Every value crossing into a uniform is clamped and range-checked against the schema's own validation before it reaches the device. A NaN, an infinite, or a wildly out-of-range value is a source of driver hangs, so the effect executor rejects them at the edge rather than trusting that a slider produced them.
- **Resource exhaustion.** A hostile or merely enormous document can request an unbounded number of textures, an unbounded texture size, or an unbounded pass count. Every one of those is bounded: texture allocations come from a pooled allocator with a hard memory ceiling derived from `maxTextureSize` and device limits; effect graph depth and pass count are capped; a graph exceeding a cap falls back to CPU evaluation at reduced resolution rather than allocating. Exceeding a budget degrades quality, never stability.
- **Long-running dispatch and driver hangs.** A single pass over an enormous buffer can trip a platform's watchdog and reset the GPU for the whole system. Work is chunked into bounded passes with a per-frame time budget, large effect evaluations are tiled rather than issued as one dispatch, and the renderer treats a lost device as expected rather than exceptional (FR-4).
- **Driver crashes and blast radius.** A device loss must never take the document with it. The scene graph and the document are the source of truth in CPU memory and in the CRDT; GPU resources are derived, disposable, and rebuildable. After repeated loss the renderer pins Canvas2D and records the adapter string, which is how a bad-driver deny-list entry gets written.
- **Browser sandbox and cross-origin.** All GPU work stays inside the browser sandbox and inherits its process isolation; the engine adds no native module, no WASM-with-device-access, and no privileged path. Images sampled into shaders follow the same origin rules the existing asset pipeline enforces, and a tainted resource must not silently produce a readback path. Any tile or effect readback (for export, thumbnails, or the parity suite) is subject to the same origin checks the Canvas2D path already obeys.
- **Fingerprinting.** Adapter descriptions and device limits are identifying. The renderer keeps them in local diagnostics and structured server logs for support, never in document data, never in an export, and never in telemetry that leaves a self-hosted instance by default.
- **Self-host posture.** The server never needs a GPU (FR-28). A self-hoster running on a headless container gets identical exports to one running on a workstation, and no deployment ever requires a driver stack, a display server, or device passthrough.

### Observability and metrics

The renderer emits structured JSON diagnostics (FR-30): selected backend, adapter description, fallback reason and count, context-loss count, tile-cache hit rate, texture memory high-water mark, and frame-time percentiles. Success metrics: proportion of sessions on an accelerated backend, fallback rate by reason, context-loss rate by adapter, p95 frame time under gesture by document size, and golden-suite pass rate by backend. Org-wide observability, tracing, and dashboards defer to F38.

## 12. Accessibility and i18n

- **GPU-independent correctness is the accessibility requirement.** Everything a user can do must be doable on the Canvas2D path. A feature that is only usable with an accelerated backend is a feature that excludes users on managed machines, older hardware, and hardened configurations, and it does not ship in that form.
- **Reduced motion.** `prefers-reduced-motion` already gates transitions (`packages/engine/src/deck.ts`, `PresentMode.tsx`, `ExportDialog.tsx`, and the global rule in `globals.css`). The accelerated path adds no new motion of its own, and specifically adds no progressive-refinement shimmer, no tile fade-in, and no loading animation on the canvas. A tile that is not ready shows the previous content, not an animation.
- **High contrast and forced colours.** Design content is never restyled by a theme, and that rule is unchanged: forced-colours and high-contrast modes affect the app chrome only. The renderer must ensure a forced-colours environment does not alter canvas pixel output, and the diagnostics indicator, the compatibility notice, and the settings control all honor forced colours as ordinary chrome.
- **The compatibility indicator is a chrome element.** It is keyboard reachable, screen-reader labelled, dismissible, and never the only way to learn the renderer state (the settings panel always shows it). It is not a canvas overlay, so it is not affected by rendering state.
- **Text quality is an accessibility concern, not only a fidelity one.** Blurry or shifted glyphs harm low-vision users first. FR-23's positioning rule and the looser text threshold in the parity metric exist for that reason, and the deep-zoom path-rendering fallback (FR-22) exists because magnification is an assistive behaviour, not only an authoring one.
- **i18n.** Shaping, bidi, and measured metrics live in `@hc/text` upstream of rasterization and are unaffected by backend choice; the parity corpus includes CJK and RTL fixtures so a backend cannot regress them unnoticed. All new user-visible strings (the compatibility notice, the rendering setting, the diagnostics panel) are localized.

## 13. Import / export and interop

- **Export parity is the point.** Export runs on the Go CPU renderer (FR-28), so every export is reproducible and hardware-independent. The parity suite (FR-25) makes the browser preview and that export agree, which is the promise this spec exists to keep: a GPU path that renders differently from the export path would silently ruin every export, which is a worse outcome than having no GPU path at all.
- **The Go path's existing gaps are export bugs today, not new work created by this spec.** A stroked shape exports without its stroke, a multiply blend exports as normal, and a blurred node exports sharp, because `raster.go` implements no strokes, no blend modes, and no effects. FR-27 requires each gap to be closed or documented as a tested, user-visible limitation. Closing them is a prerequisite for the parity suite being meaningful, and it improves exports for every user regardless of whether they ever get an accelerated backend.
- **The three server outputs must agree with each other too.** `svg.go` (highest fidelity), `pdf.go` (shared geometry), and `raster.go` currently diverge. The golden corpus compares them pairwise, so raster/vector divergence becomes visible rather than folkloric.
- **Colour profiles.** Raster exports are tagged sRGB by default. If the working space is linear-light internally (FR-19), export converts back to the tagged output space, and the conversion is a golden-tested step. `ImageSource.colorSpace` is honored on decode if and only if the golden suite proves it does not change existing documents' appearance. CMYK and spot handling stay with `@hc/print` preflight and the print pipeline; the accelerated path does not composite in CMYK and does not claim to.
- **The open file format is unchanged**, so every existing file opens, renders, and exports on any backend, and a file authored today opens on a build from before F44 with identical results. Mixed-version and mixed-backend collaboration is safe by construction, because rendering state is never persisted.
- **A rendering-diagnostics export** (the golden comparison output for one document across the available backends) is a support artefact, downloadable by the user, containing no document content beyond the rendered images the user already has.

## 14. Phasing / milestones

Each phase is independently shippable and independently abandonable. If a phase's measurements do not justify the next one, stopping is a legitimate outcome.

**Phase 0: parity before acceleration.** No GPU code at all. Build the golden-image suite and the perceptual metric (FR-25, FR-26), wire it into CI across Canvas2D and the three Go outputs, and close or document every Go gap it exposes (FR-27). Note what has since landed and what has not: the Go RASTER path now implements shape strokes, all sixteen blend modes, drop shadows, and the effect kinds (`composite.go`, `effects.go`), so the remaining raster gaps are narrower than this spec was written against: `PathNode` strokes are still not drawn, an effect still applies to the whole subtree where the browser resets before children, and shadow `spread` is ignored. `svg.go` and `pdf.go` remain untouched and are now the widest divergence in the product, which is the real Phase 0 target alongside the suite itself. Adopt the renderer lifecycle at all twelve call sites (FR-5) and give the dead `EngineConfig` knobs consumers or delete them (FR-6). Extend the benchmark harness with the new scenarios and the backend comparison mode (FR-29). At the end of Phase 0 the product is measurably better for every user, no GPU has been written, and the safety net that makes the rest survivable exists. **This phase ships value on its own and is the precondition for everything after it.**

**Phase 1: minimum viable GPU (the scope that unblocks F40 to F43).** A WebGPU backend that composites the Canvas2D-rendered scene as a texture and runs only the effect and procedural-graph executor on the GPU (FR-11 to FR-14), with tile-based partial repaint (FR-15 to FR-17), full capability detection, selection policy, and context-loss recovery (FR-1 to FR-4), the working-colour-space and premultiplication decisions made and tested (FR-19, FR-20), and text left on the Canvas2D path (FR-24). Vector geometry is still rasterized by Canvas2D into tiles. This is the smallest thing that makes procedural graphs, painting, and motion previews interactive, and it deliberately does not take on the hardest parity surface.

**Phase 2: GPU vector rasterization.** Path tessellation and caching, GPU fills and strokes, gradients, clipping, antialiasing quality, and the 50,000-path target (FR-7 to FR-10). This is where F41's path counts get met and where the parity suite earns its cost, because stroke geometry and antialiasing are the differences a designer notices.

**Phase 3: text, deep zoom, and the WebGL2 backend.** Glyph atlas with path fallback (FR-22, FR-23), zoom-bucketed tile re-rasterization and static-layer separation (FR-18), and the WebGL2 backend covering the same surface for machines without WebGPU. WebGL2 moves earlier if Phase 1 measurement shows the WebGPU availability floor is too low to be worth shipping alone.

**Phase 4 (measurement-gated, not committed).** Wide-gamut presentation surfaces, ICC soft-proofing on the GPU path, mesh gradients, and compute-based tessellation. Each is entered only on evidence from the harness, and each may be permanently declined.

**Never in this spec:** a GPU-accelerated Go export renderer, user-authored shaders, HDR authoring, and removing the Canvas2D path.

## 15. Acceptance criteria

- AC-1: On a machine with a working WebGPU adapter, the editor selects the accelerated backend automatically; on a machine with none, it selects Canvas2D, opens normally, and shows the compatibility indicator with a readable explanation (FR-1, FR-2, FR-3).
- AC-2: Setting Rendering to Compatibility, or loading with `?render=2d`, pins the Canvas2D path; every tool, every document type, and every export continues to work with no feature removed (FR-3).
- AC-3: Forcing a context loss mid-edit (via the device-loss test hook) restores the canvas without losing a single edit, with the document identical before and after; a second forced loss in the same session pins Canvas2D and notifies the user once (FR-4).
- AC-4: **Golden-image parity.** For every fixture in the corpus, the images produced by the Canvas2D path, each available GPU backend, and the Go export renderer agree pairwise under the section 10 perceptual metric: no pixel over the hard ceiling, and pixels over the soft ceiling under the stated fraction, with the text-fixture allowance applied only to text-bearing fixtures. The suite runs in CI and fails the build on regression (FR-25, FR-26).
- AC-5: The corpus covers every node type, every fill kind, every blend mode, every effect, all three stroke alignments with each join and cap, rect and shape clipping, Latin/CJK/RTL text, a transparent-edge fixture, a gradient-banding fixture, a deep-zoom fixture, and at least one real design file per document type (FR-26).
- AC-6: A stroked shape, a multiply-blended node, and a blurred node each export from the Go renderer matching the browser within the parity threshold, or each remaining difference is a recorded, tested, user-visible limitation that the suite asserts still holds (FR-27).
- AC-7: **Measured frame rate.** On the reference machine, a 50,000-path document pans and zooms with p95 frame time under 16.7ms and no frame over 33ms, measured by the extended harness through `npm run bench:paint`, with the result recorded in this spec the way AC-10's 120.5fps result is recorded in doc 16 (FR-29).
- AC-8: A 10-operation effect stack over a 4000 x 3000 buffer tracks a parameter drag within the interactive frame budget at preview resolution and resolves at full resolution within 500ms of release (FR-11).
- AC-9: With no accelerated backend available, the same effect stack produces an image within the parity threshold of the GPU result, and the UI states that it is computing at reduced preview quality (FR-12, section 5).
- AC-10: Changing one node in a large document repaints only the tiles intersecting its dirty region, verified by instrumentation counting rasterized tiles per frame, not by inspection (FR-15, FR-16).
- AC-11: Zooming from 100% to 6400% and back shows a re-rasterized tile within one frame of each zoom-bucket change, and no tile remains resampled after the gesture settles (FR-18).
- AC-12: A transparent-edge fixture composited over both light and dark backgrounds shows no halo or dark fringe on any backend, proving the premultiplication contract (FR-20).
- AC-13: Every blend mode produces the same result on Canvas2D, each GPU backend, and the Go export renderer within the strict threshold (FR-14).
- AC-14: Text rendered on an accelerated backend does not shift, reflow, or change line breaks relative to Canvas2D; glyph positions are within the stated sub-pixel tolerance, and text at 6400% zoom is path-rendered rather than magnified from the atlas (FR-22, FR-23).
- AC-15: A document authored on a wide-gamut display opens with identical stored colour values and a matching appearance on an sRGB display, and no colour value in the file changes as a result of the display's gamut (FR-21).
- AC-16: A procedural graph node supplies only parameters into a catalogued shader; an attempt to inject shader source or an unknown program identifier through document content is rejected at the boundary, and no path exists from document data to shader compilation (section 11).
- AC-17: A document requesting an effect graph beyond the pass, depth, or texture-memory caps degrades to CPU evaluation at reduced resolution and continues to render; the tab does not crash and the device is not lost (section 11).
- AC-18: With the accelerated backend active, the editor canvas renders on a worker via `OffscreenCanvas`, main-thread input latency does not regress against the Canvas2D baseline, and hit-testing answers within the same input frame; where transfer is unavailable, the same backend runs on the main thread (section 8).
- AC-19: Exporting the same document on a GPU-equipped host and a headless GPU-less host produces identical output bytes for a given binary version (FR-28).
- AC-20: `CURRENT_SCHEMA_VERSION` and the Go mirror are still 17, no migration step was added, and no SQL migration exists in the change; opening a document created before F44 and one created after produces identical renders on every backend (section 7).

## 16. Test plan

- **Golden-image parity (the centrepiece).** The fixture corpus rendered through Canvas2D (headless via the existing one-shot `render()`), each GPU backend, and the Go export renderer, compared pairwise under the perceptual metric. Runs in CI for the CPU pairs on every commit; GPU pairs run on a self-hosted reference runner and on release candidates. Every failure emits the two images plus a difference map as build artefacts, because a parity failure is unreviewable without them.
- **Fallback matrix.** Every combination of backend (WebGPU, WebGL2, Canvas2D), execution context (worker, main thread), interaction quality (adaptive, full), and user override (Automatic, Accelerated, Compatibility) is a named configuration; a smoke suite opens each document type, performs a representative edit, and exports in each configuration. A configuration that is not in the matrix is not supported.
- **Device matrix.** Rendering is a cross-device problem, so the golden suite runs on a maintained device list spanning at least one discrete GPU, one integrated GPU, one Apple-silicon GPU, one Android-class mobile GPU, and one software-rasterizer configuration, across the browsers that ship WebGPU and those that ship only WebGL2. Results are recorded per device, and a device-specific failure is a known limitation with an owner, never a silently loosened threshold.
- **Unit (pure cores).** Tessellation output determinism and cache-key correctness; tile math against `tiles.ts` invariants; spatial-index-driven cull equivalence with the current traversal cull (same visible set, fewer tests); capability-probe parsing including malformed and hostile adapter records; parameter clamping rejecting NaN, infinity, and out-of-range values; blend-mode formula equivalence tested numerically rather than visually.
- **Context loss and recovery.** Forced device loss during idle, during a gesture, during effect evaluation, and during export-thumbnail generation; assert document integrity, successful rebuild, and the two-failure pin-to-Canvas2D rule.
- **Resource exhaustion.** Documents that request oversized textures, deep effect graphs, and excessive pass counts; assert degradation to CPU at reduced resolution, a bounded memory high-water mark, and no crash or device loss.
- **Go backend (Go tests).** New stroke, blend-mode, and effect implementations in `backend/internal/render` with table-driven unit tests, plus cross-output consistency tests comparing `raster.go`, `svg.go` (rasterized for comparison), and `pdf.go` on the shared corpus. Export reproducibility asserted by rendering the same input twice on different hosts and comparing bytes.
- **Performance.** The extended harness scenarios (50k paths, deep effect stack, procedural parameter drag, deep zoom, paint stroke) on every available backend, reported as one comparison table with p50/p95/worst; the existing CPU harness and `perf.test.ts` kept as the regression floor; texture memory and tile-cache hit rate asserted against budgets.
- **Regression against the shipped baseline.** The existing 50-page x 1000-node `bench:paint` scenario must not regress on Canvas2D as a side effect of the backend refactor. The recorded p50 120.5fps / 9.3ms worst frame is the floor.
- **Accessibility.** Compatibility indicator keyboard reachability and screen-reader labelling; forced-colours and high-contrast modes verified not to alter canvas pixels; `prefers-reduced-motion` verified to introduce no new canvas animation; text-quality fixtures reviewed at magnification.
- **Manual.** A rendering-support runbook (reproduce a report, capture diagnostics, pin compatibility mode, file a deny-list entry); a self-host smoke test proving export works on a GPU-less container; a designer review session comparing GPU and Canvas2D output side by side on real production documents, because a metric that passes while a designer says it looks wrong means the metric is wrong.

## 17. Differentiators

- **A parity contract, not a parity claim.** Most editors that ship a GPU renderer have a separate export renderer and no cross-renderer test suite; divergence is discovered by users. A perceptual golden suite spanning the browser preview, both GPU backends, and the headless export path, running in CI and blocking merge, is a stronger correctness guarantee than the preview-versus-export story of any tool in this category, hosted or self-hosted.
- **The fallback is a first-class product, not a degraded mode.** Canvas2D stays the baseline forever, every feature states what it loses without a GPU, and a locked-down machine opens, edits, and exports the same documents. Tools that require WebGL or WebGPU simply do not open on those machines.
- **Export is hardware-independent by design.** A self-hoster's export is reproducible on a headless container with no driver stack and no device passthrough, and matches a workstation byte for byte. Hosted competitors do not have to solve this; self-hostable ones usually have not.
- **One scene graph, one file format, three renderers that agree.** The open format means the accelerated path is an optimization over the same document everyone else reads, with no GPU-specific state persisted, so a document is never coupled to the machine that made it.
- **Honest measurement in public.** The existing benchmark culture (a CPU harness isolating traversal from rasterization, a real-browser paint benchmark with recorded p50/p95/worst numbers) extends to a per-backend comparison table on real devices. Published, reproducible numbers on named hardware are rare in this category.
- **A GPU path that closes existing export bugs on the way in.** Phase 0 brings the vector outputs up to the raster path and pins the whole lot with golden images, for every user, GPU or not, because parity work cannot start until the reference is right.

## 18. Open questions and risks

- **Working colour space is the highest-risk decision in this spec.** Compositing in linear light is more correct and will make some existing documents look different from how their author saw them, because Canvas2D composites and interpolates gradients in non-linear sRGB. The zero-data-loss rule is about data, not appearance, but silently changing how a saved design renders is close enough to violate the spirit. Options: reproduce the Canvas2D behaviour exactly on the GPU path and never composite in linear (safe, permanently limiting); composite in linear and accept a documented appearance change (correct, disruptive); or make the working space a document-level property (correct and safe, but that is a schema change this spec refuses to make). Leaning toward reproducing Canvas2D behaviour for Phases 1 and 2 and revisiting only with a before/after golden set and an explicit product decision. Unresolved.
- **How much of WebGPU availability is real.** The selection policy assumes WebGPU is common enough that Phase 1 reaches most users. If measurement shows otherwise, WebGL2 moves from Phase 3 to Phase 1, which roughly doubles Phase 1 cost, since WebGL2 lacks compute and storage textures and the effect executor needs a different implementation strategy there. Mitigation: measure availability from real sessions before committing Phase 1 scope.
- **Two renderers is a permanent tax and the plan must survive losing interest.** Every new node type in every future spec becomes two or three implementations plus fixtures. Mitigation: the Canvas2D path stays authoritative, a new node type ships on Canvas2D first and gets a GPU path only when measurement demands it, and a node with no GPU implementation composites through the Canvas2D tile path rather than blocking. This must be enforced in review, not just written here.
- **Text is the parity surface most likely to fail and the one users notice fastest.** FR-24 hedges by keeping text on Canvas2D through Phases 1 and 2, but a Canvas2D text layer composited over GPU tiles has its own costs (an extra surface, an extra composite, and ordering complexity when text sits between GPU-rendered layers). Open: whether the hybrid can express arbitrary z-order or whether text must be promoted to its own compositing layer with ordering constraints.
- **Worker scene transport granularity is unproven.** Per-node patches assume edits are small and localized. A multi-select transform, a paste of 5,000 nodes, or a CRDT rebase can produce a very large patch, and structured-cloning that per frame may cost more than the GPU saves. Mitigation: a spike measuring patch size distribution against real edit traces before committing the worker protocol; a fallback to main-thread rendering is always available.
- **The parity threshold could become a rubber stamp.** A threshold loose enough that nothing ever fails is worse than no suite, because it manufactures confidence. Mitigation: thresholds are code, reviewed as code; every loosening cites a specific fixture and reason; and the suite asserts known limitations still hold, so drift fails in both directions. Still relies on review discipline.
- **CI cannot answer frame-rate questions.** A CI runner's software rasterizer produces meaningless GPU timings, so frame-rate acceptance depends on reference hardware that has to be maintained, which is real operational cost for a project that ships a single self-hostable binary. Open: whether a self-hosted reference runner is worth maintaining, or whether GPU performance gates run only at release on a developer machine with recorded results.
- **Device-specific bugs will outnumber logic bugs.** Driver-specific miscompilations, precision differences, and vendor-specific blend behaviour will be the bulk of the maintenance load, and a self-hosted user's report will arrive with hardware nobody on the project owns. Mitigation: the diagnostics record, the adapter deny list, the one-parameter compatibility escape hatch, and a support runbook that reaches a workaround in one message.
- **F30 explicitly dropped GPU scale for the board, and this spec must not quietly re-open it.** F44's targets are driven by F40 to F43, not by 10k-object boards. If the board later benefits, that is a bonus, not a commitment, and F30's scope decision stands until F30 changes it.
- **Whether Phase 1's "Canvas2D geometry into GPU tiles" hybrid is a real speedup or an architectural detour.** It unblocks the effect executor without touching vector parity, which is the whole point, but it adds a rasterize-then-upload step per dirty tile that may dominate on large viewports. Mitigation: prototype and measure the upload cost against the effect-evaluation saving before committing Phase 1; if the upload dominates, Phase 2 moves ahead of Phase 1 and takes the parity risk earlier.
