# F40 AI Platform: Implementation Task Board

| Field | Value |
| --- | --- |
| Feature ID | F40 |
| Role | Execution-grade task list for the four post-F28 AI-platform priorities: a public generation API, an MCP server, theme/template catalog breadth, AI template-from-PPTX, and adaptive smart-slide reflow. Written to be picked up and implemented task by task by an AI coding session running in this repository |
| Date | 2026-08-26 (grounded against the code the same day, at the F28 completion board's final commit) |
| Parent docs | `28-presentations.md` (rows this board closes: "Table / data autoflow", the automation-API deferred line, template-breadth market context), `28-presentations-completion-tasks.md` (the completed predecessor board; its "How to use" conventions apply verbatim) |

## How to use this document (read this first, every session)

The rules from `28-presentations-completion-tasks.md` apply unchanged. In brief:

1. Read `CLAUDE.md` at the repo root first. Zero Data Loss rules override everything. This board plans NO design-file schema bumps: new per-page state rides the open `Page.data` record (the C35 precedent), and all SQL is additive-only nullable/defaulted columns or new tables. If a task turns out to need a schema field after all, claim the version in `docs/roadmap/README.md` FIRST and follow the full bump protocol.
2. Implement ONE task at a time. Verify honestly (`npm run build:packages`, `npm run test`, `cd backend && go test ./...`, `npm run lint`, `rm -rf frontend/.next && npm run build:frontend`, plus the task's own acceptance check), flip the Status here with the date, and keep the matching capability rows in `28-presentations.md` in sync (upgrade-only, keep honest gap notes).
3. New user-facing strings go in all 8 locale catalogs; API errors are RFC 7807 problem+json with stable codes; long-running server work goes through the job registry, never inline in a handler.
4. Secrets hygiene is load-bearing in Phase 1: API keys are shown once at mint, stored only as hashes, never logged, and revocable. Follow the existing session/refresh-token storage patterns in `backend/internal/accounts`.
5. If a task turns out to be already done, wrong, or blocked, update its Status to `blocked` or `dropped` with a one-line reason and stop. Do not force it.

## Task status board

| Task | Phase | Title | Status |
| --- | --- | --- | --- |
| E01 | 1 Generation API | API keys: additive table, hashed storage, mint/revoke UI | todo |
| E02 | 1 Generation API | Bearer API-key auth middleware + scopes + rate budget | todo |
| E03 | 1 Generation API | Headless deck composition service (goja-embedded composer) | todo |
| E04 | 1 Generation API | POST /v1/generate/presentation through the job registry | todo |
| E05 | 1 Generation API | Export + share hookup for API-generated decks | todo |
| E06 | 1 Generation API | OpenAPI document + served API docs page | todo |
| E07 | 2 MCP | MCP server (streamable HTTP) over the generation API | todo |
| E08 | 2 MCP | MCP hardening: per-key scopes, audit log, docs | todo |
| E09 | 3 Catalog | Slide layout library: ~5 to 15+ layouts with capacity hints | todo |
| E10 | 3 Catalog | Theme catalog: 14 to 30+, extracted to a shared module | todo |
| E11 | 3 Catalog | Presentation template seeds: 11 to 40+ | todo |
| E12 | 3 Catalog | Generate-with-template: pick a template/theme as the generation base | todo |
| E13 | 4 Template-from-PPTX | One-click AI template builder from an uploaded PPTX | todo |
| E14 | 4 Template-from-PPTX | Custom templates as first-class generation targets | todo |
| E15 | 5 Reflow | Pure adaptive-reflow engine over placeholder capacity hints | todo |
| E16 | 5 Reflow | Live reflow on edit for layout-linked slides (opt-out, one undo) | todo |
| E17 | 5 Reflow | Layout-variant switching on over/underflow | todo |

Deferred (documented, deliberately not tasks): outbound webhooks on job completion (revisit once the API has real consumers); publish-as-website / custom domain (overlaps the website feature); AI voice/TTS narration (`23-ai-media.md`); a paid/community template marketplace beyond the existing `@hc/templates` marketplace scaffolding; Zapier/Make connectors (build on the API once it is stable).

## Phase 1: Public generation API

The pitch: presenton ships a generation API and positions it as the differentiator; HyCanvas has the stronger pipeline but no programmatic door. Everything below reuses shipped machinery: the job registry (`backend/internal/jobs`), the aistudio outline/layout/fill services (`backend/internal/aistudio`), and the write boundary (`persistence/validate.go`).

### E01: API keys

- New additive table `api_keys` (id, user_id, workspace_id, label, key_hash, prefix, scopes text[], last_used_at, created_at, revoked_at). Keys are minted as `hyk_<random>` with only a SHA-256 hash stored; the raw key is returned exactly once at creation. Settings UI (workspace settings) lists keys by label/prefix/last-used and revokes them. Reuse the accounts service's token-hashing patterns; never log a raw key.

### E02: API-key auth + scopes + rate budget

- A Bearer branch in the auth middleware: `hyk_`-prefixed tokens resolve an api_key row (constant-time compare on the hash), stamp the owning user + workspace into the request context, and update last_used_at (throttled). Scopes on the key (`generate`, `read`, `export`) gate route groups; workspace data isolation holds because the key is workspace-scoped. A per-key sliding rate budget (reuse the audience limiter pattern) with 429 problem+json.

### E03: Headless deck composition

- The outline-to-pages composer (`deckThemes` + `layoutDeck` + layout selection/fill in `@hc/aistudio`) is pure TS with no DOM. Bundle it (the `crdt/fold.go` goja embedding is the exact precedent and build pattern) and expose Go `Compose(outline, theme, size, layouts) (DesignFile, error)`. The output must pass the existing write-boundary validation; add a golden test asserting the goja composition of a fixed outline equals the client-side composition byte-for-byte (same seed).

### E04: POST /v1/generate/presentation

- Request: prompt, designType (deck|doc|poster|social), pageCount?, language?, themeId?/templateId? (Phase 3 wires these), sources? (text blocks, same 8-source cap and untrusted-source prompt rules as the panel). Runs as a job: outline via the existing server generation (per-slide polish included), composition via E03, design created in the key's workspace, snapshot saved through the normal write boundary. Job result: designId, editor URL, and the file. Poll via the existing `GET /v1/jobs/:id`; images resolve through the existing queue semantics or are skipped for text-only keys (stated in the response). Errors are RFC 7807 with stable codes.

### E05: Export + share hookup

- Document and, where a gap exists, wire: API-created design -> existing export jobs (PPTX/PDF/PNG) via the API-key auth path, and share-link creation (named links land per-link analytics for API-generated decks for free). Acceptance: a curl script goes prompt -> deck -> PPTX bytes -> share URL with no browser session.

### E06: OpenAPI + docs page

- A hand-maintained OpenAPI 3.1 document for the API-key surface (generate, jobs, exports, share links, templates/themes list), served from the binary (embedded, like the locales) at `/api/docs`, with copy-paste curl examples. README gains the "Generation API" section.

## Phase 2: MCP server

### E07: MCP server over the API

- A streamable-HTTP MCP endpoint at `/mcp`, authenticated by the same API keys, implemented in Go (no new runtime). Tools map 1:1 onto Phase 1: `generate_presentation`, `get_job`, `list_templates`, `list_themes`, `get_design_file`, `export_design`, `create_share_link`. Tool schemas mirror the OpenAPI shapes; results return compact JSON (ids + URLs, never megabyte files inline; exports return a download URL).

### E08: MCP hardening + docs

- Per-key scopes enforced tool-by-tool; an `api_audit_log` additive table (key id, tool/route, design id, at) with a retention cap; docs page section with Claude Desktop / generic MCP client setup snippets. Acceptance: an MCP client generates a deck and fetches its PPTX using a generate+export key, and a read-only key is refused for generation with a clean error.

## Phase 3: Theme and template catalog breadth

The pitch: generation quality is bounded by the layout library (T12 grounding picks from what exists), and the gallery's presentation shelf is thin (11 of 100 seeds). This phase is mostly curated content flowing through existing systems; the one new capability is choosing the visual base before generating.

### E09: Slide layout library expansion

- `builtinMasterAndLayouts` (`packages/schema/src/theme.ts`) grows from ~5 layouts to 15+: agenda, section header, quote, timeline/process, team/people grid, stats/KPI row, comparison (2-col and pro/con variants), picture-focus (full-bleed and side), content+chart, two-content, closing/CTA. Every placeholder carries v21 capacity hints (maxChars/minItems/maxItems) so generation fill and Phase 5 reflow both benefit. Layout selection prompts/repairs (`layoutSchema.ts`, `repairLayoutSelection`) learn the new roles. Existing decks are untouched (builtins install on first use only).

### E10: Theme catalog expansion

- The 14 builtin theme seeds move out of `PropertiesPanel.tsx` into a shared module (they are data, not UI), and grow to 30+ covering light/dark, corporate/editorial/bold/minimal/warm/tech, every one passing `repairThemeSlots` contrast validation in a test that walks the whole catalog. The theme picker gets simple style grouping. Deck generation's seeded-theme picker (`deckThemes`) draws from the same catalog so generated decks inherit the breadth.

### E11: Presentation template seeds

- Grow presentation-category seeds in `backend/internal/templates/seed.json` from 11 to 40+ (pitch deck, QBR, project kickoff, research readout, course/lecture, portfolio, all-hands, roadmap review, case study, one-pager...). Author them THROUGH the product (generation pipeline + hand-tuning), export the `.hyc` files, and register them with previews, categories, tags, and fillable fields where they fit. No engine work; acceptance is the gallery shelf and honest previews.

### E12: Generate with a chosen template/theme

- The generation flows (panel + Phase 1 API) accept an optional template or theme as the visual base: a chosen template contributes its masters/layouts + theme (generation fills ITS layout system instead of the builtins); a chosen theme seeds `deckThemes`. Panel UI: an optional style row in the outline-review card (template/theme thumbnails). This is presenton's template-bound generation matched, without giving up the freeform path.

## Phase 4: AI template-from-PPTX

### E13: One-click template builder

- The flow, all from shipped parts: upload PPTX -> `pptxToDesign` (`@hc/export`) -> `extractLayoutSet` (`@hc/aistudio`) + optional `refineExtractedLayoutSet` vision pass -> theme derivation (dominant palette via `extractPalette` + `deriveThemeSlots`/`repairThemeSlots`, font pair from the deck's dominant fonts mapped to the loadable list) -> preview grid (engine-rendered, slots highlighted) -> confirm -> `SaveAsTemplate` with workspace visibility. Ships as a dashboard entry point ("Create template from PowerPoint") and from the template gallery. Degrades honestly: no vision provider means geometric extraction only; a PPTX the importer cannot fully map still yields layouts from what mapped, with the losses listed before saving.

### E14: Custom templates as generation targets

- Templates saved by E13 (and by save-as-template generally) appear in E12's generation chooser like builtins, including through the Phase 1 API (`templateId`). Acceptance: upload a branded PPTX, build the template, generate a new deck on it via BOTH the panel and a curl call, and the deck wears the uploaded deck's layout system and palette.

## Phase 5: Adaptive smart-slide reflow

The pitch: the one Beautiful.ai capability with no HyCanvas answer (`28-presentations.md` "Table / data autoflow" row). Deterministic and rule-based on purpose; no model calls in the loop.

### E15: Pure reflow engine

- A pure module (`@hc/aistudio` or `@hc/editor`): given a layout-linked page, its layout (with capacity hints), and current content, return deterministic adjustments: type-scale step-downs within bounds, placeholder rect grow/shrink along the layout's declared flow axis, spacing redistribution, and an overflow verdict per placeholder. Unit-tested on fixture layouts; no store or DOM dependency.

### E16: Live reflow on edit

- Layout-linked slides reflow as content changes: the store applies E15's adjustments inside the SAME undo step as the triggering edit (`setContent`/`fillPlaceholderContent` paths). Per-page opt-out rides `Page.data.autoflow` (open record, no schema bump; absent = on for layout-linked pages, and the C28 rule applies: hand-moving a placeholder box breaks the link for that box). Collaborative safety: adjustments mutate in place (the setDeckTheme identity rules), never rebuild nodes.

### E17: Layout-variant switching

- When content over/underflows past what E15's adjustments absorb, propose the nearest denser/sparser variant in the same layout family (E09's expanded library makes families real): a subtle inline chip ("Switch to 2-column?") applying `applyLayoutToPage` + refill in one undo step, never automatic replacement of user-arranged content. Flip the `28-presentations.md` adaptive-layout row with honest scope (text/list reflow and variant switching; table-cell autoflow stays out).
