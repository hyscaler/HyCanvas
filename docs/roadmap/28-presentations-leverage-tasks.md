# F28 Leverage: Implementation Task Brief

| Field | Value |
| --- | --- |
| Role | Execution-grade task list for the work planned in `28-presentations-leverage.md`. Written to be picked up and implemented task by task by an AI coding session running in this repository |
| Date | 2026-08-22 (audited at HEAD `730406e`; re-verify line numbers before editing, they drift) |
| Parent docs | `28-presentations.md` (F28 spec), `28-presentations-leverage.md` (rationale and evidence for every task here) |

## How to use this document (read this first, every session)

You are implementing one task at a time from the table below. For each session:

1. Read `CLAUDE.md` at the repo root. Its rules override anything here, especially the Zero Data Loss schema rules, the naming conventions, and the theming rules.
2. Read this section, then read ONLY your task's entry and its listed references. Do not try to implement multiple tasks in one change unless the task says so.
3. The two reference repositories are READ-ONLY sources of business logic, prompts, constants, schemas, and test fixtures:
   - Reference A: `/Users/mdmotahiralam/mdWorld/internal/experiments/presenton` (Apache 2.0, Python backend + TS frontend)
   - Reference B: `/Users/mdmotahiralam/mdWorld/internal/experiments/presentation-ai` (MIT, TypeScript)
   - The R&D spec distilled from both: `/Users/mdmotahiralam/mdWorld/internal/experiments/presenton/RND-PRESENTATION-CREATOR.md` (cited as "RND n")
   - Never modify these repos. Verify a referenced path exists (`ls`, `grep`) before relying on it; if it moved, find it by symbol name.
4. Porting rules: port LOGIC, not code, across stack boundaries (Python to Go, rich-text framework to scene graph). Prompt text, constants, regexes, schemas, and algorithms may be adapted nearly verbatim. When you copy or closely adapt code (as opposed to logic), append a line to `THIRD_PARTY.md` at the repo root (create it if absent) naming the source repo, path, license, and date. Never use the reference products' names in code identifiers, comments, commit messages, or user-facing strings (repo naming convention: describe by function).
5. Schema changes: only the tasks that say so touch `@hc/schema`, and they are strictly additive. Follow the full protocol: claim the next free version number in the table in `docs/roadmap/README.md` FIRST (the table has been stale before; verify against `CURRENT_SCHEMA_VERSION` in `packages/schema/src/schema.ts` and the Go mirror in `backend/internal/persistence/file.go`), bump both sides in the same change, register the forward migration in `packages/schema/src/migrate.ts`, and append the version-history line in `schema.ts`.
6. New user-facing strings must be localized: add keys to all 8 locale catalogs (run `npm run i18n:extract` and `npm run i18n:coverage`). API errors are RFC 7807 problem+json with stable codes. Long-running server work goes through the job registry, never inline in a handler.
7. Verify before you finish, honestly:
   - `npm run build:packages` (required after editing any `packages/*` source)
   - `npm run test` (packages + Go), and targeted: `cd backend && go test ./...`, plus the specific package test you added
   - `npm run lint`
   - A manual check per the task's acceptance criteria (run `npm run dev` when a UI check is listed)
8. When a task is done: flip its Status in the table below to `done` (with the date), and if the task changed F28 scope or status, update `28-presentations.md` per the keep-in-sync convention. Keep commit messages short and descriptive of what changed.
9. If a task turns out to be already done, wrong, or blocked, do NOT force it: update its Status to `blocked` or `dropped` with a one-line reason and stop.

## Task status board

