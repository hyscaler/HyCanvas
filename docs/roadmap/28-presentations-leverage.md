# F28 Presentations: Reference-Implementation Leverage Map

| Field | Value |
| --- | --- |
| Role | Companion to `28-presentations.md` (F28). Not a feature spec: an implementation-acceleration map and a code-verified drift report |
| Date | 2026-08-22 (code audited at HEAD `730406e`) |
| Sources | Two local reference codebases plus a combined R&D specification (section 1) |
| Owner scope | Everything here lands under F28's existing FR ids unless marked "candidate new scope" (section 5) |
| Execution | The task-level implementation brief (per-task files, references, acceptance criteria, status board) is [`28-presentations-leverage-tasks.md`](28-presentations-leverage-tasks.md) |

## 1. What this document is

We have full code access to two open-source AI presentation generators and a 651-line combined R&D specification distilled from them plus an August 2026 market scan:

- **Reference A**: `/Users/mdmotahiralam/mdWorld/internal/experiments/presenton` (Apache 2.0). Fixed-canvas object model, template-schema-driven generation, public generation API, server-side export. Python backend + TypeScript frontend.
- **Reference B**: `/Users/mdmotahiralam/mdWorld/internal/experiments/presentation-ai` (MIT). Flowing document model, streamed XML component dialect, theme system. TypeScript.
- **R&D spec**: `/Users/mdmotahiralam/mdWorld/internal/experiments/presenton/RND-PRESENTATION-CREATOR.md`. Sections cited below as "RND n".

This document maps that material onto F28's remaining work. For each item: what HyCanvas has today (code-verified), what the reference implements, and what is worth porting. The references mostly contribute PROVEN BUSINESS LOGIC AND PROMPT CORPUS rather than droppable code: Reference A's backend is Python (ours is Go) and Reference B's editor is a rich-text framework (ours is a scene graph), so the transferable assets are rules, constants, prompts, schemas, algorithms, and test fixtures, not modules.

Guardrails this document holds itself to, per `CLAUDE.md` and the F28/roadmap conventions:

- Every generated or imported slide lands as editable native `@hc/schema` nodes. Reference A's "Smart HTML mode" (RND 15) is therefore explicitly NOT adopted; it is the anti-pattern F28 already rejects.
- Everything stays free and ungated. The references' and market's metering, watermarking, and tier-gating logic (RND 31.7) is documented context only; none of it is proposed.
- AI stays BYO-key with no data egress; schema changes stay additive with claimed version numbers; scope needs demand evidence (the creation-depth withdrawal is the standard).

## 2. Code drift found during the audit (repair before building)

The audit that produced this document compared F28's "Current state" against HEAD and found real divergence. These are defects or stale claims, not new scope, and several silently disable shipped F28 features. Echoing the roadmap's own lesson that phase-one work is often "defect repair wearing feature clothing": this is that repair list.

1. **Assistant tool catalog divergence (functional defect).** The client catalog (`packages/aistudio/src/assistant.ts`) declares 23 tools; the Go catalog (`backend/internal/aistudio/generate.go`, `assistantTools`/`assistantCatalog`) lists 18. `translateDeck`, `generateSpeakerNotes`, `generateDiagram`, `clusterStickies`, and `summarizeStickies` are missing server-side, and since `/v1/ai/assistant` is the preferred path and `validateAssistant` drops unknown actions, whole-deck translation and AI speaker notes (both marked Built in F28) are unreachable in a normal deployment. Fix: single-source the catalog (generate the Go list from the TS one or vice versa) and add a parity test.
2. **Generated decks ship without speaker notes.** `buildDeckFromOutline` (`frontend/src/store/editor.ts`) creates pages with no `notes` at all. Reference A's rule is the fix pattern: every structured generation carries a required plain-text speaker note of 100..500 chars (RND 13); generate notes in the same pass instead of as a separate later tool call.
3. **`generateDesign` is destructive by default.** It replaces every page unless the model happens to pass `mode:"append"`. Flip the default to append-or-confirm; Reference A never deletes old slides until all new slides exist (RND 13, "old slides are deleted only AFTER all new slides exist").
4. **The outline review UI no longer exists.** F28 marks "outline-first editable flow" Built via `StudioPanel`, but commits `75febeb`/`24aadff` deleted `StudioPanel`, `MagicDesignPanel`, `TransformPanel`, `ChartPanel`, and `ImprovePanel`; `docs/shipped/39-ai-creative-studio.md` still describes all five as shipped. The pure cores survive orphaned (`deriveOutline`, `switchOutline`, `recomposeSpec`, `paletteTheme`, `qualityCheck`, `outlineItemToSpec`, `buildAiDesign`). Either restore an outline surface (section 3.3) or update F28/F39 docs to match reality.
5. **Implemented but unreachable endpoints and fields**: `POST /ai/variations`, `POST /ai/chart`, `POST /ai/style-profile`, `POST /ai/critique` have zero frontend callers; the AI policy and usage endpoints have no admin UI; the `imageModel` config field is never sent by `saveConfig`; 7 of 11 provider presets are absent from the provider dropdown; `maskBase64` (outpaint/inpaint) has no client caller; `recordProvenance`/`doc.meta.aiProvenance` is never invoked. Decide per item: wire it or remove it.
6. **The `azure-openai` preset is nominal.** The transport sends a bearer token to `{base}/chat/completions`; real Azure needs an `api-key` header and deployment-scoped paths. Fix or drop the preset.
7. **Stale docs**: `docs/shipped/39-ai-creative-studio.md` (five deleted panels described as shipped) and `docs/FEATURES.md` (lists shipped F28 items as not done). Bring both in line with code.

