# F43: Procedural and real-time motion graphics

| Field | Value |
| --- | --- |
| Feature ID | F43 |
| Phase | 5 Creation depth |
| Sequence | 43 |
| Status | Not started |
| Depends on | F40 (procedural node graph: the parameter addressing and evaluation model this spec animates, `40-procedural-node-graph.md`), F44 (GPU rendering path, `44-gpu-rendering.md`), F41 (vector authoring: the path/point parameters worth animating, `41-vector-authoring.md`), F16 (realtime/CRDT: how animation edits merge), F23 (AI media: audio assets that drive motion), F38 (accessibility/i18n/NFR: reduced motion, keyboard model), `@hc/schema` (open file format + forward migration), `@hc/engine` (pure playback core `animation.ts`/`pose.ts`/`buildorder.ts`/`transition.ts`/`deck.ts`), `@hc/timeline` (the video-document clip model this spec deliberately does not extend) |

Motion in HyCanvas today is a slide-delivery feature: a node carries a preset entrance, exit, emphasis, or a five-channel keyframe track, and the pure `@hc/engine` playback core renders it identically in editor preview, present mode, animated export, and the Go headless MP4 path. That is a real and unusual foundation, and this spec does not rebuild it. What it adds is the other half of a motion-graphics tool: any parameter animatable rather than five transform channels, a real timeline and editable curve editor on the design document itself, onion skinning for frame-by-frame work, and above all motion that is GENERATED rather than hand-keyed, where a parameter is bound to another parameter, to time, to a seeded noise or oscillator, to a baked audio envelope, or to a small deterministic expression, and where an instanced or repeated set of elements staggers from one rule. It also makes the output real-time and interactive: triggers, state machines for interactive components, a published playback runtime, and animated SVG / Lottie vector export alongside the existing video, GIF, and APNG paths. The whole thing is free, self-hostable, and runs on the open file format, so a motion document is editable data rather than a rendered artifact.

## Current state

Audited against the code: `packages/schema/src/schema.ts` (`Easing` 363, `EntrancePreset`/`ExitPreset`/`EmphasisPreset` 366-368, `AnimationStartMode` 379, `AnimationClip` 381, `Keyframe` 408, `KeyframeTrack` 429, `NodeAnimation` 443, `InteractionAction`/`Interaction` 458-480, `PageTransition` 483, `ImageMotion` 495, `NodeBase.hidden`, `UnknownNode` 1708, `CURRENT_SCHEMA_VERSION = 17`) + `migrate.ts`; `packages/engine/src/animation.ts` (`AnimPatch` 21, `IDENTITY_PATCH`, `evalEasing`, `cubicBezierEase`, `clipEase`, `entrancePatch`, `entranceProgress`, `exitPatch`, `emphasisPatch`, `clipEnd`, `customPatch`, `customTrackEnd`, `appliedOpacity`, `transitionProgress`, `imageMotionPatch`); `packages/engine/src/pose.ts` (`revealEntranceText`, `sequenceStarts`, `pageAnimationDuration`, `poseDesignAt`); `packages/engine/src/buildorder.ts` (`BuildStep`, `BuildPlan`, `planBuildOrder`, `childIndexForBuildOrder`, `startModeLabel`); `packages/engine/src/transition.ts` (`renderTransition`, `MorphPlan`, `morphPlan`, `lerpNode`, `morphDesignAt`, `morphHiddenIds`); `packages/engine/src/deck.ts` (`planDeckFrames`, `SlideFrame`, `DeckTransitionFrame`, `slideDurationMs`, `planDurationMs`, `DeckPlanOptions.reducedMotion`); `packages/engine/src/{spatial,tiles,viewport,render2d}.ts`; `packages/export/src/{lottie,apng,gif,svg}.ts` (`designPageToLottie` 165); `packages/timeline/src/{model,time,edit,transitions,nest,snap,scenes}.ts` (`Clip`, `Clip.element`, `Clip.keyframes`, its own `KeyframeTrack {property, keyframes:[{frame,value,easing}]}` 92); `frontend/src/components/editor/{PropertiesPanel,BuildOrderSection,PresentMode,ExportDialog,VideoSurface}.tsx` (`KeyframeEditor` 2065, `AnimateSection` 2134 in PropertiesPanel); `frontend/src/lib/video/{compositor,playback,deckToVideo}.ts` (`evalKeyframes`, `evalProperty`); `frontend/src/store/editor.ts` (`setNodeAnimation` 3348, `magicAnimatePage` 3359, `setNodeKeyframes` 3382, `playAnimations` 3526); backend `internal/render/anim.go` (`animPatch`, `evalEasing`, `cubicBezierEase`, `animClip`, `entrancePatch`, `exitPatch`, `emphasisPatch`, `imageMotionPatch`, `composePatch`, `parseClip`, `NodeIsAnimated`, `applyPatchToNode`, `PoseElementNode`), `internal/render/{timeline,video,raster}.go`, `internal/render/anim_test.go` (`TestEvalEasingParity`), `internal/persistence/file.go` (`currentSchemaVersion`), `internal/crdt/fold.go` (goja).

What genuinely ships. A node's motion is a typed `NodeAnimation` with four optional slots (entrance, exit, emphasis, a custom `KeyframeTrack`), 11 entrance / 6 exit / 8 emphasis presets, 9 named easings plus a freeform CSS-style cubic bezier per clip, and three cross-element start modes. One pure, framework-free core computes it: `animation.ts` returns an `AnimPatch` (`dx`, `dy`, `scale`, `rotate`, `opacityMul`) for a clip at time `t`, `pose.ts` `poseDesignAt(file, pageIndex, tMs)` composes the patches for a whole page into a posed copy of the document, and `buildorder.ts` `planBuildOrder` projects the playback order that `sequenceStarts` actually uses. That one core drives editor Play (`playAnimations`), present mode, the deck frame planner (`deck.ts` `planDeckFrames`, which already honors `reducedMotion`), APNG/GIF export, and Lottie export. Lottie export is real and shipped (`designPageToLottie`, surfaced in `ExportDialog` as a format), sampling the same engine math into baked Lottie keyframes. `transition.ts` is a pure, exportable transition compositor including id-then-name matched Magic Move (`morphPlan`/`lerpNode`/`morphDesignAt`). Server-side, `backend/internal/render/anim.go` is a hand-written Go port of the same math that poses element nodes per output frame for the ffmpeg MP4 path, and `timeline.go`/`video.go` stage the results. Authoring UI exists in two places: `AnimateSection` (preset, duration, delay, easing, bezier toggle) plus `KeyframeEditor` (a one-line dot strip with numeric fields for t / dx / dy / scale / rotate / opacity / easing) in the design editor's `PropertiesPanel`, and `BuildOrderSection`, a page-level strip of every animated element in playback order, draggable to reorder. The video editor is a separate and much deeper timeline (`VideoSurface.tsx`, ~8.5k lines) over `@hc/timeline`, with its own per-clip keyframe model (`Clip.keyframes`, property/value/frame) evaluated by `frontend/src/lib/video/compositor.ts` `evalKeyframes`, and with element clips (`Clip.element`) that embed a schema `Node` and pose it through the SAME engine poser in preview, exact export, and the Go MP4 path.

What is missing for design documents, honestly. There is no document timeline: `KeyframeEditor` is a property-panel widget with one lane, no playhead, no scrubbing, no time ruler, no multi-element view, and no curve editor at all (the bezier is four numeric inputs). There is no graph/curve editor anywhere in the product, and no keyframe evaluator supports per-key tangents: both `customPatch` and the video editor's `evalKeyframes` interpolate linearly between keys with one named easing per segment. The video editor's own keyframe lane (`VideoSurface.tsx` `KeyframeRows`) is a text list limited to five properties and four easings, and that file's header states outright that keyframe property lanes are deferred pending an animation UI. There is no onion skinning (zero hits repo-wide). The animatable surface is exactly five channels: `AnimPatch` is `{dx, dy, scale, rotate, opacityMul}` and `Keyframe` mirrors it, so fill, stroke, size, corner radius, blur, text content, path geometry, and every graph parameter are unreachable. There are no drivers of any kind: no parameter-to-parameter binding, no time driver, no expressions (grep finds none), no seeded noise (no perlin/simplex/value-noise anywhere), no oscillators, and no stagger primitive beyond `magicAnimatePage` writing increasing literal `delayMs` values. "wiggle" exists only as a fixed emphasis preset (`6 * sin(p * TAU)` degrees, identical in `animation.ts` and `anim.go`), not as a seeded noise source. Interactivity stops at `Interaction {trigger: "click"|"hover", action: none|navigate|open-link}` consumed only by present mode; there are no state machines, no scroll or view triggers, and no real-time interactive runtime outside the deck player. Animated SVG (SMIL) export does not exist and Lottie is export-only, with each node exported as a coloured rectangle proxy rather than its real geometry. Determinism between the two evaluators is maintained BY HAND: `anim.go`'s header comment says "keep these formulas byte-for-byte aligned with the TypeScript", and the only cross-language check is `TestEvalEasingParity`, six hardcoded easing values plus boundary invariants, with no shared golden corpus. The Go port is already knowingly behind: `video-design-mode.md` P4.2 records that custom keyframe tracks and typewriter/word-wipe reveals are honored in the browser but NOT in `anim.go`, so a node carrying one renders its transform but not its content reveal server-side. The two sides have already diverged in the other direction too: `poseDesignAt` never applies an exit clip, while the Go `PoseElementNode` applies one over the clip tail. That drift is the single biggest technical risk this spec inherits.

Three further facts shape the design. First, the product already carries THREE incompatible easing vocabularies (`@hc/schema` `Easing`, nine named curves plus an optional bezier tuple; `@hc/timeline` `type Easing = string`, opaque; and `frontend/src/lib/video/compositor.ts` `applyEasing`, three names) and TWO different types both named `KeyframeTrack` (the schema's ms-based five-channel track, and `@hc/timeline`'s frame-based `{property, value: unknown}` track). Adding a third model without a plan for the evaluator would be indefensible; section 18 states the plan. Second, reduced motion is handled by three uncoordinated mechanisms (a global CSS rule that only reaches app chrome, the opt-in `DeckPlanOptions.reducedMotion` flag which skips transitions but not element animation, and direct `matchMedia` reads in `PresentMode.tsx` and `ExportDialog.tsx`), and the shared web player and second-display surfaces honor none of them. Third, `@hc/a11y` contains no motion code at all, so every motion-safety check in section 12 is new.

Status legend: **Built** (ships today, code-referenced), **Partial** (some of it ships, gaps noted), **Planned (doc 40)** (depends on the F40 parameter/evaluation model), **Not started**.

## Sequencing

**F38 (accessibility, i18n, security, compliance, self-host, NFR) precedes this spec.** That ordering was set in August 2026 on adoption evidence: internationalisation and accessibility show more evidence of blocking adoption than creative depth does, and both are axes a desktop-native incumbent cannot follow the product onto. The reasoning is recorded in `README.md` under "Why F38 precedes the creation-depth set" and in F38's own Priority section.

