# F42: Raster imaging and digital painting

| Field | Value |
| --- | --- |
| Feature ID | F42 |
| Phase | 5 Creation depth |
| Sequence | 42 |
| Status | Not started |
| Depends on | F40 (procedural node graph / non-destructive editing: owns every live filter, adjustment, and warp as a parameterized operation), F44 (GPU rendering path: owns WebGL/WebGPU, which several painting features need to be practical), F16 (realtime/CRDT, presence, locks, offline, branches, history), F38 (accessibility/i18n/security/NFR), F23 (AI media, where generative imaging shares the media pipeline), `@hc/schema` (open file format + forward migration), `@hc/engine` (framework-agnostic Canvas2D scene graph, dirty-tile repaint, asset provider), `@hc/media` (sniffing, quotas, alpha-matte math, dedupe/perceptual hash) |

HyCanvas today is a vector, scene-graph product: everything on the canvas is a resolution-independent node, and the only pixels in the document are read-only photographs referenced by asset id. That covers layout, presentation, and diagramming, and it stops exactly where digital art and photo work begin. This spec makes pixels a first-class citizen of the same canvas and the same open file format: a real brush engine with pressure/tilt/velocity dynamics and custom tips, stylus input with palm rejection and stroke prediction, pixel selections and non-destructive masks, live adjustment layers and filters (expressed as F40 procedural operations, never as a second parallel effect mechanism), mesh/pin/perspective warp and liquify, and heal/clone/patch retouching, all rendering in the browser on Canvas2D, in the Go headless export path, and inside a CRDT document that must never be bloated by pixel payloads. The single hardest design problem here is not the brush: it is where painted pixels actually live so that version history, branching, offline editing, realtime merge, and export all keep working without pushing megabytes through the update log, and section 7 answers that question first.

## Current state

Audited against the code: `packages/schema/src/schema.ts` (`CURRENT_SCHEMA_VERSION = 17`, `ImageNode`, `ImageSource`, `ImageFill`, `CropRect`, `ClipPath`, `InkNode`/`InkPoint`, `PathNode`/`PathContour`, `MaskNode`, `BooleanNode`, `AssetRef`, `Effect`, `AdjustmentOp`, `Duotone`, `BlendMode`, `NodeBase.data`) + `packages/schema/src/migrate.ts` (steps keyed on source version) + `backend/internal/persistence/file.go` (`currentSchemaVersion = 17`, `designs/{id}/snapshots/{checksum}.hyc`) and `persistence/validate.go`; `frontend/src/lib/imageFilters.ts` (`FILTER_PRESETS`, `resolvePresetOps`, `autoEnhanceOps`, `rasterizeToPng`, `removeBackground`); `frontend/src/components/editor/PropertiesPanel.tsx` (`runBgRemoval`, the Filters/Adjust/Effects tabs); `frontend/src/components/editor/Canvas.tsx` (pointer handling, `inkStroke`, pen-pressure capture, palm rejection) and `WhiteboardSurface.tsx` (`pickInk`, pen/marker/highlighter presets); `packages/engine/src/{render2d,effects,duotone,image,tiles,renderer,types}.ts` (`drawInk`, `drawImageNode`, `effectsFilter`, `adjustmentOpToFilters`, `applyDuotone`, `duotoneCanvas`, `computeEffectivePpi`, `isLowResolution`, `tilesForRegion`, `gpuAvailable`, `AssetProvider`); `frontend/src/lib/assetProvider.ts` (`imageAssets`); `packages/media/src/{matte,sniff,quota,ingest,dedupe,phash,fidelity}.ts`; `backend/internal/uploads/uploads.go` (`store`, `quotaBytes`, `userQuotaBytes`, SSRF-vetted `ImportFromURL`), `backend/internal/storage/{storage,s3}.go` (`Driver` with `Put`/`Get`/`Delete`/`Exists`, local + S3), `backend/internal/render/{raster,svg,pdf,nodes_extra}.go` (`rasterImage`, `rasterInk`, `placeholderBox`) and `backend/internal/httpapi/embed_assets.go` (`embedNodeAssets`, `embedDesignFileAssets`); `packages/realtime/src/reconcile.ts` (`reconcile`, `fromDoc`, `reconcileKeyedArray`, `reconcilePlainArray`) and `backend/internal/persistence/history_updates.go` (update log with `blob_url` offload).

What exists today and is genuinely useful groundwork:

- Pixels are referenced, never embedded. `ImageNode.source` is an `ImageSource { assetId, naturalWidth, naturalHeight, colorSpace?, previewKey? }`, and `DesignFile.assets` is a list of `AssetRef { id, kind, url, mime, checksum? }`. The document holds ids and URLs; the bytes live in `backend/internal/storage` behind an opaque-key `Driver` with a local-filesystem default and an S3/MinIO alternative, written at `assets/{workspaceID}/{id}.{ext}` by `uploads.Service.store`, quota-checked per workspace and per user.
- Content addressing is already an established pattern in this codebase. `persistence/file.go` writes design snapshots as `designs/{designID}/snapshots/{sha256}.hyc`, and `design_update_logs` rows can offload their payload to a `blob_url` in the same storage driver rather than sitting inline in Postgres. The pixel-storage design in section 7 is a direct extension of both.
- A stroke node type ships. `InkNode` carries a decimated `{x, y, p?, t?}` point stream plus `smoothing`, an optional `seed`, and a `brush { width, opacity, color, mode: pen | marker | highlighter }`. `render2d.ts` `drawInk` builds a variable-width filled ribbon (pen width responds to per-point pressure; highlighter multiplies), and `backend/internal/render` `rasterInk` mirrors it so ink exports headlessly. This is a vector ribbon, not a raster brush: there is no stamp/spacing model, no flow, no hardness, no tip texture, no tilt, and no velocity dynamics.
- Stylus input is partly there. `Canvas.tsx` handles PointerEvents with pinch-zoom, two-finger pan, pen-vs-finger discrimination, palm rejection (touch is ignored while a pen is down), and `e.pressure` capture for `pointerType === "pen"`. Tilt (`tiltX`/`tiltY`, `twist`), coalesced events (`getCoalescedEvents`), and predicted events (`getPredictedEvents`) are not read at all.
- Image adjustment exists as a shallow, display-only layer. `Effect` includes `{ kind: "adjustment"; ops: AdjustmentOp[] }`, `{ kind: "blur"; radius }`, `{ kind: "glow" }`, `{ kind: "outline" }`, shadows, and `{ kind: "duotone" }`. `packages/engine/src/effects.ts` `adjustmentOpToFilters` maps op names to CSS filter functions and `effectsFilter` concatenates them onto `ctx.filter`; `duotone.ts` is the one effect that renders through a real per-pixel LUT into a cached offscreen canvas. `frontend/src/lib/imageFilters.ts` supplies eleven named presets and an auto-enhance bundle. There are no curves, no levels, no channel mixer, no selective colour, no per-channel work, no sharpen, no noise, no distort/stylize family, and no adjustment layer that affects the nodes below it.
- Background removal ships and is destructive. `PropertiesPanel.tsx` `runBgRemoval` fetches the asset, rasterizes non-PNG/JPEG/WebP sources through `rasterizeToPng`, runs `@imgly/background-removal` (dynamically imported, WebGPU-preferred), and then calls `setImageSource(id, dataUrl)`. That path pushes a base64 data URL of the cutout into `DesignFile.assets` as a new `AssetRef`, which means a cutout today lands inside the document (and therefore inside the CRDT and every snapshot). That is precisely the failure mode this spec must not generalize.
- `packages/media/src/matte.ts` is a real, framework-free pixel core that nothing consumes yet: `growMatte`, `shrinkMatte`, `featherMatte`, `refineMatte`, `brushMatte` (a soft/hard-edged brush stamp with hardness and flow), and `applyMatteToRGBA`, over an 8-bit alpha buffer, with separable box blur and separable morphology already implemented. Grep shows no importer outside `@hc/media` itself. This is the seed of both the selection engine and the brush stamp, sitting unused.
- The engine already has the shape of what a raster path needs. `tiles.ts` (`tilesForRegion`, `tileSizePage`) implements dirty-rectangle tiling in page space; `EngineConfig` carries `tileSize` (default 256), `maxTextureSize`, and `interactionQuality`; `AssetProvider` gives the renderer a `image(assetId) / status / onChange` port that `frontend/src/lib/assetProvider.ts` `imageAssets` implements. `renderer.ts` `gpuAvailable()` returns a hard `false` today and `probeContext` always resolves to `"2d"`, so everything runs on Canvas2D.
- The Go headless renderer draws images, but narrowly. `backend/internal/render/raster.go` imports only `image/png` and `image/jpeg`, and `rasterImage` reads a base64 data URL from `node["src"]`, decodes it, and scales it with `xdraw.CatmullRom` under `contain`/`cover`. `backend/internal/httpapi/embed_assets.go` `embedNodeAssets` is what puts the data URL there, base64-inlining each image and pattern fill before export. The Go RASTER path now applies the effect kinds the browser supports (adjustment matrices, blur, glow, outline, duotone) plus blend modes and drop shadows, through isolated-layer compositing (`backend/internal/render/composite.go`, `effects.go`), so an adjusted image no longer exports unadjusted to PNG/JPEG. `svg.go` now emits the full effect chain per node in declared order (blend modes, adjustment color matrices, duotone via component-transfer tables, layer blur, silhouette shadow/glow chains, and the outline stroked after the filter, all pinned to sRGB filter space); `pdf.go` emits opacity and blend modes as `/ExtGState` (`/ca` `/CA` `/BM`), paints linear/radial gradients as real axial/radial shadings, and reproduces shadows/glow/blur/adjustments/duotone as embedded raster layers rendered by this same compositing code (`pdffx.go`; text subtrees stay vector so tagged-PDF extraction survives, and conic gradients still degrade to their first stop). This spec inherits a working raster effect pipeline and extends it to painted pixels rather than building it.

What does not exist, at all: a brush engine (stamps, spacing, flow, hardness, tip shapes, textures, presets, stabilization), a paintable pixel layer of any kind, pixel selections (marquee/lasso/polygonal/wand/colour-range/quick-mask), layer masks, adjustment layers that affect other nodes, curves/levels/channels, sharpen/noise/distort/stylize, liquify or any mesh/pin/perspective warp, heal/clone/patch, PSD or TIFF import or export, 16-bit or float precision, tilt or velocity dynamics, stroke prediction, and any GPU path.

Status legend: **Built** (ships today, code-referenced), **Partial** (some of it ships, gaps noted), **Planned (doc 40)** / **Planned (doc 44)** / **Planned (doc 23)** (depends on the sibling spec named), **Not started**.

## Sequencing

**F38 (accessibility, i18n, security, compliance, self-host, NFR) precedes this spec.** That ordering was set in August 2026 on adoption evidence: internationalisation and accessibility show more evidence of blocking adoption than creative depth does, and both are axes a desktop-native incumbent cannot follow the product onto. The reasoning is recorded in `README.md` under "Why F38 precedes the creation-depth set" and in F38's own Priority section.

This does not reduce the value of the work below; it places it second, and it means the parts worth pulling forward early are the ones that serve the existing audience. For raster that is AI-assisted work (background removal, object erase, image-to-editable-layers) plus basic adjustments, which is where the demand actually sits; the brush engine, pixel selections, and liquify serve a different audience and compete with free incumbents.

## 1. Context and Goal

A design platform that cannot paint is a layout tool. Professional imaging splits into two markets that both sit outside HyCanvas today: digital painting and illustration (brush engines, pressure and tilt, custom tips, canvas rotation, stabilization) and photo work (selections, masks, adjustment layers, retouching, warp). The tools that own those markets are desktop-first, mostly closed, mostly per-seat, and none of them are a collaborative web canvas that a team can self-host. Meanwhile the tools that own the collaborative web canvas cannot paint a stroke. The opening is the intersection: pixel work that is native to the same document as the vector work, editable by the same collaborators, exportable through the same open format, and running on the buyer's own hardware.

The structural advantage HyCanvas brings is the same one that made the whiteboard and presentation work possible: the file format is open, additive, and forward-migrated, and the engine is framework-agnostic and already renders headless in Go. A painted layer that lands as a described, versioned, addressable object in `@hc/schema` is a painted layer that exports, branches, restores, and round-trips, instead of a flattened dead end.

