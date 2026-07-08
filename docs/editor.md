# The Editor

The editor is HyCanvas's design surface: a custom rendering engine on an HTML canvas, with content panels on the left, contextual properties on the right, and your pages along the bottom. Everything saves automatically.

![The editor](images/editor.png)

## The left rail

Each entry opens a panel next to the rail:

- **Elements**: shapes (rectangles, ellipses, stars, arrows, and more), lines, and frames. Click or drag to place one.
- **Text**: headings, subheadings, and body text presets. Double-click any text on the canvas to edit it in place.
- **AI**: the AI panel, including image generation and the design assistant. AI runs on the provider keys configured for your workspace (bring your own key; keys are stored encrypted server-side).
- **Uploads**: your uploaded images, video, and audio, with a usage meter. Uploads count against the workspace and per-user storage limits.
- **Stock**: free stock photos and media, searchable and insertable without leaving the editor.
- **Apps**: additional content sources and integrations.
- **Brand**: the workspace brand kit (logos, colors, fonts) for on-brand design. The brand kit themes design content only; it never restyles the application itself.
- **Layers**: the stacking order of everything on the current page; select, reorder, lock, or hide from here.

## The canvas

The design page sits in the middle, with rulers on the top and left edges.

- Drag to move; handles resize and rotate. Alignment guides snap elements to each other and to the page.
- The toolbar above the page offers z-order controls, visibility, locking, duplicate, and delete for the current selection.
- The floating strip near the page's bottom edge zooms (also trackpad pinch), fits the page, or zooms to the selection.
- Toggles in the top bar switch rulers, the layout grid, and snapping.

## The properties panel

The right panel is contextual:

- With nothing selected it shows page properties: page size with presets and **Magic Resize** (re-layout the design to a different format), the page background, the page transition, and present-mode options such as speaker notes and auto-advance.
- With a selection it shows that element's properties: fill and stroke, opacity, position and size, text typography, image adjustments, and animation.

## The top bar

From left to right: back to the dashboard, the design name (click to rename), undo and redo, the view toggles, the realtime status ("Live" plus "All changes saved"), present mode, presenter view, comments, notifications, the overflow menu, export, **Share**, and **Save** (manual snapshot; autosave runs regardless).

## Pages

The strip along the bottom manages pages: thumbnails to navigate, plus duplicate and add-page buttons. Multi-page designs power presentations; present mode plays them full-screen with per-page transitions.

## Collaboration

Designs are collaborative in real time. Share a design (or invite workspace members) and edit together: everyone sees live presence cursors, edits merge automatically (offline edits sync when you reconnect), and element locks with comments keep coordinated work orderly.

## Export

The download icon in the top bar exports the design: raster images (PNG, JPG), PDF, SVG, and animated formats for designs with motion. Exports render server-side through the same engine that draws the canvas, so what you see is what you get. Long exports run as background jobs; you can keep working while they finish.
