# Editor Parity Backlog (Canva-level gaps)

A grounded gap analysis of the HyCanvas editor against Canva, produced by auditing the actual code (`frontend/src/components/editor`, `frontend/src/store/editor.ts`, `packages/*`). Use this to pick up work; check items off as they ship.

## Legend

- Status: **M** = missing entirely, **W** = exists but weak/shallow, **D** = exists but poor discoverability.
- Priority: **P1** = Canva-defining, high user impact. **P2** = important depth. **P3** = polish / advanced.

## P1 - High impact (start here)

### Canvas and pages
- [~] **Continuous multi-page vertical scroll** (EXPERIMENTAL, needs visual testing): all pages now render stacked vertically (engine `clear:false` composites pages onto one canvas); wheel/trackpad scrolls through them; clicking a page activates it for editing; picking a thumbnail scrolls it into view. Editing/selection/gizmo stay on the active page (offset by its stacked position), so the coordinate core didn't need a full rewrite. Single-page docs are unchanged (offset 0).
- [x] **Floating selection toolbar** (DONE): a hovering bar above the selection with Duplicate, Lock/Unlock, Bring-to-front, Send-to-back, Delete. Flips below when near the top edge; hidden for viewers/preview/crop/present. (Could later add inline color/font shortcuts.)
- [x] **Quick actions on hover/gizmo** (DONE): covered by the floating toolbar above.

### Text and typography
- [x] **Text effect presets** (DONE): one-click Shadow / Lift / Hollow / Splice / Glow / Neon presets on top of the manual shadow/outline/glow fine-tune toggles. (Background highlight still pending, needs a separate mechanism.)
- [ ] **Curved / warped text** (M): schema has `TextFlow kind:"arc"` but no UI.
- [x] **Font combinations depth** (DONE): expanded from 3 to 12 curated pairings (recent fonts already surfaced). Font upload remains, see below.
- [~] **Font upload** (DONE, client-side): upload a `.ttf/.otf/.woff` in the Text panel; it registers into `document.fonts` (so the canvas renders it), persists in localStorage across sessions, and appears under "Your fonts" in the picker. Server-side storage for cross-device/sharing is a follow-up. Brand fonts remain read-only.
- [x] **Underline / strikethrough + justify** (DONE): underline + strikethrough render with UI buttons; justify now distributes slack across whitespace (non-last lines) in the renderer, with a justify alignment button.

### Color, gradients, fills
- [~] **Gradient depth** (PARTIAL): added per-stop opacity and expanded presets (6 to 12). Still pending: RGB/HSB sliders, radial/conic center/rotation.
- [x] **Gradient on text and stroke** (DONE): both text fills and borders (strokes) support gradients now, with a toggle + the gradient editor. (Engine already rendered gradient strokes via resolveFill.)
- [x] **Recently used colors** (DONE): a "Recent" swatch row (last 12, persisted in localStorage) under the fill and text color pickers.
- [ ] **Gradient discoverability** (D): the gradient editor only appears when a shape is selected; many users won't find it.

### Elements and tools
- [~] **Graphics / stickers library** (DONE, v1): a bundled set of free, editable-vector stickers (stars, badges, banners, nature, etc.) in a "Graphics" section of the Elements panel; click to insert as recolorable vectors. Can grow the set or wire a provider later.
- [x] **More shapes** (DONE): added Diamond, Octagon, Burst, and Pill (11 total). Still room for speech bubble / blob / chevron later.
- [ ] **Element search by intent** (M): only literal text search, no "I want a ..." discovery.

### Animation
- [ ] **More animation presets** (W): 15 total (6 entrance / 4 exit / 5 emphasis). Canva has many more (wipe, tumble, neon, baseline, stomp, typewriter).
- [ ] **Text animations** (M): no typewriter / character-reveal / word-wipe; all current animations are spatial transforms.
- [ ] **Animation timeline / sequencing UI** (M): no track view, no per-element ordering ("with/after previous").

## P2 - Important depth