| Task | Phase | Title | Status |
| --- | --- | --- | --- |
| T01 | 0 Repair | Assistant tool-catalog parity + test | done 2026-08-22 |
| T02 | 0 Repair | Generated decks carry speaker notes | todo |
| T03 | 0 Repair | Non-destructive generation default | todo |
| T04 | 0 Repair | Provider config gaps (dropdown, imageModel, azure preset) | todo |
| T05 | 0 Repair | Sync stale docs to code | todo |
| T06 | 1 Core | Native structured output in the provider layer | todo |
| T07 | 1 Core | Validation-repair loop in the orchestrator | todo |
| T08 | 1 Core | Port the prompt rule corpus | todo |
| T09 | 1 Core | Outline review step + generation dials | todo |
| T10 | 1 Core | Placeholder-first per-slide image pipeline + stock selection | todo |
| T11 | 2 Layout | Capacity fields on Placeholder (schema bump) | todo |
| T12 | 2 Layout | Derived layout schemas + layout-grounded generation | todo |
| T13 | 2 Layout | Narrative ops: insertAgenda, splitSlide, insertComparison | todo |
| T14 | 2 Layout | Per-slide AI regeneration | todo |
| T15 | 3 Trust | Ingestion depth: multi-file, office formats, scanned-PDF detection | todo |
| T16 | 3 Trust | Web search tool with untrusted-source framing | todo |
| T17 | 3 Trust | Computed chart values from attached data | todo |
| T18 | 3 Trust | Streaming per-slide generation progress | todo |
| T19 | 4 Design | Theme UI, brand-to-theme bridge, AI theme generation | todo |
| T20 | 4 Design | Import a deck as a reusable layout set | todo |
| T21 | 4 Design | Brand kit draft from a company domain | todo |
| T22 | 5 Tail | PPTX fidelity golden set + present-and-record camera bubble | todo |
| T23 | 5 Tail | Programmatic generation API (blocked) | blocked: integrations layer |

Dependencies: T06 and T07 before T09/T12/T14/T16; T01 before any task adding assistant tools (T13, T14, T16); T11 before T12; T12 before T13/T14/T20. Everything in Phase 0 is independent and can be done first in any order.

## Phase 0: Repairs

### T01: Assistant tool-catalog parity + test

- Problem: the client catalog (`packages/aistudio/src/assistant.ts`, `toolCatalog()`, 23 tools) and the Go catalog (`backend/internal/aistudio/generate.go`, `assistantTools` string and `assistantCatalog` map, 18 tools) have diverged. Missing server-side: `translateDeck`, `generateSpeakerNotes`, `generateDiagram`, `clusterStickies`, `summarizeStickies`. Since `POST /v1/ai/assistant` is the preferred path and `validateAssistant` (`backend/internal/aistudio/specs.go`) drops unknown actions, those five tools are unreachable in normal deployments.
- Do: add the five tools (names, param specs, one-line descriptions) to the Go catalog and the assistant system prompt it builds. Then prevent recurrence: add a parity test. Simplest robust approach: a small generator or a checked-in JSON manifest of tool names + param names that both a TS test (`packages/aistudio/src/__tests__/assistant.test.ts`) and a Go test (`backend/internal/aistudio/`) assert against, so either side drifting fails CI.
- Acceptance: in a dev run, asking the assistant to "translate this deck to German" and "write speaker notes" produces plans containing those actions via the server path (not the local fallback); the parity test fails if a tool is added on one side only.
- Verify: `npm run build:packages && npm run test`, `cd backend && go test ./internal/aistudio/...`, manual dev-run check.

### T02: Generated decks carry speaker notes

- Problem: `buildDeckFromOutline` (`frontend/src/store/editor.ts`, around line 1903) creates pages with no `notes`; AI-generated decks ship silent.
- Reference: Reference A injects a REQUIRED plain-text speaker note (100..500 chars, no markup) into every slide generation (RND 13; `servers/fastapi/utils/llm_calls/generate_slide_content.py`, search `__speaker_note__`). Its note-style prompt rules: spoken style, adds context and delivery cues, never restates slide text.
- Do: extend the outline stage so each `OutlineItem` may carry `note?: string` (pure change in `packages/aistudio/src/outline.ts`: type, `normalizeOutline`, `outlineJsonSchema`; cap length, plain text). Ask for it in `outlineSystemPrompt` (`packages/aistudio/src/prompts.ts`). Thread it through `layoutDeck` (`deck.ts`) into `DeckPage`, and write `Page.notes` in `buildDeckFromOutline` and `appendDeckPages` (`frontend/src/store/editor.ts`). Server prompt in `backend/internal/aistudio/generate.go` must match the schema.
- Acceptance: a freshly generated deck shows non-empty notes in the Present HUD teleprompter and in `SlideOverview` outline view; notes are 1..3 sentences, not slide-text restatements.
- Verify: package tests for `normalizeOutline` with/without notes; manual generation check.

### T03: Non-destructive generation default

