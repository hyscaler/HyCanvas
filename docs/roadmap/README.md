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