The structural risk is equally specific. Pixels are large and CRDTs are not built for large. `packages/realtime/src/reconcile.ts` projects the whole `DesignFile` out of the Y.Doc on every remote update (`fromDoc`, page-granular reuse aside), and `reconcilePlainArray` delete-and-reinserts an entire non-keyed array on any edit. A single 4096x4096 RGBA layer is 64 MB uncompressed. Putting even a compressed version of that inside the document would destroy sync latency, blow up every snapshot in `design_snapshots`, make the update log unusable, and make offline IndexedDB storage untenable. Every design decision below is downstream of the rule that the document describes pixels and never carries them.

Intended outcome: an illustrator opens a document, creates a paint layer at a chosen resolution, draws with a pressure- and tilt-responsive textured brush at a stroke latency they do not notice, masks a photograph with a wand selection refined by feather and grow, stacks a curves and a hue/saturation adjustment above it as live F40 operations, liquifies a shape with a pin warp, heals a blemish, and exports a print-resolution PNG from the Go binary that matches the screen. A collaborator paints on a different layer at the same time and neither loses a stroke. A self-hoster's Postgres never sees a pixel, and rolling the binary back one version still opens the file.

## 2. Scope

In scope:
- The brush engine: a stamp-and-spacing stroke model, pressure/tilt/velocity dynamics mapped to size/opacity/flow/angle/scatter, hardness and falloff, per-brush blend modes, custom tips (bitmap and procedural), grain/texture, brush presets and a preset library, and input smoothing/stabilization with a pull-string and an average-of-N mode.
- Stylus and tablet input depth: pressure curves, tilt and twist, velocity, coalesced-event capture, predicted-event stroke extension, palm rejection, per-device pressure calibration, and eraser-end detection.
- The paint layer itself: a tiled, content-addressed pixel buffer that is a first-class node in the open file format, with the storage, GC, offline, version-history, branching, and realtime story that entails (section 7 is the core of this document).
- Pixel selection: rectangular and elliptical marquee, freehand lasso, polygonal lasso, magic wand (contiguous and global, tolerance and anti-alias), colour range, quick-mask painting, plus select-subject via the AI layer, and the selection algebra (add/subtract/intersect, feather, grow, shrink, border, invert, transform selection).
- Masking: non-destructive raster layer masks (8-bit alpha, tiled like pixels), vector masks derived from existing `PathNode`/`BooleanNode` geometry, clipping masks, and mask-from-selection / selection-from-mask.
- Adjustment layers and filters as live parameterized operations: levels, curves, hue/saturation/lightness, colour balance, black and white, channel mixer, selective colour, exposure, threshold, posterize, gradient map; the blur family (gaussian, box, motion, radial, lens, surface); sharpen (unsharp mask, smart sharpen, high pass); noise (add, reduce, median, despeckle); distort (wave, ripple, spherize, pinch, polar); stylize (find edges, emboss, oil, halftone, glow). Every one of these is registered as an F40 operator, not as a new `Effect` kind.
- Warp and liquify: a mesh warp over a control lattice, puppet-style pin warp, perspective warp, and the liquify brush family (push, twirl, pucker, bloat, freeze/thaw, reconstruct), all stored as parameterized deformations rather than baked pixels until explicitly applied.
- Retouching: spot heal, healing brush, clone stamp (aligned and non-aligned, cross-layer, with a source offset preview), patch, red-eye, dodge/burn/sponge, and content-aware fill on a selection.
- Resolution and precision: per-layer authoring resolution, a documented account of where resolution independence stops, a vector-backed re-render mode for stroke-only layers, and an honest 8-bit-first precision plan with the 16-bit path scoped.
- The export story: browser rendering on Canvas2D, headless rendering in `backend/internal/render`, and the PSD/TIFF/OpenRaster interop and flattening rules.

Out of scope (owned elsewhere):
- The procedural operation graph, its evaluation order, caching, parameter typing, dependency invalidation, and the non-destructive edit-history model. F40 owns all of it; this spec contributes imaging operators to it and specifies their parameters and UX, nothing more. If this spec ever appears to define a second filter mechanism, that is a bug in this spec.
- The WebGL/WebGPU backend, shader authoring, texture management, and the `gpuAvailable()`/`probeContext` promotion path. F44 owns those. This spec states which features are impractical on Canvas2D and therefore gated on F44 landing.
- The CRDT protocol, presence, locks, offline persistence, branches, and history mechanics. F16 owns those; this spec specifies how a tiled pixel layer behaves inside them.
- The AI provider-adapter layer, key storage, model routing, and quotas (`backend/internal/ai`, `@hc/aistudio`); generative video/audio (F23).
- The base export encoders and the PDF/SVG writers; this spec adds raster compositing inside them.
- Cross-cutting SSO, audit, compliance, and observability (F38).

Deferred (explicitly not in this plan; revisit only with a dedicated spec):
- A history brush (painting a region back to an earlier history state). It needs per-region history snapshots rather than the per-document snapshots that ship, so its cost sits in the history model and not in the brush. The clone stamp (FR-27) covers the common repair case.
- RAW photo processing. Demosaicing, camera-specific colour profiles, lens correction databases, highlight recovery, and a 16/32-bit-float scene-referred pipeline are a product of their own, and every one of them needs precision the 8-bit path in this spec does not have. Deferred until the 16-bit pipeline in section 14 Phase 5 lands and a separate spec covers it.
- The heaviest photo-compositing tail: HDR merge, panorama stitching, focus stacking, frequency separation as a first-class workflow, advanced content-aware fill and scale, perspective crop with automatic vanishing-point detection, and colour-managed soft proofing against printer profiles. Individually reasonable, collectively a second product.
- Animated raster (frame-by-frame animation on paint layers, onion skinning). Interacts with F25/timeline in ways this spec does not model.
- Painting on 3D surfaces, and any texture-authoring workflow tied to the reserved `model3d` node type.

## 3. User Stories

- As an illustrator, I want a brush that responds to pressure, tilt, and speed with a tip I can shape and texture, and a preset I can save and reuse, so the stroke feels like a tool and not like a polyline.
- As an illustrator, I want stabilization so a slow deliberate line does not wobble, and I want the line to appear under the nib rather than lagging behind it.
- As a photo editor, I want to select a subject with a wand or a one-click AI selection, refine the edge with feather and shrink, and turn that selection into a layer mask that I can paint on later, without ever destroying the original pixels.
- As a photo editor, I want curves and hue/saturation as live layers above the image that I can re-open and re-tune a week later, and that affect every layer beneath them.
- As a retoucher, I want spot heal, a clone stamp with a visible source, and a patch tool, working across layers, so I can clean up a photograph without flattening it.
- As a designer, I want to liquify and pin-warp an image and still be able to undo the warp parametrically, and I want the warp to re-evaluate at export resolution rather than at screen resolution.
- As anyone exporting, I want the PNG the Go binary produces at 4x to match what I saw on screen, including every adjustment and mask, or I want the tool to tell me exactly what it could not reproduce.
- As a collaborator, I want to paint on one layer while my colleague paints on another and have both survive, and I want to know when we are about to collide on the same layer.
- As an offline user, I want to paint on a plane, land, and have every stroke sync without a single tile being lost or duplicated.
- As a self-hoster, I want painted documents to grow object storage, which I can size and price, and not to grow Postgres or the realtime update log, which I cannot.
- As an administrator, I want a hostile PSD or a 60000x60000 PNG to be rejected before it allocates memory, and I want painting to respect the storage quotas I already set.
- As a keyboard or screen-reader user, I want every brush and adjustment parameter to be reachable and announced numerically, even where the stroke gesture itself is inherently a pointer act.

## 4. Feature matrix / scope

Status values: **Built**, **Partial**, **Planned (doc 40)**, **Planned (doc 44)**, **Planned (doc 23)**, **Not started**. Priority is given in the Notes as P1 (the layer must exist and be paintable), P2 (professional depth), P3 (leap-ahead).

### Brush engine and stroke pipeline

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Stamp-and-spacing stroke model | Not started | new `@hc/paint` pure core; consumed by `packages/engine` | P1. The heart of the engine: resample the input path to a constant arc-length spacing (as a fraction of tip diameter) and composite one tip stamp per station. `packages/media/src/matte.ts` `brushMatte` is the single-stamp primitive to generalize (it already has radius, hardness, flow). |
| Variable-width ribbon stroke | Built (F30) | `render2d.ts` `drawInk`; `schema.ts` `InkNode` | Vector ribbon with pressure-varied half-width. Stays as-is for whiteboard ink; it is not the raster brush and must not be confused with it. |
| Opacity vs flow vs density | Not started | `@hc/paint` | P1. Opacity caps the whole stroke's contribution (composite the stroke into a scratch buffer, then blend once); flow is per-stamp alpha and accumulates within a stroke. Getting this distinction right is what makes an airbrush feel like an airbrush. |
| Hardness / edge falloff | Partial (core only) | `matte.ts` `BrushStamp.hardness` | P1. The falloff math exists for the matte brush and is unused; lift it into the shared stamp. |
| Pressure dynamics with an editable curve | Partial | `Canvas.tsx` pen `e.pressure` -> `InkNode.points[].p` | P1. Pressure is captured but only maps to ink ribbon width. Needs a per-brush response curve (per target) and per-device calibration. |
| Tilt and twist dynamics | Not started | `Canvas.tsx` (does not read `tiltX`/`tiltY`/`twist`) | P2. Tilt maps to tip angle, elongation, and grain rotation; twist to tip rotation. Requires a tip that has an angle to rotate, so it lands with custom tips. |
| Velocity / speed dynamics | Not started | `@hc/paint`; `InkPoint.t` already carries time | P2. Speed from consecutive timestamps drives size and flow; the timestamp field already exists in the schema. |
| Custom brush tips (bitmap) | Not started | `@hc/paint`; tips stored as assets | P2. A tip is a grayscale asset referenced by id, cached as an `ImageBitmap`, pre-rotated/pre-scaled into a small LRU stamp cache. |
| Procedural tips (round, square, chisel, bristle) | Not started | `@hc/paint` | P2. Analytic tips avoid an asset fetch and cover most of the default set. Bristle/dual-brush is P3. |
| Grain / texture and pattern-stamped strokes | Not started | `@hc/paint` | P2. A tiling grain multiplied into each stamp's alpha, anchored either to the canvas or to the stroke. |
| Scatter, jitter, count | Not started | `@hc/paint` | P2. Seeded from a per-stroke `seed` so a stroke re-renders identically headless (the same determinism contract `InkNode.seed` already establishes). |
| Per-brush blend mode | Partial | `schema.ts` `BlendMode` (16 modes); `render2d.ts` `blendToComposite` | P2. The schema's blend list maps cleanly onto Canvas2D `globalCompositeOperation`. Modes outside that set (linear/vivid/pin light, subtract, divide) need F44. |
| Wet/mixer brushes, colour pickup | Not started | `@hc/paint` | P3, and honestly impractical on Canvas2D at usable sizes: a mixer needs a read-back of the destination per stamp. Gated on F44. |
| Smoothing / stabilization | Partial | `Canvas.tsx` ink decimate+smooth; `editor.ts` `simplifyPolyline`, `fitCubicBeziers` | P1. A post-hoc simplify is not stabilization. Needs live pull-string (a lagging anchor pulled by the cursor) and weighted-average-of-N modes, applied before stamping, with a visible catch-up on stroke end. |
| Brush presets and a preset library | Not started | new `brush_presets` store; `@hc/paint` serialization | P2. Presets are pure data (all brush parameters plus tip/grain asset ids), workspace-scoped, importable/exportable as JSON. No preset is gated. |
| Symmetry / mirror painting, canvas rotation | Not started | `store/editor.ts` viewport; `@hc/paint` | P3. Canvas rotation is a viewport-only change (the existing viewport already has zoom/pan); symmetry replays each stamp through N reflections. |
| Line/shape assist while painting (straight, ellipse, perspective guides) | Not started | `@hc/paint` + editor guides | P3. Shares the existing snapping/guide infrastructure. |

