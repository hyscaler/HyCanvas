# F28: Presentations (beat PowerPoint)

| Field | Value |
| --- | --- |
| Feature ID | F28 |
| Phase | 3 Collaboration |
| Sequence | 28 |
| Status | Core shipped (presentations as the multi-page editor: `Page` present fields in `@hc/schema` with `notes`/`transition`/`autoAdvanceMs`/`hidden`, the typed F25 animation model `NodeAnimation`/`AnimationClip`/`KeyframeTrack`/`Interaction`/`ImageMotion`/`PageTransition`, the pure shared `@hc/engine` playback core `animation.ts`/`pose.ts` driving editor Play preview, present mode, and animated export identically, the `PresentMode.tsx` runtime with 9 transitions including a real id/name-matched Magic Move morph, laser/pen/spotlight/zoom/blank, autopilot, a single-window presenter HUD with rehearsal timer, `lib/present.ts` slide/timer math, `PagesBar.tsx` slide management, F39 AI Creative Studio prompt-to-deck, charts/tables, sharing + per-page engagement insights, and image/PDF/SVG/APNG/GIF export). This spec owns the remaining and ambitious work to make HyCanvas the best presentation tool on the market: PPTX import/export round-trip, slide masters/layouts/themes, a true second-display presenter view, present-and-record + full-deck video, live audience interaction (Q&A/polls/reactions/captions), AI design autopilot and whole-deck AI, charts bound to live data, accessibility leadership, and 60fps present at scale. |
| Depends on | F25 (animation/timeline primitives this builds on), F39 (AI Creative Studio / `@hc/aistudio` BYO-key layer), `@hc/schema` (open file format + forward migration), `@hc/engine` (Canvas2D scene-graph + animation core + planned WebGL/WebGPU path), F11 (export encoders + Go render engine), F16 (realtime/CRDT, presence, comments, sharing), F38 (accessibility/i18n/security/NFR) |

A free, self-hostable, AI-native presentation tool that beats PowerPoint, Keynote, Google Slides, Canva, Gamma, Beautiful.ai, and Pitch on every axis that matters: the full deck-delivery suite shipped ungated (presenter view, present-and-record, audience Q&A/polls/reactions, captions, analytics, brand kits, custom fonts, and AI deck generation all with no tiers, paywalls, or watermarks, where competitors gate exactly this), every AI/generated/imported slide landing as editable native scene-graph nodes in the open `@hc/schema` format (never a flattened render or a locked proprietary blob, so AI decks stay fully editable, exportable, forward-migratable, and runnable on-prem), one pure framework-agnostic `@hc/engine` animation core that already renders identically in editor preview, present mode, and headless export (no incumbent ships a free, self-hostable, WYSIWYG-correct animation engine), Magic Move morph done right on stable schema node ids, AI deck generation and design autopilot on a BYO-key/self-host model layer with no markup and no data egress, and accessibility as a category lead. HyCanvas already ships a strong presentations base; this spec closes the table-stakes interop and delivery gaps, then leaps ahead.

## Current state

Audited against the code: `packages/schema/src/schema.ts` (`Page` present fields at 1517-1549, `PageTransition` 449-459, `EntrancePreset`/`ExitPreset`/`EmphasisPreset` 333-341, `AnimationClip`/`AnimationStartMode` 343-368, `Keyframe`/`KeyframeTrack` 370-405, `NodeAnimation` 407-421 on `NodeBase.animation` 622, `Interaction`/`InteractionAction` 423-447, `ImageMotion` 461-469, `ChartNode`/`TableNode`, `VideoNode`/`AudioNode` 1092-1131) + `migrate.ts` (`currentSchemaVersion = 13`); `packages/engine/src/{animation,pose}.ts` (`entrancePatch`/`exitPatch`/`emphasisPatch`/`customPatch`/`imageMotionPatch`/`evalEasing`/`cubicBezierEase`, `poseDesignAt`/`sequenceStarts`/`revealEntranceText`/`pageAnimationDuration`); `packages/engine/src/transition.ts` (`renderTransition`/`morphPlan`/`lerpNode`); `frontend/src/components/editor/PresentMode.tsx` (`compositeTransition`, `runInteraction`, autopilot, laser/pen/spotlight/zoom/blank overlay, `JumpPalette`, `PresenterHud`, `RehearsalTimer`); `frontend/src/lib/present.ts` (`visibleIndices`/`seekVisible`/`dwellMs`/`spotlightGeom`/`RehearsalTimer`/`formatClock`); `frontend/src/components/{SharedViewer,DeckPlayer}.tsx`; `frontend/src/components/editor/{PagesBar,PropertiesPanel,ExportDialog,EditorPanels,ShareDialog}.tsx`; `frontend/src/store/editor.ts` (`addPage`/`duplicatePage`/`movePage`/`setPageNotes`/`setPageTransition`/`setNodeAnimation`/`magicAnimatePage`/`playAnimations`/`buildDeckFromOutline`/`magicResizePages`/`insertChartData`/`applyBrandFixes`); `packages/aistudio/src/{outline,deck,layout,theme,transform,assistant,quality,prompts}.ts`; `packages/export/src/{apng,gif,lottie,svg,dimensions}.ts`; backend `internal/render/{raster,pdf,svg,video}.go`, `internal/aistudio`, `internal/sharing`, `internal/comments`, `internal/engagement` (`useViewBeat.ts` + insights), `internal/realtime/*.go`, `internal/persistence/file.go`.

Presentations are the multi-page editor, not a bespoke deck engine. Each slide is an ordinary `@hc/schema` `Page` carrying present metadata; every node may carry a typed `NodeAnimation` (entrance/exit/emphasis presets plus a custom keyframe timeline with freeform cubic-bezier easing and cross-element start-modes) and an `Interaction` (click/hover to navigate or open a link); each `Page` carries a `PageTransition` (10 types incl. Magic Move morph); `ImageNode` carries `ImageMotion` (Ken Burns / parallax). The defining structural strength is that one pure, allocation-light playback core (`@hc/engine` `animation.ts`/`pose.ts`) computes a per-node patch at time `t` and is the single source of truth shared by editor Play preview (`playAnimations`), the present runtime (`PresentMode.tsx`), and animated export (`poseDesignAt`), so the same animation renders identically in the browser and headless. `PresentMode.tsx` is a capable present runtime: visible-slide navigation that skips hidden slides, 9 transitions including a real id-then-unique-name matched Magic Move morph, entrance/exit/emphasis/custom playback with sequencing and typewriter/word-wipe reveals, photo motion, autopilot + kiosk loop, a separate-overlay magic-tools layer (laser, ephemeral pen with color/width/undo/clear, spotlight, zoom-to-cursor, B/W blank), a jump palette, and a presenter HUD with a rehearsal timer. F39 AI Creative Studio does agentic outline-first prompt-to-deck producing native editable pages, plus per-slide auto-layout by role, N style variations, brand grounding, Magic Switch/Resize/Charts/Animate, and critique-and-improve. Sharing ships role-based links with password/expiry, and `useViewBeat` + the engagement service give real per-page viewer analytics (unique named + anonymous, duration, per-page time).

