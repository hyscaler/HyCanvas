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
| Accessibility, i18n, security, compliance, self-host, NFR | [38-accessibility-i18n-security-compliance-selfhost-nfr.md](38-accessibility-i18n-security-compliance-selfhost-nfr.md) | **In progress.** Accessibility, i18n (seven full catalogs, 3232 keys each), export fidelity and RTL shipped, with a zero-violation axe pass recorded in `docs/audits/`. The FR-13 ratchet blind spot is closed, and API errors now localize (every problem+json response carries a stable code, enforced on both sides). Remaining: a manual screen-reader pass, passkeys (deferred), and the workspace-scoped half of the audit trail (FR-16/AC-7), deferred as useful but not pressing since the design-scoped half already ships. Enterprise governance (SAML, SCIM, DLP, CMEK, hash-chained audit) was dropped from scope, not deferred |

### Schema version allocation

A version is a single global counter mirrored in Go (`backend/internal/persistence/file.go`), so it has to be allocated centrally, in the order the work actually lands, not per document. Whoever starts a bump claims the next free number here first and edits their spec to match:

| Version | Owner | Carries |
| --- | --- | --- |
| 17 | shipped | |
| 18 | shipped | `DesignFile.language` (F38, August 2026) |
| 19 | Effect stack | `Effect.enabled` and `TextEffect.enabled`, the per-effect enable |
| 20 | shipped | `ImageNode.alphaMask`, non-destructive background removal (August 2026; landed without claiming here - backfilled) |
| 21 | F28 T11 | `Placeholder.maxChars/minChars/minItems/maxItems`, optional capacity hints for layout-grounded generation |
| 22 | F28 completion C02+C03 | `PageTransition.easing` (plain string, engine-clamped) and `Page.transitionOut`, per-transition easing + exit transitions |
| 23 | F28 completion C11+C12+C13+C15 | `Keyframe.color/width/height`, `KeyframeTrack.path/orient`, `AnimationClip.spring`, `NodeAnimation.trigger` - animation depth channels |
| 24 | F28 completion C16 | `Interaction.actionV2` (plain-string kind + optional target), the play-media / run-animation interaction actions |

This table was already wrong once, which is the case for keeping it. F38
shipped `DesignFile.language` as v18 in August 2026 without reclaiming the
number here, so the table went on offering 18 to a spec that would then have
bumped to a version already in use, and the Go write boundary would have
started rejecting files. Claim the number HERE first, then edit the spec.

Two rules that follow from the counter being global. A bump must raise
`currentSchemaVersion` and the Go mirror in the SAME change, or the write
boundary answers 422 and nothing persists. And a version is permanent once it
reaches a real instance: under the zero-data-loss rule every later binary has
to open, migrate, and preserve it forever, so the moment before a schema
addition ships is the only free moment to decline it.

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

### Creation depth: specified, then withdrawn (August 2026)

Six specs were drafted to take the platform from a layout tool to a 2D
content-creation suite: a procedural node graph, vector authoring depth, raster
and painting, motion graphics, GPU rendering, and creative interop with colour
management. **They were withdrawn in August 2026 before any of them shipped**,
and the documents were removed. This section records why, so the decision is not
silently re-litigated.

Two findings drove it.

The demand evidence never improved. A market and demand review found that
internationalisation and accessibility show more evidence of BLOCKING adoption
than creative depth does, and that they are two axes an incumbent cannot easily
follow us onto:

- Demand for creative depth from a template-first audience is weak where it is measurable. On the closest vote-counted analogue board, a pen tool scores 5 votes while "export to an editable format a professional can open" scores 1,128, and non-English font coverage scores 135. The market leader reached hundreds of millions of users without ever shipping a bezier pen.
- Language support is stated as a hard adoption blocker by real teams, and a paid cottage industry exists purely to pre-fix RTL text for tools that lack shaping. RTL and Indic grapheme handling share a root cause, so they are one investment rather than two.
- Accessibility is a procurement gate rather than a popularity contest: public buyers must demand conformance evidence, several universities restrict competing tools over EXPORT accessibility rather than missing features, and the leading products' published conformance records are years stale or absent. Vote counts systematically understate this, because one blocked institution equals one lost contract.
- Self-hosting and data sovereignty are what organizations actually pay for in a browser-based creative tool, which is F38's territory and already our strongest differentiator.
- The creative-depth market moved in the meantime: a mature professional vector, raster, and publishing suite became free in October 2025, so entering on depth alone means competing with free incumbents for a much smaller audience, on the axis where we are weakest.

A surfaced node graph in particular had no demand evidence at all from this
audience, which its own spec conceded.

The first phase turned out to be defect repair wearing feature clothing. When it
was attempted, its stated prerequisites were not groundwork for anything new:
they were bugs in shipped behaviour. Those were fixed and kept. The procedural
machinery built on top of them was removed rather than shipped, because a schema
addition is permanent under the zero-data-loss rule and the moment before it
reaches an instance is the only free moment to decline it.

What this does NOT say is that creative depth is worthless. Vector authoring
depth and colour management stand on their own and would deserve fresh specs on
their own evidence. It says the set was bundled too early, that the bundle made
the speculative parts look as justified as the necessary ones, and that
separating them was the part with a demonstrable payoff.

Defects those audits recorded, and where they now stand. Fixed as part of the
withdrawal: `MaskNode` was in the schema and rendered by nothing, in all four
output paths; group opacity multiplied down per child instead of compositing the
group as a layer, so overlaps in a semi-transparent group showed seams; boolean
nodes drew curved results as polylines. Still open and unowned now that the
specs are gone: the Go export renderer's coverage gaps, background removal
writing a base64 cutout into the document and therefore into the CRDT, every
snapshot and IndexedDB, and the dead `matte.ts`, `tiles.ts`, `EngineConfig`
tiling knobs, and `Scene` dirty API. Whoever next touches those areas owns them.

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
- i18n and localization; observability beyond structured logs; compliance programs (SOC 2, ISO 27001, GDPR tooling); Helm.
- A workspace audit trail (widening the existing `activity_events` feed to workspace scope and adding sign-in, permission, sharing, export and admin events) and data residency.
- Dropped from scope in August 2026, with reasons recorded in the spec: SAML 2.0 (OIDC covers every modern IdP and SAML's XML signature handling is a permanent risk surface), SCIM 2.0 (manual deprovisioning is the accepted gap), DLP policy controls (a single external-sharing toggle survives instead), and CMEK (a self-hoster already owns the keys). WebAuthn and passkeys are deferred, not dropped: TOTP already satisfies MFA.
- Editor accessibility depth: full keyboard model, assistive-technology tree, high-contrast theme.

## Editor parity backlog

The editor closed every audited capability gap: all 56 tracked items ship, and the one deliberately out-of-scope item (semantic/embedding element search) is not planned. The completed, code-audited record is archived at [`../shipped/editor-parity-backlog.md`](../shipped/editor-parity-backlog.md). Start a fresh backlog if new capability gaps surface.
