# F28 Completion: Implementation Task Board

| Field | Value |
| --- | --- |
| Role | Execution-grade task list closing the remaining Not started / Partial rows in `28-presentations.md`. Written to be picked up and implemented task by task by an AI coding session running in this repository |
| Date | 2026-08-25 (rows audited against the code the same day; the capability tables in `28-presentations.md` are current as of commit `7e3e128`) |
| Parent docs | `28-presentations.md` (F28 spec; each task names the capability-row it closes), `28-presentations-leverage-tasks.md` (the completed predecessor board; its "How to use" conventions apply verbatim) |

## How to use this document (read this first, every session)

The rules from `28-presentations-leverage-tasks.md` apply unchanged. In brief:

1. Read `CLAUDE.md` at the repo root first. Zero Data Loss rules override everything: schema changes are additive-only, claim the version number in `docs/roadmap/README.md` FIRST, bump `packages/schema/src/schema.ts` and `backend/internal/persistence/file.go` together, register the forward migration, update the paired exact version-pin tests on both sides. Never widen an enum on an existing node type; a new interaction/animation behavior goes on a NEW optional field so older clients keep validating the file.
2. Implement ONE task at a time. Verify honestly (`npm run build:packages`, `npm run test`, `cd backend && go test ./...`, `npm run lint`, plus the task's own acceptance check), flip the Status here with the date, and keep the matching capability row in `28-presentations.md` in sync (upgrade-only, keep honest gap notes).
3. New user-facing strings go in all 8 locale catalogs; API errors are RFC 7807 problem+json with stable codes (one message per code); long-running server work goes through the job registry.
4. If a task turns out to be already done, wrong, or blocked, update its Status to `blocked` or `dropped` with a one-line reason and stop. Do not force it.

## Task status board

| Task | Phase | Title | Status |
| --- | --- | --- | --- |
| C01 | 1 Hardening | Archive-bomb guards on the client zip reader | done 2026-08-25 |
| C02 | 1 Hardening | Per-transition easing control (schema v22) | done 2026-08-25 |
| C03 | 1 Hardening | Exit / asymmetric transitions (schema v22, same bump) | done 2026-08-25 |
| C04 | 1 Hardening | Transition picker gallery with live preview swatches | done 2026-08-25 |
| C05 | 1 Hardening | Animate-all-slides bulk action | done 2026-08-25 |
| C06 | 2 Morph | Nested / grouped element morph matching | done 2026-08-25 |
| C07 | 2 Morph | Per-element morph easing | done 2026-08-25 |
| C08 | 2 Morph | Fill / stroke / color / radius morph tween | done 2026-08-25 |
| C09 | 2 Morph | Forced-match naming convention | done 2026-08-25 |
| C10 | 2 Morph | Word-level text morph | done 2026-08-25 |
| C11 | 3 Animation | Motion paths (follow a curve, orient-to-path) | done 2026-08-25 |
| C12 | 3 Animation | Color and size keyframe channels | done 2026-08-25 |
| C13 | 3 Animation | Configurable spring physics | done 2026-08-25 |
| C14 | 3 Animation | Animation painter (copy animations between elements) | done 2026-08-25 |
| C15 | 3 Animation | Animation triggers tied to media timestamps | done 2026-08-25 |
| C16 | 4 Present | Element interaction actions: play media, run animation | done 2026-08-25 |
| C17 | 4 Present | Live captions overlay (local speech recognition) | done 2026-08-25 |
| C18 | 4 Present | Translated captions | done 2026-08-25 |
| C19 | 4 Present | Kiosk / links-only navigation mode | done 2026-08-25 |
| C20 | 4 Present | Speaker coach (pacing, filler words, long pauses) | done 2026-08-25 |
| C21 | 4 Present | Phone-as-remote pairing | done 2026-08-25 |
| C22 | 4 Present | Co-presenter control hand-off | done 2026-08-25 |
| C23 | 5 Scale+Interop | Present prefetch: precompute the next slide | todo |
| C24 | 5 Scale+Interop | Large-deck PagesBar virtualization + lazy thumbnails | todo |
| C25 | 5 Scale+Interop | ODP import (Keynote/Slides documented via the PPTX bridge) | todo |
| C26 | 5 Scale+Interop | Markdown outline import / export | todo |
| C27 | 6 A11y+AI | One-click accessibility fixes in the checker | todo |
| C28 | 6 A11y+AI | Slide titles auto-derived from the title placeholder | todo |
| C29 | 6 A11y+AI | AI chart descriptions | todo |
| C30 | 6 A11y+AI | Magic Switch wiring (deck to doc/social/poster) | todo |
| C31 | 6 A11y+AI | Clarifying-questions interview before thin-brief generation | todo |
| C32 | 6 A11y+AI | Critique-and-improve loop with per-issue apply | todo |
| C33 | 6 A11y+AI | Citations from web research into slides | todo |
| C34 | 6 A11y+AI | Reference-image style transfer to a theme | todo |
| C35 | 7 Collab+Share | Per-slide status and assignees (board view) | todo |
| C36 | 7 Collab+Share | Named share links + per-link analytics | todo |
| C37 | 7 Collab+Share | Public embeddable deck player | todo |
| C38 | 7 Collab+Share | Reuse slides from another deck (theme-matched) | todo |

Dependencies: C02 before C03/C04 (one schema bump, then UI); C17 before C18 and C20 (captions feed both); C06 before C07/C08/C09/C10; C12 before C11 (channel plumbing first); C36 before C37 (links carry the embed surface).

Deferred (documented, deliberately not tasks): Prezi-style zoomable canvas and 3D/cinematic transitions (blocked on the WebGL/WebGPU engine path, itself an engine-roadmap item); present-to-video-call integration (external platform APIs); AI voice/TTS/avatar narration and per-slide voiceover binding (AI media pipeline roadmap); camera-as-schema-node (after the recording pipeline matures); publish-as-website/custom domain (overlaps F34); rich-text speaker notes, table/data autoflow, SmartArt-style bullets-to-graphic, transition easing curve EDITOR (beyond the preset set), multipresenter beyond hand-off (P3 or architectural; revisit when the board above is done).

## Phase 1: Hardening and transition polish

### C01: Archive-bomb guards on the client zip reader (P0)

- Today: `@hc/export` `unzip.ts` inflates untrusted archives (.pptx import) with no entry-count or decompressed-size caps; a crafted bomb can exhaust the importing tab's memory. Closes the remaining half of the spec's "Untrusted PPTX/embed import sandboxing + SSRF" row.
- Do: cap entry count, per-entry decompressed size, and TOTAL decompressed size in `unzip.ts` (reject with a clear error, never truncate silently); same caps in the deflate path. Surface the rejection as a friendly import error.
- Accept: a zip with 100k entries or a 10 GB-expanding entry is refused instantly with a readable message; every existing import test still passes.
- Verify: new bomb-fixture tests in `packages/export`; full battery.

### C02: Per-transition easing control (schema v22)

- Today: transition easing is hardwired ease-in-out in the compositor path. Spec row "Per-transition easing / curve control".
- Do: claim v22 in `docs/roadmap/README.md`; add OPTIONAL `PageTransition.easing` as a plain string (never z.enum, so future values cannot break older clients; the engine clamps unknown values to the default), bump both schema mirrors + migration + history + version-pin tests; present mode and the export planner evaluate the easing (reuse the animation easing evaluator: linear, ease-in, ease-out, ease-in-out); a small easing select in `PageTransitionSection`.
- Accept: a slide set to linear visibly cuts at constant speed; an old file with no easing behaves exactly as before.
- Verify: engine easing tests; schema round-trip; full battery.

### C03: Exit / asymmetric transitions (same v22 bump)

- Today: `Page.transition` plays on ARRIVAL only. Spec row "Exit / asymmetric transitions".
- Do: add OPTIONAL `Page.transitionOut` (same `PageTransition` shape, part of the same v22 bump as C02); when navigating A to B with A.transitionOut set, the compositor animates A out per ITS type while B animates in per B.transition, over one duration (two-layer composite in `@hc/engine` `transition.ts`, pure + tested); present mode, the deck player, animated export, and the audience stage all consume the same helper; UI: an "exit" select in `PageTransitionSection`.
- Accept: A set to fade-out + B set to slide-in composites both simultaneously; decks with no transitionOut are pixel-identical to today.
- Verify: pure compositor tests (both-set, only-enter, only-exit); full battery.

### C04: Transition picker gallery with live preview swatches

- Today: `PageTransitionSection` is a bare select. Spec row "Transition picker UX".
- Do: a swatch grid (one tile per transition type) with a miniature two-frame preview per tile that animates on hover/focus using the SAME engine compositor into a small canvas, so the preview cannot lie; keyboard accessible (radiogroup), honors reduced motion (static swatch).
- Accept: hovering a tile plays its transition in miniature; picking works by keyboard; reduced-motion users get static tiles.
- Verify: component renders in tests; manual run.

### C05: Animate-all-slides bulk action

- Today: transition apply-to-all shipped; there is no bulk animation op. Spec row "Apply transition / animation to all slides" (the animation half).
- Do: store action `magicAnimateAllPages()` running the existing per-page magic-animate across every slide inside ONE undo turn (`runAsTurn`); a button next to the existing apply-transition-to-all; slides whose nodes already carry animations are skipped unless a "replace existing" toggle is set.
- Accept: one click animates a 10-slide deck; one Ctrl+Z reverts all of it; existing animations survive by default.
- Verify: store test (bulk + one-undo + skip rule); full battery.

## Phase 2: Magic Move depth

### C06: Nested / grouped element morph matching (P1)

- Today: morph matches top-level children only (`transition.ts` `morphPlan`, id then unique-name). Spec row "Nested / grouped element morph matching".
- Do: recursive matching through group/frame children with ABSOLUTE (accumulated) transforms on both sides, so a node moving into or out of a group still morphs; matched pairs keep the existing lerp path.
- Accept: a shape inside a group on slide A morphs to the same-id shape at top level on slide B; existing top-level morphs unchanged.
- Verify: morphPlan tests with nested fixtures; full battery.

### C07: Per-element morph easing

- Today: morph interpolation is strictly linear (`lerpNode`). Spec rows "Eased / spring per-element morph".
- Do: apply the transition's easing (C02) to morph progress, and support an optional per-node easing override via `NodeAnimation` where present; spring maps to the existing deterministic spring evaluator.
- Accept: a morph under ease-in-out visibly accelerates/decelerates; linear remains available.
- Verify: pure lerp/easing tests; full battery.

### C08: Fill / stroke / color / radius morph tween

- Today: morph lerps transform+size+opacity; appearance snaps from the destination. Spec row "Shape / path / fill / gradient / color morph" (the color/fill half; path morphing stays out).
- Do: tween solid fill colors, gradient stop colors (matched by index when stop counts agree, else snap), stroke color/width, and corner radius between matched nodes in `lerpNode`.
- Accept: a red rect morphing to a blue rounded rect animates color and radius smoothly; mismatched gradient shapes fall back to today's snap.
- Verify: lerpNode tests per property; full battery.

### C09: Forced-match naming convention

- Today: matching is automatic by id, then unique name. Spec row "Forced-match naming convention".
- Do: nodes whose names share a `!!token` prefix pair-match across slides regardless of id (documented in the morph help text), taking precedence over automatic matching; collisions (two `!!x` on one side) fall back to automatic.
- Accept: renaming two different-id shapes `!!logo` morphs them; removing the prefix restores automatic behavior.
- Verify: morphPlan precedence tests; full battery.

### C10: Word-level text morph

- Today: no text-content morphing. Spec row "Text glyph-level morph", honestly scoped: word-level position morph, glyph-level explicitly documented as out of scope.
- Do: for matched TEXT nodes, diff words; words present on both sides animate from their measured old line/offset position to the new one (measurement via the shared text layout), added words fade in, removed fade out. Cap at a sane word count; beyond it, fall back to today's crossfade.
- Accept: a headline reordering three words slides the common words; a paragraph rewrite crossfades.
- Verify: word-diff + position tests; manual run.

## Phase 3: Animation depth

### C11: Motion paths

- Spec row "Motion paths (follow a curve, orient-to-path)". Add an optional path (list of points, additive schema field on `AnimationClip` under the v-bump this phase claims) sampled with the existing easing; optional orient-to-path; editor draws the path as an overlay when the clip is selected. Verify with pure sampling tests.

### C12: Color and size keyframe channels

- Spec row "Custom keyframe channels". Additive optional `color`/`width`/`height` values on `Keyframe`; engine pose applies them; keyframe editor exposes them. Skew/filter stay out (documented).

### C13: Configurable spring physics

- Spec row "Configurable spring physics". Additive optional stiffness/damping on the spring easing, mapped to the existing omega/zeta evaluator with today's values as defaults.

### C14: Animation painter

- Spec row "Animation Painter". Copy the selected node's animation (entrance/emphasis/exit/keyframes) and paste onto other selections; pure store action, one undo step per paste.

### C15: Animation triggers tied to media timestamps

- Spec row "Animation triggers tied to media bookmarks". Additive optional trigger `{mediaNodeId, atMs}` on `NodeAnimation`; present runtime listens to the media element's timeupdate and fires the entrance. NEW optional field, never an enum widening.

## Phase 4: Present interactivity and delivery

### C16: Element interaction actions: play media, run animation (P1)

- Spec row "Element interactions". CAUTION: `InteractionAction` is an existing enum; widening it breaks older clients. Add a NEW optional field (e.g. `Interaction.actionV2` as a plain string) carrying the new actions; old clients preserve it via unknown keys and simply do not respond. Present runtime handles play/pause media and run-animation-by-node.

### C17: Live captions overlay (P1)

- Spec row "Live captions / subtitles". Local SpeechRecognition (feature-detected; a clear notice where unsupported), rendering a caption band over the slide and mirrored to the audience window via the existing BroadcastChannel; nothing leaves the machine; toggle in the present toolbar.

### C18: Translated captions

- Spec row "Real-time translated captions". Caption chunks batch through the existing BYO-key translate path (target language picker), throttled and sequence-tagged so late replies never regress the band; degrades to untranslated captions on provider failure.

### C19: Kiosk / links-only navigation mode

- Spec row "Hyperlink-only / interactive kiosk navigation mode". A present option (and share-link flag) that disables linear advance; only interactions navigate. Escape still exits for the owner.

### C20: Speaker coach (P1)

- Spec row "Speaker coach". Rehearsal mode analysis from the same local speech stream as C17: words-per-minute pacing bands, filler-word counts, long-pause detection, a per-rehearsal report; entirely client-side.

### C21: Phone-as-remote pairing

- Spec row "Phone-as-remote". A short-lived pairing code shown in present mode; the phone page (share-token scoped) sends next/prev/blank over the existing `/realtime` relay; presenter honors only its paired session.

### C22: Co-presenter control hand-off

- Spec row "Multipresenter / co-presenter control hand-off". A control token in the presence protocol: the current holder advances slides; hand-off passes it explicitly; the audience window and slide-follow honor whoever holds it.

## Phase 5: Scale and interop

### C23: Present prefetch (P1)

- Spec row "60fps present + prefetch/precompute next slide". Pre-render the NEXT slide's scene (and preload its images/fonts) while the current slide idles, so advancing never pays a first-paint stall; measure and log the present frame budget in dev builds.

### C24: Large-deck PagesBar virtualization

- Spec row "Large-deck handling". Virtualize the PagesBar list (render only the visible window of thumbnails plus overscan) and defer engine thumbnail renders offscreen; a 300-slide deck must scroll smoothly.

### C25: ODP import (P1)

- Spec row "Keynote / Google Slides / ODP import". Parse ODP (content.xml: frames, text, images, fills) into the design model client-side like pptximport; Keynote/Slides documented as import-via-PPTX in the import dialog help.

### C26: Markdown outline import / export

- Spec rows "Markdown / Marp / Slidev / reveal.js import-export" + "Outline import/export", honestly scoped: deterministic markdown-outline-to-deck seed (headings to slides, lists to content) and deck-to-markdown-outline export. Marp/Slidev/reveal stay out (documented).

## Phase 6: Accessibility and AI completion

### C27: One-click accessibility fixes (P1)

- Spec row "In-canvas WCAG 2.2 AA checker ... with one-click fixes". Per-issue fix actions in the dialog: contrast issues get the existing fix-to-AA color nudge applied to the offending run/fill; missing alt gets the AI describe flow inline; reading-order issues get "adopt visual order". Each fix is one undo step.

### C28: Slide titles auto-derived from the title placeholder

- Spec row "Slide titles for screen-reader navigation" (the enforcement half). When a page's layout has a title placeholder with text, keep `Page.name` in sync with it (explicit user renames win and stop the sync for that page).

### C29: AI chart descriptions

- Spec row "AI alt-text / chart descriptions" (the chart half). Describe a chart node from its DATA (categories/series/values through the existing text model), not vision, writing altText; surfaced next to the image alt generation.

### C30: Magic Switch wiring

- Spec row "Magic Switch". `deriveOutline`/`switchOutline` exist with zero callers: wire an assistant tool + panel action that re-shapes the current deck into doc/social/poster via the existing generation pipeline, appended never replacing.

### C31: Clarifying-questions interview

- Spec row "Clarifying-questions deck builder". When a generation brief is thin (short, no attachments), the assistant asks up to 3 clarifying questions FIRST (existing clarify mechanism, made proactive for generateDesign), then generates with the answers folded into the brief. A "just generate" escape always shown.

### C32: Critique-and-improve loop

- Spec row "Critique-and-improve". Critique output becomes a structured issue list with per-issue apply buttons mapping to existing fixers (harmonize, tidy, fix-to-AA, brand fixes); each apply is one undo step; a re-critique confirms.

### C33: Citations from web research into slides

- Spec row "Web-research deck agent with citations" (the citations half). When webSearch grounded a generation, append a Sources slide (title + per-source name/URL) and per-slide source superscripts where the outline used a source; sources stored in page meta so they survive edits.

### C34: Reference-image style transfer

- Spec row "Reference-image style transfer". From a dropped reference image: palette via the existing extractPalette, font-feel via one vision call (serif/sans, weight character) mapped to the theme font allowlist, produced as a THEME (T19 record) behind a confirm step.

## Phase 7: Collaboration and sharing

### C35: Per-slide status and assignees

- Spec row "Slide-level status / assignees". Additive per-page status/assignee (page meta or a small table via comments infrastructure), a board-style overview panel grouping slides by status, and status pills in the PagesBar.

### C36: Named share links + per-link analytics

- Spec row "Multiple per-audience tracked links". Add a label to share links (additive column) and record the LINK id in shared view beats so per-link analytics render in the insights panel.

### C37: Public embeddable deck player

- Spec row "Public iframe / web embed". An embed-safe player route for a share link (no chrome, postMessage-friendly sizing) plus a copy-embed-snippet action in the share dialog; honors link modes/passcodes/expiry.

### C38: Reuse slides from another deck

- Spec row "Reuse slides / slide library". A picker listing the workspace's other decks and their slide thumbnails; inserting copies pages (id-regenerated, assets carried) and optionally theme-matches them to the destination via the T19 exact-slot restyle.