- Problem: the assistant tool `generateDesign` replaces every page unless the model passes `mode:"append"` (`frontend/src/components/editor/EditorPanels.tsx`, resolve around line 2146, apply around 2351; `frontend/src/store/editor.ts` `buildDeckFromOutline` replaces the document).
- Reference rule: Reference A never deletes existing slides until every new slide exists (RND 13).
- Do: make replacement explicit and gated. If the current document has more than one page or any non-empty page, default the executed mode to `append` unless the plan step explicitly carries `mode:"replace"` AND the plan-confirmation gate (which already exists for `generateDesign`) has shown the user a "replaces all N pages" warning. Update the tool description in BOTH catalogs (client + Go, per T01's parity test) so the model knows `replace` is destructive and needs intent.
- Acceptance: "make me a 5 slide deck about X" on a non-empty document appends (or asks) rather than wiping; explicit "replace everything with ..." still works after confirmation; the whole turn remains one undo entry.
- Verify: manual dev run both paths; existing undo tests still pass.

### T04: Provider config gaps

- Problems (all in shipped code): (a) the provider dropdown offers only `openai`, `anthropic`, `deepseek`, `custom` (`frontend/src/components/editor/EditorPanels.tsx`, around line 3257) while `backend/internal/ai/registry.go` presets 11; (b) `saveConfig` (around line 3222) never sends `imageModel`, so the image model cannot be changed from the UI; (c) the `azure-openai` preset advertises full capability but the transport (`backend/internal/ai/provider.go`) sends a bearer token to `{base}/chat/completions`, while real Azure needs an `api-key` header and `/openai/deployments/{deployment}/...?api-version=...` paths.
- Do: (a) render the dropdown from `GET /ai/providers` instead of a hardcoded list; (b) add an image-model field to the config form and include `imageModel` in the save payload (the backend already accepts it); (c) either implement the Azure dialect in `provider.go` (header + deployment path from the stored base URL or a new optional field) with a unit test, or remove the preset from `registry.go`; do not leave it advertised and broken. Pick based on effort: implementing the header/path variant is small and preferable.
- Acceptance: all presets selectable and saving correctly; image model editable; an Azure config (mock server in a Go test) produces the correct header and path.
- Verify: `go test ./internal/ai/...` including a new transport test; manual config save/load.

### T05: Sync stale docs to code

- Problems: `docs/shipped/39-ai-creative-studio.md` (around lines 250-271) describes `MagicDesignPanel`, `StudioPanel`, `TransformPanel`, `ChartPanel`, `ImprovePanel` as shipped; all five were deleted (commits `75febeb`, `24aadff`). `docs/FEATURES.md` (around lines 80-88) lists shipped F28 items (whole-deck translation, AI speaker notes, ingestion, bulk merge, deck-to-video) as not done. `28-presentations.md` marks "outline-first editable flow" Built via `StudioPanel`.
- Do: docs-only change. Correct all three to match code, noting the panel-to-chat consolidation and which pure cores remain orphaned (`deriveOutline`, `switchOutline`, `recomposeSpec`, `paletteTheme`, `qualityCheck`, `buildAiDesign`). Do not delete the orphaned code in this task; T09 and later tasks reconnect some of it.
- Acceptance: no doc claims a deleted surface ships; F28 row for the outline flow reflects reality (core shipped, UI removed, restoration tracked by T09).

## Phase 1: Generation core

### T06: Native structured output in the provider layer

- Today: no `response_format`, no tool-calling anywhere; schemas are prompt-embedded and hand-parsed (`backend/internal/ai/provider.go`, `backend/internal/aistudio/aistudio.go` `extractJSON`).
- Reference: Reference A requests schema-constrained output wherever the provider supports it AND restates the schema in the prompt as a fallback, with a lenient extraction ladder (native structured object, serialized object, tolerant JSON parse, fail) and provider quirks (RND 27; grep `response_format` under `presenton/servers/fastapi`).
- Do: add a structured-text primitive to `backend/internal/ai` (for example `TextStructured(ctx, workspaceID, prompt, system, schemaJSON)`): OpenAI-compatible dialect sends `response_format: {type:"json_schema", json_schema:{...}, strict:false}`; Anthropic dialect uses a single forced tool whose input schema is the schema (their structured-output idiom); on a provider 4xx that indicates the parameter is unsupported, retry once WITHOUT it (prompt-embedding still applies). Keep the existing `Text` primitive untouched. Migrate `backend/internal/aistudio` generators (outline, chart, assistant plan, style profile) to the new primitive.
- Acceptance: with an OpenAI-compatible test double, the request carries `response_format`; with a double that rejects it, the call still succeeds via fallback; all existing aistudio Go tests pass; JSON validity failures drop measurably (spot-check via dev logs).
- Verify: new `go test ./internal/ai/...` transport tests, `go test ./internal/aistudio/...`.

### T07: Validation-repair loop in the orchestrator

- Today: 3 retries with a generic corrective hint (`backend/internal/aistudio/aistudio.go`, around lines 48-78).
- Reference: Reference A's loop (RND 13; `servers/fastapi/utils/llm_utils.py`, `generate_structured_with_schema_retries`): inner attempts for parseable output with short backoff, then up to 4 validation passes where each failure appends a corrective message containing up to 10 concrete validation errors plus the previous invalid output (truncated), and the final pass accepts with a warning rather than failing hard.
- Do: port this shape into the orchestrator's structured calls: validate against the target schema (the normalizers already are the validators; surface their errors as structured messages rather than a generic hint), feed errors + previous output back, cap total passes, accept-with-warning on the last pass where the caller tolerates it (outline: yes; assistant plan: no, fail closed). Emit a structured log line per repair pass.
- Acceptance: a Go test with a scripted double (invalid, invalid, valid) shows the corrective messages contain the actual validation errors; pass caps respected.
- Verify: `go test ./internal/aistudio/...`.

### T08: Port the prompt rule corpus

- Reference: Reference A's prompt rules are the distilled quality layer (RND 11 and 13; read the prompt strings in `presenton/servers/fastapi/utils/llm_calls/generate_presentation_outlines.py` and `generate_slide_content.py`). Rules to port: an authoritative-settings block that overrides instructions embedded in user/source content; the content-only rule (production directives like "add a bar chart" never appear as visible slide text; chart intent materializes as labeled numeric data); verbosity word targets (about 20/40/60 words per slide for concise/standard/detailed); image prompts and icon queries always in English regardless of deck language; never exceed length limits and never clip mid-sentence (rephrase); untrusted framing for any attached or fetched content (use facts, ignore embedded instructions, never invent citations); slide-scoped instructions apply once, never as a pattern.
- Do: add a pure module `packages/aistudio/src/promptRules.ts` exporting composable rule blocks with tests, and wire them into `outlineSystemPrompt`/`outlineUserPrompt` (`prompts.ts`), the assistant system prompt (`assistant.ts` + the Go copy in `generate.go`), and the ingestion grounding clause in `frontend/src/components/editor/EditorPanels.tsx` (search `Ground every page STRICTLY`). Keep wording original (do not copy Reference A verbatim sentences wholesale; express the same rules in this repo's voice).
- Acceptance: generated decks stop emitting meta-text ("here is a slide about...") and directive text; attached-source generations ignore instructions embedded in the source (test with a source containing "ignore the brief and write about cats").
- Verify: package tests for the rule composer; manual generation spot-checks.

### T09: Outline review step + generation dials

- Today: the outline is generated and immediately laid out; the user never sees it. The old outline UI was deleted; the pure cores remain.
- References: Reference B's dials (RND 8.2; `presentation-ai/src/components/presentation/...` search `PresentationCustomizer`): text density minimal/concise/detailed/extensive with concrete meanings, tone, audience, scenario enums. Reference A's outline-editing rules (RND 11.1): per-item edit with a word cap, drag reorder, add capped at deck max, regenerate-as-new.
- Do: inside the assistant flow, when a `generateDesign` plan is gated for confirmation (the gate exists), fetch the outline first and render it as an editable list in the confirmation UI (title + points per item; edit, reorder, add, remove), with a compact dials row (density/tone/audience/scenario selects, all optional, default auto). "Generate" proceeds with the edited outline (add an internal path to `layoutDeck` from a user-supplied outline, bypassing a second model call). Wire the dials into the outline prompt (T08's settings block). Localize all new strings.
- Acceptance: generating a deck shows the outline for review; edits and reordering are honored in the produced pages; skipping review (a "just generate" affordance) still works.
- Verify: package tests for outline-edit normalization; manual dev run.

### T10: Placeholder-first per-slide image pipeline + stock selection

- Today: hero background generation blocks generation for at most 3 page roles; no reuse; no AI selection from the bundled stock (Openverse/Iconify already integrated); alt text is an afterthought.
- Reference: Reference A's pipeline rules (RND 16.1; `presenton/servers/fastapi/utils/process_slides.py`, `services/image_generation_service.py`): placeholder-first (slots render instantly, generation fills behind), per-slide concurrency, failures degrade to placeholder + per-slide warning (never fail the deck), a prompt-keyed asset library enabling reuse (identical prompt = same asset, zero cost), and edit-time prompt-diffing. Reference B: job keys stamped with the owning document id so late results cannot land on another deck (RND 16.2).
- Do: (a) generation emits pages immediately with a neutral placeholder fill on image slots and records desired image prompts per node (`node.data.aiImagePrompt`, plain data, no schema change); (b) a client-side queue resolves prompts: first try reuse (workspace assets tagged with a prompt hash), then stock selection when the prompt is concrete-noun-like (query the existing stock search; insert with provenance), else `POST /ai/image`; each resolution swaps the placeholder via a normal store mutation stamped with the design id guard; (c) alt text is generated in the same resolution step (reuse `frontend/src/lib/altText.ts`); (d) failures set a small "image failed, click to retry" state on the node, never abort.
- Acceptance: a generated deck appears fully laid out in under a couple of seconds with placeholders, images stream in; regenerating the same deck reuses previously generated images; a provider failure leaves a working deck.
- Verify: package tests for the reuse-key and stock-vs-generate routing decision (pure functions); manual dev run with a failing image double.

## Phase 2: Layout grounding

### T11: Capacity fields on Placeholder (schema bump)

- Do: add OPTIONAL fields to `Placeholder` (`packages/schema/src/schema.ts`, around line 1853): `maxChars?: number`, `minChars?: number`, and for list-capable roles `minItems?/maxItems?: number`. Follow the full schema protocol from the header of this doc (claim the version in `docs/roadmap/README.md` FIRST, bump TS + Go mirror together, forward migration step, version-history line). Populate sensible capacities on the five built-in layouts in `packages/schema/src/theme.ts` (`builtinMasterAndLayouts()`), derived from their rects and a chars-per-area heuristic; Reference A's observed medians are a guide (headings roughly 20..40 chars max, body up to a few hundred; the intended invariant is `min` about half of `max`, RND 6.4-6.5).
- Acceptance: older files open unchanged; a new file with capacities round-trips through the Go write boundary; `savePageAsLayout` continues to work (it may leave capacities unset).
- Verify: `packages/schema` migration tests (older file opens; additive bump; unknown-field preservation), `go test ./internal/persistence/...`.

### T12: Derived layout schemas + layout-grounded generation

- Today: two disconnected layout systems; AI generation never sets `Page.layoutId` or touches masters/layouts/placeholders.
- Reference: Reference A's architecture is the proven pattern (RND 6 and 12-13): derive a JSON content schema per layout from its slots (`presenton/servers/fastapi/templates/v2/schema.py` is the algorithm: walk slots, bounded strings from capacities, arrays from item ranges, all fields required); select one layout per outline item from layout names/roles/descriptions with variety rules and index repair (out-of-range replaced by a random valid index, RND 12.1); fill the schema; hydrate by writing content into materialized placeholders.
- Do: (a) new pure module `packages/aistudio/src/layoutSchema.ts`: `deriveLayoutContentSchema(layout: SlideLayout): JsonSchema` from placeholder roles + T11 capacities, with tests; (b) a layout-selection step: given the outline and the document's available layouts (built-ins plus user-captured), one structured call returns a layout id per item (variety rule: adjacent items differ unless role demands repetition; repair invalid ids); (c) a fill step per page: structured call against the derived schema (T06/T07), then apply: `applyLayoutToPage(layoutId, pageIndex)` (which materializes tagged placeholder text boxes) followed by writing the filled content into those boxes and `Page.layoutId`; picture-role slots route through T10's image pipeline; (d) keep the existing aistudio 4-intent engine as the fallback when a document has no layouts. The whole generation stays one undo turn.
- Acceptance: generated decks carry `Page.layoutId`; editing a layout and `syncLayoutPages` restyles generated pages; content respects capacities (no overflow flags from `qualityCheck` on default themes); layout variety across a 6-page deck.
- Verify: `layoutSchema` unit tests including capacity edge cases; a deck-generation integration test at the store level; manual dev run.

### T13: Narrative ops: insertAgenda, splitSlide, insertComparison

- Reference: Reference A's agenda synthesis is fully algorithmic and portable as-is (RND 12.1; `presenton/servers/fastapi/utils/ppt_utils.py` and `utils/outline_utils.py`): entries per agenda page `ceil((total - title_flag)/10)`, agenda layout chosen by priority regex over layout names/descriptions with a list-layout fallback (skip silently if none), insertion after the title slide, page numbers accounting for inserted pages, per-item titles by first-heading/first-sentence/first-line fallback.
- Do: three new assistant tools (client catalog + Go catalog + parity manifest from T01): `insertAgenda` (pure algorithm over current pages + T12 layout selection for the agenda layout), `splitSlide(pageIndex)` (one structured call splits the page's content into two outline items, then T12 fills two pages replacing one), `insertComparison(topicA, topicB, afterPageIndex?)` (fill the comparison built-in layout). All undoable as single turns.
- Acceptance: "add an agenda" on an 8-page deck inserts a correct agenda after the title with accurate titles; "split slide 3" yields two coherent pages; parity test passes.
- Verify: pure tests for the agenda math and title extraction; manual runs.

### T14: Per-slide AI regeneration

- Reference: Reference A's single-slide edit (RND 20; `presenton/servers/fastapi/api/v1/ppt/endpoints/slide.py`): re-pick the layout only if the instruction warrants, rewrite content against the layout's schema, diff asset prompts so only changed images regenerate. Reference B preserves slide identity on regenerate (RND 20). HyCanvas keeps stable node ids (Magic Move depends on them), so preserve ids for placeholder-matched nodes and the page id; never rotate identities.
- Do: assistant tool `regenerateSlide(pageIndex, instruction)`: build a slide-scoped context (the page's current placeholder contents + layout id + the instruction), optionally re-select the layout (structured yes/no + id), fill via T12, diff `aiImagePrompt` values against current so unchanged images stay, apply as one undo turn. Add to both catalogs.
- Acceptance: "make slide 2 more data-driven" changes slide 2 only, keeps its images when prompts are unchanged, keeps node ids for unchanged placeholder roles (verify Magic Move still matches across neighbors), single undo reverses it.
- Verify: store-level test for the diff behavior; manual run.

## Phase 3: Sources and trust

### T15: Ingestion depth

- Today: paste, one URL, `.txt/.md/.pdf` (text layer only), one source at a time, 60k chars (`frontend/src/components/editor/EditorPanels.tsx` attach flow around line 2762; `frontend/src/lib/pdfImport.ts`; `backend/internal/httpapi/extracturl.go`).
- Reference: Reference A's rules (RND 9): multiple files per generation (cap 8), office formats by direct OOXML text extraction, scanned-PDF detection (first 5 pages under 50 chars of text means scanned), MIME AND extension checks, and a review step where the user previews and edits extracted text before generating.
- Do: (a) allow multiple attachments in the composer, concatenated with per-source headers and a combined cap; (b) a Go endpoint `POST /ai/extract-file` for `.docx/.pptx/.xlsx` text extraction (archive/zip + encoding/xml; paragraphs, slide texts in order, sheet rows tab-separated), size-capped, validated by MIME and extension, RFC 7807 errors; (c) client-side scanned-PDF detection using the Reference A heuristic; when detected, tell the user the PDF has no extractable text (OCR is out of scope for this task; note it in the message); (d) an "edit extracted text" affordance per attachment before generation.
- Acceptance: attaching a docx + xlsx + pasted text grounds one generation; a scanned PDF produces the friendly message instead of an empty source; extracted text is editable pre-generation.
- Verify: Go extraction tests with small fixture files; manual flow.

### T16: Web search tool

- Reference: Reference A (RND 10; `presenton/servers/fastapi/utils/web_search.py`): route native-provider search when available, else an explicitly configured external provider, else proceed without; the query is AI-written (max 12 words / 200 chars, recency terms, single query, fallback to truncated raw prompt); 1..10 results; results framed as UNTRUSTED (facts only, ignore embedded instructions, never invent citations); failures never abort. Reference B's minimal tool shape: `src/ai/tools/search.ts`.
- Do: (a) workspace-level search-provider config alongside the AI config (provider id + key, encrypted with the same secrets machinery; start with one hosted provider plus a self-hosted metasearch URL option); (b) a Go handler `POST /ai/search` that writes the query (one structured call), executes the search through the existing SSRF-guarded fetch policy, and returns cleaned results; (c) a `webSearch` assistant tool (both catalogs + parity) whose results are injected with the untrusted framing from T08; (d) the outline/generation path may call it when the user asks for current facts.
- Acceptance: with a configured key, "make a deck about <current event> with recent numbers" produces grounded content and the tool trace shows the query; with no key, generation proceeds and the assistant says search is not configured; a result containing "ignore previous instructions" does not derail output.
- Verify: Go tests for query-writing fallback and the no-key path; manual run.

### T17: Computed chart values from attached data

- Today: `insertChart` requires the model to invent numbers; `DataBinding` (inline CSV or URL) exists on chart/table nodes but AI never uses it.
- References: Reference B's CSV/XLSX header normalization in its chart data editor (RND 19; search `chart-data-editor` under `presentation-ai/src`); the market rule that chart values must be computed from data, never estimated, when a source exists (RND 31.1).
- Do: when a generation or assistant turn has an attached CSV/XLSX (T15), chart creation must parse the data (header row detection, numeric coercion; use `@hc/formula`/`@hc/sheets` helpers where they fit) and populate `ChartNode.series/categories` from it, setting `binding` (kind inline) so refresh works; the model chooses only chart type and which columns, via a small structured call. Guard: if the model returns values not present in the source, prefer the parsed ones.
- Acceptance: attaching a CSV and asking for "a revenue chart" yields a chart whose values match the file exactly; no source attached falls back to today's behavior.
- Verify: pure tests for parse + column-selection application; manual run.

### T18: Streaming per-slide generation progress

- Today: no streaming; generation jobs complete inline before the POST returns.
- Reference: Reference A's event protocol (RND 13; the stream route in `presenton/servers/fastapi/api/v1/ppt/endpoints/presentation.py`): per-slide events as soon as a slide's content exists, separate later events for resolved assets per slide with non-fatal warnings, a final complete event; the client never lets a late coarse payload clobber an already-resolved asset.
- Do: an SSE variant of design generation: `POST /ai/generate-design/stream` (or reuse `/realtime` frames if a session exists; SSE is simpler and matches the one-shot nature): events `outline`, `page` (index + filled content), `assets` (per T10 resolutions when server-side), `done`, `error`. Client appends pages into the document as they arrive (the store already supports incremental `appendDeckPages`; adapt to per-page), keeps the whole run one undo turn (accumulate ops, commit progressively but group history), and applies the asset-preservation rule. Long work stays out of inline handlers where it exceeds request norms; SSE handlers are the sanctioned exception here and must respect client disconnect.
- Acceptance: generating an 8-page deck paints page 1 within a few seconds and the rest appear progressively; canceling mid-stream leaves a consistent document (pages so far, no dangling placeholders); undo removes the whole generation.
- Verify: Go handler test with a scripted generator; manual run.

## Phase 4: Design system

### T19: Theme UI, brand-to-theme bridge, AI theme generation

- Today: the swappable `Theme` record ships with no UI; `themeFromPalette()` (`packages/schema/src/theme.ts`) has zero callers; AI decks never set `DesignFile.theme`; brand kits do not produce themes.
- References: Reference A's algorithmic palette generation (RND 7.2; `presenton/servers/fastapi/api/v1/ppt/endpoints/theme.py`): perceptual color space, fixed lightness ladder, dark classification threshold, surface/stroke at ladder distances, graph colors as reversed variations, retry-until-contrast. Reference B (RND 7.1): 38 concrete theme token sets and 19 font pairs (`presentation-ai/src/lib/presentation/themes.ts`, MIT: record in THIRD_PARTY.md if palettes are copied), the AI theme block with strict hex validation and PARTIAL-TAG STRIPPING so half-streamed markup never leaks (`generated-theme.ts`), and per-theme customization memory (`customization.ts`).
- Do: (a) a theme section in the deck properties: pick from seed themes (adapt a curated subset of Reference B's palettes into `Theme` records), apply via `applyTheme()`, undoable; (b) "Create theme from brand kit" calling `themeFromPalette()` with brand fonts; (c) assistant tool `generateTheme(description?)`: one structured call returns the color slots + font pair, validated (hex-strict, AA contrast via `@hc/color`), written as `DesignFile.theme`; the deterministic ladder from Reference A is the repair path when the model's palette fails contrast; (d) deck generation sets `DesignFile.theme` from the chosen `DeckTheme` so the two theme concepts converge.
- Acceptance: swapping a theme restyles master-linked content in one undo step; brand-kit theme creation works; "generate a warm editorial theme" produces a valid, AA-passing theme.
- Verify: pure tests for validation/repair; manual runs.

### T20: Import a deck as a reusable layout set

- The largest new-scope task (evidence and rationale in `28-presentations-leverage.md` section 5.1). Multi-session: split into the numbered stages below and land them separately.
- Reference: Reference A's pipeline (RND 18 and 23; `presenton/servers/fastapi/templates/v2/generation.py`, `api/v1/ppt/endpoints/template.py`): decompose slides to primitives; classify each element decorative vs content slot; assign capacity constraints from geometry; a vision self-review loop (render the candidate layout to an image, at most 2 review rounds, bounded validation retries); cluster similar components. HyCanvas already ships both bridge ends: `pptxToDesign` (`packages/export/src/pptximport.ts`) and `savePageAsLayout` (`frontend/src/store/editor.ts`).
- Stages: (1) heuristic-only v1: an "Extract layouts from this deck" action that runs an improved `savePageAsLayout` over every page of an imported deck: largest text = title, other text boxes = body/content slots with T11 capacities derived from box geometry, images = picture slots, everything else decorative; dedupe near-identical layouts by placeholder-signature; name layouts by structure; (2) vision-assisted v2: for each page, send the engine-rendered page image (the Go render endpoint exists) plus the heuristic layout through `describe-image`-capable providers to correct roles and decorative flags, with ONE self-review render pass; (3) capacity verification: reject/shrink capacities that overflow at max fill using `qualityCheck`.
- Acceptance (v1): importing a 10-slide PPTX and extracting yields a layout set where applying a layout to a new page materializes sensible placeholders; generation (T12) can target the extracted layouts.
- Verify: fixture PPTX round-trip test; manual run.

### T21: Brand kit draft from a company domain

- Reference: market pattern (RND 31.3); infrastructure exists (`backend/internal/httpapi/extracturl.go` SSRF policy).
- Do: `POST /ai/brand-from-url`: fetch the page through the hardened fetch path, extract candidate logo URLs (link rel icons, og:image), palette (from inline styles/CSS variables plus a structured model pass over the visible text/HTML head for brand colors), and font families; return a DRAFT the user confirms in `BrandPanel` before anything is saved. Never auto-apply.
- Acceptance: entering a well-known site produces a plausible draft (logo, 3..6 colors, font guesses) behind a confirm step; a private-network URL is refused by the SSRF policy.
- Verify: Go tests with fixture HTML; manual run.

## Phase 5: Tail

### T22: PPTX fidelity golden set + camera bubble

- Part 1: turn Reference A's export findings into regression fixtures for `packages/export/src/pptx.ts`/`pptximport.ts`: multi-run text with mixed styling, gradient fills, rotated groups, cropped images, notes round-trip, z-order. Reference rules worth asserting where applicable (RND 24.1): bold threshold at weight 600 on import mapping, no silent drops (unsupported nodes rasterize in place). Extend `pptx.test.ts`/`pptximport.test.ts`.
- Part 2: camera bubble in present-and-record. Reference: Reference B's compositor math (RND 21; `presentation-ai/src/hooks/presentation/useRecording.ts`): webcam drawn into the capture canvas at a draggable overlay position with rounded-rect clipping and cover-cropping. Do: add an optional camera to `toggleRecording` in `frontend/src/components/editor/PresentMode.tsx` (getUserMedia video; declining keeps today's behavior), a draggable preview overlay whose position drives the composite, drawn AFTER slide + ink so it records. Fully client-side, nothing uploads.
- Acceptance: golden tests pass and pin current fidelity; recording with camera enabled produces a webm with the bubble at the dragged position; declining camera matches today.
- Verify: package tests; manual recording on a 3-slide deck.

### T23: Programmatic generation API (blocked)

- Blocked on: an integrations layer (API-key principals, a durable job store; the in-memory job registry does not survive restarts). Do not start until those exist.
- When unblocked, adopt Reference A's contract (RND 25; `presenton/servers/fastapi/models/generate_presentation_request.py` and the generate endpoints): one-shot generate (prompt or per-slide markdown, template/layout-set id, language, dials, export format), an async variant with a human-readable progress sequence and per-batch counts, webhooks for completion/failure with explicit no-retry semantics documented, and an allowlisted agent-protocol endpoint. Everything free and ungated per the product pillar.