### Stylus, tablet, and input latency

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Pointer pressure capture | Built | `Canvas.tsx` (`e.pointerType === "pen" ? e.pressure : undefined`) | Captured for pen only; mouse/touch leave it unset. |
| Palm rejection | Built (F30) | `Canvas.tsx` (touch ignored while `penDown`) | Works. Extend with an explicit "pen only" painting mode that ignores touch entirely. |
| Pen-vs-finger discrimination | Built (F30) | `Canvas.tsx` pointerType routing | Pen draws, finger pans. |
| Coalesced-event capture | Not started | `Canvas.tsx` (does not call `getCoalescedEvents()`) | P1. Without it the stroke is sampled at frame rate and loses fidelity on fast strokes; this is a small change with a large quality payoff. |
| Predicted-event stroke extension | Not started | `Canvas.tsx` (does not call `getPredictedEvents()`) | P1. Draw the predicted tail in an ephemeral overlay only, never into the committed buffer, so a mispredicted tail is discarded rather than painted. |
| Tilt / twist capture | Not started | `Canvas.tsx` | P2. Needed before tilt dynamics are meaningful. |
| Eraser-end detection | Not started | `Canvas.tsx` (`e.buttons === 32` / `pointerType` eraser) | P2. Flipping the stylus switches to the eraser tool and back. |
| Per-device pressure calibration | Not started | user preferences | P2. A stored response curve per pointer device; some tablets report a very compressed range. |
| Low-latency stroke overlay | Not started | new dedicated overlay canvas above the scene canvas | P1. The in-progress stroke renders to a separate compositor-friendly overlay so it never triggers a scene repaint; it is stamped into the layer once on stroke end. Same architecture as the shipped ephemeral laser/ink trail, applied to the wet stroke. |
| Desynchronized canvas context hint | Not started | `Canvas.tsx` `getContext("2d", { desynchronized: true })` | P1. Measurable latency win on the overlay context specifically. |

### Paint layers, pixel storage, and compositing

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Pixels referenced by id, never embedded | Built | `schema.ts` `ImageSource.assetId`, `AssetRef`; `uploads.Service.store`; `storage.Driver` | The precedent this whole spec extends. |
| Content-addressed blob storage | Built (for snapshots) | `persistence/file.go` `designs/{id}/snapshots/{sha256}.hyc`; `history_updates.go` `blob_url` offload | The tile store in section 7 reuses this exact pattern and driver. |
| Paintable raster layer | Not started | `schema.ts` `ImageNode.raster` (additive, section 7) | P1. The central new capability. |
| Tiled pixel buffer with per-tile content hashes | Not started | `@hc/paint` tiling; `packages/engine/src/tiles.ts` for geometry | P1. Tile geometry math already exists for dirty-rect repaint; reuse the grid convention (256 px default from `EngineConfig.tileSize`). |
| Immutable tiles + manifest rewrite on edit | Not started | section 7 | P1. Never mutate a tile in place. Undo, history, branching, and dedupe all fall out of immutability for free. |
| Tile garbage collection | Not started | new sweep job in `backend/internal/persistence` | P1 and safety-critical. A tile is only deletable when no live snapshot, checkpoint, branch head, or trashed-but-restorable design references it. Section 11. |
| Flattened composite proxy per layer | Not started | `ImageNode.source` reused as the proxy | P1. Keeps older clients rendering, keeps the Go export path working from day one, and keeps thumbnails cheap. |
| Layer blend modes and per-layer opacity | Built | `NodeBase.blendMode`, `NodeBase.opacity`; `render2d.ts` `blendToComposite` | Already correct for raster layers; no new mechanism. |
| Layer groups with isolated blending | Partial | `group`/`frame` nodes render children | Group-level blend isolation and pass-through semantics are not modelled. P2. |
| Clipping masks | Partial | `MaskNode`, `FrameNode` clip, `ClipPath` | Vector clipping exists in several forms. A "clip to layer below" convention over the existing structures is P2. |
| 16-bit / float precision | Not started | n/a | P3 and gated on F44. Canvas2D is 8-bit per channel; a 16-bit pipeline needs its own buffers and its own compositor. Called out honestly in section 18. |

### Pixel selection and masking

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Marquee (rect/ellipse) selection of pixels | Not started | new `@hc/paint` selection core | P1. Note the existing marquee in `Canvas.tsx` selects nodes, not pixels; these are different objects and must not share a tool slot without a mode. |
| Freehand and polygonal lasso | Not started | `@hc/paint` | P1. Rasterize the closed polygon to the selection alpha buffer with anti-aliased coverage. |
| Magic wand (contiguous + global, tolerance) | Not started | `@hc/paint` | P1. Scanline flood fill over the composited or per-layer pixels with a tolerance metric in a perceptual space (`@hc/color` already exists for the conversion). |
| Colour range selection | Not started | `@hc/paint` + `@hc/color` | P2. Global selection by colour distance with a live preview matte. |
| Quick mask (paint the selection) | Not started | `@hc/paint`; `matte.ts` `brushMatte` | P1. The selection alpha buffer is exactly a matte, and the brush primitive for it is already written. |
| Feather / grow / shrink / border | Partial (core only) | `matte.ts` `featherMatte`, `growMatte`, `shrinkMatte`, `refineMatte` | P1. Implemented and unused. Border is a grow minus a shrink. |
| Selection algebra (add/subtract/intersect/invert) | Not started | `@hc/paint` | P1. Per-pixel max/min/complement over 8-bit alpha. |
| Select subject / select sky (AI) | Partial | `imageFilters.ts` `removeBackground` (`@imgly/background-removal`) | P2. The model already ships and already runs in-browser; today its output replaces the image destructively. Redirect it to produce a selection or a mask. Section 9. |
| Non-destructive raster layer masks | Not started | `ImageNode.mask` (additive, section 7) | P1. Same tiled, content-addressed storage as pixels, one channel instead of four. |
| Vector masks from paths | Partial | `PathNode`, `BooleanNode`, `MaskNode`, `ClipPath` | P2. The geometry exists; what is missing is attaching it to a node as a mask channel rather than as a wrapper node. |
| Mask from selection / selection from mask | Not started | `@hc/paint` | P1. A one-step conversion in both directions. |
| Refine edge (decontaminate, smart radius) | Partial (core only) | `matte.ts` `refineMatte` | P2. Shrink/feather/grow exist; colour decontamination does not. |

### Adjustments and filters (operators contributed to F40)

Every row here is an operator registered with the F40 procedural graph. None of them adds a new `Effect` kind to `packages/schema/src/schema.ts`. The existing `{ kind: "adjustment"; ops }` effect stays exactly as it is, forever, as the compatibility path for files written before F40, and F40 owns the mapping from it to the graph.

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Named filter presets and intensity blending | Built | `frontend/src/lib/imageFilters.ts` `FILTER_PRESETS`, `resolvePresetOps` | Eleven presets plus a neutral-blend intensity model. Keep; re-express as F40 operator presets. |
| Auto-enhance | Built | `imageFilters.ts` `autoEnhanceOps` | Fixed bundle. Add a histogram-driven version in P2. |
| Brightness/contrast/saturation/hue/sepia/grayscale | Built (display-only) | `engine/effects.ts` `adjustmentOpToFilters`, `effectsFilter` | Rendered via `ctx.filter`. Not applied at all in the Go export path (`raster.go` ignores `effects`), which is an existing correctness gap this spec must close. |
| Duotone | Built | `engine/duotone.ts` `duotoneCanvas`, `effects.ts` `duotoneLut`/`applyDuotone` | The one real per-pixel LUT effect, with an offscreen cache. The pattern to generalize for LUT-based adjustments. |
| Levels (per channel, input/output, gamma) | Not started | F40 operator | P1. |
| Curves (RGB + per channel, spline) | Not started | F40 operator | P1. The signature non-destructive adjustment; needs a real spline evaluator and a 256-entry LUT per channel. |
| Hue/saturation/lightness with colour-range bands | Not started | F40 operator | P1. |
| Colour balance, exposure, black and white, channel mixer, selective colour, gradient map, threshold, posterize | Not started | F40 operators | P2. All are LUT or small-matrix operations and are cheap on Canvas2D via `ImageData`. |
| Blur family (gaussian, box, motion, radial, lens, surface) | Partial | `Effect { kind: "blur" }` -> CSS `blur()` | P1 for gaussian/box (separable, already have the pattern in `matte.ts` `boxBlur`); motion/radial/lens are P2 and slow on CPU at large radii; surface blur is P3 and wants F44. |
| Sharpen (unsharp mask, smart sharpen, high pass) | Not started | F40 operators | P2. Unsharp mask is a blur plus a weighted difference, so it comes nearly free once the blur operator exists. |
| Noise (add, reduce, median, despeckle, dust and scratches) | Not started | F40 operators | P2. Median at large radii is the expensive one; cap the radius on the CPU path. |
| Distort (wave, ripple, spherize, pinch, polar, displace) | Not started | F40 operators | P2. All are resampling operators sharing one warp-sampling kernel with section "Warp". |
| Stylize (find edges, emboss, oil, halftone, glow, pixelate) | Not started | F40 operators | P3. |
| Adjustment layer affecting the layers beneath it | Not started | F40 graph + a scene-level operator node | P1. This is a graph-topology question (what does "beneath" mean in a scene graph), and it is F40's to answer; this spec supplies the operators and the UX. |
| Live preview at screen resolution, full evaluation at export resolution | Planned (doc 40) | F40 caching | P1. The correctness rule that makes procedural filters worth having; stated here because export parity depends on it. |

### Warp, liquify, and transform

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Affine transform of nodes | Built | `schema.ts` `Transform`; engine + Go renderers | Existing. |
| Mesh warp over a control lattice | Not started | F40 deformation operator + `@hc/geometry` | P2. Store an `n x m` lattice of displacement vectors; evaluate with bicubic interpolation. Small in the document (a 5x5 lattice is 50 numbers). |
| Puppet-style pin warp | Not started | F40 deformation operator | P2. Store pins as `{x, y, dx, dy, weight?}`; evaluate with moving-least-squares or a triangulated mesh. Also small. |
| Perspective warp / free transform with a quad | Not started | F40 deformation operator | P2. A homography from four corner points. |
| Liquify brushes (push, twirl, pucker, bloat, freeze, reconstruct) | Not started | F40 deformation operator with a stored displacement map | P2. The displacement map is itself a two-channel tiled buffer stored exactly like pixels (section 7), so a liquify session is bounded and non-destructive but is not free in storage. Honest note: at full resolution the live preview is CPU-bound on Canvas2D; preview at a reduced-resolution proxy and evaluate at full resolution on commit and on export. |
| Content-aware scale | Not started | n/a | Deferred (section 2). |

### Retouching

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Spot heal | Not started | `@hc/paint` retouch core | P2. Sample an annulus around the target and solve a small Poisson/PDE fill; bounded by the brush size, so it is tractable on CPU. |
| Healing brush (sampled source, texture-preserving) | Not started | `@hc/paint` | P2. Stamp the source with the destination's low-frequency component. |
| Clone stamp (aligned/non-aligned, cross-layer, source preview) | Not started | `@hc/paint` | P1 of the retouch group and the simplest: it is the brush engine with a source offset. |
| Patch | Not started | `@hc/paint` | P2. Selection-driven heal; depends on the selection core. |
| Red eye, dodge/burn/sponge | Not started | `@hc/paint` | P2. Dodge/burn are brush modes over a tonal curve, not new engines. |
| Content-aware fill on a selection | Not started | `@hc/paint` or the AI layer | P3. A patch-match implementation is expensive on CPU; the AI inpaint path (section 9) covers most of the need first. |

