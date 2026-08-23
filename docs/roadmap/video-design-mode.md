# Video Editor: Design-Video (Motion Graphics) Backlog

Compiled 2026-07-22 from a code-level gap analysis of the video editor vs a
Canva-style video maker. The current editor is a capable clip/footage timeline
(see `video-editor-backlog.md`, essentially complete). The gaps below are about
the OTHER video model it lacks: video built from designed "pages" (a background
with freely placed text, images, and shapes, each shown for a duration, with
element animations and scene transitions), i.e. a footage-free motion-graphics /
animated-slideshow video.

Ordering is by dependency then impact. Phase 1 is the unlock: until video can
composite non-footage elements, most of the rest is moot. Work top to bottom;
check items off as they land.

## MVP slice (smallest thing that delivers the flagged use case)

The "white page + text + image, timed, with basic motion" workflow needs, at
minimum: P1.1, P1.2, P1.3, P1.4, P2.1, P2.2, P2.3, P4.1, P4.2, P4.4. Everything
else broadens and polishes from there.

## Phase 1. Foundations: elements in video (the unlock)

STATUS: Phase 1 COMPLETE. A video can now be built from footage-free design
elements, solid background pages (P1.3), text (P1.4), and still images (P1.2), each
a `Clip.element` composited through all three render paths (browser preview, exact
in-browser export, server ffmpeg MP4). The flagged "white page + text + image"
motion-graphics video works end to end. Next: Phase 2 (a scene/pages model to group
and reorder elements) and Phase 3 (the Elements/Text/Stock panels + drag-onto-stage).

Progress: the element-clip render path is DONE across all three surfaces. A clip
carries an embedded scene node in `Clip.element` (@hc/timeline model). Browser
preview + exact export rasterize it via the engine node renderer in `playback.ts
drawSource` (returned as a `DrawSource`, so the existing opacity/transition/pose
compositing applies). The Go server MP4 export rasterizes it via `raster.go ToPNG`
and composites it as a looped-image overlay (`timeline.go`, staged in the export
handler), matching the preview. A `+Background` action inserts a full-stage solid
element (P1.3). Verified: browser smoke (stage 100% white), Go E2E test (rendered
MP4 frame is white), unit tests for the ffmpeg args, tsc/eslint/gofmt clean.

Server rasterizer parity: the Go rasterizer (`raster.go` + `nodes_extra.go`,
shared by design PNG/JPEG/PDF export and video element clips) now also renders
text wrapping, image and pattern shape fills (on rect/polygon/star AND ellipse
shapes), conic gradients, a frame's own fill, and the
`boolean`/`qr`/`table`/`chart`/`stamp` node types (drawing from the editor-baked
`result`/`modules`/`cells`/`series` data). `path` nodes now fill with gradients, images, and patterns too (not solid only),
on rect/polygon/star and ellipse shapes. Design PNG/JPEG AND SVG export now
inline referenced image/pattern asset bytes (shared `embedNodeAssets`/
`embedDesignFileAssets`; SVG's `imageBody` prefers the inlined `src`), and SVG
shape image/pattern FILLS emit `<pattern>`/`<image>` defs, so images render
across every export path (PDF already resolved images via `pdfImageSource`). The
chart renderer is now a full port of the browser `drawChart`: title / legend /
axis labels / Y-axis ticks (chrome), the exact `seriesPaletteHex`, and every
kind (bar/grouped/stacked, line, area, pie, donut, scatter, radar; gauge/funnel/
progress render as a line chart, exactly as the browser does). `stamp` glyphs
render as colored vector icons for the fixed whiteboard stamp set
(🔴🟢🟡⭐👍👎❤️🔥✅❓💡🎯); `sticker`/`icon`/`embed`/`video` still nodes fall back to
the neutral placeholder the browser draws, so nothing exports as a blank hole.
SVG export now also renders `qr` (background + module path + optional center
logo `<image>`) and `stamp` (the glyph in an emoji font stack, so a browser
viewing the SVG shows the real color emoji), and SVG image-fill sizing uses a
userSpaceOnUse pattern so cover/contain fit is exact for any aspect ratio (not
just square shapes). Server raster text now draws in an embedded Arial-metric
fallback (Liberation Sans, SIL OFL 1.1; `fallbackfont.go`) instead of the Go
font, so width-driven layout (chart legend fitting, table alignment, text wrap)
matches the editor's system-ui metrics far more closely.
Covered by `TestRasterTextWrap`, `TestEmbedDesignFileAssets`, and the
`nodes_extra_test.go` suite (path/ellipse fills, SVG embedding + image fill +
non-square fit, SVG QR/stamp, stamp glyphs, QR logo + size, chart bar + chrome).
Known fidelity caveats (not blank-render bugs): server text is still not
glyph-identical to a viewer's exact system font (metrics now match closely via
Liberation Sans); RASTER export of arbitrary emoji `stamp` glyphs outside the
fixed vector set needs an emoji font server-side (SVG export renders them as
emoji text); SVG image-fill crop/focal isn't expressed in the pattern. Pattern
"mirror" repeat intentionally tiles, matching the browser's `paintPattern`.

