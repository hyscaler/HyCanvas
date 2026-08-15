# Accessibility and export-fidelity audit, August 2026

Evidence for F38 AC-1 (WCAG 2.2 AA) and for the export-parity claims in F38 FR-10 and doc 42. Everything below was measured against a real build, not inspected by eye: a production `dist/hycanvas` binary on an isolated Postgres database, driven through headless Chrome, plus a rendering sweep through the three export paths.

## 1. Automated WCAG scan (axe-core)

Method: axe-core 4.12.0 injected into a real page in headless Chrome (CDP), run against a production binary serving the embedded frontend, with a real account, workspace, and design created through the product's own APIs. All rule sets enabled (WCAG A/AA plus axe's best-practice rules); results are violations only.

Result, final run:

| Surface | Violations |
| --- | --- |
| /login | 0 |
| /signup | 0 |
| /dashboard | 0 |
| /settings (account) | 0 |
| /settings/security | 0 |
| /settings/notifications | 0 |
| /editor (design open) | 0 |
| /editor + export dialog | 0 |
| /editor + share dialog | 0 |
| Whiteboard surface | 0 |
| Docs surface | 0 |
| Sheets surface | 0 |
| Video editor | 0 |
| Present mode (audience display) | 0 |
| Design (1920x1080 base) | 0 |

Zero violations of any severity on all fifteen surfaces, including axe's non-WCAG best-practice rules. Raw output: `axe-scan-results.json` beside this file.

What the first run found and what was done about it:

| Finding | Rule | Severity | Fix |
| --- | --- | --- | --- |
| Secondary text at 2.58:1 across the editor and settings | color-contrast (1.4.3 AA) | serious | The neutral ramp's steps 400/500 were Tailwind defaults used as real text. Both now clear 4.5:1 on every chrome background, changed once in `theme.config.mjs` rather than per component. |
| Design-title field had no accessible name | label (4.1.2 A) | critical | `aria-label` on the input. |
| Dashboard sort and collection filter selects unnamed | select-name (4.1.2 A) | critical | `aria-label` on both. |
| Editor and settings had no level-one heading | page-has-heading-one | moderate | The design title is the editor's `h1` (offscreen, inside the banner); "Settings" is the settings `h1`. |
| Panel titles jumped h1 to h3 | heading-order | moderate | Panel shell titles are `h2`. |
| 25 editor nodes and 23 settings nodes outside any landmark | region | moderate | Tool rail is `aside`, the slide strip is `nav`, the settings body is `main`, the audience display is `main`. |
| 21 properties-panel selects and 2 dashboard selects unnamed | select-name (4.1.2 A) | critical | `aria-label` on each. |
| Warning text at 3.2:1 (amber) on docs, sheets, and video | color-contrast (1.4.3 AA) | serious | The amber text step moved one stop darker (5.03:1); 20 usages, swept at once. |
| Two unnamed `aside` landmarks on the video editor | landmark-unique | moderate | Named "Media library" and "Inspector". |
| The sheet's corner cell announced as an empty column header | empty-table-header | minor | It heads nothing, so it is `role="presentation"`. |
| 27 form controls named only by `title` | label-title-only | serious | `title` mirrored into `aria-label` (a title alone is not a reliable name). |

## 2. Keyboard-only walkthrough

Driven with synthetic key events against the same live instance, no pointer input except where drawing a shape.

| Check | Result |
| --- | --- |
| Canvas surface is focusable | pass |
| Canvas exposes `role="application"` and a descriptive label | pass |
| Offscreen object tree is a single tab stop (`listbox`, tabIndex 0) | pass |
| Tree mirrors the page's objects, named | pass (grew 0 to 1 on insert, 1 to 2 on keyboard duplicate) |
| Tab selects an object in reading order | pass |
| Tab advances to the next object | pass |
| Live region announces the selection | pass ("Selected Rectangle") |
| Nudge, Alt+arrow resize, comma/period rotate keep the selection | pass |
| Escape clears the selection | pass |
| Layer rows are focusable options with selection state | pass |
| Tab escapes the canvas to real controls (no keyboard trap) | pass |
| Escape closes the export dialog | pass |

One line in the harness reports a failure that is a harness limitation, not a product defect: a second synthetic mouse drag does not register in the small headless window, so the "objects added" check reads 1 to 1 there. The same growth is demonstrated deterministically by the keyboard-duplicate probe (1 to 2) recorded above.

