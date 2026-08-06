# Roadmap

The core product is built: a single-player editor, content systems (uploads, stock, templates), accounts and workspaces, document types (presentations, video, whiteboard, docs, sheets), export, brand kits, a bring-your-own-key AI layer, and the AI Creative Studio (agentic outline-first multi-page generation, a conversational design assistant, Magic transforms, and brand/style grounding) all ship today on the Go + Next.js stack described in the root `README.md`.

Specs for already-shipped features are archived in [`../shipped/`](../shipped/README.md) (the shipped code is the source of truth for those). What stays below is the work that is genuinely unbuilt or early, kept as a forward-looking spec for each.

For the product-wide north star (the goals and differentiators we hold ourselves to), see [requirements.md](requirements.md).

## Remaining work at a glance

| Area | Spec | State |
| --- | --- | --- |
| Realtime collaboration | [16-realtime-collaboration.md](16-realtime-collaboration.md) | Core, multi-instance, server-side CRDT fold + last-leave snapshot, in-CRDT branches, and the measured scale story all shipped; only on-wire per-node enforcement remains (deferred on per-frame decode cost) |
| AI media | [23-ai-media.md](23-ai-media.md) | Not started (blocked on the video media pipeline and audio/video model endpoints) |
| Presentations | [28-presentations.md](28-presentations.md) | Core + a long interop/AI/live tail shipped (PPTX export, deck-to-video MP4, present-and-record, live audience Q&A/polls/reactions, whole-deck translation, AI speaker notes, doc/URL/file ingestion, tagged PDF); PPTX import now ships too (full round-trip); masters/layouts UI and live-data charts/bulk merge remain |
| Whiteboard | [30-whiteboard.md](30-whiteboard.md) | Core, infinite canvas, ink, the full facilitation suite, and the Phase 3 AI canvas (diagram-from-prompt, clustering, summarize, Mermaid round-trip) shipped; agent deep-end and guest rate limiting remain |
| Accessibility, i18n, security, compliance, self-host, NFR | [38-accessibility-i18n-security-compliance-selfhost-nfr.md](38-accessibility-i18n-security-compliance-selfhost-nfr.md) | Self-host baseline strong; i18n, compliance, and enterprise controls remain |
| Procedural node graph and non-destructive editing | [40-procedural-node-graph.md](40-procedural-node-graph.md) | Not started; the core of the creation-depth set (layers and graph as two views of one document) |
| Vector authoring depth | [41-vector-authoring.md](41-vector-authoring.md) | Not started; a pen and a node editor exist, but booleans bake, path effects do not exist, and `mask`/`boolean` have no export path |
| Raster imaging and digital painting | [42-raster-and-painting.md](42-raster-and-painting.md) | Not started; ink is a vector ribbon, there is no brush engine, and the one existing pixels-in-document path writes base64 into the CRDT |
| Real-time and procedural motion graphics | [43-motion-graphics.md](43-motion-graphics.md) | Not started; a preset animation model and a Go poser ship, but there is no timeline panel, no curve editor, and nothing procedural |
| GPU-accelerated rendering | [44-gpu-rendering.md](44-gpu-rendering.md) | Not started; the seam exists but is inert (`gpuAvailable()` returns false), and render parity across the four output paths is currently unmet and untested |
| Creative interop, colour management, asset libraries | [45-creative-interop-and-color.md](45-creative-interop-and-color.md) | Not started; PPTX/PDF/SVG ship, but PSD/AI/EPS/DXF import, ICC and CMYK, and shared libraries do not |

### Schema version allocation

Five of the creation-depth specs bump `CURRENT_SCHEMA_VERSION`, and several were drafted in parallel each claiming "17 to 18". A version is a single global counter mirrored in Go (`backend/internal/persistence/file.go`), so it has to be allocated centrally, in the order the work actually lands, not per document. Whoever starts a bump claims the next free number here first and edits their spec to match:

| Version | Owner | Carries |
| --- | --- | --- |
| 17 | current | shipped |
| 18 | F40 | `NodeBase.graph` plus the bake |
| 19 | F41 | vector op node types and `PathNode.pathEffects` |
| 20 | F42 | `ImageNode.raster` tile manifests |
| 21 | F43 | the `MotionNode` payload |
| 22 | F45 | colour, print, and library records |