## 3. Acceleration map for F28's remaining and planned work

### 3.1 Structured output and validation retries (foundation for every AI item below)

- Today: no `response_format`, no tool-calling; every schema is prompt-embedded and hand-parsed (`extractJSON`, 3 retries with a corrective hint).
- Reference A runs schema-constrained responses on every provider that supports them, restates the schema in the prompt as belt-and-braces, and layers a repair loop: up to 3 attempts for parseable output, then up to 4 validation passes where each failure feeds back up to 10 validation errors plus the previous invalid output before regenerating, accepting the final pass with a warning (RND 13; `servers/fastapi/utils/llm_utils.py`, `llm_calls/generate_slide_content.py`). Its extraction ladder (native structured object, serialized object, lenient JSON parse, fail) and per-provider quirks table (RND 27) are directly portable to `backend/internal/ai/provider.go`.
- Port: native structured-output support in the two wire dialects, the validation-feedback repair loop in `backend/internal/aistudio`, and the lenient-parse ladder. This raises the validity rate of every existing generator (outline, chart, assistant plan, SVG) before any new feature is built.

### 3.2 Streaming per-slide progress (F28 "watch slides appear", currently P2)

- Today: no streaming anywhere; jobs run inline and are already complete when the POST returns.
- Reference A streams generation as typed events: a synthetic opening chunk for incremental parsing, one event per slide the moment its content plus placeholder assets exist, later `slide_assets` events carrying resolved image URLs per slide with non-fatal warnings, and a completion event; the client never lets a late coarse payload clobber an already-resolved asset and drops the stream flag from the URL on completion (RND 13; `api/v1/ppt/endpoints/presentation.py` stream route). Reference B's complementary trick: deterministic IDs derived from content fingerprints so a full re-parse per frame keeps stable editing identity during the stream (RND 14; `src/components/notebook/presentation/utils/parser.ts`).
- Port: an SSE (or `/realtime` frame) variant of `generate-design` emitting outline, per-page, and per-asset events; pages append into the doc as they validate (the CRDT already tolerates incremental insertion); asset resolution decoupled from page emission per 3.6.

### 3.3 Outline review surface (restores a deleted capability; feeds FR-23's interview flow)

- Today: the outline is generated and immediately laid out; the user never sees or reorders it.
- Reference A's outline stage rules: editable Markdown per item with a hard 100-word re-trim on commit, drag reorder, add capped at the deck maximum, regenerate-as-new, and streaming display that highlights the item being written (RND 11.1). Reference B adds the customization dials worth copying verbatim as enums: text density (minimal/concise/detailed/extensive with concrete meanings), tone, audience, scenario (RND 8.2), and the rule that outline item count, not the requested count, becomes the slide count.
- Port: a thin outline step inside the assistant flow (or a restored panel) over the existing `DesignOutline` model, plus the dials as optional prompt parameters. Reference A's count math including agenda synthesis is in 3.11.

### 3.4 Layout-grounded generation (FR-3 grounding, FR-23 autopilot; the largest single lever)

