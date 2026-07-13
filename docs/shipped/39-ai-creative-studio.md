# F39: AI Creative Studio (agentic, multi-page generative design)

| Field | Value |
| --- | --- |
| Feature ID | F39 |
| Phase | 4 AI |
| Sequence | 39 |
| Status | Shipped end to end: pure cores + editor surfaces + Go orchestration/persistence (all FRs; see notes) |
| Depends on | AI platform (shipped, `backend/internal/ai`, `@hc/ai` surface), Magic Design (shipped, `frontend/src/lib/magicDesign.ts`), AI command bar (shipped, `frontend/src/lib/aiCommandBar.ts`), templates (`@hc/templates`), schema (`@hc/schema`), brand kit (F18), job registry (`GET /api/v1/jobs/:id`), document types (presentations/docs F28-F32), export (F11) |

## 1. Context and Goal

HyCanvas already ships a capable AI layer: a multi-provider, bring-your-own-key platform with encryption, per-feature routing, policy, and usage metering (`backend/internal/ai`); Magic Write with tone and translate; text-to-image and logo mode; inpaint and Magic Expand (outpaint); alt-text; a single-page Magic Design; and an AI command bar that routes one natural-language request to one editor action. These are solid one-shot tools.

The market has moved past one-shot tools. As of 2026 the bar for AI in a design product is set by three things: full multi-page generation (Gamma generates an entire deck from a prompt; Canva Magic Design returns 8 to 12 complete branded layouts and now builds presentations end to end), agentic assistants that plan and execute multi-step work and refine it conversationally (Adobe Firefly's creative agent, Canva's AI assistant), and one-click brand grounding plus reference-image style transfer. The recurring weakness of the leaders is that their output needs cleanup: Gamma's PowerPoint export substitutes fonts and shifts layouts, because the generated artifact is not natively editable in the target format.

That weakness is our opening. HyCanvas stores every design in one open, fully-editable scene graph (`@hc/schema`), so anything the AI produces is a first-class native artifact the user can edit, restyle, version, and export with zero fidelity loss. Combined with bring-your-own-key and self-host (no paywalls, no watermarks, private by default), an editable-native generative studio is a genuine differentiator, not a copy.

This document specifies the upgrade from one-shot AI tools to an AI Creative Studio: an agentic, brand-aware generator that produces complete, multi-page, fully-editable posters, social sets, documents, and presentations from a prompt, an outline, or a reference, and then refines them through conversation. The single hard rule carried from the rest of the AI tier holds: every output is an editable native artifact (text runs, shapes, images, charts, pages, animations), never a flattened render.

Intended outcome: a user types "a 10-slide investor pitch for a coffee subscription startup, on-brand," watches an editable outline appear, approves it, gets a complete on-brand deck of native slides in under a minute, then says "make slide 4 a comparison and add our logo to every footer" and watches it happen, undoably.

## 2. Scope