- [x] **P1.1 Render scene-node elements as clips.** DONE in all three paths.
  Browser: `Clip.element` (embedded `@hc/schema` Node) -> `renderScene` -> offscreen
  -> `DrawSource` in `frontend/src/lib/video/playback.ts`. Server: element clips
  rasterize to a staged PNG (`ToPNG`) and composite as a looped-image overlay in
  `backend/internal/render/timeline.go` (paths passed via `TimelineOptions.ElementFiles`,
  staged in `internal/httpapi/export.go`).
- [x] **P1.2 Still images as timed elements.** DONE (all three paths). A `+Image`
  action opens a workspace-image picker; picking one creates an `image` element clip
  (`Clip.element`, cover fit, real dimensions probed) registered with the shared
  `imageAssets` provider. Browser draws via `renderScene`; server MP4 rasterizes via a
  new `case "image"` in `raster.go` (image bytes embedded as a data URL by the export
  handler, scaled with `x/image/draw`). Verified: live smoke (uploaded image fills the
  stage) + `TestRasterImageElement`. Reuses the stock/uploads model (no new provider).
  Follow-ups: image upload from within the video editor, Stock-panel photos (P3.4),
  positioning/resize (P2/P3), and design PNG export image support (separate gap).
- [x] **P1.3 Solid/blank colored background page.** DONE via the `+Background`
  toolbar action: inserts a full-stage solid-color rectangle element clip (default
  white, 5s) on an overlay track. Renders in preview, exact export, AND server MP4.
  The background color is now editable from the clip inspector (Background section:
  a fill color picker on the selected background element).
  A brand-new video now OPENS on a blank WHITE page (design-first onboarding):
  the init effect sets the stage `background` to white, so the editor starts on a
  white canvas instead of a black stage. The stage background IS the page (no
  redundant white rectangle layered over a black base); it stays editable from the
  video settings Background picker, and all three render paths honor it (preview
  compositor, exact export, and the Go MP4 base canvas via `cssColorToFF`). Only
  new videos are affected (the seed runs when `meta.video` is absent); existing
  videos are untouched.
- [x] **P1.4 Full styled text elements.** DONE: a `+Text` toolbar action inserts a
  real centered `TextNode` element via `Clip.element` (default "Your text", system
  font, 700 weight). Renders in preview, exact export, AND server MP4 (browser
  `renderScene`; server `raster.go rasterText`). The legacy text-track title cards
  remain as "+Text track". A Text section in the clip inspector now edits the
  content, font family (from the bundled catalog), size, color, bold, and alignment
  (see P3.5). Verified end to end: editing the inspector text persists to
  `meta.video` and re-renders the stage.

## Phase 2. Scene / page model

STATUS: core done. Elements now belong to a scene (page) via `Clip.sceneId`;
adding text/image/background at the playhead JOINS the scene there, and scenes lay
out as contiguous blocks. A scenes strip in the toolbar adds/jumps/reorders/
duplicates/deletes scenes. Verified live (bg+text = 1 scene; +Scene = 2; duplicate
= 3; delete = 2; contiguous packing persisted) + `packScenes`/`listScenes` unit tests.

- [x] **P2.1 Scene primitive.** `Clip.sceneId` (@hc/timeline) + pure helpers
  `listScenes` / `sceneAtFrame` / `packScenes` (contiguous re-pack). A scene is the
  set of element clips sharing a sceneId, occupying one contiguous time block.