- Today: two disconnected layout systems. `@hc/aistudio` lays out with 4 internal intents and never touches `masters`/`layouts`/`placeholders`/`Page.layoutId`; the schema's master/layout/placeholder cascade (v11) ships with 5 built-in layouts and a materialization model, but AI never uses it.
- Reference A's architecture is the proven pattern for exactly this (RND 6): a layout tree annotated with a `decorative` flag (content slot vs fixed scaffolding) and per-slot capacity constraints (min/max text length with `min ~ ceil(max/2)`, min/max items, min/max children), from which a machine-readable content schema is DERIVED deterministically per layout; the model fills the schema, never invents geometry; a selector picks one layout per outline item from layout names and descriptions with variety rules and repair (out-of-range index replaced by a random valid one) (RND 12.1); hydration merges content into a deep copy of the layout with name-matching fallbacks.
- Port onto HyCanvas's own model: extend `Placeholder` with optional capacity fields (`maxChars`, `minChars`, item ranges for list-role slots): additive, one claimed schema version bump. Derive a per-layout content schema from placeholders exactly as Reference A derives it from elements (`servers/fastapi/templates/v2/schema.py` is the reference algorithm). Generation then: outline item -> pick a `SlideLayout` by role/description -> fill its derived schema -> `applyLayoutToPage` + write content into the materialized placeholders, setting `Page.layoutId`. This unifies the two layout systems, makes `savePageAsLayout` outputs immediately AI-usable, and gives FR-7 its capacity contract (a layout's declared maxima are promises geometry must keep).

### 3.5 User deck to reusable layout set (candidate new scope; see section 5.1)

### 3.6 Batch image-per-slide and the asset pipeline (FR-24)

- Today: hero background generation for at most 3 roles runs inline and blocks; no image library reuse; no AI selection from the bundled stock/Openverse/Iconify catalogs; alt text is a best-effort afterthought.
- Reference A's pipeline rules (RND 16.1; `utils/process_slides.py`, `services/image_generation_service.py`): PLACEHOLDER-FIRST (every slot renders instantly with a bundled placeholder; generation fills in behind), per-slide assets fetched concurrently while the next slide's text generates, failures degrade to the placeholder plus a per-slide warning instead of failing the deck, generated images recorded in a per-user library WITH their prompts, and edit-time reuse by prompt equality (identical prompt = reuse the URL, zero cost). Reference B adds job keying that stamps the owning document so a late async result cannot land on a different deck (RND 16.2).
- Port: a placeholder-first per-slide image job model over the existing job registry, prompt-keyed reuse against workspace assets, and an assistant/stock bridge so the model can SELECT from Openverse/Iconify (both already integrated) before generating; the icon path is a query against the existing Iconify search rather than Reference A's embedding index. Alt text generation moves into the same pass (FR-24/FR-29 pairing).

### 3.7 Ingestion depth (extends the shipped attach flow toward FR-23's ingestion claim)

- Today: paste, one URL, `.txt/.md/.pdf` (text layer only; a scanned PDF yields nothing); one source at a time; 60k char cap.
- Reference A (RND 9): accepts office documents and spreadsheets by direct OOXML extraction, images via OCR, detects scanned PDFs by sampling the first 5 pages for under 50 chars of text and re-parsing at 300 DPI, validates type by MIME AND extension, allows 8 files per generation, and ships a decompose step where the user previews and EDITS extracted text per file before generating. Its heading-score chunker (score headings by level and spacing, pick top-K spread evenly) is the designed path for very large sources.
- Port: multi-attachment support, OOXML text extraction (straightforward in Go), the scanned-PDF heuristic with an optional OCR dependency for self-hosters, and the review-extracted-text step.

### 3.8 Web research and content verification (F28 deferred item)

- Reference A (RND 10): a routing decision (native provider search tool when available, else an explicit external provider, else proceed without), an AI-written query capped at 12 words/200 chars with recency terms and a truncation fallback, 1..10 results, and results framed as UNTRUSTED reference material with instructions ignored and citations never invented. Failures never abort generation.
- Market logic worth pairing (RND 31.1): verification as a distinct action that cross-checks figures against sources or attachments and leaves citation marks that export into speaker notes.
- Port: a `webSearch` assistant tool behind the existing SSRF-guarded fetch infrastructure, the query-writing rules as a prompt, and (later, with FR-2 rich notes) citation trails into notes. Keeps to BYO-key: external search APIs are workspace-configured like AI providers.

### 3.9 Per-slide AI edit and regeneration (new capability inside FR-23)

- Today: no AI on `PagesBar`, `SlideOverview`, or selection; the unit of generation is the whole document.
- Reference A's single-slide edit logic (RND 20): re-pick the layout if the instruction warrants, rewrite content against that layout's schema, DIFF asset prompts so only changed images regenerate, and rotate the slide's identity so clients detect the change. Reference B's variant preserves the slide id and existing root image on regenerate and length-checks parallel id/content arrays (RND 20).
- Port: a `regenerateSlide(pageIndex, instruction)` assistant tool built on 3.4's layout-grounded fill, with asset-prompt diffing from 3.6. HyCanvas keeps stable node ids (Magic Move depends on them), so adopt Reference B's preserve-identity stance, not Reference A's rotation.