F44 bumps nothing by design.

One more thing to fix before anyone codes: the six header tables use a single "Depends on" field for two different relationships, which makes the graph look cyclic (F40 lists F41 through F45, and each of those lists F40). Read it as **Requires** (must exist first) versus **Serves** (is consumed by). F40 requires nothing from F42, F43, or F45; F44 requires nothing from F42 or F43; F41 requires the geometry kernels that F40 Phase 1 re-homes into the engine. Split the field when each spec is next touched. The table is the claim, not the specs: if the build order changes, renumber here and fix the specs, never the other way round.

Each spec follows the original 15-section template (context, requirements, data model, API, acceptance criteria, tests). Read the spec before picking up its area, and keep it in sync if scope changes.

## Status detail

### Realtime collaboration (16)

Shipped:
- Yjs CRDT sync over `/realtime`, presence cursors and follow mode, offline editing (IndexedDB), authed and read-only enforcement.
- Collaborative locks with heartbeat-TTL release, per-user undo, character-level text merge, live permission downgrade.
- Horizontal scale: Redis fan-out, cross-instance roster catchup, Redis-CAS lock authority.
- CRDT history scrubber and restore, automatic snapshots, update-log compaction.

Shipped since the last audit:
- The server decodes the CRDT (`backend/internal/crdt`: the client fold bundled and embedded under a pure-Go JS engine, byte-identical output) and materializes a server-authoritative last-leave snapshot (catch-up-only, dedup-safe).
- True in-CRDT named branches with live switching: branch-scoped update-log lineages inside one design, branch realtime rooms, History-panel switcher + "Branch from here", compaction fork-guards, and main-lineage write protection during branch sessions.
- The scale story: page-granular incremental projection (a peer's edit re-projects one page, not the deck) and the AC-10 browser paint proof (p50 120fps on the 50-page x 1000-node deck at dpr 2; `npm run bench:paint`). True per-page Y.Doc subdocuments were deliberately rejected: a per-room protocol change that old clients sharing the live room cannot survive.

Remaining:
- On-the-wire per-node enforcement (the decoder now exists; deferred on per-frame decode cost pending a pooled/incremental design).

### AI media (23)

Not started. Captions, TTS, music, avatars, lip-sync, and image-to-video are all blocked on the video media pipeline and on audio/video model endpoints in the AI layer.

### Creation depth: the 2D content-creation set (40 to 45)

Six specs that together take the platform from a layout tool to a comprehensive 2D content-creation suite for graphic design, digital art, and interactive real-time motion graphics. They close two north-star differentiators that have never had specs behind them: a GPU-accelerated engine, and a real vector editor with print-grade colour.

All six are Not started. They are written to be built roughly in this order, which is not their numeric order: a minimal F40 core together with F41, because parametric path effects are graph operations and building the pen destructively first means building it twice; then F44, because F42 and F43 are impractical at professional scale on Canvas2D alone; then F42, then F43, then F45 last, since interop matters most once there is depth worth importing into.

Two constraints run through all six. Progressive disclosure: direct manipulation stays the default and writes into the graph behind the scenes, and a task that can only be completed through the graph panel is a defect, not a power feature. Render parity: every path already disagrees today, so the parity suite in F44 Phase 0 is a prerequisite for the rest rather than a later hardening pass.

The audits behind these specs also recorded defects in shipped code, each tracked in the spec that owns the area: the Go export renderer implements no drop shadows, no blend modes, and no shape strokes, so those export wrong from the current product; `MaskNode` is in the schema and rendered by nothing; group opacity multiplies per child instead of compositing the group as a layer; background removal writes a base64 cutout into the document and therefore into the CRDT, every snapshot, and IndexedDB; and `matte.ts`, `tiles.ts`, the `EngineConfig` tiling knobs, and the `Scene` dirty API are all dead code.

### Presentations (28)

Shipped:
- Presentations as the multi-page editor: `Page` present fields plus the F25 animation model (`NodeAnimation`, `KeyframeTrack`, `Interaction`, `ImageMotion`, `PageTransition`).
- The pure `@hc/engine` playback core (`animation.ts`, `pose.ts`) rendering identically in editor preview, present mode, and animated export.
- Present mode with 9 transitions including id/name-matched Magic Move morph, laser/pen/spotlight tools, autopilot, and a presenter HUD with rehearsal timer.
- AI prompt-to-deck (F39), charts and tables, sharing with per-page engagement insights, image/PDF/SVG/APNG/GIF export.

Shipped since the last audit:
- PPTX EXPORT (`@hc/export` OOXML writer: editable text/shapes/images/notes, engine-rasterized fallback for the rest, surfaced in ExportDialog).
- One-click deck-to-video MP4 (client deck-to-video conversion rendered on the server video pipeline via an inline-file override) and present-and-record (slides + ink + mic narration to a local .webm).
- Live audience: share-link viewers (anonymous OK) ask/upvote questions, vote on presenter polls, and send emoji reactions that float over the presenter's slides live; presenter moderation drawer in present mode.
- The FR-23 AI trio: whole-deck translation (per-run, styling preserved), AI speaker notes, and doc/URL/file-to-deck ingestion (SSRF-hardened URL extractor, PDF/text/markdown attach).
- Confirmed already shipped despite stale spec rows: second-display presenter view, tagged selectable-text PDF, sections/layout plumbing, the Go animation core.

Shipped since: PPTX IMPORT (dependency-free OOXML parser: editable text/shapes/images/notes/backgrounds, round-trip proven against our exporter; the dashboard Import tile accepts .pptx) and presenter-driven slide-follow (the shared player mirrors the live presenter's slide).

Remaining:
- Slide master/layout editing UI (the schema shipped at v11).
- Live data-linked charts and bulk data-merge; live captions (deferred to the AI-media pipeline); the present-and-record camera bubble; Keynote/Google/ODP interop; 60fps present-at-scale measurement.

### Whiteboard (30)

Shipped:
- The whiteboard document type: `@hc/whiteboard` routing/layout/templates/sessions over the shared canvas, sticky/connector/frame schema nodes.
- Realtime collaboration with presence, reactions, and cursor chat; comments and sharing; dot-voting, the session timer, convert-to-deck.

Shipped since the last audit (the spec's own header was fresher than these rows):
- True infinite canvas, board-native ink, free connectors, quadtree culling/LOD, and touch/stylus input (Phase 1).
- The facilitation suite: private mode (hidden-until-reveal rounds), protected facilitator lock with handoff, spotlight/summon/take-control, server-authoritative voting, kick/ban moderation, timer, named views/deep-links.
- Phase 3 AI canvas core: diagram-from-prompt (native stickies + connectors, auto-laid-out, one undo), sticky clustering into labeled theme frames, board summarize to a canvas note, all via the conversational assistant; Mermaid import (pasted source parses directly) and "Copy as Mermaid" export.

Remaining:
- The canvas-agent deep end (viewport-screenshot context, streaming multi-step actions, computation-graph cards); breakout rooms; anonymous-guest rate limiting and first-run onboarding polish; PlantUML/DOT interop; 10k+ object measurement beyond the shipped spatial index.

### Accessibility, i18n, security, compliance, self-host, NFR (38)

Shipped:
- The design accessibility checker; app-wide reduced motion; a token-driven dark mode for the app chrome (system/light/dark, never restyling design content).
- Self-host baseline: a single self-daemonizing binary, browser/CLI first-run setup wizard with reverse-proxy support, `storage migrate` to S3, per-workspace and per-user storage quotas with UI meters.
- Release engineering: multi-platform binaries with checksums and lean channel-tagged Docker images, cut from `stable` only, each release carrying generated notes.
- Auth hardening: OIDC SSO and MFA (TOTP).

Remaining:
- i18n and localization; SCIM; observability beyond structured logs; compliance programs (SOC 2, ISO 27001, GDPR tooling); Helm.
- Enterprise controls: audit log, DLP, CMEK, data residency.
- Editor accessibility depth: full keyboard model, assistive-technology tree, high-contrast theme.

## Editor parity backlog

The editor closed every audited capability gap: all 56 tracked items ship, and the one deliberately out-of-scope item (semantic/embedding element search) is not planned. The completed, code-audited record is archived at [`../shipped/editor-parity-backlog.md`](../shipped/editor-parity-backlog.md). Start a fresh backlog if new capability gaps surface.