This does not reduce the value of the work below; it places it second, and it means the parts worth pulling forward early are the ones that serve the existing audience. For motion that is the SEQUENCING tier (per-element order, duration, delay, trigger, and reliable animated export with alpha), which is where measured demand stops. The timeline, curve editor, drivers, and expressions serve motion designers, and a cautionary case exists of a mainstream tool harming its core audience by retrofitting a professional timeline.

## 1. Context and Goal

Professional motion tooling splits into three camps and HyCanvas sits in none of them. Compositors and motion-design suites give deep keyframing, a graph editor, expressions, and procedural noise, but they are desktop applications that produce rendered video and a proprietary project file. Vector-animation runtimes give small, scalable, interactive output that ships inside real products, but authoring is either a plugin on top of a compositor or a separate tool with its own closed format. Web design tools give scroll and hover motion, but only over their own DOM output, not over a design document, and nothing they produce is editable outside the tool. Across all three, the thing that separates a motion designer from an animator is procedural control: a wiggle expression, an oscillator, an offset applied across 200 instances, a parameter driven by another parameter, so a change to one number restyles the whole motion instead of forcing a re-key of every element.

HyCanvas's opening is structural and specific. The playback core is already pure, framework-free, and shared by the browser, the worker, and a headless server renderer, which is precisely the property a procedural motion system needs and which no incumbent offers for free on a self-hostable stack. The open file format already round-trips unknown node types losslessly through `UnknownNode.raw`, which gives a zero-data-loss path for a rich motion payload. F40 is building the parameter addressing and non-destructive evaluation model that a driver system needs, so this spec animates F40's parameters instead of inventing a parallel one. And the deliverables at the end (an editable Lottie, an animated SVG, an interactive published page, an MP4) are all things the product already knows how to emit or serve.

Intended outcome: a designer opens a design document, adds a timeline, keys a shape's corner radius and gradient stop alongside its position, shapes the motion on a real curve editor, binds a headline's rotation to a seeded wiggle and a background's scale to the low band of the soundtrack, applies a 40ms stagger across 200 instanced dots generated by the procedural graph, wires a button component's hover and click states as a state machine, previews the whole thing at 60fps while scrubbing, publishes it as an interactive page that honors `prefers-reduced-motion`, exports the same document as a Lottie an engineer drops into an app and as an MP4 rendered on the server, and gets frame-identical results from every one of those paths, on their own instance, ungated.

## 2. Scope

In scope:
- Parametric animation of any addressable parameter (node properties, style/fill/effect values, text content, path geometry, and F40 graph parameters), not the current five transform channels.
- A design-document timeline panel: playhead, time ruler, per-target lanes, keyframes, an editable bezier curve / graph editor over value-versus-time, and keyframe workflows (insert, move, scale, copy, retime, hold).
- Onion skinning for frame-by-frame work, on the design canvas.
- Drivers and expressions: parameter-to-parameter binding, time drivers, a restricted deterministic expression language, and baked audio-amplitude envelopes.
- Hardware control surfaces (MIDI) as an AUTHORING input: knobs and faders drive parameters live while you work, and a performance can be recorded into a channel. What lands in the document is always baked data, never a live device binding.
- Procedural motion: seeded noise and wiggle, oscillators, stagger/offset across instanced or repeated elements, and motion sourced from the F40 procedural graph.
- Interactive and real-time output: triggers (click, hover, view-enter, scroll, state, time), state machines for interactive components, a real-time playback runtime, and a published interactive document served through the existing sharing/publishing path.
- Export and import: animated SVG (SMIL and a CSS/WAAPI variant), a real Lottie exporter (upgrading the shipped rectangle-proxy exporter) and a Lottie importer, plus reuse of the existing video/GIF/APNG paths.
- Determinism and parity engineering: one evaluation core specified once, implemented twice (TypeScript and Go), with a shared golden-vector corpus that both test suites run.
- Playback performance for authoring: interactive-rate preview and scrubbing, incremental evaluation, and long-timeline handling.