- [~] **P2.2 Scenes strip.** DONE: +Scene, click-to-jump, reorder (‹ ›), duplicate,
  delete, and a per-scene DURATION field (seconds) that retimes all the scene's
  element clips and re-packs the following scenes contiguously. Verified: setting a
  scene to 2s retimes it and shifts the next scene's start to 2s. REMAINING: scene
  thumbnails and drag-reorder (arrows + the numeric field cover the essentials).
- [x] **P2.3 Compose text + image + shapes on one scene.** Elements added at the
  playhead join the current scene on stacked overlay layers (bg + text + image on
  one page), verified.
- [x] **P2.4 Scene transitions.** DONE (basic): a per-scene ENTRANCE transition
  cycled from the scene chip (none / fade / crossDissolve / slide / wipe), applied as
  `transitionIn` on all the scene's element clips, so preview and MP4 both honor it.
  Verified: clicking a scene's transition control sets its clips' transitionIn.
  REMAINING: true cross-scene overlap crossfade (today the entrance plays against the
  stage background, i.e. a fade/dip-in), and a dedicated picker vs the cycle button.

## Phase 3. Content-insertion parity with the design editor

- [~] **P3.1 Content insertion in video.** Rather than porting the design ToolRail
  (whose panels drive the design store, not `meta.video`), the video editor grew a
  NATIVE insertion toolbar that covers the same intent: Templates, +Background,
  +Text (heading/subtitle/body/quote/lower-third presets), +Image (workspace uploads
  + stock-photo search), +Shape (rect/ellipse/triangle/star/divider), +Scene, and
  Animate all, plus on-stage select/move/resize and a full element inspector. This is
  the deliberate design for video. REMAINING (optional): surfacing the Brand kit and
  Uploads-management panels inside the video editor, and drag-from-panel inserts.