### Rendering, export, and interop

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Browser Canvas2D rendering of image nodes | Built | `render2d.ts` `drawImageNode`, `drawMedia`, `AssetProvider` | Existing. |
| Go headless raster export of image nodes | Built (narrow) | `render/raster.go` `rasterImage`; `httpapi/embed_assets.go` `embedNodeAssets` | Decodes PNG and JPEG only; reads a base64 data URL from `node["src"]`; ignores `effects` entirely. |
| Go headless rendering of tiled paint layers | Not started | `render/raster.go` + `storage.Driver` | P1. Must fetch tiles by key through the storage driver, NOT via `embedNodeAssets` base64 inlining: inlining 256 tiles as data URLs would multiply the export payload by ~1.33 and hold the whole layer in memory twice. Section 8. |
| Go headless evaluation of adjustments/filters | Not started | F40 Go evaluator + `render/` | P1 for parity. Today the Go path silently drops every adjustment, so an exported PNG of a filtered photo is already wrong; this must be fixed as part of P1 or the degradation must be reported in the export fidelity report (`@hc/media` `fidelity.ts`). |
| PSD import (layers, masks, groups, blend modes) | Not started | new `@hc/psd` parser | P2. Raster layers, layer masks, group nesting, blend modes, and opacity map cleanly. Text, layer effects, smart objects, and adjustment layers map partially or flatten, with every gap recorded via `fidelity.ts` `recordUnsupported`. |
| PSD export | Not started | `@hc/psd` writer | P3. Write raster layers, masks, groups, and blend modes; flatten everything else with a report. |
| TIFF import/export | Not started | `@hc/media` + a TIFF codec | P2. Multi-page, alpha, and 16-bit-to-8-bit downconversion with a warning. Note `sniff.ts` already recognizes TIFF magic bytes while `raster.go` cannot decode it. |
| OpenRaster (.ora) import/export | Not started | `@hc/paint` | P2 and a genuine differentiator: an open, zip-based layered raster format that we can round-trip losslessly, matching the open-format positioning better than PSD does. |
| Flattened PNG/JPEG/WebP export | Built | `@hc/export` + `render/raster.go` | Existing; gains raster layers. |

### Realtime, offline, and history

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| CRDT document sync | Built (F16) | `packages/realtime/src/reconcile.ts`; `backend/internal/realtime` | Existing. Paint must ride it without flooding it. |
| Ephemeral in-flight stroke over presence | Not started | `frontend/src/lib/realtime.ts` frame union; `realtime/presence.go` | P1. Same model as the shipped laser/ephemeral-ink trail: the wet stroke is presence, the committed tiles are document. |
| Manifest-only CRDT writes | Not started | section 7 | P1. One stroke end = one small map write per touched tile cell. |
| Per-tile merge on concurrent paint | Not started | section 7, section 8 | P1. Different tiles merge cleanly; the same tile is last-writer-wins and is the honest limitation of this design. |
| Offline painting with a tile outbox | Not started | IndexedDB outbox + upload drain | P1. Tiles are written locally first; the manifest edit is immediate; uploads drain on reconnect. |
| Version history and restore with tiles | Not started | `persistence` snapshots + GC | P1. A snapshot is a manifest, so restore is O(manifest) and shares unchanged tiles. |
| Branching with tiles | Not started | `persistence/branches_crdt.go` + GC roots | P1. Branches share tiles by hash; the GC must treat every branch head as a root. |

### Accessibility, security, performance

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Magic-byte sniffing and upload acceptance | Built | `@hc/media` `sniff.ts` `sniffType`/`acceptUpload`; `uploads.go` `requireImage` | Type is validated by content, never by extension. |
| Per-workspace and per-user storage quotas | Built | `uploads.go` `quotaBytes`/`userQuotaBytes`; `@hc/media` `quota.ts` | Tiles must count against these, and painting must fail soft. |
| Decode-bomb defence (pixel-count ceiling) | Not started | `uploads.go`, `@hc/paint` decode path | P1. Dimensions must be read from the header and checked before any full decode allocates. |
| Dirty-rect tiled repaint | Built | `packages/engine/src/tiles.ts`; `EngineConfig.tileSize` | Existing and directly reusable. |
| Memory ceiling and tile eviction | Not started | `@hc/paint` tile cache | P1. A bounded decoded-tile LRU with an explicit budget, evicting to the blob store. |
| Keyboard/screen-reader parity for parameters | Partial | `@hc/a11y`; existing panels | P1 for the panels; the stroke gesture itself is honestly pointer-first (section 12). |
| GPU acceleration | Planned (doc 44) | `renderer.ts` `gpuAvailable()` returns `false` | Several features are gated on this; section 10 names them. |

## 5. UX and interaction behavior

- Entering paint. A raster layer is created explicitly ("New paint layer") or implicitly by choosing a brush with a photo selected, which offers to add a paint layer above it rather than painting into the photo. Painting never modifies imported pixels in place unless the user explicitly rasterizes. The layer's authoring resolution is chosen at creation (default: the page size at the document `dpi`, clamped to the section 10 ceiling) and shown in the layer's properties, because it is the number that determines whether a later export is sharp.
- The wet stroke. Pressing the pen down starts a stroke on a dedicated overlay canvas above the scene canvas, created with `{ desynchronized: true }`. Coalesced points are consumed each frame so fast strokes keep their fidelity; predicted points extend the visible tail but are never committed. The stabilizer lags the stamped position behind the raw cursor by a configurable amount, and on pointer-up the stroke catches up to the true final position before committing. On stroke end the overlay's affected region is stamped into the layer's tiles, new tile hashes are computed, the manifest entries for exactly the touched cells are rewritten, and the overlay clears. One stroke is one undo step and one CRDT write.
- Brush controls. A brush bar exposes size, opacity, flow, hardness, spacing, and smoothing with both a slider and a numeric field; bracket keys change size, shift-brackets change hardness, number keys set opacity. A brush editor exposes the dynamics matrix (source: pressure, tilt, velocity, random, direction; target: size, opacity, flow, angle, roundness, scatter, grain) with a per-cell response curve. Presets are saved from the current state, named, tagged, and reorderable; a preset is data, so it exports and imports as JSON.
- Selection. Selection tools share a mode row (new, add, subtract, intersect) and a feather field. An active selection draws as an animated dashed outline derived from the alpha buffer's contour, honoring reduced-motion by falling back to a static outline with a tinted overlay. Quick-mask toggles the selection into a paintable red overlay and back. A selection is a transient editing state: it survives tool changes and undo within a session, is not written into the document, and offers "Save as mask" to persist it. This is a deliberate choice explained in section 7.
- Masks. A mask appears as a thumbnail beside the layer; clicking it targets painting at the mask instead of the pixels, with an unmistakable indicator (the brush cursor turns monochrome and the layer row shows a mask-active badge), because painting on the wrong target is the classic destructive mistake. Alt-click views the mask alone. Masks can be disabled, inverted, and detached without losing the pixels.
- Adjustments. Adjustment layers are inserted from the layers panel and are ordinary F40 operator nodes in the scene; their parameter panel is the F40 parameter UI, not a bespoke one. Re-opening an adjustment restores its exact parameters. A live histogram accompanies levels and curves. Dragging an adjustment above or below other layers changes what it affects, with the affected set outlined on hover.
- Warp and liquify. Entering warp overlays the control lattice, pins, or quad handles on the node; the preview is evaluated on a reduced-resolution proxy while a handle is dragged and at full resolution on release. Liquify opens a modal-free brush mode with push/twirl/pucker/bloat, a freeze brush that paints a protection mask, and a reconstruct brush that eases the displacement field back toward zero. Committing keeps the deformation parametric; an explicit "Apply" bakes it into new tiles and says so.
- Retouching. Clone stamp shows a live source-position crosshair and a ghosted preview of the sampled pixels under the brush. Heal and patch preview their result before release. All three obey the active selection.
- Degradation and honesty in the UI. When the document exceeds the section 10 memory ceiling, the editor tells the user which layers were proxied rather than silently blurring. When a filter cannot be evaluated headlessly, the export dialog lists it in the fidelity report rather than exporting something different from the screen. When a tile upload is pending, the layer shows a small sync indicator and the document refuses to be marked "saved" until the outbox drains.

## 6. Functional requirements

Grouped by theme; these FR ids are the durable contract referenced by the acceptance criteria.

Brush engine:
- FR-1: Strokes are rendered by a stamp-and-spacing model: the input path is resampled to a constant arc-length interval expressed as a fraction of tip diameter, and one tip stamp is composited per station, so spacing, not sample rate, determines stroke appearance.
- FR-2: Opacity and flow are distinct. Flow is per-stamp alpha and accumulates within a stroke; opacity bounds the entire stroke's contribution by compositing the stroke into a scratch buffer and blending it once into the layer.
- FR-3: A brush defines hardness/falloff, spacing, roundness, angle, scatter, count, and a per-brush blend mode drawn from the existing `BlendMode` union.
- FR-4: Dynamics map any of {pressure, tilt, twist, velocity, direction, random} to any of {size, opacity, flow, angle, roundness, scatter, grain offset} through an editable response curve per pair; randomness is seeded per stroke so the stroke re-renders identically in the browser and headless.
- FR-5: Brush tips may be procedural (round, square, chisel) or a bitmap asset referenced by id; a grain/texture asset may modulate stamp alpha, anchored to either the canvas or the stroke.
- FR-6: Brush presets serialize every brush parameter plus tip/grain asset ids, are stored per workspace, and import/export as plain JSON. No preset, tip, or texture is gated behind a tier.
- FR-7: Input stabilization offers a pull-string mode and a weighted-average-of-N mode, applied before stamping, with a deterministic catch-up on stroke end so the stroke terminates at the true final cursor position.

Input and latency:
- FR-8: Pointer input consumes `getCoalescedEvents()` for stroke fidelity and `getPredictedEvents()` for the visible tail; predicted points render only in the ephemeral overlay and are never committed to the layer.
- FR-9: Pressure, tilt (`tiltX`/`tiltY`), and twist are captured where the device reports them, normalized, and passed through a per-device calibration curve stored in user preferences.
- FR-10: Palm rejection and pen-vs-finger routing (already shipping for whiteboard ink) apply to painting, plus an explicit pen-only mode and stylus eraser-end detection.
- FR-11: The in-progress stroke renders to a dedicated overlay canvas requested with `{ desynchronized: true }`, so a stroke never triggers a scene-graph repaint.

Pixel storage (see section 7 for shapes):
- FR-12: A paint layer's pixels are stored as immutable, fixed-size, content-addressed tiles in object storage through the existing `storage.Driver`; the open file format carries only a manifest of `{cell, hash}` references plus layer metadata. No pixel payload ever enters `DesignFile`, the Y.Doc, the update log, or a Postgres row.
- FR-13: Editing a region rewrites only the manifest entries for the tiles it touched; tiles themselves are never mutated in place.
- FR-14: A paint layer additionally references a flattened composite asset (the proxy) so that an older client, the Go export path, thumbnails, and any consumer that does not understand tiles still render the layer correctly.
- FR-15: Tile blobs are reference-counted against every live root (current snapshot, every historical snapshot, every update-log checkpoint, every branch head, every trashed-but-restorable design) and are deleted only by an offline sweep that finds zero roots. No request handler ever deletes a tile.
- FR-16: Tile keys are namespaced per design and per workspace, and the server recomputes the content hash on write; a client-supplied hash is never trusted for addressing or for authorization.
- FR-17: Tile bytes count against the existing per-workspace and per-user storage quotas; exceeding a quota fails the upload with an RFC 7807 problem+json and leaves the local stroke intact and retryable, never silently discarded.

Selection and masking:
- FR-18: Pixel selections are an 8-bit alpha buffer supporting rectangular/elliptical marquee, freehand lasso, polygonal lasso, contiguous and global magic wand with tolerance and anti-aliasing, colour range, and quick-mask painting.
- FR-19: Selections support add/subtract/intersect/invert algebra plus feather, grow, shrink, border, and transform-selection, reusing `@hc/media` `matte.ts` (`growMatte`, `shrinkMatte`, `featherMatte`, `refineMatte`) as the shared pure core.
- FR-20: A selection is session state, not document state; it is never written into `DesignFile`. Promoting a selection to a layer mask persists it as a tiled single-channel buffer under the same storage rules as pixels (FR-12).
- FR-21: A node may carry a non-destructive raster mask and/or a vector mask; masks can be disabled, inverted, detached, and converted to and from selections without altering the underlying pixels.