Out of scope (owned elsewhere):
- The video editor and the `@hc/timeline` clip model. The footage/clip timeline, its scenes, transitions, trimming, audio mixing, and its per-clip `Clip.keyframes` property model are complete and tracked in `video-editor-backlog.md` and `video-design-mode.md`. This spec does not re-specify, replace, or migrate any of it. The one interface it defines is that a schema node animated by this spec keeps animating when it is embedded as a `Clip.element`, because both paths already call the same engine poser.
- Slide transitions, present-mode delivery, Magic Move, and the deck frame planner (F28 owns `transition.ts`, `deck.ts`, and `PresentMode.tsx`; this spec consumes them unchanged).
- The parameter model, parameter addressing, non-destructive operator stack, and the evaluation engine itself (F40 owns these; this spec animates them and must not build a second evaluator).
- The GPU/WebGL/WebGPU backend and worker render offload (F44; this spec states the evaluation contract that rides on it and keeps Canvas2D as the always-available fallback).
- Vector authoring primitives, path effects, and booleans (F41; this spec animates their parameters).
- Audio/video generation, TTS, and captions (F23; this spec consumes an audio asset's baked amplitude envelope).
- The CRDT protocol, presence, and locks (F16; this spec adds the animation-specific merge and ephemerality rules that ride on it).
- Cross-cutting SSO/observability/compliance/self-host NFR (F38; this spec adds the reduced-motion and keyboard-timeline requirements that hook into it).

Deferred:
- Physics simulation (rigid bodies, cloth, particles, collisions). A deterministic cross-language solver is a much larger commitment than a deterministic expression evaluator; revisit after the parity harness proves itself.
- 3D, cameras, and depth. The engine is 2D by design.
- Rigging: bones, inverse kinematics, mesh/puppet deformation. Depends on F41 mesh work landing first.
- Live audio-reactive input (microphone or stream). Deferred because it cannot be reproduced by a headless render; only baked envelopes ship (see FR-16).
- A general scripting API beyond the expression language (a document-level script host has a fundamentally different security and determinism story).
- Interop with proprietary interactive-animation runtimes beyond Lottie.

## 3. User Stories

- As a motion designer, I want to keyframe any property, not just position and opacity, so a fill colour, a corner radius, a blur, and a path point can all animate on one timeline.
- As a motion designer, I want a real curve editor with draggable bezier handles over value-versus-time, so I can shape ease and overshoot instead of typing four numbers.
- As an animator, I want onion skinning with configurable before/after frames and tint, so frame-by-frame work is possible on the canvas.
- As a motion designer, I want to bind one parameter to another (a shadow's offset to a light's angle) so the whole composition stays coherent when I change one value.
- As a motion designer, I want seeded wiggle and oscillators so idle motion looks organic without keying 40 frames by hand, and I want the same seed to give the same motion on the server render.
- As a motion designer, I want to stagger an animation across 200 procedurally instanced elements with one offset value and an ordering rule, so mass motion is a parameter, not 200 delays.
- As a product designer, I want to author a button or toggle as a state machine with hover, press, and disabled states and real transitions between them, so the motion spec I hand to engineering is the artifact, not a description of one.
- As an engineer, I want to receive a Lottie or an animated SVG that renders the real geometry, not a rectangle proxy, so I can ship the designer's motion without rebuilding it.
- As a marketer, I want to publish an interactive animated page from a design document with scroll and hover triggers, on our own instance, with no watermark.
- As a motion-sensitive user, I want every published animation to respect my reduced-motion setting without the author being able to override it.
- As a screen-reader and keyboard user, I want to drive the playhead, step frames, and add and edit keyframes without a mouse.
- As a self-hoster, I want the server MP4 of my animation to be frame-identical to what I previewed, including noise and expressions, or to fail loudly instead of quietly rendering something else.

## 4. Feature matrix / scope

The heart of this spec. Status values: **Built**, **Partial**, **Planned (doc 40)**, **Not started**. Priorities: P0 blocks the wedge, P1 is core, P2 is depth, P3 is polish.

### Parameter animation and the channel model

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Preset clip animation (entrance / exit / emphasis) | Built | `engine/src/animation.ts` `entrancePatch`/`exitPatch`/`emphasisPatch`; `schema.ts` `NodeAnimation` 443 | 11/6/8 presets, 9 easings, freeform bezier per clip. Stays as the preset layer over the new channel model; not replaced. |
| Per-element custom keyframe track | Built | `animation.ts` `customPatch`; `schema.ts` `KeyframeTrack` 429 | Five channels only (`dx`/`dy`/`scale`/`rotate`/`opacity`), one track per node, optional loop. |
| Animate ANY addressable parameter | Not started | n/a | P0. Channels target an F40 parameter reference (node property, style/fill/effect slot, path point, graph parameter). Requires the sparse `ParamPatch` pass in section 7, composed after the existing five-channel `AnimPatch` so the hot path is untouched. |
| Colour / gradient-stop channels | Not started | n/a | P0. Interpolation in a documented space (OKLab via `@hc/color`) so browser and Go agree; `Color` carries optional cmyk/spot, which are interpolated separately or held (open question). |
| Size / geometry / path-point channels | Not started | n/a | P1. Depends on F41 for the anchor model; point-count mismatches resolve by a documented pairing rule, never by silent truncation. |
| Text content / counter channels | Not started | n/a | P2. Extends the shipped `revealEntranceText` reveal machinery from typewriter/word-wipe to arbitrary string and numeric counters. |
| Effect / filter channels (blur, shadow, opacity per effect) | Not started | n/a | P1. Trivially expressible as parameters once F40's addressing lands. |
| Multiple channels and layered tracks per node | Not started | n/a | P1. Today one `custom` track per node; the channel table is a per-page list keyed by target, so a node can carry any number. |
| Rest-pose invariant (t=0 mirrored into the static value) | Not started | n/a | P0. The zero-data-loss mechanism: an older client with no timeline renders the static parameters, which the authoring client keeps equal to the frame-0 evaluation. See FR-25 and AC-3. |

### Timeline panel and curve editing

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Page-level build-order strip | Built | `engine/src/buildorder.ts` `planBuildOrder`; `BuildOrderSection.tsx` | Every animated element in playback order, draggable to reorder, projected from the same `sequenceStarts` present mode uses. The seed the timeline panel grows out of; the strip stays as the simple view. |
| Single-lane keyframe widget | Partial | `PropertiesPanel.tsx` `KeyframeEditor` 2065 | A dot strip plus numeric fields. No playhead, no ruler, no scrub, no zoom, no multi-target view, no curves. |
| Design-document timeline panel (ruler, playhead, lanes, zoom) | Not started | n/a | P0. Docked panel on the design surface, lanes grouped by node then by channel, time in ms with a frame grid at the document fps. |
| Scrubbing and transport (play/pause/loop, frame step, in/out range) | Partial | `store/editor.ts` `playAnimations` 3526 | Play preview exists as a fire-and-forget page playthrough; there is no scrub, no seek, no loop range, no frame stepping. P0. |
| Graph / curve editor (value versus time, bezier handles) | Not started | n/a | P0. Draggable in/out tangents per keyframe, multi-channel overlay, value-axis normalization, box-select, and numeric handle entry. The shipped four-number bezier field is the fallback. |
| Keyframe workflows (insert, move, box-select, copy, scale/retime, hold) | Not started | n/a | P0. Time-scaling a selection retimes proportionally; hold produces a step interpolation. |
| Snapping (to frame grid, playhead, markers, other keys) | Not started | n/a | P1. The video timeline's snap semantics (`@hc/timeline` `snap.ts`) are the reference for behaviour, not the code to reuse (different unit model). |
| Markers, labels, and named time ranges | Not started | n/a | P2. Also the anchor for trigger authoring and for export range selection. |
| Timeline virtualization for long documents | Not started | n/a | P1. Render by visible time range, never by frame; see section 10. |

### Frame-by-frame and onion skinning

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Onion skinning (N before / M after, tint, opacity falloff) | Not started | n/a | P1. Zero occurrences of "onion" in the repo today. Renders posed copies of the document at neighbouring frames beneath the live frame in the canvas overlay layer. |
| Onion skin scoping (selection only, or whole page) | Not started | n/a | P1. Whole-page onion skins at 60fps are unaffordable on a heavy document; selection scoping is the default. |
| Frame-by-frame hold/step interpolation | Not started | n/a | P1. A `hold` interpolation on a keyframe plus a step-to-next-key transport action. |
| Drawn frame sequences (a node whose content is a frame list) | Not started | n/a | P2. Depends on F42 raster/painting for the drawing surface. |
| Ghost trails / motion trail visualization | Not started | n/a | P3. A path preview of an animated node's position across the timeline, drawn in the overlay. |

### Drivers, expressions, and procedural motion

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Parameter-to-parameter driver | Planned (doc 40) | n/a | P0. A directed binding from a source parameter to a target parameter with an optional range remap. The graph is the F40 evaluation graph; this adds time-varying sources to it. |
| Time driver | Not started | n/a | P0. Target = f(time), with scale and offset; the primitive every other procedural source composes with. |
| Expression driver (restricted deterministic language) | Not started | n/a | P0. NOT JavaScript. Pure, side-effect free, no property access, no loops, an allowlisted function set, compiled to an AST evaluated by twin TS and Go interpreters. Bounded per section 11. |
| Seeded noise / wiggle | Not started | n/a | P0. Integer-hash value noise with fractal octaves, specified bit-exactly and evaluated with the same operations in both languages. The shipped `wiggle` emphasis preset is a fixed `6*sin` rotation and is NOT this. |
| Oscillators (sine, triangle, square, saw) with frequency/phase/amplitude | Not started | n/a | P1. Cheap, deterministic, and the second most-requested procedural source after wiggle. |
| Stagger / offset across instanced or repeated elements | Not started | n/a | P0. One rule (step ms, ordering by index, spatial distance from a point, or seeded shuffle) applied over a set. `magicAnimatePage` writing literal increasing `delayMs` is the crude precedent and stays for presets. |
| Motion from the procedural graph | Planned (doc 40) | n/a | P1. A graph output feeds a channel target; an instancer's per-instance index and position are the stagger ordering inputs. Requires F40's instancing to exist. |
| Baked audio-amplitude envelope driver | Not started | n/a | P1. Amplitude is analysed once at bind time into a quantized, versioned envelope stored with the document; both the browser and the server read the SAME envelope, which is the only way audio-driven motion can render identically headless. |
| MIDI control surface (authoring input) | Not started | n/a | P2. Web MIDI knobs/faders/pads bound to parameters for live tweaking, and a record mode that captures a performance into a channel as keyframes. The binding is a workstation preference, NOT document data: a document that only renders correctly with a particular controller plugged in is not a document. Follows the audio-envelope precedent (bake at capture, store the result). Requires a user gesture and a permission prompt; unavailable in Safari and in the headless renderer, where it is simply absent rather than degraded. |
| Driver graph validation (acyclic, bounded, typed) | Not started | n/a | P0. Cycles rejected at write time and re-checked at load; a cyclic or over-budget driver set never blocks opening the document, it degrades to the rest pose with a surfaced warning. |

### Interactivity, triggers, and state machines

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Click / hover interaction | Partial | `schema.ts` `Interaction` 473, `InteractionAction` 458; `PresentMode.tsx` `runInteraction` | Only `none`/`navigate`/`open-link`, only in present mode, unsafe URL schemes already refused. |
| Motion triggers (click, hover, hover-out, press, view-enter, scroll, time, load) | Not started | n/a | P0. Additive trigger kinds bound to motion actions rather than navigation actions. |
| Motion actions (play, pause, seek, toggle, set-state, reverse) | Not started | n/a | P0. Extends `InteractionAction` additively; older files only ever carry the three shipped variants. |
| State machines for interactive components | Not started | n/a | P0. Named states, an initial state, and transitions with duration and easing; each state selects a channel set. The deliverable a design-to-engineering handoff actually needs. |
| Scroll-linked motion (progress-driven playhead) | Not started | n/a | P1. Playhead position bound to a scroll progress input in the published runtime; a no-op in the editor and in headless export (which samples a time range instead). |
| Real-time playback runtime | Not started | n/a | P0. A small pure runtime (`@hc/motion` evaluator + `@hc/engine` renderer + the document) that plays a motion document outside the editor. |
| Published interactive document | Not started | n/a | P1. A job produces a self-contained bundle served through the existing sharing/publishing path with the same link guards; no external network access, CSP-safe (no `eval`, no `Function`). |
| Nested / component motion (a state machine inside a reused component) | Not started | n/a | P2. Depends on how F40 models component instancing. |

### Real-time playback, determinism, and render parity

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Pure framework-free playback core | Built | `engine/src/animation.ts` + `pose.ts` | The structural asset this whole spec rests on: one core for browser, worker, and headless. |
| Per-frame document poser | Built | `pose.ts` `poseDesignAt` | Deep-clones the page per frame. Fine for slides and export sampling; too allocation-heavy for a 60fps design timeline (section 10). Stays as the export/compat path. |
| Go evaluation core | Partial | `backend/internal/render/anim.go` | Hand-ported presets, easings, image motion, and pose application. Does NOT implement `customPatch` (keyframe tracks) or the text reveals, a gap recorded in `video-design-mode.md` P4.2. P0 to close. |
| Cross-language parity testing | Partial | `render/anim_test.go` `TestEvalEasingParity` | Six hardcoded easing values plus boundary invariants. No shared corpus, no keyframe/pose vectors, no image comparison. P0 to replace with the golden-vector harness (FR-22). |
| Shared golden-vector corpus run by both test suites | Not started | n/a | P0. One JSON corpus under the pure core's `testdata/`, consumed by the Vitest suite and by `go test`, covering easing, presets, channels, noise, oscillators, expressions, and stagger. |
| Incremental evaluation (cursor advance, dirty parameters) | Not started | n/a | P1. Replaces per-frame full-document posing during interactive playback. |
| Worker offload of evaluation | Not started | n/a | P2. The evaluator is already framework-free, so this is packaging plus a transferable parameter buffer; pairs with F44. |
| Frame-exact time model (integer ms from a frame index) | Partial | `deck.ts` `planDeckFrames` derives frames from ms | Export already plans discrete frames; interactive playback uses rAF timestamps. P0 to make every evaluation take an integer ms derived from a frame index so no accumulated float ever reaches the math. |

### Export, import, and interop

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Lottie export | Partial | `packages/export/src/lottie.ts` `designPageToLottie`; `ExportDialog.tsx` format `lottie` | Real and shipped, sampling the engine math into baked Lottie keyframes, but every node becomes a coloured RECTANGLE shape layer at the node's size. P0 to emit real shape/path/text/image layers. |
| Lottie export of channels, drivers, and procedural motion | Not started | n/a | P1. Drivers and expressions BAKE to sampled keyframes at the export fps (Lottie expressions are not emitted); the baking rate and the resulting file-size tradeoff are surfaced in the export dialog. |
| Lottie import | Not started | n/a | P2. Shape/transform/keyframe layers map to native nodes and channels; Lottie expressions are never executed, they are baked from the source when a sampled value is available, otherwise dropped with a report. |
| Animated SVG export (SMIL) | Not started | n/a | P1. Reuses `packages/export/src/svg.ts` `toSvg` for geometry and emits `<animate>`/`<animateTransform>` for sampled channels. |
| Animated SVG export (CSS / WAAPI variant) | Not started | n/a | P2. Better browser support for some channels than SMIL; same sampler, different emitter. |
| APNG / GIF animated raster export | Built | `packages/export/src/{apng,gif}.ts`; `ExportDialog.tsx` | Already samples the shared core; picks up new channels for free once the evaluator is the sampling source. |
| Video export (client exact path and server MP4) | Built | `frontend/src/lib/video/*`; `backend/internal/render/{video,timeline}.go` | Owned by the video specs. This spec only requires that a design motion document can be handed to the existing video render path as a frame plan. |
| Frame-sequence export (PNG sequence) | Not started | n/a | P2. Trivial once the frame plan exists; useful for handing motion to an external compositor. |

### AI motion

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| AI Creative Studio (BYO-key, multi-model, editable output) | Built | `@hc/aistudio` (`docs/shipped/39-ai-creative-studio.md`) | The layer all motion AI builds on; not yet motion-aware. |
| One-click page animate | Built | `store/editor.ts` `magicAnimatePage` 3359; assistant tool `animatePage` | Heuristic staggered entrance across a page's elements using literal delays. The precedent for AI motion, and the thing FR-20 generalizes. |
| Motion from a prompt | Not started | n/a | P1. A prompt produces channels, drivers, and a stagger rule as native editable data, applied as one undoable scene-op, never a rendered result. |
| Auto-stagger (choose the ordering rule and step) | Not started | n/a | P1. The model picks ordering (index, reading order, spatial distance, seeded shuffle) and step from the layout; the output is a stagger driver the user can then tune with one number. |
| Text animation presets library | Not started | n/a | P1. Per-character/word/line animators built on the channel model, generatable and adjustable; extends the shipped typewriter/word-wipe reveals rather than replacing them. |

### Accessibility and motion safety

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Reduced motion in export planning | Partial | `engine/src/deck.ts` `DeckPlanOptions.reducedMotion`; `ExportDialog.tsx` reads `matchMedia` | Drops TRANSITION frames from the plan; element entrance/emphasis/custom animation is unaffected. |
| Reduced motion in present mode | Built | `PresentMode.tsx` `reducedMotion` 564 | Zeroes transition duration and entrance totals via direct `matchMedia`. |
| Reduced motion in the shared player and second display | Not started | `DeckPlayer.tsx`, `AudienceStage.tsx` | Neither reads the preference; a shared link plays full motion regardless. P0 gap the runtime work closes. |
| Reduced motion in the real-time runtime | Not started | n/a | P0, hard requirement. One resolver used by every playback surface; the document cannot override it (FR-27). |
| Motion-safety authoring check (flash rate, vestibular risk) | Not started | n/a | P1. `@hc/a11y` has zero motion code today. Flag flashing above 3 Hz (WCAG 2.3.1) and large-area parallax/zoom at authoring time. |
| Keyboard timeline and curve editing | Not started | n/a | P0. Full transport, keyframe navigation and editing, and curve-handle manipulation by keyboard, with announced values (FR-28). |

## 5. UX and interaction behavior

The motion-authoring interaction model. It does not restate the F16 realtime UX (presence, locks, connection state), the base editor authoring UX (selection, transforms, panels), or the video editor's timeline, which is a separate surface with its own conventions.

- Timeline panel: a dock at the bottom of the design surface, opened per document and remembered as a view preference. A time ruler in seconds with a frame grid at the document fps; a draggable playhead; transport controls (play/pause, loop, go to start/end, step frame, step keyframe) with the shipped video-editor key bindings where they transfer (space to play, arrow keys to step). Lanes are grouped hierarchically: one row per animated node, expandable into one row per channel. Selecting a node in the canvas scrolls and highlights its lane; selecting a lane selects the node. Time always runs left to right, including in RTL locales, matching the shipped video timeline.
- Keying: a record-arm toggle plus a per-parameter key button in the properties panel. With record armed, changing any parameter writes a keyframe at the playhead on that parameter's channel, creating the channel if it does not exist. Without record armed, changing a parameter that already has a channel edits the channel's rest value and offsets every key, which is the behaviour that keeps a rest pose meaningful (a confirmation appears the first time). Keys can also be inserted directly on a lane.
- Curve editor: a toggle switches the lane area from a dope-sheet view (keys as dots) to a graph view (value versus time). Each key exposes in and out tangent handles, draggable and constrained to monotonic time; a modifier breaks handle symmetry. Multiple channels overlay with per-channel value normalization so a rotation in degrees and an opacity in 0..1 are readable together. A numeric readout on the selected key allows exact entry of time, value, and both handles, which is also the keyboard path.
- Keyframe workflows: box-select across lanes and time; drag to move in time; drag an edge of the selection to scale/retime proportionally; copy and paste a selection onto another target with a compatible channel type; right-click to set interpolation (hold, linear, bezier) or to apply a named easing from the shipped `Easing` set. Snapping to the frame grid, the playhead, markers, and neighbouring keys, with a snap toggle.
- Drivers: a parameter's context menu offers "Add driver", opening a small inspector on the lane rather than a separate editor. A driven parameter shows a distinct lane style and its numeric field becomes read-only with the resolved value shown live. The driver inspector offers the source kinds (parameter, time, expression, noise, oscillator, audio, stagger), a range remap, and a live sparkline of the resolved value across the visible time range. An expression field validates as you type and shows the parse error inline; an invalid expression never persists.
- Stagger: selecting a set of nodes (or an F40 instancer output) and applying a stagger opens one control group: step in ms, ordering rule, and reverse. The preview immediately shows the offset applied; the underlying data is one driver, not N delays, so changing the step reanimates the whole set.
- Onion skinning: a toggle in the timeline transport with a small popover for frames before, frames after, tint colours, and opacity falloff. Skins render in the canvas overlay beneath the live frame, are scoped to the selection by default, and are suppressed during playback (they are an authoring aid for a paused playhead, not a playback effect).
- State machines: an interactive component opens a states view in the timeline dock: states as columns, transitions as connections, each transition carrying a duration and an easing. Selecting a state pins the canvas to that state's resolved values so it can be edited like a normal design; selecting a transition scrubs through it.
- Reduced motion in authoring: when the author's own OS requests reduced motion, the editor still plays the timeline (they are authoring motion, and silently freezing it would be worse than useless), but a persistent badge shows that the published output will be reduced, with a one-click preview of exactly what a reduced-motion viewer sees.

## 6. Functional requirements

Grouped by theme. These FR ids are the durable contract referenced by the acceptance criteria and the feature matrix.

Parameter animation and the channel model:
- FR-1: A motion channel targets any parameter addressable by the F40 parameter reference scheme (node property, style/fill/effect slot, path point, or graph parameter) and evaluates to a typed value at a time `t`. The channel model is defined once and consumed identically by the browser, the worker, and the Go renderer. No second parameter or evaluation model is introduced.
- FR-2: Channel value types cover number, colour, 2D vector, boolean, enum, and string, with documented interpolation per type (colour in OKLab via `@hc/color`; boolean, enum, and string are hold-only).
- FR-3: A keyframe carries a time in integer ms, a value, an interpolation mode (hold, linear, bezier), and, for bezier, editable in/out tangents in normalized time-value space; a named `Easing` from the shipped set is accepted as a shorthand that resolves to fixed tangents.
- FR-4: A channel declares pre- and post-extrapolation (hold, loop, ping-pong, or linear continuation) so motion outside the keyed range is defined rather than clamped by accident.
- FR-5: The existing `NodeAnimation` preset layer (entrance/exit/emphasis/custom) continues to work unchanged and composes with channels in a documented order: presets produce the five-channel `AnimPatch` first, channels produce a sparse parameter patch second, and the parameter patch wins on any parameter both touch.

Timeline, curves, and frame-by-frame:
- FR-6: A design document exposes a timeline panel with a time ruler, a frame grid at the document fps, a scrubable playhead, transport (play/pause/loop/step frame/step keyframe/in-out range), zoom, and hierarchical lanes grouped by node and channel.
- FR-7: A graph/curve editor renders value versus time with draggable bezier tangents, multi-channel overlay with per-channel normalization, and exact numeric entry of time, value, and both handles.
- FR-8: Keyframe workflows support insert, box-select across lanes, move, proportional time-scale/retime, copy/paste onto a compatible target, interpolation change including hold, and snapping to the frame grid, playhead, markers, and neighbouring keys.
- FR-9: Onion skinning renders configurable counts of before/after frames with independent tints and opacity falloff, scoped to the selection by default, drawn in the canvas overlay, and suppressed during playback.
- FR-10: Named markers and time ranges exist on the timeline and are addressable by triggers and by export range selection.

Drivers, expressions, and procedural motion:
- FR-11: A driver binds a target parameter to a source: another parameter, time, an expression, seeded noise, an oscillator, a baked audio envelope, or a stagger rule, with an optional input-to-output range remap and a blend weight against the target's keyed value.
- FR-12: The expression language is a restricted, pure, side-effect-free grammar (numeric and colour literals, named inputs, arithmetic, comparison, ternary, and an allowlisted function set including the noise and oscillator sources). It has no property access, no loops, no host object access, and no string evaluation. It compiles to an AST that both the TypeScript and Go interpreters evaluate identically.
- FR-13: Seeded noise is specified as an exact algorithm (integer hash, gradient interpolation with a polynomial smoothstep, fractal octaves) using only operations that produce identical IEEE 754 double results in both languages. Every noise source derives its seed from the document seed and its own id, so duplicating an element produces a different but reproducible motion.
- FR-14: A stagger driver applies one animation across a set with a step in ms and an ordering rule (child index, reading order, spatial distance from a point, or seeded shuffle), including sets produced by F40 instancing where the per-instance index and position are the ordering inputs.
- FR-15: The driver graph is validated as acyclic, bounded in node count and evaluation depth, and type-compatible at write time and again at load. A document whose driver graph fails validation still OPENS: the failing drivers resolve to the rest pose and a warning is surfaced. Validation failure never blocks reading a document.
- FR-16: Audio-driven motion uses a baked amplitude envelope: the audio asset is analysed once into a quantized, band-split, versioned envelope stored with the document, and both the browser and the Go renderer read that envelope. Live microphone or stream input is out of scope precisely because it cannot be reproduced headless.

Interactivity and the real-time runtime:
- FR-17: Triggers extend additively beyond `click`/`hover` to hover-out, press, view-enter, scroll progress, time, load, and state change, bound to motion actions (play, pause, seek, toggle, reverse, set-state) in addition to the shipped navigate and open-link actions. Unsafe URL schemes stay refused.
- FR-18: A state machine declares named states, an initial state, and transitions with duration and easing; each state selects a set of channel values, and a transition interpolates between the resolved values of two states. State machines nest inside reused components where F40's component model allows it.
- FR-19: A real-time runtime plays a motion document outside the editor from the same pure evaluator, and a publish job produces a self-contained, CSP-safe bundle (no `eval`, no `Function`, no external network access) served through the existing sharing/publishing path with the same link guards.

AI:
- FR-20: On `@hc/aistudio`, motion-from-a-prompt emits channels, drivers, and stagger rules as native editable data applied as one undoable scene-op; auto-stagger chooses an ordering rule and step from the layout; and a text-animation preset library generates per-character/word/line animators built on the channel model. No AI motion output is a rendered artifact, and all of it runs on the workspace's own key so document data never egresses on a self-hosted instance.

Determinism and parity:
- FR-21: Every evaluation takes an integer millisecond derived from a frame index, never an accumulated float; the browser, the worker, and the Go renderer therefore evaluate the same discrete time values for the same frame plan.
- FR-22: A single golden-vector corpus (JSON fixtures under the pure core's `testdata/`) is run by BOTH the TypeScript test suite and `go test`, covering easings, presets, every channel type and interpolation mode, noise, oscillators, expressions, stagger, extrapolation, and state-machine transitions. Adding a source, easing, channel type, or preset without adding its vectors fails CI.
- FR-23: The Go evaluation core reaches feature parity with the TypeScript core, including the currently missing custom keyframe tracks and text reveals (`video-design-mode.md` P4.2). Where the Go core cannot evaluate a document feature, the headless render FAILS with an explicit RFC 7807 error naming the unsupported feature; it never silently renders a different frame.
- FR-24: A frame-parity harness renders a corpus of motion documents through the browser path and the Go path and compares both the resolved parameter values (exact for the deterministic core) and the rasterized frames (within a documented per-pixel tolerance covering font rasterization and antialiasing differences).

Data integrity:
- FR-25: The motion payload is carried on a new hidden, zero-size node type so an older client preserves it verbatim through `UnknownNode.raw` across a full open-edit-save cycle, and every animated parameter keeps its static value equal to the frame-0 evaluation (the rest-pose invariant). An older client therefore renders a correct static frame 0 and loses no animation data.
- FR-26: Animation edits merge under the F16 CRDT without whole-array rewrites during interactive editing: keys are committed on gesture end, the playhead and scrub position are presence-only and never document state, and channels and drivers are addressed by stable id so two editors working on different channels never conflict.

Accessibility:
- FR-27: `prefers-reduced-motion` is a hard requirement in the real-time runtime and the published document. The runtime resolves a reduced evaluation mode that freezes looping, oscillator, noise, and audio drivers at their frame-0 value, collapses transitions to a cross-fade, and disables autoplaying loops. A document cannot override it. Export honors it when the export is requested with the flag, reusing the shipped `planDeckFrames({reducedMotion})` behaviour.
- FR-28: The timeline, transport, keyframe editing, and curve-handle manipulation are fully keyboard operable with announced values: playhead by arrow keys with a frame-step modifier, keyframe next/previous, set/delete key, and exact numeric entry for time, value, and tangents. Every control has an accessible name and an announced state.
- FR-29: A MIDI control surface can be bound to any animatable parameter for AUTHORING: a control change moves the parameter live in the editor, and a record mode captures the movement into a channel as keyframes (rate-limited and simplified on commit, so a thirty-second knob sweep does not become nine hundred keys). Bindings live in workstation preferences, never in the document, and the captured keyframes are ordinary channel data indistinguishable from hand-authored ones. Absence of a device, of the Web MIDI API, or of permission changes nothing about how a document opens, renders, or exports.

## 7. Data model / schema changes

All motion data is added to the open file format per the schema-is-contract rule: extend the `NodeType` union and `KNOWN_NODE_TYPES` in `packages/schema/src/schema.ts`, define the interface plus Zod schema with `...nodeBaseFields, type: z.literal("motion")`, add it to the `KnownNode` union and the discriminated `NodeSchemaByType`, give it a default in `factory.ts`, register a forward migration step in `migrate.ts` keyed on the source version, and bump `CURRENT_SCHEMA_VERSION` (currently 17). Two coupling rules apply to every bump: (1) raise the Go mirror `currentSchemaVersion` in `backend/internal/persistence/file.go` in the SAME change, or the write boundary `persistence/validate.go` rejects the newer file with a 422 (`ErrInvalidFile`) and nothing persists; purely additive bumps need no new Go migration step. (2) Append a one-line entry to the schema-version-history doc-comment above `CURRENT_SCHEMA_VERSION` in `schema.ts`.

Why a node and not fields on `NodeBase`. Note first what is NOT the reason: unknown keys on a known node type are not stripped in this codebase. `validate()` returns a verdict and never replaces the document (`validate.go` and `packages/schema/src/validate.ts` both read the caller's object), a loaded file is the raw `JSON.parse` result, `migrate.ts` steps spread existing objects, and the CRDT is key-driven rather than allowlisted: `reconcileMap` iterates `Object.keys(source)` and `yToJson` projects whatever is in the Y.Map. An older client therefore round-trips an unknown field on a known node intact, and the same is true of the optional fields F40 and F42 add.

The real reason is scale and blast radius. Motion is a per-parameter, per-page payload with channels, drivers, and state machines; hanging it off every animatable node spreads a large mutable structure across the whole tree, multiplies CRDT churn on every keyframe edit, and makes the document expensive to project. One hidden node per page keeps the payload in a single subtree that addresses its targets by node id and parameter reference.

There is one genuine hazard that the single-node design also sidesteps, and it applies to ANY optional field an older client does not know about: `reconcileMap` deletes keys the source no longer has, so a store action on an older client that REBUILDS a node object from its known fields (rather than mutating it in place) drops the unknown key, and the reconcile then removes it for everyone. Concentrating the payload on a node no older action ever rebuilds removes that exposure. This is the concrete mechanism behind FR-25.

```ts
// One motion document per page. Written with hidden: true and a zero size, so an
// older client draws nothing (the UnknownNode path renders a placeholder box for
// non-zero-size unknown nodes) and round-trips the payload losslessly in raw.
interface MotionNode extends NodeBase {
  type: "motion";
  fps: number;                 // authoring frame rate; evaluation is ms-exact
  durationMs: number;
  loop?: "none" | "loop" | "pingpong";
  seed: number;                // document seed; every procedural source derives from it
  channels: ParamChannel[];
  drivers?: Driver[];
  machines?: StateMachine[];
  triggers?: MotionTrigger[];
  envelopes?: AudioEnvelope[]; // baked audio amplitude (FR-16)
  markers?: { id: string; t: number; label: string }[];
}

// A channel animates one F40-addressable parameter. `rest` mirrors the value the
// static parameter holds, which is what an older client renders (the rest-pose
// invariant, FR-25).
interface ParamChannel {
  id: string;
  target: string;              // F40 parameter reference
  type: "number" | "color" | "vec2" | "bool" | "enum" | "string";
  mode: "absolute" | "delta";
  rest: ChannelValue;
  keys: MotionKey[];
  pre?: Extrapolation;         // default "hold"
  post?: Extrapolation;        // default "hold"
  muted?: boolean;
}
type Extrapolation = "hold" | "loop" | "pingpong" | "linear";

interface MotionKey {
  t: number;                   // integer ms from the document start
  v: ChannelValue;
  interp?: "hold" | "linear" | "bezier";   // default "linear"
  easing?: Easing;             // shipped named curve; shorthand for fixed tangents
  inTan?: [number, number];    // normalized (time, value) tangent handles
  outTan?: [number, number];
}

// Drivers generate motion instead of storing it. Every variant is deterministic
// and evaluable in both TypeScript and Go.
type Driver =
  | { id: string; target: string; kind: "param"; source: string; remap?: Remap; weight?: number }
  | { id: string; target: string; kind: "time"; scale: number; offsetMs: number; remap?: Remap }
  | { id: string; target: string; kind: "expr"; expr: string; inputs: Record<string, string> }
  | { id: string; target: string; kind: "noise"; seed: number; frequencyHz: number; amplitude: number; octaves?: number; lacunarity?: number; gain?: number }
  | { id: string; target: string; kind: "osc"; wave: "sine" | "triangle" | "square" | "saw"; frequencyHz: number; amplitude: number; phase: number }
  | { id: string; target: string; kind: "audio"; envelopeId: string; band?: "low" | "mid" | "high"; gain: number; remap?: Remap }
  | { id: string; targets: string[]; kind: "stagger"; channelId: string; stepMs: number; order: "index" | "reading" | "distance" | "shuffle"; from?: { x: number; y: number }; seed?: number; reverse?: boolean };

interface Remap { inMin: number; inMax: number; outMin: number; outMax: number; clamp?: boolean }

interface StateMachine {
  id: string;
  nodeIds: string[];                                   // the component this drives
  initial: string;
  states: { id: string; name: string; channelIds: string[] }[];
  transitions: { id: string; from: string; to: string; on: TriggerKind; durationMs: number; easing: Easing }[];
}

type TriggerKind = "click" | "hover" | "hover-out" | "press" | "view-enter" | "scroll" | "time" | "load" | "state";
interface MotionTrigger {
  id: string;
  on: TriggerKind;
  sourceNodeId?: string;       // which node the pointer event is on
  at?: number;                 // ms, for "time"
  action:
    | { kind: "play" | "pause" | "reverse"; from?: number }
    | { kind: "seek"; t: number }
    | { kind: "toggle" }
    | { kind: "set-state"; machineId: string; stateId: string };
}

// Amplitude baked once at bind time so headless render matches the browser (FR-16).
interface AudioEnvelope {
  id: string;
  assetId: string;
  analyzerVersion: number;     // bump invalidates and re-bakes
  sampleHz: number;            // envelope rate, not audio rate
  bands: 1 | 3;
  values: number[];            // 0..1, quantized; bands interleaved when bands === 3
}
```

Additive optional fields on existing structures (version bump only):
- `Keyframe` (`schema.ts:408`): optional `interp` and tangent handles, so the shipped five-channel track gains curve control without a new type. Omitted means today's behaviour exactly.

What this spec must NOT do, and why it is worth stating: **the new triggers and motion actions cannot widen `InteractionAction` or `Interaction.trigger`.** `Interaction` hangs off `NodeBase.interaction`, so its `z.enum(["click","hover"])` is part of every node's schema. A file carrying `trigger: "scroll"` fails that node's own branch, and `UnknownNodeSchema` refuses it too because the node type IS known, so `validate()` rejects the WHOLE FILE on an older client while the Go write boundary (structural only) persists it happily. The newer client writes a document the previous binary can never open. See the zero-data-loss rules in `CLAUDE.md`.

Instead, the new triggers and actions live on the `MotionNode` payload alongside everything else this spec adds: a motion interaction is `{ targetId, trigger, action }` inside the motion document, addressed by node id, exactly like every other channel here. The shipped `Interaction` record stays frozen at its three actions and two triggers and keeps meaning what it means. That also keeps the whole feature behind the one hidden node whose round-trip is already proven, rather than spreading it across every node in the file.

Migration and mixed-version rules:
- The migration step in `migrate.ts` keyed on v17 is a version stamp: nothing to rewrite, because every addition is a new optional structure and a new node type. Opening a v17 or older file yields a document with no `MotionNode` and behaviour identical to today.
- A newer client's document opened by an older client: the `MotionNode` parses as `UnknownNode` (its `type` is not in the older `KNOWN_NODE_TYPES`), renders nothing because it is `hidden` with zero size, and is written back verbatim from `raw` on save. Every animated node renders its static parameter values, which the rest-pose invariant keeps equal to the frame-0 evaluation. The defined static state is FRAME 0 of the document timeline.
- The rest-pose invariant is maintained by the authoring client on every channel edit: writing a channel also writes its frame-0 resolved value into the static parameter. For a driven parameter whose frame-0 value differs from the authored static value, the driver's frame-0 value wins and the static parameter is updated, which is a visible change the author sees immediately in the canvas, not a silent one.
- Dangling targets are not an error: a channel, driver, or state machine whose target node or parameter no longer resolves is skipped during evaluation and surfaced in a document-health list. It is never auto-deleted, because an older client may have removed and a newer client may restore the target.
- Rollback: a rollback to a previous binary leaves the `MotionNode` present and inert, the document opens, and re-upgrading resumes the animation. That is the acceptance bar for every schema change here.
- Per-workspace data isolation is enforced at the query layer for any new table, consistent with the existing services. Baked audio envelopes live in the document (they are small and must travel with it); the source audio stays in the existing asset/object-storage pipeline.

## 8. API and realtime

REST under `/api/v1` (chi router). Errors are RFC 7807 problem+json; all handlers emit structured JSON logs with design id, workspace id, user id, and request id.

```
POST   /api/v1/designs/{id}/export/lottie        Lottie JSON (real layers, drivers baked) -> job
POST   /api/v1/designs/{id}/export/svg-animated  animated SVG (SMIL or CSS variant) -> job
POST   /api/v1/designs/{id}/export/frames        PNG frame sequence over a time range -> job
POST   /api/v1/designs/{id}/export/video         existing video job, given a motion frame plan
POST   /api/v1/designs/{id}/publish/interactive  build the real-time runtime bundle -> job
POST   /api/v1/designs/{id}/motion/bake-audio    analyse an audio asset into an AudioEnvelope -> job
POST   /api/v1/imports/lottie                    Lottie -> editable native nodes + channels -> job
POST   /api/v1/designs/{id}/ai/motion            motion-from-prompt / auto-stagger (AI) -> job
GET    /api/v1/jobs/{id}                          poll long-running ops (existing job registry)
```

Every one of these is long work and goes through the in-process job registry (202 plus a job id), never inline in a handler: rendering a frame sequence, baking an audio envelope, building a runtime bundle, and parsing an untrusted Lottie are all unbounded in the input's size. A 422 problem+json is returned when an imported or AI-produced document fails boundary schema validation (`persistence/validate.go`), so a malformed document never persists for other clients. Headless render of a document with a motion feature the Go core cannot evaluate returns a 422 naming the feature (FR-23), rather than producing a divergent frame.

Realtime over `/realtime` (extends F16). The merge story matters more than new frame types here, because animation editing is high-frequency:
- Document state: channels, keys, drivers, machines, and triggers live inside the `MotionNode` and sync through the existing generic scene-graph CRDT bridge (`@hc/schema/yjs.ts`, `@hc/realtime/reconcile.ts`). The known hazard is that `reconcilePlainArray` delete-and-reinserts a whole array on any edit and `fromDoc` rebuilds the `DesignFile` per delta, so a 500-key channel edited per pointer-move would rewrite 500 entries per frame. Mitigation, following the shipped ink-stroke precedent: a drag is LOCAL and ephemeral, and one commit lands on gesture end as a single array write (FR-26). Scrubbing the playhead writes nothing to the document at all.
- Addressing: channels, keys, drivers, and states carry stable ids, so two editors editing different channels of the same page produce disjoint writes and converge without a positional conflict. Two editors editing the SAME key converge last-writer-wins on that key, which is the same guarantee the rest of the property model gives.
- Presence: the playhead position, the timeline zoom/scroll range, and the record-arm state are presence, extending `PeerState` in `store/presence.ts` and the `sanitizePresence` allowlist in `backend/internal/realtime/presence.go`. Seeing a collaborator's playhead is the useful signal; putting it in the document would be a per-frame write storm.
- No new server-authoritative store is needed: nothing in the motion model has an integrity requirement of the kind that forced the whiteboard vote store into Postgres.

SDK (`@hc/sdk`): typed methods for the export, publish, bake, import, and AI-motion routes. New and changed pure cores: `@hc/motion` (new, no React and no UI, no DOM) holds the channel evaluator, the driver graph, the expression compiler and interpreter, the noise and oscillator sources, the stagger resolver, and the state-machine runtime, and it owns the golden-vector corpus; `backend/internal/motion` is its Go twin, and `backend/internal/render/anim.go` becomes a caller of it rather than a parallel implementation; `@hc/engine` gains the frame-plan and incremental-pose entry points that consume `@hc/motion`'s resolved parameter buffer, keeping `poseDesignAt` as the compatibility path; `@hc/export` gains the animated-SVG emitter and the upgraded Lottie emitter/importer; `@hc/a11y` gains the motion-safety checks. The engine stays free of React and UI dependencies, and so does `@hc/motion`.

## 9. AI hooks

All motion AI builds on the shipped F39 AI Creative Studio (`@hc/aistudio`): the BYO-key, multi-model, self-hostable provider-adapter layer with editable, reproducible output. Document data never leaves a self-hosted instance because inference routes through the workspace's own key or endpoint. Every capability emits content plus intent validated against a JSON Schema, is materialized into native `@hc/schema` structures by deterministic TypeScript code, and is applied through the `@hc/editor` command framework as one undoable scene-op.

- Motion from a prompt: the model returns a motion SPEC (which targets, which channels, which keys, which drivers, which stagger rule), validated against a schema and materialized into `MotionNode` data. It never returns rendered frames and never returns an expression string that has not been through the same parser and bounds checks a hand-typed expression goes through (section 11).
- Auto-stagger: given a selection, the model chooses an ordering rule and a step from the layout (reading order for text, spatial distance for a radial burst, index for a list) and emits ONE stagger driver. The value of this over the shipped `magicAnimatePage` is exactly that: the output is a rule with two knobs, not N literal delays, so the user can retune the whole set with one number.
- Text animation presets: a generated library of per-character, per-word, and per-line animators built on the channel model plus a stagger driver, extending the shipped typewriter and word-wipe reveals rather than replacing them. Presets are data, so a user can open one and edit its curves.
- Motion critique: the assistant reads a document's channels and drivers and reports on timing consistency, easing mismatches across sibling elements, motion that will be dropped under reduced motion, and flash-rate or vestibular risks flagged by `@hc/a11y`, as an accept/reject list rather than an automatic rewrite.
- Expression assist: natural language to an expression in the restricted language, with the compiler's error surfaced back to the model on failure. The generated expression is subject to the identical parse, allowlist, and bounds checks; there is no privileged AI path into the evaluator.
- Reproducibility: because every procedural source is seeded from the document seed and its own id, an AI-generated motion is exactly reproducible and diffable, which is the property that makes AI motion reviewable rather than a slot machine.

## 10. Performance and scale

- Frame budget: at 60fps the whole pass has 16.6ms. The committed split is at most 4ms for evaluation (channels plus drivers plus expressions plus state machines) on a document with 2,000 animated parameters, leaving the remainder for raster. Evaluation cost must scale with the number of ANIMATED parameters, not with the number of nodes in the document.
- Incremental evaluation: channels keep their keys sorted and hold a cursor that advances monotonically during forward playback, so per-frame key lookup is amortized O(1) rather than a binary search per channel per frame; a seek falls back to a binary search once and then resumes the cursor. The driver graph is topologically sorted once per edit, not per frame.
- No per-frame document cloning on the interactive path: `poseDesignAt` deep-clones the page every call, which is correct and fine for export sampling and slide playback but is not a 60fps design-timeline budget. Interactive playback resolves into a double-buffered parameter array and applies it to the scene in place; `poseDesignAt` remains the export and compatibility path so nothing that depends on it changes.
- Render scope: reuse the shipped `@hc/engine` `spatial.ts`, `tiles.ts`, and `viewport.ts` culling so only nodes whose resolved parameters CHANGED this frame and are visible are re-rasterized. Off-screen animated nodes are still EVALUATED (a driver may read them) but not rasterized; that asymmetry is deliberate and must be documented, because skipping their evaluation would make on-screen results depend on the viewport, which would break determinism.
- Long timelines: a 10-minute document at 60fps is 36,000 frames. The timeline panel renders by visible time range with virtualized lanes and keys, never by frame, and the ruler's tick density adapts to zoom. Channel key counts are capped with a surfaced warning rather than an unbounded array, and a bake-down operation can resample a dense channel.
- Scrub responsiveness: a scrub must resolve within one frame of the pointer move. Seeking never replays; every source is a pure function of `t`, which is exactly why drivers and procedural sources are specified as stateless functions of time rather than as integrators.
- Onion skinning cost: each skin frame is a full evaluate-and-raster pass. Selection-scoped by default, capped, cached by frame index, and invalidated only when the underlying document changes, not when the playhead moves.
- Export sampling: the frame plan is generated once (generalizing `deck.ts` `planDeckFrames` from slides to a document timeline) and consumed by the APNG, GIF, Lottie, animated-SVG, PNG-sequence, and server video paths, so no exporter has its own notion of when a frame occurs. Memory stays bounded because the plan is streamed frame by frame, never materialized as a frame array.
- GPU path: F44's accelerated backend consumes the resolved parameter buffer rather than the scene graph, which is the interface that makes the evaluator reusable on both backends. Canvas2D remains the always-available fallback, and the frame plan is backend-independent so a GPU-rendered preview and a Canvas2D headless render still agree on WHICH frames exist.
- Sustainability note: server-side frame rendering, envelope baking, and runtime-bundle builds are real server costs the self-host story owns. All of them are job-queued and quota-bounded per deployment, never inline.

## 11. Security and threat model

Expressions are user code. That is the defining security fact of this spec, and it is compounded by the requirement that the same code must also run server-side during a headless render. Cross-cutting SSO/compliance/observability infrastructure is owned by F38; this section covers the motion-specific posture.

Web MIDI (FR-29) is the one device-access surface added here, and it is deliberately small: it is requested only on an explicit user gesture when a control surface is first bound, it is never requested at page load, SysEx is never requested (the permission prompt is materially scarier with it and nothing here needs it), and no device identifier reaches the document or the server. Because the binding is a workstation preference and the captured output is ordinary keyframes, an attacker who somehow forged MIDI input could move a slider in someone's editor and nothing more; there is no path from a device message to stored data that a normal edit could not also produce.

- The expression language is not JavaScript and is not evaluated by a JavaScript engine. It is a small grammar (numeric and colour literals, named inputs, arithmetic and comparison operators, a ternary, and an allowlisted pure function set) parsed into an AST and interpreted by hand-written evaluators in TypeScript and Go. There is no property access, no member call, no loop, no assignment, no string-to-code path, and no host object in scope. `eval`, `new Function`, and dynamic `import` appear nowhere in the runtime, which also makes the published bundle CSP-safe under a strict policy.
- Resource bounds are enforced at parse time and at evaluation time: a maximum AST node count per expression, a maximum input-reference count, a maximum evaluation depth, a maximum total driver-graph node count per document, and a per-frame evaluation budget. Exceeding a budget degrades that driver to its rest value and surfaces a warning; it never hangs a frame, and it never fails a document open (FR-15).
- The driver graph is proven acyclic at write time and re-proven at load, because a document can arrive from an import, from another client, or from an older binary. A cycle is a rejection at write and a degrade-to-rest at load.
- Numeric hazards are handled explicitly rather than left to the two languages to differ on: division by zero, NaN, and infinity resolve to a documented value and are clamped to the target parameter's range. This matters twice over, because a silent NaN in TypeScript and a silent NaN in Go can propagate differently into a rasterizer.
- Server-side evaluation reuses no JavaScript. The Go binary already embeds goja for the CRDT fold (`backend/internal/crdt/fold.go`, compiled once, run in a throwaway VM under a timeout), which proves the pattern is available, but per-frame expression evaluation through a JS VM is the wrong cost and the wrong trust boundary. The Go interpreter in `backend/internal/motion` is the render path; goja stays reserved for the CRDT fold. If a document's expression cannot be evaluated by the Go interpreter, the render returns 422 naming the feature (FR-23) instead of substituting a value.
- Untrusted imports: a Lottie file is untrusted input parsed by a job with size, depth, and layer-count caps, never inline. Lottie expressions are NEVER executed; they are baked from sampled values where the source provides them and otherwise dropped with an explicit report. Any embedded asset goes through the existing SSRF-guarded media path.
- Audio baking reads a workspace asset through the existing media pipeline with a duration and size cap; the resulting envelope is quantized and bounded, so a malicious audio file cannot produce an unbounded array in the document.
- The published interactive runtime executes only the document's own compiled AST, has no network access, and is served through the existing share-link guards (password, expiry, rotate, disable, anonymous bounds) at the link's permission level; a view-only link exposes no editor capability.
- AI and data residency: all motion AI routes through the workspace's own BYO key or endpoint, so document data stays on the self-hosted instance. AI-generated expressions receive no privileged treatment.
- Observability and metrics: motion API handlers and the export/publish jobs emit structured JSON logs keyed by design id, workspace id, user id, job id, and request id. Success metrics: evaluation time per frame at the section 10 budgets, scrub latency, frame-parity pass rate on the golden corpus, headless-render 422 rate by unsupported feature (which is the leading indicator of TS/Go drift), and reduced-motion resolution rate in the published runtime.

## 12. Accessibility and i18n

- Reduced motion is a hard requirement, not a preference. The real-time runtime and every published document resolve `prefers-reduced-motion` before the first frame and, when it is set, freeze looping/oscillator/noise/audio drivers at their frame-0 value, collapse transitions to a cross-fade, disable autoplaying loops, and suppress scroll-linked motion (the content still reaches its final state; it just does not travel there). A document has no field that can override this. This extends the behaviour that already ships in `deck.ts` `planDeckFrames({reducedMotion})` and `PresentMode.tsx` to the general motion runtime.
- Author-side clarity: the editor keeps playing motion for an author whose own OS requests reduced motion, because silently freezing the surface they are authoring would be worse than useless, but a persistent badge and a one-click "preview as reduced motion" show exactly what a reduced-motion viewer gets. Reduced motion is never a surprise at publish time.
- Motion safety checks in `@hc/a11y` at authoring time: flashing above 3 Hz (WCAG 2.3.1 Three Flashes), large-area parallax and zoom that commonly trigger vestibular responses, and text that moves while it is meant to be read. Each is a warning with a one-click fix (clamp the frequency, reduce the amplitude, or mark the motion as decorative).
- Keyboard timeline control: the transport, the playhead, keyframe navigation, keyframe creation and deletion, interpolation changes, and curve-handle manipulation are all reachable and operable by keyboard, with exact numeric entry as the precise path for tangents. The focused lane, key, and handle are announced with their time and value, and the timeline exposes a landmark and a labelled structure rather than a wall of unlabelled buttons.
- Screen-reader semantics for motion content: an animated node's accessible name and description come from the existing `NodeBase.altText`/`decorative` model (shipped at schema v12) and do not change per frame; a state machine exposes its current state name so an interactive component announces meaningfully. Motion never carries information that is not also available statically.
- i18n: numeric entry honors locale decimal separators; time is formatted per locale; all timeline and curve-editor strings are localized. In RTL locales the panel chrome mirrors but the TIME AXIS does not, matching the shipped video timeline and the near-universal convention that time runs left to right.

## 13. Import / export and interop

- Lottie export: the shipped `designPageToLottie` already samples the engine math into baked Lottie keyframes, but emits each node as a coloured rectangle shape layer. The upgrade emits real geometry (shape and path layers from `PathNode`/`ShapeNode`, text layers, image layers referencing embedded assets), real fills and strokes, and the new channel types. Drivers, expressions, noise, oscillators, and stagger BAKE to sampled keyframes at the chosen export fps, because Lottie expressions are a different and less portable language; the export dialog states the sampling rate and its file-size consequence rather than hiding it.
- Lottie import: shape, transform, and keyframe layers map to native `@hc/schema` nodes plus `ParamChannel`s, so an imported animation is editable data, not a playback blob. Source expressions are never executed; where the file carries sampled values they are imported as keys, otherwise the property imports static with an entry in the import report. The importer is a job with the caps in section 11.
- Animated SVG export: `packages/export/src/svg.ts` `toSvg` already produces the static geometry; the animated variants add SMIL (`<animate>`, `<animateTransform>`, `<animateMotion>`) and a CSS/WAAPI emitter for the channels SMIL handles poorly. Both are sampled from the same frame plan, so all three vector emitters agree.
- Raster animated export: APNG and GIF ship (`packages/export/src/{apng,gif}.ts`) and pick up the new channels automatically once the frame plan is the sampling source, with no exporter-side change beyond consuming the plan.
- Video export: unchanged and owned by the video specs. The only new interface is that a design motion document can hand its frame plan to the existing client exact-export path and to the Go MP4 path. A schema node animated by this spec already animates inside a video project, because `Clip.element` nodes are posed by the same engine core.
- PNG frame sequence: a range of the frame plan rendered to numbered PNGs, for handing motion to an external compositor.
- Open format: every import, AI generation, and preset lands as editable `@hc/schema` data with forward migration and lossless `UnknownNode` round-trip. A motion document is data a user owns and can take elsewhere, which is the structural difference from every proprietary motion project file.

## 14. Phasing / milestones

Dependency-ordered, each phase independently shippable. Phase 1 is gated on F40's parameter addressing existing in some usable form; if it slips, Phase 1 can land against a narrower hand-rolled target set and adopt F40's references when they arrive, but the evaluator must not fork.

Phase 1: the channel model and the timeline (a real animation tool for design documents).
- `@hc/motion` as a new pure core (no React, no UI, no DOM) with the channel evaluator, typed interpolation, extrapolation, and the frame-plan generator generalized from `deck.ts` `planDeckFrames`.
- The `MotionNode` schema addition with the forward migration, the Go mirror bump, and the rest-pose invariant.
- The design-document timeline panel: ruler, playhead, transport, lanes, scrubbing, zoom, virtualization.
- The graph/curve editor with draggable bezier tangents and exact numeric entry, plus the keyframe workflows.
- `backend/internal/motion` as the Go twin, and the golden-vector corpus wired into both test suites, INCLUDING the presets and easings that already ship (which closes the existing hand-maintained-parity gap immediately).
- Close the known Go gaps: custom keyframe tracks and text reveals in the server core (`video-design-mode.md` P4.2).

Phase 2: procedural motion (the differentiator).
- The driver model, the driver graph with cycle and bounds validation, and the driven-parameter UI.
- Time and parameter-to-parameter drivers; seeded noise and wiggle; oscillators.
- The expression language: grammar, compiler, twin interpreters, bounds, and the editor field with inline validation.
- The stagger driver with all four ordering rules, including F40 instancer sets when available.
- Baked audio envelopes plus the bake job.
- Onion skinning and hold interpolation for frame-by-frame work.

Phase 3: interactivity and the real-time runtime.
- Additive triggers and motion actions; state machines and the states view.
- The real-time runtime and the interactive publish job with the CSP-safe bundle.
- Scroll-linked motion in the runtime.
- Reduced-motion resolution as a hard runtime requirement plus the motion-safety authoring checks.
- The full keyboard timeline and curve-editing model.

Phase 4: interop and AI.
- Real-geometry Lottie export with driver baking; Lottie import; animated SVG (SMIL then CSS/WAAPI); PNG frame sequence.
- Motion from a prompt, auto-stagger, the text-animation preset library, motion critique, and expression assist.
- The frame-parity harness in CI against a corpus of real documents, browser versus Go, with the per-pixel tolerance policy.

Phase 5: scale and craft.
- Incremental evaluation and dirty-parameter rendering at the section 10 budgets; worker offload of the evaluator; the F44 GPU path consuming the resolved parameter buffer.
- Long-timeline handling proven at 10 minutes and 60fps; motion trails; markers and named ranges everywhere they are useful.
- Reassess the deferred set (physics, rigging, live audio input) against what the parity harness has actually proven.

## 15. Acceptance criteria

These sample representative, testable criteria across the phases; a requirement not pinned to a numbered AC here is verified by the section 16 test plan.

- AC-1: A fill colour, a corner radius, a blur amount, a path point, and an F40 graph parameter can each be keyed on the timeline and animate correctly in the canvas, in an animated export, and in a headless server render (FR-1, FR-2).
- AC-2: A keyframe's interpolation can be set to hold, linear, or bezier; bezier tangents are draggable in the curve editor and enterable as exact numbers; the shipped named easings resolve to the same curve they produce today (FR-3, FR-7).
- AC-3: A document animated by the current client, opened by the previous release, renders exactly its frame-0 state, shows no placeholder artifact, and after that older client edits an unrelated property and saves, the full motion payload is still present and plays identically when reopened by the current client (FR-25).
- AC-4: Raising `CURRENT_SCHEMA_VERSION` in `packages/schema/src/schema.ts` without raising `currentSchemaVersion` in `backend/internal/persistence/file.go` causes the write boundary to return 422 and persist nothing; a test asserts the two constants are equal (FR-25).
- AC-5: For every document in the golden corpus and every frame in its plan, the resolved parameter values from the TypeScript evaluator, the worker evaluator, and the Go evaluator are bit-identical, and the rasterized frames from the browser path and the Go path match within the documented per-pixel tolerance. The same corpus is executed by `npm run test` and by `go test` (FR-22, FR-24).
- AC-6: A document using a motion feature the Go core cannot evaluate returns a 422 problem+json naming the unsupported feature from the headless render, and never returns a rendered frame that differs from the browser (FR-23).
- AC-7: With `prefers-reduced-motion: reduce` set, a published interactive document freezes noise, oscillator, audio, and looping drivers at their frame-0 value, cross-fades transitions, does not autoplay, and reaches every element's final state; no document field can re-enable the motion, and the same document with the preference unset plays fully (FR-27).
- AC-8: The timeline is fully operable by keyboard: playhead move and frame step, keyframe next/previous, set and delete a key, change interpolation, and adjust both tangents by exact numeric entry, with the focused key's time and value announced to a screen reader (FR-28).
- AC-9: A seeded noise driver produces the same values for the same seed and time in the browser and in Go; duplicating the driven element produces a different but reproducible motion; changing the document seed changes both reproducibly (FR-13).
- AC-10: An expression referencing another parameter evaluates identically in both languages, is rejected at parse time if it uses property access, a loop, or an unlisted function, degrades to the rest value (with a warning, not a failure to open) when it exceeds a resource bound, and is rejected at write time if it introduces a cycle (FR-12, FR-15).
- AC-11: A stagger driver over 200 instanced elements animates them with the configured step and ordering rule; changing the step from 40ms to 20ms retimes the whole set with a single edit and a single undo step (FR-14).
- AC-12: An audio-driven parameter is baked into an envelope once, and the browser preview and the server MP4 of the same document track the audio identically frame for frame (FR-16).
- AC-13: A button component authored as a state machine transitions on hover, press, and release in the real-time runtime with the authored durations and easings, and the same document exported to video renders the initial state without firing pointer triggers (FR-17, FR-18).
- AC-14: A published interactive document runs under a strict CSP with no `eval` and no `Function`, makes no external network request, and honors the share link's permission level, password, and expiry (FR-19).
- AC-15: A Lottie export of a document containing a path, text, an image, a colour channel, and a noise driver renders in a standard Lottie player with the real geometry (no rectangle proxies) and motion matching the in-editor preview at the export fps (FR-1, section 13).
- AC-16: A Lottie file imports to editable native nodes and channels, its expressions are not executed, and anything not importable appears in an explicit report rather than being silently dropped (section 13).
- AC-17: An animated SVG export plays the same motion as the APNG export of the same time range, sampled from the same frame plan (section 13).
- AC-18: Onion skinning shows the configured number of before and after frames with distinct tints, is scoped to the selection, and disappears during playback (FR-9).
- AC-19: Two collaborators editing different channels of the same page converge with no lost edits; dragging a keyframe produces exactly one document write on gesture end; a scrub produces zero document writes and appears on the peer's timeline as a presence playhead (FR-26).
- AC-20: A document with 2,000 animated parameters evaluates within the 4ms budget and plays at 60fps with dirty-parameter rendering; a 10-minute timeline scrolls and zooms without materializing per-frame UI (section 10).
- AC-21: The motion-safety checker flags a driver whose resolved motion flashes above 3 Hz and a full-bleed parallax, each with a one-click fix (section 12).
- AC-22: No motion feature (timeline, curve editor, drivers, expressions, state machines, the real-time runtime, Lottie/SVG export, publishing) is gated behind a tier or watermarked, and the whole motion document exports to the open format and runs self-hosted (differentiator 1).
- AC-23: Recording a MIDI knob sweep onto a parameter produces channel keyframes that play back identically with the controller unplugged, in a browser with no Web MIDI support, and in the headless server render; the document contains no reference to the device, and re-opening it on a machine that has never seen a controller shows the same motion (FR-29).

## 16. Test plan

- Unit (pure cores, `@hc/motion`): channel evaluation for every value type and interpolation mode; extrapolation modes; bezier tangent solving against the shipped `cubicBezierEase`; the expression parser (accept and reject sets, including every disallowed construct); the interpreter's numeric-hazard policy (division by zero, NaN, infinity); noise determinism and distribution; oscillators; stagger ordering rules; driver-graph topological sort and cycle rejection; state-machine transition resolution; frame-plan generation.
- Cross-language golden vectors (FR-22): one JSON corpus consumed by the Vitest suite and by `go test`, covering easings and the shipped presets (which today have only six hand-written parity constants), channels, noise, oscillators, expressions, stagger, extrapolation, and state transitions. CI fails if a new source, easing, channel type, or preset lands without vectors.
- Frame-parity harness (FR-24): a corpus of real motion documents rendered frame by frame through the browser path and the Go path, comparing resolved parameter buffers exactly and rasterized frames within the documented tolerance, run in CI on every change to either evaluator or to the rasterizers.
- Schema (`@hc/schema`): the migration step (an older file opens unchanged, the additive bump is a no-op); the `MotionNode` round-trip through `UnknownNode.raw` under an older client's parse-and-resave; the rest-pose invariant (frame-0 evaluation equals the static parameter after every channel edit); dangling-target tolerance; the TS/Go schema-version equality assertion.
- Backend (Go): `backend/internal/motion` mirroring the TypeScript suite over the same vectors; the export/publish/bake/import jobs through the job registry; RFC 7807 on every error path including the unsupported-feature 422; Lottie import caps (size, depth, layer count) and SSRF guards on embedded assets; audio-bake caps; structured-log assertions; per-workspace isolation on any new query.
- Integration: CRDT convergence with the `MotionNode` under concurrent channel edits; the one-write-per-gesture assertion; presence playhead fan-out; cross-instance behaviour with Redis; an older-binary client and a current client in the same live room, both editing, with no motion data lost.
- Frontend / E2E (compose stack, real browsers): timeline scrub and transport; curve-editor handle drag and numeric entry; keyframe box-select, move, and proportional retime; driver authoring including an expression with a live error; stagger over an instanced set; onion skinning; state-machine authoring and playback; the published runtime under a strict CSP; reduced-motion resolution with the media query forced both ways; the full keyboard path.
- Performance: the 4ms evaluation budget at 2,000 animated parameters; 60fps playback with dirty-parameter rendering; scrub latency within one frame; a 10-minute timeline panel; onion-skin cost with the cap in place; export sampling within a bounded memory ceiling.
- AI eval / golden-set: a harness scoring motion-from-prompt validity (schema-valid, no invalid targets, one undo step), auto-stagger sensibility, and expression-assist compile rate across multiple models, for reproducibility.
- Manual: a motion-designer runbook (author, drive, stagger, publish, export end to end); a self-host smoke test with a BYO key proving no document egress; an accessibility audit of the timeline and curve editor against WCAG 2.2 AA; a real-device check of the published runtime with reduced motion enabled at the OS level.

## 17. Differentiators

- One evaluation core across browser, worker, and headless server, extended from transforms to arbitrary parameters and to procedural sources, with a shared golden-vector corpus proving it. Desktop motion suites render locally and web tools render in a browser; nothing free and self-hostable offers frame-identical authoring and headless rendering of procedural motion (differentiator 2).
- Procedural motion in a design tool, free and ungated: seeded noise, oscillators, expressions, parameter binding, and rule-based stagger are the capabilities that separate motion design from animation, and they live in professional desktop suites, not in free web design tools (differentiators 1 and 5).
- Motion as open, editable data: channels, drivers, state machines, and expressions live in the open file format with forward migration and lossless round-trip, exportable to Lottie and animated SVG with real geometry. A motion document is portable data rather than a proprietary project file plus a rendered artifact (differentiator 6).
- Determinism as a product property, not an implementation detail: integer-ms time, seeded procedural sources, baked audio envelopes, a restricted expression language with twin interpreters, and a loud 422 instead of a silently different frame. Reproducible motion is what makes AI-generated and collaboratively-edited motion reviewable (differentiators 4 and 6).
- Interactive components as a first-class output: state machines and a real-time runtime published through the existing sharing path, so a design-to-engineering handoff is a running artifact on the team's own instance, not a video of one (differentiator 6).
- Reduced motion as a hard, non-overridable runtime requirement plus authoring-time flash-rate and vestibular checks, on a surface where the entire industry treats motion accessibility as an afterthought (differentiator 7).
- Procedural motion over a procedural graph: because F40 makes the document itself non-destructive and parametric, a driver can reach a generator's parameter and an instancer's per-instance index, which is a composition no layer-based motion tool can express (differentiators 2 and 5).

## 18. Open questions and risks

- TypeScript/Go drift is the top risk and it is already real: `anim.go` is a hand-written port kept aligned by a comment and six hardcoded easing constants, and it is knowingly missing custom keyframe tracks and text reveals. Adding drivers, expressions, noise, and state machines multiplies the surface. Mitigations committed here: one specification, twin interpreters, a shared golden-vector corpus run by both suites (FR-22), a frame-parity harness in CI (FR-24), and a loud 422 rather than a substituted value (FR-23). The residual question is whether to go further and generate the Go evaluator from a single source of truth; the working assumption is no (generated Go would be hard to read and debug) and that the corpus is the contract instead. Revisit if the corpus starts catching regressions faster than it prevents them.
- Transcendental parity: `sin`, `cos`, `pow`, and `exp` are not guaranteed bit-identical across libm implementations, and the shipped emphasis presets and easings already use them. Options: restrict the deterministic core to polynomial approximations we implement ourselves (exact, but changes the shipped preset curves, which alters existing documents and is therefore not acceptable), or define an exactness policy per layer: bit-exact for the NEW noise and expression core (built from arithmetic and polynomials only), and a documented ulp tolerance for the existing preset math where both sides already agree in practice. Working assumption: the layered policy. Needs a spike measuring actual divergence across target platforms before Phase 1 closes.
- Where the timeline lives relative to the video editor, and the vocabulary sprawl. Two keyframe models already exist under the same NAME (`@hc/schema` `KeyframeTrack`, ms-based, five transform channels, evaluated by `customPatch`; and `@hc/timeline` `KeyframeTrack` on `Clip.keyframes`, frame-based, `{property: string, value: unknown}`, evaluated by `frontend/src/lib/video/compositor.ts` `evalKeyframes`), alongside three easing vocabularies (`@hc/schema` `Easing`, `@hc/timeline`'s opaque `type Easing = string`, and `compositor.ts` `applyEasing`'s three names). This spec deliberately adds a third channel model for design documents rather than unifying, because unifying would require reworking a complete and shipped video editor. The open question is whether that is permanent. Working assumption: permanent for the clip UNIT (a clip is not a scene node), but convergent at the evaluator and at the vocabulary: `@hc/motion` becomes the single evaluator for schema-node parameters and the single easing definition, `@hc/timeline`'s opaque easing string is narrowed to that definition as a non-breaking tightening, and video element clips inherit the whole thing for free because they already pose their `Clip.element` through the shared engine core. The convergence must be sequenced so no shipped video project changes behaviour.
- Rest-pose maintenance under mixed clients. The invariant (static parameter equals frame-0 evaluation) is maintained by the AUTHORING client. An older client that edits the same static parameter breaks the invariant until a newer client re-derives it. Working assumption: the newer client re-derives the rest pose on load and reports the discrepancy in a document-health list rather than silently overwriting the older client's edit. This needs a decision on whose value wins, and the case is unusually easy to get wrong in a way that looks like data loss to the user.
- CRDT cost of dense channels. `reconcilePlainArray` delete-and-reinserts a whole array on any edit and `fromDoc` rebuilds the `DesignFile` per delta, so a channel with thousands of keys is expensive even with commit-on-gesture-end. Mitigations proposed: gesture-end commits, presence-only scrubbing, per-channel arrays rather than one document-wide key list, and a key-count cap with a bake-down operation. If that is insufficient, the fallback is a chunked channel representation, which is a schema shape decision better made after measurement. Needs a spike against a realistic dense document.
- The `AnimPatch` five-channel ceiling. F28 already flags this as an open question and assumed a parallel evaluation pass. This spec commits to that answer: a sparse parameter patch composed AFTER the existing five-channel patch, leaving the hot path and every shipped document untouched. The residual risk is compose-order surprises where a preset and a channel touch the same parameter; the rule is that the parameter patch wins, and it needs to be visible in the UI, not just in a doc.
- Expression language scope. Too small and users bounce off it; too large and it becomes a scripting host with a real sandbox problem and a much harder parity story. Working assumption: start deliberately small (arithmetic, comparison, ternary, an allowlisted function set, named inputs) and grow only on evidence. Explicitly out: loops, assignment, user-defined functions, and anything that can observe the environment.
- Audio determinism. Baking an envelope is the only way headless render can match, but it means changing the source audio silently invalidates the motion. Working assumption: the envelope stores an asset reference plus an analyzer version, and a changed source or a bumped analyzer version surfaces a re-bake prompt rather than re-baking silently. Live microphone input stays out of scope for exactly this reason.
- Publishing an interactive document versus the existing web/publishing surfaces. The interactive runtime overlaps the deck player and the website/publishing path. Where does it live, and does a motion document publish as its own artifact or as an embeddable component in the website feature? Defer the decision until the website surface is further along; ship the standalone shared-link runtime first.
- Onion skinning cost on a heavy document. Each skin is a full evaluate-and-raster pass, and the honest position is that whole-page onion skinning at useful skin counts is not affordable on Canvas2D for a heavy document. Selection scoping and caching are the committed mitigations; whole-page onion skinning may have to wait for the F44 GPU path.
- Dependency on F40. Parameter addressing, the evaluation model, instancing, and the component model all come from F40. If F40 lands late or lands with a different parameter reference scheme, Phase 1 must either wait or ship against a narrower hand-rolled target set and adapt. The hard constraint either way is that there is exactly ONE evaluation engine; a second one built here to unblock a schedule would be a permanent architectural mistake.