### Canvas and pages
- [x] **Object-level shadow/glow for all elements** (DONE): extracted a reusable effects control (presets + shadow/outline/glow) now shown for shapes, lines, and frames (single selection).
- [x] **Opacity slider** (ALREADY PRESENT): the panel already has an opacity slider + blend-mode select (audit was wrong).
- [ ] **Page templates / preset sizes when adding a page** (M).
- [ ] **Grids and margin guides** per page (M); ruler-drag-to-add-guide affordance (W).
- [ ] **Page transition preview** in the pages bar; page rename inline (W).
- [ ] **Select by type / select all of a kind** (M); marquee add/subtract modifiers (W).

### Text
- [~] **List depth** (PARTIAL): added indent/outdent level controls (engine indents by level). Marker styles and nested-outline view still pending.
- [ ] **Links on text runs** (M): schema supports it; no inline link UI.
- [ ] **Text box modes** (W): auto-height / auto-width modes exist in schema, only fixed-box editing in UI.
- [ ] **Columns** (M): `TextBox.columns` in schema, no UI.

### Color and fills
- [~] **Image fill on shapes** (DONE, needs visual test): the engine clips an image to any shape outline and cover-fits it; set via a "Image fill" button (URL) in the Fill section or by dragging an image onto a shape. Clear reverts to solid.
- [ ] **Image color extraction** (M): "pick palette from this photo" (logo extraction exists, generalize it).
- [ ] **Color harmony suggestions** (M): complementary/analogous/triadic.
- [ ] **Pattern fills** (M).

### Elements and media
- [ ] **Connectors / elbow lines UI** (M): schema `connector` node exists (straight/elbow/curved) but no insert or joint-edit UI. Key for whiteboard.
- [ ] **Frames library + shaped frames** (W): only a plain rectangular frame.
- [ ] **Tables advanced** (W): merge-cell UI, row/column insert-delete, per-cell background styling (schema supports merge already).
- [~] **Chart data table editor + more chart types** (PARTIAL): added insert tiles for grouped/stacked bar, scatter, radar (already rendered + in the type dropdown). A proper data-table editor is still pending.
- [ ] **Photo grids / grid layouts** (M): schema `grid` node exists, unused.
- [ ] **Video element on canvas + trim** (W): video lives only in the separate Video surface; no inline video node + scrubber.
- [ ] **Brush/pencil depth** (W): freehand exists but no width/opacity/color controls.
- [ ] **Recently used elements** and **shape replace/swap** (M).

### Animation and interactivity
- [x] **Combined entrance + exit per element** (ALREADY WORKS): the Animate section stores entrance/exit/emphasis as separate fields and the tab `set` preserves the others, so an element can have entrance + exit + emphasis at once (audit was wrong).
- [ ] **More page transitions** (W): 5 today (fade/slide/push/dissolve/morph-lite) vs Canva's 10+; true element-matched morph.
- [ ] **Hover/click visual states** (M): interactions only navigate/link; no pressed/hover state swap for prototypes/websites.
- [ ] **Per-element easing curve editor** (W): dropdown presets only, no bezier/spring curve UI.

## P3 - Polish and advanced

- [ ] **Mini-map / zoom overview** (M).
- [ ] **Lock canvas / lock all** (M).
- [ ] **Keyboard shortcut remapping** (M); nudge-distance options (W).
- [ ] **Pivot / rotation origin control** (M); layout constraints/pin-to-edge (M).
- [ ] **Variable font axes beyond weight** (W): WDTH/ITAL/etc. in schema, only `wght` exposed.
- [~] **Small caps** done (renders via the canvas font `small-caps` variant, in the Case dropdown). Kerning / ligatures / tab stops / baseline shift still pending (engine work, low value).
- [ ] **Language + spellcheck** (M).
- [ ] **CVD (color-blind) preview in the picker** (W): `@hc/color` supports it; not surfaced.
- [ ] **Scroll-driven / parallax depth** beyond the fixed Ken Burns loop (W).
- [ ] **Animated stickers / motion-graphics library** (M).
- [ ] **AI "Magic Animate"** that generates motion from element semantics (M).

## Notes on sequencing

- The two highest-leverage P1 items are **continuous multi-page scroll** and the **floating selection toolbar**: both are constantly-visible Canva signatures that change the whole feel.
- Many P1/P2 items are **UI-only** because the schema and pure cores already support them (text effects, curved text, connectors, image fill, more chart types, decoration/justify, variable axes). Those are cheaper than they look.
- A few need new model/engine work (continuous scroll rendering, gradient-on-text, pattern fills, true morph transition).
