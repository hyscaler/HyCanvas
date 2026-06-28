# Editor Parity Backlog (Canva-level gaps)

A grounded gap analysis of the HyCanvas editor against Canva, produced by auditing the actual code (`frontend/src/components/editor`, `frontend/src/store/editor.ts`, `packages/*`). Use this to pick up work; check items off as they ship.

Re-audited against the code on 2026-06-23: several items previously marked missing were already shipped (curved text, connectors UI, hover/click interaction states, rulers + drag-to-add guides, CVD preview in the picker, the keyframe timeline, continuous multi-page scroll, shaped frames, and keyboard-shortcut remapping). Those are corrected below so the backlog reflects reality.

## Legend

- Status: **M** = missing entirely, **W** = exists but weak/shallow, **D** = exists but poor discoverability.
- Priority: **P1** = Canva-defining, high user impact. **P2** = important depth. **P3** = polish / advanced.

## P1 - High impact

### Canvas and pages
- [x] **Continuous multi-page vertical scroll** (DONE): pages render stacked vertically (engine `clear:false` composites pages onto one canvas, continuous-scroll mode in `Canvas.tsx`); wheel/trackpad scrolls through them; clicking a page activates it; picking a thumbnail scrolls it into view. Editing/selection/gizmo stay on the active page. Single-page docs unchanged.
- [x] **Floating selection toolbar** (DONE): `SelectionToolbar.tsx`, a hovering bar above the selection with Duplicate, Lock/Unlock, Bring-to-front, Send-to-back, Delete. Flips below near the top edge; hidden for viewers/preview/crop/present.
- [x] **Quick actions on hover/gizmo** (DONE): covered by the floating toolbar.
- [x] **Zoom control on the whiteboard surface** (DONE): the `ZoomControl` (zoom in/out, % presets, fit, zoom-to-selection) was extracted to a shared component and now renders on the whiteboard surface too, matching the design editor (it was previously design-only).

### Text and typography
- [x] **Text effect presets** (DONE): one-click Shadow / Lift / Hollow / Splice / Glow / Neon on top of manual shadow/outline/glow. (Background highlight still pending, separate mechanism.)
- [x] **Curved / warped text** (DONE): `TextFlow kind:"arc"` renders in the engine (`render2d.ts`, glyph rotation on a circle) and is driven by a Curve slider in `PropertiesPanel.tsx`.
- [x] **Font combinations depth** (DONE): 12 curated pairings; recent fonts surfaced.
- [x] **Font upload + cross-device** (DONE): upload `.ttf/.otf/.woff` in the Text panel; it registers into `document.fonts`, persists in localStorage for this browser, AND embeds in the design (`doc.fonts` data-URL FontRef) so it loads on any device that opens the design (`fontProvider.ensureForDoc`). Brand fonts read-only.
- [x] **Underline / strikethrough + justify** (DONE): render with UI buttons; justify distributes slack across non-last lines.

### Color, gradients, fills
- [x] **Gradient depth** (DONE): per-stop opacity, 12 presets, angle, and now radial/conic center (X/Y) + radial radius controls in the gradient editor. (Explicit RGB/HSB numeric sliders in the picker remain a minor nicety.)
- [x] **Gradient on text and stroke** (DONE): text fills and strokes both support gradients with a toggle + editor.
- [x] **Recently used colors** (DONE): a "Recent" swatch row (last 12, localStorage) under the fill and text pickers.
- [x] **Gradient discoverability** (DONE): a Solid/Gradient toggle sits at the top of the Fill section (and a Gradient toggle on text), so the gradient editor is one click from any fillable selection.

### Elements and tools
- [x] **Graphics / stickers library** (DONE): a bundled set of ~48 free editable-vector stickers across Shapes / Symbols / Fun in a "Graphics" section of Elements (plus the "Animated" set), inserted as recolorable vectors. Can still wire an external provider later.
- [x] **More shapes** (DONE): Diamond, Octagon, Burst, Pill added (11 total). Room for speech bubble / blob / chevron later.
- [x] **Element search by intent** (DONE, heuristic): a deterministic synonym map turns plain-language stock queries ("something for a party" -> celebration, "make me happy" -> happy, etc.) into catalog terms. True embedding/semantic search lands with the F39 AI studio.

### Animation
- [x] **More animation presets** (DONE): ~26 now (entrance incl. tumble/stomp/zoom/typewriter/word-wipe; exit incl. tumble-out/zoom-out; emphasis incl. flicker/jiggle/bob).
- [x] **Text animations** (DONE): "Typewriter" (character reveal) and "Word wipe" (word-by-word) entrances reveal a text node's content over the clip, via the shared engine `revealEntranceText` so they render in the editor "Play" preview, present mode, AND animated export. Per-character emphasis is an optional future add.
- [x] **Animation timeline / sequencing** (DONE): a per-element keyframe timeline (`KeyframeEditor`) plus cross-element sequencing via a Start mode (On delay / With previous / After previous, `AnimationClip.startMode`), resolved in `poseDesignAt`/present timing. A full page-wide track-grid view is an optional future visualization.

