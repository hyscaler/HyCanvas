# Roadmap

The core product is built: a single-player editor, content systems (uploads, stock, templates), accounts and workspaces, document types (presentations, video, whiteboard, docs, sheets), export, brand kits, a bring-your-own-key AI layer, and the AI Creative Studio (agentic outline-first multi-page generation, a conversational design assistant, Magic transforms, and brand/style grounding) all ship today on the Go + Next.js stack described in the root `README.md`.

Specs for already-shipped features are archived in [`../shipped/`](../shipped/README.md) (the shipped code is the source of truth for those). What stays below is the work that is genuinely unbuilt or early, kept as a forward-looking spec for each.

For the product-wide north star (the goals and differentiators we hold ourselves to), see [requirements.md](requirements.md).

## Remaining work at a glance

| Area | Spec | State |
| --- | --- | --- |
| Realtime collaboration | [16-realtime-collaboration.md](16-realtime-collaboration.md) | Core and multi-instance shipped; scale and deep-enforcement work remains |
| AI media | [23-ai-media.md](23-ai-media.md) | Not started (blocked on the video media pipeline and audio/video model endpoints) |
| Presentations | [28-presentations.md](28-presentations.md) | Core shipped; PPTX round-trip, presenter display, live audience, and a11y leadership remain |
| Whiteboard | [30-whiteboard.md](30-whiteboard.md) | Core shipped; infinite canvas, ink, facilitation suite, and scale remain |
| Accessibility, i18n, security, compliance, self-host, NFR | [38-accessibility-i18n-security-compliance-selfhost-nfr.md](38-accessibility-i18n-security-compliance-selfhost-nfr.md) | Self-host baseline strong; i18n, compliance, and enterprise controls remain |

Each spec follows the original 15-section template (context, requirements, data model, API, acceptance criteria, tests). Read the spec before picking up its area, and keep it in sync if scope changes.

## Status detail

### Realtime collaboration (16)

Shipped:
- Yjs CRDT sync over `/realtime`, presence cursors and follow mode, offline editing (IndexedDB), authed and read-only enforcement.
- Collaborative locks with heartbeat-TTL release, per-user undo, character-level text merge, live permission downgrade.
- Horizontal scale: Redis fan-out, cross-instance roster catchup, Redis-CAS lock authority.
- CRDT history scrubber and restore, automatic snapshots, update-log compaction.

Remaining:
- Per-page subdocuments and lazy load at scale (plus the GPU-paint AC-10 proof).
- True in-CRDT branches; server-authoritative last-leave snapshot.
- On-the-wire per-node enforcement (needs a server-side CRDT decoder; deferred).

### AI media (23)

Not started. Captions, TTS, music, avatars, lip-sync, and image-to-video are all blocked on the video media pipeline and on audio/video model endpoints in the AI layer.

### Presentations (28)

Shipped:
- Presentations as the multi-page editor: `Page` present fields plus the F25 animation model (`NodeAnimation`, `KeyframeTrack`, `Interaction`, `ImageMotion`, `PageTransition`).
- The pure `@hc/engine` playback core (`animation.ts`, `pose.ts`) rendering identically in editor preview, present mode, and animated export.
- Present mode with 9 transitions including id/name-matched Magic Move morph, laser/pen/spotlight tools, autopilot, and a presenter HUD with rehearsal timer.
- AI prompt-to-deck (F39), charts and tables, sharing with per-page engagement insights, image/PDF/SVG/APNG/GIF export.

Remaining:
- PPTX import/export round-trip; slide masters, layouts, themes, and sections.
- A true second-display presenter view; present-and-record plus full-deck video export.
- Live audience Q&A, polls, reactions, captions.
- AI design autopilot, whole-deck translation, speaker-note generation, doc/URL/file ingestion.
- Live data-linked charts and bulk merge; accessibility leadership (alt text, reading order, checker integration, tagged PDF, reduced motion); 60fps present at scale.

### Whiteboard (30)

Shipped:
- The whiteboard document type: `@hc/whiteboard` routing/layout/templates/sessions over the shared canvas, sticky/connector/frame schema nodes.
- Realtime collaboration with presence, reactions, and cursor chat; comments and sharing; dot-voting, the session timer, convert-to-deck.

Remaining:
- True infinite canvas; board-native ink and free-draw connectors.
- The full facilitation suite: private mode, spotlight/take-control, server-authoritative voting, breakouts.
- AI canvas agents; diagram-as-code round-trip; performance at 10k+ objects; accessibility leadership.

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

The editor reached Canva parity on every audited gap: all 56 tracked items ship, and the one deliberately out-of-scope item (semantic/embedding element search) is not planned. The completed, code-audited record is archived at [`../shipped/editor-parity-backlog.md`](../shipped/editor-parity-backlog.md). Start a fresh backlog if new Canva-parity gaps surface.