## 3. Panel-level ARIA review

A structured read of 18 surfaces (properties, layers, pages, tool rail, comments, activity, history, selection toolbar, left panels, share, export, command menu, and the shared Modal/Toast/Button/Input primitives) against name, role, keyboard, focus, state, and live-region criteria.

Passing as found: Modal (focus trap, restore, Escape, `aria-modal`), Toast (`role="status"`, assertive for errors), Button/IconButton (focus-visible rings, real `disabled`), ToolRail (`role="toolbar"`, per-tool `aria-pressed`), CommandMenu's combobox pattern, the alt-text and reading-order features, and the high-contrast and forced-colors focus rules.

Fixed in this pass:

- **Keyboard blockers.** Layer actions activated on `onPointerDown` (Enter and Space never fired); layer rows were unfocusable divs; the export dialog could not be dismissed by keyboard; uploads, pages, and stock actions were `hidden` until mouse hover; mention and emoji pickers activated on `onMouseDown`.
- **Missing names.** Eleven color inputs, roughly sixteen sliders (one prop on `FxSlider` names the fifteen effect sliders), five switches, the share dialog's six access selects and its link field, chart data cells, and rename inputs.
- **Missing state.** `aria-pressed` on tab-like and chip groups, `aria-current` on the active page thumbnail, `aria-expanded` on the size menu.
- **Form errors.** `ui/Input` now associates its error text with `aria-describedby` and sets `aria-invalid`, which repairs error announcement in every form in the product.
- **Command palette.** `role="dialog"`, `aria-modal`, focus restored to the opener on close, Tab contained.

## 4. Export visual regression

Method: eight probe designs (shapes and strokes, gradients including a hard stop and an off-centre elliptical radial, all six effect kinds, blend with nested opacity, rotation/flip/scale, Latin text, RTL text with Arabic and Hebrew, a shadow-plus-blend combination) rendered through `ToPNG`, `ToSVG`, and `ToPDF`. SVG rasterized with rsvg-convert, PDF with pdftoppm at 144dpi, compared to the PNG reference with ImageMagick RMSE and inspected side by side.

Divergences found and fixed:

1. **PDF dropped the outline effect** on vector bodies. Now stroked over the body, after the filter, as the raster path does.
2. **SVG group opacity isolated the group.** CSS group opacity composites children first and fades once; the engine, raster, and PDF paths multiply opacity per node, so overlapping siblings double-darken. SVG now matches (0.019 to 0.001 RMSE on that probe).
3. **SVG text carried no direction or alignment.** RTL paragraphs rendered left-aligned with punctuation on the wrong side in third-party renderers, and centred or right-aligned text exported left-aligned. Now emits the resolved base direction and a direction-aware `text-anchor`.
4. **PDF text outside WinAnsi was mojibake.** Arabic, Hebrew, and CJK with no embedded covering font were written as UTF-8 bytes through a Latin-1 encoding. Such runs now rasterize through the effect-layer machinery and are tagged as a `Figure` whose `/Alt` carries the words as UTF-16, so the text is still announced. The same change fixed non-ASCII alt text being garbled in the structure tree.

Residual deltas, all understood:

| Probe | SVG | PDF | Note |
| --- | --- | --- | --- |
| shapes and strokes | 0.006 | 0.007 | antialiasing |
| gradients | 0.045 | 0.043 | interpolation smoothness of the ramp |
| effects | 0.005 | 0.020 | blur kernel differences |
| blend and opacity | 0.001 | 0.002 | |
| transforms | 0.000 | 0.002 | |
| text (Latin, RTL) | font substitution | font substitution | external rasterizers pick different faces |

## 5. What this does not cover

- No manual screen-reader pass (VoiceOver, NVDA, JAWS). Automated tooling catches roughly a third to a half of real barriers; the announcements verified here were read from the accessibility tree and live regions programmatically, not heard.
- The scans cover application chrome on the fifteen surfaces listed. Not covered: the installation wizard, the shared-link viewer, and email templates.
- The accessibility checker's own issue messages are English prose from a framework-agnostic package; translating them needs a message-code mechanism like the one `errors.*` uses.
- Colour contrast of user *design content* is the checker's job (FR-5), not this scan's; this audit covers application chrome.