### 3.10 Theme generation and the brand bridge (FR-4 UI + AI)

- Today: the swappable `Theme` record ships with no editor UI; AI decks never set `DesignFile.theme`; `themeFromPalette()` is implemented and uncalled; brand kits do not produce themes.
- Reference A's algorithmic palette generator (RND 7.2): perceptual color space, a fixed lightness ladder, dark classification below a lightness threshold, card/stroke at ladder distances from the background, graph colors as reversed primary variations, and retry-until-contrast for seeds. Reference B (RND 7.1): 38 concrete token sets with 19 font pairs as ready-made theme content, an AI theme block emitted during outline generation with strict hex validation and PARTIAL-TAG STRIPPING so half-streamed theme markup never leaks into visible text, and per-theme customization memory (tweaks remembered per theme and restored on switch).
- Port: a theme swap UI over `applyTheme()`, `themeFromPalette()` wired to brand kits, the palette generator as the "generate a theme" primitive, AI theme emission in outline generation writing a real `Theme`, and Reference B's 38 palettes re-expressed as seed `Theme` records (MIT, attribution per section 6).

### 3.11 Structure synthesis: agenda and narrative ops (FR-23 deeper assistant ops)

- Reference A's agenda/TOC synthesis is fully algorithmic and portable as-is (RND 12.1): entry count `ceil((total - title_flag)/10)` per pass, layout chosen by priority regex over layout names/descriptions with a list-layout fallback and silent skip, insertion after the title slide, page numbers accounting for inserted slides, per-item titles extracted by first-heading/first-sentence/first-line fallback.
- Port as assistant tools: `insertAgenda`, `splitSlide`, `insertComparison`: exactly the multi-slide narrative ops F28 names as missing.

### 3.12 Prompt corpus (cheapest high-value port; applies across 3.1..3.11)

Reference A's prompts encode hard-won content rules worth adopting nearly verbatim (RND 11, 13): the authoritative-settings block that overrides instructions embedded in user content; the CONTENT-ONLY rule (production directives like "add a bar chart" must never appear as visible text; chart intent materializes as labeled numeric data); verbosity word targets (~20/40/60 words per slide); image prompts and icon queries always in English regardless of deck language; never exceed length limits and never clip mid-sentence (rephrase); untrusted-source framing for web/document content; slide-scoped instructions applied once. Reference B contributes the geometry-conditioned component rules (wide components under top images, compact under side images) that translate to layout-role selection hints.

### 3.13 Remaining F28 items with reference support

| F28 item | Reference leverage |
| --- | --- |
| FR-27 PPTX fidelity tail | Reference A's export rules as a checklist and golden-set source: shadow selection scoring, multiline line-height correction, bold at weight >= 600, image pre-compositing (corner rounding before AND after resampling), cross-suite compatibility fixups (RND 24.1); its font-variant extraction from OOXML including embedded-font recovery (RND 18 step 2). For byte-preserving round-trip, the GenOffice engine (Apache 2.0, see RND 31.8) archives the original and re-emits only modified OOXML fragments |
| FR-19 camera bubble | Reference B's recording compositor: webcam drawn at a draggable overlay position with rounded-rect clipping and cover-cropping into the capture canvas (RND 21; `src/hooks/presentation/useRecording.ts`) |
| FR-26 tracked links | Market API shapes for per-link, per-viewer analytics endpoints (RND 31.5); extends the shipped view-beat model |
| FR-8 chart data depth | Reference B's chart data editor schemas incl. CSV/XLSX header normalization (RND 19); computed-values-from-data via `@hc/formula`/`@hc/sheets` instead of model-guessed numbers (the market's strongest trust feature, RND 31.1) |
| FR-25 speaker coach | Rubric only: pacing, filler words, monotone, repetition, inclusive language, verbatim-reading detection (RND 31.5) |
| Diagram depth | Reference B's semantic parse -> multiple candidate visualizations -> orthogonal style pattern (RND 17); HyCanvas's whiteboard diagram-from-prompt already emits native nodes, so this extends `generateDiagram` to slide-scoped native output rather than adopting Reference B's renderer |

## 4. Programmatic generation API (F28 deferred; ready reference exists)

