# F45: Creative file interop, colour management, and asset libraries

| Field | Value |
| --- | --- |
| Feature ID | F45 |
| Phase | 5 Creation depth |
| Sequence | 45 |
| Status | Not started |
| Depends on | F40 (procedural node graph: non-destructive operators are where imported adjustment/effect layers land), F41 (vector authoring: pen/bezier, live booleans, compound paths, image trace), F42 (raster and painting: pixel layers, blend modes, high-bit-depth buffers), F44 (GPU rendering path: colour transforms must be identical on the accelerated path), F38 (accessibility, i18n, security, compliance, NFR), `@hc/schema` (open file format + forward migration), `@hc/export` (encoders), `@hc/print` (print geometry + pre-flight), `@hc/color` (colour maths) |

Once HyCanvas is a full 2D creation platform, the thing that blocks adoption stops being features and becomes two questions a professional asks in the first five minutes: can I bring my existing work in without losing it, and can I hand output to a printer, an agency, or a client's pipeline and have it accepted. This spec owns both ends of that pipe and the colour correctness that runs through it: import of layered PSD, PDF and PDF-compatible AI, DXF, TIFF, and high-fidelity SVG as editable native scene-graph nodes rather than a flat raster; export at the same fidelity where it is legally and technically feasible, with every lossy mapping written down instead of discovered; ICC-based colour management with real working spaces, CMYK, spot inks, soft-proofing, and gamut warnings that agree across the browser preview, the GPU path, and the Go headless renderer; print-ready output with bleed, marks, overprint, separations preview, and PDF/X conformance; and workspace-scoped asset libraries with reusable components, shared styles, and linked assets that update across documents. Everything ships free and unwatermarked on a self-hostable binary, which is exactly the combination that no CMYK-capable design tool currently offers.

## Current state

Audited against the code: `packages/schema/src/schema.ts` (`Color`, `ColorSwatch`, `ImageSource.colorSpace`, `AssetRef`, `DesignFile.colorProfile`, `CURRENT_SCHEMA_VERSION = 17`) + `migrate.ts`; `packages/color/src/{convert,contrast,nearest,gamut,palette,harmony,cvd,series}.ts`; `packages/print/src/{types,geometry,preflight,catalog,cost,mockup,order,address}.ts`; `packages/export/src/{types,preflight,svg,pptx,pptximport,xml,unzip,zipstore,gif,apng,lottie,pages,dimensions}.ts`; `packages/stock/src/svg.ts` (`svgToNodes`, `parseGradients`); `packages/media/src/{types,fidelity,sniff}.ts`; `packages/engine/src/color.ts`; `packages/brandkit/src/{lint,gate,types}.ts`; `packages/templates/src/{apply,deepcopy,fill,lockedregions,marketplace}.ts`; `frontend/src/lib/{pdfImport,svgFlatten}.ts`; `frontend/src/components/editor/ExportDialog.tsx`; backend `internal/render/{pdf,pdftag,pdffont,pdfttf,pdfimage,raster,svg,board,fonts}.go`, `internal/docexport/{pdf,docx,model}.go`, `internal/color/color.go`, `internal/jobs/jobs.go`, `internal/persistence/{file,validate,migrate}.go`, `internal/migrations/sql/*`, `internal/uploads`, `internal/storage`.

The colour model in the file format is already print-shaped, and that is the single biggest head start this spec has. `Color` (`schema.ts:64-78`) is `{ srgb, cmyk?, spot? }`: canonical sRGB always present, optional explicit device CMYK, and an optional named spot with a book name and a CMYK fallback. `ImageSource.colorSpace` accepts `"srgb" | "display-p3" | "cmyk"`. `DesignFile.colorProfile?: string` exists at `schema.ts:1930`. `packages/engine/src/color.ts` states the intended architecture in its header: canonical sRGB drives the screen, explicit cmyk/spot drive print export, and ICC soft-proofing is a render-time transform to be layered on later.

Almost none of that is honoured downstream. `@hc/color` converts sRGB to and from hex, HSL, naive device CMYK, and CIE L\*a\*b\*, computes WCAG contrast (`contrastRatio`, `wcag`, `fixToAA`), CIE76 `deltaE`, `nearestPaletteColor`, median-cut `extractPalette`, CVD simulation, and harmony schemes. The `_profile` argument on `rgbToCmyk` and `cmykToRgb` is accepted and ignored, and `convert.ts` says so in its header. `gamutCheck` (`gamut.ts:31`) is an sRGB to CMYK to sRGB round trip with a tolerance, which is a clamp check, not perceptual gamut mapping, and it has no rendering intents. There is no ICC parsing, no colour management module, no OKLab/OKLCH, no Display P3 maths, no soft proofing, no CIEDE2000, and `@hc/color` never reads `Color.spot` at all.

`@hc/print` is a complete, well-tested pure core with zero consumers. `printRects` returns bleed/trim/safe boxes in millimetres; `cropMarks` emits eight clamped `MarkLine` segments; `effectivePpi`/`qualityBadge` grade image resolution; `runPrintPreflight` produces `PreflightCheck`s over the codes `dpi`, `color_space`, `icc`, `bleed`, `safe_zone`, `font_embed`, `overprint`, and `evaluateGate` blocks an order on un-overridden errors. Overprint is detected only (`isOverprintRisk` warns on registration black or pure RGB black on a CMYK product); there is no overprint attribute, no knockout, no trapping. ICC appears only as an opaque string (`PrintProduct.iccProfile` seeded as `"FOGRA39"`) compared for string equality against `design.colorProfile` in `preflight.ts:162,202`. There are no separations, no imposition, and no general paper-size table. `grep "@hc/print"` across the repo matches only the package's own `index.ts`: it is a dependency of the frontend that nothing imports, and nothing renders its crop marks.

Export is strong on structure and blind on colour. `@hc/export` ships a dependency-free OOXML writer and reader (`deckToPptx`, `pptxToDesign`), an editable-primitive SVG writer (`toSvg`), GIF/APNG encoders, a Lottie writer, and `preflight`. It contains no PDF writer at all: `PdfOptions` declares `intent`, `cmykProfile`, `embedFonts`, `flattenTransparency`, `bleedMm`, `cropMarks`, `trimMarks`, `registrationMarks`, and `colorBars`, and only `intent` and `cmykProfile` are ever read, by `preflight` deciding whether to run gamut checks. `"pdfx"` is a member of `ExportFormat` and of `PRINT_FORMATS` with nothing behind it. Real PDF comes from two other places: the client path in `ExportDialog.tsx` uses jsPDF to place one JPEG per page (pixel-exact, no text, no vectors), and the server path is a hand-rolled dependency-free writer, `backend/internal/render/pdf.go` plus `pdftag.go`/`pdffont.go`/`pdfttf.go`/`pdfimage.go` and `internal/docexport/pdf.go`. That Go writer is genuinely good on accessibility: a real structure tree, `/MarkInfo`, `/Lang`, `/ParentTree`, MCID-wrapped content, `/Alt` from `NodeBase.altText`, reading order independent of z-order, and embedded design fonts as Type0/Identity-H with ToUnicode. It is entirely RGB: `colorComponents()` reads only `color["srgb"]` and emits `rg`/`RG`, there is no `k`/`K` operator, no `/Separation`, no `/DeviceN`, no `/OutputIntent`, and no ICC stream anywhere in the binary, and embedded images are written `/DeviceRGB` or `/DeviceGray` at 8 bits per component. The only CMYK awareness in the whole Go backend is defensive: `pdfimage.go:58-62` refuses to pass a CMYK JPEG through untouched and re-encodes it to RGB. Documented degradations in the writer's own header: gradients render as their first stop, and per-element opacity is not applied because there is no ExtGState. Font handling is the strongest part: `pdfttf.go` embeds design-carried fonts as Type0/Identity-H with a CIDFontType2 descendant, checks the OS/2 fsType embedding permission before doing so, and records the glyphs actually drawn in a `used` map to build the `/W` array and the ToUnicode CMap, though the font file itself is embedded whole rather than glyph-subsetted, which matters for PDF/X. Raster export does not benefit: `render/fonts.go` `RegisterFont` exists but the API server never calls it (the only caller is `cmd/render-templates`), so every HTTP-served PNG and JPEG draws through the embedded Liberation Sans fallback, and `@hc/export`'s `embedFonts` flag is never read by anything. There is a third PDF writer in `internal/docexport/pdf.go` for the docs document type, A4, base-14 fonts only, with no embedding at all. Render output is bounded at `maxRenderSide = 16384` in `httpapi/export.go`.

Import today is two narrow paths plus a set of type declarations with nothing behind them. `frontend/src/lib/pdfImport.ts` (99 lines) exposes `pdfFileToText` and `pdfToPages`, using pdf.js to pull each page's text runs and rebuild them as editable text boxes with a hardcoded `system` family and a solid black fill, one design page per PDF page; its header states that vector graphics and embedded images are not extracted because that needs operator-list parsing. SVG import is two layers: `@hc/stock` `svg.ts` `svgToNodes` is a regex-based, DOM-free scanner covering `path`, `rect`, `circle`, `ellipse`, `polygon`, `polyline`, `line`, `text`, and `image` with named/hex/rgb/hsl colours, linear and radial gradients through `parseGradients`, fill and stroke opacity, and compound paths through `contours`, and it estimates text width as `length * fontSize * 0.55`; `frontend/src/lib/svgFlatten.ts` `flattenSvgToNodes` mounts the SVG offscreen, resolves CSS classes, `currentColor`, and inheritance through `getComputedStyle`, rasterizes modern CSS colour syntax (`lab()`, `lch()`, `oklab()`, `oklch()`, `color()`) to sRGB through a 1x1 canvas, accumulates nested transform matrices, and bakes each leaf's matrix onto the node. Anything outside its leaf and container sets is skipped silently: `defs`, `use`, `symbol`, `clipPath`, `mask`, `filter`, `pattern`, `marker`, `textPath`, `foreignObject`, and `switch`. Two losses are sharper than they look: `stroke-dasharray`, miterlimit, conic and mesh gradients, and `tspan` positioning are dropped, and in `pathdata.ts` an elliptical arc segment (`A`) is replaced by a straight line to its endpoint, flagged only by `pathUsesArcs` setting the `approximated` boolean on the whole result. PPTX round-trips both directions (`pptximport.ts` `pptxToDesign` / `pptx.ts` `deckToPptx`) and is the proof that a dependency-free, clean-room importer producing editable native nodes is achievable in this codebase. `.hyc` portable design and template files import and export through `frontend/src/lib/hycFile.ts` (`parseHycFile` refuses a newer-than-current file, then migrates and validates). The dashboard import tile is labelled "Import (.hyc, .pptx)" in `DashboardApp.tsx` and accepts exactly those. `@hc/media` already declares the shape of the work this spec does: `ImportFormat = "pdf" | "pptx" | "docx" | "psd" | "ai" | "figma" | "svg"`, an `ImportJob` with `status: "queued" | "running" | "succeeded" | "partial" | "failed"`, and a `FidelityReport { pages, warnings[], fontsSubstituted[], unsupportedFeatures[] }` with a tested accumulator in `fidelity.ts` (`createFidelityReport`, `addWarning`, `recordFontSubstitution`, `recordUnsupported`, `mergeFidelity`, `fidelityStatus`). No importer calls any of it. `packages/media/src/sniff.ts` and `backend/internal/media/media.go` already recognise TIFF and PSD magic bytes (PSD sniffs to `image/vnd.adobe.photoshop` with kind `"source"`, meaning "importable design file"), so the product detects the formats it cannot open and files them under a name that promises an importer that does not exist.