Adjustments, filters, and warp:
- FR-22: Every adjustment and filter is a parameterized F40 operator evaluated procedurally at render time. This spec adds no new `Effect` kind to `packages/schema/src/schema.ts`, and the existing `{ kind: "adjustment" }`, `{ kind: "blur" }`, and `{ kind: "duotone" }` effects continue to render exactly as they do today for files that already use them.
- FR-23: The operator set covers levels, curves (RGB and per channel), hue/saturation/lightness, colour balance, exposure, black and white, channel mixer, selective colour, gradient map, threshold, posterize; blur (gaussian, box, motion, radial, lens); sharpen (unsharp mask, smart sharpen, high pass); noise (add, reduce, median, despeckle); distort (wave, ripple, spherize, pinch, polar, displace); and stylize (find edges, emboss, oil, halftone, glow, pixelate).
- FR-24: An adjustment operator may be scoped to one node or applied as a layer affecting everything beneath it in the scene, and may itself carry a mask (FR-21) restricting where it applies.
- FR-25: Warp deformations (mesh lattice, pins, perspective quad) and liquify displacement are stored as parameters, not baked pixels, and are re-evaluated at the output resolution; an explicit Apply bakes them to new tiles and records that it did.
- FR-26: Filters and warps preview at screen resolution and evaluate at export resolution; a preview must never be what gets exported.

Retouching:
- FR-27: Clone stamp supports aligned and non-aligned sampling, a cross-layer source (including "all layers"), a visible source crosshair, and a ghosted preview under the cursor.
- FR-28: Spot heal, healing brush, and patch reconstruct the target from surrounding or sampled pixels while preserving destination luminance structure, and all three obey the active selection and the active mask.
- FR-29: Dodge, burn, and sponge operate as tonal brush modes with shadow/midtone/highlight ranges.

Resolution and precision:
- FR-30: A paint layer declares its pixel dimensions and its pixel density; the document reports effective PPI at the current placement using the existing `packages/engine/src/image.ts` `computeEffectivePpi`/`isLowResolution`, and warns before an export that would upsample a raster layer beyond its native resolution.
- FR-31: A stroke-only paint layer may opt into keeping a bounded stroke journal (the vector stroke record) alongside its tiles, enabling a true re-render at a different resolution. When the journal budget is exceeded, or when external pixels (an import, a generative fill, a paste, a bake) enter the layer, the journal is closed, the layer becomes resolution-fixed, and the UI says so.
- FR-32: The pipeline is 8-bit per channel in sRGB in Phase 1 to Phase 4. Any wider-precision path is gated on F44 and is out of scope here; the document must not claim precision it does not have.

Realtime and offline:
- FR-33: The in-progress stroke is broadcast as throttled, ephemeral presence frames (never persisted, aged out like the existing laser/ink trail), and the committed result is a single manifest update on stroke end.
- FR-34: Concurrent paints on different tiles of the same layer merge without loss. Concurrent paints on the same tile resolve last-writer-wins at tile granularity; the editor warns when a peer is painting inside the same layer, and an optional per-layer soft lock (reusing the F16 lock/heartbeat mechanism) prevents the collision outright.
- FR-35: Painting offline writes tiles to a local outbox first, commits the manifest immediately, and drains the outbox on reconnect. A manifest hash whose tile has not yet arrived renders as the last known content or a pending indicator, never as a hole and never as a dropped reference.

Export and interop:
- FR-36: Paint layers, masks, adjustments, and warps render in the Go headless export path (`backend/internal/render`) at any requested scale. Where an operator has no Go implementation, the export must fall back to the flattened proxy and record the substitution in the fidelity report (`@hc/media` `fidelity.ts`), never silently omit it.
- FR-37: The Go export path fetches tiles by key through `storage.Driver` rather than by base64 data-URL inlining, and decodes at most a bounded working set of tiles at a time.
- FR-38: PSD and TIFF import produce native `@hc/schema` nodes: raster layers become paint layers, layer masks become masks, groups become groups, blend modes and opacity map directly; unsupported constructs flatten with an explicit per-item fidelity report. OpenRaster imports and exports losslessly for the layer/mask/blend subset it defines.

Accessibility and security:
- FR-39: Every brush, selection, adjustment, and warp parameter is reachable by keyboard, editable numerically, and announced with its value and unit; the tool palette is a proper keyboard-navigable toolbar with documented shortcuts.
- FR-40: Image decoding is bounded before allocation: header-derived pixel count, dimensions, and layer count are checked against explicit ceilings, and a file exceeding them is rejected with a problem+json rather than decoded. This applies to uploads, to PSD/TIFF parsing, and to tile decode.

## 7. Data model / schema changes

Schema version numbers below are PROVISIONAL. They were written when each spec expected to be the next bump, and several specs claimed the same number. The allocation table in the roadmap README is authoritative: claim the next free number there when this work actually starts, then correct the numbers here. F38 shipped v18, so every number in this document is at least one low.


This section is the core of the spec. It answers where painted pixels live.

### 7.1 The constraint

`DesignFile` is the CRDT document. It is reconciled into a Y.Doc by `packages/realtime/src/reconcile.ts`, projected back out by `fromDoc` on every remote update, journaled into `design_update_logs`, snapshotted into content-addressed `.hyc` blobs by `backend/internal/persistence/file.go`, mirrored into IndexedDB for offline, and folded server-side by `backend/internal/crdt`. Anything placed in `DesignFile` is paid for in all six places, repeatedly. A 4096x4096 RGBA layer is 64 MB raw; PNG-compressed artwork typically lands in the 4 to 20 MB range. Base64 in a JSON document adds a further third. Therefore: no pixel payload may enter `DesignFile`.

Note that the shipped background-removal path already violates this in miniature. `PropertiesPanel.tsx` `runBgRemoval` calls `setImageSource(id, dataUrl)`, which pushes `AssetRef { url: "data:image/png;base64,..." }` into `doc.assets`. That is a real bug for large images and section 14 Phase 1 fixes it by uploading the cutout and referencing it by asset id, which is also the migration rehearsal for everything below.

### 7.2 The design: content-addressed tiles, manifest in the document

Painted pixels are stored as immutable tiles in object storage, addressed by the SHA-256 of their bytes, and the document carries only the manifest.