## P2 - Important depth

### Canvas and pages
- [x] **Object-level shadow/glow for all elements** (DONE): a reusable effects control (presets + shadow/outline/glow) shown for shapes, lines, frames (single selection).
- [x] **Opacity slider** (DONE): opacity slider + blend-mode select in the panel.
- [x] **Page preset sizes when adding a page** (DONE): the add-page button has a size-preset dropdown (Instagram, Story, 16:9, A4, ...); `addPage(size?)`. (Full per-page starter templates remain a later content task.)
- [x] **Grids and margin guides + ruler-drag-to-add-guide** (DONE): rulers ship; guides are draggable from the rulers; snap to grid/guides works. (Per-page margin presets could still be added.)
- [x] **Page transition preview + inline page rename** (DONE): transition UI + preview ship; the pages bar now shows the page name and double-click renames it inline (`setPageName`).
- [x] **Select by type / select all of a kind + marquee modifiers** (DONE): "Select all of type" in the context menu (`selectSameType`); Shift-marquee adds, Alt-marquee subtracts.

### Text
- [x] **List depth + markers** (DONE): indent/outdent levels, bullet/number/checklist types, and a bullet-marker style picker (• ◦ ▪ – ➤ ✓, via `list.marker`). Deeply-nested outline view is a future nicety.
- [x] **Links on text runs** (DONE): a per-run Link field in the Text panel sets `run.style.link` on the selected range; clickable in present/preview (`setChar({ link })`).
- [x] **Text box modes** (DONE): Fixed / Auto H / Auto W switcher in the Text panel (`setTextBoxMode`), driving `box.mode`.
- [x] **Columns** (DONE): `@hc/text layoutText` now flows text into N columns (wrap at column width, reflow lines across columns by height, tag each line with its column left/width); the renderer aligns per column; a 1/2/3 Columns control sits in the Text panel. Single-column layout is unchanged.

### Color and fills
- [x] **Image fill on shapes** (DONE): the engine clips an image to any shape outline and cover-fits it; set via an "Image fill" button or by dragging an image onto a shape. Clear reverts to solid.
- [x] **Image color extraction** (DONE): an "Extract palette" button in the Image panel samples the selected photo and surfaces its dominant colors as swatches (reuses `@hc/color extractPalette`); picked colors flow into recents.
- [x] **Color harmony suggestions** (DONE): a new `@hc/color` `colorHarmony` (complementary/analogous/triadic/tetradic/split-complementary/monochromatic) drives a Harmony picker under the fill color; picking applies it.
- [x] **Pattern fills** (DONE): the engine now tiles a `PatternFill` image (clipped to the shape, scale/rotation via the pattern transform, `createPattern`); a "Pattern fill" button + scale slider in the shape Fill section (`setPatternFill`/`setPatternParams`). Mirror repetition falls back to tile on Canvas2D.

### Elements and media
- [x] **Connectors / elbow lines UI** (DONE): `connector` node (straight/elbow/curved) inserts via the store (`connectNodes`, plus the whiteboard `ConnectorDragLayer` drag-to-connect UI), renders in the engine, attaches to nodes and re-routes. (Free-form joint dragging could still be deepened.)
- [x] **Frames library + shaped frames** (DONE): rectangular, circle, and rounded frame presets ship in Elements plus the shape->frame conversion and `setFrameShape` (rect/ellipse). Exotic silhouettes (devices, custom paths) can be added as content later.
- [x] **Tables advanced** (DONE): per-cell styling, row/column insert-delete, and merge/split cells all ship. The schema already carries `rowSpan`/`colSpan` and the engine renders spans; `mergeTableCell`/`splitTableCell` + Merge →/↓ and Split buttons drive it.
- [x] **Chart data table editor + more chart types** (DONE): 12 chart types render and insert; the chart panel now has an editable data grid (rows = categories, columns = series, add/remove either, edit names and values) that commits through `setChart`.
- [x] **Photo grids / grid layouts** (DONE): a photo grid inserts as a `grid` container whose cells are image frames laid into cell rects (`insertPhotoGrid`); the engine renders the container's children (no engine change needed), drop a photo onto a cell to fill it, and a rows/cols/gap editor re-lays the grid (`setGridLayout`). Insert tiles (2x2 / 3x3 / 2x3) in Elements.
- [x] **Video element on canvas + trim** (DONE): the asset provider loads videos as `<video>` so the engine draws the current frame; a Video panel scrubs, plays/pauses (repainting per frame), sets trim in/out, mute, and loop (`setVideoProps`).
- [x] **Brush/pencil depth** (DONE): a brush-options bar (size / opacity / color) appears when the pencil tool is active and feeds new strokes via the store's `brush` settings.
- [x] **Recently used elements** and **shape replace/swap** (DONE): shape replace/swap ships (a Swap shape row, `setShapeKind`); the Elements panel now shows a "Recently used" section of the last inserted tiles (localStorage), one click to re-insert.