There is no library, component, or shared-style model. `@hc/brandkit` is the closest thing: per-workspace palettes, fonts, logos, collections, and controls stored in the `brand_kits`/`brand_kit_versions` tables, with `lintDesign` flagging off-brand colours at `COLOR_TOLERANCE = 2.0` deltaE and `evaluateBrandGate` gating. `@hc/templates` copies a whole document (`deepCopyDesign`, `applyTemplateToNew`, `applyTemplateIntoExisting`, `remapLockedRegions`). Both are copy-in mechanisms: nothing links, and nothing propagates. `NodeType` has no `component`, `instance`, or `symbol` member. There is one half-built style reference already in the format and it is worth knowing about before adding another: `TextNode.styleRefs?: { defaultParagraph?: StyleId }` and `Run.charStyleId?: StyleId` (with `Run.overrides?: Partial<CharStyle>`) reference a `TextStyleSheet` that is declared at `schema.ts:904`, is not a field on `DesignFile` or `Page`, and has zero references anywhere in the repo. The pointer exists; the thing it points at has no home. `DesignFile.theme?: Theme` (a 12-slot palette plus a heading/body font pair) and the master/layout/placeholder cascade are the closest working approximation of shared styling today, and they are deck-scoped. Assets are per-workspace rows (`assets`, `asset_folders`, snake_cased by `20260629000000_snake_case_rename`, columns `id, workspace_id, kind, storage_key, filename, mime_type, byte_size, thumbnail, folder_id, tags, meta, uploaded_by_id, created_at, updated_at`) behind a base64-JSON upload endpoint with magic-byte sniffing, per-workspace and global per-user quotas, and an SSRF- and DNS-rebinding-guarded URL import capped at 25MiB; `AssetRef` in the file format carries `{ id, kind, url, mime, width?, height?, durationMs?, checksum? }` and no profile, bit depth, or link state.

Infrastructure this spec builds on rather than invents, with one caveat that changes the design. The job registry (`backend/internal/jobs/jobs.go`: `Registry.Start(userID, name)`, `Complete(id, result, blob)`, `Fail`, `Get`, polled at `GET /api/v1/jobs/{id}`, results either inline as `Job.Result` or as a `Job.Blob` storage key streamed by an ownership-rechecking download route) is a process-local map behind a mutex with no queue, no worker, no retry, no progress field, and no persistence across restart, and four of its five current callers do the work inline in the HTTP handler so the job is already `completed` when the POST returns. Only the video export at `httpapi/export.go:203` is genuinely asynchronous: it spawns a goroutine after `Start` and returns the job id immediately. That goroutine pattern, not the inline one, is the precedent this spec follows, and progress reporting has to be added rather than assumed. The rest is solid: the write-boundary validator (`persistence/validate.go` returns `ErrInvalidFile` as 422 when `schemaVersion` is outside `1..currentSchemaVersion`, with node count and depth bounds at 100000 and 64); the Go schema mirror at `currentSchemaVersion = 17` in `persistence/file.go`; per-workspace isolation enforced at the query layer across every service, uniformly as an explicit `workspaceID` parameter and a `WHERE workspace_id = $n`, returning not-found rather than forbidden so no endpoint is a cross-tenant existence oracle (`persistence/writes.go` `requireDesign` is the canonical gate); a storage `Driver` interface with S3 and local-filesystem implementations; `golang.org/x/image` already in `backend/go.mod` (BSD, and it carries a TIFF decoder); `pdfjs-dist` (Apache-2.0) and `jspdf` (MIT) already in `frontend/package.json`; and `dop251/goja` already embedded and shipping, running a bundled JS client inside the single Go binary for the CRDT fold, which is the existing precedent for headless parsing without cgo.

One more current-state fact matters for zero data loss and is easy to miss. `wrapUnknownNode` in `packages/schema/src/unknown-nodes.ts` copies a fixed `BASE_KEYS` list to the surface of an unknown node and stashes the verbatim original in `raw`. That list predates several base fields (`animation`, `interaction`, `altText`, `decorative`, `aspectLocked`, `opticalAlign`), which therefore survive only inside `raw`. Any new `NodeBase` field this spec adds inherits the same behaviour: preserved losslessly, but invisible to an older client's surface-level logic. Separately, `backend/internal/persistence/migrate.go` is a partial Go port of the TypeScript chain: its `switch` implements transforms only for source versions 1, 2, 3, and 5, and every other version takes a bare version bump, so the v13 to v14 effect normalization has no Go counterpart. Any migration this spec adds that is not purely additive would hit the same gap.

Status legend: **Built** (ships today, code-referenced), **Partial** (some of it ships, gaps noted), **Declared** (types or flags exist with no implementation behind them), **Not started**.

## Sequencing

**F38 (accessibility, i18n, security, compliance, self-host, NFR) precedes this spec.** That ordering was set in August 2026 on adoption evidence: internationalisation and accessibility show more evidence of blocking adoption than creative depth does, and both are axes a desktop-native incumbent cannot follow the product onto. The reasoning is recorded in `README.md` under "Why F38 precedes the creation-depth set" and in F38's own Priority section.

This does not reduce the value of the work below; it places it second, and it means the parts worth pulling forward early are the ones that serve the existing audience. That is OUTBOUND interop (layered export a professional can open), which is the single largest measured request in this segment, plus basic print mechanics (bleed, crop marks, 300dpi, RGB to CMYK on export). Full colour management and the inbound professional-format importers rank lower: the deepest browser imaging tool added colour profiles only long after it was already large, and the market leader already ships PSD and AI import.

## 1. Context and Goal

The product goal sheet lists "a real vector editor and print-grade CMYK/ICC color built in" as differentiator 5. Half of that is F41's job. This spec is the other half, plus the reason anyone would move their existing work here at all.

Two hard facts shape everything below. First, the tools a professional is migrating from write formats that are proprietary, partly undocumented, or expensive to interpret correctly, and HyCanvas ships as source-available software under the Elastic License 2.0 that self-hosters build and run themselves. That rules out linking copyleft interpreters into the binary and rules out redistributing licensed colour books and vendor ICC profiles. Being honest about which formats can be done cleanly, which need an optional user-installed component, and which we decline is a design requirement, not a disclaimer. Second, colour correctness is a three-renderer problem here, not a one-renderer problem. The same document is painted by `render2d.ts` on Canvas2D, by the F44 GPU path, and by `backend/internal/render` headless for export. A colour-managed pipeline that only holds in the browser is worse than none, because it makes the export silently wrong.

The product principle that governs import is already stated across the shipped specs and it is not negotiable here: an import produces editable native `@hc/schema` nodes, never a rasterized dead end. Where a source construct genuinely cannot be represented, the fallback is defined per construct, the loss is recorded in the fidelity report, and the user sees it. Silence is the failure mode we are designing against, because a silently flattened logo is discovered by the customer at the printer.

Intended outcome: a designer drops a layered PSD and a client's PDF-compatible AI logo into a HyCanvas workspace, gets editable layers, paths, type, and spot inks rather than pictures of them, reads a report that names the four things that did not survive and what they became, assigns the document a CMYK working space with the printer's ICC profile, soft-proofs on screen and sees the two out-of-gamut brand colours flagged, publishes the logo to the workspace library as a component with its colour style, uses it in eleven documents, updates it once, and exports a PDF/X-4 with bleed, marks, correct separations, and the spot ink still a spot ink, on their own self-hosted instance, for free.

## 2. Scope

In scope:
- Import of professional creative formats to editable native nodes: layered PSD, PDF, PDF-compatible AI, DXF, TIFF (including multi-page and high-bit-depth), and high-fidelity SVG including filter primitives, clip paths, masks, patterns, symbols, and markers.
- Export at matching fidelity where feasible: PDF (vector, tagged, and PDF/X), SVG with filters, TIFF, PSD-compatible layered output, and DXF, each with a documented lossy-mapping table.
- The fidelity report: a per-import, per-object record of what was preserved, what was approximated, and what was substituted, surfaced as a first-class document rather than a toast.
- Colour management: a colour-transform core with ICC profile parsing and application, RGB/CMYK/Gray/Lab working spaces, rendering intents, black point compensation, soft-proofing, gamut warnings, spot ink handling, and profile-aware image decode.
- Colour parity across the Canvas2D path, the F44 GPU path, and the Go headless renderer, proven by shared golden vectors.
- Print-ready output: bleed and slug boxes, trim/crop/registration marks, colour bars, overprint and knockout attributes, separations preview, ink coverage limits, and PDF/X-1a and PDF/X-4 conformance from the Go writer.
- Asset libraries: workspace-scoped reusable components with instance overrides, shared colour/text/effect/stroke styles, and linked assets that propagate updates across documents, all under per-workspace data isolation.
- Design variables: named, typed values (colour, number, string, boolean) resolvable per mode, referenced by node properties instead of being copied into them, so a change propagates rather than being re-applied by hand.
- The security posture for parsing untrusted binary formats, which this spec treats as the highest-risk surface in the product.

Out of scope (owned elsewhere):
- The vector authoring model itself: pen/bezier tooling, live booleans, compound paths, gradient meshes, and image trace (F41). This spec consumes those node types as import targets and states what it needs from them.
- Pixel layers, blend modes, high-bit-depth raster buffers, and painting (F42). PSD and TIFF import land on F42's model; this spec does not define it.
- Non-destructive operators and the node graph that adjustment layers, layer effects, and smart filters map onto (F40).
- The GPU renderer itself (F44). This spec imposes a colour-parity requirement on it.
- SSO/SCIM, audit, compliance programmes, and org-wide observability (F38).
- PPTX, ODP, and Keynote interop (F28) and diagram-format interop (F30).
- The video and audio media pipeline and its codecs.

Deferred, with reasons stated:
- A community or public gallery of shared assets, components, colour books, and presets. Deferred deliberately: it is a moderation, licensing-provenance, and abuse-surface problem before it is a feature problem. A public library needs per-item licence metadata that survives copy (the `@hc/templates` `mergeAttributions`/`remapAttributions` pattern is the seed, not the answer), takedown handling, malware scanning of user-supplied binaries, and a trust model for a self-hosted instance pulling content from an origin it does not control. Shipping it before workspace libraries are solid would mean designing the hard parts twice. Revisit after Phase 5, tracked with the templates marketplace rather than here.
- Shared preset packs (export presets, pre-flight profiles, print profiles) as distributable artefacts. Same reason: the distribution channel is the deferred part, not the presets. Workspace-scoped presets ship in Phase 5.
- DWG import (see section 13: no public specification, and the mature implementations are copyleft).
- Native import of the two closed cloud design formats. Their wire formats are undocumented and access is API-gated; the practical bridge is their own PDF and SVG export, which this spec already reads well.
- ICC v5 / iccMAX. Rare in production, large surface. v2 and v4 cover the professional print pipeline.

## 3. User Stories

- As a designer migrating a brand system, I want a layered PSD to open with its layers, groups, masks, type, and layer styles as editable objects, so I am not rebuilding it by hand.
- As an illustrator, I want an AI or PDF logo to import as real paths with its spot ink intact, so the logo I hand back to the client is still the logo.
- As a print buyer, I want to set the printer's ICC profile, soft-proof on screen, see which brand colours are out of gamut, and export a PDF/X-4 with 3mm bleed and crop marks that the printer accepts first time.
- As a packaging designer, I want a separations preview and an ink coverage warning before I send the file, not after.
- As a fabricator, I want to import a DXF drawing at true scale in millimetres and cut against it.
- As a photographer, I want a 16-bit TIFF with an embedded profile to import without a colour shift and without being silently converted to 8-bit sRGB.
- As a brand owner, I want a logo, a colour set, and a type scale published once to the workspace library, used across every document, and updated in one place.
- As a team lead, I want a linked asset update to be visible and reviewable, not to silently rewrite eleven live documents while people are editing them.
- As an operator of a self-hosted instance, I want the parser for a hostile file to be unable to reach my network, my filesystem, or my other workspaces' data.
- As a user on an older client during a rollout, I want a document carrying colour profiles and library references to open and save without losing anything.

## 4. Feature matrix / scope

Status values: **Built**, **Partial**, **Declared** (types/flags exist, no implementation), **Not started**. Priorities: P0 blocks the pillar, P1 is the credible-professional bar, P2 is depth.

### Colour model and working spaces

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Canonical sRGB colour with optional CMYK and spot | Built | `schema.ts:64-78` (`Color`, `ColorSchema`) | The right shape already: `srgb` mandatory, `cmyk?`, `spot?{name,book?,fallback}`. Nothing outside the schema reads `spot`. |
| Document colour profile field | Declared | `schema.ts:1930` `DesignFile.colorProfile?: string` | A bare name string. Read only by `print/preflight.ts:162,202` for string equality against `PrintProduct.iccProfile`. No profile is loaded. P0 to replace with a real reference (FR-9). |
| Working spaces (RGB/CMYK/Gray/Lab) per document | Not started | n/a | No concept of a working space, a rendering intent, or black point compensation. P0 (FR-9). |
| Wide-gamut and perceptual spaces (Display P3, OKLCH, Lab authoring) | Partial | `ImageSource.colorSpace` enum; `color/nearest.ts` `rgbToLab` | The image enum admits P3 but no P3 maths exists; Lab is a conversion target only, never an authoring space. P2 (FR-10). |
| Per-asset embedded profile | Not started | n/a (`AssetRef` has no profile field; `AssetMeta.colorProfile` in `@hc/media` is a four-value string enum) | An image's own profile is discarded on upload, so decode is unmanaged. P0 (FR-11). |
| Spot ink definition and rendering | Partial (schema only) | `schema.ts:67` `Color.spot` | Stored, never rendered as an ink, never separated, never proofed. P1 (FR-13). |
| Colour styles (named, reusable, document- and library-scoped) | Not started | n/a (`DesignFile.palette?: ColorSwatch[]` is a flat swatch list with no binding) | Swatches are values, not references: editing one changes nothing downstream. P1 (FR-19). |

