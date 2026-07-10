# Feature Checklist

A living checklist of what ships today versus what is planned. Shipped items are grounded in the code; pending items map to the specs in [`roadmap/`](roadmap/README.md). Keep this in sync as scope changes.

## Shipped

### Editor core
- [x] Scene-graph engine on Canvas2D (framework-agnostic; browser, worker, headless server)
- [x] Shapes, lines, arrows, frames, grids, tables, 9 chart types, QR codes
- [x] Text: presets, font pairings, searchable catalog, custom font upload (embedded)
- [x] Fills (solid/gradient/image/pattern), stroke, corner radius, opacity, effects (shadow/lift/hollow/glow/neon)
- [x] Image filters, Light/Color/Detail adjust, crop, remove background, rasterize
- [x] Animations: entrance/exit/emphasis presets, motion-path keyframes, photo motion (Ken Burns/parallax)
- [x] Layers panel, alignment guides/snap, rulers, grid, minimap, zoom control
- [x] Keyboard shortcuts (with remapping dialog), command menu + AI command bar
- [x] Magic Resize (switch format / re-flow), boolean ops, groups
- [x] Autosave + manual save

### Content systems
- [x] Uploads (folders, tags, from-URL, SVG/PDF import, screen/mic recording)
- [x] Stock (bundled catalog + live Openverse photos, licensing/attribution)
- [x] Templates (categories, save-as-template, workspace collections, locked regions)
- [x] Brand kits (colors/fonts/logos/voice, brand lock with off/warn/block policy, auto-fix, re-skin)

### Document types
- [x] Presentations (present mode: 9 transitions incl. Magic Move, laser/pen/spotlight, autopilot, presenter HUD, rehearsal timer)
- [x] Pure, exportable transition compositor in `@hc/engine` (F28 FR-13), shared by present mode, the player, and (planned) export
- [x] Shared-link deck player: engine-drawn slides, navigation, fullscreen, real transitions (F28 FR-26)
- [x] Animated export of a whole deck (APNG/GIF) with slide transitions composited (F28 FR-19 groundwork)
- [x] Second-display presenter view: audience window, wall clock, teleprompter (F28 FR-15)
- [x] Slide master/layout/placeholder model + swappable deck Theme, schema v11 (F28 FR-3, FR-4)
- [x] Accessibility model: per-node alt text + decorative, page reading order, schema v12 (F28 FR-29)
- [x] Whiteboards (sticky/frame/ink/connectors, 8 templates, facilitation, synced timer, dot voting, convert-to-deck)
- [x] Sheets (~48-function formula engine, formatting, borders, sort)
- [x] Docs (block editor, callouts, embeds, AI writing tools, DOCX/PDF export)
- [x] Video (multi-track timeline, trim/split/transitions/audio mixing, server MP4 render)

### Collaboration
- [x] Realtime CRDT (Yjs), presence cursors, follow mode, locks, per-user undo
- [x] Offline editing (IndexedDB) with merge on reconnect
- [x] Multi-instance scale (Redis fan-out, cross-instance roster, CAS lock authority)
- [x] Comments (threads, pins, @mentions, reactions, resolve, convert-to-task)
- [x] Version history (auto/named checkpoints, restore, branch, CRDT scrub timeline)
- [x] Approvals (any/all policy, server-enforced lock), activity feed, engagement insights
- [x] Share links (view/comment/edit, password, expiry, require-sign-in) with canonical URLs
- [x] My tasks

### AI
- [x] Bring-your-own-key providers (OpenAI/Anthropic/DeepSeek/custom), encrypted per workspace
- [x] Magic Design, design assistant chat, image generation, restyle, chart, critique
- [x] AI Creative Studio (outline-first multi-page generation), no-key Assist tools

### Export and publishing
- [x] Export: PNG/JPG/PDF/SVG/APNG/GIF/Lottie, size multipliers, page selection, zip
- [x] Print (OS dialog at print resolution)
- [x] Website generator (static HTML, SEO, nav, file export), local generation only
- [x] Social publish planner, local/mock only

### Accounts, workspaces, platform
- [x] Roles (owner/admin/member/viewer) + custom roles; invitations
- [x] Cookie sessions, MFA (TOTP), OIDC SSO
- [x] Per-workspace + per-user storage quotas with UI meters
- [x] Notifications (email + web-push preferences)
- [x] Dark mode (system/light/dark), app-wide reduced motion
- [x] Design accessibility checker (contrast/alt-text/reading-order/tap-target)

### Self-host and ops
- [x] Single self-daemonizing binary (service start/stop/restart/status/log)
- [x] First-run setup wizard (browser + CLI), reverse-proxy support
- [x] `storage migrate` local to S3
- [x] Multi-platform release binaries + checksums + generated notes
- [x] Lean channel-tagged Docker images, stable-branch-gated releases

## Pending

### AI media ([spec 23](roadmap/23-ai-media.md)), not started
- [ ] Captions, TTS, music generation, AI avatars, lip-sync, image-to-video (blocked on the video pipeline + audio/video model endpoints)

### Presentations ([spec 28](roadmap/28-presentations.md))
- [ ] Deck-to-video (server MP4 with animations, transitions, narration); per-transition easing
- [ ] Tracked per-audience player links with passcodes and per-slide dwell analytics; iframe embed
- [ ] Grid/outline overview editing view
- [ ] PPTX import/export round-trip
- [ ] Present-and-record; full-deck video
- [ ] Live audience Q&A, polls, reactions, captions
- [ ] AI design autopilot, whole-deck translation, speaker-note generation, doc/URL ingestion
- [ ] Live data-linked charts, bulk merge; 60fps present at scale

### Whiteboard ([spec 30](roadmap/30-whiteboard.md))
- [ ] True infinite canvas; board-native ink and free-draw connectors
- [ ] Full facilitation suite (breakouts, spotlight/take-control, server-authoritative voting)
- [ ] AI canvas agents; diagram-as-code; performance at 10k+ objects

### Realtime ([spec 16](roadmap/16-realtime-collaboration.md))
- [ ] Per-page subdocuments + lazy load at scale
- [ ] True in-CRDT branches; server-authoritative last-leave snapshot
- [ ] On-the-wire per-node enforcement (needs a Go CRDT decoder)

### Accessibility, i18n, enterprise ([spec 38](roadmap/38-accessibility-i18n-security-compliance-selfhost-nfr.md))
- [ ] UI internationalization/localization; high-contrast theme; full keyboard model + assistive-tech tree
- [ ] SCIM, audit log, DLP, customer-managed keys (CMEK), data residency
- [ ] Observability (metrics/traces), Helm chart, compliance programs (SOC 2/ISO 27001), backup/DR drills

### Publishing gaps (marked in-product)
- [ ] Real social-account posting (currently local planner only)
- [ ] Hosted website publishing: domains, TLS, server-side password gate, form capture

### Sheets gaps
- [ ] Merge cells, frozen panes, filter views, function autocomplete