- Tile geometry: a fixed grid in layer pixel space, default 256x256 (matching `EngineConfig.tileSize`, so the paint tile grid and the engine's dirty-repaint grid can be kept in step). Tile size is recorded per layer so it can change later without breaking old files.
- Tile encoding: PNG for the lossless default (already decodable by both `image/png` in Go and the browser, so no new codec is needed on either side), with a raw-RGBA-plus-deflate alternative reserved for the tile formats a future GPU path prefers. Fully transparent tiles are not stored at all; their absence from the manifest means "empty".
- Tile key: `designs/{designId}/tiles/{sha256}.png`, written through the existing `storage.Driver` (local filesystem or S3/MinIO). This is deliberately the same shape as `designs/{designID}/snapshots/{checksum}.hyc` in `persistence/file.go`, so self-hosters see one storage layout and one backup story.
- Immutability: a tile is never rewritten. Painting produces new bytes for the touched cells, which get new hashes, and the manifest entries for exactly those cells are updated. Undo restores the previous manifest entries, whose tiles still exist. Two layers, two documents, two branches, or two versions that share identical content share one blob automatically.
- Manifest size: one entry is a cell coordinate plus a hash. Stored as a compact record it is roughly 40 bytes. A 4096x4096 layer is 256 tiles, so ~10 KB of manifest for a layer whose pixels are megabytes. A 16384x16384 layer is 4096 tiles, ~160 KB, which is the practical ceiling this design is comfortable with and is a component of the section 10 limits.

### 7.3 Where it attaches in the schema: extend `ImageNode`, do not mint a new node type

The obvious move is a new `raster` node type. The safer move, and the one this spec commits to, is an additive optional field on the existing `ImageNode`.

Rationale, in zero-data-loss terms. A new node type is preserved by an older client through `UnknownNode.raw`, but it is not rendered by one: `packages/engine/src/render2d.ts` has no case for it and `backend/internal/render/raster.go` would fall through to `placeholderBox`. During any mixed-version rollout, and after any rollback to the previous binary, every painted layer would go blank. Attaching to `ImageNode` avoids that entirely: an older client sees a perfectly ordinary image node with a real `source.assetId` (the flattened proxy) and renders it correctly. It simply cannot edit the pixels, which is the correct degradation.

```ts
// Additive optional field on the existing ImageNode. An older client ignores
// `raster` and renders `source` (the flattened proxy) exactly as it renders any
// other image, so a mixed-version rollout and a binary rollback are both safe.
interface RasterLayer {
  /** Pixel dimensions of the authored buffer (independent of node size). */
  pixelWidth: number;
  pixelHeight: number;
  /** Tile edge length in layer pixels (default 256). */
  tileSize: number;
  /** Non-empty tiles only. Absent cell = fully transparent. */
  tiles: { c: number; r: number; h: string }[];
  /** Pixels per inch the layer was authored at; drives the FR-30 warning. */
  ppi?: number;
  /** 8-bit sRGB is the only value in Phase 1 to 4 (FR-32). */
  precision?: "u8";
  /** Optional bounded vector stroke record enabling a true re-render at another
   *  resolution (FR-31). Closed (and cleared) as soon as external pixels land. */
  journal?: { assetId: string; bytes: number; closed: boolean };
  /** Set when the last write happened offline and tiles may still be draining. */
  pendingTiles?: number;
}

interface RasterMask {
  pixelWidth: number;
  pixelHeight: number;
  tileSize: number;
  /** Single-channel (8-bit alpha) tiles, same storage rules as pixels. */
  tiles: { c: number; r: number; h: string }[];
  enabled: boolean;
  inverted?: boolean;
}

interface ImageNode extends NodeBase {
  // ...existing fields unchanged...
  /** Present when this image is a paintable layer. `source` remains the
   *  flattened proxy and stays authoritative for any reader that ignores this. */
  raster?: RasterLayer;
  /** Non-destructive mask. Applies to any node that can carry one, so this is
   *  lifted to NodeBase rather than left image-specific (see below). */
  mask?: RasterMask;
}
```

`mask` is added to `NodeBase` (alongside the existing optional `altText`, `decorative`, `aspectLocked`, `data`) rather than to `ImageNode` alone, because a mask is meaningful on a shape, a group, a text node, and an adjustment layer too. It is optional, so the change is additive for every node type at once. A vector mask reuses the existing geometry rather than inventing new shapes: an optional `vectorMask?: { pathNodeId: string; inverted?: boolean }` on `NodeBase` points at an existing `PathNode`/`BooleanNode` in the document.

Deformations (mesh, pins, perspective, liquify displacement) are **not** defined here. They are F40 operator parameters and live wherever F40 puts operator state. The only imaging-specific note is that a liquify displacement map, being a two-channel raster buffer, uses the same tile storage as pixels (FR-12), so F40's operator parameter is a tile manifest reference rather than an inline buffer.

Adjustment layers are likewise not new node types in this spec. They are F40 operator nodes. If F40 concludes it needs a scene-level node type to place an operator in z-order, F40 defines it and this spec supplies the operator list.

### 7.4 Why selections are not in the document

A pixel selection is a full-resolution alpha buffer. Persisting it would double a layer's storage for something the user discards seconds later, and every selection tweak would be a document write and a CRDT broadcast. Selections are therefore session state (in-memory buffer plus a compact serializable description for the parametric cases: a rect, a polygon, a wand seed and tolerance). "Save as mask" is the explicit, one-click path to persistence, and it goes through `RasterMask` under the normal storage rules. This is a deliberate, stated limitation: a selection does not survive a reload, and it is not shared with collaborators.

### 7.5 Migration plan

The schema change is purely additive: optional `ImageNode.raster`, optional `NodeBase.mask`, optional `NodeBase.vectorMask`. No field is renamed, repurposed, or narrowed. Concretely:

1. Add the interfaces and Zod schemas in `packages/schema/src/schema.ts` next to `ImageNodeSchema` and inside `nodeBaseFields`, each `.optional()`.
2. Raise `CURRENT_SCHEMA_VERSION` from 17 to 18 in `packages/schema/src/schema.ts` and append the one-line version-history entry to the doc comment above it (the comment is current through v17 and must stay that way).
3. Raise the Go mirror `currentSchemaVersion` in `backend/internal/persistence/file.go` from 17 to 18 **in the same change**. Skipping this makes `persistence/validate.go` reject every newly written file with a 422 `ErrInvalidFile` and nothing persists; the `UnknownNode` round-trip does not rescue a top-level `schemaVersion` mismatch.
4. Register the v17 to v18 step in `packages/schema/src/migrate.ts`, keyed on the source version. The step is an identity function: a v17 file simply has no `raster`, no `mask`, and no `vectorMask`, and opens unchanged. Registering it anyway keeps the chain contiguous and gives the step a home if a later fix-up is needed.
5. Because the change is additive, no Go migration step is required, matching the precedent set by v15 to v17.

Rollback and mixed-version behavior, stated explicitly because this is where zero-data-loss is won or lost:
- An older client opening a v18 file: `ImageNode` validates (unknown keys are not the discriminator, and the node type is known), `raster`/`mask` are carried through untouched on save, and the node renders from `source`, the flattened proxy. Nothing goes blank and nothing is dropped.
- An older **binary** (Go mirror at 17) receiving a v18 file: `validate.go` rejects with 422 and nothing persists. This is why the deploy order for a rollback is binary-last, and why a rollback plan must be exercised before Phase 2 ships (section 16).
- A newer client opening a v17 file: no `raster` field, so the image is a plain photograph. Choosing a brush offers to add a paint layer above it; nothing is converted implicitly.
- Two clients, one new and one old, editing the same document live: the old client's writes never touch `raster`/`mask` (it does not know them, and the reconciler preserves unknown map keys), and the new client's tile writes are ordinary small map edits the old client relays without understanding. Neither discards the other's data.

### 7.6 Server-side storage and lifecycle

- Tables. One additive table, `design_tiles (design_id, hash, size_bytes, created_at, PRIMARY KEY (design_id, hash))`, recording which tiles a design has ever written, with per-workspace isolation enforced at the query layer like every other service. No `DROP`, no destructive `ALTER`, no backfill.
- Quota. `size_bytes` rolls into the existing per-workspace and per-user accounting that `uploads.go` `quotaBytes`/`userQuotaBytes` and `@hc/media` `quota.ts` already implement.
- Garbage collection. A tile is deletable only when no live root references it. Roots are: the design's current snapshot, every retained historical snapshot, every update-log checkpoint, every branch head (`persistence/branches_crdt.go`), and every trashed-but-restorable design. The sweep runs as a background job through the existing job registry, computes the union of manifests across roots, and deletes only tiles absent from that union and older than a grace window (default 7 days) to cover in-flight offline outboxes. It never runs inline in a request handler. A tile whose root set cannot be computed (a storage read error, a corrupt snapshot) is treated as referenced, always: the sweep fails closed.
- Deduplication. Because tiles are content-addressed, `@hc/media` `dedupe.ts` and `phash.ts` are not needed for exact duplicates; the hash handles them. They remain useful for near-duplicate detection among uploaded photographs, which is a different problem.

## 8. API and realtime

REST under `/api/v1` (chi router). Errors are RFC 7807 problem+json; handlers emit structured JSON logs keyed by design id, workspace id, user id, and request id.

```
POST   /api/v1/designs/{id}/tiles              upload a batch of tiles (body: multipart or length-prefixed
                                               blobs); server hashes each, stores it, returns {hash} per tile.
                                               Idempotent: an already-present hash returns 200 with no write.
GET    /api/v1/designs/{id}/tiles/{hash}       fetch one tile (workspace-authorized; immutable, so
                                               Cache-Control: public, max-age=31536000, immutable)
POST   /api/v1/designs/{id}/tiles/probe        given a list of hashes, return which are already present
                                               (lets a client skip re-uploading shared/undone tiles)
POST   /api/v1/designs/{id}/raster/flatten     regenerate the flattened proxy asset for a layer -> job
POST   /api/v1/designs/{id}/raster/bake        bake a warp/liquify/filter stack into new tiles -> job
POST   /api/v1/imports/psd                     PSD/TIFF/ORA import -> job (202 + job id)
POST   /api/v1/designs/{id}/ai/inpaint         masked generative fill / outpaint -> job
POST   /api/v1/designs/{id}/ai/upscale         upscale a layer or selection -> job
GET    /api/v1/jobs/{id}                       poll long-running work (existing registry)
```

Everything heavy (flatten, bake, import, inpaint, upscale, the GC sweep) goes through the in-process job registry, never inline in a handler, consistent with the existing export and bulk-create paths.

Realtime over `/realtime` (extends F16):
- The wet stroke is presence, not document. A new ephemeral frame `{t:"stroke"}` carries a throttled batch of `{x, y, p?, tilt?, t}` samples plus the brush id and layer id, is aged out exactly like the shipped `{t:"laser"}` trail, and is never journaled. Peers render it on their own overlay canvas so they see the stroke as it happens without a single document write.
- The commit is one CRDT edit. On stroke end the painting client uploads the touched tiles (or skips upload for hashes `probe` says are already present), then writes the manifest entries for those cells in a single Yjs transaction. For a typical 40-pixel brush stroke that is one to four map entries.
- Merge semantics. The manifest is a keyed structure (`reconcileKeyedArray` diffs by id, so manifest entries carry a stable `c,r`-derived id and never trigger the whole-array delete-and-reinsert of `reconcilePlainArray`). Two peers painting different tiles of the same layer therefore produce disjoint key writes and both survive. Two peers painting the **same** tile produce competing values for one key and Yjs resolves last-writer-wins: one peer's strokes on that tile are lost. This is the honest limitation of hash-in-CRDT storage, and this spec mitigates rather than eliminates it: (a) the editor surfaces peer paint activity per layer from presence, (b) an optional per-layer soft lock reuses the shipped F16 lock/heartbeat mechanism to make collision impossible when a team wants that, and (c) the loser's stroke is recoverable from their local undo stack because their pre-write tiles still exist. A true per-pixel merge would require an operational transform over the stroke journal and is listed as an open question in section 18, not promised here.
- Offline. Tiles go to an IndexedDB outbox keyed by hash; the manifest edit commits to the local Y.Doc immediately, so the user sees their work and undo behaves normally. On reconnect the outbox drains through `POST /tiles`, guarded by `probe` so nothing is uploaded twice. Until it drains, `pendingTiles` is non-zero and the UI shows a sync indicator. A peer that receives a manifest hash it cannot fetch renders the layer's proxy for that region and retries; it must never rewrite the manifest to "repair" the missing reference, because that would destroy the absent author's work.

SDK (`@hc/sdk`): typed methods for tile upload/probe/fetch, flatten, bake, PSD import, and the AI imaging endpoints. Pure cores: a new `@hc/paint` (stamp engine, stroke resampling, stabilization, selection algebra, flood fill, retouch kernels, tile encode/decode, ORA read/write) with no React and no DOM dependency, so it runs in the browser, in a worker, and under Node for tests; `@hc/media` gains the decode-bomb ceilings; `@hc/engine` gains tile-manifest compositing behind its existing `AssetProvider` port, extended with a `tile(designId, hash)` accessor so the engine stays free of fetch logic.

## 9. AI hooks

All imaging AI routes through the shipped BYO-key layer (`backend/internal/ai`, `@hc/aistudio`), which already supports image generation (`ai.Image`, `FeatureImage`, per-workspace `image_model`, `ErrImageUnsupported` when a provider cannot do it) and image description (`DescribeImage`, used for alt text). Nothing here egresses pixels to a third party unless the workspace configured a third-party key; a self-hoster pointing at a local endpoint keeps everything on the instance.

- Generative fill / inpaint / outpaint. The active selection becomes the mask, the layer's composited pixels become the reference, and the model's return lands as tiles **on a new layer above** by default, never overwriting the source. Runs as a job (section 8). The result is an ordinary paint layer: paintable, maskable, adjustable, and exportable, not a locked AI object.
- Background removal, redirected. The path already ships (`imageFilters.ts` `removeBackground`, `@imgly/background-removal`, WebGPU-preferred with WASM fallback, dynamically imported so it never bloats the static export). Two changes: its output becomes a `RasterMask` on the existing node instead of a replacement `source`, so the original pixels survive and the cutout is re-editable, and the intermediate no longer travels as a base64 data URL in `DesignFile.assets` (section 7.1).
- Select subject / select sky. The same segmentation model, with the alpha output converted to a pixel selection rather than a mask, so it feeds the whole selection algebra (feather, grow, intersect with a lasso) instead of being a one-shot cutout.
- AI matte refinement. The model's raw alpha is refined through `@hc/media` `matte.ts` `refineMatte` (shrink to kill haloes, feather, grow to recover thin detail) with the parameters exposed, so a poor model result is fixable rather than discarded.
- Upscaling and denoise. Provider-side where the configured model supports it, local-model where one is available, always as a job with a progress-reporting UI, always producing a new layer with the original preserved. Upscaling must update `RasterLayer.pixelWidth/pixelHeight` and `ppi` so the FR-30 resolution warning stays truthful.
- Style transfer and img2img variations. The same generation path with the layer as the reference image; results land as sibling layers so they can be compared and blended.
- Alt text. Painted layers get the same `DescribeImage` treatment `ImageNode.alt`/`altText` already receives, so a painted document is as accessible as an uploaded photograph.
- Prompt-side hygiene. Every AI imaging job reports which model produced it and with what prompt in the layer's metadata (`NodeBase.data`), so a document remains auditable. Generative results are never watermarked and never gated.

Anything requiring video or audio models (animated fills, video inpainting) is F23's, not this spec's.

## 10. Performance and scale

Budgets are the contract; anything not measurable here is not committed.

- Stroke latency. Input-to-photon for the wet stroke: p50 <= 16 ms, p95 <= 33 ms, measured on the reference machine at a 2048x2048 layer, a 64 px brush, and dpr 2, from `pointermove` timestamp to the overlay's next presented frame. This is achievable on Canvas2D only because the wet stroke is on a desynchronized overlay and the scene never repaints during a stroke (FR-11). Commit cost (stamping into tiles, hashing, manifest write) is budgeted separately at <= 50 ms for a stroke touching up to 8 tiles, and runs off the input path.
- Memory ceiling. A hard, configurable decoded-tile budget, default 512 MB across all layers of a document, enforced by an LRU that evicts decoded tiles back to their blobs (they are immutable, so eviction is always safe and re-decode is always correct). Above the budget, off-viewport layers fall back to their flattened proxy at a reduced resolution and the UI names which layers were proxied. The editor must never be killed by the browser for memory; degrading visibly is always preferable.
- Document limits, stated rather than discovered: a single paint layer up to 16384x16384 (4096 tiles, ~160 KB of manifest); up to 64 paint layers per page before the editor warns; a manifest total per document soft-capped so no single `DesignFile` exceeds a few hundred KB of tile references. These are the numbers section 15 tests against.
- Repaint. Scene repaint after a commit touches only the dirty tiles via the existing `packages/engine/src/tiles.ts` grid; a stroke that touched 3 tiles must not repaint the page.
- Filter evaluation. Screen-resolution preview must stay interactive (a parameter drag re-evaluates within 100 ms at viewport resolution) while full-resolution evaluation is deferred to commit and export. This is F40's caching model; the number is this spec's requirement on it.
- Export. Headless render of a document with 16 paint layers at 4x must stream tiles rather than hold the whole set: bounded working set, decode-composite-release, with peak Go heap for the raster path proportional to the output tile band, not to the total pixel count.
- What Canvas2D cannot do, honestly. Gated on F44: wet/mixer brushes and any per-stamp destination read-back; brush sizes beyond roughly 400 px at interactive rates; live full-resolution liquify preview; blend modes outside the `globalCompositeOperation` set (linear light, vivid light, pin light, subtract, divide); real-time full-stack filter preview on layers past ~4096x4096; 16-bit and float precision; and per-pixel operations on very large selections (a wand over a 100 MP composite is seconds, not milliseconds, on CPU). Each of these ships either degraded (reduced-resolution proxy preview, progress indicator) or not at all until F44 lands, and the UI says which.

## 11. Security and threat model

- Untrusted image data and decode bombs. Dimensions and pixel count are read from the file header and checked against ceilings **before** any decode allocates: a hard cap on total pixels (default 100 megapixels), on either dimension (default 30000), on PSD/TIFF layer count, and on compressed-to-decompressed ratio. `@hc/media` `sniff.ts` already validates type by magic bytes rather than extension and `uploads.go` already enforces `requireImage`; the ceilings are the missing half. A file over the ceiling is rejected with problem+json and never partially decoded.
- Parser hardening. PSD, TIFF, and ORA parsers are new attack surface written against hostile input: bounded allocations derived from validated header fields only, no unbounded recursion on nested layer groups, explicit limits on string and channel counts, and a fuzz corpus in CI. They run in the browser or in a job, never with instance privileges.
- Tile addressing and authorization. The server recomputes the SHA-256 of every uploaded tile and uses its own hash as the key; a client-supplied hash is never trusted. Keys are namespaced `designs/{designId}/tiles/{hash}` and every read is authorized against the design's workspace, so content addressing cannot become a cross-workspace existence oracle or a way to read another tenant's pixels by guessing a hash. Per-workspace isolation is enforced at the query layer for `design_tiles`, like every other service.
- Storage exhaustion. Painting is a high-rate blob writer, so it is rate-limited per user and per design, counted against the existing quotas, and fails soft: a quota rejection leaves the stroke in the local outbox and surfaces a quota meter, so the user loses nothing and the operator's disk is protected. The GC grace window bounds how long orphaned tiles occupy space.
- Garbage collection safety. This is the highest-consequence code in the feature: a GC bug deletes user artwork irrecoverably. The sweep is fail-closed (any unreadable root marks everything referenced), runs behind a grace window, is dry-runnable with a report before any destructive mode is enabled, logs every deletion with the roots it checked, and is disabled by default on a fresh instance until an operator opts in.
- AI and data residency. Imaging AI routes through the workspace's own key/endpoint; a self-hoster with a local model sends no pixels anywhere. Prompt and model provenance are recorded on the layer for auditability.
- SSRF. Any URL-sourced image continues through the existing vetted path (`uploads.go` `ImportFromURL`, `vetImportHop`, `getPinned`, `@hc/media` `ssrf.ts`); the tile endpoints accept bytes, never URLs.

### Observability and metrics

Structured JSON logs on every tile, flatten, bake, import, and AI handler, keyed by design/workspace/user/request id, plus counters for tiles written, tiles deduped by `probe`, bytes stored, GC candidates and deletions (with roots examined), outbox drain latency, and quota rejections. Product metrics: stroke latency percentiles sampled client-side, commit duration, proxy-fallback rate (how often the memory ceiling degraded a layer), and export fidelity-report rates per operator (which filters are actually falling back in the Go path).

## 12. Accessibility and i18n

- Parameter parity is non-negotiable and achievable: every brush, selection, mask, adjustment, and warp parameter is a labelled control with a numeric field, a keyboard shortcut path, an announced value with units, and a documented range. No parameter is slider-only.
- The stroke gesture is honestly pointer-first. Painting a freehand line with a keyboard is not a workflow this spec will pretend to deliver. What it does deliver: every non-stroke operation (fill a selection, apply an adjustment, invert a mask, run a filter, transform, bake) is fully keyboard-operable; selections can be created numerically (exact marquee coordinates) and by algebra; and shape-assisted strokes (line, rectangle, ellipse) accept numeric endpoints, so a keyboard user can produce deliberate marks even if they cannot produce a gestural one. This is stated plainly rather than papered over.
- Screen readers. A paint layer exposes a role, a name, its pixel dimensions, its mask state, and its adjustment stack through the `@hc/a11y` layer over the scene graph, in the same way other node types already do. Layer/mask targeting state is announced on change, because painting on the wrong target is the most common destructive error and it is invisible without an announcement.
- Alt text. Painted and generatively filled layers participate in the existing `altText`/`decorative` model and the AI alt-text path, so a painted document is not an accessibility hole in an exported PDF.
- Colour. The colour picker reports numeric values in multiple spaces and never relies on hue alone to convey state; the existing `@hc/color` conversions back it. Selection outlines pair the dashed contour with a fill tint so selection state is not conveyed by a single visual channel.
- Reduced motion. The animated selection outline, brush cursor pulses, and progress shimmers all honor the app-wide reduced-motion preference already shipping under F38, falling back to static equivalents.
- i18n. Every tool, parameter, preset, and filter name is localizable; default brush and filter preset names ship as translatable strings rather than hardcoded English; numeric input honors locale decimal separators; and panels lay out correctly under RTL (the canvas itself is not mirrored, since artwork orientation is content, not chrome).

## 13. Import / export and interop

- PSD import. Parse the layer tree into native nodes: raster layers become paint layers (tiles cut from the decoded layer data), layer masks become `RasterMask`, groups become groups, blend modes and opacity map onto the existing `BlendMode`/`opacity` fields, and layer names and visibility carry over. Text layers become native `TextNode`s where the font resolves and rasterize with a warning where it does not. Layer effects, smart objects, adjustment layers with no equivalent operator, and 16-bit/32-bit documents flatten or downconvert, each recorded through `@hc/media` `fidelity.ts` (`recordUnsupported`, `recordFontSubstitution`, `addWarning`) so the user gets an itemized report rather than a silent surprise. Runs as a job.
- PSD export (later phase). Write raster layers, masks, groups, blend modes, and opacity. Everything procedural (F40 operator stacks, warps, live adjustments) is evaluated and baked into the exported raster layer, because PSD has no representation of our graph; the report says exactly which layers were baked.
- TIFF. Import multi-page and alpha TIFF; downconvert 16-bit to 8-bit with an explicit warning, since FR-32 caps the pipeline at 8-bit. Export flattened or multi-page. Note the current asymmetry to close: `@hc/media` `sniff.ts` recognizes TIFF while `backend/internal/render/raster.go` registers only `image/png` and `image/jpeg`, so anything the Go path must decode needs its codec registered there too.
- OpenRaster (.ora). Read and write losslessly for the subset it defines (layer stack, per-layer PNG, offsets, opacity, blend modes, masks). This is the format that matches the product's open positioning: a zip of PNGs and an XML stack that any tool can read, with no proprietary blob. It is also the cheapest high-fidelity round-trip we can offer, because our tiles are already PNG.
- Flattening rules, applied uniformly across every raster export target:
  1. Evaluate the F40 operator stack at the output resolution (never at preview resolution).
  2. Apply the layer's raster mask, then its vector mask, then layer opacity, then layer blend mode against the accumulated backdrop.
  3. Composite in the document colour space; convert once at the end for the target format.
  4. A layer with no representation in the target format is rasterized to a single layer at output resolution and reported.
  5. Nothing is dropped silently. If it could not be reproduced, it appears in the fidelity report.
- The open format remains the guarantee. A `.hyc` document plus its referenced tiles is a complete, self-describing archive: the manifest names every tile by content hash, so an archive is verifiable, deduplicable, and restorable, and no part of a painted document is locked in a proprietary container.

## 14. Phasing / milestones

Dependency-ordered; each phase is independently shippable and each ends with the document still openable by the previous binary.

Phase 0 (prerequisite hygiene, no schema change):
- Stop `runBgRemoval` from writing a base64 data URL into `DesignFile.assets`; upload the cutout and reference it by asset id. This is a pure bug fix, it removes the one existing pixels-in-document path, and it exercises the upload plumbing the tile store will use.
- Add decode ceilings (pixel count, dimensions, ratio) to the upload and decode paths (FR-40).
- Register the missing image codecs in `backend/internal/render/raster.go` so the Go path decodes what `sniff.ts` accepts.
- Wire `packages/media/src/matte.ts` into the existing background-removal UI as a refine-edge control, proving the pure core in production before the selection engine depends on it.

Phase 1 (the layer exists and is paintable):
- `@hc/paint`: stamp-and-spacing engine, opacity/flow/hardness, procedural tips, stabilization, tile encode/decode.
- Schema v17 to v18: additive `ImageNode.raster`, `NodeBase.mask`, `NodeBase.vectorMask`, Go mirror bump, identity migration step, version-history line.
- Tile store: `POST/GET/probe` endpoints, `design_tiles`, quota accounting, content-addressed keys, workspace authorization.
- Wet-stroke overlay canvas with `desynchronized`, coalesced and predicted events, commit-on-stroke-end.
- Flattened proxy generation, so older clients and the Go export path render paint layers from day one.
- GC in dry-run mode only (report, never delete).

Phase 2 (selection, masks, and collaboration):
- Selection engine: marquee, lasso, polygonal, wand, colour range, quick mask, full algebra, feather/grow/shrink/border on `matte.ts`.
- `RasterMask` end to end: mask from selection, selection from mask, paint on mask, disable/invert/detach.
- Ephemeral `{t:"stroke"}` presence frames; per-tile merge; optional per-layer soft lock; offline tile outbox with `probe`-guarded drain.
- GC enabled with grace window, fail-closed roots, and operator opt-in.
- The rollback rehearsal: prove a v18 document opens, renders, and saves on the previous binary (section 16).

Phase 3 (non-destructive imaging, with F40):
- Contribute the operator set to F40: levels, curves, hue/saturation, colour balance, exposure, black and white, channel mixer, selective colour, gradient map, threshold, posterize; gaussian/box blur; unsharp mask and high pass; add/reduce noise.
- Adjustment layers affecting the layers beneath, with operator masks.
- Go-side evaluation of the operator set so headless export matches the browser, plus the fidelity report for anything that does not.
- Resolution reporting and the FR-30 upsample warning; the FR-31 stroke journal for stroke-only layers.

Phase 4 (retouch, warp, and interop):
- Clone stamp, spot heal, healing brush, patch, red-eye, dodge/burn/sponge.
- Mesh warp, pin warp, perspective warp, and the liquify brush family as F40 deformations with a tiled displacement map.
- Custom bitmap tips, grain/texture, scatter, tilt and velocity dynamics, brush presets and the preset library.
- PSD and TIFF import with fidelity reports; OpenRaster round-trip.
- Motion/radial/lens blur, median/despeckle, distort family.

Phase 5 (the F44-gated leap, not committed until F44 lands):
- GPU compositing of tiles and GPU brush stamping; mixer/wet brushes; large-brush interactivity; live full-resolution liquify.
- Blend modes outside the Canvas2D set; the stylize family at interactive rates.
- The 16-bit precision path, which is also the precondition for ever revisiting RAW.
- PSD export.

## 15. Acceptance criteria

Testable, each traceable to an FR.

- AC-1: A pen stroke produces stamps at a constant arc-length spacing: at 50% spacing on a 40 px tip, a 400 px stroke deposits 20 stamps, verified against a recording canvas, independent of pointer sample rate (FR-1).
- AC-2: With flow 20% and opacity 50%, a stroke that crosses itself darkens at the crossing up to but never beyond 50% coverage; the same stroke at flow 100% reaches 50% immediately and stops (FR-2).
- AC-3: A stroke recorded with pressure, tilt, and velocity re-renders byte-identically from its seed in the browser, in a worker, and in a headless Node test (FR-4).
- AC-4: **Stroke latency.** On the reference machine, at a 2048x2048 layer with a 64 px brush at dpr 2, input-to-photon for the wet stroke is p50 <= 16 ms and p95 <= 33 ms over a 60 second continuous drawing session, and no scene repaint occurs between pointer-down and pointer-up (FR-8, FR-11).
- AC-5: Coalesced events are consumed: a synthesized fast stroke delivering 8 coalesced points per frame produces a stroke whose stamp count matches the coalesced sample count, not the frame count (FR-8).
- AC-6: Painting a 40 px stroke on a 4096x4096 layer produces at most 4 changed tile manifest entries and adds zero pixel bytes to `DesignFile`; the serialized document grows by under 200 bytes (FR-12, FR-13).
- AC-7: **Memory ceiling.** A document with 16 paint layers at 4096x4096 stays within the configured decoded-tile budget (default 512 MB) throughout a scripted pan/zoom/paint session; when the budget would be exceeded, layers fall back to their proxy and the UI names them, and the tab is never terminated for memory (FR-12, section 10).
- AC-8: Undo after a stroke restores the previous manifest entries and the previous pixels exactly, with no tile fetch failure, because the prior tiles still exist (FR-13).
- AC-9: A v18 document with paint layers opens on a client built at v17: every paint layer renders correctly from its flattened proxy, the `raster`/`mask` fields survive a save round-trip untouched, and re-opening on v18 shows the tiles intact (FR-14, section 7.5).
- AC-10: Rolling the Go binary back to the v17 mirror rejects a v18 write with a 422 problem+json and persists nothing, and rolling forward again accepts it; no existing design is altered by either transition (section 7.5).
- AC-11: Two collaborators painting on different tiles of the same layer both keep their strokes after convergence; painting on the same tile resolves last-writer-wins with a warning shown to both, and the losing peer can recover via undo (FR-34).
- AC-12: Painting offline for 5 minutes and reconnecting drains every tile exactly once (verified by `probe` hit counts), converges to the same document on both peers, and loses no stroke (FR-35).
- AC-13: A magic-wand selection with tolerance 30 on a known fixture matches a golden alpha buffer within a 1% pixel tolerance; feather, grow, shrink, invert, and intersect each match their golden (FR-18, FR-19).
- AC-14: Promoting a selection to a mask persists it as tiles, hides the masked region, and painting on the mask reveals it back, with the underlying pixels bit-identical before and after (FR-20, FR-21).
- AC-15: A curves adjustment layer above two image layers alters both, re-opens with its exact control points a session later, and is restricted by its own mask to the masked region only (FR-22, FR-24).
- AC-16: No new `Effect` kind exists in `packages/schema/src/schema.ts` after this feature ships; a pre-existing document using `{ kind: "adjustment" }`, `{ kind: "blur" }`, or `{ kind: "duotone" }` renders pixel-identically to how it renders today (FR-22).
- AC-17: A 4x PNG export from the Go binary of a document containing a paint layer, a mask, a curves adjustment, and a pin warp matches the browser's 4x render within a stated per-pixel tolerance; any operator the Go path cannot evaluate appears by name in the fidelity report and nowhere else (FR-26, FR-36).
- AC-18: The Go export path fetches tiles via `storage.Driver` and never base64-inlines them: exporting a 16384x16384 layer holds a bounded working set and peak heap scales with the output band, not the layer (FR-37).
- AC-19: A layered PSD imports to native nodes with layer masks, groups, blend modes, and opacity preserved, and every unsupported construct is itemized in the fidelity report; an OpenRaster round-trip (export then import) reproduces the layer stack losslessly (FR-38).
- AC-20: A 30000x30000 PNG and a PSD with a hostile layer count are both rejected before decode with problem+json, allocating no proportional memory; the fuzz corpus runs clean in CI (FR-40).
- AC-21: The GC sweep in dry-run mode reports zero deletions for a document referenced by any snapshot, checkpoint, or branch head; in enabled mode it deletes only orphans older than the grace window, and an induced storage read error causes it to delete nothing (FR-15).
- AC-22: Tile bytes count against the workspace and user quota; exceeding it returns problem+json, leaves the stroke in the outbox, surfaces the quota meter, and loses no work (FR-17).
- AC-23: A tile fetch with a valid hash from another workspace's design returns 404/403 and never bytes (FR-16).
- AC-24: Every brush, selection, mask, adjustment, and warp parameter is reachable by keyboard, editable numerically, and announced with value and unit; a screen reader announces mask-vs-pixels targeting on change (FR-39).
- AC-25: A generative fill on a selection lands as a new layer above the source, leaves the source pixels bit-identical, and records model and prompt provenance on the layer; with a self-hosted endpoint configured, no pixel data leaves the instance (section 9).
- AC-26: Upscaling a layer updates `pixelWidth`/`pixelHeight`/`ppi` and the FR-30 export warning reflects the new native resolution (FR-30).
- AC-27: No painting, brush, filter, preset, or interop capability is gated behind a tier, watermarked, or degraded in the self-hosted build.

## 16. Test plan

- Unit (pure cores, no DOM): `@hc/paint` stamp spacing and determinism from seed, opacity-vs-flow accumulation, stabilization convergence, selection algebra and flood fill against golden buffers, tile cut/encode/decode round-trip, manifest diffing (a stroke touches exactly the expected cells), ORA read/write round-trip. `@hc/media` `matte.ts` grow/shrink/feather/refine goldens (currently untested by any consumer). `@hc/schema` v17 to v18 migration: a v17 file opens unchanged, a v18 file round-trips, an unknown-key node survives a save, `CURRENT_SCHEMA_VERSION` and the Go mirror agree.
- Schema-coupling guard: a test that fails if `CURRENT_SCHEMA_VERSION` in `packages/schema/src/schema.ts` and `currentSchemaVersion` in `backend/internal/persistence/file.go` diverge, and one that fails if the version-history comment lacks an entry for the current version.
- Backend (Go): tile upload hashing (server hash wins over any client claim), `probe` correctness, per-workspace authorization on tile GET, quota enforcement and the soft-fail contract, problem+json on every error path, structured-log assertions, job-registry routing for flatten/bake/import/inpaint/upscale, and GC root computation across snapshots, checkpoints, branch heads, and trashed designs, including fail-closed behavior on an induced storage error.
- Render parity: a golden-image suite rendering the same fixture document through `@hc/engine` in a browser and through `backend/internal/render` headless at 1x and 4x, per-pixel diffed with a stated tolerance, covering paint layers, masks, each operator, and each warp; a test that asserts every operator with no Go implementation appears in the fidelity report.
- Realtime and convergence: two-client tile-disjoint paint converges with both strokes; same-tile paint converges to one deterministic value and warns; offline paint for N minutes drains exactly once; a peer receiving an unfetchable hash does not rewrite the manifest.
- Data-loss rehearsal, run against a database seeded with pre-change designs, not fresh ones: open, edit, save, export, and restore an old version of a design created before this feature; then open a post-change painted design on the previous binary and confirm the proxy renders and the fields survive; then roll forward and confirm the tiles are intact. This is the gate for Phase 2 and is not optional.
- Performance: the AC-4 stroke-latency harness (scripted pointer trace, timestamped to presented frame), the AC-7 memory-ceiling soak, commit duration at 1/4/8 touched tiles, repaint-region assertions (a 3-tile stroke repaints 3 tiles), and the AC-18 headless export heap profile.
- Security: decode-bomb fixtures (oversized dimensions, high compression ratio, hostile PSD layer counts), a fuzz corpus for the PSD/TIFF/ORA parsers in CI, cross-workspace tile fetch attempts, and a client-supplied-hash poisoning attempt.
- E2E (compose stack, real browsers, including a pen-capable device): draw, undo, redo, select, mask, adjust, warp, retouch, export, import, and reload; verify the document is marked unsaved while the outbox is draining.
- Manual: an artist runbook (produce a finished illustration end to end) and a retoucher runbook (finish a photograph end to end), each with a written report of where the tool got in the way; plus a self-host smoke test with a local model proving no pixel egress.

## 17. Differentiators

- Pixels and vectors in one document, one format, one collaborative session. Not a raster tool bolted beside a vector tool, and not a vector tool that imports flat images: a paint layer sits in the same scene graph as text, shapes, and connectors, obeys the same transforms and blend modes, and exports through the same pipeline.
- The document never carries pixels, so everything downstream keeps working. Content-addressed tiles mean version history, branching, restore, and dedupe are near-free, snapshots stay small, the update log stays fast, and a self-hoster's Postgres does not grow with artwork. Most collaborative raster tools either bloat their sync layer or give up on real history.
- Non-destructive by construction, and shared with the rest of the product. Every filter and adjustment is an F40 procedural operation, so it re-opens with its parameters, re-evaluates at export resolution, and is the same mechanism the rest of HyCanvas uses. There is no second, weaker effect system for imaging.
- Headless export parity as a hard requirement. A painted document renders from a single Go binary with no browser, no headless Chrome, and no service dependency, and anything that cannot be reproduced is named in a fidelity report rather than silently dropped.
- Open interop that favours open formats. OpenRaster round-trips losslessly; PSD is supported because users need it, not because it is the ideal container. An archive of a `.hyc` plus its content-addressed tiles is fully self-describing and verifiable.
- Free, ungated, self-hostable, and BYO-key for every AI imaging feature. Generative fill, background removal, select-subject, and upscaling run against the workspace's own model endpoint, so a studio's artwork never has to leave its own hardware, and no brush, filter, tip, or preset sits behind a tier.
- Accessibility stated honestly and then delivered where it is deliverable: full keyboard and screen-reader parity for every parameter and every non-stroke operation, numeric selection entry, and announced mask targeting, in a category where the usual answer is nothing at all.

## 18. Open questions and risks

- Same-tile concurrent paint is lossy, and this spec accepts that. Hash-in-CRDT gives clean merges at tile granularity and last-writer-wins within a tile. A true per-pixel merge would need an operational transform over stroke records (replay the loser's strokes onto the winner's tile), which is feasible only while both peers keep a stroke journal and every op in it is replayable. Open question: is a journal-replay reconciliation worth its complexity, or is the per-layer soft lock the right answer for real teams? Decide with usage data after Phase 2; do not build it speculatively.
- Tile size is a guess until measured. 256x256 aligns with the engine's dirty-repaint grid and keeps a manifest small, but a small brush stroke still rewrites a whole 256x256 tile (256 KB decoded), which is wasteful for fine detail work, while a smaller tile multiplies manifest entries and request counts. The field is per-layer precisely so this can change; the first Phase 1 measurement should test 128 and 256 against real strokes.
- GC is the highest-consequence code in the feature. A bug deletes artwork with no recovery. Mitigations are in section 11 (fail-closed, grace window, dry-run first, operator opt-in, deletion logging), but the residual risk is real and the phasing reflects it: GC ships in report-only mode a full phase before it is allowed to delete anything.
- Storage growth is real and must be communicated. Immutable tiles plus history plus branches means a heavily painted document can hold many versions of the same region. The grace window and GC bound it, but a self-hoster will see object storage grow faster than they expect. Open question: does a retention policy for historical tiles (keep every tile for N days, then keep only snapshot-referenced tiles) belong in this spec or in F38's operator controls?
- Canvas2D is the committed rendering path and it will not be enough for the top end. Section 10 lists exactly what is gated on F44. The risk is a credibility gap if the product is positioned as a painting tool while mixer brushes, large brushes, and live liquify are missing. Mitigation: phase the positioning with the capability, and never claim in the UI what the renderer cannot do.
- Go-side operator parity is a second implementation of every filter. Each F40 operator needs a TypeScript evaluator and a Go evaluator that agree per-pixel, or export diverges. That is a real, recurring cost and a permanent source of drift. Mitigation: a shared golden-image suite (section 16) gating every operator, and the fidelity report as the honest fallback when one is missing. Open question: is there a path to one implementation (a compiled shared core, an interpreted operator description) worth prototyping, or is dual implementation with golden tests the accepted cost? Note the precedent: `backend/internal/crdt` already embeds a JS bundle under a pure-Go engine to avoid exactly this kind of duplication, so the pattern exists in-tree and is worth a spike.
- Resolution independence is a half-truth and must be documented as one. Vector nodes re-render at any size; a paint layer has a fixed buffer. The FR-31 stroke journal genuinely restores resolution independence for stroke-only layers, but it is bounded, it closes the moment external pixels arrive, and it costs storage. Risk: users assume infinite zoom because the rest of the canvas behaves that way. Mitigation: the layer's native resolution and its journal state are visible in the layer properties, and the export dialog warns before upsampling.
- Selections not being persisted or shared will surprise people. It is the right call for document size, but "my selection vanished when I reloaded" is a support question waiting to happen. Mitigation: make "Save as mask" prominent and consider an opt-in session-local persistence in IndexedDB (not the document) so a reload can restore it locally without touching the CRDT.
- 8-bit throughout means banding on aggressive curves and repeated adjustments. Acceptable for Phase 1 to 4 and standard for web tools, genuinely limiting for print and photography. The 16-bit path is F44-gated and is also the gate on ever revisiting RAW.
- The proxy can drift from the tiles. The flattened composite is what older clients and the first Go implementation render, so a stale proxy shows stale artwork. Mitigation: regenerate the proxy debounced after painting stops and always before a snapshot; treat a stale proxy as a bug with a checksum check in the snapshot path. Open question: should proxy regeneration be client-side (fast, but a client can skip it) or a server job (authoritative, but adds load)?
- Tool-slot collision between node marquee selection and pixel marquee selection is a small UX landmine: the same drag gesture means two different things depending on whether a paint layer is targeted. Needs an explicit, visible mode rather than an inferred one.