### Colour management runtime

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| ICC profile parsing (v2/v4) | Not started | n/a | No parser, no tag table, no curve/matrix/LUT evaluation. The foundation for everything else in this table. P0 (FR-9). |
| Colour transform engine (CMM) | Not started | n/a (`color/convert.ts` `rgbToCmyk(c, _profile?)` ignores the profile) | Naive device CMYK only. Needs matrix/TRC and A2B/B2A LUT paths with tetrahedral interpolation, per intent. P0 (FR-9). |
| Rendering intents + black point compensation | Not started | n/a | `ColorIntent` exists as an `@hc/export` type and is only used as a preflight switch. P0 (FR-9). |
| Soft-proofing on canvas | Not started | n/a (`engine/color.ts` header names it as a later render-time transform) | Proof transform applied at paint time with a toggle, paper-white simulation, and a proof-vs-source split view. P1 (FR-12). |
| Gamut warning overlay | Partial | `color/gamut.ts` `gamutCheck` | A round-trip clamp check with no intents, no perceptual mapping, no UI. Needs a real out-of-gamut mask and a per-colour warning in the inspector. P1 (FR-12). |
| Perceptual gamut mapping | Not started | n/a | `gamutCheck.nearest` is the round-tripped colour, which is a clamp. Chroma-preserving mapping is a different algorithm. P2 (FR-12). |
| CIEDE2000 | Not started | `color/nearest.ts:58` `deltaE` is CIE76 | CIE76 is adequate for palette nearest-match, not for proofing tolerances or the parity harness. P1 (FR-27). |
| Colour parity across Canvas2D, GPU, and Go export | Not started | `engine/color.ts` (sRGB only), `render/pdf.go` `colorComponents()` (sRGB only), `internal/color/color.go` (Lab + contrast only) | Three independent colour implementations exist and none is managed. The parity contract is the load-bearing requirement of this spec. P0 (FR-14). |
| Colour-blindness simulation | Built | `color/cvd.ts` `simulateCvd`, `CVD_MATRICES` | Ships; extend the same overlay machinery to proofing and gamut views rather than building a second one. |

### Creative format import

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| PDF import as editable text | Partial | `frontend/src/lib/pdfImport.ts` (99 lines, pdf.js text content) | Text runs only, one design page per PDF page. Header states vectors and images are not extracted. P0 to extend to the operator list (FR-1). |
| PDF import as editable vectors, images, and clips | Not started | n/a | Needs operator-list walking: path construction/painting operators, `cm`/`q`/`Q` state, `Do` XObjects, inline images, `gs` ExtGState, shadings, tiling patterns, soft masks. P0 (FR-1). |
| AI import (PDF-compatible route) | Not started | n/a (`ImportFormat` declares `"ai"`) | Modern `.ai` is a PDF container; the artwork reads through the PDF path. The parallel private stream is undocumented and stays unread (section 13). P0 (FR-2). |
| Layered PSD import | Not started | n/a (`sniff.ts:86` detects PSD; `ImportFormat` declares `"psd"`) | Layers, groups, masks, text, vector shape layers, blend modes, layer styles. Depends on F42 for pixel layers and F40 for adjustment layers. P0 (FR-3). |
| EPS import | Not started | n/a | PostScript needs an interpreter; the mature ones are copyleft. Restricted-subset plus optional user-installed converter (section 13). P2 (FR-4). |
| DXF import | Not started | n/a | ASCII DXF, publicly documented, clean-room parseable, unit-aware. Highest fidelity-per-effort of the set. P1 (FR-5). |
| TIFF import (multi-page, 16-bit, CMYK, alpha) | Not started | n/a (sniffed in `media/sniff.ts:57` and `backend/internal/media/media.go:73`) | `golang.org/x/image/tiff` covers the server side; the browser needs its own decoder. P1 (FR-6). |
| SVG import: shapes, paths, text, images, gradients | Built | `@hc/stock` `svg.ts` `svgToNodes`, `parseGradients`; `frontend/src/lib/svgFlatten.ts` `flattenSvgToNodes` | Nine element types, compound paths, CSS/computed-style resolution, `currentColor`, modern colour syntax flattened to sRGB, baked nested transforms. Solid base. |
| SVG import: elliptical arcs | Partial (lossy) | `@hc/stock` `pathdata.ts` (`A` becomes a straight line to the endpoint), `pathUsesArcs` -> `approximated` | A rounded corner or a pie slice imports as a chord. The flag exists but reaches no user. Convert arcs to cubics; the `approximated` flag then feeds the report. P1 (FR-7, FR-8). |
| SVG import: `use`/`symbol`/`clipPath`/`mask`/`pattern`/`marker`/`textPath` | Not started | n/a (skipped by both the scanner and the flattener) | Silently dropped today, which is exactly the failure mode this spec exists to end. Also missing: `stroke-dasharray`, miterlimit, conic and mesh gradients, `tspan` positioning. P1 (FR-7). |
| SVG filter primitives | Not started | n/a | `feGaussianBlur`, `feColorMatrix`, `feOffset`, `feBlend`, `feComposite`, `feFlood`, `feMerge`, `feDropShadow` as the committed set; map to F40 operators, rasterize the rest with a report entry. P2 (FR-7). |
| Fidelity report produced by importers | Declared | `@hc/media` `types.ts:76` `FidelityReport`, `fidelity.ts` (tested accumulator, no caller) | The type and its accumulator ship and nothing uses them. Wiring this is cheap and is the spine of FR-8. P0. |
| Font substitution on import | Partial | `fidelity.ts` `recordFontSubstitution` exists; `render/fonts.go` + `fallbackfont.go` do server-side fallback | No import-time matching, no user-facing substitution list, no remap UI. P1 (FR-8). |
| Import as a background job | Partial | `internal/jobs/jobs.go` registry; `httpapi/export.go:203` (the one truly async caller) | The registry ships and is the right home, but it is a process-local map with no queue, no retry, no persistence, and no progress field, and most callers complete inline before returning. Needs the goroutine pattern plus progress. P0 (FR-22). |

### Export fidelity and print-ready output

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Vector PDF export with real text | Built (RGB) | `backend/internal/render/pdf.go` (dependency-free writer) + `pdffont.go`/`pdfttf.go`/`pdfimage.go` | Real vectors, embedded Type0/Identity-H fonts, JPEG passthrough. Gradients emit their first stop; per-element opacity is not applied (no ExtGState). P0 to fix both for print (FR-15). |
| Tagged/accessible PDF | Built | `render/pdftag.go`; `render.ToDeckPDF`; `ExportDialog` Accessible PDF; `sdk` `taggedPdfUrl()` | Structure tree, `/Alt`, `/Lang`, MCID, reading order independent of z-order. Keep it working through every change in this spec. |
| Raster PDF (client) | Built | `ExportDialog.tsx` jsPDF, one JPEG per page | Pixel-exact, no text, no vectors, RGB. Stays as the "looks exactly like the screen" option. |
| CMYK PDF output | Not started | `pdf.go` `colorComponents()` reads only `srgb` | No `k`/`K` operator anywhere. P0 (FR-15). |
| Spot colour separations in PDF | Not started | n/a | No `/Separation` or `/DeviceN` colour space in the writer. P1 (FR-16). |
| Output intent / ICC stream in PDF | Not started | n/a | Required for PDF/X conformance. P0 (FR-17). |
| PDF/X-1a and PDF/X-4 conformance | Declared | `"pdfx"` in `ExportFormat` and `PRINT_FORMATS`; `print/preflight.ts:73` builds a `pdfx` request | A format name with no encoder. P0 (FR-17). |
| Bleed, trim, and slug boxes in output | Declared | `print/geometry.ts` `printRects`; `PdfOptions.bleedMm` (never read) | Geometry computed, never written to a PDF box or honoured by the renderer. P0 (FR-18). |
| Crop/trim/registration marks and colour bars | Declared | `print/geometry.ts` `cropMarks` (8 `MarkLine`s); `PdfOptions.cropMarks`/`trimMarks`/`registrationMarks`/`colorBars` (never read) | Marks exist as coordinates that nothing draws. P0 (FR-18). |
| Overprint and knockout | Partial (detection) | `print/preflight.ts` `isOverprintRisk` | Warns on registration black and RGB black on CMYK. No attribute on nodes, no `/OP`/`/op`/`/OPM` in output, no trapping. P1 (FR-16). |
| Separations preview | Not started | n/a | Per-plate on-canvas preview plus total ink coverage against a limit. P1 (FR-16). |
| Print pre-flight surfaced in the product | Partial | `print/preflight.ts` `runPrintPreflight`, `evaluateGate` (no consumers) | A complete pure core with no UI and no export gate. Wiring it is high value per unit of work. P0 (FR-18). |
| Transparency flattening for PDF/X-1a | Declared | `PdfOptions.flattenTransparency` (never read) | X-1a forbids live transparency; X-4 permits it. Needed only for the X-1a path. P2 (FR-17). |
| Font subsetting in PDF | Partial | `render/pdfttf.go` (whole file embedded; `used` map already tracks drawn glyphs for `/W` + ToUnicode) | Fonts embed with fsType permission checks but are not glyph-subsetted, which inflates print files and is a practical PDF/X problem. The glyph set is already known, so subsetting is a contained change. P1 (FR-17). |
| Design fonts in raster export | Partial | `render/fonts.go` `RegisterFont` (called only by `cmd/render-templates`) | Every HTTP-served PNG/JPEG falls back to embedded Liberation Sans, so raster and PDF export disagree on type. Colour parity work is pointless if glyph parity is broken; fix alongside FR-14. P1. |
| SVG export with filters and clips | Partial | `@hc/export` `svg.ts` `toSvg` | Editable primitives, gradients, groups, text. No filter emission, no clip/mask emission. P2 (FR-21). |
| Layered export (PSD-compatible, layered TIFF) | Not started | n/a | The reciprocal of FR-3/FR-6 and the hand-off professionals actually ask for. P2 (FR-21). |
| DXF export | Not started | n/a | Cheap once the importer exists; the entity mapping is symmetric. P2 (FR-21). |

### Asset libraries, components, and shared styles

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Per-workspace asset store | Built | `assets`/`asset_folders` tables; `internal/uploads`, `internal/storage` (S3 with local fallback) | Rows are workspace-scoped and isolated at the query layer. The storage half of a library already exists. |
| Brand kit (palettes, fonts, logos, controls) | Built | `brand_kits`/`brand_kit_versions`; `@hc/brandkit` `lintDesign`, `evaluateBrandGate`, `COLOR_TOLERANCE = 2.0` | A workspace-scoped, versioned style source with linting. The closest thing to a library today, but it lints; it does not bind. |
| Template copy-in | Built | `@hc/templates` `applyTemplateToNew`, `applyTemplateIntoExisting`, `deepCopyDesign`, `remapLockedRegions` | Copies and re-ids. No live link back to the source. |
| Reusable components (definition + instances) | Not started | n/a (`NodeType` has no `component`/`instance`/`symbol`) | New node type plus a document- and library-level definition registry. P1 (FR-19). |
| Instance overrides | Not started | n/a | Per-instance text/fill/image overrides that survive a definition update. P1 (FR-19). |
| Shared styles (colour, text, effect, stroke) | Partial (dangling) | `schema.ts:904` `TextStyleSheet` (declared, no home, zero references); `TextNode.styleRefs`, `Run.charStyleId`, `Run.overrides` | Text nodes already point at a stylesheet that does not exist on `DesignFile`. Give the declared type its home rather than adding a second parallel mechanism, then add colour/effect/stroke styles beside it. P1 (FR-19). |
| Linked assets across documents | Not started | n/a (`AssetRef` has no link state) | Reference by library id and version, with an explicit update action. P1 (FR-20). |
| Update propagation and review | Not started | n/a | A push that lists affected documents, is reviewable, and is undoable per document. P1 (FR-20). |
| Cross-workspace sharing | Not started | n/a | Explicitly a copy, never a live link (section 8). P2. |
| Community / public shared library | Deferred | n/a | Deferred with reasons in section 2. |