In scope:
- Multi-page generative design: full presentations/decks, multi-page documents, and poster/social sets from a prompt, an outline, or a reference design.
- Outline-first flow: prompt to an editable outline (titles, bullets, intended visual per page) to a generated multi-page design; the user can edit the outline before generation.
- Template-grounded and component-grounded layout: generation composes real, well-formed nodes using the layout engine and the template/component library, not ad-hoc rectangles.
- Agentic design assistant: a conversational surface that plans and executes multi-step work across the whole document and refines it iteratively ("make it punchier", "warmer colors", "tighten the spacing on slide 3").
- Structured generation: provider tool-use / structured outputs replace fragile free-text JSON parsing for all design generation.
- Brand grounding: one-click apply brand kit (fonts, colors, logo) to any generated or existing design; brand voice; reference-image style transfer (match the aesthetic of an uploaded image or an existing design).
- Variations: generate N distinct layout/style options for a page or a whole design and let the user pick or merge.
- Magic transforms: Magic Switch (new: convert a design from one type/format to another, for example deck to summary doc to social posts), AI-upgraded Magic Resize (today's constraint-aware reflow made content- and style-aware), Magic Charts (data or text to an editable chart), and one-click Magic Animate.
- Design-quality guardrails: contrast, legibility, hierarchy, alignment, and whitespace checks applied to generated output, with a critique-and-improve pass.
- Generation as background jobs: multi-page and other long generations run through the job registry with progress, partial results, and cancellation; text streams where possible.
- Provenance: every generated artifact records model, prompt, parameters, and seed for reproducibility and regeneration.

Out of scope (owned elsewhere, invoked here):
- The provider-adapter layer, BYO keys, routing, fallback, quotas, policy, capability metadata, and usage metering (shipped AI platform; this feature consumes and extends it).
- Raw single-image and single-text generation primitives (shipped F20/F21; reused here).
- AI media: video background removal, captions, TTS, music, lip-sync, avatar, image-to-video (F23).
- The rendering engine, the document-type surfaces (presentations/docs/sheets/whiteboard/video), the template data model, and the export pipeline (their own features; this feature emits into them).
- Realtime collaboration, history, and persistence mechanics (F16, F10, F04; generated edits apply through the same collaborative, undoable, versioned path as manual edits).

Deferred:
- Fine-tuning or training a brand-voice model on a workspace's own corpus (depends on the enterprise data/consent framework); brand voice here is prompt-grounded, not trained.
- Fully autonomous "agent runs for minutes unattended" flows; the first cut keeps a human approving the plan and each large step.
- Cross-document agent actions (operating over many designs at once); single-document scope first.

## 3. User Stories

- As a founder, I want to generate a complete, on-brand pitch deck from one sentence so I can start from 90 percent done instead of a blank page.
- As a marketer, I want one prompt to produce a matching set (story, post, banner) already sized for each channel, all editable.
- As a small-business owner, I want to type "summer sale poster for my bakery" and get several distinct, polished options to choose from.
- As a designer, I want to upload a reference image or an existing design and have new pages generated in that exact visual style.
- As any user, I want to approve and tweak an outline before the AI builds the whole thing, so I stay in control of the narrative.
- As any user, I want to talk to the design ("make this punchier", "use our brand colors", "add a chart of these numbers") and watch it change, with full undo.
- As a brand manager, I want one click to bring any generated or imported design fully on-brand (fonts, colors, logo, voice).
- As an analyst, I want to paste a table or describe data and get an editable chart placed and styled to match the design.
- As a presenter, I want to convert a finished deck into a one-page summary or a thread of social posts without redesigning it.
- As a self-hoster, I want all of this to run against my own provider key, privately, with no feature locked behind a paywall.

## 4. Functional Requirements

Multi-page generative design:
- FR-1: From a single prompt and a chosen design type and size, the studio generates a complete multi-page design (presentation, multi-page document, or poster/social set) of native editable pages and nodes, placed on a new design.
- FR-2: Generation is outline-first by default: the model first returns an editable outline (per-page title, key points, and intended visual/layout role); the user can reorder, edit, add, or remove pages before committing; on commit the studio expands each outline item into a full page. A "skip outline" fast path generates directly.
- FR-3: Each generated page uses the layout engine and the template/component library (including the shipped 32-template seed catalog, `backend/internal/templates/seed.json` / `@hc/templates`) to produce well-formed structure (proper hierarchy, alignment, spacing, grids, consistent type scale across pages), not arbitrary absolute boxes; pages in one design share a coherent visual system. Generation can start from a seed template and adapt it, not only compose from zero.
- FR-4: The studio generates N distinct options (default 3 for a whole design, more for a single page) that differ meaningfully in layout and style; the user can pick one, regenerate, or pull a page or element from one option into another.
- FR-5: Generation length and structure adapt to the design type: a deck gets a title, agenda, content, and closing arc; a poster gets a single strong composition; a document gets sectioned prose with headings.

Agentic design assistant:
- FR-6: A conversational assistant accepts natural-language requests scoped to the current design (single page, selection, or whole document) and decomposes them into an ordered plan of editor actions, then executes them through the editor command/transform layer.
- FR-7: The assistant uses provider tool-use over a typed catalog of editor capabilities (create page, add/edit/style node, apply layout, apply brand, insert chart, resize, etc.); it never edits raw scene JSON directly, so every step is a normal undoable, collaborative-safe edit.
- FR-8: For large or destructive plans the assistant shows the plan and asks for confirmation before executing; small edits run immediately. The whole assistant turn is one undo group (one Cmd+Z reverts the turn), with per-step granularity available.
- FR-9: The assistant supports iterative refinement that references prior turns and current selection ("make it punchier", "warmer colors", "tighten slide 3", "do that to all slides"), maintaining a session context.
- FR-10: When a request is ambiguous or under-specified, the assistant asks one focused clarifying question rather than guessing destructively.
- FR-11: The existing one-shot command bar (`aiCommandBar.ts`) is subsumed as the assistant's single-action fast path; behavior for a single matched action is preserved.

Structured generation and design intelligence:
- FR-12: All design generation uses provider structured-output / tool-calling to return schema-validated objects; free-text JSON parsing (current `parseModelJson`) is retained only as a degraded fallback when a provider lacks structured output.
- FR-13: A layout engine turns a high-level page spec (regions, roles, content) into concrete nodes with correct geometry for the target size, honoring margins, a grid, a type scale, and z-order; it is deterministic given a spec and reusable across generation, resize, and switch.
- FR-14: A design-quality pass checks generated output for contrast (WCAG-aware, reusing `@hc/color`), text overflow/overlap, reading hierarchy, and excessive empty or crowded space, and auto-corrects or flags issues before the result is shown.
- FR-15: A critique-and-improve action evaluates an existing (generated or hand-made) design and proposes specific, applyable improvements (contrast, alignment, spacing, hierarchy, copy), each acceptable individually.

Brand grounding and style:
- FR-16: One action applies a brand kit (fonts, color palette, logo placement, and brand voice) to any design, generated or imported, remapping styles consistently across all pages in one undoable step.
- FR-17: All generation is brand-aware when a brand kit is present: palette, type, logo, and voice are passed as constraints to the generator (extending the current palette/voice grounding to type and logo).
- FR-18: Reference-image style transfer: the user supplies a reference image or an existing design, the studio extracts a style profile (palette, type feel, mood, composition cues) and generates new pages or restyles existing ones to match.

Magic transforms:
- FR-19: Magic Switch converts a design from one type or purpose to another (for example deck to summary document, deck to a set of social posts, document to deck), preserving content and re-laying-out for the new form, as native editable output.
- FR-20: Magic Resize already ships with constraint-aware reflow (`magicResizePages` in the store, backed by `@hc/editor resizePage`, multi-target via `MagicResizeDialog`). F39 upgrades it to AI-driven re-layout: when reflow alone would crowd or unbalance a target size, the studio re-composes the page (re-ranking content, swapping layout, re-balancing whitespace) rather than only scaling/reflowing, keeping brand and hierarchy intact. The existing deterministic path stays the fast, offline default; AI is the opt-in quality upgrade.
- FR-21: Magic Charts turns a pasted table, an uploaded data file, or a natural-language description into an editable chart node (`ChartNode`), typed and styled to the design; this completes the AI front end for the existing chart data model.
- FR-22: Magic Animate applies tasteful, brand-consistent entrance/emphasis animations and page transitions across a design in one click, as editable keyframes/transitions (the animation model, F25), never baked.

Generative media in context:
- FR-23: Image generation invoked from the studio is grounded in the design context (subject, palette, aspect, and style profile) and can produce a style-consistent set (for example matching spot illustrations across slides), reusing the F20 image primitive.
- FR-24: Background generation and replacement for a page or image node produces an editable image/fill, non-destructively, reusing inpaint/outpaint primitives.

Platform, jobs, and safety:
- FR-25: Multi-page generation, variation generation, Magic Switch/Resize, and multi-step agent plans run as background jobs through the job registry with progress, streamed/partial results where possible, and user cancellation; single small actions stay synchronous.
- FR-26: Text generation streams to the UI where the provider supports streaming.
- FR-27: Every generated page, node, and artifact records provenance (model id, prompt, parameters, seed where available, source reference) for reproducibility and one-click regenerate.
- FR-28: All studio AI calls route through the shipped AI platform, honoring per-feature routing, BYO keys, fallback, policy (provider allow/block, monthly token cap), redaction, and usage metering; no provider SDK is called directly and no new key storage is introduced.
- FR-29: Generation degrades gracefully when the configured provider lacks a needed capability (for example no image model, or no structured output): the studio uses fallbacks, omits the unsupported step, and tells the user plainly rather than failing the whole job.
- FR-30: All generated edits apply through the standard edit path, so they are collaborative-safe (F16), undoable (F10), and versioned (F04); a generation can be reverted like any edit.

Accessibility, reuse, and efficiency:
- FR-31: Generated and AI-placed images automatically receive alt text (reusing the shipped alt-text pipeline, `frontend/src/lib/altText.ts`), and generated output is run through the design accessibility checker (F38/`@hc/a11y`) so AI never ships an inaccessible design by default.
- FR-32: A user can save a generated design or page as a reusable template (feeds `@hc/templates` / the marketplace), creating a flywheel where good generations improve the seed catalog that grounds future generation.
- FR-33: Generation results and style profiles are cached (keyed by request + provider + seed) so re-opening, regenerating-around, and small follow-ups do not re-pay full token cost; the user can force a fresh generation.
- FR-34: The user can regenerate at any granularity (one element, one page, or the whole design) using stored provenance, without rebuilding the rest.

## 5. UX and Interaction Behavior

Entry points:
- A "Create with AI" action on the dashboard / new-design flow opens the generation panel (type, size, prompt, optional reference).
- The editor AI panel (`AiPanel` in `EditorPanels.tsx`) gains a "Studio" mode hosting the assistant chat and the generate/transform tools, alongside the existing one-shot tools.
- The command bar (Cmd+K) routes free-text requests into the assistant.

Key flows:
- Generate a deck: prompt + type + size to outline (editable list) to "Generate" to a job with live progress and page thumbnails appearing as they complete to a finished design with the variation switcher.
- Refine conversationally: type a request to (optional plan preview for large changes) to streamed/animated application to a chat entry the user can undo or follow up on.
- Apply brand: one click to a preview to confirm to consistent restyle across pages.
- Magic Resize/Switch: pick targets to a job to one or more new designs, linked back to the source.

States:
- Empty: prompt placeholder with examples per design type.
- Loading: outline spinner, then per-page progress with thumbnails; partial results are visible and the user can cancel.
- Streaming: assistant responses and generated copy stream in.
- Error: provider/config errors surface with the same human-friendly mapping the current panel uses (`aiErr`), plus per-step failure that does not abort the whole job.
- No provider: the studio shows setup (reusing the existing provider config UI) and still offers deterministic, non-AI assists.

Control and trust:
- The outline gate and the plan-confirmation gate keep the user in control of large actions.
- Every AI change is undoable as one turn and inspectable (provenance), so users can trust and reproduce results.

## 6. Data Model

New types live in a pure, framework-free core (proposed `@hc/aistudio`) plus a small amount of persisted session state; design output reuses existing `@hc/schema` node and page types.

Outline and page spec (pure types, validated):
- `GenerationRequest`: { designType, targetSize, prompt, referenceAssetId?, brandKitId?, optionCount, outlineFirst }.
- `DesignOutline`: { title, theme, pages: OutlineItem[] }.
- `OutlineItem`: { id, title, points: string[], visualRole (cover|agenda|content|comparison|quote|data|closing|...), notes? }.
- `PageSpec`: { size, grid, regions: Region[] } where `Region` has { role, content (text|image|chart|shape), styleHints }; the layout engine consumes `PageSpec` to emit `@hc/schema` nodes.
- `StyleProfile`: { palette: Color[], typeScale, fontRoles, mood, compositionCues } extracted from a brand kit or a reference (reuses `@hc/color` palette extraction).

Assistant session (persisted, lightweight):
- `AiSession`: { id, designId, workspaceId, createdAt }.
- `AiTurn`: { id, sessionId, role (user|assistant), text, plan?: PlanStep[], appliedEditIds?: string[], provenance, createdAt }.
- `PlanStep`: { action, args, status (planned|done|skipped|failed), reason? }.

Provenance (attached to generated nodes/pages via existing node metadata where possible, else a side table):
- `AiProvenance`: { model, provider, prompt, params, seed?, sourceRef?, createdAt }.

Persistence: sessions/turns are workspace-isolated rows (per the data-isolation rule). Generated design content is stored in the open file format exactly like any design; provenance travels with it.

## 7. API and Interfaces

New REST endpoints under `/api/v1` (all reuse the AI platform internally; member access, workspace-isolated):
- `POST /api/v1/ai/outline` to generate or revise a `DesignOutline` from a `GenerationRequest`.
- `POST /api/v1/ai/generate-design` to start a multi-page generation job from an approved outline (or a direct prompt); returns a job id.
- `POST /api/v1/ai/variations` to generate N options for a page or design; returns a job id.
- `POST /api/v1/ai/assistant` to run one assistant turn (plan + execute or plan-only); supports streaming; large turns return a job id.
- `POST /api/v1/ai/transform` for Magic Switch / Magic Resize (params: source design, target type(s)/size(s)); returns a job id.
- `POST /api/v1/ai/chart` for Magic Charts (data or text in, `ChartNode` spec out).
- `POST /api/v1/ai/style-profile` to extract a `StyleProfile` from a reference asset or design.
- `POST /api/v1/ai/critique` to return applyable improvement suggestions for a design.
- `GET /api/v1/jobs/:id` (existing) to poll generation/transform jobs.
- `GET/POST /api/v1/designs/:id/ai-sessions` and turns for assistant history.

Existing AI endpoints (`/ai/text`, `/ai/image`, `/ai/describe-image`, `/ai/image/edit`, config/policy/usage) are unchanged and reused.

SDK (`@hc/sdk`, on the `oc`/`hc` client): typed methods mirroring the above (`aiOutline`, `aiGenerateDesign`, `aiVariations`, `aiAssistant`, `aiTransform`, `aiChart`, `aiStyleProfile`, `aiCritique`, plus session helpers), all returning typed results or job handles.

Internal interfaces:
- `@hc/aistudio` (pure): `planFromRequest`, `expandOutline`, `layoutPage(spec, size) -> Node[]`, `extractStyleProfile`, `applyBrand(profile, design)`, `qualityCheck(page) -> Issue[]`, `toolCatalog()` for the assistant. Framework-free and unit-tested, consumed from `dist/`.
- Backend orchestrator (`backend/internal/ai` extension): drives provider tool-use, validates structured outputs against the pure schemas, runs jobs, applies results through the design write path, and records provenance.

## 8. Technical Approach and Architecture

- Structured output first: define JSON Schemas for `DesignOutline`, `PageSpec`, `PlanStep[]`, and `ChartNode` specs; call providers with tool-use / response-format constraints; validate every model response against the schema and retry-on-mismatch at the orchestrator. The current `magicDesign.ts` free-text parser becomes the degraded fallback only.
- Generation pipeline: prompt to outline (structured) to per-page `PageSpec` (structured, brand/style-constrained) to `layoutPage` (deterministic node emission) to quality pass (auto-correct) to assemble pages into a design to persist. Per-page expansion fans out concurrently within a job for speed.
- Layout engine: a deterministic composer that places nodes for a `PageSpec` against a grid and type scale for the target size; shared by generation, Magic Resize, and Magic Switch so all three produce consistent structure. This is the heart of "editable and well-formed, not raw rectangles," and it leans on the existing editor transforms (align/distribute, arrange) and template/component primitives.
- Agentic assistant: a tool-use loop where the model selects from a typed `toolCatalog` mapped onto editor store actions (extends the existing command manifest in `aiCommandBar.ts`). The loop plans, optionally confirms, then executes each tool call as a normal store mutation, grouped into one undo turn. Context = session turns + a compact serialization of the current design (page list, selection, key node summaries), not the raw file, to control token cost.
- Jobs: heavy work (multi-page, variations, transforms, large agent plans) runs in the in-process job registry; progress and partial pages stream to the client via polling `GET /jobs/:id` (and the realtime channel where available). Single small edits stay synchronous.
- Reuse, do not duplicate: all model calls go through the shipped AI platform (routing, BYO keys, fallback, policy, metering); image work reuses F20 primitives; charts reuse the existing `ChartNode` model and `insertChartData`; animation reuses F25; brand data comes from F18; color/contrast from `@hc/color`; templates/components from `@hc/templates`.
- Collaborative-safe application: generated edits are applied through the same path as user edits, so F16/F10/F04 give collaboration, undo, and versioning for free.

## 9. Edge Cases and Constraints

- Provider lacks structured output: fall back to the free-text JSON parser with strict validation; if still invalid after limited retries, fail that page/step cleanly and keep the rest.
- Provider lacks an image model: generate text/layout only; leave styled image placeholders with a one-click "generate image" affordance; tell the user.
- Token/length limits on large decks: generate the outline in one call, expand pages in batched calls; never send the whole design file as context.
- Policy cap reached mid-job (monthly token cap): stop gracefully, keep completed pages, report partial completion and the cap.
- Non-Latin scripts and RTL: outline and copy generation must respect the requested language and direction; layout engine honors RTL (a known weak spot for competitors, an opportunity for us).
- Ambiguous or unsafe prompts: assistant asks one clarifying question; content safety follows the AI platform's redaction/policy.
- Determinism: layout is deterministic given a spec; generation variability comes only from the model and the seed, which is recorded for reproduction.
- Undo integrity: a cancelled job must leave the document either unchanged or at a clean, fully-undoable partial state, never half-applied without an undo entry.

## 10. Performance and Security Considerations

- Performance: outline returns fast (one call); first page thumbnail should appear within a few seconds via concurrent page expansion; the design context sent to the model is a compact summary, not the raw file, to bound latency and cost. Layout and quality passes are pure and fast.
- Cost transparency: each job reports estimated and actual token usage (reusing usage metering) so users see the cost of a generation before/after.
- Security: no new secret storage; keys stay server-side and encrypted (existing AES-256-GCM). SSRF guards on custom base URLs (existing) apply to any new provider calls. Reference images and design context sent to providers honor the platform's redaction and policy, and BYO/self-host keeps data on the user's chosen provider.
- Data transparency: because the studio sends design context and reference images to an external model, the UI clearly discloses what is sent to which provider on the first generation and in settings; this is core to the privacy positioning and should not be buried.
- Generated-content provenance and rights: outputs carry model/provider provenance (FR-27). For BYO the rights and safety of generated media follow the user's chosen provider terms; the studio surfaces, but does not itself adjudicate, that (commercial-safety indemnification, where a provider offers it, is a provider property, not ours).
- Isolation: sessions, turns, and provenance are workspace-isolated at the query layer.
- Abuse: jobs are cancellable and bounded; the monthly token cap and provider allow/block list gate runaway usage.

## 11. Acceptance Criteria

- AC-1: From one prompt, a user generates a complete multi-page deck of native, editable pages that share a coherent visual system, with brand kit applied when present.
- AC-2: The user can edit the outline before generation and the final design reflects those edits.
- AC-3: At least N distinct, meaningfully different options are produced for a generation and the user can pick or mix them.
- AC-4: The assistant executes a multi-step request ("build X, then make it on-brand, then add a chart") as native, undoable edits, revertible as one turn.
- AC-5: All design generation uses validated structured output; a schema-invalid model response is retried or degraded, never applied raw.
- AC-6: One click brings a generated or imported design fully on-brand (fonts, colors, logo, voice) across all pages, undoably.
- AC-7: Reference-image style transfer produces output that visibly matches the reference palette and feel.
- AC-8: Magic Resize reflows (not just scales) a design to a new size with hierarchy and brand intact; Magic Switch converts a deck to a summary doc and to a social set as editable output.
- AC-9: Magic Charts turns a pasted table and a natural-language description into a correctly typed, styled, editable chart.
- AC-10: Multi-page generation runs as a cancellable job with visible progress and partial results; cancelling leaves the document clean and undoable.
- AC-11: Every generated artifact carries provenance and can be regenerated.
- AC-12: With no provider configured, the studio shows setup and still offers deterministic assists; with a limited provider, it degrades and explains rather than failing.
- AC-13: All AI calls honor routing, BYO keys, fallback, policy, and metering; no provider SDK is called directly.
- AC-14: Generated images carry auto alt text and a generated design passes the accessibility checker (or surfaces its issues) before it is considered done; the user can save a generation as a reusable template.
- AC-15: The UI discloses what design data and which provider a generation uses, before the first send.

## 12. Test and Verification Plan

- Unit (`@hc/aistudio`, pure): outline expansion, `layoutPage` geometry for several sizes and roles, style-profile extraction, brand application remap, quality-check detection (contrast/overflow/overlap), tool-catalog validation, structured-output schema validation and fallback parsing.
- Backend (Go): orchestrator structured-output validation and retry, job lifecycle (progress, partial, cancel), policy/cap enforcement mid-job, provenance writes, workspace isolation, SSRF on any new calls, graceful capability degradation.
- Integration: end-to-end generate-from-prompt to persisted multi-page design with a mock provider; assistant turn producing a known sequence of undoable edits; Magic Resize/Switch round-trips; chart-from-table.
- Frontend: outline editor, generation progress and variation switcher, assistant chat with streaming and undo-per-turn, error/no-provider/degraded states, command-bar to assistant routing.
- Quality/manual: human review of generated decks/posters for visual quality, brand fidelity, contrast/legibility, RTL/non-Latin output, and editability (every element selectable and restylable).
- Generation eval harness: a golden set of prompts per design type, scored (automatically where possible: contrast pass rate, overflow/overlap count, brand-color adherence, element count, structured-output validity rate; plus periodic human rating) to catch quality regressions as prompts/models change. Run against a mock and at least one real provider.

## 13. Differentiators

- Editable-native by construction: generated decks and posters are first-class scene-graph designs, so there is no export-cleanup tax (Gamma's PowerPoint export substitutes fonts and shifts layouts; ours does not, because the artifact is the format).
- Bring-your-own-key and self-host: agentic generation runs against the user's own provider, privately, with no per-seat AI paywall and no watermarks; competitors meter AI behind Pro tiers.
- Provider-agnostic and future-proof: routing across many providers (OpenAI, Anthropic, Google, Mistral, Groq, Together, OpenRouter, Azure, custom) means the studio rides the best model available, not one vendor.
- Transparent and reproducible: provenance and seeds on every artifact make generations auditable and regenerable; usage metering makes cost visible.
- Accessibility-forward generation: WCAG-aware contrast and hierarchy checks are part of the generator, and RTL/non-Latin output is a first-class target (a known competitor weak spot).
- Open format: generated output is portable and inspectable, never locked in.

## 14. Open Questions and Risks

- Layout quality is the make-or-break: a weak layout engine yields generic output. Risk mitigation: ground in the existing 32-template seed catalog (`backend/internal/templates/seed.json`) and the component library plus a strong grid/type-scale system, and invest in the quality pass. Prefer seeding/adapting proven templates over composing from zero, and grow the seed catalog via FR-32 (save generation as template). Expanding the seed catalog is itself a worthwhile pre-investment for this feature.
- Token cost of multi-page generation with capable models can be high on BYO keys; mitigate with compact context, batching, caching, and clear cost reporting.
- Structured-output support varies by provider; the fallback parser must be robust, and capability negotiation must be honest about what a given provider can do.
- Agentic reliability: tool-use loops can misfire; mitigate with plan confirmation for large actions, strict tool schemas, single-turn undo, and conservative defaults.
- Brand fidelity from a reference image is fuzzy; set expectations and make the result fully editable so the user can finish it.
- Scope discipline: this is large. The phasing below keeps each step shippable on its own.

## 15. Suggested Implementation Phasing

Each phase is independently shippable and adds value without the later phases.
- Phase 1 (SHIPPED): Structured-output foundation and the layout engine. Landed as the pure `@hc/aistudio` package: `normalizeDesignSpec` + `designSpecJsonSchema` validate a role/layout spec (FR-12, with the legacy fraction parser kept as the degraded fallback since `oc.aiText` is free-text only); `layoutDesign(spec, size)` is the deterministic layout engine owning margins, the type scale, vertical rhythm, alignment, z-order, and WCAG-readable text color (FR-13); `qualityCheck(page)` verifies contrast/overflow/overlap (FR-14). The single-page Magic Design (`MagicDesignPanel` + the store's new `buildAiDesign`) now generates roles + a layout intent and lays them out through the engine, with a quality pass before display. Multi-page, the assistant, and Magic transforms remain in later phases.
- Phase 2 (SHIPPED): Multi-page generation, outline-first. `@hc/aistudio` outline core (`normalizeOutline`/`outlineJsonSchema`/`outlineSystemPrompt`, `outlineItemToSpec` per visual role, `deckThemes` variations, `layoutDeck`); store `buildDeckFromOutline` (whole-document, one undo); `StudioPanel` UI: prompt -> editable outline (reorder/edit/add/remove) -> generate a complete on-brand deck/doc/social-set with an N-way style switcher. Brand palette grounds both the outline prompt and the themes.
- Phase 3 (SHIPPED): The agentic assistant. `@hc/aistudio` assistant core (`toolCatalog`, `assistantSystemPrompt`, `summarizeDesign` compact context, `parseAssistantReply` validating actions/args against the catalog, `planMutates`); store `runAsTurn` collapses a plan's edits into ONE undo turn (FR-8); `AssistantPanel` chat with session history (FR-9), clarifying questions (FR-10), per-step status, and "Undo turn". The shipped command bar remains the single-action fast path (FR-11).
- Phase 4 (SHIPPED): Magic transforms. `@hc/aistudio` transform core (`deriveOutline` from any current design, `switchOutline` deck->doc/social-set/poster, `recomposeSpec` = size-aware re-layout for AI Resize, `normalizeChartSpec`/`chartSystemPrompt` for Magic Charts, `paletteTheme` for style transfer); `TransformPanel` (Magic Switch) + `ChartPanel` (data/NL -> editable ChartNode) wired to `buildDeckFromOutline`/`insertChartData`.
- Phase 5 (SHIPPED): Generative media in context (`groundImagePrompt` grounds image gen in brand palette + aspect, applied in the image generator, FR-23); critique-and-improve (`ImprovePanel` runs critique then harmonize+tidy as one turn, FR-15); Magic Animate (existing `magicAnimatePage`, also an assistant tool, FR-22); RTL/non-Latin hardening (layout `dir` honors RTL alignment + paragraph direction). Streaming and a server-side job registry for generation remain future work - see note below.

Additional FR coverage delivered client-side: FR-2 skip-outline fast path ("Generate now"); FR-16 one-click brand apply across pages (existing `BrandPanel` + `applyBrandFixes`); FR-18 reference-image style transfer ("Match selected image colors" extracts a palette and grounds the deck themes); FR-27 provenance (`recordProvenance` writes feature/prompt/model into `doc.meta.aiProvenance`); FR-32 save-as-template (existing `SaveAsTemplateDialog`). FR-28 (routing/BYO/policy/metering) is honored because every call routes through the shipped AI proxy.

Backend orchestration (section 7) is now built in `backend/internal/aistudio`, reusing the AI proxy (routing/BYO/policy/metering) and adding the orchestrator value the spec asks for: every generator embeds its JSON Schema, the server validates the model reply against typed Go validators and retries on mismatch (FR-12), and returns clean typed objects. Endpoints: `POST /api/v1/ai/outline`, `/ai/generate-design` (job: outline + per-page copy-polish, FR-1/FR-5/FR-25), `/ai/variations` (job: N distinct angles, FR-4), `/ai/assistant` (validated plan/clarify, FR-6/7/10), `/ai/chart` (FR-21), `/ai/style-profile` (FR-18), `/ai/critique` (FR-15), plus design-scoped `GET/POST /designs/:id/ai-sessions` and `/ai-sessions/:sid/turns` for persisted assistant history + provenance (FR-9/FR-27, tables `AiSession`/`AiTurn`, workspace+design isolated). Typed SDK methods mirror all of these. The frontend studio/assistant/chart now PREFER these endpoints (server-side validation + retry) and fall back to the free-text `@hc/aistudio` path if a provider/endpoint is unavailable.

The deterministic layout engine deliberately stays in `@hc/aistudio` (TypeScript): the orchestrator returns validated outlines/specs/plans and the client composes the final scene graph, so there is no duplicate Go layout engine to drift (the repo rule against duplicating engine/schema logic). FR-26 streaming and incremental job-progress remain limited by the platform's non-streaming primitive and the synchronous in-process job registry (jobs are recorded then polled, not streamed); these are infra constraints, not missing F39 surface.