- [x] **P3.2 Position / resize elements on the video stage.** Clicking an element on
  the stage selects it (hit-test on the node's own bounds), a selection box with
  corner handles hugs it, dragging the body repositions it and dragging a corner
  resizes it, both pixel-accurate via the stage-point mapping and keeping a text
  node's layout `box` in sync; the clip inspector's Layout section (X / Y / W / H)
  does the same numerically. Verified: a 150px drag moves the node the matching
  stage distance, an SE-handle drag grows w/h by the matching amount, and both
  round-trip to `meta.video`. Drag-from-panels (dropping a NEW element from a panel)
  remains, and pairs with the full ToolRail in video (P3.1).
- [~] **P3.3 Shapes / graphics / stickers / lines / frames** as timed elements.
  DONE (shapes/lines): a `+Shape` toolbar menu inserts rectangle, rounded rectangle,
  ellipse, triangle, star, or divider element clips (centered, accent fill), joining
  the scene at the playhead. Renders in preview, exact export, AND server MP4 (the Go
  rasterizer already handles shape/line nodes). Verified: +Shape ellipse persists to
  `meta.video` and renders on the stage. REMAINING: stickers/graphics/frames from the
  content panels (needs P3.1's ToolRail in video). On-stage move/resize + numeric
  positioning/resize now ship (P3.2).
- [x] **P3.4 Stock photos into video.** The +Image picker has a stock-photo
  search: results come from the same `/stock/search` provider layer as the design
  editor, and picking one imports it into the workspace uploads (`importAssetFromUrl`)
  then places it as an image element. Importing first (rather than hotlinking) gives
  the photo a real asset id, so the server MP4 export embeds its bytes and the video
  never depends on an external host, and provenance/attribution is preserved. Verified
  end to end: search -> import -> image element persisted to `meta.video` with a real
  workspace asset id. (A full Stock ToolRail panel + drag-onto-stage still waits on P3.1.)
- [~] **P3.5 Rich text styling for video text:** DONE (core + spacing): the clip
  inspector's Text section edits content, font family (bundled catalog), size,
  color, bold, alignment, LETTER SPACING, and LINE HEIGHT on a selected text
  element (spacing/line-height are honored by both the engine renderer and the Go
  raster text layout, so they stay faithful across all paths), plus a shape's fill
  and an image's fit. REMAINING: shadow / outline / glow / gradient / curved layout.
  These render in the browser preview + exact export (the engine supports them) but
  the Go server raster draws plain text, so exposing them would diverge the server
  MP4 (same class as the server font fallback). Best closed with server text-effect
  support / the accelerated render path.

## Phase 4. Motion: animations, Ken Burns, transitions

STATUS: node animation is wired across the render paths. The clip inspector has an
Animation section (entrance / emphasis / exit pickers, plus Ken Burns / parallax on
image elements), writing `NodeAnimation` / `ImageMotion` onto the element node. The
browser preview and the exact in-browser export pose the element via the shared
engine poser (`poseDesignAt`, + an exit over the clip tail), and the server ffmpeg
MP4 poses per frame via a Go port of the animation math (`backend/internal/render/anim.go`),
staging each animated element as a posed PNG SEQUENCE composited over the clip span.
Verified: browser smoke (a fade entrance drops the element to 0 ink at t=0 and back),
pose-math unit tests, and an ffmpeg E2E (an animated element is dark early, opaque
later). A latent server bug was fixed en route: element PNGs now stage on a
TRANSPARENT background (`ToElementPNG`), so a partial/faded element no longer arrives
as an opaque white card that occludes lower tracks.

- [x] **P4.1 Wire NodeAnimation into the video UI.** Entrance / emphasis / exit pickers on the selected element in the clip inspector (Animation section), plus a photo-motion picker for images.
- [x] **P4.2 Render node animations in playback AND server export.** Browser + exact export pose via `poseDesignAt`; the server MP4 poses per frame (Go `PoseElementNode`) into a PNG sequence overlaid over the clip. Both honor `NodeAnimation` (entrance/exit/emphasis) and `ImageMotion`. LIMITATION: custom keyframe tracks (`animation.custom`) and typewriter/word-wipe text reveal are honored in the browser but not yet in the Go server port (the video UI does not author either, so UI-made videos are consistent; a node imported from a design carrying one would render its transform but not its per-frame content reveal server-side).
- [x] **P4.3 Honor an element's existing animation** when a node authored in a design/presentation is used in a video. The poser reads `node.animation` / `node.motion` regardless of origin, so a pre-animated node animates in the video too.
- [x] **P4.4 Ken Burns / pan-zoom on images.** Photo-motion picker (Ken Burns zoom / parallax pan) on image elements; posed via the engine's `imageMotionPatch` in the browser and the Go port server-side.
- [x] **P4.5 Emphasis / looping animations** (pulse, wiggle, spin, breathe, tada, flicker, jiggle, bob) that loop while the element is on screen.
- [x] **P4.6 "Animate all" + per-element sequencing.** An "Animate all" toolbar
  action staggers an entrance across the current scene's elements (skipping the
  full-stage background), giving each element the same preset with an increasing
  explicit `delayMs`. Using explicit delays (rather than startMode resolution)
  means the staggered build is honored identically in preview, exact export, and
  the server MP4. Verified: entrances land at delays [0, 150, 300] ms and the
  background stays static.
- [~] **P4.7 Transition variety + direction control.** DONE (directions): slide and
  wipe take a `direction` (from left / right / top / bottom), editable per edge in
  the clip inspector (additive `ClipTransition.direction`; older projects unchanged).
  Slide directions render faithfully in preview, exact export, AND the server MP4 (a
  time-varying overlay x/y expression, `slideOverlayXY`); wipe directions render in
  preview/exact export (the server still approximates wipe as a fade, see P4.8).
  Verified: a slide-up persists and its server MP4 is white on top / black on bottom
  mid-transition; the direction picker round-trips to `meta.video`. REMAINING: zoom,
  flip, and push. These need per-frame SCALE / 3D transforms that Canvas2D and the
  ffmpeg-overlay path cannot do faithfully across both surfaces; they belong with the
  accelerated WebGL/WebGPU render path on the main roadmap (not a footgun to fake).
- [~] **P4.8 [BUG] Faithful server-side wipe/slide transitions.** SLIDE is now
  faithful: the server MP4 moves the clip via a time-varying `overlay` x-expression
  (`slideOverlayX`) matching the browser compositor (in: enters from the left -W->0;
  out: exits right 0->+W), instead of downgrading it to a fade. Verified by an ffmpeg
  E2E (a sliding element is white on the left and black on the right mid-transition,
  full white once settled), including directional slides (P4.7). REMAINING: WIPE
  still approximates as a fade server-side (a faithful left-to-right pixel reveal
  needs a per-frame alpha mask, which the ffmpeg-overlay path cannot express cheaply;
  the browser preview/exact export do it with a canvas clip, incl. direction). Best
  revisited with the accelerated render path. Applies to media and element clips.

## Phase 5. Templates and conversion

- [x] **P5.1 Video starter templates.** A `Templates` toolbar menu offers starter
  designs (Title intro, Promo 3-scene, Animated slideshow, Bold statement), defined
  in `frontend/src/lib/video/videoTemplates.ts` as contiguous scenes of element nodes
  (background + animated text). Applying one APPENDS its scenes after any existing
  content (never destructive) on fresh overlay tracks and jumps the playhead there;
  for a new empty video it fills the timeline. Verified: "Animated slideshow" adds 3
  scenes (3 backgrounds + 6 text, 6 with entrance animations) to `meta.video`.
- [x] **P5.2 Text style presets, animated title templates, lower-thirds.** The
  +Text toolbar button is now a preset menu: Heading, Subtitle, Body copy, Quote,
  and Lower third (which drops a translucent bar plus its label as one insert).
  Combined with "Animate all" (P4.6) these cover animated titles and lower-thirds.
  Verified: the lower-third inserts a bar + text together (one persist), and the
  presets land as styled text elements. Full-page animated templates are P5.1.
- [~] **P5.3 Design/presentation to video.** DONE (structure + motion): a "Convert
  to video" action in the design editor's overflow menu (shown for multi-page decks)
  turns each page into a contiguous SCENE, a background element plus one element clip
  per top-level page node, preserving each node's `NodeAnimation` and mapping the
  page's slide transition to the scene's clip transition. Client-side and
  non-destructive (a new video document; the deck is untouched); it opens the result.
  Conversion lives in `frontend/src/lib/video/deckToVideo.ts`. Verified: a 2-page deck
  (an animated shape + a slide-transition page) converts to a 2-scene video with the
  entrance animation and slide transition preserved, and a page's authored
  `autoAdvanceMs` becomes its scene duration (verified: 2000ms -> a 2s scene).
  REMAINING: carrying the deck's audio/voiceover onto the video timeline, and full
  posing of animations nested inside a group node in the server export (browser-only,
  same limit as custom keyframe tracks).

## Phase 6. Built-in media libraries

- [ ] **P6.1 Stock video (b-roll)** in the Stock panel and video editor. BLOCKED
  on a source decision: there is no keyless open stock-VIDEO API (Openverse is
  images only) and the keyed providers (Pexels/Pixabay) were dropped; bundling
  video is heavy. Needs a maintainer call (enable a keyed provider, or bundle a
  small CC0 set) before it can be built.
- [ ] **P6.2 Music + sound-effects library** (royalty-free), with a one-click add.
  Feasible by bundling a small curated CC0 set (like the illustration packs),
  but needs sourcing + adds binary size, a maintainer call on scope/source.
- [x] **P6.3 Curated font pairings for video text.** DONE. The +Text menu now has
  a "Font pairings" section (Bold & clean, Elegant serif, Modern, Editorial,
  Impact, Statement); picking one drops a heading + subheading in the paired fonts
  as one scene, using the full bundled font library. En route this fixed a latent
  gap: the video path never LOADED webfonts, so a non-system font (P3.5, and any
  pairing) rendered as the system fallback in the browser preview/exact export.
  Now VideoSurface lazy-loads the webfonts used by text element clips (fonts.ensure)
  and drops the cached element rasters when a font arrives (`player.invalidateElements`),
  so the real face renders in preview + exact in-browser export. (Server MP4 still
  uses a fallback font unless registered, the documented `RegisterFont` limit.)
  Verified live: a "Bold & clean" pairing inserts a Montserrat heading + Open Sans
  subheading (persisted to `meta.video`) and both fonts load from Bunny.

## Phase 7. AI, captions, and publish

- [ ] **P7.1 Auto-captions / speech-to-text transcription** (captions are manual-only today).
- [~] **P7.2 Multi-language subtitle tracks.** DONE (manual multi-track): the
  captions editor gained a Language track selector, add a track (per BCP-47 lang),
  switch the active track, rename its lang inline, and delete it. All cue editing,
  styling, SRT/VTT download (now per-language filename), and the burn-in preview
  target the ACTIVE track; the server export already receives every track. Caption
  helpers (`captions.ts`) were generalized to address a track by id
  (`withCues`/`withCaptionStyle` + `addCaptionTrack`/`removeCaptionTrack`/`setCaptionLang`).
  Verified: a unit test (edit/rename/remove a track by id leaves others intact) and
  a live smoke (a cue on track 1, +Language, a cue on track 2 = two tracks each with
  one cue). REMAINING: AUTO-translation (generating a track in another language),
  which needs the BYO-key AI layer (a P7 AI item), and multiple burned/sidecar
  subtitle streams in the server MP4 (today one track burns; all are sent).
- [x] **P7.3 Beat sync.** A pure energy-flux onset detector (`frontend/src/lib/video/beats.ts`,
  unit-tested against a synthetic click track) decodes a selected audio/video clip
  (`decodeMono`) and a "Detect beats" clip context-menu action adds the onsets as
  ruler markers within the clip's span. Markers are already snap targets
  (`snapTargets`), so cuts and clip edges snap to the beat. Verified: 3 unit tests
  (grid detection, silence + debounce, frame mapping).
- [ ] **P7.4 AI background removal** for arbitrary images/video (today only true green-screen keying works).
- [ ] **P7.5 Text-to-video / image-to-video** (Magic Animate), via the bring-your-own-key AI layer.
- [ ] **P7.6 AI text-to-speech voiceover.**
- [ ] **P7.7 AI music generation / soundtrack matching.**
- [x] **P7.8 Timeline-synced voiceover recording.** DONE: a "Voiceover" toolbar
  action starts the mic AND plays the timeline from the playhead, so you narrate
  to the picture; on stop (button, pause, or the playhead reaching the end) the
  take uploads and drops in as an audio clip at the frame recording began (its own
  audio lane if the sync spot is occupied), reusing `uploadAssetWithProgress` +
  `probeMedia`. Verified live (fake mic): a 5s recording auto-stopped at the
  timeline end and landed as a ~5s "Voiceover" audio clip at frame 0 with a real
  asset id.
- [~] **P7.9 Publish / watch page.** DONE (watch page): a shared video now opens
  in a lightweight public WATCH player (`frontend/src/components/VideoWatch.tsx`) via
  the existing share link, a canvas stage plus play/pause and a scrubber, reusing the
  editor's compositor + playback engine with no editor chrome. `SharedViewer` routes
  `meta.kind === "video"` docs to it (design/deck docs unchanged). Design-videos
  (element clips) play fully client-side; footage/audio/image media resolve to the
  PUBLIC `/assets/{id}/content` route by asset id (a video doc carries no assets[]
  manifest, so the kind is derived from the project: audio-track clips are audio,
  others video, and element image nodes register with the image provider). The
  content route is anonymous (confirmed: an unauthenticated request returns 200), so
  a link-holder loads the media without a session. Verified live in an
  anonymous (incognito) context: the share link shows "Video · View only" with a
  player, and pressing play advances the playhead (frame 0 -> 66) with the stage
  rendering. REMAINING: DIRECT PUBLISH to social platforms (needs per-platform OAuth
  apps / credentials, a maintainer decision), and optionally publishing a
  pre-rendered MP4 (vs replaying the live timeline) for heavy-footage videos.

## Notes

- Phase 1 is the hard, foundational engineering (three render paths must agree:
  browser playback compositor, exact/in-browser export, and the Go ffmpeg
  renderer). Once elements composite in all three, Phases 2-4 are mostly UI +
  reusing existing design-engine capabilities.
- Zero-data-loss: any new video primitives (scene, element clip, per-scene
  background) are additive schema changes, bump `currentSchemaVersion` in both
  `packages/schema/src/schema.ts` and the Go mirror, and provide a forward
  migration; older video files must keep opening.
- The clip/footage editor (`video-editor-backlog.md`) stays; this is a parallel
  authoring model, not a replacement.
- Known cross-path fidelity limits (the exact in-browser export is glyph/effect
  true; the server ffmpeg MP4 degrades gracefully): server text uses a fallback
  font unless real fonts are registered (`render.RegisterFont`); text effects
  (shadow/outline/glow/gradient/curved, P3.5) and custom keyframe / typewriter
  reveals are browser-only in the Go path; wipe downgrades to a fade (P4.8). These
  are best closed alongside the accelerated (WebGL/WebGPU) render path and a
  server font-registration step for exports.