### Security of format parsing

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Archive extraction limits | Partial | `@hc/export` `unzip.ts` (store + `DecompressionStream`) | Works for PPTX; no ratio cap, no entry-count cap, no per-entry size cap, no path-traversal check on entry names. P0 (FR-23). |
| Allocation clamping on attacker-controlled dimensions | Partial | The existing code-scanning-driven clamp pattern in the table/axis allocation paths | The pattern is established in the codebase and must be applied to every width/height/layer-count/strip-offset field a parser reads. P0 (FR-23). |
| Active content stripping (PDF/EPS/SVG) | Not started | n/a | `/JavaScript`, `/OpenAction`, `/Launch`, `/EmbeddedFile`, `<script>`, `<foreignObject>`, and external `xlink:href` must be refused, never executed or fetched. P0 (FR-24). |
| XML hardening (XXE, entity expansion) | Partial | `@hc/export` `xml.ts` (a compact parser with no DTD/entity support, which is the safe default) | The property must be asserted by test, not left implicit, and must hold for SVG and XMP too. P0 (FR-24). |
| Sandboxed parse boundary | Not started | n/a | Worker-isolated in the browser, bounded job on the server. Precedent: `internal/crdt` already runs a bundled JS engine (goja) inside the binary. P0 (FR-25). |
| SSRF guard on any import-time fetch | Partial | The existing SSRF-guarded URL extractor used by document ingestion | Must cover linked images, external profiles, and remote font references in imported files. P0 (FR-24). |
| Untrusted font parsing | Partial | `render/pdfttf.go`, `render/fonts.go` | Embedded fonts from imports are attacker-controlled binaries; parse under the same limits and never load them into a system font path. P1 (FR-23). |

## 5. UX and interaction behavior

The novel surfaces are the import report, the colour-management controls, and the library. Everything else reuses existing editor chrome.

- Import entry points: the dashboard import tile (which already accepts `.pptx` and `.hyc`) gains the creative formats behind one file picker with format sniffing (`@hc/media` `sniff.ts`), plus drag-and-drop onto the canvas for placing a single imported file as artwork inside the current document. A file the instance cannot open is refused with the reason and the format's row from the section 13 matrix, never with a generic failure.
- Import runs as a job with real progress. The user is not blocked: the design is created when the job completes, and a partial result (`fidelityStatus` returning `"partial"`) still opens, because a document with four warnings is worth more than an error dialog.
- The import report is a document, not a toast. It opens beside the imported design and lists, per page and per object: what was preserved exactly, what was approximated and how (an arc converted to cubics, a gradient mesh baked to a bitmap fill, a layer effect converted to an operator chain), what was substituted (a font, a profile, a spot ink resolved to its CMYK fallback), and what was refused (an embedded script, an unreadable private stream). Every row links to the affected object and selects it on click. The report persists with the design so it can be reread a week later, and it is exportable.
- Nothing is flattened silently. When a construct must rasterize, the resulting node is tagged as approximated, the canvas shows a subtle badge on it in a review mode, and the report row explains the reason. Flattening is the last resort, and the user always learns about it before the printer does.
- Colour setup lives in a document settings pane: working RGB space, working CMYK space (chosen from installed profiles), gray, rendering intent, black point compensation, and a proof target. Changing the working space never rewrites stored colours; it changes interpretation and display, and the pane says so.
- Soft-proofing is a toggle with a target profile and paper-white simulation, plus a split view that shows source and proof side by side. Gamut warning is a separate toggle that masks out-of-gamut pixels; the mask uses a pattern as well as a colour so it is not a colour-only signal (section 12). The colour inspector shows, for the selected colour, its value in the working space, its converted CMYK under the current profile and intent, its deltaE against the source, and an out-of-gamut flag with a suggested in-gamut alternative.
- Print setup extends the same pane: page size and orientation from a real paper table, bleed and slug in the document unit, marks (crop, trim, registration, colour bars) with offset and length, and a live preview of the bleed/trim/safe boxes on canvas as non-printing guides. Pre-flight (`runPrintPreflight`) runs on demand and before any print export, and its result gates the export exactly as `evaluateGate` already models: errors block unless overridden, warnings require acknowledgement.
- Separations preview is a view mode: toggle plates individually (C, M, Y, K, plus each spot), see a single-plate view or an ink-coverage heat map against the configured total-area-coverage limit.
- The library is a panel with two halves: assets (images, vectors, documents, components) and styles (colour, text, effect, stroke). Publishing takes the current selection or the document's styles and pushes them to the workspace library with a name and a version note. Using a library item inserts an instance or applies a style reference, both of which show a link badge.
- A library update is a reviewable event, never a silent rewrite. When a definition changes, documents using it show an "update available" affordance listing what changed; accepting is one undoable action per document. Documents open with their last-accepted version, so a colleague publishing a change mid-edit cannot move objects under the user's cursor. Auto-update is available per link but is not the default.
- Detaching is always available and always local: detach an instance, detach a style, detach a linked asset. Detach never modifies the library.

## 6. Functional requirements

Grouped by theme. These FR ids are the durable contract referenced by the acceptance criteria and the feature matrix.