### Animation and interactivity
- [x] **Combined entrance + exit + emphasis per element** (DONE): stored as separate fields; an element can hold all three.
- [x] **More page transitions + true morph** (DONE): 9 now (fade, slide, push, dissolve, morph-lite, wipe, flip, zoom, and **Morph / magic move**). Magic Move matches elements shared across two slides by id (falling back to a unique name, covering duplicate-then-edit), hides them in the cross-fade buffers, and renders them tweened (position/size/rotation/opacity) on top so they glide into place; non-shared content cross-fades.
- [x] **Hover/click visual states** (DONE): interactions support click/hover triggers with actions (`setInteraction`, UI in `PropertiesPanel.tsx`).
- [x] **Per-element easing** (DONE): 9 named curves (linear, ease-in/out/in-out, spring, ease-in/out-cubic, back, bounce) plus a freeform **cubic-bezier** curve (CSS-style [x1,y1,x2,y2], `cubicBezierEase` solver + `clipEase`, with a Custom-curve toggle and 4 control inputs). It overrides the named easing when enabled.

## P3 - Polish and advanced

- [x] **Mini-map / zoom overview** (DONE): a corner overview (`MiniMap`) renders the active page with a viewport rectangle; click or drag in it to pan. Hidden when the whole page already fits.
- [x] **Lock canvas / lock all** (DONE): "Lock all on page" / "Unlock all on page" in the canvas context menu (`lockAllOnPage`), plus the existing page-level lock.
- [x] **Keyboard shortcut remapping** (DONE): `ShortcutsEditor.tsx`. Nudge-distance options still W.
- [x] **Pivot / rotation origin control** (DONE): a 3x3 pivot picker sets `transform.origin` (normalized 0..1); the gizmo then rotates about that point by recomputing the node's position (rigid rotation about the pivot). Implemented entirely in the editor/gizmo, with NO change to the shared `fromTransform` matrix, so the core coordinate system is untouched. Default (no origin) = center.
- [x] **Variable font axes beyond weight** (DONE for the Canvas2D-expressible axes): `wght` (weight), `wdth` (mapped to a CSS font-stretch keyword the canvas applies to the width axis, with a Width slider), and `ital`/`slnt` (italic) now render. `opsz` and arbitrary axes still await the GPU/text-shaping path (F03).
- [x] **Small caps + OpenType details** (DONE): small caps (Case dropdown), ligatures toggle (`features.liga`), tab stops (`tabStops`/`tabRunWidth`), and baseline shift all render. Only automatic kerning-pair adjustment is unimplemented (manual letter-spacing covers the practical need).
- [x] **Language + spellcheck** (DONE): the inline editor enables browser spellcheck and applies a per-text-node language tag (BCP-47, set via a Language field, `setTextLang`) to the contentEditable's `lang`, so spellcheck uses the right dictionary.
- [x] **CVD (color-blind) preview in the picker** (DONE): protanopia/deuteranopia/tritanopia/achromatopsia simulation in `ColorField.tsx` using `@hc/color` `cvd`.
- [x] **Scroll-driven / parallax depth** (DONE): per-image photo motion ships Ken Burns and a coherent same-phase **parallax** drift whose amplitude scales with intensity, so several images at different intensities read as multiple depth layers moving at different rates (`ImageMotionSection`, `imageMotionPatch`). (Pointer/scroll-position-driven parallax is N/A for slide-based present; the continuous-scroll canvas is an editing view, not playback.)
- [x] **Animated stickers / motion-graphics library** (DONE, v1): an "Animated" section in Elements inserts editable-vector stickers with a looping emphasis animation pre-applied (spin/pulse/wiggle/bob/flicker). Can grow the set later.
- [x] **"Magic Animate"** (DONE, heuristic): one click ("✨ Animate all" in the Animate panel) applies tasteful, staggered entrance animations to every element on the page (`magicAnimatePage`), with Clear all. Semantics-driven AI motion is delivered by the shipped AI Creative Studio ([39-ai-creative-studio.md](39-ai-creative-studio.md)).

## Genuinely remaining (post re-audit), grouped

Status: the editor-parity backlog is complete. Everything tractable is shipped, including the items once flagged as engine-limited (columns, variable axes), core-risk (rotation-origin pivot), or research-grade (Magic Move morph, multi-layer parallax). Multi-layer parallax is delivered via coherent per-image parallax intensity; true element-matched morph ("magic move") ships as a page transition.

Dropped (out of scope, by decision, not planned): **element search by intent (semantic / embedding)** - the shipped deterministic synonym layer is the chosen approach and is sufficient; full embedding/semantic search is intentionally not on the roadmap. With this, the backlog has no open or deferred items.