The honest gaps: PPTX now round-trips: EXPORT (`deckToPptx` in ExportDialog: editable text/shapes/images/notes, raster fallback for the rest) and IMPORT (`pptxToDesign`, the dashboard Import tile accepts .pptx: editable text/shapes/images/backgrounds/notes with theme-color resolution, plus real PowerPoint tables (`p:graphicFrame` + `a:tbl`) as editable `TableNode`s; charts/SmartArt/embedded objects have no native equivalent yet and import as a labelled placeholder in position rather than disappearing; animations and master inheritance flatten). Keynote/Google/ODP formats remain; the slide master/layout/placeholder model and the swappable `Theme` record ship (FR-3/FR-4, schema v11), and the editor now drives them (save a page as a layout, link pages, update-and-sync), though no theme-swap UI yet; the true second-display presenter view ships (FR-15: audience window + BroadcastChannel, wall clock, teleprompter); the transition compositor is now a pure `@hc/engine` helper (FR-13 shipped), and the web player and animated export (APNG/GIF) now consume it, so a deck exports its whole playthrough with transitions; the server now renders full video timelines with a Go animation core (`render/anim.go`), and a deck exports to MP4 in one click (Export -> Video: `deckToVideoFile` + the export handler's inline-file override), and present-and-record now ships in present mode (slides + ink + mic narration to a local .webm; camera bubble remains); LIVE AUDIENCE now ships too - share-link viewers (anonymous OK) ask and upvote questions, vote on presenter-launched polls, and send emoji reactions that float over the presenter's slides live (`internal/audience` + share-token routes + the AudiencePanel/PresenterAudience drawers), with the anonymous side guarded: a per-caller-and-token write budget (429 past it), a voter-key length cap, a per-design question ceiling, and a short-lived cache of SUCCESSFUL password resolutions so a room full of polling viewers does not re-run scrypt every few seconds (failures are never cached, so guessing stays expensive), with captions still deferred to the AI-media pipeline, and presenter-driven slide-follow now shipped (the DeckPlayer follows the live presenter; the presenter republishes on a 10s heartbeat so a slide held longer than the staleness window does not drop the audience); charts and tables now bind to live data (inline CSV or a URL through the SSRF-guarded `/data/fetch` proxy, refreshed on open and on demand) and bulk data-merge ships in-deck (one slide per CSV row with {{token}} substitution). The alt-text/reading-order model ships (FR-29, schema v12) with the checker honoring it, the Reading Order pane driving keyboard Tab navigation, AND a tagged, selectable-text PDF export (`render.go` `?page=all` + `taggedPdfUrl`, surfaced in ExportDialog). AI now does whole-deck translation, AI speaker notes (assistant tools `translateDeck` / `generateSpeakerNotes`), AND document/URL/file-to-deck ingestion (attach pasted text, a web page via the SSRF-hardened `/ai/extract-url`, or a .txt/.md/.pdf file; the outline grounds strictly in it). This spec is the forward-looking plan for all of that.

Status legend: **Built** (ships today, code-referenced), **Partial** (some of it ships, gaps noted), **Planned (doc 16)** (depends on F16 realtime work tracked there), **Not started**.

A reference-implementation leverage map for the remaining AI/generation work (two audited open-source codebases plus a market R&D spec, with a code-drift repair list) is maintained in [`28-presentations-leverage.md`](28-presentations-leverage.md).

## 1. Context and Goal

HyCanvas ships a strong presentations base, but "beat PowerPoint" sets a bar far higher than a working slide editor. PowerPoint owns the universal `.pptx` format, Morph, slide masters, Designer auto-layout, Cameo, Recording Studio with teleprompter, Speaker Coach, Live Presentations with translated captions, and a tagged-PDF accessibility pipeline; most of its AI sits behind M365 Copilot licensing. Keynote owns Magic Move, film-grade transitions, multi-source live video, multipresenter control, and movie export, but has no native generative AI. Google Slides owns Workspace integration, audience Q&A with upvotes, live captions, linked-Sheets charts, present-to-Meet, and web publish/embed. Canva owns template breadth (its single biggest moat), Magic Design, Magic Animate, Present-and-Record, Canva Live, Bulk Create, and live-linked data, but caps free AI and gates exports. Gamma owns sub-60-second prompt-to-deck, flexible web-native cards, publish-as-website, and per-card analytics, but its PPTX/PDF export is paywalled and lossy. Pitch owns multiple tracked per-audience links and per-slide engagement analytics. Beautiful.ai owns rule-based adaptive smart slides. Every one of them stores deck content in a closed format where AI and imported slides flatten to dead-ends, gates the delivery suite behind tiers, or both.

HyCanvas's opening is structural. Deck content is the open `@hc/schema` format (`currentSchemaVersion = 13`) with forward migrations and lossless `UnknownNode` round-trip, so every AI generation, PPTX import, and template lands as editable native nodes, fully exportable and runnable on-prem; this directly attacks Gamma's lock-in and the export gap that stalled Tome's adoption. The shipped `@hc/engine` animation core is a moat no incumbent has: a single pure, framework-agnostic playback layer that renders the same in editor preview, present mode, and headless export, with 11 entrance / 6 exit / 8 emphasis presets, 9 easings plus freeform cubic-bezier, per-element keyframes, sequencing, and text reveals. Magic Move already matches shared elements by stable schema node id (`@hc/engine` `morphPlan`/`lerpNode`), which the open format makes higher-fidelity than PowerPoint's heuristic name matching and which Google Slides lacks entirely; it already beats two of four mainstream incumbents today. The F39 AI Creative Studio gives a BYO-key, multi-model, self-hostable layer to build deck generation and design autopilot on, so deck data never leaves a self-hosted instance and AI costs no markup. Per-page engagement analytics already ship via view-beats, an axis where PowerPoint/Slides/Keynote have nothing. Everything ships free and unwatermarked. Note: HyCanvas is deliberately web-only (no native iOS/Android/iPad client); the phone-as-remote and audience-companion work in this spec are how a presenter's and an audience's phones participate, substituting for the absent mobile apps.

Intended outcome: a user pastes a brief or a URL and gets an editable, on-brand, methodology-correct deck in one step; refines copy and layout with a conversational assistant on their own model key; runs it from a true second-display presenter view with notes, next-slide preview, a teleprompter, and a wall clock while the audience sees a clean projection; an in-room and remote audience joins by QR to ask upvoted questions, answer a live poll, and read translated captions; the presenter records the live run (slide + narration + camera bubble + ink/laser) to a shareable video; later imports a colleague's `.pptx` losslessly and exports the finished deck back to `.pptx`, to an accessibility-tagged PDF, and to a narrated MP4 with synced animations and transitions, then watches per-slide dwell analytics roll in from a tracked share link, all free, fully accessible by keyboard and screen reader, at 60fps, on their own self-hosted instance.

## 2. Scope

In scope:
- The present runtime and delivery suite: a true second-display presenter view, teleprompter, wall clock, phone-as-remote, reduced-motion present mode, hyperlink-only kiosk navigation, a real web player link, and present-and-record. This is the "document-type-specific delivery nuances for presentations" beyond base co-edit.
- Slide structure: slide master / layout / placeholder model, a first-class swappable Theme record, slide sections, and a grid/outline overview editing view.
- Interop: PPTX import and export round-trip (the universal format), Keynote/Google Slides/ODP/PDF/Markdown-Marp-Slidev import, MP4/WebM full-deck video export with synced animations + transitions + narration, GIF, and images, all to/from the open format.
- Motion and transition leadership: lifting the transition compositor into a pure `@hc/engine` helper (so export and the web player can render transitions), a page-level animation build-order timeline, motion paths, extra keyframe channels, eased/spring and nested/grouped/text-glyph Magic Move, richer text builds, configurable transitions, and richer interaction triggers (run-animation, play-media, overlay).
- Audience interaction: an audience-facing live present share, live Q&A with upvote/moderation, polls/word-clouds/quizzes, per-slide emoji reactions, and live captions with AI translation, over the shipped `/realtime` relay.
- AI for decks built on `@hc/aistudio`: design autopilot / smart-slide auto-layout, AI rewrite/condense/translate including whole-deck translation, AI speaker notes, batch per-slide image generation, theme generation, chart-from-data, and document/URL/file-to-deck ingestion.
- Data-driven slides: charts bound to a live data source with refresh-on-present, chart-from-uploaded-file, and a bulk data-merge slide pipeline.
- New present-related node types and additive schema enrichments (slide master/layout/theme, sections, motion-path channel, per-slide narration, live camera, chart data-binding, alt-text/reading-order, interaction triggers, poll node) plus their forward migrations.
- Present-specific performance (60fps present, prefetch/precompute next slide, large decks) and presentation accessibility (alt text, reading/tab order, slide titles, in-canvas WCAG checker, tagged-PDF export, reduced-motion).

Out of scope (owned elsewhere):
- The CRDT data model, base sync protocol, base presence, base per-element lock mechanics, base comment system, and history/branch/restore (F16 owns these; this spec extends them with present-along and audience-interaction frame types and authoritative stores).
- The AI provider-adapter layer, key storage, model routing, and reproducibility (F39 / the `@hc/aistudio` layer; this spec consumes it).
- The base export encoders and the Go render engine (F11 / `@hc/export`; this spec maps decks to those encoders and adds PPTX and full-deck video).
- The animation/timeline primitives themselves (F25 owns `NodeAnimation`/`AnimationClip`/`KeyframeTrack`/`ImageMotion`/`PageTransition`; this spec extends them with new channels, build-order UI, and a pure exportable transition compositor).
- Cross-cutting SSO/SCIM/observability/compliance/self-host NFR (F38; this spec adds the player-link, audience-session, and accessibility requirements that hook into it).
- The engine's general WebGL/WebGPU path (the engine roadmap owns the GPU backend; this spec specifies the present/transition/large-deck needs that ride on it).

Deferred:
- AI voice / TTS narration and AI avatar presenters (Synthesia/HeyGen/Canva AI Voice class), pending an audio/TTS pipeline (tracked under `23-ai-media.md`).
- On-slide live camera (Cameo-style first-class node) beyond a present-and-record camera bubble, pending a media-presence layer.
- Non-linear / Prezi-style continuous-canvas zoom presenting (architectural; transitions are pairwise full-frame composites today). Hyperlink-only kiosk navigation covers the interactive/branching need first; continuous-canvas zoom is a spike.
- Publish-as-standalone-website / custom domain (Gamma microsite), pending the website feature; the web player ships first.
- Web-research deck agent with citations, pending an assistant research tool.
- Template-library breadth as a content moat: the catalog (vs Canva's thousands) is an ongoing content investment tracked with `@hc/templates`, not a code milestone here.
- Add-ons / automation API for programmatic deck generation, pending an integrations layer.

## 3. User Stories

- As a PowerPoint user, I want to import my existing `.pptx` and later export back to `.pptx` losslessly (text, animations, notes, masters preserved), so adopting HyCanvas does not strand my decks or my collaborators.
- As a presenter, I want a true second-display presenter view with notes, next-slide preview, a teleprompter, a timer and a wall clock, and a phone-as-remote, so I can deliver confidently on any projector.
- As a presenter, I want to record the live run (slides + narration + my camera bubble + ink/laser) to a shareable video, and export the deck as a narrated MP4 with synced animations and transitions, ungated.
- As an audience member, I want to scan a QR code to follow the deck on my phone, ask an upvoted question, answer a live poll, and read captions in my language.
- As a deck author, I want to paste a brief, a URL, or a document and get an editable on-brand deck, then have AI write speaker notes, translate the whole deck, and lay each slide out by role, all on my own model key.
- As an analyst, I want native charts bound to a live data source that refresh on present, and a bulk pipeline that turns a CSV into one slide per row, so report decks build themselves.
- As a designer, I want a slide master/layout/theme system and adaptive smart-slide auto-layout, so the whole deck restyles in one click and stays balanced as content changes.
- As a screen-reader user, I want alt text on every object, a defined reading order independent of z-order, guaranteed slide titles, an authoring-time accessibility checker, accessibility-tagged PDF export, and a reduced-motion present mode.
- As a sales/investor presenter, I want multiple tracked per-audience player links with per-slide dwell analytics on my own infrastructure, so I know which slides held attention.
- As a privacy-sensitive team, I want AI deck generation, translation, and the speaker coach to run without any deck or audio data leaving our self-hosted instance.
- As a large-deck author, I want a 200-slide deck with many animated objects to present at 60fps with the next slide precomputed.

## 4. Feature matrix / scope

The heart of this spec. Status values: **Built**, **Partial**, **Planned (doc 16)** (depends on F16 work tracked in `16-realtime-collaboration.md`), **Not started**.

### Slides and structure (masters / layouts / themes / sections)

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Per-slide present fields (notes, transition, auto-advance, hidden) | Built | `schema.ts:1517-1549` (`Page`); `editor.ts` `setPageNotes`/`setPageHidden`/`setPageTransition`; `PropertiesPanel.tsx` `PagePresentSection` | Notes plain string only; auto-advance + hidden + transition all ship and undoable (FR-1). |
| Slide list management (add/dup/reorder/delete/rename/hide, preset sizes) | Built | `PagesBar.tsx`; `editor.ts` `addPage`/`duplicatePage`/`movePage`/`deletePage`/`setPageName`/`setPageHidden` | Live engine thumbnails, drag reorder, per-slide hide badge, add-with-preset-size. Flat list only; no virtualization. |
| Slide master / layout hierarchy (master -> layouts -> slides) | Built | `SlideMaster`/`SlideLayout`/`Placeholder` + `Page.layoutId` in `schema.ts` (v11); `editor.ts` `savePageAsLayout`/`applyLayoutToPage`/`updateLayoutFromPage`/`syncLayoutPages`; `PropertiesPanel` "Slide layout" section | Materialization model: save any page as a layout (auto master, title = largest text), link pages to it, edit-and-sync pushes background + placeholder changes to every linked page. Applying is idempotent (placeholder-tagged nodes) and never deletes page content (FR-3). |
| Placeholders + built-in layouts (title/content/two-content/comparison/picture) | Partial | `Placeholder` in `schema.ts`; `applyLayoutToPage` materializes placeholder text boxes tagged `data.placeholderId` | Placeholders ship via the layout model (roles inferred on capture: title/body); no built-in layout gallery yet, layouts are user-captured from pages (FR-3). |
| Theme record (palette + heading/body font pair + effect styles, swappable) | Partial | `Theme` record in `schema.ts` (v11); `DesignFile.palette`/`fonts`; AI `DeckTheme` in `aistudio/src/{outline,theme}.ts` | The first-class `Theme` record ships in the schema (FR-4) but no editor UI swaps a deck's theme yet; brand apply and AI `DeckTheme`s cover restyle today. |
| Slide sections / chapters (group, collapse, reorder) | Built | `DesignFile.sections` + `Page.sectionId` in `schema.ts`; `sections.ts` helpers; `PagesBar` section chips | Named, collapsible sections group the slide strip; collapse is a view preference and never hides a slide from the deck. FR-5. |
| Grid / outline overview editing view (light table) | Built | `SlideOverview.tsx`; shared `SlideThumb.tsx` | Full-surface overview with grid and outline views, grouped by section, drag to reorder through the same undoable `movePage`. Opens from the editor overflow menu. FR-5. |
| Background styles (per-slide / theme, solid/gradient/picture) | Built | `Page.background` in `schema.ts`; `PropertiesPanel` background controls | Per-page background ships; theme-level background cascade is part of the missing theme model. |
| Slide size / page setup (16:9, 4:3, custom) | Built | `PagesBar` add-with-preset-size; `Page.width`/`height` | Per-page sizing + presets ship; Magic Resize re-lays out at new size. |
| Reuse slides / slide library (match destination theme) | Not started | n/a | No cross-deck slide insertion preserving-or-matching theme (PowerPoint Reuse Slides). Lower priority; templates partly cover. |
| Font embedding in file (portability) | Partial | `DesignFile.fonts`; brand fonts via `@hc/aistudio`; `applyBrandFixes` `editor.ts:3501` | Brand fonts can be applied; no font-embedding-in-file portability story for the open format (Keynote/PowerPoint embed fonts). |

### Content and data-driven slides (charts / tables / data autoflow / bulk merge)

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Native charts (`ChartNode`) | Built | `ChartNode` in `schema.ts` (bar/line/area/pie/donut/scatter/radar) | 7 chart types as native nodes. Static data only. |
| Tables (`TableNode`) | Built | `TableNode` in `schema.ts` | Native table node ships. |
| Magic Charts (NL / table text -> editable chart) | Built | `aistudio/src/transform.ts` `normalizeChartSpec`/`chartSpecJsonSchema`; assistant `insertChart` tool (`EditorPanels.tsx` resolve/apply); `editor.ts` `insertChartData`; `generate.go` `Chart` | NL or pasted table -> validated `ChartSpec` -> native `ChartNode`. The dedicated chart panel was removed in the panel-to-chat consolidation; the assistant tool is the surface. |
| Live data-linked charts (Sheets/CSV/connector, refresh-on-present) | Built | `DataBinding` on chart/table nodes in `schema.ts`; `editor.ts` `refreshBinding` + `PropertiesPanel` `DataBindingControls` (inline CSV or URL + Refresh); backend `POST /data/fetch` (SSRF-guarded CSV/JSON proxy in `extracturl.go`); `EditorApp` auto-refreshes URL-bound nodes on design open | Charts/tables bind to a URL (CSV or JSON) or inline CSV; refresh on demand and automatically on open. Direct fetch first, server proxy fallback for hosts without CORS; the proxy validates every redirect hop and DIALS the address it validated (pinned dialer, shared policy with the uploads import path) so DNS rebinding cannot reach an internal host, and refuses an oversized source rather than truncating it into a half row. No third-party connector (Sheets API) auth yet (FR-8). |
| Chart from uploaded data file (CSV/XLSX) | Partial | `DataBindingControls` inline CSV; Magic Charts pasted-table path | CSV paste/URL-bind to a chart ships; no XLSX parsing or file-picker-to-chart flow yet (FR-8). |
| Table / data autoflow (rule-based reflow as content changes) | Not started | n/a | No Beautiful.ai-style adaptive layout that recomputes spacing/hierarchy live. AI re-layout (`recomposeSpec`) exists but not live rule-based reflow. P2 (FR-7). |
| Bulk create / data-merge (CSV row -> slide) | Built | `editor.ts` `bulkMergePages`; `EditorApp` overflow menu "Bulk slides from CSV" | Pick a CSV: each row clones the active slide with `{{header}}` tokens substituted in text runs and stickies, fresh node ids, one undo step, capped at 100 rows. Complements the dashboard-level bulk create (F27) with in-deck merge (FR-9). |
| SmartArt-style bullets-to-graphic conversion | Not started | n/a | No automatic list-to-diagram/timeline/process conversion (PowerPoint Designer, Plus AI Remix). Could ride the `@hc/aistudio` layout engine. |

### Transitions

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Page transitions (9 types incl. flip/zoom/wipe) | Built | `packages/engine/src/transition.ts` `renderTransition`; `PageTransition` `schema.ts:449-459`; `PageTransitionSection` | fade, dissolve, slide, push, morph-lite, wipe, flip, zoom, morph. Direction for slide/push/wipe; per-page duration; transition belongs to the arriving slide (on-enter only). |
| Transition compositor is pure + exportable (in `@hc/engine`) | Built | `packages/engine/src/transition.ts` (`renderTransition`/`morphPlan`/`morphDesignAt`/`morphHiddenIds`/`lerpNode`); `PresentMode.tsx` `compositeTransition` is a thin browser adapter | Pure and framework-agnostic (CanvasLike only), so present mode, the web player, and headless export composite identically. Magic Move stays pure by splitting: the helper plans/tweens, the caller renders the tweened layer. Unknown types degrade to the arriving slide. 22 engine tests pin every type. Unblocks the web player and deck-to-video (FR-13). |
| Per-transition easing / curve control | Not started | n/a | Easing hardwired to ease-in-out in `renderTransition`; add a selectable per-transition curve (additive `PageTransition` field). P2 (FR-13). |
| Apply transition / animation to all slides | Not started | n/a | No bulk apply-to-all op given the per-slide-only transition model (PowerPoint apply-to-all). |
| Exit / asymmetric transitions | Not started | n/a | Transition applies only on enter; no separate exit transition. P3. |
| 3D / cinematic transitions (cube, gallery, doorway, page-curl) | Not started | n/a | `flip` is a 2D x-scale squash, not perspective. Keynote/PowerPoint ship 40+ incl. 3D. Needs the WebGL path. P2 (FR-13, Phase 5). |
| Transition picker UX (gallery / preview swatches) | Partial | `PageTransitionSection` is a bare `<select>` | Works but no categorized gallery / live preview. P3. |
| Non-linear / zoomable continuous canvas (Prezi-style) | Not started | n/a | Transitions are strictly pairwise full-frame composites; no infinite-canvas zoom between scenes. Deferred (see open questions). |

### Animations and motion (presets / timeline / motion paths / build order)

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Pure shared playback engine (WYSIWYG across preview/present/export) | Built | `engine/src/animation.ts` + `pose.ts` (`AnimPatch`, `compose`, `poseDesignAt`) | Single source of truth driving editor Play, present, and animated export identically. The major structural moat: no incumbent ships a free, framework-agnostic, headless-WYSIWYG engine. |
| Entrance presets (11) | Built | `animation.ts` `entrancePatch`; `EntrancePreset` (333-341) | fade, rise, pan, pop, drift, breathe-in, typewriter, word-wipe, tumble, stomp, zoom-in. |
| Exit presets (6) | Built | `animation.ts` `exitPatch` | fade-out, sink, pop-out, drift-out, tumble-out, zoom-out. Not sampled by export (`poseDesignAt` does entrance+emphasis+custom only). P1 gap for deck-to-video (FR-19). |
| Emphasis (looping) presets (8) | Built | `animation.ts` `emphasisPatch` | pulse, wiggle, spin, breathe, tada, flicker, jiggle, bob. |
| Easings (9) + freeform cubic-bezier override | Built | `animation.ts` `evalEasing`/`cubicBezierEase`; `Easing` (330) + `AnimationClip.bezier` | Full CSS-style bezier solver; spring is a fixed closed-form curve (no stiffness/damping params); UI exposes a 4-number bezier but no graphical curve editor. |
| Per-element custom keyframe timeline (F25) | Built | `animation.ts` `customPatch`; `KeyframeTrack`/`Keyframe` (370-405); `KeyframeEditor` | Channels limited to dx/dy/scale/rotate/opacity; no color/size/skew/filter channels (FR-12). |
| Cross-element sequencing / start modes (delay/with/after-previous) | Built | `pose.ts` `sequenceStarts`; `AnimationStartMode` (343-346) | Only build-order mechanism; implied by sibling order. No explicit per-build index or animation groups. |
| Text reveals (typewriter / word-wipe) | Built | `pose.ts` `revealTextContent`/`revealTextWords`/`revealEntranceText` | Per-character and per-whole-word only; no per-line/paragraph/bullet, fade-by-word, character cascade, or chart by-series/category sequencing (FR-11). |
| Page-level animation build-order timeline (Animation Pane / Build Order) | Partial | `PropertiesPanel.tsx` `AnimateSection` `startMode` + single-element `KeyframeEditor` | Sequencing is a per-element `startMode` select; there is NO single strip showing every element's entrance order. PowerPoint Animation Pane / Keynote Build Order parity missing. P0 (FR-10). |
| Motion paths (follow a curve, orient-to-path) | Not started | n/a | `AnimPatch` carries only dx/dy/scale/rotate/opacity; no path channel and no motion-path node. Keynote/PowerPoint ship custom paths. P2 (FR-12). |
| Animation triggers tied to media bookmarks | Not started | n/a | No syncing an animation to a timestamp in audio/video (PowerPoint media bookmarks). Pairs with run-animation interaction + per-slide narration (FR-12, FR-16). |
| Animation Painter (copy animation set between objects) | Not started | n/a | No copy-animations-to-another-object affordance. P3. |
| Magic Animate (one-click whole-page build-in) | Built | `editor.ts:2069` `magicAnimatePage`; `AnimateSection`; assistant `animatePage` tool | Heuristic staggered entrance + transition across all elements; also assistant-callable. Matches Canva Magic Animate intent. |
| Configurable spring physics (stiffness/damping/mass) | Partial | `animation.ts` spring easing fixed `omega=8, zeta=0.32` | Deterministic faked spring only; no per-element spring params and no spring on morph (linear interp). P3. |
| Custom keyframe channels beyond transform/opacity (color/size/skew/filter) | Not started | n/a | Cannot keyframe fill/stroke/blur/size/text. Structural ceiling is `AnimPatch`'s 5 channels (see open questions). P2 (FR-12). |

### Magic Move / morph

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Magic Move morph (id then unique-name matched element tween) | Built | `PresentMode.tsx` `morphPlan` + `lerpNode` + `renderTransition` case `morph` | Matches shared elements by node id, falls back to unique name (survives duplicate-then-move). Tweens transform+size+opacity over a crossfade. Already a real differentiator on stable schema ids; already beats PowerPoint heuristic matching and Slides (none). |
| Nested / grouped element morph matching | Not started | n/a | Top-level children only; no nested/group matching. Keynote matches deeper. Recursive matching in `morphPlan`. P1 (FR-14). |
| Eased / spring per-element morph | Not started | n/a | Interpolation strictly linear (`lerpNode`); no per-element easing/spring for morph motion. P2 (FR-14). |
| Text glyph-level morph | Not started | n/a | No character-by-character text morph (Keynote Magic Move / PowerPoint Morph word/char level). P2 (FR-14). |
| Shape / path / fill / gradient / color morph | Not started | n/a | No shape/path morphing and no color/fill/gradient tween; only transform+size+opacity. Unmatched elements only crossfade. P2 (FR-14). |
| Forced-match naming convention (e.g. `!!` prefix) | Not started | n/a | Matching is automatic by id/name; no explicit force-match override (PowerPoint `!!`). P3. |

### Present runtime and navigation

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Visible-slide navigation (hidden-slide skip, n-of-N) | Built | `lib/present.ts` `visibleIndices`/`seekVisible`/`next`/`prevVisibleIndex`; `PresentMode.tsx` `navigate` | Arrows/Space/PageDown/Up + click; hidden slides skipped everywhere. Pure, unit-tested. |
| Element interactions (click/hover -> navigate / open-link) | Partial | `PresentMode.tsx` `effectiveInteraction`/`runInteraction`; `Interaction` (423-447); `InteractionSection` | Navigation + link only; unsafe URL schemes refused. No play-media, run-animation, toggle-visibility, overlay, or trigger-other-element. P1 (FR-17). |
| Autopilot + kiosk loop | Built | `PresentMode.tsx` autopilot effect; `lib/present.ts` `dwellMs`; `PagePresentSection` auto-advance | Per-slide dwell (600ms floor), loop-to-first, `P` toggles. No scheduled start time, no global deck-timing UI. |
| Jump-to-slide palette | Built | `PresentMode.tsx` `JumpPalette` + `SlideThumb` | Grid of engine-rendered visible-slide thumbs; bound to `G` or `/`. |
| Magic tools: laser, ephemeral pen, spotlight, zoom-to-cursor, B/W blank | Built | `PresentMode.tsx` overlay paint loop; `lib/present.ts` `spotlightGeom`/`adjustSpotlightRadius`/zoom helpers | Separate overlay canvas so it never stalls the slide rAF. Pen ink ephemeral per-slide with color/width/undo/clear. All keyboard-bound; pure geometry unit-tested. Already exceeds Canva's thin presenter tools and matches Keynote. |
| Photo motion in present (Ken Burns / parallax) | Built | `PresentMode.tsx` `imageMotionPatch`; `ImageMotionSection` | Fixed sinusoidal drift, intensity-only. No start/end framing rect or direction control. |
| Reduced-motion fallback in present | Partial | `PresentMode.tsx` reduced-motion fallback | A fallback exists; formalize as a first-class, settings-driven `prefers-reduced-motion` playback mode (rare across incumbents = differentiator). P1 (FR-22). |
| Hyperlink-only / interactive kiosk navigation mode | Not started | n/a | No mode that disables linear advance so the deck navigates only via links/buttons (Keynote interactive mode). Builds on the Interaction model; covers branching decks before any Prezi-style work. P2 (FR-17). |
| Hardware clicker support | Built | `PresentMode.tsx` `onKey` (PageUp/PageDown) | USB/RF clickers send PageUp/PageDown; covered. |

### Presenter experience (presenter view / coach / teleprompter / remote)

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| True second-display presenter view (popout audience window) | Not started | n/a | The single most table-stakes gap: every incumbent has it, HyCanvas does not. Needs a `window.open` audience window mirroring the slide via `BroadcastChannel` while the HUD stays on primary. P0 (FR-15). |
| Presenter HUD (current+next thumb, notes, n-of-N, prev/next/jump, timer) | Partial | `PresentMode.tsx` `PresenterHud` (toggle `S`) | Same-window OVERLAY, not a second display; code flags `window.open` + `BroadcastChannel` as deferred. No wall clock. Becomes the primary-display HUD once FR-15 lands. |
| Rehearsal timer + per-slide breakdown | Built | `PresentMode.tsx` `RehearsalTimer`; `lib/present.ts` `RehearsalTimer`/`formatClock` | Count-up/down with editable target; per-slide elapsed + visit count on Stop. No saved rehearsal history. |
| Time-of-day wall clock in HUD | Not started | n/a | HUD shows only the rehearsal timer. Trivial add in `PresenterHud`. P2 (FR-15). |
| Teleprompter (scrolling sized notes, speed control) | Not started | n/a | Notes shown statically. Needs a scrolling full-width teleprompter; pure scroll math in `lib/present.ts`. P2 (FR-15). |
| Phone-as-remote / hardware remote pairing | Not started | n/a | No phone remote (advance/blank/jump/see notes). Rides the `/realtime` relay or a QR-paired channel (`QRNode` exists). Substitutes for the absent mobile client. P2 (FR-18). |
| Speaker coach / rehearse-with-AI-feedback (pacing/filler/monotone/inclusive) | Not started | n/a | Only a passive timer. PowerPoint Speaker Coach is the leader; fits BYO-key AI + mic capture, with gaze/eye-contact as a leapfrog frontier. Strong differentiator. P1 (FR-25). |
| Rich-text speaker notes | Not started | n/a | `Page.notes` is a plain string (`schema.ts:1526`); no formatted notes or per-build cue notes. P3. |

### Audience interaction (live Q&A / polls / reactions / captions / translation)

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Audience-facing live present share (join link / broadcast) | Built | share link + `AudiencePanel`; slide-follow via `audience_live` (presenter publishes each slide from PresentMode, `POST /designs/{id}/audience/live`, -1 on exit) and a follow banner in `DeckPlayer` (polls state; fresh <25s = live) | The share link is the join link; while the presenter presents, viewers see "Presenter is live - follow along" and, when following, their player mirrors the presenter's slide. Q&A/polls/reactions ride the same session. |
| Multipresenter / co-presenter control hand-off | Not started | n/a | No live co-control of a running deck across presenters (Keynote multipresenter). Natural fit for the relay; pairs with present-along. P2 (FR-19). |
| Live Q&A with upvote / moderation | Built | `backend/internal/audience` + `httpapi/audience.go` (share-token routes, anonymous OK); `AudiencePanel.tsx` (viewer drawer in DeckPlayer); `PresentMode.tsx` `PresenterAudience` (moderation drawer + unread badge) | Share-link viewers ask (name optional) and upvote (one per client-held voter key, computed counts); the presenter sees questions live over the realtime hub (`BroadcastEvent`), marks answered, dismisses (hidden from the audience, kept for the presenter), and clears the board between sessions. `audience_test.go` covers the lifecycle incl. design scoping. |
| Live polls / word clouds / quizzes | Built (polls) | same stack; poll launcher + live result bars in `PresenterAudience`, voting bars in `AudiencePanel` | Presenter launches a 2-6 option poll from present mode; viewers vote (re-vote while open, one ballot per voter key), results tally live on both sides, open/close toggle. Word clouds and quizzes remain. |
| Live emoji reactions per slide | Built | `audience.React` (allowlisted emoji, notify-only, never stored) -> hub -> floating overlay in `PresentMode` | Viewers tap an emoji in the drawer; it floats up over the presenter's slides in real time. Ephemeral by design. |
| Live captions / subtitles (SpeechRecognition) | Not started | n/a | No caption capture/overlay. Caption overlay can ride the present overlay canvas; pure caption-timing helper in `lib/present.ts`. P1 (FR-21). |
| Real-time translated captions (subtitle language != spoken) | Not started | n/a | PowerPoint leads, Google Slides is English-only; translated captions are open territory and fit the AI translate path. P2 (FR-21). |
| Present-to-video-call integration (present into a conferencing tool) | Not started | n/a | No conferencing integration (Google Slides -> Meet). For web-first this is a real distribution channel; deferred (overlaps host-app distribution). |

### Recording and video export

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Animated export (APNG / GIF / Lottie, single page) | Built | `export/src/{apng,gif,lottie}.ts`; `ExportDialog.tsx` (~193-240) sampling `poseDesignAt` at 15fps | Single active page, capped 150 frames; entrance+emphasis+custom+motion (no exit, no page transitions, no audio). Lottie bakes engine math to match present. |
| MP4 video export (server) | Built (timeline path) | `backend/internal/render/{video,timeline,anim}.go`; `httpapi/export.go` POST `/designs/{id}/export/video` (+ inline-`file` override); `ExportDialog.tsx` | The server renders a video TIMELINE (multi-track ffmpeg graph) with per-frame Go animation posing (`anim.go`); video documents export from the video editor, and decks export one-click from `ExportDialog` via deck-to-video (row above). The legacy static per-page path remains only for non-timeline files posted without conversion. |
| Deck-to-video with synced animations + transitions across all slides | Built | `ExportDialog.tsx` (Video (MP4) format) -> `lib/video/deckToVideo.ts` `deckToVideoFile` -> `POST /designs/{id}/export/video` with the inline-`file` override (`httpapi/export.go`) | One click in Export: the deck converts client-side to a video project (each slide a scene with its `autoAdvanceMs` timing, node animations, and its slide transition mapped to a scene transition) and renders on the SERVER video pipeline (ffmpeg + the Go animation poser `render/anim.go`), nothing persisted. Video-pipeline caveats apply (cross-scene overlap crossfade still renders as a dip-in; group-nested animation posing is browser-only). |
| Present-and-record (MediaRecorder: slide + narration + camera + ink/laser) | Built (camera bubble remains) | `PresentMode.tsx` (record toolbar button + REC badge) | One click in present mode records a 30fps composite of the slide canvas + the presenter ink/laser overlay, mixes mic narration when granted (declining records silently), and saves a `.webm` on stop or on leaving present mode. Client-side MediaRecorder only; nothing uploads. Remaining: the camera-bubble overlay (webcam picture-in-picture) and the black/white blanking screens (DOM overlays, not captured). |
| Per-slide / background voiceover binding + recorded narration | Partial | `VideoNode`/`AudioNode` are scene nodes (`schema.ts:1092-1131`); no slide-level narration binding | Audio can live as a free node but there is no `Page`-level narration tied to slide/build timing. Needs `Page.narration` + timestamped narration model. P2 (FR-16, FR-19). |
| AI voice narration / TTS / avatar presenters | Not started | n/a | No text-to-speech or avatar (Synthesia/HeyGen/Canva AI Voice). Fits AI + an audio pipeline. Deferred (`23-ai-media.md`). |
| On-slide live camera (Cameo-style first-class node) | Not started | n/a | No live webcam-as-node that can be moved/cropped/animated/morphed across slides (PowerPoint Cameo / Keynote multi-source). Deferred; a present-and-record camera bubble (FR-19) comes first. |

### AI for decks (text-to-deck / auto-layout / rewrite / notes / images / translate)

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Text-to-deck (prompt -> full multi-page editable deck) | Built | `aistudio/src/{outline,deck}.ts`; `editor.ts:1277` `buildDeckFromOutline`; `generate.go:55` | Prompt + designType + pageCount -> editable outline -> native pages in one undo step + per-page copy-polish. |
| Outline-first editable flow | Partial | `aistudio/src/outline.ts` `normalizeOutline`/`outlineJsonSchema`; `generate.go` `Outline` | The pure outline core and server endpoint ship, but the editable-outline UI was removed in the panel-to-chat consolidation: generation runs through the assistant without a review step. Restoration is tracked as T09 in `28-presentations-leverage-tasks.md`. |
| Per-slide auto-layout by visual role (design autopilot / smart slides) | Built | `aistudio/src/outline.ts` `ROLE_LAYOUT`/`outlineItemToSpec`; `layout.ts` `layoutDesign` | 7 roles -> layout intents; deterministic grid/type-scale/WCAG-readable color; single TS layout engine. Rule-based adaptive reflow (Beautiful.ai) is the remaining gap (FR-7). |
| N style variations | Built | `aistudio/src/theme.ts` `deckThemes`; `generate.go:109` | Multiple coherent visual systems / outline angles; user picks. |
| Conversational agentic assistant (tool-use, one undo turn) | Built | `aistudio/src/assistant.ts` `toolCatalog`/`planMutates`; `editor.ts:1343` `runAsTurn`; `generate.go:162` | ~12 tools; lacks multi-slide narrative ops (add agenda, insert comparison, split slide). Gamma Agent depth is the bar (FR-23). |
| Clarifying-questions deck builder (interview before generating) | Partial | `assistant.ts` (clarifying questions in the assistant) | The assistant can ask clarifying questions, but there is no dedicated interview-before-generation flow for first-draft deck creation (Canva AI for Presentations). FR-23. |
| Brand grounding (palette/fonts/voice/logo) | Built | `DeckTheme` fonts in `outline.ts`; `brandVoiceClause` `EditorPanels.tsx`; `editor.ts:3501` `applyBrandFixes`; assistant `applyBrand` | Brand palette grounds prompts; brand fonts per page; one-click apply-brand. |
| Reference-image style transfer | Partial | `aistudio/src/transform.ts` `paletteTheme`; `generate.go:176` | Palette/gradient only; no font-feel/layout/composition transfer (acknowledged fuzzy; closer to absent for the marketed feature). |
| Magic Switch (deck -> doc/social/poster) | Partial | `aistudio/src/transform.ts` `deriveOutline`/`switchOutline` | The deterministic re-shape cores ship but lost their UI in the panel-to-chat consolidation and currently have no caller; no assistant tool covers the switch yet. |
| AI Magic Resize re-layout | Built | `transform.ts` `recomposeSpec`; `editor.ts:1116` `magicResizePages`; `MagicResizeDialog.tsx` | Size-aware reflow rather than scaling. |
| Critique-and-improve (design critique + harmonize/tidy) | Partial | `aistudio/src/quality.ts` `qualityCheck`; assistant `critique`/`harmonize`/`tidyLayout` tools; `generate.go` `Critique` | AI critique and the fix tools ship as separate assistant actions; the one-click improve panel was removed in the panel-to-chat consolidation, and the deterministic `qualityCheck` report is computed per generated page but not surfaced. No per-issue accept/reject list (FR-23). |
| Brand-grounded per-slide image generation | Partial | `aistudio/src/prompts.ts` `groundImagePrompt` | Single-image grounding; no batch "one matching image per slide" UI. P2 (FR-24). |
| Per-text rewrite/shorten/expand/tone/translate | Built | `EditorPanels.tsx` (~3192-3210, Magic Write + `TONE_PRESETS`) | Acts on the selected text box only. |
| Whole-deck translation | Built | assistant tool `translateDeck` (`aistudio/assistant.ts`); `editor.ts` `collectDeckTexts`/`applyDeckTexts`; executor in `EditorPanels.tsx` | "Translate this deck to X" in the assistant walks EVERY page: each text RUN (styling boundaries preserved), sticky notes, and speaker notes, translated as ordered JSON batches (length/order contract, malformed replies rejected) and applied to exact addresses as ONE undo step. Locked subtrees skipped. `deckTexts.test.ts`. |
| AI speaker-notes generation | Built | assistant tool `generateSpeakerNotes` (`aistudio/assistant.ts`); executor in `EditorPanels.tsx` -> `setPageNotes` per slide | "Write speaker notes" summarizes each slide's visible text and generates spoken-style notes per slide (optional guidance arg, brand voice honored), written into `Page.notes` (presenter view + notes panel) in one turn. |
| Document / URL / file -> deck ingestion | Built | Assistant attach flow (`EditorPanels.tsx` Paperclip: paste / URL / .txt/.md/.pdf), `POST /ai/extract-url` (`httpapi/extracturl.go`, SSRF-hardened: public-IP resolution per redirect hop, size/time caps, html/plain only), `pdfFileToText` (`lib/pdfImport.ts`) | Attach source content in the assistant (paste, a fetched web page, or a text/markdown/PDF file); "create a deck from this" then grounds the generated outline STRICTLY in the attachment (structure/facts preserved, no invention) via the existing outline pipeline. `extracturl_test.go` covers the SSRF gate + HTML-to-text reduction. |
| AI theme generation as a swappable Theme | Partial | `@hc/aistudio` `deckThemes`/`paletteTheme` | Themes generated as part of deck gen; no standalone "generate a theme" that becomes a swappable `Theme` record (gated on the missing theme model, FR-4). |
| Chart-from-data (Magic Charts) | Built | `transform.ts` `normalizeChartSpec`; `generate.go:140` | See data-driven slides; native editable charts from NL/table. |
| Web-research deck agent with citations | Not started | n/a | No web research + cited facts into slides (Gamma Agent 3.0). Fits the assistant + a research tool. Deferred. |
| Streaming / real per-slide job progress | Partial | `httpapi/aistudio.go` generate-design/variations use the job registry; recorded then polled | No token streaming, no per-slide thumbnail-as-it-completes. "Watch slides appear" UX unrealized. P2. |
| Whiteboard-to-deck (deterministic board -> slides) | Built | `packages/whiteboard/src/deck.ts` `whiteboardToDeck`; `WhiteboardSurface.tsx`; server job | Each top-level frame -> slide; cross-document-type wedge no incumbent owns. |

### Templates / themes / brand

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Templates pure core (deep-copy + id-regen, style swap, fillable fields, scoped search) | Partial | `@hc/templates` (F14 pure core); ~32 real templates | Pure-core apply pipelines exist; layout-grounding AI from the template seed catalog is not wired, and ~32 templates vs Canva's thousands is an existential content gap, not a P2 line item. Catalog growth is an ongoing content investment (deferred as a code milestone). |
| Brand kit (logos/palette/fonts, multiple kits) | Partial | `BrandPanel` + `applyBrandFixes` `editor.ts:3501`; `DesignFile.palette`/`fonts` | Brand grounding + apply-brand ship; a centralized multi-kit Brand Hub with brand-locked templates is not formalized. |
| Brand templates (locked on-brand starting templates) | Not started | n/a | No locked team brand templates / brand-lock enforcement (Canva Brand Templates, Copilot brand-lock). |
| AI theme generation from prompt / brand inputs | Partial | `@hc/aistudio` `deckThemes`/`paletteTheme` | See AI for decks; gated on the missing swappable Theme model (FR-4). |

### Collaboration and comments

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Live co-editing (Yjs CRDT, presence, locks, Redis fan-out) | Built | `backend/internal/realtime/{serve,hub,coordinator,coordinator_redis}.go`; `lib/{realtime,ydoc}.ts`; `packages/realtime/src/reconcile.ts` | Real CRDT co-edit with presence and per-element locks; horizontal scale; offline-first. F16-owned. |
| Comments on slides/elements (threads, reactions, mentions, resolve) | Built | `backend/internal/comments/comments.go` | Anchored to design/page/element/region/video; replies, reactions, @mentions, resolve, orphan re-resolution; capability-gated. |
| Version history / branching / restore | Built | `backend/internal/persistence/repository_writes.go`; `httpapi/persistence.go` | Snapshots, diffs, restore, branch-from-version; stored in open format. Strong deck version-control foundation. |
| Approvals / review workflow (slide sign-off) | Partial | `comments/comments.go` task statuses + assignee + due date; `persistence` brand-reviewed-version | Comment-tasks + brand-reviewed marker approximate it; no formal per-slide/per-deck approval gate / sign-off state machine. Pitch slide-status/assignee is the bar. P2. |
| Slide-level status / assignees (project-board view) | Partial | `comments` task model (assignee/status), comment-scoped | Task status/assignee exist on comments but not as first-class per-slide ownership. Pitch treats a deck as a board. P2. |

### Sharing / publishing / player-links and analytics

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Share links (RBAC view/comment/edit, password, expiry, rotate) | Built | `ShareDialog.tsx`; `pages/shared.tsx`; `backend/internal/sharing/sharing.go` | Anyone-with-link at view/comment/edit + password + expiry + member grants. Password-prompt flow ships. |
| Per-page viewer engagement insights (unique viewers, duration, per-page time) | Built | `lib/useViewBeat.ts`; `backend/internal/engagement/{insights,service,repository}.go`; GET `/designs/{id}/insights`; POST `/shared/{token}/view-beat` | View-beat heartbeats per visible page; unique named + anonymous, total/avg duration, per-page ms. Incumbents (PowerPoint/Slides/Keynote) have zero of this. Strong base for Pitch/Gamma/DocSend-grade analytics. No real-time live-audience dashboard. |
| Read-only shared viewer | Built | `frontend/src/components/SharedViewer.tsx` | Routes multi-page designs to `DeckPlayer` (the web player); single-page designs keep the plain scroll render. Client-only, latest snapshot. |
| Web player link with slide navigation + fullscreen + transitions | Built | `frontend/src/components/DeckPlayer.tsx` | Engine-drawn slides on a dark stage; arrow/space/page-key + click navigation, slide counter, fullscreen, and real transitions via the pure `@hc/engine` compositor (FR-13), so player and present mode composite identically. Entrances play through `poseDesignAt`. Read-only; keeps the share-link engagement beats. Remaining (FR-26): named per-audience tracked links with passcodes + per-link dwell analytics, and the public iframe/web embed. |
| Multiple per-audience tracked links + passcodes | Not started | n/a (single share token per design) | Pitch creates many named per-audience links. Needs multiple named links per design + per-link analytics. P2 (FR-26). |
| Public iframe / web embed of a deck | Not started | n/a (`PublishDialog`/`@hc/publishing` is social-post oriented) | No embeddable deck player. Google Slides/Gamma embed is the bar. P2 (FR-26). |
| Publish as standalone website / custom domain | Not started | n/a | No deck-as-microsite. Gamma collapses deck + website; deferred (overlaps the website feature). |
| Image / PDF / SVG export | Built | `ExportDialog.tsx`; `export/src/{dimensions,svg}.ts`; `backend/internal/render/{raster,pdf,svg}.go` | PNG/JPG (client + Go), PDF (jsPDF + Go), editable/flattened SVG. PDF print-intent (CMYK/bleed/crop) modeled in `@hc/export` but print-grade encoder deferred; accessibility-tagged PDF is a further gap (FR-22). |

### Import / export interop (PPTX / Keynote / Google / PDF / Markdown)

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| PPTX import (high-fidelity, editable: text/animations/fonts/masters) | Built (core fidelity) | `@hc/export` `pptximport.ts` (+ `unzip.ts` store/deflate via native DecompressionStream, `xml.ts` compact OOXML parser - all dependency-free); dashboard Import tile accepts `.pptx` | A real .pptx opens as editable pages: text runs with size/family/bold/italic/underline/color and alignment, preset-geometry shapes (rect/roundRect/ellipse/triangle/star/polygon families; unknown geometry keeps its bounds as a rect) with solid/gradient/theme-scheme fills and strokes, images as self-contained data-URL assets with srcRect crops, straight connectors as lines, groups flattened through chOff/chExt, slide backgrounds, notes, z-order, and rotation/flips converted from center-rotation. Round-trip proven against our own exporter (`pptximport.test.ts`). Remaining fidelity: animations/transitions, master/layout inheritance (slides import flattened), embedded fonts. |
| PPTX export (native PowerPoint round-trip) | Built (export half) | `@hc/export` `pptx.ts` `deckToPptx` + `zipstore.ts`; `ExportDialog.tsx` (PowerPoint format) | Fully client-side OOXML writer: one slide per page; native DrawingML for text boxes (per-run size/family/bold/italic/underline/color, paragraph alignment), rect/roundRect/ellipse/triangle/star/polygon shapes with solid+gradient fills and strokes, images with crop/cover srcRect, straight lines, page backgrounds, rotation/flips (re-anchored to PowerPoint's center-rotation model); speaker notes as real notesSlides; every OTHER node type (charts, paths, ink, tables, QR, ...) embeds as a correctly-placed PNG via a per-node engine rasterizer, so nothing drops silently. Structure-validated by `pptx.test.ts` (part/rel/content-type integrity walk). Remaining: animations/transitions mapping and master/layout round-trip (IMPORT now ships - row above). |
| Keynote / Google Slides / ODP import (via PPTX bridge) | Not started | n/a | Most tools bridge `.key`/Google through PPTX; ODP for LibreOffice interop is an open/self-host wedge. P1 (FR-27). |
| PDF export | Built | `ExportDialog.tsx` jsPDF + Accessible PDF option; `backend/internal/render/pdf.go` | Ships. Two paths, named in the dialog: a raster PDF (pixel-exact, no text) and an accessibility-tagged PDF from the Go encoder (real text, structure tree, images and design fonts embedded). FR-22. |
| MP4 / WebM video export of animated deck + narration | Partial | `render/video.go` (static); see recording/video | Continuous animated deck-to-video with audio is the goal. P1 (FR-19). |
| GIF / image export | Built | `export/src/gif.ts`; raster path | Animated GIF (single page) + per-slide images ship. Full-deck GIF rides the deck-to-video sampler (FR-19). |
| Markdown / Marp / Slidev / reveal.js import-export | Not started | n/a | No code-first/Markdown round-trip. Open-ecosystem wedge (editable md<->deck is unsolved by incumbents who raster). P3 (FR-27). |
| Outline import/export (RTF/Word/Markdown outline) | Not started | n/a | No outline interchange. The AI outline model could seed this. P3. |

### Performance and scale

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Framework-agnostic Canvas2D engine (shared browser/worker/headless) | Built | `@hc/engine` (`animation.ts`/`pose.ts` + scene renderer); Go render engine | Same engine in editor, present, and headless export; WYSIWYG. Performance leadership wedge. |
| Separated overlay rAF for present magic tools | Built | `PresentMode.tsx` overlay paint loop | Laser/pen/spotlight render on a separate canvas so they never stall the slide rAF. |
| 60fps present + prefetch/precompute next slide | Partial | `PresentMode.tsx` slide rAF | No stated present-frame budget and no explicit next-slide precompute/prefetch. Commit budgets + precompute the arriving slide (and its transition buffers) ahead of advance. P1 (FR-28). |
| WebGL / WebGPU accelerated path for 3D transitions / large animated decks | Not started | n/a (Canvas2D only; GPU path on engine roadmap) | 3D/cinematic transitions and very large animated decks want GPU; Canvas2D fallback must remain. Engine-roadmap-owned. P2 (Phase 5, FR-28). |
| Large-deck handling (lazy thumbnails, virtualized PagesBar) | Partial | `PagesBar.tsx` renders live engine thumbnails for all pages | Thumbnail rendering may not scale to hundreds of slides; needs virtualization/LOD. P2 (FR-28). |

### Accessibility and i18n

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Alt text on nodes | Not started | n/a (no alt-text field on `NodeBase` `schema.ts:617-646`) | No alt text; screen readers get nothing. Table-stakes vs PowerPoint/Slides/Keynote; a credibility hole for an accessibility-pillar product. Needs `NodeBase.altText` + migration. P0 (FR-29). |
| Slide reading-order / tab-order model | Not started | n/a | No reading-order independent of z-order. Section 508 requires it. Needs `Page` reading-order + a Reading Order pane. P0 (FR-29). |
| Slide titles for screen-reader navigation | Partial | `Page.name?` exists (`schema.ts:1517`) but not enforced as an accessible title | Page name exists but is not a guaranteed accessible slide title; placeholders/layouts would enforce it (FR-3, FR-29). |
| In-canvas WCAG 2.2 AA checker (contrast/alt/order) with one-click fixes | Partial | `@hc/a11y` + `AccessibilityDialog`; `qualityCheck` flags contrast (`aistudio/src/quality.ts`) | Contrast flagged and an a11y package/dialog exist; a full severity-tiered checker with fix-it actions + ACR/VPAT is not assembled for the slide surface. P1 (FR-29). |
| Prefers-reduced-motion present mode | Partial | `PresentMode.tsx` reduced-motion fallback | A fallback exists; formalize as a first-class, settings-driven reduced-motion playback (rare across incumbents = differentiator). P1 (FR-22). |
| Accessibility-tagged PDF export (PDF-UA) | Built | `backend/internal/render/{pdftag,pdfimage,pdfttf}.go`; `render.ToDeckPDF`; `GET /designs/{id}/render.pdf?page=all`; `ExportDialog` Accessible PDF option | The Go encoder emits a structure tree (Document -> per-slide Sect -> P/Figure), honors `readingOrder` independent of z-order, carries `altText` as `/Alt`, artifacts decorative content, embeds images (JPEG passthrough, Flate + soft mask otherwise), and embeds the design's own fonts (Type0/Identity-H + CIDFontType2 + ToUnicode), which also makes non-Latin text exportable. Fonts the design does not carry (Google/system faces) and fonts whose OS/2 fsType forbids embedding fall back to base-14. |
| AI alt-text / chart descriptions | Not started | n/a | No AI-suggested alt text or chart descriptions; fits AI once the alt-text field exists. P2 (FR-24, FR-29). |
| i18n / RTL / CJK / string localization | Partial | `@hc/text` engine handles segmentation; whole-deck AI translate absent | Text engine supports complex scripts; UI string localization and whole-deck translate need work (FR-23, FR-29). |

### Security

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Per-workspace data isolation at query layer | Built | backend persistence/comments/sharing/engagement enforce isolation | Architectural rule enforced; carries to all present/share/analytics surfaces. |
| Unsafe-URL refusal in present interactions | Built | `PresentMode.tsx` `runInteraction` (unsafe URL schemes refused) | open-link guards against unsafe schemes. Extend to any new interaction action (FR-17). |
| Share-link security (password, expiry, rotate, anonymous bounds) | Built | `backend/internal/sharing/sharing.go`; `ShareDialog.tsx` | Password/expiry/rotate/disable; anonymous access bounded. Player links + per-link analytics must keep these guards (FR-26). |
| BYO-key AI with no data egress / on-prem residency | Built | `backend/internal/ai` proxy; keys stored encrypted per workspace | All AI (deck gen, assistant, translate, coach) routes through the proxy; on self-host, deck data never leaves the instance. Strong privacy wedge. |
| Untrusted PPTX/embed import sandboxing + SSRF | Not started | n/a | PPTX/ODP/Keynote import parses untrusted archives (zip/XML/embedded media/fonts) and embeds may fetch remote URLs. Needs archive-bomb and XXE guards plus an SSRF guard on any server-side fetch. P0 with FR-27. |
| Audience / live-share threat model (untrusted joiners, moderation, rate-limit) | Not started | n/a | Live Q&A/polls/reactions over the relay need moderation, rate-limiting, anonymous-session bounds, and abuse handling. Spec defines a present-time trust boundary (section 11). P1 (FR-20). |
| RFC 7807 errors + structured JSON logs | Built | API-wide convention (chi `/api/v1`) | Convention enforced; new present/audience/export endpoints follow it, keyed by design/workspace/session/request ids. |

## 5. UX and interaction behavior

The present-specific interaction model, the complement to the F16 realtime UX (presence cursors, lock badges, connection state) and the editor authoring UX (selection, transforms, panels) which this spec does not restate. The novel present and motion flows are specified here so they are reviewable as an interaction model, not only as capability rows.

- Second-display presenter view: entering present mode opens a clean audience window via `window.open`, sized to the external display; the primary window keeps the presenter HUD (current + next-slide preview, notes, rehearsal timer, wall clock, teleprompter toggle, n-of-N, jump). The two windows share state over a `BroadcastChannel` (slide index, transition trigger, laser/ink, blank), so advancing on the primary animates the audience window. If `window.open` is blocked, the runtime falls back to a same-window overlay HUD (today's behavior) with a clear prompt.
- Teleprompter: a toggle replaces the static notes pane with a full-width scrolling script at an adjustable size and speed (auto-scroll or manual), reading-position centered; pure scroll math lives in `lib/present.ts` and never touches the audience window.
- Phone-as-remote: a QR/`QRNode`-paired companion page over `/realtime` advances/reverses, blanks, jumps via thumbnails, and shows the presenter's notes on the phone, substituting for the absent native mobile app.
- Audience companion: an audience join link (QR) opens a responsive web player that follows the presenter's current slide (present-along), shows live captions, and surfaces a Q&A composer (submit + upvote), poll responses, and an emoji-reaction tray; submissions flow back to the presenter HUD. In-room and remote audiences use the same companion.
- Motion authoring: a page-level build-order timeline shows every animated element on one strip with its entrance order, start-mode (on-advance / with-previous / after-previous), delay, and duration, draggable to reorder and overlap; selecting an element opens its keyframe track and a graphical cubic-bezier curve editor. Motion paths are drawn directly on the slide as an editable curve with an orient-to-path toggle.
- Magic Move authoring: matched elements are highlighted between adjacent slides; an author can force or break a match by name, choose linear/eased/spring morph, and opt into nested/grouped and text-glyph morph.
- Interaction triggers: an element can be wired to navigate, open a link, play/pause a media node, run an animation (its own or a target's), toggle visibility, or show an overlay, with click or hover triggers; a deck can be set to hyperlink-only kiosk mode where linear advance is disabled and navigation is solely via triggers.
- Reduced motion: a settings-driven `prefers-reduced-motion` present mode cuts transitions to a cross-fade, suppresses emphasis loops and photo motion, and renders text reveals instantly, honoring the OS/user preference.

## 6. Functional requirements

Grouped by theme. These FR ids are the durable contract referenced by the acceptance criteria and the feature matrix.

Slide structure and content:
- FR-1: A `Page` carries present metadata (notes, transition, auto-advance, hidden), all undoable, all CRDT-synced, and all honored identically in editor Play, present mode, and export (already shipped; the contract this spec extends).
- FR-2: Speaker notes become rich text (formatting, links, lists) rather than the current plain `notes` string, edited in a dedicated notes pane, shown in the presenter view and teleprompter (FR-15), generatable by AI (FR-23), and carried through PPTX/PDF export.
- FR-3 (model + editing UI shipped; built-in layout gallery pending): A slide master / layout / placeholder model cascades fonts/colors/backgrounds and enforces an accessible slide title; built-in layouts (title/content/two-content/comparison/picture) are available and ground AI layout generation. The page name becomes a guaranteed accessible title via the title placeholder.
- FR-4 (model shipped; UI pending): A first-class swappable `Theme` record (12-slot color palette + heading/body font pair + effect styles + variants) restyles the whole deck in one action; AI theme generation produces a `Theme` the deck can adopt.
- FR-5 (shipped): Slides group into named, collapsible sections; a grid/outline overview editing view lets an author reorder the narrative; present navigation is section-aware.

Data-driven slides:
- FR-6: Native editable tables on slides (extending `TableNode`) support paste-from-spreadsheet and CSV/XLSX import, theme-aware header/zebra styling and per-cell formatting, and one-click table-to-chart; tables participate in the reading-order and accessibility model (FR-29).
- FR-7: Adaptive smart-slide auto-layout recomputes spacing, alignment, and hierarchy as content changes (rule-based, not only AI), keeping a slide balanced.
- FR-8 (shipped: URL/inline-CSV binding, `/data/fetch` proxy, refresh on open + on demand; connector auth and XLSX pending): `ChartNode` gains an optional `DataBinding` (sheet/CSV/connector source + ref + `refreshOnPresent`); charts refresh from the source on demand and optionally on present, caching the last-fetched data in the file; a CSV/XLSX upload also produces a native chart.
- FR-9 (shipped: `bulkMergePages`, one slide per CSV row with {{token}} substitution): A bulk data-merge pipeline maps rows of a data source to one slide per row over a template (text + image placeholders), producing native editable slides.

Motion and transitions:
- FR-10 (shipped): A page-level animation build-order timeline shows every element's entrance order, start-mode, delay, and duration on one strip, draggable to reorder and overlap (PowerPoint Animation Pane / Keynote Build Order parity); an apply-to-all op sets a transition or animation across slides.
- FR-11: Text reveals add per-line, per-paragraph, and per-bullet builds and fade/rise-by-word; chart builds sequence by series/category.
- FR-12: The keyframe model adds optional color/fill, width/height, skew, and filter/blur channels (additive, omitted = identity); a motion-path channel (or motion-path node) lets an element follow an editable curve with orient-to-path; an animation can be triggered at a media bookmark timestamp.
- FR-13 (compositor shipped): The slide-to-slide transition compositor is lifted out of `PresentMode.tsx` into a pure `@hc/engine` helper so editor preview, present mode, the web player, and headless export all render transitions identically; transitions gain selectable per-transition easing and, on the GPU path, 3D/cinematic types. Shipped: `packages/engine/src/transition.ts` (`renderTransition` plus the Magic Move split `morphPlan`/`morphHiddenIds`/`morphDesignAt`/`lerpNode`), consumed by `PresentMode.tsx` via a thin `compositeTransition` adapter, with 22 tests. Remaining: consume it from the web player and headless export, per-transition easing, and GPU 3D types.
- FR-14: Magic Move adds recursive nested/grouped matching, per-element eased/spring morph, text glyph-level morph, shape/path/fill/gradient/color tween, and a force/break-match override; matching stays keyed on stable schema node ids.

Present runtime and presenter experience:
- FR-15 (shipped): A true second-display presenter view opens an audience window (`window.open`) mirroring the slide via `BroadcastChannel` while the primary window keeps the HUD; the HUD adds a wall clock and a teleprompter (scrolling sized notes with speed control); it falls back to a same-window overlay if popups are blocked.
- FR-16: A `prefers-reduced-motion` present mode is a first-class, settings-driven playback path; element interaction triggers extend beyond navigate/open-link to play/pause-media, run-animation (self or target), toggle-visibility, and show-overlay, with click or hover triggers, and unsafe URL schemes stay refused.
- FR-17: A hyperlink-only kiosk navigation mode disables linear advance so the deck navigates only via triggers (Keynote interactive mode), built on the interaction model.
- FR-18: A phone-as-remote companion over `/realtime` (or a QR-paired channel) advances/reverses, blanks, jumps, and shows notes; hardware clickers continue to work.

Recording, audience, and AI:
- FR-19 (deck timeline shipped for client animated export): Present-and-record captures a live run (slide canvas `captureStream` + mic narration + camera bubble + ink/laser) via browser `MediaRecorder` to a downloadable/shareable video; deck-to-video renders all slides headlessly with synced animations (incl. exit), transitions (via FR-13), and narration to MP4/WebM with audio (extend `render/video.go` per-frame `poseDesignAt` sampling); per-slide/background narration binds to slide + build timing.
- FR-20: An audience-facing live present share (join link / QR) broadcasts the current slide over `/realtime` with a present-time trust boundary; live Q&A with upvote and moderation, live polls/word-clouds/quizzes (a `PollNode` + live tally), and per-slide emoji reactions surface in the presenter HUD; multipresenter co-control lets presenters hand off live.
- FR-21: Live captions via SpeechRecognition overlay the audience slide; AI translation renders captions in a subtitle language different from the spoken language.
- FR-22: Accessibility present and export: a reduced-motion present mode (FR-16), accessibility-tagged PDF export (PDF-UA), and reading-order-respecting export.
- FR-23: AI for decks on `@hc/aistudio`: design autopilot / smart-slide auto-layout (with FR-7), AI rewrite/condense/tone, whole-deck translation (an all-text-node iterator preserving layout), AI speaker-notes generation, theme generation (FR-4), chart-from-data (FR-8), document/URL/file-to-deck ingestion, a clarifying-questions interview flow, deeper multi-slide narrative assistant ops (add agenda, insert comparison, split slide), and a per-issue accept/reject critique list, all producing editable native nodes routed as one undoable scene-op.
- FR-24: AI image generation places first-class `ImageNode`s onto slides, including a batch "one matching image per slide" flow; AI suggests alt text and chart descriptions (with FR-29).
- FR-25: A speaker coach captures mic audio through the BYO-key/self-host AI layer (or in-browser ASR for the live-nudge path) and reports on pacing, filler words, monotone, repetition, and inclusive language, with a saved rehearsal report, and no audio egress on self-host.

Interop, performance, accessibility:
- FR-26 (player shipped): A real web player link (engine-rendered slide nav + fullscreen + transitions via FR-13) replaces the scroll-stack `SharedViewer` (shipped: `DeckPlayer.tsx`, routed from `SharedViewer` for multi-page designs); multiple named per-audience tracked links with passcodes carry per-link, per-slide dwell analytics; a public iframe/web embed renders the deck player; all keep the existing share-link security guards.
- FR-27: PPTX import and export round-trip preserves editable text, animations, notes, transitions, and masters as faithfully as the model allows (lossy mappings documented, never silently flattened); Keynote/Google Slides import bridges through PPTX; ODP and Markdown/Marp/Slidev import are open-ecosystem wedges; all produce or consume the open `@hc/schema` format, with new node types backed by a forward migration.
- FR-28: Present sustains 60fps with the next slide (and its transition buffers) precomputed/prefetched ahead of advance; large decks virtualize `PagesBar` thumbnails; committed budgets are stated (section 10); the WebGL/WebGPU path falls back to Canvas2D.
- FR-29 (model + checker + authoring UI + Reading Order pane + tagged-PDF encoder shipped): `NodeBase` gains optional `altText` and `decorative`; `Page` gains a reading-order/tab-order list independent of z-order; an in-canvas WCAG 2.2 AA checker flags low-contrast, missing alt text, and unreadable text at authoring time with one-click fixes; slide titles are guaranteed via the title placeholder (FR-3); a presentations ACR/VPAT is published.

## 7. Data model / schema changes

All present node types and properties are added to the open file format per the schema-is-contract rule: extend the `NodeType` union and `knownNodeTypes` in `packages/schema/src/schema.ts`, define the interface + Zod schema with `...nodeBaseFields, type: z.literal("...")`, add it to the `KnownNode` union and discriminated `NodeSchemaByType`, give it a default in `factory.ts`, register a forward migration step in `migrate.ts` keyed on the source version, and bump `currentSchemaVersion` (currently 13). Additive node types and optional fields need only a version bump, because older files omit them and `UnknownNode.raw` preserves a newer client's nodes losslessly, so additive rollout is safe across mixed-version clients. Two coupling rules apply to every version bump: (1) raise the Go mirror `currentSchemaVersion` in `backend/internal/persistence/file.go` in the same change, or the write boundary `persistence/validate.go` rejects the newer file with a 422 (`ErrInvalidFile`) and nothing persists (the rejection is on the top-level `schemaVersion` field, not on per-node round-trip); purely-additive bumps need no new Go migration step. (2) Append a one-line entry to the schema-version-history doc-comment above `currentSchemaVersion` in `schema.ts`.

New deck-level structures and node types (additive, each batch a version bump):

```ts
// Slide master / layout / placeholder model on DesignFile (cascades style + enforces titles)
interface SlideMaster { id: string; theme?: string; background?: Fill; placeholders: Placeholder[] }
interface SlideLayout { id: string; masterId: string; name: string; placeholders: Placeholder[] }
interface Placeholder {
  id: string;
  role: "title" | "body" | "content" | "picture" | "chart" | "media" | "footer";
  rect: { x: number; y: number; width: number; height: number };
}
// DesignFile gains optional masters: SlideMaster[]; layouts: SlideLayout[]; Page gains optional layoutId.

// First-class swappable theme (distinct from the flat palette/fonts)
interface Theme {
  id: string;
  colors: Color[];        // 12 slots
  fontHeading: string;
  fontBody: string;
  effects?: Record<string, unknown>;
  variants?: { id: string; colors: Color[] }[];
}
// DesignFile gains optional theme: Theme; a default theme is synthesized from palette/fonts for older files.

// Live poll / quiz node (live tally lives in Postgres + over the relay, not the file)
interface PollNode extends NodeBase {
  type: "poll";
  question: string;
  options: { id: string; label: string }[];
  mode: "single" | "multi" | "wordcloud" | "quiz";
  reveal: "live" | "after-close";
}
```

Additive optional fields on existing structures (no node mapping, version bump only):
- `Page` (`schema.ts:1517-1549`): optional `layoutId` (master/layout cascade), `sectionId` (or a `DesignFile.sections[]` with ordered membership), `readingOrder: string[]` (node-id order independent of z-order), and `narration: { assetId: string; startMode: AnimationStartMode; timestamps?: number[] }` (per-slide voiceover tied to slide + build timing).
- `NodeBase` (`schema.ts:617-646`): optional `altText: string` and `decorative: boolean` (missing = fall back to z-order, no alt text, as today).
- `ChartNode`: optional `binding: { source: "sheet" | "csv" | "connector"; ref: string; refreshOnPresent?: boolean }` (unbound charts behave as today; last-fetched data is cached in the file).
- `KeyframeTrack`/`Keyframe` (`schema.ts:370-405`): additive optional channels (color/fill, width/height, skew, filter/blur) plus an optional motion-path channel (a path of anchors + orient-to-path flag); omitted channels keep identity, so older tracks behave as transform/opacity-only. Widening `AnimPatch`'s 5-channel contract is the structural risk (section 18); the working assumption is a parallel path-evaluation pass that composes into the existing patch without changing the 5 core channels.
- `InteractionAction` discriminated union (`schema.ts:429`): additive variants `play-media`/`pause-media` (target node id), `run-animation` (self or target), `toggle-visibility` (target), and `show-overlay`; the trigger union may extend beyond `click`/`hover`. Older files only use `none`/`navigate`/`open-link`.
- `PageTransition` (`schema.ts:449-459`): optional per-transition `easing` (named or bezier), an optional `exit` transition, and additive 3D/cinematic types (rendered only on the GPU path).

Persistence and storage:
- Durable present settings (masters/layouts/theme/sections/reading-order/narration/transition/animation/interaction) live in the open `@hc/schema` `DesignFile` synced via the CRDT, with forward migrations.
- Transient live-session state stays out of the file format, mirroring the `AiSession`/engagement pattern: a per-design `presentation_poll_vote` table (design_id, session_id, poll_id, option_id, user_id/anon_id, cast_at), a `live_session` row (presenter, current slide, captions config), and audience Q&A rows live in Postgres, fanned over `/realtime`. Multiple tracked share-links and per-link analytics extend `internal/sharing` + `internal/engagement`.
- AI provenance stays in `doc.meta.aiProvenance`; comments, share grants/links, and engagement stay in their existing Postgres services.
- Per-workspace data isolation is enforced at the query layer for every new table, consistent with the existing services.

## 8. API and realtime

REST under `/api/v1` (chi router). Errors are RFC 7807 problem+json; all handlers emit structured JSON logs with design id, workspace id, user id, session id (for live sessions), and request id.

```
POST   /api/v1/imports/pptx                          PPTX/ODP/Keynote-via-PPTX import -> job (returns 202 + job id)
POST   /api/v1/designs/{id}/export/pptx              native PPTX export -> job
POST   /api/v1/designs/{id}/export/video             full-deck MP4/WebM with animations+transitions+narration -> job
POST   /api/v1/designs/{id}/ingest                   document/URL/file -> deck (AI) -> job
POST   /api/v1/designs/{id}/ai/notes                 AI speaker notes for one/all slides -> job for whole-deck
POST   /api/v1/designs/{id}/ai/translate             whole-deck translation -> job
POST   /api/v1/designs/{id}/charts/{node}/refresh    refresh a data-bound chart from its source
POST   /api/v1/designs/{id}/present/sessions         open/close a live present session (presenter)
POST   /api/v1/designs/{id}/present/questions        submit/upvote/moderate an audience question
POST   /api/v1/designs/{id}/present/polls/{poll}/votes  cast a poll vote (server-authoritative; 409 over-budget/closed)
GET    /api/v1/designs/{id}/present/polls/{poll}     poll tally (respects reveal mode)
POST   /api/v1/designs/{id}/coach/sessions           speaker-coach rehearsal session -> job (report)
GET    /api/v1/designs/{id}/links                    list/create named tracked share-links (per-audience)
GET    /api/v1/designs/{id}/insights                 per-page (and per-link) engagement analytics (existing, extended)
GET    /api/v1/jobs/{id}                              poll long-running ops (existing job registry)
```

Heavy operations never run inline in a handler: PPTX import/export, full-deck video render, document/URL/file ingestion, whole-deck translation and AI speaker notes, AI deck generation (existing), and the speaker-coach report go through the in-process job registry and are polled via `GET /api/v1/jobs/{id}` (202 + job id). A 422 problem+json is returned when an imported or AI-produced document fails boundary schema validation (`persistence/validate.go`), so a malformed document never persists for other clients.

Realtime over `/realtime` (extends F16). New `t` frame types are added to the client `ServerFrame` union (`frontend/src/lib/realtime.ts`) and the server dispatch (`backend/internal/realtime/serve.go`, `hub.go`):
- `{t:"present-along"}`: the presenter's current slide index + transition trigger broadcast to audience companions (in-room and remote), so the audience web player follows.
- `{t:"present-control"}`: phone-as-remote and multipresenter co-control frames (advance/blank/jump/handoff), gated to a presenter role server-side.
- `{t:"question"}`: audience Q&A submit/upvote/moderate fan-out (paired with the Postgres Q&A store).
- `{t:"poll-vote"}`: server-authoritative poll vote cast/tally fan-out (paired with the Postgres poll store).
- `{t:"reaction-present"}`: per-slide ephemeral emoji reactions, age-gated like the whiteboard's reactions, never persisted.
- `{t:"caption"}`: live caption text (optionally translated) overlaid on the audience slide, ephemeral.
- Presence (`PeerState` in `store/presence.ts`, `sanitizePresence` in `presence.go`) is extended for audience-companion cues; the presenter/co-presenter roles gate the control frames, consistent with the existing viewer-frame drop in `hub.go`.

SDK (`@hc/sdk`): typed methods for PPTX import/export, video export, ingestion, AI notes/translate, chart refresh, present sessions, questions, poll votes, coach sessions, and tracked links. Pure cores: a new `@hc/pptx` (or `@hc/export` extension) maps slides <-> Office Open XML; `@hc/engine` gains the pure exportable transition compositor (lifted from `PresentMode.tsx`) and the new keyframe channels; `@hc/aistudio` gains whole-deck translation, speaker-notes, ingestion, and deeper assistant ops; `lib/present.ts` gains teleprompter scroll math and caption timing helpers. Existing comments, sharing, and engagement endpoints are reused and extended.

## 9. AI for decks

All deck AI builds on the shipped F39 AI Creative Studio (`@hc/aistudio`): the BYO-key, multi-model, self-hostable provider-adapter layer with editable, reproducible output. Deck data never leaves a self-hosted instance because inference routes through the workspace's own key/endpoint. Every AI capability emits content + intent (validated against JSON Schemas), is materialized into native `@hc/schema` nodes by the deterministic TS layout engine (`aistudio/src/layout.ts` `layoutDesign`, `deck.ts` `layoutDeck`), and is applied through the `@hc/editor` command framework as one undoable scene-op, never a flattened render.

- Text-to-deck and design autopilot: prompt-to-deck ships (`buildDeckFromOutline`); the remaining work is layout-grounding from the slide master/layout model (FR-3) and the template seed catalog, an optional clarifying-questions interview before first-draft generation, and rule-based adaptive smart-slide auto-layout (FR-7) that recomputes spacing/hierarchy as content changes (Beautiful.ai parity), all producing native editable slides.
- AI rewrite / condense / translate: per-text Magic Write ships; whole-deck translation walks every text node preserving layout (an all-text-node iterator), and condense/tone ops act on a slide or the deck.
- AI speaker notes: generated alongside copy-polish during deck generation and on demand for one or all slides, written via `setPageNotes`; emitted into `Page.notes`.
- Image-per-slide: brand-grounded single-image generation ships (`groundImagePrompt`); a batch flow generates one style-consistent matching image per slide, placing first-class `ImageNode`s.
- Theme generation and chart-from-data: AI generates a swappable `Theme` (FR-4) the deck can adopt, and Magic Charts produces native `ChartNode`s (data binding via FR-8).
- Document / URL / file -> deck ingestion: a brief, article, PDF, Word doc, or URL is structured into an editable outline and expanded into native slides (Gamma import / Copilot create-from-file parity); imported source is sandboxed/SSRF-guarded (section 11).
- Deeper agentic editing: the assistant gains multi-slide narrative tools (add an agenda, insert a comparison slide, split a slide) and a per-issue accept/reject critique list, beyond the current ~12 coarse page-level tools.
- Speaker coach (FR-25) and AI alt-text/chart descriptions (FR-24) route through the same BYO-key layer; the coach keeps audio on-instance (in-browser ASR for the live-nudge path, the AI layer for the post-session report).

## 10. Performance and scale

- Present at 60fps: the slide rAF and the separate overlay rAF (laser/pen/spotlight) already keep magic tools from stalling the slide loop; the committed budget is a sustained 60fps present on a typical deck, with local edits applying in the same frame. The arriving slide and its two transition buffers are precomputed/prefetched before an advance so a transition never blocks on first paint (FR-28).
- Many animated objects: `poseDesignAt` is allocation-light and deep-clones a page per frame; for heavy slides, pose computation is bounded by visible animated nodes, and export sampling reuses the same path. The keyframe-channel additions (FR-12) compose without widening the hot 5-channel `AnimPatch` path (section 18).
- Large decks: `PagesBar` thumbnails virtualize and render at level-of-detail so a 200-slide deck does not materialize every thumbnail at full resolution; the present runtime keeps only the current, previous, and next slides hot.
- WebGL/WebGPU path: a GPU-accelerated path (on the engine roadmap) targets film-grade 3D/cinematic transitions and very large animated decks at 60fps, with Canvas2D as the stable fallback when WebGL/WebGPU is unavailable. This is the Phase 5 leap-ahead.
- Sustainability note: the free/ungated wedge shifts AI compute to the user's own key (no markup), but full-deck video render, live-audience fan-out, and analytics storage are server costs the open/self-host story owns; budgets and quotas for these run-time costs are stated per deployment and the heavy paths are job-queued, never inline.
- Budgets: 60fps present and transitions on a typical deck; a 200-slide deck navigable and editable without thumbnail-render jank; full-deck video export sampling at a committed frame rate without unbounded memory; live-audience fan-out to a committed concurrency budget (section 11), all proven under load in Phase 5.

## 11. Security and threat model

Present and delivery security is consolidated here rather than scattered across the AI, interop, and open-questions sections. Cross-cutting SSO/SCIM/compliance/observability infrastructure is owned by F38; this section covers the presentation-specific posture.

- Untrusted import: PPTX/ODP/Keynote-via-PPTX import parses untrusted zip archives, XML, embedded media, and fonts. The importer guards against archive bombs, entity-expansion/XXE, and path traversal, runs as a job (never inline), caps resource use, and validates the produced document at the write boundary (`persistence/validate.go`) so a malformed deck returns 422 and never persists. Any server-side fetch (linked media, remote images) is SSRF-guarded, consistent with the existing media guards.
- Untrusted embed and generated content: `EmbedNode` iframes are sandboxed; AI-ingested documents/URLs and any generated HTML are never executed with instance privileges; self-hosters get the same sandbox.
- Player-link access control: tracked per-audience links keep the existing share-link guards (password, expiry, rotate, disable, anonymous bounds); per-link analytics and the public embed honor the link's permission level, and the web player never exposes editor capabilities at a view-only link.
- Live present-time trust boundary: audience companions join over a session token; anonymous joiners are rate-limited on question/poll/reaction submission; a presenter can moderate (hide/remove) questions and reactions and mute the channel; poll votes are server-authoritative (per-user/anon budget, double-vote rejection, reveal-mode enforcement) through the Postgres mirror, because the `/realtime` relay is a blind relay and cannot enforce integrity in the CRDT alone. Multipresenter co-control is gated to a presenter role at the WS dispatch layer.
- Recording and media privacy: present-and-record captures the slide canvas, mic, and camera locally in the browser via `MediaRecorder`; the artifact is the user's, uploaded only on explicit save. Live captions and the speaker coach keep audio on-instance (in-browser ASR for live nudges; the BYO-key AI layer for the report), with no audio egress on self-host.
- AI and data residency: all deck AI routes through the workspace's own BYO key/endpoint, so deck and audience data stay on the self-hosted instance; no deck data egresses to a third party by default.
- Per-workspace data isolation is enforced at the query layer for every new table (polls, Q&A, live sessions, tracked links).

### Observability and metrics

All present/audience/export API handlers and the realtime dispatch emit structured JSON logs keyed by design id, workspace id, user id, session id, and request id (consistent with the existing services). Success metrics: time-to-interactive on present-open, sustained present frame rate under the section 10 budgets, PPTX round-trip fidelity rate (golden-set), AI deck/ingestion validity rate (section 16 eval), per-slide engagement (existing view-beats, extended to live sessions), and live-audience concurrency. Org-wide observability, tracing, and dashboards defer to F38.

## 12. Accessibility and i18n

- Alt text and reading order: `NodeBase` gains optional `altText` and `decorative`; `Page` gains a reading-order/tab-order list independent of z-order, surfaced as a Reading Order pane; a screen reader announces every object including AI-generated ones, in reading order, with role and description.
- Guaranteed slide titles: the slide master/layout title placeholder (FR-3) makes the page name a real accessible slide title so screen-reader users can navigate between slides.
- In-canvas WCAG 2.2 AA checker at authoring time flags low-contrast text, missing alt text, unreadable text, and missing titles with one-click fixes (extending `@hc/a11y` and the `qualityCheck` contrast logic from the design side to the slide surface), and a presentations ACR/VPAT is published with annual audits.
- Reduced motion: a first-class, settings-driven `prefers-reduced-motion` present mode (FR-16) cuts transitions to a cross-fade, suppresses emphasis loops and photo motion, and renders text reveals instantly, honoring the OS/user preference, an axis rare across all incumbents.
- Captions and translation: live captions (FR-21) serve deaf/hard-of-hearing audiences; AI translated captions serve multilingual audiences.
- Tagged export: accessibility-tagged PDF (PDF-UA) preserves structure, titles, alt text, and reading order in the exported file.
- i18n / RTL / CJK: sticky/text auto-fit and layout use `@hc/text` measured metrics so CJK/RTL/variable-width scripts are not misestimated; all present/HUD/audience UI strings are localized; whole-deck AI translation (FR-23) covers content.

## 13. Import / export and interop

- PPTX round-trip: a new `@hc/pptx` core (plus a Go encoder/decoder) maps slides to/from Office Open XML preserving editable text, shapes, notes, transitions, animations, and masters as faithfully as the model allows; lossy mappings (custom-keyframe -> baked, HyCanvas morph <-> PowerPoint Morph) are documented in a mapping table and a round-trip golden-set, and flattening is a last resort, never silent. This is the interop battleground that blocks PowerPoint-user adoption, so it ships in Phase 1.
- Cross-tool import: Keynote and Google Slides import bridge through PPTX; ODP (LibreOffice) and Markdown/Marp/Slidev import are open-ecosystem wedges (editable md<->deck is unsolved by incumbents who raster). All importers run as jobs and produce editable native `@hc/schema` nodes.
- Image/PDF/SVG export: ships for designs via `@hc/export` + the Go render engine; slides map to export pages, with accessibility-tagged PDF (PDF-UA) added (FR-22).
- Video export: full-deck MP4/WebM with synced animations, transitions, and narration (FR-19), and animated GIF, via the per-frame `poseDesignAt` sampler + the ported transition compositor (FR-13).
- Open format: every import, AI generation, and template lands as editable `@hc/schema` nodes with forward migration and lossless `UnknownNode` round-trip, the structural data-ownership differentiator vs Gamma's lock-in and PowerPoint/Keynote's proprietary blobs.

## 14. Phasing / milestones

Dependency-ordered, from closing table-stakes gaps to leaping ahead. Each phase is independently shippable. PPTX interop and accessibility foundations are front-loaded because they are credibility blockers for "beat PowerPoint" and for the accessibility-pillar claim; the slide master model is front-loaded because three later workstreams (accessible titles, AI layout grounding, brand restyle) depend on it.

Phase 1: close the table-stakes gaps (the tool must be a credible PowerPoint replacement).
- PPTX import and export round-trip (editable text/animations/notes/transitions/masters) as a new `@hc/pptx` core + Go path + job routes, with a documented mapping table and golden-set; ODP and Keynote/Google-via-PPTX import.
- Slide master / layout / placeholder model + a first-class swappable Theme record + slide sections + a grid/outline overview editing view (schema additions + cascade + `PagesBar`/overview UI).
- Accessibility foundation: `NodeBase.altText`/`decorative`, `Page` reading-order/tab-order + Reading Order pane, guaranteed slide titles via the title placeholder, an in-canvas WCAG 2.2 AA checker with one-click fixes, and accessibility-tagged PDF export.
- True second-display presenter view (`window.open` + `BroadcastChannel`) with wall clock and teleprompter; formalize the `prefers-reduced-motion` present mode.
- Lift the transition compositor into a pure `@hc/engine` helper (unblocks the web player and deck-to-video); a real web player link (engine-rendered slide nav + fullscreen + transitions) replacing the scroll-stack `SharedViewer`.
- Page-level animation build-order timeline + apply-to-all.

Phase 2: data, motion, and player productization (own the report deck and the share story).
- Charts bound to a live data source (sheet/CSV/connector) with refresh-on-present + chart-from-uploaded-file; bulk data-merge slide pipeline; rule-based adaptive smart-slide auto-layout.
- Motion: extra keyframe channels (color/size/skew/filter), motion paths + orient-to-path, media-bookmark triggers, richer text builds (per-line/paragraph/bullet + chart by-series), per-transition easing, and richer interaction triggers (play-media, run-animation, toggle-visibility, overlay) + hyperlink-only kiosk mode.
- Magic Move leadership: nested/grouped matching, eased/spring per-element morph, text glyph-level morph, shape/path/fill/color tween, force/break-match.
- Player productization: multiple named per-audience tracked links with passcodes + per-link/per-slide dwell analytics; public iframe/web embed; phone-as-remote.

Phase 3: record and full-deck video (own the async/video deck, ungated).
- Deck-to-video: per-frame `poseDesignAt` sampling across all slides + the ported transition compositor + exit clips, encoded to MP4/WebM with audio (extend `render/video.go`).
- Present-and-record: browser `MediaRecorder` capture of a live run (slide canvas + mic narration + camera bubble + ink/laser) to a downloadable/shareable video.
- Per-slide / background voiceover binding (`Page.narration` tied to slide + build timing) + recorded narration.
- AI deck completeness: AI speaker-notes generation, whole-deck translation, document/URL/file -> deck ingestion, clarifying-questions interview, deeper multi-slide narrative assistant ops, per-issue accept/reject critique, batch per-slide image generation, AI alt-text/chart descriptions, and streaming per-slide progress.

Phase 4: live audience + analytics (leap ahead, ungated).
- Audience-facing live present share (join link / QR) broadcasting the current slide over `/realtime` with a present-time trust boundary (moderation, rate-limit, anonymous bounds); remote-viewer follow and multipresenter co-control.
- Live Q&A with upvote/moderation, live polls/word-clouds/quizzes (`PollNode` + server-authoritative tally), and per-slide emoji reactions surfaced in the HUD.
- Live captions via SpeechRecognition overlaid on the audience slide + AI translated captions.
- Real-time live-audience dashboard layered on the existing view-beat/insights analytics.

Phase 5: design autopilot, motion craft, and performance (surpass on craft).
- AI design autopilot: layout-grounded generation from the master/layout model + template seed catalog; theme generation as a swappable Theme; Magic Switch/Resize parity extended.
- Speaker coach: BYO-key/self-host rehearsal with mic capture, pacing/filler/monotone/inclusive feedback (with gaze/eye-contact as a frontier), and saved reports.
- WebGL/WebGPU path for film-grade 3D/cinematic transitions and large animated decks (Canvas2D fallback retained); committed present/export perf budgets proven under load; `PagesBar` virtualization at scale.
- Configurable spring physics, a graphical bezier curve editor, Animation Painter, font-embedding-in-file, Markdown/Marp/Slidev round-trip; deferred items (AI voice/TTS, on-slide live camera, present-to-conferencing, publish-as-website, Prezi-style zoom) reassessed.

## 15. Acceptance criteria

These sample representative, testable criteria across the phases; a requirement not pinned to a numbered AC here is verified by the section 16 test plan.

- AC-1: A `.pptx` imports to editable native `@hc/schema` nodes (text, shapes, images, notes, transitions, animations, masters) with documented lossy mappings, and the same deck exports back to a valid `.pptx` that opens in PowerPoint; an older HyCanvas client opening the imported file preserves any new node types via `UnknownNode` (FR-27).
- AC-2: A slide master/layout cascade restyles all slides that use a layout; a built-in layout's title placeholder yields a screen-reader-navigable slide title; switching the deck `Theme` recolors and re-fonts the whole deck in one undoable action (FR-3, FR-4).
- AC-3: Entering present mode opens a second-display audience window mirroring the slide via `BroadcastChannel` while the primary shows the HUD with next-slide preview, notes, rehearsal timer, wall clock, and a scrolling teleprompter; with popups blocked it falls back to the same-window overlay (FR-15).
- AC-4: The page-level build-order timeline shows every animated element's order, start-mode, delay, and duration on one strip and reorders by drag; an apply-to-all op sets a transition across all slides (FR-10).
- AC-5: The transition compositor is a pure `@hc/engine` helper; the same transition renders identically in editor preview, present mode, the web player, and headless export (FR-13).
- AC-6: A `prefers-reduced-motion` present mode cross-fades transitions, suppresses emphasis/photo motion, and renders text reveals instantly when the OS/user preference is set (FR-16, FR-22).
- AC-7: A real web player link renders engine-drawn slides with arrow/click navigation, fullscreen, and transitions (not a scroll stack); a view-only link exposes no editor capability and keeps password/expiry guards (FR-26).
- AC-8: A `ChartNode` bound to a data source refreshes from the source on demand and on present, caches the last-fetched data in the file, and behaves as a static chart when offline or unbound; a CSV upload produces a native editable chart (FR-8).
- AC-9: A bulk data-merge run produces one native editable slide per data row over a template, mapping columns to text and image placeholders (FR-9).
- AC-10: A keyframe can animate color/size/skew/filter channels and follow an editable motion path with orient-to-path; an animation triggers at a media-bookmark timestamp; older tracks still behave as transform/opacity-only (FR-12).
- AC-11: Magic Move matches nested/grouped elements by stable schema id, morphs text glyph-by-glyph, tweens shape/fill/color, applies per-element easing/spring, and honors a force/break-match override (FR-14).
- AC-12: Present-and-record captures a live run (slide + mic narration + camera bubble + ink/laser) via `MediaRecorder` to a downloadable video; deck-to-video renders all slides with synced animations (incl. exit), transitions, and narration to MP4/WebM with audio (FR-19).
- AC-13: An audience scans a QR code, follows the presenter's current slide on a phone, submits an upvoted question, answers a server-authoritative poll (double-vote rejected, budget enforced, reveal honored), and sends a per-slide emoji reaction that surfaces in the HUD (FR-20).
- AC-14: Live captions overlay the audience slide and render in a subtitle language different from the spoken language via AI translation (FR-21).
- AC-15: AI generates speaker notes for one and all slides, translates the whole deck preserving layout, and ingests a document/URL/file into an editable native deck, each as one undoable scene-op with no rasterized output and no deck data egress on a self-hosted BYO key (FR-23).
- AC-16: Every node carries optional alt text and a decorative flag; a `Page` reading-order list drives screen-reader announcement independent of z-order; the in-canvas checker flags a low-contrast or missing-alt-text object at authoring time with a one-click fix; PDF export is PDF-UA tagged (FR-29, FR-22).
- AC-17: A 200-slide deck navigates and edits without thumbnail-render jank, and present sustains 60fps with the next slide and its transition buffers precomputed before advance (FR-28).
- AC-18: No present/delivery feature (presenter view, present-and-record, audience Q&A/polls/reactions, captions, analytics, AI deck generation, PPTX export) is gated behind a paid tier or watermarked; the full deck exports to the open format and runs self-hosted (differentiator 1).
- AC-19: The speaker coach captures mic audio through the BYO-key/self-host layer (or in-browser ASR for live nudges) and produces a saved rehearsal report (pacing, filler words, monotone, repetition, inclusive language) with no audio egress on self-host (FR-25).
- AC-20: A hyperlink-only kiosk mode disables linear advance so the deck navigates only via interaction triggers; play-media, run-animation, toggle-visibility, and show-overlay triggers fire as authored, and unsafe URL schemes stay refused (FR-16, FR-17).
- AC-21: Multiple named per-audience tracked links each report per-link, per-slide dwell analytics with passcodes; a public iframe embed renders the deck player at the link's permission level (FR-26).

## 16. Test plan

- Unit (pure cores): `@hc/pptx` slide <-> Office Open XML round-trip (golden fixtures, documented lossy mappings); `@hc/engine` pure transition compositor (identical output to the old present-only path) and new keyframe-channel interpolation; `lib/present.ts` teleprompter scroll math and caption timing; `@hc/aistudio` whole-deck translation iterator, speaker-notes, ingestion; `@hc/schema` migration steps for each new node type/field (older file opens, additive bump, `UnknownNode` preservation, default theme synthesized from palette/fonts).
- Backend (Go): PPTX/video/ingestion/translate/coach jobs through the job registry; server-authoritative poll vote store (budget, double-vote, reveal, per-workspace isolation); present-session and Q&A role gating and moderation; PPTX/ODP import archive-bomb/XXE/path-traversal/SSRF guards; RFC 7807 problem+json on every error path; structured-log assertions; boundary validation 422 on malformed import/AI output.
- Integration: realtime frame fan-out for present-along/present-control/question/poll-vote/reaction/caption; cross-instance behavior with Redis; CRDT convergence with the new node types/fields under concurrent edits; second-display `BroadcastChannel` sync.
- Frontend / E2E (compose stack, real browsers): second-display presenter view + teleprompter + reduced-motion present, the web player, the build-order timeline, motion paths, Magic Move flows, present-and-record capture, audience companion (follow/Q&A/poll/reaction/caption), data-bound charts, bulk merge, accessibility flows (reading order, checker, tagged-PDF).
- Load / perf: 200-slide deck navigation/editing without jank; sustained 60fps present with next-slide precompute; full-deck video export sampling within memory budget; live-audience fan-out to the committed concurrency budget.
- AI eval / golden-set: a harness scoring text-to-deck and ingestion correctness, layout quality, translation faithfulness (layout preserved), speaker-notes quality, and assistant action validity (no invalid ids, every action undoable) across multiple models, for reproducibility.
- Manual: presenter runbook (deliver a full talk end to end with second display, teleprompter, and audience companion); self-host smoke test with a BYO key proving no deck/audio egress; PPTX round-trip against real-world decks; accessibility audit against WCAG 2.2 AA.

## 17. Differentiators

- Everything free and unwatermarked: presenter view, present-and-record, audience Q&A/polls/reactions, captions, analytics, brand kits, custom fonts, and AI deck generation all ship ungated, where Canva caps Magic Design uses, Gamma paywalls PPTX/PDF, and PowerPoint gates Copilot behind licensing; the full deck-delivery suite is the wedge competitors gate (differentiator 1).
- Open file format + self-host + data ownership: every AI/generated/imported slide lands as editable native scene-graph nodes (never a flattened render or locked blob), fully exportable, forward-migratable, and runnable on-prem, attacking Gamma's lock-in and the export gap that killed Tome (differentiator 6).
- One WYSIWYG animation engine across preview/present/export: a single pure, framework-agnostic `@hc/engine` core renders entrance/exit/emphasis/keyframes/sequencing/reveals/Ken Burns identically in the browser and headless, with 11/6/8 presets, 9 easings, and freeform bezier; no incumbent ships a free, self-hostable engine with this property (differentiator 4).
- Magic Move on stable schema ids: id-then-name matched morph already beats PowerPoint's heuristic matching and Slides (none) today, and extending it to nested/grouped, eased/spring, and text-glyph morph reaches and exceeds Keynote on a free web tool (differentiator 3).
- AI-native deck generation + design autopilot on BYO-key AI: prompt/doc/URL-to-deck, design autopilot, whole-deck translation, AI speaker notes, theme generation, and chart-from-data, all producing editable native slides on the user's own model with no markup and no data egress (differentiator 5).
- Self-hosted web-first player links with per-slide engagement analytics: tracked per-audience links with per-slide dwell on the customer's own infrastructure, an axis where PowerPoint/Slides/Keynote have nothing and Pitch/Gamma/DocSend are hosted-only (differentiator 6).
- Present-and-record + live audience interaction ungated and native: live-run capture and a join-link audience companion with Q&A/upvote/polls/reactions/translated captions over the already-shipped `/realtime` relay, not a paid Mentimeter/Slido/Canva Live add-on (differentiator 7).
- Accessibility as a category lead: an in-canvas WCAG 2.2 AA checker with one-click fixes, AI alt-text + chart descriptions, a reading-order model, guaranteed slide titles, accessibility-tagged PDF export, and a first-class reduced-motion present mode, an axis where every incumbent is weak on motion-sensitivity (differentiator 7).

## 18. Open questions and risks

- Second-display presenter view: `window.open` + `BroadcastChannel` (popup-blocker and cross-window engine-render cost) vs the Presentation API vs a separate route fed by the `/realtime` relay. Which gives the most reliable cross-browser audience window without doubling render cost? Mitigation: prototype `BroadcastChannel` first (the code already flags it as the intended path), fall back to a relay-fed route, and to a same-window overlay if popups are blocked.
- Transition compositor port: lifting `renderTransition` out of `PresentMode.tsx` into a pure `@hc/engine` helper is needed for the web player and deck-to-video but requires refactoring the present runtime. Working assumption: port it in Phase 1 since both the web player and deck-to-video depend on it; keep the present runtime calling the same pure helper to avoid drift.
- PPTX fidelity ceiling: how much of HyCanvas's animation/morph/keyframe model maps cleanly to PPTX (and back) without flattening? Where do we accept lossy round-trip (custom-keyframe -> baked, morph <-> PowerPoint Morph) vs refuse? Mitigation: a documented mapping table and a round-trip golden-set; flatten only as a last resort and never silently.
- Masters/layouts/theme cascade: a full PowerPoint-style two-tier master->layout inheritance vs a lighter single Theme + named layouts. How much inheritance complexity is worth it given the open format must stay additive and forward-migratable, and three workstreams (accessible titles, AI layout grounding, brand restyle) depend on it? Spike the minimum model that satisfies all three before Phase 1.
- The `AnimPatch` 5-channel ceiling: adding color/size/skew/filter and a motion-path channel risks breaking the deliberate 5-channel contract (`dx,dy,scale,rotate,opacityMul`) that keeps browser and headless identical. Do we widen `AnimPatch` (risking export/preview drift) or add a parallel path/extra-channel evaluation pass that composes into the existing patch? Working assumption: a parallel pass that does not change the 5 core channels; spike it.
- Live audience scale and trust: how many concurrent audience devices must the `/realtime` relay carry per session, and what is the moderation/rate-limit/anonymous-abuse model for Q&A/polls/reactions? Does live-session state stay entirely out of the file format (Postgres + relay, mirroring engagement/`AiSession`)? Working assumption: yes; commit a concurrency budget and a present-time trust boundary (section 11).
- Present-and-record codec/quality: browser `MediaRecorder` (VP9/H.264 availability varies by browser) for client capture vs server-side compositing via the Go render engine for deterministic quality. Default and dual-mode? Mitigation: client capture for the live-run artifact (live narration/camera), server re-render for the high-quality clean export.
- Speaker-coach data residency: mic capture + transcription must run through the BYO-key layer with no audio egress on self-host. Is in-browser ASR (WebSpeech) viable for the live-nudge path, with the AI layer only for the post-session report, or do we need a self-hostable ASR? Spike WebSpeech vs a self-hostable ASR.
- Live data-linked charts: which connectors at launch (Google Sheets, CSV upload, generic HTTP/JSON), and how does refresh-on-present behave offline or on a shared player link where the source may be unreachable or access-controlled? Working assumption: cache last-fetched data in the file, refresh best-effort, never break the slide.
- Analytics privacy on self-host: per-viewer/per-slide dwell analytics are powerful but sensitive. What is the consent/anonymization default, and how do anonymous (anonId) viewers reconcile with named viewers across multiple tracked links? Mitigation: anonymize by default, make named attribution opt-in per link.
- Web player vs publish-as-website overlap: the deck web player and a deck-as-microsite/custom-domain (Gamma-style) overlap with any future website feature. Where is the boundary, and does the player live in `pages/shared.tsx` or a dedicated publishing surface? Defer the microsite; ship the player first in `pages/shared.tsx`.
- Non-linear / Prezi-style zoomable presenting: worth the engine work given transitions are pairwise full-frame composites today, or is hyperlink-only kiosk navigation (cheaper, builds on Interaction) enough to cover interactive/branching decks? Working assumption: ship hyperlink-only kiosk first; treat continuous-canvas zoom as a deferred spike.
- Web-only scope and mobile: HyCanvas ships no native mobile client by design, so the phone-as-remote and audience-companion web pages are how phones participate. Risk: a pure-web presenter remote and audience companion must be reliable across mobile browsers (background tab throttling, wake-lock). Mitigation: treat the companion as a first-class responsive PWA surface, not an afterthought.