Import:
- FR-1: PDF import produces editable native nodes for text, vector paths (fill, stroke, winding rule, dash), images (including inline images and image XObjects), clipping paths, soft masks, shadings, and tiling patterns, walking the content stream operator list rather than only the text layer, with page geometry taken from the MediaBox/CropBox/TrimBox and the document unit set accordingly.
- FR-2: AI import reads the PDF-compatible container through the FR-1 path and reports, as a first-class warning, when a file was saved without PDF compatibility (there is nothing readable to import, and the user must be told exactly that rather than shown an empty document). The undocumented private stream is never parsed.
- FR-3: PSD import produces a layer tree preserving groups, layer order, opacity, blend modes, raster layers (as F42 pixel layers), vector shape layers (as F41 paths), type layers (as editable text with font, size, tracking, and colour), layer masks, vector masks, and clipping groups; adjustment layers and layer styles map to F40 operators where an equivalent exists and are baked with a report entry where it does not.
- FR-4: EPS import is attempted only through the safe routes defined in section 13 (an embedded PDF or preview, or a restricted operator subset under a hard operation and time budget); anything else is refused with a clear explanation and the optional-converter instructions, never partially rendered.
- FR-5: DXF import produces native geometry for LINE, LWPOLYLINE, POLYLINE, CIRCLE, ARC, ELLIPSE, SPLINE, POINT, SOLID, TEXT, MTEXT, INSERT/BLOCK (as groups or component instances), HATCH (as a fill where the pattern maps, otherwise an outline plus a report entry), and DIMENSION (as its exploded geometry), honouring `$INSUNITS` so the drawing arrives at true scale.
- FR-6: TIFF import handles baseline plus LZW, Deflate, and PackBits compression, multi-page (as multiple pages or layers, user's choice), 8- and 16-bit-per-channel, alpha, and Gray/RGB/CMYK/Lab photometric interpretations, preserving the embedded ICC profile and never silently reducing bit depth or converting colour.
- FR-7: SVG import gains `use`/`symbol` (as instances or expanded groups), `clipPath`, `mask`, `pattern`, `marker`, `switch`, and the committed filter primitive set (`feGaussianBlur`, `feColorMatrix`, `feOffset`, `feBlend`, `feComposite`, `feFlood`, `feMerge`, `feDropShadow`) mapped to F40 operators; unsupported primitives rasterize the filtered subtree with a report entry, and arcs continue to set the existing `approximated` flag which now flows into the report.
- FR-8: Every importer produces a `FidelityReport` using the existing `@hc/media` accumulator, recording per-object preservation, approximation, substitution, and refusal; the report is persisted with the design, surfaced as a navigable document, and exportable. An import that records any approximation or substitution completes with status `"partial"`, never `"succeeded"`.

Colour management:
- FR-9: A colour-management core parses ICC v2 and v4 profiles (header, tag table, TRC curves, matrix, A2B/B2A LUTs including `mft1`/`mft2`/`mAB`/`mBA`) and evaluates transforms between profiles for the four rendering intents with optional black point compensation. A document declares working RGB, CMYK, and Gray spaces plus a default intent; absent declarations mean sRGB, the shipped default CMYK, and relative colorimetric, which is exactly today's behaviour.
- FR-10: `Color` optionally carries a non-sRGB authoring value (space, components, and a profile reference) while `srgb` remains mandatory as the always-renderable fallback, so a colour authored in CMYK, Lab, or a wide-gamut space is stored losslessly and any client, old or new, can still paint it.
- FR-11: An uploaded or imported image retains its embedded ICC profile as a workspace asset, referenced by the asset row and by `AssetRef`; decode converts from the image's profile to the document working space rather than assuming sRGB, and a profile-less image is treated as sRGB and flagged in the report.
- FR-12: Soft-proofing renders the document through a proof profile and intent with optional paper-white simulation; a gamut warning mode marks out-of-gamut areas using a pattern plus colour; the colour inspector reports the converted value, the deltaE, and an in-gamut suggestion; out-of-gamut colours are additionally surfaced by pre-flight.
- FR-13: A spot colour is a first-class ink: named, optionally measured in Lab, with a CMYK or RGB fallback for display; it is previewed as its own plate, exported as a `/Separation` colour space, counted in ink coverage, and never silently converted to process unless the user asks for it.
- FR-14: One colour-transform implementation is the source of truth and is mirrored, not reimplemented: the pure TypeScript core in `@hc/color` and its Go mirror in `backend/internal/color` are verified against a shared golden vector table so a colour renders identically in the Canvas2D path, the F44 GPU path, and the Go headless export, to a stated deltaE tolerance. A change to either side that breaks the table fails the build.

Export and print:
- FR-15: The Go PDF writer emits DeviceCMYK (`k`/`K`) as well as DeviceRGB, honours per-element opacity through ExtGState, and emits real gradient shadings instead of the first stop, closing the two degradations its own header documents.
- FR-16: Overprint and knockout are node attributes honoured by the writer (`/OP`, `/op`, `/OPM`); spot inks export as `/Separation` (and `/DeviceN` where combined); a separations preview renders per-plate on canvas; and total ink coverage is computed against a configurable limit and reported by pre-flight.
- FR-17: PDF export conforms to PDF/X-1a and PDF/X-4 on request: an `/OutputIntent` with an embedded ICC profile, all fonts embedded and subset, no unmanaged RGB in the X-1a path, transparency flattened for X-1a and preserved for X-4, and required document information keys present. A file failing conformance fails the export with the specific violation, rather than emitting a non-conforming file named `pdfx`.
- FR-18: Print geometry becomes real output: the bleed, trim, and slug boxes computed by `printRects` are written to the PDF page boxes and honoured by the renderer; `cropMarks` and registration marks and colour bars are drawn outside the trim; and `runPrintPreflight`/`evaluateGate` run before every print export, blocking on un-overridden errors and unacknowledged warnings.

Libraries:
- FR-19: A component is a named definition (in the document or the workspace library) plus instances that reference it; an instance renders the definition with per-instance overrides for text, fills, and image sources, and overrides survive a definition update. Shared colour, text, effect, and stroke styles are named records referenced by nodes; editing a style restyles every referencing node in one undoable action, and a local edit detaches that node from the style.
- FR-20: A linked asset references a workspace library item by id and version; a document opens at its last-accepted version; a library update surfaces as a reviewable, per-document, undoable action listing the affected objects; auto-update is opt-in per link; detaching is always available and never modifies the library.
- FR-28: A design variable is a named, typed value (colour, number, string, or boolean) living in the document or the workspace library. Any node property of a matching type may hold a reference to one instead of a literal, and resolution happens at render time so changing the variable updates every referencing property at once. This is the same substitution the Brand Kit performs for a fixed set of slots, generalized to arbitrary properties, and it must not repaint app chrome (F38's separation of app accent from design content holds).
- FR-29: Variables may be grouped into named modes (for example light and dark, or compact and comfortable), and a document or a subtree selects a mode. Resolving a reference is (variable, mode) to value, with a documented fallback to the default mode when a mode omits a variable, so a missing mode degrades rather than failing to render.
- FR-30: A variable reference is preserved end to end: it survives save, reload, CRDT merge, and export, and an older client that does not understand variables renders the RESOLVED value rather than an empty property, by the same baked-fallback rule this spec applies to components. A newer client re-resolves on open.
- FR-21: Export reciprocates import where feasible: SVG with filters and clips, layered TIFF, PSD-compatible layered output, and DXF, each with a documented mapping table stating what does not survive.

Jobs, performance, and security:
- FR-22: Import, print export, and library-wide update propagation run through the existing job registry (`internal/jobs`) and are polled at `GET /api/v1/jobs/{id}`; no format parsing and no propagation runs inline in a request handler. Because the registry is a process-local map whose typical caller completes the work before returning, this requires the asynchronous goroutine pattern used by video export plus a progress field the registry does not have today, and it inherits the registry's current limits (no persistence across restart, no retry), which the phasing must either accept explicitly or fix.
- FR-23: Every parser enforces hard resource limits before allocation: maximum decompressed size and compression ratio, maximum entry count and per-entry size for archives, maximum image dimensions and layer count, a wall-clock budget, and a memory ceiling, with attacker-controlled dimension fields clamped at the allocation site following the pattern already established in the codebase. Exceeding a limit aborts the import with a specific error and never a partial write.
- FR-24: Active and external content is refused, not executed: PDF/EPS `/JavaScript`, `/OpenAction`, `/Launch`, `/AA`, and embedded files; SVG `<script>`, event attributes, and `<foreignObject>`; and any external reference (image, font, profile, entity) is either resolved from the archive or refused, with no network fetch except through the existing SSRF-guarded path. XML parsing supports no DTDs and no entity expansion, asserted by test.
- FR-25: Parsing of untrusted binary formats happens inside a sandbox: a dedicated browser worker for the client path (no DOM, no same-origin credentials, terminated on budget breach) and a bounded job for the server path, with no filesystem access beyond the input blob, no network, and per-workspace credentials never in scope. Whatever a parser produces crosses the write boundary as a normal document and is validated by `persistence/validate.go`, which returns 422 and persists nothing on failure.
- FR-26: Colour profiles, library items, linked assets, and import artefacts are workspace-scoped and isolated at the query layer, consistent with every existing service; a reference that resolves outside the caller's workspace is refused at the query layer, not filtered in the handler.
- FR-27: The parity and accuracy harness uses CIEDE2000 for tolerance assertions (CIE76 remains adequate for palette nearest-match), with stated per-surface budgets.

## 7. Data model / schema changes

All additions follow the schema-is-contract rule: extend the `NodeType` union and `KNOWN_NODE_TYPES` in `packages/schema/src/schema.ts`, define the interface plus the Zod schema with `...nodeBaseFields, type: z.literal("...")`, add it to the `KnownNode` union and the discriminated `NodeSchemaByType`, give it a default in `factory.ts`, register a forward migration step in `migrate.ts` keyed on the source version (the registered steps are a record keyed by source version, the newest being `16: (file) => ({ ...file, schemaVersion: 17 })`), and bump `CURRENT_SCHEMA_VERSION` (currently 17). Two coupling rules apply to every bump: raise the Go mirror `currentSchemaVersion` in `backend/internal/persistence/file.go` (currently 17, also exported as `CurrentSchemaVersion`) in the same change, or `persistence/validate.go` rejects the newer file with a 422 (`ErrInvalidFile`) and nothing persists; and append a one-line entry to the schema-version-history doc-comment above `CURRENT_SCHEMA_VERSION`.

Everything in this section is additive and optional. No field is repurposed, renamed, or narrowed, and no existing field changes meaning. `DesignFile.colorProfile?: string` in particular stays exactly as it is and keeps being read by `print/preflight.ts`; the new profile model sits beside it, and the migration does not rewrite it. Two properties of the existing mechanics constrain the shapes below. First, the known and accepted trade for an additive node type is that an older client preserves it losslessly through `UnknownNode.raw` on save but cannot render it, which is the same trade already accepted for the F30 board node types; an instance therefore carries its geometry on `NodeBase` so an old client shows a correctly sized empty placeholder rather than nothing. Second, `wrapUnknownNode`'s `BASE_KEYS` list does not include recently added base fields, so a new `NodeBase` field is preserved inside `raw` but is not surfaced; either extend `BASE_KEYS` in the same change or accept that older clients cannot reason about the field, and say which in the commit.

Colour representation:

```ts
// Optional non-sRGB authoring value. `srgb` on Color stays mandatory, so every
// client, old or new, can always paint the colour.
interface ColorValue {
  space: "srgb" | "display-p3" | "rec2020" | "lab" | "oklch" | "cmyk" | "gray";
  components: number[];       // 0..1 per channel, space-ordered
  profileId?: string;         // -> DesignFile.colorProfiles[].id
}
// Color gains: value?: ColorValue. Absent means "srgb is the authored value",
// which is exactly today's semantics.
// Color.spot gains: lab?: { L: number; a: number; b: number } (measured), and
// tint?: number (0..1) so a tinted spot is not a separate ink.

interface ColorProfileRef {
  id: string;
  name: string;                          // human label, e.g. the printer's profile name
  class: "rgb" | "cmyk" | "gray" | "lab";
  source: { kind: "builtin"; key: string } | { kind: "asset"; assetId: string };
  checksum?: string;                     // sha-256 of the profile bytes
}

interface WorkingSpaces {
  rgb?: string;                          // profile id; absent means sRGB
  cmyk?: string;                         // absent means the shipped default CMYK
  gray?: string;
  intent?: "perceptual" | "relative" | "saturation" | "absolute"; // absent means relative
  blackPointCompensation?: boolean;      // absent means true
}
// DesignFile gains: colorProfiles?: ColorProfileRef[]; workingSpaces?: WorkingSpaces.
```

Profile bytes are stored as workspace assets and referenced by id, not inlined in the document. A design file stays a document, not a profile bundle; profiles are large, shared across many documents, and often licence-restricted, so duplicating them into every file would be wrong on size and on redistribution. The `checksum` makes a missing profile detectable and a substituted one visible in pre-flight.

Print attributes:

```ts
// NodeBase gains: print?: { overprint?: boolean; knockout?: boolean; }
// Absent means today's behaviour (no overprint, normal knockout).

interface PageBleed { bleedMm?: number; slugMm?: number; safeMm?: number }
interface PageMarks {
  crop?: boolean; registration?: boolean; colorBars?: boolean;
  offsetMm?: number; lengthMm?: number;
}
// Page gains: print?: { bleed?: PageBleed; marks?: PageMarks; inkLimit?: number }.
```

Libraries, components, and styles:

```ts
// A reusable definition. Lives in the document (self-contained) or is mirrored
// from the workspace library via `libraryRef`.
interface ComponentDef {
  id: string;
  name: string;
  nodes: Node[];                 // the definition's own subtree
  width: number; height: number; // intrinsic size, so an instance can be laid out
  libraryRef?: { assetId: string; version: number };
}

// An instance node. Carries width/height/transform on NodeBase, so an older
// client that cannot resolve the definition still round-trips it via
// UnknownNode.raw and knows the space it occupies.
interface InstanceNode extends NodeBase {
  type: "instance";
  componentId: string;
  overrides?: { nodeId: string; text?: string; fills?: Fill[]; assetId?: string }[];
  detached?: boolean;
}

interface SharedStyle {
  id: string;
  name: string;
  kind: "color" | "effect" | "stroke";   // text styles use the existing TextStyleSheet
  value: unknown;                        // ColorSchema | Effect[] | Stroke
  libraryRef?: { assetId: string; version: number };
}
// DesignFile gains: components?: ComponentDef[]; styles?: SharedStyle[];
//   textStyles?: TextStyleSheet  (the declared-but-homeless type at schema.ts:904
//   finally gets its home, so TextNode.styleRefs and Run.charStyleId resolve).
// NodeBase gains: appliedStyles?: { fill?: string; effect?: string; stroke?: string }.

interface LinkedAsset {
  id: string;
  libraryAssetId: string;
  acceptedVersion: number;
  updatePolicy?: "manual" | "auto";   // absent means manual
  lastCheckedAt?: string;
}
// DesignFile gains: links?: LinkedAsset[]. AssetRef gains: linkId?: string;
// colorProfileId?: string; bitDepth?: number; channels?: number.
```

Import provenance:

```ts
// The persisted fidelity report, so "what did this import lose" is answerable
// a week later. Shape mirrors @hc/media FidelityReport, which already ships.
// DesignFile.meta gains an `importReport` entry (meta is Record<string, unknown>,
// so this needs no schema bump at all, matching the aiProvenance precedent).
```

Migration plan. Batch the additions into as few bumps as the phasing allows, each one purely additive: v17 to v18 for colour (`ColorValue`, `ColorProfileRef`, `WorkingSpaces`, spot `lab`/`tint`, `AssetRef` colour fields); v18 to v19 for print (`NodeBase.print`, `Page.print`); v19 to v20 for libraries (`InstanceNode`, `ComponentDef`, `SharedStyle`, `TextStyleSheet`'s home, `NodeBase.appliedStyles`, `LinkedAsset`). Each step is `(file) => ({ ...file, schemaVersion: n + 1 })` with no node mapping, because older files simply omit the new fields and the absent-means-today's-behaviour rule holds for every one of them. Because every step is a bare bump, the partial Go migration chain in `persistence/migrate.go` needs no new case, which is exactly why staying additive matters here and not only in principle. Each bump raises the Go mirror in the same change and appends its history line. Mixed-version coexistence is the acceptance bar: a v17 client and a v20 client editing the same design must each preserve the other's data, an old binary must still open a v20 file after a rollback (via the version-history restore path, since forward-only migration means the file itself does not downgrade), and no destructive SQL is involved anywhere in this spec. New tables are additive with nullable or defaulted columns; nothing drops or rewrites user content.

## 8. API and realtime

REST under `/api/v1` (chi router). Errors are RFC 7807 problem+json; every handler emits structured JSON logs keyed by design id, workspace id, user id, job id, and request id.

```
POST   /api/v1/imports/creative                 asset-ref or base64 body + sniff -> 202 + job id (psd/ai/pdf/dxf/tiff/eps/svg)
GET    /api/v1/imports/{id}                     import job state + FidelityReport
POST   /api/v1/designs/{id}/export/pdf          vector/tagged PDF -> job
POST   /api/v1/designs/{id}/export/pdfx         PDF/X-1a or X-4 with output intent -> job (409 on conformance failure)
POST   /api/v1/designs/{id}/preflight           run print pre-flight -> PreflightResult
GET    /api/v1/workspaces/{id}/color/profiles   installed ICC profiles (builtin + workspace-uploaded)
POST   /api/v1/workspaces/{id}/color/profiles   upload an ICC profile as a workspace asset
POST   /api/v1/designs/{id}/color/convert       batch colour conversion for the inspector (profile, intent)
GET    /api/v1/workspaces/{id}/library          library items (assets, components, styles) with versions
POST   /api/v1/workspaces/{id}/library          publish selection/styles as a library item -> new version
GET    /api/v1/workspaces/{id}/library/{id}/usages   documents referencing this item
POST   /api/v1/designs/{id}/links/accept        accept a library version into this design -> job for large docs
GET    /api/v1/jobs/{id}                        poll long-running ops (existing registry)
```

Two conventions from the existing code carry over rather than being reinvented. Bytes arrive the way uploads already arrive: a base64 payload in a JSON body (or a reference to an already-uploaded asset id for anything large), not multipart, matching `internal/uploads`; the existing quota, magic-byte sniffing, and SSRF-guarded URL import path apply unchanged, with the 25MiB URL-import cap raised per format only where a limit in section 10 justifies it. And a long operation returns its job id immediately from a spawned goroutine, following the video-export path at `httpapi/export.go:203`, not the inline pattern the other four job callers use; `Job` gains a progress field, since it has none today and an import that takes a minute without one is indistinguishable from a hung request.

Per-workspace isolation is the governing rule for every one of these. A library item, an ICC profile, an import artefact, and a linked-asset reference are workspace-scoped rows, and every query takes the workspace id as a parameter rather than filtering after the fact, consistent with the existing services and with the `requireDesign` gate in `persistence/writes.go`. A `libraryAssetId` that resolves to another workspace is a 404 at the query layer, not a 403 after a successful read, so the existence of another workspace's asset is never observable, which is the behaviour every existing endpoint already has. Sharing a library item across workspaces is an explicit copy that duplicates the bytes and the definition and creates no cross-workspace link, because a live cross-tenant link would make one workspace's edit mutate another's documents and would defeat isolation at exactly the point where it matters most.

Linked-asset propagation is pull, not push. Publishing a new library version writes a new row and does not touch any document. Each design records its `acceptedVersion` per link. A client with the design open learns that a newer version exists in one of two ways: on open, or over `/realtime` via a small `{t:"library"}` frame carrying only `{ libraryAssetId, version }` and no payload, fanned to the rooms of designs known to reference the item (and through the existing Redis coordinator for multi-instance). The frame is an invalidation hint, never the content, so it costs nothing on the wire and cannot corrupt a document. Accepting an update is a normal editor command: it rewrites the referencing nodes through the `@hc/editor` command framework as one undoable scene-op that fans out over the CRDT like any other edit, which is what keeps concurrent editing safe. A whole-workspace accept across many documents runs as a job, per document, each independently undoable and each validated at the write boundary.

SDK (`@hc/sdk`): typed methods for creative import, import-report retrieval, print export and pre-flight, profile listing and upload, colour conversion, library read/publish/usages, and link acceptance. Pure cores: `@hc/color` gains the ICC parser, the transform engine, intents, proofing, and CIEDE2000; `@hc/print` gains the mark renderer, separations model, ink coverage, and PDF/X rule set on top of its existing geometry and pre-flight; `@hc/export` gains the format writers and the mapping tables; a new pure importer core per format keeps parsing out of both the UI and the handler. The Go side mirrors the colour core in `backend/internal/color` and extends `internal/render/pdf.go` with CMYK, ExtGState, shadings, separations, page boxes, marks, and output intents.

## 9. AI hooks

Everything here runs on the shipped BYO-key layer (`@hc/aistudio`), so on a self-hosted instance no imported artwork leaves the box. The deterministic paths are the default and need no model at all, which matters because an import must work with no AI configured.

- Auto-vectorize on import: when a PSD or TIFF layer is flat line art (detected deterministically from colour count, edge density, and alpha structure), the import report offers to run it through the F41 image-trace path to produce editable paths instead of a pixel layer. It is an offer, never automatic, because a bad trace is worse than an honest raster, and the original pixels are always retained so the choice is reversible.
- Palette extraction: `extractPalette` (median-cut, deterministic, already shipping) runs over every imported document to propose a colour style set, and `nearestPaletteColor` plus deltaE maps each proposed colour to the workspace brand kit so an import can be snapped to brand in one action. No model call is involved.
- Colour matching and spot suggestion: for an out-of-gamut or unnamed colour, the same nearest-match machinery proposes the closest available spot ink or brand colour with its deltaE shown, so the user accepts a number rather than a vibe. Where a model is configured, it adds naming and grouping ("these seven greys are one scale") on top of the deterministic match, never replacing it.
- Layer and component naming: imported files routinely arrive with "Layer 47" and "Group copy 3". A model pass proposes readable names for layers, components, and styles from their content and position; a deterministic fallback derives names from text content and node type when no model is configured.
- Alt text on imported images, feeding `NodeBase.altText` so the tagged-PDF path (which already reads it) benefits immediately.
- Import triage: for a partial import, a model can summarise the fidelity report into a short plain-language account of what to check first. The structured report remains the source of truth and is never replaced by the summary.

## 10. Performance and scale

- The hostile case is real and common: a layered PSD with 400 layers at 8000 by 8000 pixels is roughly 25 megabytes per full-resolution 8-bit RGBA layer, so decoding everything eagerly is out of the question. Layers decode lazily: parse the layer tree and metadata first, decode a downsampled preview per layer for the canvas, and decode full resolution only on demand or at export. Layer pixel data is stored as assets, not inlined in the document, so the design file stays a document.
- Hard ceilings, declared and enforced (FR-23): a maximum input size per format, a maximum decompressed size, a maximum compression ratio, a maximum pixel count and layer count, and a wall-clock budget. Exceeding a ceiling aborts cleanly with a specific message rather than exhausting the process; on the server that protects the whole instance, and on the client it protects the tab.
- Where parsing runs is a performance decision as much as a security one. The default is a browser worker: the file is already in the browser, parsing it there costs the server nothing, and the browser sandbox is the strongest isolation available for free. The server job path exists for headless and API imports and for files too large for a tab, runs under the same limits, and is polled through the existing registry (FR-22). The two paths must not produce different documents, which drives the open question in section 18 about a single parser implementation.
- Colour transforms are the per-pixel cost in the new pipeline. Profile transforms are compiled once into a fast path (concatenated matrices where both profiles are matrix/TRC, and a 3D lookup table with tetrahedral interpolation where a LUT is involved), cached per profile pair and intent, and applied on the GPU where F44 is available. Soft-proofing must not turn a 60fps canvas into a slideshow: the proof transform runs as a post-process over the composited frame, not per drawing operation.
- Library propagation scales with usage, not with library size: a usages index keyed by library asset id keeps "which documents use this" a single indexed query, and accepting an update across many documents is a job that processes them one at a time so a failure affects one document rather than a batch.
- Budgets to commit and prove: a 100-layer PSD opens to an interactive canvas within a stated time; a 200-page PDF imports without exceeding the memory ceiling; soft-proofing holds the editor's existing frame budget on the GPU path and degrades to a stated lower budget on Canvas2D; a print export of a bleed-and-marks document completes within the existing export job budget.

## 11. Security and threat model

Parsing untrusted binary formats is the highest-risk surface this product will ever have. Every other input in HyCanvas is either JSON validated at a boundary or an image handed to a browser decoder. These formats are attacker-controlled binaries with length fields, offsets, compression, embedded programs, and embedded fonts, parsed by code we write, and self-hosters run that code on their own infrastructure. The posture below is a requirement of the feature, not a hardening pass after it.

- Threat model: a hostile file arrives through an upload from any workspace member, through a share link, or through the API. The attacker's goals are remote code execution in the parser, memory exhaustion or CPU exhaustion to deny service to the instance, server-side request forgery to reach the instance's internal network or cloud metadata endpoint, reading files off the host, or crossing a workspace boundary through a crafted reference.
- Decompression bombs: every compressed stream (ZIP entries in an archive-based format, Deflate and LZW and PackBits in TIFF, RLE in PSD, Flate and LZW and RunLength in PDF) is decompressed under a byte ceiling and a ratio ceiling with the counters checked during the decompression loop, not after it. Archive extraction additionally caps entry count and per-entry size and rejects entry names that are absolute or contain traversal segments. The existing `unzip.ts` gains these caps and keeps its `DecompressionStream` implementation.
- Malformed streams and integer handling: every length, offset, dimension, channel count, layer count, and strip pointer read from a file is validated against the actual buffer bounds and clamped at the allocation site before any allocation, following the pattern the codebase already adopted under code scanning for the table axis allocations. Parsers are written to fail closed on a short or contradictory record rather than to guess, and every one of them is fuzzed (section 16).
- Embedded active content: PDF and EPS can carry executable content. `/JavaScript`, `/JS`, `/OpenAction`, `/AA`, `/Launch`, `/SubmitForm`, `/ImportData`, and `/EmbeddedFile` are refused and recorded in the fidelity report as refused (so the user knows the file contained them), never executed and never extracted to disk. PostScript is a programming language, so the EPS subset interpreter runs under an operation-count budget and a time budget with no file, no exec-adjacent, and no device operators available at all, and any file that needs more is declined rather than partially rendered. SVG `<script>`, event handler attributes, `<foreignObject>`, and `javascript:` URLs are stripped; SVG import already goes through a non-DOM parser on the pure path, and the browser path must never inject untrusted SVG into the live DOM.
- External references and SSRF: no importer fetches anything. Images, fonts, colour profiles, and XML entities resolve from within the file or the archive, or they are recorded as missing in the report. Where a remote fetch is genuinely required by a user action, it goes through the existing SSRF-guarded fetch path with its allowlist, not through the parser.
- XML: no DTD processing and no entity expansion, so XXE and billion-laughs are structurally impossible rather than filtered. The existing compact `xml.ts` parser has this property today; the requirement is that it is asserted by test and that no importer introduces a second, more permissive XML parser.
- Fonts: an embedded font in an imported file is an attacker-controlled binary going into a font parser, historically one of the richest exploit classes. Embedded fonts are parsed under the same limits as everything else, are stored as workspace assets rather than installed anywhere, and are never handed to a system font API.
- The sandbox argument, stated plainly. Client-side parsing in a dedicated worker is the preferred default: the browser sandbox is a real security boundary maintained by someone else, the file never reaches the server at all in the common case, and a runaway parser costs the user a tab rather than costing the instance. Server-side parsing is unavoidable for headless and API imports, and there the boundary must be built: a bounded job with a wall-clock and memory budget, no filesystem access beyond the input blob, no network, no database handle, and no workspace credentials in scope, with the process-level isolation available on the deployment. The single-binary constraint rules out spawning a separate hardened runtime by default, which is why the working assumption in section 18 is client-first with a narrowly-scoped server path.
- Write boundary: whatever a parser produces is a document like any other and is validated by `persistence/validate.go` before it persists. A parser that emits a malformed or future-versioned file gets a 422 and nothing is written, which is the same guarantee that already protects the realtime and AI paths.
- Data isolation: profiles, library items, and import artefacts are workspace-scoped at the query layer (FR-26), and an import job carries the requesting workspace id through to every asset it creates.

### Observability and metrics

Import, export, and library handlers emit structured JSON logs keyed by design id, workspace id, user id, job id, and request id, including the source format, byte size, duration, peak memory, and the fidelity counts. Success metrics: import completion rate by format, the ratio of `"succeeded"` to `"partial"` outcomes, the top recorded unsupported features (which is the roadmap for the next phase of fidelity work), pre-flight pass rate on first attempt, print export rejection rate, and library link acceptance latency. Every refused-active-content and limit-breach event is logged at a level an operator can alert on. Org-wide observability and dashboards defer to F38.

## 12. Accessibility and i18n

- Colour signals are never colour alone. The gamut warning mask uses a pattern as well as a colour, out-of-gamut colours are additionally listed as text in the inspector and in pre-flight, and separations preview labels each plate by name. This is a WCAG 1.4.1 requirement and it is also the only usable design for the colour-blind professionals who work in print.
- The import report is a real, navigable, keyboard-operable document with headings and a list structure, not a transient notification, and every row is reachable by keyboard with the associated object selectable from it. A screen reader user must be able to answer "what did this import lose" without sighted help.
- Accessibility metadata survives import where the source has it: PDF `/Alt` strings map to `NodeBase.altText`, and PDF tag structure maps to `Page.readingOrder` where present. Layer names are not promoted to alt text, because a layer name is not a description and inventing alt text is worse than admitting its absence. Where alt text is missing, the a11y checker flags it as it already does, and the AI hook in section 9 can propose it.
- The tagged-PDF path (`pdftag.go`) keeps working through every writer change in this spec, and the PDF/X path does not conflict with it: PDF/X and PDF/UA can be satisfied by the same file, and the export dialog states which conformance levels are being requested.
- Text imported from PSD, PDF, AI, and DXF carries its script and direction: RTL runs stay RTL, CJK stays in its script with the right font metrics through `@hc/text`, and a font substitution that would change script coverage is a warning, not a silent swap.
- Colour profile names, spot ink names, and colour book names are proper nouns and are never translated or transliterated, in any locale. Everything else in the import, colour, print, and library UI is localizable through the F38 i18n layer, including the pre-flight messages, which are user-facing text today generated inside `@hc/print` and will need message ids rather than baked English strings.
- Units follow the document and the user's locale: millimetres, inches, and points are all first-class in the print UI, and `@hc/print` already carries the conversions (`mmToPx`, `pxToMm`, `mmToPt`).

## 13. Import / export and interop

The fidelity matrix is the heart of this document. It states, per format, what we produce, what we knowingly lose, and whether we can implement it cleanly at all. The legal column is not decoration: HyCanvas ships under the Elastic License 2.0 as source-available software that self-hosters build and run, so a copyleft dependency in the default build is not an option, and neither is redistributing licence-restricted colour books or vendor profiles.

| Format | Direction | Native representation | Documented loss | Legal and licensing | Priority |
| --- | --- | --- | --- | --- | --- |
| PDF | Import + export | Pages to pages; text runs to editable text; path operators to `PathNode` with compound contours; XObjects and inline images to `ImageNode`; clips and soft masks to F40 operators; shadings to gradients | Type 3 fonts and text with no ToUnicode import as outlines (report entry); JBIG2 and JPX images rasterize through a decoder or are refused; PostScript-function shadings sample to stops; encrypted PDFs need the user's password and are refused otherwise; annotations and form fields import as static artwork | Clean. ISO 32000 is a published standard, and `pdfjs-dist` (Apache-2.0) is already a dependency. Our own writer is already hand-rolled and dependency-free | P0 |
| AI (Illustrator) | Import only | Read through the PDF-compatible container by the PDF path: paths, type, images, spot inks, layers where the container preserves optional content groups | Live effects, symbols as symbols, gradient meshes, blends, envelopes, and appearance stacks are not in the readable container: they arrive as their rendered artwork with a report entry naming each one; a file saved with PDF compatibility disabled has nothing readable and is refused with that exact message | Clean for the PDF route. The parallel private stream is undocumented and is not reverse-engineered. No `.ai` export: writing a format whose native semantics we cannot read would produce a file that looks native and is not | P0 |
| PSD (Photoshop) | Import; export as PSD-compatible | Layer tree, groups, opacity, blend modes, raster layers (F42), vector shape layers (F41 paths), type layers as editable text, layer masks, vector masks, clipping groups, spot channels | Layer styles map to F40 operators where an equivalent exists and bake where not; smart objects import as their rendered contents plus the embedded source retained as an asset; adjustment layers map where an equivalent operator exists; 32-bit float and duotone import with a stated conversion; some blend modes have no exact equivalent and are approximated with a report entry | Feasible with a clean-room parser: the file format specification is published, the container is documented, and permissively-licensed independent parsers exist as prior art. Export is "PSD-compatible", explicitly not byte-identical, and says so | P0 import, P2 export |
| DXF | Import + export | Entities to native geometry, blocks to groups or component instances, layers to groups, `$INSUNITS` to the document unit so drawings arrive at true scale | Splines convert to cubics within a stated tolerance; hatch patterns map to fills where a match exists, otherwise outline plus report entry; dimensions import as exploded geometry (the parametric dimension is not a HyCanvas concept); 3D entities are refused, not projected; xrefs are not resolved | Clean. The DXF reference is published by its originator and the format is ASCII and parseable clean-room | P1 |
| DWG | Neither | n/a | n/a | Declined. No public specification, and the mature implementations are GPL-licensed, which cannot ship in this binary. The documented answer to a user with a DWG is to export DXF from their CAD tool | Declined |
| TIFF | Import + export | Pages or layers, 8- and 16-bit, Gray/RGB/CMYK/Lab, alpha, embedded ICC profile preserved | Exotic photometric interpretations and rare compressions (old-style JPEG, CCITT variants beyond the common ones) are refused with a specific message; layered TIFF written by other tools imports as its flattened composite plus any readable layers | Clean. The TIFF specification is published, the compressions we need are patent-expired, and `golang.org/x/image` (BSD) already ships a decoder in the binary | P1 |
| EPS | Import only, restricted | Route 1: an embedded PDF or DSC-referenced preview goes through the PDF path. Route 2: a restricted PostScript operator subset (path construction, painting, transforms, colour, simple text) under an operation and time budget produces paths and text | Anything using procedures, loops beyond the budget, custom fonts defined in-stream, or device operators is declined rather than half-rendered; the preview route yields artwork without live text | Constrained. A full interpreter means a copyleft or commercially licensed dependency, which cannot ship by default. The optional route is a user-installed external converter invoked out of process, off by default, with its licence the operator's decision, clearly labelled as not part of the distribution | P2 |
| SVG | Import + export | Existing element coverage plus `use`/`symbol`, `clipPath`, `mask`, `pattern`, `marker`, `switch`, `textPath`, `stroke-dasharray`, and the committed filter primitive set mapped to F40 operators; arcs convert to cubics instead of the current straight-line substitution; export emits filters and clips | Unsupported filter primitives rasterize the filtered subtree with a report entry; SMIL animation is not imported (the animation model belongs to F28 and F43, and a silent drop is not acceptable, so it is reported); CSS is already resolved through computed style, and unsupported properties are reported rather than dropped; conic and mesh gradients approximate to the nearest supported gradient with a report entry | Clean. Open W3C standard | P1 |
| ICC profiles | Import (v2/v4) | Parsed into the transform engine; stored as workspace assets and referenced by id | v5/iccMAX is out of scope; unusual tag combinations fall back to the matrix/TRC path with a warning | The specification is open (ISO 15076-1). We ship only profiles whose licences permit redistribution and let operators install their own profile directory. Vendor press profiles are not bundled | P0 |
| Spot colour books | Import from exchange formats | Named inks with Lab or CMYK values, imported from swatch-exchange files and CxF | Book metadata beyond name and value is not retained | Named ink libraries from ink manufacturers are trademarked and licensed; we ship none and never will by default. We support user-supplied books and file-embedded definitions, which is the legally clean path to the same outcome | P1 |
| PDF/X-1a, PDF/X-4 | Export | Output intent with embedded profile, all fonts embedded and subset, correct page boxes, marks, separations | X-1a requires flattened transparency and no live RGB, so an X-1a export of a transparency-heavy document is a lossy conversion and is reported as one before it runs | Clean. ISO standard, our own writer | P0 |
| PPTX / ODP / diagram formats | Owned elsewhere | See F28 and F30 | n/a | n/a | n/a |

Two cross-cutting rules bind the whole matrix. Import never produces a rasterized dead end as its primary output: where a construct must rasterize, the raster is a child of a named, selectable, reportable object and the original bytes are retained as an asset so the decision is reversible. And export never emits a file claiming a conformance it does not meet: a PDF/X export that cannot satisfy the profile fails with the specific violation instead of producing a file named for a standard it breaks.

## 14. Phasing / milestones

Dependency-ordered. Each phase is independently shippable and each one is useful on its own.

Phase 1: colour correctness (nothing else is trustworthy without it).
- ICC v2/v4 parser and the transform engine in `@hc/color` (matrix/TRC and LUT paths, four intents, black point compensation), plus CIEDE2000.
- The Go mirror in `backend/internal/color` and the shared golden vector table that proves Canvas2D, GPU, and headless agreement (FR-14). This lands before anything depends on it.
- Schema v17 to v18: `ColorValue`, `ColorProfileRef`, `WorkingSpaces`, spot `lab`/`tint`, `AssetRef` colour fields, with the Go mirror bumped in the same change.
- Profile storage as workspace assets, profile-aware image decode on upload, document colour settings UI, colour inspector with converted values and deltaE.
- Soft-proofing and gamut warning on the Canvas2D path, with the pattern-plus-colour mask.

Phase 2: vector-first import (the migration wedge, and the formats that are legally cleanest).
- The PDF operator-list importer replacing the text-only path, producing paths, images, clips, soft masks, and shadings.
- AI import through the PDF route, including the explicit refusal path for files saved without PDF compatibility.
- SVG import completion: `use`/`symbol`, `clipPath`, `mask`, `pattern`, `marker`, and the committed filter primitives.
- DXF import with true-scale units.
- The fidelity report wired end to end: the existing `@hc/media` accumulator called by every importer, persisted in `meta`, and surfaced as a navigable document.
- Import as a job through the existing registry, with the full limit set (FR-23) and the active-content refusals (FR-24) from the first commit, not retrofitted.

Phase 3: print-ready output (the reason a professional can actually use the result).
- Go PDF writer: DeviceCMYK, ExtGState for opacity, real gradient shadings, page boxes for bleed/trim/slug.
- Marks rendering from the existing `cropMarks` geometry, plus registration marks and colour bars.
- Overprint and knockout attributes honoured in output; `/Separation` and `/DeviceN` for spot inks; separations preview and ink coverage on canvas.
- PDF/X-1a and PDF/X-4 with output intents, and the conformance failure path.
- `@hc/print` finally wired into the product: pre-flight surfaced in the UI and gating print exports through `evaluateGate`.
- Schema v18 to v19 for the print attributes.

Phase 4: raster interop (the largest parsing surface, deliberately last among the importers).
- Layered PSD import onto the F42 pixel-layer model and the F40 operator model, with lazy per-layer decode.
- TIFF import with bit depth, alpha, CMYK/Lab, and embedded profiles preserved.
- The EPS restricted routes and the optional out-of-process converter hook.
- Export reciprocals: layered TIFF, PSD-compatible layered output, SVG with filters, DXF.

Phase 5: libraries.
- Schema v19 to v20: `InstanceNode`, `ComponentDef`, `SharedStyle`, `NodeBase.styleRefs`, `LinkedAsset`.
- Workspace library: publish, browse, use, version, usages index, all workspace-isolated at the query layer.
- Components with instance overrides; shared colour/text/effect/stroke styles with detach.
- Linked assets with reviewable, per-document, undoable update acceptance and the `{t:"library"}` invalidation frame.
- Workspace-scoped presets (export, pre-flight, print).

Deferred beyond the phases: the community/shared library and distributable preset packs (section 2), DWG, ICC v5, and native import of the closed cloud design formats.

## 15. Acceptance criteria

These sample representative, testable criteria; a requirement not pinned to a numbered AC here is verified by the section 16 test plan.

- AC-1: A PDF containing vector artwork, text, and images imports to editable native nodes with paths as paths (not outlines of a picture), text as editable text, and images as image nodes; nothing on the page arrives as a single flattened raster (FR-1).
- AC-2: An `.ai` file saved with PDF compatibility imports its artwork and spot inks; the same file saved without PDF compatibility is refused with a message naming that exact cause, and no empty document is created (FR-2).
- AC-3: A layered PSD imports with its layer tree, groups, blend modes, masks, editable type, and vector shape layers intact; a layer style with no operator equivalent is baked and appears as a named row in the fidelity report (FR-3, FR-8).
- AC-4: A DXF drawing in millimetres imports at true scale, blocks arrive as groups or instances, and a spline matches its source within the stated tolerance (FR-5).
- AC-5: A 16-bit CMYK TIFF with an embedded profile imports without bit-depth reduction and without colour conversion to sRGB; the embedded profile is retained and referenced (FR-6, FR-11).
- AC-6: An SVG using `use`, `clipPath`, `mask`, `pattern`, and `feGaussianBlur` imports with each construct represented natively or as a mapped operator; a filter primitive outside the committed set rasterizes only its own subtree and produces a report row (FR-7).
- AC-7: Every import produces a persisted, navigable fidelity report; an import that approximated or substituted anything reports status `"partial"`, never `"succeeded"`; the report is keyboard-navigable and each row selects its object (FR-8, section 12).
- AC-8 (colour accuracy): For a golden set of colours across sRGB, a wide-gamut RGB working space, a CMYK press profile, and Lab, the transform engine matches reference values within deltaE(2000) of 1.0 for all four rendering intents, with and without black point compensation (FR-9, FR-27).
- AC-9 (three-surface parity): The same document rendered by the Canvas2D path, the F44 GPU path, and the Go headless export produces colour values agreeing within deltaE(2000) of 0.5 at every sample point of the shared golden table; breaking the table fails the build (FR-14).
- AC-10: Soft-proofing through a press profile visibly matches the exported PDF's rendering of the same document, gamut warning marks the out-of-gamut regions using pattern and colour, and the inspector reports the converted CMYK value, the deltaE, and an in-gamut suggestion (FR-12).
- AC-11: A spot ink survives the whole pipeline: authored or imported as a named ink, previewed as its own plate, counted in ink coverage, and written to the exported PDF as a `/Separation` colour space rather than converted to process (FR-13, FR-16).
- AC-12: A PDF/X-4 export carries an output intent with an embedded profile, all fonts embedded and subset, correct trim and bleed boxes, and crop and registration marks outside the trim, and it passes a third-party pre-flight tool's PDF/X-4 check; a document that cannot conform fails the export with the specific violation instead of producing a file (FR-17, FR-18).
- AC-13: A CMYK document exports with CMYK ink values in the PDF content stream (not RGB conversions), per-element opacity honoured through ExtGState, and gradients rendered as shadings rather than their first stop (FR-15).
- AC-14 (round-trip fidelity): For each round-trippable format (SVG, DXF, TIFF, PDF geometry), a corpus file imports, exports, and re-imports to a document that matches the first import within stated per-format tolerances (geometry within the format's precision, colour within deltaE(2000) 1.0, text content exact), and every deviation is covered by a row in the section 13 matrix. A deviation that is not documented is a test failure.
- AC-15: A component published to the workspace library, used in eleven documents, and updated once shows an update affordance in each; accepting it is one undoable action per document; instance overrides survive the update; and a detached instance is unaffected (FR-19, FR-20).
- AC-16: A shared colour style edited once restyles every referencing node in one undoable action; a node edited locally detaches from the style and stops following it (FR-19).
- AC-17: A library item, ICC profile, or linked asset from another workspace is not readable, not resolvable, and not enumerable; the reference returns 404 from the query layer and the attempt is logged (FR-26).
- AC-18 (zero data loss): A design carrying colour profiles, print attributes, library references, and component instances opens, edits, saves, exports, and restores from version history on a client one schema version older without losing any of that data; the older client preserves unknown nodes losslessly through `UnknownNode.raw`; and a document created before this feature opens and renders byte-identically after the migration (CLAUDE.md zero-data-loss rules, section 7).
- AC-19: A decompression bomb, a PSD with a layer count field of 2^31, a TIFF with strip offsets outside the buffer, and a PDF with a `/JavaScript` action each fail safely: bounded memory, bounded time, a specific error, nothing written, nothing executed, and a logged event (FR-23, FR-24).
- AC-20: An import running in the browser worker and the same import running as a server job produce equivalent documents from the same input file (FR-25).
- AC-21: Print pre-flight runs before a print export and blocks on un-overridden errors and unacknowledged warnings, with each check naming the offending object (FR-18).
- AC-23: Changing one colour variable updates every node that references it, in one undoable step, across pages, and the change survives save, reload, and export.
- AC-24: A document authored with variables opens on a client that predates them and renders the correct resolved colours rather than empty properties; re-saving there and reopening on a current client restores live references.
- AC-22: No import, export, colour management, print, or library capability is gated behind a paid tier or watermarked, and all of it runs on a self-hosted instance with no external service call (differentiator 1).

## 16. Test plan

Corpus-based testing is the only honest way to test interop, because the specification is not the format: the files real applications write are. The corpus is the deliverable that makes the rest of the plan possible.

- The corpus: a versioned set of real-world files per format, each with a recorded provenance and licence. Three sources, in order of preference: files we author ourselves in each originating application and can therefore redistribute; openly-licensed public conformance and test suites; and, for anything we cannot redistribute, a fixture-generation script plus a checked-in structural digest so the test is reproducible without shipping the file. Each corpus entry carries the expected outcome (node counts by type, colour values, and the exact expected fidelity-report rows), so a change in what an importer loses is a diff, not a surprise.
- Unit (pure cores): `@hc/color` ICC parsing against known profiles, transform maths against reference values per intent, CIEDE2000, gamut and proofing; `@hc/print` geometry, mark generation, ink coverage, pre-flight checks and gate behaviour; each importer's structural parsing against synthetic minimal files exercising each construct; `@hc/schema` migration steps for every bump (older file opens, purely additive, `UnknownNode` preservation, absent-means-today's-behaviour for each new optional field).
- Round-trip golden tests: import, export, re-import for every round-trippable format, asserting the tolerances in AC-14, with the diff attributed to a documented matrix row or failing.
- Colour parity harness: the shared golden vector table evaluated by the TypeScript core, the Go core, the Canvas2D renderer, and the GPU renderer, asserting the AC-9 tolerance. It runs in CI on every change to any of the four, and a mismatch fails the build. This is the same discipline the CRDT fold already uses to keep the JS and Go paths in agreement.
- Fuzzing: a continuous fuzz target per parser seeded from the corpus, asserting no panic, no unbounded allocation, no unbounded time, and no write outside the sandbox. Go parsers use the native fuzzer; TypeScript parsers run under a property-based harness. Every crash found becomes a permanent regression fixture.
- Security tests as first-class cases, not a checklist: a nested-archive bomb, a ratio bomb, a path-traversal entry name, oversized dimension and count fields for each format, truncated streams at every structural boundary, an XXE payload, a billion-laughs entity, an SVG with a script and an external reference, a PDF with `/JavaScript` and `/Launch` and an embedded file, and an EPS that loops. Each asserts a specific error, bounded resources, no side effects, and a log line.
- Backend (Go): import and export jobs through the registry, RFC 7807 on every error path, structured-log assertions, 422 at the write boundary for a malformed importer result, per-workspace isolation on every library and profile query (including the cross-workspace 404 case), and PDF output validated by structural walk plus a third-party pre-flight tool for the PDF/X assertions.
- Frontend and E2E (compose stack, real browsers): the import flow end to end for each format including the report document and its keyboard navigation, colour settings and soft-proofing, separations preview, the print export gate, and the full library lifecycle (publish, use, update, review, accept, undo, detach).
- Performance: the stated ceilings under the section 10 budgets, measured (100-layer PSD to interactive, 200-page PDF within the memory ceiling, soft-proofing frame budget on both render paths), with a regression gate.
- Zero-data-loss verification: a database seeded with pre-change designs is the test bed for every schema bump. Open, edit, save, export, and restore an old version; run a mixed-version session with one client on the previous schema version and one on the new one and assert neither discards the other's data; and confirm a rollback to the previous binary leaves every design openable. A change that touches no schema and no SQL says so explicitly in its report rather than skipping this silently.
- Manual: a print runbook (produce a real job, send the PDF/X to a commercial printer, compare the proof), a migration runbook (bring a real brand system in from each supported format and record what a professional had to redo), and a self-host smoke test proving no external service call during import, colour management, or export.

## 17. Differentiators

- Print-grade colour in a free, self-hostable tool. Product differentiator 5 names "a real vector editor and print-grade CMYK/ICC color built in", and this spec is where the colour half is delivered: ICC working spaces, soft-proofing, gamut warnings, spot inks, separations, and PDF/X, with no tier, no watermark, and no hosted dependency. Colour management of this depth is currently the boundary between free web design tools and paid desktop suites, and the boundary is not technically necessary.
- Import that produces editable objects, enforced as a product rule rather than promised as a feature. Every importer lands native `@hc/schema` nodes, and the one place a raster appears it is named, selectable, reportable, and reversible because the source bytes are retained. Tools that import professional formats overwhelmingly flatten, and the flattening is discovered later.
- The fidelity report. Making loss visible, per object, persisted with the document, and navigable by keyboard is a small piece of engineering and a large piece of trust. The type and its accumulator already ship in `@hc/media`; wiring them turns "it imported" into "here is precisely what changed".
- Colour parity across three renderers, proven in CI. The browser preview, the GPU path, and the headless server export agreeing to a stated deltaE is a property most tools do not have, because most tools have one renderer and a separate export path they hope matches. The codebase already holds itself to this standard for the CRDT fold; applying it to colour is the same discipline.
- Honest interop. Every format has a published row saying what survives, what does not, and why, including the formats we decline and the reason. A user planning a migration can read the matrix before they commit, rather than discovering the ceiling after they have moved.
- Libraries that respect tenancy and respect the editor. Workspace-isolated at the query layer, pull-based rather than push-based, reviewable and undoable per document, with cross-workspace sharing as an explicit copy. A library update cannot silently move objects under a colleague's cursor.
- Self-hosted print production with no service dependency. Pre-flight, separations, and PDF/X run inside the binary, so a print shop or an in-house studio can run the whole pipeline on its own hardware with no per-seat licence and no file leaving the building.

## 18. Open questions and risks

- One parser or two? A browser worker is the right default for security and cost, and the server path is unavoidable for headless and API imports. Writing each parser twice guarantees they diverge, which AC-20 forbids. Three options: write the parsers in TypeScript and run the same bundle server-side under the already-embedded `goja` (the `internal/crdt` precedent, and the cleanest for correctness, but goja's performance on heavy binary parsing is unproven and probably poor for a 400-layer PSD); write them in Go and compile to WebAssembly for the browser (good performance both sides, larger client bundle, more build complexity); or accept a narrower server path where the browser parses and uploads an already-validated `DesignFile` and the server only handles the headless case with a smaller pure-Go parser set. Working assumption: browser-first with the third option, and measure the goja route on a real PSD before committing. This is the first thing to spike.
- CMM implementation. A correct, fast colour transform engine is real work, and the mature open implementation is a C library. Linking it would mean cgo, which breaks the single self-contained binary in exactly the way the CRDT work already rejected a Rust dependency for. Working assumption: implement the transform engine in pure TypeScript and pure Go against the shared golden table, accepting that we support the profile shapes that matter (matrix/TRC and the common LUT tag types) rather than every legal profile. Risk: an unusual profile falls back to the matrix path and is subtly wrong. Mitigation: detect unsupported tag combinations explicitly and warn rather than silently approximating.
- Which profiles ship in the binary. sRGB and a generic Gray are uncontroversial. A default CMYK profile is needed for the product to be useful out of the box, and the freely redistributable press profiles are the candidates, but each one's licence needs reading before it goes in the repo, and the right default differs by region. Working assumption: ship the minimum redistributable set, make the profile directory an operator-configurable path, and make "no CMYK profile installed" a first-class state with a clear message rather than a silent fallback to naive device CMYK.
- Where profile bytes live. Section 7 puts them in workspace assets rather than in the design file, which keeps documents small and avoids duplicating licence-restricted bytes into every export. Risk: a design exported to `.hyc` and opened on another instance loses its profile reference. Mitigation: `.hyc` export bundles referenced profiles by default with a checksum, and an unresolvable profile is a pre-flight error naming the missing profile rather than a silent substitution.
- Component model overlap with F40. A component definition with instances and overrides and a node-graph subgraph with parameters are two ways to say "a reusable parameterised thing". Building both independently risks two competing reuse models in one editor. Open question for the F40 and F45 owners together: is a component a graph node, is a graph a component's internals, or are they deliberately separate concepts with a stated boundary? This must be resolved before Phase 5 starts, not during it.
- Linked-asset updates under concurrent editing. Accepting an update is a normal undoable command through the editor framework, which is what makes it CRDT-safe, but a large component used 300 times in one document produces a large single operation. Risk: an accept becomes a multi-second freeze or an oversized CRDT update. Mitigation to spike: chunked acceptance with a single logical undo entry, and measuring where the practical ceiling is.
- Spot inks on the GPU path. A spot ink is not a colour, it is a plate with an ink model, and the F44 renderer works in RGB like every GPU pipeline. Preview fidelity for spot and overprint on the accelerated path needs a design (render plates to separate targets and composite, or fall back to Canvas2D in separations view). Open until F44's architecture is fixed.
- PSD layer-effect depth. Layer styles are a deep, undocumented-in-detail rendering model. Emulating them exactly is a large project on its own; baking them loses editability. Working assumption: map the effects with clean F40 equivalents (drop shadow, inner shadow, stroke, colour overlay, gradient overlay), bake the rest with a report row, and retain the original layer pixels so the user can rebuild. Revisit after seeing what the corpus actually contains.
- EPS: is the restricted subset worth building at all? It is the format most likely to arrive from an archive and the one we can least cleanly support. The alternative is declining EPS outright and documenting the convert-to-PDF workaround, which is honest and cheap. Decision deferred to Phase 4 with real demand data; the optional out-of-process converter hook is the fallback either way.
- PDF/X-1a versus X-4. X-4 is the modern target and preserves transparency; X-1a is still demanded by some printers and requires transparency flattening, which is a substantial renderer feature in its own right. Working assumption: X-4 first, X-1a only if the flattener is needed for another reason, with the export dialog stating plainly which conformance levels this build supports.
- Job infrastructure. This spec puts long, memory-hungry, failure-prone work through a registry that is a process-local map with no queue, no retry, no progress, and no persistence across a restart, and whose usual caller runs the work inline. An import that dies with the process leaves the user with a job id that no longer exists. Open question: does Phase 2 harden the registry (a persisted job row, progress, retry, resumability) or accept the limits and document them? Working assumption: add progress and the async pattern in Phase 2 because import is unusable without them, and defer persistence and retry until the failure rate on the real corpus says whether they matter.
- Corpus licensing. The most valuable test files are real client work and application-authored samples we cannot redistribute. Risk: the test suite is weakest exactly where the formats are hardest. Mitigation: author our own corpus in each application, prefer openly-licensed conformance suites, and use checked-in structural digests plus generation scripts for anything else, accepting that the corpus grows over time rather than arriving complete.
- Scope honesty. This document specifies more work than any other single roadmap item: an ICC engine, five importers, a print-production PDF writer, and a library system. The phases are ordered so each one is independently valuable and shippable, and colour correctness comes first because everything downstream is untrustworthy without it. If only Phase 1 and Phase 2 ever ship, the product is meaningfully better; that is the test each phase boundary is drawn to satisfy.