F28 defers "add-ons / automation API" pending an integrations layer. Reference A ships the complete pattern (RND 25): a one-shot generate endpoint (prompt or per-slide markdown, template, language, tone, flags, export format), an async variant with a human-readable progress sequence and per-batch counts, webhooks for completion/failure, and an agent-protocol endpoint exposing exactly three tools behind API keys. HyCanvas prerequisites are real (API keys as a principal, a durable job store rather than the in-memory registry), so this stays sequenced after the integrations layer, but the endpoint contract, progress-message design, and webhook semantics can be adopted from Reference A wholesale when it lands.

## 5. Candidate new scope (evidence-framed, per the withdrawal discipline)

1. **Import a deck as a reusable layout set.** Reference A's strongest unique subsystem (RND 18): an uploaded PPTX becomes a first-class AI-fillable template: fonts resolved per variant, slides decomposed to primitives, a vision model segments each slide into components, classifies decorative vs content, assigns capacity constraints, and MUST self-review by rendering its candidate layout to an image (at most twice, with bounded retries); components cluster into reusable blocks. HyCanvas already has the two halves this bridges: PPTX import to editable nodes and `savePageAsLayout`. Evidence: F28 itself calls template-catalog breadth an existential content gap, and this turns every user's existing deck into catalog content. Proposed as a Phase 5 FR extension once 3.4 lands (the capacity model is a prerequisite). The self-review render loop maps onto the existing Go render engine.
2. **Content verification with citations.** Pairs with 3.8; gated on FR-2 rich notes for citation placement. Market evidence: reviewers single it out as the category's missing trust feature (RND 31.1).
3. **Brand kit from a domain.** Enter a company URL; extract logo, palette, fonts into a brand kit draft for confirmation. Every 2026 commercial tool ships it (RND 31.3); the SSRF-hardened fetch path already exists (`extracturl.go`). Small, self-contained, high onboarding value.
4. **Declined for now** (weak or conflicting evidence, recorded so it is not re-litigated silently): packaged expertise "skills" as a template replacement (speculative, no demand signal from this audience); annotate-to-edit drawing queues (novel UX, no evidence it beats the existing assistant + selection context); deck-as-conversion-funnel features (lead forms, booking, payments: a different product's territory); anything from RND 31.7 (metering/watermarks/tiers: conflicts with the free-and-ungated pillar); Reference A's whole-deck HTML mode (conflicts with native-nodes rule).

## 6. Porting rules and legal hygiene

- Licenses permit everything proposed: Reference A is Apache 2.0 (patent grant; preserve LICENSE/NOTICE for any copied code), Reference B is MIT (preserve copyright notice). Neither name may be used in product naming or code identifiers (also the repo's own naming convention: describe by function).
- Track provenance: any file or substantial logic ported from a reference gets a line in a `THIRD_PARTY` record naming source path, license, and commit.
- Port logic, not code, across stack boundaries (Python to Go, rich-text framework to scene graph). Prompts, constants, schemas, regexes, and test fixtures port directly; Reference A's golden decks and Reference B's parser fixtures are ready-made test inputs.
- Reference B is an extracted build of its upstream with known dead code and defects (catalogued in RND 29); verify against upstream before porting anything load-bearing from it.
- Every schema addition here is additive (capacity fields on `Placeholder`, nothing else identified); claim the version number in `docs/roadmap/README.md` first, bump both sides, add the migration, per the zero-data-loss rules.

## 7. Suggested sequencing

Dependency-ordered; each step independently shippable. F28's own phase numbering is the umbrella; this sequences only the leverage work.

1. **Repair (section 2):** catalog parity + test, notes-bearing generated decks, non-destructive generation default, provider dropdown/config gaps, doc corrections. Small diffs, restores already-claimed F28 capabilities.
2. **Generation core:** structured output + validation-repair loop (3.1), prompt corpus (3.12), outline review surface with dials (3.3), placeholder-first asset pipeline (3.6). These raise output quality for everything that exists today.
3. **Layout grounding:** capacity fields + derived layout schemas + layout-grounded fill (3.4), agenda synthesis and narrative ops (3.11), per-slide regeneration (3.9). This is the FR-3/FR-7/FR-23 convergence and the largest quality jump.
4. **Sources and trust:** ingestion depth (3.7), web research (3.8), computed chart values (3.13), streaming progress (3.2).
5. **Design system:** theme UI + AI themes + brand bridge (3.10), then the deck-to-layout-set import pipeline (5.1) and brand-from-domain (5.3).
6. **Platform tail:** PPTX fidelity extras and camera bubble (3.13), programmatic API when the integrations layer exists (4), verification with citations once FR-2 rich notes land (5.2).
