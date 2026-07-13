# F30: Whiteboard (beat Miro)

| Field | Value |
| --- | --- |
| Feature ID | F30 |
| Phase | 3 Collaboration |
| Sequence | 30 |
| Status | Core + **Phase 1 shipped** (the table-stakes canvas: true infinite canvas via content-extent navigation + a continuous dot-grid surface, board-native ink (pen/marker/highlighter + dedicated `ink` node with pen pressure), an object eraser, free on-canvas connectors with spawn-shape-from-handle + style picker + labels + draggable waypoints, sticky speed (Tab-to-spawn + grid) + image drag-drop, on-board search (Cmd+F) with viewport jump, a board laser pointer with a fading ephemeral-ink trail, a quadtree spatial index + viewport culling + sub-pixel LOD on Canvas2D, and touch/stylus input (pinch-zoom, two-finger pan, pen-vs-finger, palm rejection, pressure). The Go export engine now renders ink/sticky/connector so boards export to PNG/SVG/PDF. This builds on the original core: `@hc/whiteboard` routing/layout/templates/sessions, the `WhiteboardSurface` chrome over the shared `Canvas`, Yjs realtime + presence/cursors/reactions/cursor-chat, comments, sharing, timer, convert-to-deck. **Phase 2 (facilitation) is in progress** and **Phase 3 (AI on the canvas) is the remaining optional differentiator**; the former **Phases 4 and 5 are out of scope** (see section 14). The board is considered shipped for its core collaborate-and-facilitate use case after Phases 1 to 3. |
| Depends on | F16 (realtime/CRDT, presence, locks), F39 (AI Creative Studio / `@hc/aistudio` BYO-key layer), `@hc/schema` (open file format + forward migration), `@hc/engine` (Canvas2D scene-graph + planned WebGL/WebGPU path), F38 (accessibility/i18n/NFR) |

A free, self-hostable, AI-native whiteboard that beats Miro, FigJam, Mural, Lucidspark, Excalidraw, and tldraw on every axis that matters: the full facilitation and AI canvas suite shipped ungated (no tiers, paywalls, or watermarks), every AI/diagram/import action producing editable native scene-graph nodes in the open file format (no rasterized dead-ends, fully exportable, runnable on-prem), true offline-first CRDT collaboration that Miro, Mural, FigJam, and Lucidspark still lack (uncontested even against the local-first Excalidraw and tldraw once paired with the full facilitation and AI suite), performance leadership via the framework-agnostic engine, and accessibility as a category lead. HyCanvas already ships a real whiteboard document type; this spec closes the table-stakes canvas gaps, then leaps ahead.

## Current state

Audited against the code: `packages/whiteboard/src/{routing,layout,sticky,templates,region,session,deck,search}.ts`; `frontend/src/components/editor/{WhiteboardSurface,Canvas,MiniMap,ZoomControl,PresentMode,PresenceOverlay,CommentsPanel,CommentPins,ShareDialog,ActivityPanel}.tsx`; `frontend/src/store/{editor,presence,comments}.ts`; `frontend/src/lib/{ydoc,realtime,useRealtime,stickers}.ts`; `packages/schema/src/schema.ts` (`StickyNode`, `ConnectorNode`, `FrameNode`, `InkNode`, `MindMapNode`, `BoardViewNode`, `DiagramCodeNode`, `StampNode`, `PathNode`, `EmbedNode`, `QRNode`, `TableNode`; schema v10) + `migrate.ts`; `packages/engine/src/{render2d,scene,spatial,hit}.ts`; backend `internal/render/{raster,svg,pdf,board}.go`, `internal/realtime/*.go`, `internal/comments`, `internal/sharing`, `internal/engagement`.

The whiteboard is a first-class document type, not a bespoke board engine. `WhiteboardSurface.tsx` floats Tailwind chrome over the shared design `Canvas.tsx` (pan/zoom/marquee/move/select); board objects are ordinary `@hc/schema` nodes (sticky, frame, text, shape, connector, path) mutated through the `@hc/editor` command framework so every edit is one undoable scene-op and flows through the F16 CRDT. `@hc/whiteboard` is a pure, deterministic core: connector routing (straight/elbow/curved, node-attach), layered flowchart and radial mind-map auto-layout, sticky font auto-fit, eight starter templates, region-to-DesignFile extraction, facilitation accounting (countdown timer + dot voting), and whiteboard-to-deck conversion. Realtime ships the full F16 stack (Yjs sync, offline IndexedDB, presence/cursors/follow, ephemeral reactions, cursor chat, per-user undo, per-element locks), plus a complete comment system (pins, threads, mentions, reactions, resolve, convert-to-task), sharing/permissions (member grants + anyone-with-link, password/expiry, anonymous access), and an activity feed. Convert-to-deck runs as a server job.

Phase 1 (the table-stakes canvas) shipped and closed most of the original gaps: the surface is now an infinite canvas (content-extent navigation + dot-grid surface; pan/zoom unbounded, MiniMap/fit track content parked beyond the page); the board toolbar carries pen/marker/highlighter ink (a dedicated `ink` node with pen pressure) plus an object eraser; connectors draw freely with spawn-shape-from-handle, a style picker, labels, and draggable waypoints; on-board search (Cmd+F) jumps the viewport; a board laser pointer leaves a fading ephemeral-ink trail; a quadtree spatial index + viewport culling + sub-pixel LOD run on Canvas2D; touch/stylus input (pinch-zoom, two-finger pan, pen-vs-finger, palm rejection) works; and the Go export engine renders ink/sticky/connector so boards export to PNG/SVG/PDF.

The honest remaining gaps: Phase 2 facilitation is in progress (spotlight/summon/take-control, server-authoritative voting, timer presets + end alert, named views/agenda + deep-links, presence-scale interest culling, and the emoji/vote stamp are built; private mode, the protected facilitator lock + handoff, and anonymous-session moderation + first-run onboarding remain). Phase 3 (AI on the canvas: diagram-from-prompt, sticky clustering/summarize, the canvas agent) is the remaining optional differentiator, built on the shipped AI Creative Studio (F39). The former Phases 4 and 5 (smart diagramming/interop and GPU-scale/ecosystem/enterprise) are deliberately out of scope (section 14). The new mind-map/boardview/diagram-code node types stay schema-only groundwork; large-board scale beyond the Canvas2D spatial index/LOD is not pursued.

Status legend: **Built** (ships today, code-referenced), **Partial** (some of it ships, gaps noted), **Planned (doc 16)** (depends on F16 realtime work tracked there), **Not started**.

## 1. Context and Goal

HyCanvas ships a working whiteboard, but the bar that "beat Miro" sets is much higher than a working board. Miro's offline support is still an unmet community request; its AI lives behind paid tiers; Mural gates its strongest facilitation (private mode, summon, take-control) behind plans; FigJam's keyboard-driven connectors and spotlight set the speed bar; Excalidraw and tldraw set the ink, hand-drawn aesthetic, end-to-end-encryption, no-login, and agent-on-canvas bars; Lucidspark owns the converge step (gather and sort by vote count) and breakout boards. Every one of them stores board content in a closed format where AI and diagram output flatten to dead-ends.

HyCanvas's opening is structural. Board content is the open `@hc/schema` format (`CURRENT_SCHEMA_VERSION = 9`) with forward migrations and lossless `UnknownNode` round-trip, so every AI generation, diagram import, and template lands as editable native nodes, fully exportable and runnable on-prem. The F16 CRDT core (Yjs + IndexedDB + WebSocket relay, per-user undo, presence) is already offline-first and conflict-free, the exact thing Miro lacks. The F39 AI Creative Studio (`@hc/aistudio`) gives a BYO-key, multi-model, self-hostable AI layer to build canvas agents on, so board data never leaves a self-hosted instance. Everything ships free and unwatermarked.

Intended outcome: a facilitator opens an infinite board, drops a methodology-correct retro from a prompt, runs a private-mode brainstorm with a countdown timer, summons everyone to a frame, runs a server-authoritative anonymous vote, asks the canvas agent to cluster the stickies into themes and summarize decisions into a deck, and exports the resulting flowchart back to Mermaid for the team's git repo, all offline-capable, fully accessible by keyboard and screen reader, on a board with 10,000 objects that never drops below 60fps, on their own self-hosted instance with their own model key.

## 2. Scope

In scope:
- The whiteboard document surface (`meta.kind === "whiteboard"`): true infinite canvas, board-native ink, free-draw connectors, sticky speed primitives, on-board search, sections/areas, and the board toolbar.
- Board-specific facilitation: spotlight/summon/take-control, private mode, server-authoritative voting and estimation, timer presets, protected/facilitator lock, outline/agenda navigation, breakout boards, laser/ephemeral ink on the live board. This is the "document-type-specific collaboration nuances for whiteboard" that F16 explicitly lists as out of its scope.
- AI on the canvas: text-to-diagram, sticky clustering and summarize, board-to-doc/board-to-deck, the canvas agent, image generation onto the board, photo-of-stickies digitization, wireframe-to-code, idea expansion, multi-model compare, built on `@hc/aistudio`.
- Diagram-as-code import and lossless export round-trip; advanced auto-layout families; obstacle-aware connector routing; flowchart/BPMN/UML shape packs.
- New board node types (ink, mind-map, kanban/multi-view, diagram-as-code) and additive enrichments (connector labels/waypoints, sticky author, section semantics, stamp node) plus their forward migrations.
- Board-specific performance and scale (spatial indexing, LOD, page subdocuments, surgical CRDT delta apply), board accessibility (keyboard navigation, screen-reader semantics, in-canvas WCAG checker), and board interop (cross-tool import, image/PDF/code export).

Out of scope (owned elsewhere):
- The CRDT data model, base sync protocol, base presence, base per-element lock mechanics, and history time machine (F16 owns these; this spec extends them with board-specific frame types and authoritative stores).
- The AI provider-adapter layer, key storage, model routing, and reproducibility (F39 / the AI layer; this spec consumes it).
- The base export encoders (`@hc/export` + the Go render engine; this spec maps board frames to export pages and adds code export).
- Cross-cutting SSO/SCIM/observability/compliance/self-host NFR (F38; this spec adds the board admin and per-object permission requirements that hook into it).
- The rendering engine's general WebGL/WebGPU path (the engine roadmap owns the GPU backend; this spec specifies the board's spatial-index/LOD/subdocument needs that ride on it).

Deferred:
- DOM-canvas / live-React-component custom shapes (architectural; see open questions). The Canvas2D engine cannot render arbitrary interactive components without an overlay layer; tracked as a spike, not committed here.
- In-board audio/video (WebRTC signaling) and async narrated walkthrough (Talktrack-style), pending a media-presence layer.
- PM-card two-way sync (Jira/Linear/GitHub/Azure DevOps) and the MCP server, pending the cards widget and an integrations layer.
- End-to-end-encrypted rooms (post-F16 research; see open questions).

## 3. User Stories

- As a facilitator, I want an unbounded canvas, a private-mode brainstorm, a visible countdown, and a one-click "bring everyone to me" so a 30-person workshop stays focused.
- As a participant, I want to draw with a real pen, marker, and highlighter, drag a connector from a shape edge to spawn the next shape, and press Tab to keep dropping stickies, so capturing ideas is fast.
- As a synthesizer, I want AI to cluster a wall of stickies into themes and summarize the board into decisions and next steps as an editable deck, so post-workshop write-up is one step.
- As an engineer, I want to paste Mermaid and get editable native nodes, and export my edited diagram back to Mermaid for the repo, so diagrams live in git.
- As a designer, I want to sketch a wireframe and get working HTML I can annotate and iterate on, on my own self-hosted instance with my own model key.
- As a screen-reader user, I want to navigate the board by keyboard (linear, spatial, hierarchical), hear every object including AI-generated ones, and be warned about low-contrast notes at authoring time.
- As an enterprise buyer, I want SSO/SCIM, custom roles, protected locks, audit logs, and full data export on a board I can run on-prem, with no per-seat whiteboard upcharge.
- As a privacy-sensitive team, I want the AI agent to read and act on the board without any board data leaving our instance.
- As a large team, I want a 10,000-object board with hundreds of cursors to stay at 60fps.

## 4. Feature matrix / scope

The heart of this spec. Status values: **Built**, **Partial**, **Planned (doc 16)** (depends on F16 work tracked in `16-realtime-collaboration.md`), **Not started**.

### Canvas and navigation

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Infinite / unbounded canvas | Built (P1) | `store/editor.ts` `contentBounds`; `MiniMap.tsx`; `WhiteboardSurface.tsx` (dot grid); `render2d.ts` culling | Content-extent navigation: pan/zoom unbounded (no pan clamp), MiniMap + fit-all track the node-union ∪ page extent, and a zoom-scaled dot-grid surface sits behind the canvas. Auto-grow via culling. Page subdocuments + dots-everywhere (transparent page) remain (Phase 5 / cosmetic). |
| Pan / zoom about cursor | Built | `Canvas.tsx` `onWheel`, space/middle-drag, pinch | Ctrl/Cmd-wheel + pinch zoom about cursor/midpoint clamped 0.02-64x; unbounded pan. |
| Mini-map / overview | Built (P1) | `MiniMap.tsx` | Overviews the content extent (node union ∪ page), negative-origin aware; tracks objects parked beyond the page edge. |
| Fit / zoom-to-selection / presets | Built (P1) | `ZoomControl.tsx`; `store/editor.ts` `fitToScreen`/`contentBounds` | Fit-all now frames the content extent, not just the page; presets + zoom-to-selection unchanged. |
| Zoom-to-region / named views / frame-fit navigation | Not started | n/a | No named views or zoom-to-frame agenda navigation. Add view bookmarks keyed to frames/regions. (Search's `jumpToNode` is the viewport-jump primitive to build on.) |
| On-board search / find across content (Cmd+F) | Built (P1) | `@hc/whiteboard` `search.ts` (`searchNodes`); `WhiteboardSurface.tsx` `BoardSearch`; `store/editor.ts` `jumpToNode` | Cmd/Ctrl+F finds across sticky/text/connector-label/frame content and pans+zooms to a chosen match. |
| Object locking (basic) | Built | `store/editor.ts` (`locked` flag), `nodeBaseFields.locked` | Per-node `locked` honored on move. |
| Protected / facilitator lock | Not started | n/a | Role-gated lock that survives participant tampering (Miro protected lock, Mural facilitator lock). Lock-owner/role field + server enforcement. |
| Grid / snap / alignment guides | Partial | `@hc/editor` snapping; `WhiteboardMeta.grid {size,snap}` in `session.ts` | Snapping/align + grid meta flags exist; resolve and wire board-specific snap-to-grid math. Sticky/note grids (MS Whiteboard) are a separate missing layout primitive. |
| Touch / multi-touch navigation (pinch-zoom, two-finger pan) | Built (P1) | `Canvas.tsx` (`pointers`/`pinch` refs, onPointerDown/Move/Up/Cancel) | PointerEvents pinch-zoom + two-finger pan about the fingers' midpoint, with re-baselining on finger lift; `touch-none` so the browser does not hijack. |
| Pen-vs-finger discrimination + palm rejection (stylus) | Built (P1) | `Canvas.tsx` (pointerType handling); ink capture | Pen draws (with pressure feeding the `ink` stream); a single finger pans for draw tools; touch is ignored while a pen is down (palm rejection). Tilt capture not yet used. |
| Deep-link / permalink to an object, frame, or view | Not started | n/a | Search-jump (FR-2) and named views (FR-3) are in-session only; sharing yields board-level `/shared?token=` links. Encode a node/saved-view id in the link and restore the viewport on open (FR-34). Miro/FigJam ship link-to-object. |

### Content objects / widgets

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Sticky notes | Built | `schema.ts` (`StickyNode`); `WhiteboardSurface.tsx` `addSticky`, `store/editor.ts` `addStickyAt` | Plain text, Fill union, textColor, fontScale auto-fit, autoSize, frameId; optional `authorId`/`shape` fields added (schema v10). Missing: rich text inside note; the `authorId`/`shape` fields have no UI yet. |
| Sticky author attribution / color-by-author | Partial (P1 schema) | `schema.ts` `StickyNode.authorId` | Optional `authorId` field added additively (schema v10); no FigJam-style avatar / sort-by-author UI yet. |
| Sticky bulk / grid create + Tab-to-spawn | Built (P1) | `WhiteboardSurface.tsx` `addStickyGrid`; `Canvas.tsx` (StickyEditOverlay Tab) + `store/editor.ts` `addStickyAt` | Tab from an editing sticky spawns + focuses the next; a toolbar button drops a 3x2 grid; double-click empty canvas drops one. |
| Sticky font auto-fit | Built | `sticky.ts` `fitStickyFontScale` | Heuristic DOM-free estimator. Extend with `@hc/text` measured metrics for CJK/variable-width. |
| Rich text on canvas | Built | `schema.ts:842-858` (`TextNode`); Canvas text tool | Full rich-text paragraph/run model for board labels. |
| Shapes with text (rect/ellipse + flowchart shapes) | Partial | `schema.ts:900-920` (`ShapeNode`); `addShape` | `ShapeNode` supports rect/ellipse/polygon/star/triangle/custom, but board menu offers only rect+ellipse, no in-shape text edit flow, no flowchart/BPMN/UML packs. |
| Tables | Built | `schema.ts:1214-1243` (`TableNode`) | Spreadsheet-style table with cells/borders/conditional rules/DataBinding in schema. Not surfaced as a board widget; no multi-view (table/timeline/Kanban) over one dataset. |
| Kanban board widget | Partial (P1 schema) | `schema.ts` `BoardViewNode` | `BoardViewNode` (view: kanban/table/timeline, columns + cards) added additively (schema v10); no rendering/widget UI yet. |
| Cards (PM-syncable) | Not started | n/a | No card object with tags/estimates that sync to Jira/Azure DevOps. Depends on integrations layer (deferred). |
| Timeline / Gantt widget | Not started | n/a | Can derive from `TableNode` multi-view or diagram-as-code (Mermaid Gantt). |
| Embeds (web / video / iframe) | Partial | `schema.ts:1319-1331` (`EmbedNode`) | `EmbedNode` exists but is a static iframe URL, not wired onto the board, not a live widget framework. SSRF guard needed. |
| Live interactive widgets (polls/dice/music) | Not started | n/a | Typed live-app widget framework with persisted multiplayer state (FigJam widgets, Miro apps). Large surface; deferred (tied to the DOM-canvas open question). |
| Conditional formatting (data-driven auto-styling) | Not started | n/a | Lucidspark differentiator, rare among boards. `TableNode` already has conditional rules in schema; extend to board notes/shapes with AI-authored rules. |
| Code blocks | Not started | n/a | Syntax-highlighted code as a movable object (FigJam). New node type or styled text. |
| QR node | Built | `schema.ts:1333-1353` (`QRNode`) | Full QR node. Useful for present-mode remote control. |
| Stickers / stamps on canvas | Partial (P1 schema) | `frontend/src/lib/stickers.ts`; `schema.ts` `StampNode` | Editable-vector + animated stickers in the design Elements panel; `StampNode` (kind emoji/vote, glyph, authorId) added additively (schema v10) but not yet droppable on the board, no emoji-stamp wheel. |
| Washi tape / decorative organization | Not started | n/a | FigJam signature; low-priority cosmetic. |
| Image / GIF upload onto board | Built (P1) | `Canvas.tsx` `onDrop`; `schema.ts` `ImageNode`; media/uploads layer | OS file drag-drop of images onto the board places `ImageNode`s (into a frame/shape under the cursor, else free); upload pipeline ships. |

### Drawing and ink

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Board-native pen tools in the whiteboard toolbar | Built (P1) | `WhiteboardSurface.tsx` (pen/marker/highlighter buttons + `P` shortcut); `Canvas.tsx` `ink` tool | Pen, marker, and highlighter on the board toolbar; commit a smoothed `ink` stroke. |
| Freehand pencil with smoothing | Built | `Canvas.tsx` pencil; `editor.ts` `addPencilPath` | `simplifyPolyline` + `fitCubicBeziers` into a smooth path node; the board ink tools add a separate decimate+smooth `ink` pipeline. |
| Pressure/velocity-variable stroke (perfect-freehand pipeline) | Partial (P1) | `Canvas.tsx` (pen `e.pressure` capture); `render2d.ts` `drawInk`; `editor.ts` `addInkStroke` | Pen pressure is captured per point and the ink ribbon varies width by pressure for the pen brush. Velocity-variable width, corner detection, and zoom-adaptive precision (full perfect-freehand) not yet done. |
| Dedicated ink/draw node type | Built (P1) | `schema.ts` `InkNode` (v10); `render2d.ts` `drawInk`; `hit.ts` ink case | Point-stream node with optional pressure/time + brush (width/opacity/color/mode), decimated+smoothed; engine renders it as a variable-width ribbon, additive forward migration. |
| Marker / highlighter (semi-transparent, behind content) | Built (P1) | `render2d.ts` `drawInk` (mode marker/highlighter) | Highlighter multiplies (semi-transparent) onto content; marker is a flat opaque nib. |
| Eraser tool | Built (P1) | `Canvas.tsx` (`eraser` tool, `eraseAtPoint`); `store/editor.ts` `eraseNode` | Object eraser: click or drag over strokes/objects to remove the topmost one (one undo step each), gated like other mutations. Stroke-segment (partial) erase not done. |
| Shape recognition (draw-and-snap) | Partial | `editor.ts` `recognizeSelectedPath` (2016-2042); `@hc/geometry` `recognizeShape` | Snaps freehand to line/rect/ellipse/triangle/polygon, but it is a manual panel button, not snap-as-you-draw, not on the board toolbar. |
| Freehand-to-straight-line / angle snapping | Not started | n/a | No mid-stroke straight-segment detection with angle snap (tldraw state machine). Quality differentiator. |
| Hand-drawn / sketchy aesthetic option | Not started | n/a | No Rough.js-style sketchy render with seeded determinism (Excalidraw brand). Optional engine render style; low priority. |

### Connectors and diagramming

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Connector node (attach + routing styles) | Built (P1) | `schema.ts` (`ConnectorNode`, v10); `@hc/whiteboard` `routing.ts` | straight/elbow/curved, node-attach via `{nodeId,anchor,port?}`, caps, plus additive `label`/`waypoints[]`/`jumpOver`. `routeConnector` routes through waypoints (orthogonal for elbow). Still no obstacle avoidance / jump-over rendering / per-segment styling. |
| Connector labels | Built (P1) | `schema.ts` `ConnectorNode.label`; `render2d.ts` (label chip); `Canvas.tsx` `ConnectorLabelOverlay` | Optional `label` {text,position}; double-click a connector to edit; rendered as a chip along the routed line (engine + Go export). |
| Connector waypoints / multi-bend / draggable midpoints | Built (P1) | `schema.ts` `ConnectorNode.waypoints`; `routing.ts`; `Canvas.tsx` `ConnectorEditLayer` | Draggable bend handles on a selected connector; add-bend on the routed line; double-click a handle to remove. Hit-test + Go export honor waypoints. |
| Free on-canvas connector tool + connect-on-hover | Built (P1) | `Canvas.tsx` `ConnectorDragLayer`; `store/editor.ts` `connectNodes`/`setConnectorRoute` | Drag from a node's edge nub, connect-on-hover; releasing in empty space spawns a connected shape; a board style picker sets straight/elbow/curved. A pure floating-endpoint terminate is the remaining alternative. |
| Spawn-shape-from-connector-handle | Built (P1) | `store/editor.ts` `spawnConnectedShape`; `Canvas.tsx` (ConnectorDragLayer onNubUp) | Dragging a connector off a node's nub into empty space drops a connected rounded card and keeps the chain going (FigJam flow). |
| Connector auto-reroute on move | Built | `routing.ts` `routeConnector`; `connectNodes` re-route | Endpoints re-route as nodes move. Lacks shortest-path center-to-center smart routing and obstacle avoidance. |
| Obstacle-aware / orthogonal routing (A*/visibility graph) | Not started | n/a | Connectors can cross nodes. No dummy-node/ELK/dagre-grade orthogonal routing. Extend `routing.ts`. |
| Connector jump-overs / line hops | Not started | n/a | No crossing-line hop field or renderer support. |
| Flowchart / BPMN / UML shape packs | Not started | n/a | Build as template/asset packs over `ShapeNode` + custom `pathData`. |
| Swimlanes / pools / cross-functional lanes | Not started | n/a | Container + lane semantics, possibly on `FrameNode` autoLayout. |
| Diagram-as-code (Mermaid / PlantUML / DOT) import | Not started | n/a | High-value engineering wedge. Parser to `@hc/schema` nodes + auto-layout via `layout.ts`. |
| Diagram-as-code export (round-trip back to text) | Not started | n/a | Lossless export back to Mermaid/PlantUML. True round-trip is an open lead vs all incumbents. |
| Diagram-as-code node (stores source, renders diagram) | Not started | n/a | Node storing source text + materialized form. New schema node + migration. |

### Auto-layout and smart diagramming

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Flowchart layered auto-layout (Sugiyama) | Built | `layout.ts` `layoutFlowchart` | Cycle-break, longest-path layering, 4 barycenter sweeps. Limit: equal-point nodes (wide nodes overlap), no dummy nodes, no Brandes-Kopf compaction, no edge labels. |
| Mind-map radial auto-layout | Built | `layout.ts` `layoutMindMap` | Radial BFS, leaf-weighted slices. Limit: tree-only, 360 spread only, no collision resolution, no node-size awareness. |
| Auto-layout only over connector-linked graphs | Partial | `WhiteboardSurface.tsx` `buildConnectorGraph`/`applyLayout` (251-349) | A board of loose stickies cannot be tidied. Add grid/pack/align-cluster auto-arrange for unconnected stickies. |
| Mind-map node primitive (parent/child topology) | Not started | n/a | New schema node + migration (branch topology, node reassignment, dependency links). |
| Tree / hierarchy / force-directed / circular / matrix layouts | Not started | n/a | Only one layered family + one radial. Extend `layout.ts` (same `Graph` -> `Record<string,Point>` contract). |
| Node-size-aware layout + collision resolution | Not started | n/a | All layout ignores real node sizes; differently-sized nodes overlap. Add size-aware spacing + overlap resolution. |
| Container auto-resize / auto-layout frames | Partial | `schema.ts` `AutoLayout` (1015-1031) on `FrameNode` | Flexbox-style `autoLayout` in schema; not exposed as a board-section auto-arrange affordance. |
| Sticky clustering / affinity grouping / auto-grouping | Not started | n/a | No clustering/tagging/auto-grouping (manual or AI). Pairs with AI sort. |

### Sections and organization

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Sections / areas (named, colored container regions) | Partial | `schema.ts:1033-1055` (`FrameNode`); `region.ts`/`deck.ts` treat child-frames as sections | FigJam Sections / Mural Areas are headline organization primitives that move contents together. `FrameNode` is a layout/clip frame today; add optional title-bar/header slot + collapse state + move-contents-together semantics additively. |
| Outline / agenda navigation + hide & reveal sections | Not started | n/a | No sequenced agenda/outline of frames or hide-until-needed sections (Mural). Pairs with named views. |

### Templates and frameworks

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Starter board templates | Built | `templates.ts` `WHITEBOARD_TEMPLATES` + `buildTemplate`; Templates menu | Eight builders emit positioned real nodes as one undo step. Limit: fixed geometry/colors/copy, English-only, no parameterization, no thumbnails/search. |
| Template thumbnails / search / categorized picker | Not started | n/a | Add a template gallery surface. |
| Parameterized templates (column count, team size) | Not started | n/a | Extend builder signatures. |
| AI-generated boards / text-to-template | Not started | n/a | Prompt-to-board producing a methodology-correct populated board. Build on `@hc/aistudio` emitting `templates.ts`-style node sets. |
| User-saved / custom / marketplace templates | Not started | n/a | Depends on `@hc/templates` + marketplace roadmap. |
| Retro / planning frameworks (SWOT, Start-Stop-Continue, etc.) | Partial | `templates.ts` (eight starters) | Needs the broad opinionated framework library competitors ship. |

### Facilitation

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Countdown timer | Built | `session.ts` (start/pause/reset/elapsed/remaining); `WhiteboardSurface.tsx` (607-1041) | Deterministic timer in `doc.meta`, server-clock-offset synced. Limit: single timer, no expiry callbacks, no Pomodoro/stage/agenda presets, no end alert sound. |
| Timer presets + end alert (Pomodoro/stage/agenda) | Not started | n/a | Add presets, audible end alert, agenda-stage timers. |
| Private / hidden-contribution mode | Not started | n/a | Mural's defining anti-groupthink tool. Presence/visibility gating + reveal. P1 facilitation wedge. |
| Presenter / spotlight / summon (bring-everyone-to-me) | Not started | n/a | Only voluntary follow-mode exists (`useRealtime.ts`). The #1 cited reason facilitators choose Mural/FigJam. New spotlight WS frame type. P0. |
| Take-control / moderator mode (sustained scripted drive) | Not started | n/a | Distinct from one-shot summon: drive everyone's viewport through a scripted agenda (Mural Take Control, Conceptboard Moderator Mode). |
| Breakout boards / rooms | Not started | n/a | Sub-board model + participant assignment (Lucidspark/Miro). Genuine standout gap. |
| Nested sub-boards / drill-down (Substorms) | Not started | n/a | Stormboard Index Cards + Substorms: an idea/card opens its own nested board. Distinct from breakouts; hierarchical drill-down for large structured sessions. |
| Hide cursors / mute distractions | Not started | n/a | Facilitator hide-all-cursors for large sessions (Mural). |
| Laser pointer / ephemeral ink on the live board | Built (P1) | `store/presence.ts` (`laser`/`selfLaser`); `lib/realtime.ts`; `PresenceOverlay.tsx` (laser dots + fading ink trail); `WhiteboardSurface.tsx` (laser tool); `realtime/presence.go` (`sanitizePresence` allowlist) | Board-native laser tool broadcasts an ephemeral pointer over presence; peers see a fading dot plus a CSS-faded ink trail (per-owner ring buffer). Spotlight/summon still deck-only (see presenter rows). |
| Emoji-stamp / reaction-stamp tool (dot-vote placement) | Not started | n/a | FigJam's `E` stamp wheel is the actual dot-vote placement mechanism. P1. New stamp node. |
| Facilitator role + mid-session handoff | Partial | backend sharing + `onRoleChanged` | Live edit/comment/view change ships; no dedicated facilitator role with handoff. Bundle with protected lock + take-control as one P1 facilitator package. |
| Celebrate / confetti | Not started | n/a | Cosmetic morale touch (Mural). |

### Collaboration and presence

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Yjs CRDT document model | Built | `frontend/src/lib/ydoc.ts`; `@hc/realtime/reconcile.ts`; `@hc/schema/yjs.ts` | Per-design `Y.Doc`, generic scene-graph bridge, fractional-rank reorder, per-char text merge. Covers sticky/connector/frame via the type-generic bridge. |
| WebSocket sync relay | Built | `backend/internal/realtime/hub.go` (`HandleSync`), `serve.go`; `lib/realtime.ts` | y-protocols sync over `/realtime`, blind relay, journaled, wire hardening. |
| Presence: cursors, selection, avatars, per-user color | Built | `store/presence.ts`; `lib/realtime.ts` (`PRESENCE_THROTTLE_MS`); `PresenceOverlay.tsx`, `PresenceBar.tsx`; `presence.go` | Colored cursors + labels, selection outlines, avatar stack, stable palette, throttled ~22fps. No spatial culling/LOD for hundreds of cursors (see scale). |
| Follow mode | Built | `useRealtime.ts`; `presence.ts` (`following`/`toggleFollow`) | Mirrors a peer's viewport; breaks on local pan/zoom. No forced presenter (see facilitation). |
| Ephemeral reactions + cursor chat | Built | `PresenceOverlay.tsx`; `presence.ts`; `WhiteboardSurface.tsx` | Float-and-fade emoji (6 fixed) + cursor-chat bubbles, server-clock age-gated, 200-char cap. |
| Offline-first IndexedDB persistence | Built | `lib/ydoc.ts` (`IndexeddbPersistence`) | Conflict-free reconverge on reconnect. Differentiator vs Miro. |
| Per-user collaborative undo/redo | Built | `lib/ydoc.ts` (`Y.UndoManager`); `editor.ts` `collabUndo` | Undo reverts only this user's edits, fans out to peers. |
| Collaborative per-element locks | Partial | `realtime/locks.go`, `hub.go`; `useRealtime.ts` `lockSelection` | Acquire/deny/release + heartbeat TTL ship. Missing: server-side rejection of UPDATE frames touching locked nodes (no pure-Go CRDT decode), cross-instance lock authority (Redis CAS). Planned (doc 16). |
| Read-only / permission enforcement on the wire | Built | `hub.go` (drops non-editor updates); `validate.go` (422) | Auth+role resolved before join, viewer frames dropped, boundary schema validation. Per-node enforcement needs a server CRDT decoder. |
| Live role change push | Built | `lib/realtime.ts` (`onRoleChanged`); `presence.ts` | Mid-session up/downgrade with reason; client re-syncs on upgrade. |
| Horizontal scaling (Redis fan-out) | Partial | `realtime/coordinator.go`, `coordinator_redis.go` | Sync/presence/comment frames fan out via Redis; default in-memory no-op. Not fanned: locks (instance-authoritative), initial roster catchup. Planned (doc 16). |
| Scale to hundreds of cursors (batching / interest mgmt) | Not started | n/a | DOM-overlay presence broadcast to all peers; no spatial culling/aggregation/batching. Untested at scale. |
| Audio / video chat in-board | Not started | n/a | No media-presence layer, no WebRTC signaling (FigJam huddle, Mural Quick Talk). Deferred. |
| End-to-end-encrypted rooms | Not started | n/a | The relay is a blind relay for sync, but no E2E (Excalidraw key-in-URL-fragment). The privacy bar for the open/self-host positioning. See open questions. |
| No-login / zero-friction local-first start | Partial | anonymous link access via `/shared?token=` | Anonymous link access exists, but no instant no-account local-first PWA start (Excalidraw's biggest adoption driver). Distinct adoption wedge. |
| Custom avatars / visitor names for open sessions | Not started | n/a | Anonymous access exists; no themed avatars / visitor-name entry (Mural). |
| Content moderation / safety for anonymous sessions | Not started | n/a | Anonymous open boards are an adoption wedge but have no facilitator kick/ban, no removal of guest-authored stickies/chat/reactions, no rate limiting, no profanity filter. Miro/Mural moderate public boards. Needs moderation hooks + audit trail (FR-32). |

### Comments and async

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Comment system (pins, threads, mentions, reactions, resolve, tasks) | Built | `CommentsPanel.tsx`, `CommentPins.tsx`; `store/comments.ts`; `internal/comments/*.go` | Pins anchored to element or region, threads, replies, @mention, reactions, resolve/reopen, convert-to-task (assignee/status/due). REST + live `{t:'comment'}`. Strong vs incumbents. |
| Comments-mode toggle / review overlay on board | Not started | n/a | Comment is a one-shot tool on the base canvas; no dedicated board review overlay mode. |
| Activity feed | Built | `ActivityPanel.tsx`; `internal/engagement/service.go` | Reverse-chron filterable feed with cursor paging. |
| Convert-comment-to-Jira/Linear issue (two-way) | Not started | n/a | Convert-to-task exists internally; PM two-way sync is the real agile-team differentiator vs read-only cards. Depends on integrations layer. |
| Async video walkthrough (Talktrack-style) | Not started | n/a | Recorded narrated walkthrough where viewers follow + edit live (Miro Talktrack). Needs recording + path replay + media layer. Deferred. |
| Session analytics / facilitator insights | Not started | n/a | Per-participant contribution counts, vote distribution/heatmap, sentiment summary, post-session engagement report; derivable from the activity feed (`internal/engagement`) + the planned vote store. Distinct from the org-level audit log and the machine-readable session-as-data export. |

### Voting / estimation / retro

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Dot voting | Partial | `session.ts` (castVote/tally/budget); `WhiteboardSurface.tsx` (607-1041) | Multi-dot budget voting in `doc.meta`. NOT server-synced across collaborators yet (deferred-sync at ~664), NOT server-authoritative. anonymous/revealed flags exist but unenforced. |
| Voting session config (votes/person, duration, one-per-object) | Partial | `session.ts` `VoteSession` | `budgetPerUser`/`open`/`anonymous`/`revealed` in the type; no time-box tied to timer, no per-node cap, anonymity unenforced. |
| Anonymous / private voting (enforced) | Not started | n/a | Server-authoritative hiding of identities. Bias-reduction wedge. |
| Ranked / weighted / score voting (ICE/RICE) | Not started | n/a | Only multi-dot budget voting today. |
| Planning poker / estimation (story points, T-shirt) | Not started | n/a | Reveal + tag-back to cards (Miro Estimation app). Pairs with cards/PM sync. |
| Gather and sort / converge by vote count | Not started | n/a | Group/rank ideas by vote count (Lucidspark Gather and Sort). Pairs with AI clustering. |
| Server-authoritative vote integrity | Not started | n/a | Tallies computed client-side from CRDT meta; no server validation. Needs a backend vote store + REST/WS endpoints. |

### AI on the canvas

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| AI Creative Studio core (BYO-key, multi-model, editable output) | Built | `@hc/aistudio` (`docs/shipped/39-ai-creative-studio.md`); AI provider-adapter layer | The wedge to build canvas AI on; not yet board-aware. |
| AI diagram / flowchart / mind-map from text prompt | Not started | n/a | Prompt-to-diagram producing editable native nodes + connectors with auto-layout. P0. Build on `@hc/aistudio` + `layout.ts`. |
| AI sticky clustering (theme / sentiment / keyword) + action-item extraction | Not started | n/a | Cluster stickies into labeled sections by a selectable axis (theme/sentiment/keyword, Miro Intelligent Canvas parity), sorting a copy to preserve originals. P0, ships as one wedge with summarize. |
| AI summarize board / selection | Not started | n/a | Board-to-takeaways. P0 alongside clustering: the workshop-synthesis pipeline. |
| Board-to-doc / board-to-deck (AI) | Partial | `deck.ts` `whiteboardToDeck`; `convertWhiteboardToDeck` job | Deterministic board-to-deck ships (frames -> slides), NOT AI-driven. Add an AI summarize+structure pass producing decisions/next-steps. |
| AI agent that acts ON the canvas (typed/sanitized actions) | Not started | n/a | Cursor-style agent with typed action schemas (create/update/delete/align/distribute/reorder), viewport-screenshot + structured-shape + off-screen-cluster context, streaming, conversation memory (tldraw agent, Miro Sidekicks). Marquee differentiator on BYO-key/self-host. P0. |
| AI image generation onto the board | Partial | `@hc/aistudio` + AI media roadmap (`23-ai-media.md`) | Image gen exists in the studio/media roadmap; not wired to place first-class image nodes onto the board. |
| Wireframe / sketch-to-code (make-real) | Not started | n/a | Draw a wireframe -> working HTML via vision LLM with annotate-iterate loop (tldraw). Build on `@hc/aistudio` + embed render. |
| Repeatable AI workflows on canvas | Not started | n/a | Reusable multi-step automations as canvas objects (Miro Flows, tldraw workflow kit). Defer until agent lands. |
| Hand-drawn / photo-of-stickies digitization | Not started | n/a | Image-to-editable-objects (Miro Sticky Capture). Vision model -> schema nodes. |
| AI idea expansion (variations / sub-ideas off a node) | Not started | n/a | Expand-this-idea into N variations (FigJam/Whimsical/Ayoa). |
| Multi-model side-by-side compare + drag-context-into-prompt | Not started | n/a | Showcases the BYO-key/multi-model advantage on the canvas (illumi). Run the same inputs across models, compare on-canvas; drag context cards into a prompt card. |
| AI facilitation / auto meeting notes | Not started | n/a | Live-discussion summarization to notes (Mural). Depends on the audio layer (deferred). |

### Import / export and interop

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Region extraction to DesignFile | Built | `region.ts` `extractRegion` | Clones frame/selection/marquee into a fresh DesignFile, regenerates ids. Limit: top-level page children only; no connector reconciliation when one endpoint is left behind. |
| Whiteboard-to-deck conversion | Built | `deck.ts` `whiteboardToDeck`; `convertWhiteboardToDeck` job | Frames -> slides, spatial sections, frameless fit. Limit: document order only, no outline/speaker notes, drops connectors in hand-drawn sections, white bg only. |
| Image / PDF / SVG export of board | Built (P1) | `@hc/export` + export job/engine; `backend/internal/render/{board,raster,svg,pdf}.go` | PNG/SVG/PDF with board nodes rendered server-side: the Go export engine now draws ink (variable-width brush), stickies (wrapped, vertically centered), and connectors (waypoint routing + arrowheads + label chips) via the shared `board.go` routing port, matching the engine's translate-anchored geometry. Frames still map to export pages. |
| Open file format export + forward migration | Built | `schema.ts` + `migrate.ts` (v7->v8 added sticky + `meta.kind`) | Board content is the open `@hc/schema` format with forward migrations and lossless `UnknownNode` round-trip. Core differentiator (data ownership). |
| Cross-tool board import (.excalidraw, Miro/FigJam) | Not started | n/a | `.excalidraw` JSON is the de-facto interchange standard; build an importer to `@hc/schema` for migration. |
| Mermaid / draw.io / DOT / VSDX import | Not started | n/a | Diagram-format importers (see diagram-as-code). draw.io/.drawio and DOT cover migration from common tools. |
| Structured session-as-data export (votes/comments/ideas report) | Not started | n/a | Structured Excel/JSON report of ideas/votes/comments/connectors (Stormboard). Niche. |
| Diagram-as-code export round-trip | Not started | n/a | See connectors/diagramming. Lossless export back to Mermaid/PlantUML for git/docs-as-code. Open lead. |

### Integrations and embeds

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Live-interactive board embed | Not started | n/a | Live collaborative embed for Confluence/Notion/iframe (Miro Live Embed). Build on the anonymous shared-link + a read/interactive embed view. |
| Public REST API / SDK for board automation | Partial | `@hc/sdk` (`oc` client); `/api/v1` chi router | Typed SDK + REST exist for the app; no documented public board-automation API surface (Miro REST/Web SDK). Differentiator per the open-API requirement. |
| Host-app distribution (Teams/Loop/Slack live embeds) | Not started | n/a | Microsoft Whiteboard's default-in-Teams placement is a distribution moat to attack. Live-object embeds in host apps as a distribution strategy. |
| PM-card two-way sync (Jira/Linear/GitHub/Azure DevOps) | Not started | n/a | Depends on cards widget + connector model. Deferred. |
| MCP server (board context to coding agents) | Not started | n/a | Expose board context to Claude Code/Cursor (Miro MCP, Whimsical MCP). Natural fit for the open format + agent story. Deferred. |
| Generic iframe / web / video embeds on board | Partial | `schema.ts:1319-1331` (`EmbedNode`) | In schema; not wired to board, no live render, SSRF guard needed. |

### Performance and scale

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Canvas2D scene-graph engine | Built | `@hc/engine` (`packages/engine`) | Framework-agnostic Canvas2D engine (browser/worker/server). Foundation. |
| Spatial indexing + level-of-detail + culling | Built (P1) | `packages/engine/src/spatial.ts` (`SpatialIndex` uniform grid hash); `render2d.ts` (`paint()` cull param + sub-pixel LOD); `scene.ts` (`queryViewport`) | Viewport culling skips leaf nodes whose `worldBounds` fall outside the cull rect and drops sub-pixel leaves (`max(w,h)*zoom < 0.5`); containers and connectors are never culled. `queryViewport(rect)` answers interest-management queries via a lazily built spatial hash over leaves. Still Canvas2D; the GPU path and obstacle-grade indexing remain Phase 5. |
| WebGL/WebGPU accelerated render path | Not started | n/a | On the engine roadmap. Needed for 60fps at 10k+ objects to beat Canvas2D-bound incumbents. Leap-ahead (Phase 5). |
| Page subdocuments / lazy load | Planned (doc 16) | n/a | One flat `Y.Doc` materializes everything at once; the 1000-element/50-page 60fps target is unproven (F16 AC-10). Needs `Y.Doc` subdocuments + virtualization. |
| Surgical incremental CRDT delta apply | Partial | `lib/ydoc.ts` (`applyToStore`/`fromDoc`) | Remote delta rebuilds the whole store doc per update; will not hold 60fps on large boards under heavy concurrent editing. Planned (doc 16). |

### Accessibility

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Keyboard navigation of spatial content (linear/spatial/hierarchical) | Not started | n/a | Miro's three-mode model is the leader. Category-lead opportunity; most boards weak here. |
| Screen-reader semantics for canvas objects | Not started | n/a | No labels/roles/actions for board nodes (incl. AI-generated). Needs an a11y layer over the scene graph. |
| In-canvas WCAG 2.2 AA checker + published board ACR | Partial | `@hc/a11y` package | Accessibility-checking package exists (design-side); not applied as an authoring-time board checker, no board ACR (per differentiator 7). |
| Reduced-motion / high-contrast / RTL support | Partial | `@hc/a11y` + i18n (roadmap doc 38) | Covered in the a11y/i18n NFR roadmap; verify the board surface honors them (reactions, ink, presence animations). |

### Presentation / share

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| Convert board to presentation deck | Built | `WhiteboardSurface.tsx` `convertToDeck` (402-426); `deck.ts` | Async server job produces a deck and routes to it. Frames are not live slides on the board. |
| Frames-as-slides interactive present mode (on the board) | Not started | n/a | Present-from-board where frames are slides and participants vote/contribute mid-deck (Miro Interactive Presentation Mode). PresentMode is deck-only. |
| Present-mode laser / pen ink / spotlight | Built | `PresentMode.tsx:80, 448, 1104-1106` | Full ephemeral presenter kit (L/D keys) but only in deck present mode, not on the live board. |
| Sharing / permissions (member grants + anyone-with-link) | Built | `ShareDialog.tsx`; `internal/sharing/*.go` | Member/email grants + link sharing at view/comment/edit with password/expiry/rotate/disable, anonymous via `/shared?token=`. Gated on share capability. |
| Custom / granular roles + per-object permissions | Not started | n/a | Roles are fixed (view/comment/edit) like Miro; no custom roles or finer per-object permissions. Enterprise wedge (Miro lacks custom roles too). |
| History / restore / branch | Partial | `HistoryPanel.tsx`; backend persistence (`DesignUpdateLog`, snapshots) | Snapshot version history + restore + one-level branch ship. Not built: CRDT update-log scrubber, in-CRDT named branch switching, auto snapshot triggers, log compaction. Planned (doc 16). |

### Onboarding and discoverability

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| First-run guided start / empty-board onboarding | Not started | `WhiteboardSurface.tsx` shows only a static empty hint | No guided first-run for the large facilitation/AI surface. Miro/FigJam/Mural ship guided onboarding (FR-33). |
| Interactive template / method tour | Not started | n/a | No walkthrough of templates/methods. Pairs with the template gallery. |
| Contextual coachmarks for facilitation / AI tools | Not started | n/a | Summon, private mode, voting, and the canvas agent are undiscoverable without coachmarks (FR-33). |
| AI "how do I run a retro?" assist | Not started | n/a | Natural-language facilitation guidance built on `@hc/aistudio`. Low cost, high adoption impact (FR-33). |

### Enterprise and administration

| Feature | Status | Where (code) | Notes |
| --- | --- | --- | --- |
| SSO (SAML / OIDC) | Built | auth layer (OIDC SSO per CLAUDE.md) | OIDC SSO ships. Verify the board honors workspace SSO gating. |
| MFA (TOTP) | Built | auth layer (per CLAUDE.md) | Ships product-wide. |
| SCIM provisioning | Not started | n/a | Automated user/group sync with the IdP (Miro Enterprise). Tracked under F38; board-relevant for enterprise buyers. |
| Custom / granular roles | Not started | n/a | See presentation/share. Enterprise wedge (Miro's role model is fixed). |
| Audit log / admin console | Not started | n/a | Board admin dashboard (licenses, usage, feature visibility), exportable audit log. Hooks into F38 observability. |
| Data residency / on-prem data ownership | Built | open file format + self-host (docker-compose, single binary) | Full data export + self-host already ship; the structural differentiator vs closed Miro/FigJam formats. |
| Anonymous-session moderation + admin controls | Not started | n/a | Facilitator/admin kick/ban, guest-content removal with an audit-trail entry, rate limiting, and an optional profanity filter for open sessions (FR-32). Hooks into the audit log / admin console row above. |

## 5. UX and interaction behavior

The board-specific interaction model, the complement to the F16 realtime UX (presence cursors, follow banner, lock badges, connection state) which this spec does not restate. The novel board gestures are specified here so they are reviewable as an interaction model, not only as capability rows.

- Board toolbar: a floating, draggable toolbar (`WhiteboardSurface.tsx`) carries the tools (select, sticky, frame, text, shape, connector, ink, laser) plus facilitation entry points (templates, timer, voting, reactions, cursor chat). Tool selection is single-key (S sticky, F frame, T text, V select, C connect, plus new P pen / B pencil / E stamp) and ignored while a text/sticky overlay is focused.
- Free-draw connector: hovering a shape reveals edge nubs; dragging from a nub shows a live routed preview and highlights a target shape on hover (connect-on-hover). Releasing over a shape attaches both ends; releasing in empty space either leaves a floating endpoint or, with the spawn affordance, drops a new connected shape at the cursor and keeps the chain going (the FigJam flowcharting gesture). A style picker on the connector sets straight/elbow/curved.
- Sticky speed: pressing Tab from a selected sticky spawns the next sticky in the current flow direction at a fixed offset and moves focus into it for immediate typing; bulk/grid create lays a block of stickies. Double-click on empty canvas drops a sticky at the cursor.
- Ink and stylus: pen and pencil draw a live smoothed stroke that commits once on stroke-end (the in-progress stroke is ephemeral, see the CRDT note in section 18); the marker/highlighter renders semi-transparent behind content; the eraser removes whole strokes or objects. On touch and pen devices, a pen `pointerType` draws while a finger pans/selects (FR-31), with palm rejection.
- Facilitation flows: when a facilitator triggers spotlight/summon, every participant's viewport snaps to the facilitator's and a dismissible "Following [name]" banner appears; take-control sustains the drive until released. In private mode, a participant's new contributions are visible only to them behind a "Hidden until reveal" affordance until the facilitator reveals. Breakouts present an assign/reconvene panel; a countdown and a "return to main board" prompt bracket the session.
- Search and jump: Cmd/Ctrl+F opens an overlay listing matches across sticky/shape/text/connector content; selecting a match pans and zooms the viewport to it (shared with named-views/zoom-to-frame).
- Keyboard navigation: three modes, switchable, over the 2D board: linear (Tab order through objects), spatial (arrow keys move selection to the nearest object in that direction), and hierarchical (enter/exit frames, sections, and groups). Every mode exposes the same create/edit/connect/vote actions available by pointer, and announces the focused object to assistive tech (section 12).

## 6. Functional requirements

Grouped by theme. These FR ids are the durable contract referenced by the acceptance criteria.

Infinite canvas and navigation:
- FR-1: The whiteboard surface renders on an unbounded coordinate space with a virtualized, auto-growing viewport; objects can be placed and parked anywhere, and pan/zoom (clamped 0.02-64x, about cursor) operate without page bounds. The MiniMap and ZoomControl track the unbounded extent.
- FR-2: On-board search (Cmd/Ctrl+F) finds across sticky text, shape/text labels, and connector labels, highlights matches, and jumps the viewport to a chosen match.
- FR-3: Named views / zoom-to-frame bookmarks let a facilitator save and recall regions and step through frames as an agenda.
- FR-31: The board surface supports touch and stylus input on the shared web canvas: pinch-to-zoom and two-finger pan, pen-vs-finger discrimination via PointerEvents `pointerType` (pen draws, finger pans/selects), palm rejection, and pressure/tilt capture feeding FR-5's `{x,y,p?,t?}` ink point stream.
- FR-34: A shareable deep-link encodes a target node id or saved-view id (extending the `/shared?token=` links) and, on open, restores the viewport via the FR-2 jump and FR-3 zoom-to-frame machinery, honoring the link's permission level and no-opping if the target was deleted.

Ink and drawing:
- FR-4: The board toolbar surfaces pen, pencil, marker/highlighter (semi-transparent, rendered behind content), and eraser tools.
- FR-5: A dedicated ink/draw node stores a point stream with optional pressure/velocity samples and a smoothing/seed field, distinct from `PathNode`'s bezier anchors, rendered by `@hc/engine`, and decimated/smoothed so large ink boards stay performant.
- FR-6: Freehand strokes optionally snap to clean shapes (draw-and-snap) and to straight segments with angle snapping as the stroke is drawn.

Connectors and diagramming:
- FR-7: A free on-canvas connector tool draws connectors anywhere, terminates in empty space, connects on hover from any shape edge, and spawns a connected shape from the handle; a board UI picker selects straight/elbow/curved style.
- FR-8: `ConnectorNode` gains optional `label`, `waypoints[]`, and a jump-over flag (additive). Routing supports multi-bend waypoints, obstacle-aware orthogonal routing, and per-side port slots so connectors do not stack on one midpoint.
- FR-9: Diagram-as-code import (Mermaid first, then PlantUML/DOT) produces editable native nodes + connectors with auto-layout; a diagram-as-code node stores the source plus a materialized representation and re-flows on edit; export losslessly serializes the laid-out graph back to text.

Auto-layout:
- FR-10: Layout becomes node-size-aware with collision resolution, and adds tree/Reingold-Tilford, force-directed, ELK/dagre-grade orthogonal (with dummy nodes), circular, and grid/matrix families over the existing `Graph` -> `Record<string,Point>` contract.
- FR-11: Auto-arrange/pack/align operates on unconnected stickies (not only connector-linked graphs); a mind-map node captures parent/child topology for first-class radial/balanced layout.

Sections and templates:
- FR-12: `FrameNode` gains optional section semantics (title-bar/header slot, collapse state, move-contents-together) so board sections are named, colored regions distinct from a plain layout/clip frame.
- FR-13: A template gallery offers thumbnails, search, categories, and parameterized builders (column count, team size); AI generates a methodology-correct populated board from a prompt.

Facilitation:
- FR-14: A spotlight/summon frame type pulls all participants to the facilitator's viewport on command; a take-control/moderator mode sustains that drive through a scripted agenda until released.
- FR-15: Private mode hides new contributions and edits from other participants until the facilitator reveals; reveal is gated server-side so contributions cannot leak early.
- FR-16: A protected/facilitator lock, gated to a facilitator role, survives participant tampering and is enforced server-side; facilitation rights can be handed off mid-session.
- FR-17: The timer supports presets (Pomodoro/stage/agenda) and an audible end alert; a laser pointer and ephemeral ink are available on the live board (not only in deck present mode).
- FR-18: Breakout boards split participants into sub-boards with assignment and reconvene; nested sub-boards (drill-down) let a card open its own board.

Voting and estimation:
- FR-19: Voting is server-authoritative: a backend vote store validates per-user budgets, prevents double-voting, and enforces anonymity/reveal; dot-votes sync across all collaborators via a vote WS frame.
- FR-20: Estimation (planning poker, ranked/weighted/ICE/RICE) and a gather-and-sort converge step (group/rank by vote count) ship, time-boxable against the timer.
- FR-21: An emoji-stamp tool places stamp nodes for dot-voting and sentiment.

AI on the canvas:
- FR-22: AI generates diagrams/flowcharts/mind-maps from a prompt as editable native nodes + connectors with auto-layout, every action one undoable scene-op through the `@hc/editor` command framework.
- FR-23: AI clusters stickies into labeled sections (sorting a copy to preserve originals) by a selectable axis (theme by default, or by sentiment or keyword, matching Miro Intelligent Canvas), extracts themes and action items, and summarizes the board or a selection into takeaways, decisions, and next steps, including an AI board-to-doc/board-to-deck.
- FR-24: A canvas AI agent reads the board (viewport screenshot + simplified in-view shape data + off-screen cluster summaries), acts via typed and sanitized action schemas (create/update/delete/align/distribute/reorder, normalize coordinates, auto-fix bad ids) routed through the command framework, streams its work, and keeps conversation memory; it runs on the BYO-key/self-host AI layer so board data never leaves the instance. The agent also supports a linked-node computation-graph mode where on-canvas context cards joined by connectors define the data flow into a prompt.
- FR-25: AI image generation places first-class image nodes onto the board; photo-of-stickies and hand-drawn diagrams digitize to editable nodes; idea expansion produces N variations off a node; multi-model side-by-side compare runs the same inputs across models on-canvas; and wireframe/sketch-to-code (make-real) sends the board surface or a selection to a vision model and renders the returned HTML via the sandboxed, SSRF-guarded `EmbedNode` render path, with a conversational annotate-iterate loop.

Interop, performance, accessibility, enterprise:
- FR-26: Cross-tool import (.excalidraw, draw.io/VSDX, Miro/FigJam) and diagram-format import produce `@hc/schema` nodes; board frames map to export pages for PNG/SVG/PDF; a structured session-as-data export emits ideas/votes/comments/connectors.
- FR-27: A spatial index (quadtree/spatial-hash) with level-of-detail and off-screen culling keeps hit-testing and render cost tracking visible detail, not total object count; the WebGL/WebGPU path falls back gracefully to Canvas2D.
- FR-28: Presence scales to hundreds of cursors via batching, interest management, and spatial culling.
- FR-29: The board is fully keyboard navigable in three modes (linear, spatial, hierarchical); every node type, including AI-generated ones, exposes screen-reader label/role/actions; an in-canvas WCAG 2.2 AA checker flags issues (low contrast, missing labels) at authoring time, and a board ACR is published.
- FR-30: Enterprise: custom/granular roles and per-object permissions, an audit log and admin console, SCIM provisioning (via F38), and full data export and on-prem self-host, with no whiteboard feature gated behind a paid tier.
- FR-32: Anonymous and open sessions are moderated: facilitator/admin kick and ban, removal of guest-authored stickies/chat/reactions with an audit-trail entry, per-participant rate limiting on anonymous content creation, and an optional profanity/keyword filter.
- FR-33: First-run onboarding and in-product discoverability: an empty-board guided start, an interactive template/method tour, contextual coachmarks for the high-surface facilitation and AI tools (summon, private mode, voting, the canvas agent), and an AI "how do I run a retro?" assist built on `@hc/aistudio`.

## 7. Data model / schema changes

All board node types and properties are added to the open file format per the schema-is-contract rule: extend the `NodeType` union and `KNOWN_NODE_TYPES` in `packages/schema/src/schema.ts`, define the interface + Zod schema with `...nodeBaseFields, type: z.literal("...")`, add it to the `KnownNode` union and discriminated `NodeSchema`, give it a default in `factory.ts`, register a forward migration step in `migrate.ts` keyed on the source version, and bump `CURRENT_SCHEMA_VERSION`. Additive node types and optional fields need only a version bump, because older files omit them and `UnknownNode.raw` preserves a newer client's nodes losslessly (so additive rollout is safe across mixed-version clients). Two coupling rules apply to every version bump: (1) raise the Go mirror `currentSchemaVersion` in `backend/internal/persistence/file.go` in the same change, or the write boundary `persistence/validate.go` rejects the newer file with a 422 (`ErrInvalidFile`) and nothing persists (the `UnknownNode` round-trip does not save this, the rejection is on the top-level `schemaVersion` field); purely-additive bumps need no new Go migration step. (2) Append a one-line entry to the schema-version-history doc-comment above `CURRENT_SCHEMA_VERSION` in `schema.ts` (currently stale, documenting only through v7).

New node types (additive, each one version bump):

```ts
// ink/draw stroke node (distinct from PathNode bezier anchors)
interface InkNode extends NodeBase {
  type: "ink";
  points: { x: number; y: number; p?: number; t?: number }[]; // point stream, optional pressure/time
  smoothing: number;   // 0..1 input-smoothing factor
  seed?: number;       // deterministic seed for sketchy/variable render
  brush: { width: number; opacity: number; color: Color; mode: "pen" | "marker" | "highlighter" };
}

// mind-map node capturing branch topology so radial/balanced layout is first-class
interface MindMapNode extends NodeBase {
  type: "mindmap";
  rootId: string;
  branches: { id: string; parentId: string | null; label: string; childIds: string[] }[];
  direction: "radial" | "right" | "balanced";
}

// kanban / multi-view dataset node (or a view descriptor over TableNode)
interface BoardViewNode extends NodeBase {
  type: "boardview";
  view: "kanban" | "table" | "timeline";
  columns: { id: string; title: string; cardIds: string[] }[];
  cards: { id: string; title: string; tags?: string[]; estimate?: number }[];
}

// diagram-as-code node: source of truth + materialized view for round-trip
interface DiagramCodeNode extends NodeBase {
  type: "diagramcode";
  lang: "mermaid" | "plantuml" | "dot";
  source: string;
  materializedIds?: string[]; // ids of generated child nodes, for re-flow
}

// emoji-stamp / reaction-stamp placed primitive (distinct from asset-id stickers)
interface StampNode extends NodeBase {
  type: "stamp";
  kind: "emoji" | "vote";
  glyph: string;       // emoji or vote marker
  authorId?: string;
}
```

Additive optional fields on existing nodes (no node mapping, version bump only):
- `ConnectorNode` (`schema.ts:1357-1387`): optional `label` (text/run), `waypoints: {x,y}[]`, `jumpOver: boolean`, and a new optional per-side `port`/`slot` field on `EndPoint.attach` (the existing `anchor` stays an opaque string, so this is purely additive and needs no factory/migration handling).
- `StickyNode` (`schema.ts:1428-1450`): optional `authorId` (color-by-author, sort-by-author) and optional `shape` (non-square stickies).
- `FrameNode` (`schema.ts:1033-1055`): optional `header` (title-bar slot) and `collapsed` state for board-section semantics.

Persistence and storage:
- Facilitation state (timer, vote, private-mode, spotlight) stays in `DesignFile.meta` as `WhiteboardMeta` (`meta.kind === "whiteboard"`) synced via the CRDT, except where integrity demands authority. For server-authoritative voting, private-mode reveal gating, and spotlight, add a Postgres mirror (not the file): a per-board `whiteboard_vote` table (board_id, session_id, node_id, user_id unique, cast_at) and a `whiteboard_session_state` row, both enforced at the query layer for per-workspace isolation.
- Comments, share grants/links, and activity stay in their existing Postgres services (`internal/comments`, `sharing`, `engagement`), not the schema.
- Per-workspace data isolation is enforced at the query layer for every new table, consistent with the existing services.

## 8. API and realtime

REST under `/api/v1` (chi router). Errors are RFC 7807 problem+json; all handlers emit structured JSON logs with board id, workspace id, user id, and request id.

```
POST   /api/v1/designs/{id}/whiteboard/votes          cast/toggle a vote (server-authoritative; 409 on closed/over-budget)
GET    /api/v1/designs/{id}/whiteboard/votes/{session}  tally (respects anonymity/reveal)
POST   /api/v1/designs/{id}/whiteboard/sessions       open/close a vote or estimation session
POST   /api/v1/designs/{id}/whiteboard/spotlight      start/stop spotlight or take-control (facilitator role)
POST   /api/v1/designs/{id}/whiteboard/private-mode   toggle private mode + reveal (facilitator role)
POST   /api/v1/designs/{id}/whiteboard/breakouts      create/assign/reconvene breakout boards
POST   /api/v1/imports/diagram                       diagram-as-code/cross-tool import -> job (returns 202 + job id)
POST   /api/v1/designs/{id}/whiteboard/ai             AI canvas action (diagram/cluster/summarize/agent) -> job for heavy ops
GET    /api/v1/jobs/{id}                               poll long-running ops (existing job registry)
```

Heavy operations never run inline in a handler: AI board generation, AI clustering/summarize over a large board, large cross-tool imports, and diagram materialization go through the in-process job registry and are polled via `GET /api/v1/jobs/{id}`. The canvas agent's multi-step run is registry-tracked for lifecycle, but its incremental actions stream to the client over `/realtime` (the new frame types below), not via job polling, since the registry has no streaming channel. A 422 problem+json is returned when an imported or AI-produced document fails boundary schema validation (`persistence/validate.go`), so a malformed document never persists for other clients.

Realtime over `/realtime` (extends F16). New `t` frame types are added to the client `ServerFrame` union (`frontend/src/lib/realtime.ts`) and the server dispatch (`backend/internal/realtime/serve.go`, `hub.go`):
- `{t:"spotlight"}` and `{t:"takecontrol"}`: facilitator viewport authority; participants' clients follow until release, gated to the facilitator role server-side.
- `{t:"vote"}`: server-authoritative vote cast/tally fan-out (paired with the Postgres vote store).
- `{t:"private"}`: private-mode visibility gating + reveal signal.
- `{t:"laser"}` and `{t:"stamp-ephemeral"}`: ephemeral live-board laser/ink, age-gated like reactions, never persisted.
- Presence (`PeerState` in `store/presence.ts`, `sanitizePresence` in `presence.go`) is extended for new ephemeral cues; spatial culling and cursor batching apply at the broadcast layer for scale.
- Facilitator gating: the spotlight/takecontrol/private/vote frames are authorized server-side against a facilitator role. The identity model today has only `RoleEditor`/`RoleViewer` (`presence.go`), resolved by `roleResolver` in `hub.go`; a facilitator role must be added to `PeerIdentity.Role` and surfaced by the sharing service, after which non-facilitator frames are dropped, consistent with the existing viewer-frame drop.

SDK (`@hc/sdk`): typed methods for votes, sessions, spotlight, private mode, breakouts, diagram import, and the AI canvas endpoint. Pure cores: `@hc/whiteboard` gains new layout families (same `Graph` -> `Record<string,Point>` contract), obstacle-aware `routeConnector` styles, a Mermaid/PlantUML/DOT parser-and-serializer pair, and session helpers for estimation/gather-and-sort; `@hc/aistudio` gains board-aware action schemas and context assembly. The existing comments, sharing, and activity endpoints are reused unchanged.

## 9. AI on the canvas

All canvas AI builds on the shipped F39 AI Creative Studio (`@hc/aistudio`): the BYO-key, multi-model, self-hostable provider-adapter layer with editable, reproducible output. Board data never leaves a self-hosted instance because inference routes through the workspace's own key/endpoint.

- Text-to-diagram: a prompt is structured by the AI into a node/edge graph, materialized into native `@hc/schema` nodes and `ConnectorNode`s, then laid out by `@hc/whiteboard` `layout.ts` (with the new node-size-aware families). Output is editable native nodes, not a rasterized image, and re-flows on edit. Inserted as one undoable batch.
- Sticky clustering / summarize: the AI reads sticky text (and off-screen cluster summaries for large boards), groups a copy into labeled `FrameNode` sections by a selectable axis (theme/sentiment/keyword; originals preserved, FigJam pattern), extracts themes and action items, and summarizes the board or a selection into decisions and next steps. Board-to-doc and board-to-deck reuse `deck.ts` and the docs layer, adding an AI structure pass. This clustering + summarize + board-to-deck pipeline ships as one synthesis wedge.
- Canvas agent: a Cursor-style agent reads the board via three context channels (viewport screenshot, simplified structured shape data for in-view nodes, and off-screen cluster summaries produced by the spatial index/LOD layer) and acts via typed, validated, sanitized action schemas (create/update/delete shapes, draw, align/distribute/stack/reorder, move its own viewport). Every action is normalized (coordinates clamped, bad ids auto-fixed) and routed through the `@hc/editor` command framework so it is one undoable scene-op that fans out over the CRDT to all peers. The agent streams its work live and keeps conversation memory; it also supports a linked-node computation-graph mode where context cards joined by connectors define the data flow into a prompt, distinct from the multi-model compare card.
- Image generation onto the board: reuses the AI media path (`23-ai-media.md`) to place first-class `ImageNode`s as selectable, croppable, re-promptable board objects that feed back into the agent's visual context.
- Wireframe-to-code (make-real): the board surface or a selection is sent to a vision model, which returns working HTML rendered on the board via the `EmbedNode` render path; the user annotates the result and feeds it back in a conversational iterate loop. Generated HTML is SSRF/sandbox guarded for self-hosters.
- Multi-model compare and idea expansion: the same inputs run across multiple configured models side-by-side on the canvas (showcasing the BYO-key/multi-model advantage), and idea expansion produces N variations or sub-ideas off a selected node. Repeatable AI workflows (workflows as canvas objects) are deferred until the agent lands.

## 10. Performance and scale

- Infinite canvas at 10k+ objects: a quadtree/spatial-hash index over the scene graph gives average constant-time hit-testing and viewport culling; level-of-detail simplifies or hides off-screen and tiny-on-screen content so render cost tracks visible detail, not total object count. Spatial indexing + LOD is a near-term dependency (it also produces the off-screen cluster summaries the AI agent consumes) and is carried on Canvas2D for Phases 1-3, decoupled from the GPU path.
- WebGL/WebGPU path: a tile-based, instanced, batched GPU renderer (on the engine roadmap) targets 60fps at 10k+ objects, with Canvas2D as the stable fallback when WebGL/WebGPU is unavailable. This is the Phase 5 leap-ahead.
- Large multiplayer: presence scales to hundreds of cursors via cursor batching/throttling and interest management (only sync what is in view); page subdocuments and surgical incremental CRDT delta apply (replacing the whole-store rebuild in `lib/ydoc.ts`) keep big boards at 60fps under heavy concurrent editing. Subdocuments, surgical deltas, cross-instance lock authority, and roster catchup are tracked as F16 work (Planned, doc 16).
- Budgets: local edits apply in the same frame; remote deltas apply incrementally without a full re-render; the committed target is 10,000 objects and hundreds of cursors at 60fps, proven under load in Phase 5.

## 11. Security and threat model

Board security is consolidated here rather than scattered across the AI, interop, and open-questions sections. Cross-cutting SSO/SCIM/compliance/observability infrastructure is owned by F38; this section covers the board-specific posture.

- Trust boundary and integrity: the `/realtime` relay is a blind relay (it forwards opaque `Y.Doc` updates and cannot decode them without a JS runtime, see section 18), so any state whose integrity matters cannot be enforced in the CRDT alone. Server-authoritative voting, private-mode reveal gating, protected/facilitator locks, and spotlight/take-control authority are enforced through the Postgres mirror and role checks at the API and WS-dispatch layer (`hub.go` `roleResolver`), not the document. Per-workspace data isolation is enforced at the query layer for every new table.
- Untrusted content rendering: `EmbedNode` iframes and AI wireframe-to-code HTML are rendered in a sandboxed iframe with an SSRF guard on any server-side fetch, consistent with the existing media SSRF guards. Generated HTML/CSS/JS is never executed with instance privileges; self-hosters get the same sandbox.
- Anonymous and open sessions: anonymous link participants are rate-limited on sticky/cursor-chat/reaction creation, a facilitator can kick/ban a participant and remove guest-authored content, and an optional profanity/keyword filter applies to guest text (FR-32). Removal actions are written to the audit trail.
- AI and data residency: all canvas AI routes through the workspace's own BYO key/endpoint (`@hc/aistudio`), so board content stays on the self-hosted instance; no board data egresses to a third party by default.
- Privacy posture: vote anonymity hides identities in the tally server-side; an end-to-end-encrypted room mode is an open question (section 18) because it conflicts with server-authoritative voting/locks and CRDT journaling.

### Observability and metrics

All board API handlers and the realtime dispatch emit structured JSON logs keyed by board id, workspace id, user id, and request id (consistent with the existing services). Success metrics: time-to-interactive on board open, sustained frame rate under the section 10 load targets, sync round-trip latency, AI action validity rate (section 16 eval), and facilitation adoption (sessions using summon/private-mode/voting). Org-wide observability, tracing, and dashboards defer to F38.

## 12. Accessibility and i18n

- Keyboard navigation in three modes over the 2D board: linear (tab order), spatial (nearest object up/down/left/right), and hierarchical (into/out of frames, sections, groups), matching the leading model and exceeding most boards.
- Full screen-reader semantics: every node type, including AI-generated nodes, exposes a label, role, description, and available actions through an a11y layer over the scene graph; ink, stamps, connectors (with their labels), and sections are all announced.
- In-canvas WCAG 2.2 AA checker at authoring time flags low-contrast notes, missing labels, and unreadable text on board objects (extending `@hc/a11y` from the design side to the board surface), and a board-specific ACR/VPAT is published with annual audits.
- Reduced-motion, high-contrast, and RTL/non-Latin support: reactions, ephemeral ink, presence animations, and timer alerts honor reduced-motion; sticky auto-fit uses `@hc/text` measured metrics so CJK/RTL/variable-width scripts are not misestimated; all facilitation UI strings are localized (templates are no longer English-only).

## 13. Import / export and interop

- Cross-tool import: an `.excalidraw` JSON importer (the de-facto interchange standard) and draw.io/.drawio, VSDX, and Miro/FigJam importers map to `@hc/schema` nodes for migration, run as jobs, and produce editable native nodes.
- Diagram-as-code: Mermaid (first), PlantUML, and DOT import to editable native nodes + connectors with auto-layout; lossless export serializes the laid-out graph back to text for git/docs-as-code; a diagram-as-code node holds the source plus materialized view and re-flows on edit. Round-trip (board to code and code to board) is an open lead vs incumbents who only do import well.
- Image/PDF/SVG export: board frames map to export pages through `@hc/export` + the Go render engine (already shipping for designs); a structured session-as-data export emits an Excel/JSON report of ideas, votes, comments, and connectors (Stormboard-style).
- Code export: wireframe-to-code emits clean, framework-agnostic HTML/CSS/JS, SSRF/sandbox guarded for self-hosters.
- Open format: every import, AI generation, and template lands as editable `@hc/schema` nodes with forward migration and lossless `UnknownNode` round-trip, the structural data-ownership differentiator vs closed Miro/FigJam formats.

## 14. Phasing / milestones

Dependency-ordered, from closing table-stakes gaps to leaping ahead. Each phase is independently shippable.

Phase 1 (SHIPPED): close the canvas table-stakes gaps (the board must feel like a real whiteboard).
- [Built] True infinite/unbounded canvas on the shared surface via content-extent navigation + continuous dot-grid surface (pan/zoom unbounded; MiniMap/fit track content parked beyond the page). The page-bounded model stays for designs; see the open-question resolution in section 18.
- [Built] Promote ink tools to the board toolbar; marker/highlighter + eraser; dedicated `ink` node + engine renderer (variable-width ribbon) + v9->v10 forward migration.
- [Built] Free on-canvas connector tool (draw anywhere, connect-on-hover with spawn-shape-from-handle, style picker); connector `label` + `waypoints[]` in schema with draggable bend handles and a label chip. Pure floating-endpoint terminate is the remaining sub-item.
- [Built] Sticky speed (bulk/grid create + Tab-to-spawn); drag-drop images onto the board.
- [Built] On-board search/find (Cmd/Ctrl+F) with viewport jump.
- [Built] Board-native laser + ephemeral ink (lifted onto the live board via presence; fading per-owner ink trail).
- [Built] Spatial index (uniform grid hash) + level-of-detail + viewport culling on Canvas2D, producing the `queryViewport` interest-management/off-screen cluster summaries that Phase 2 presence scale and the Phase 3 agent context depend on.
- [Built] Touch and stylus input: pinch-zoom, two-finger pan, pen-vs-finger discrimination, palm rejection, and pressure capture feeding the ink pipeline.
- [Built] The Go export engine renders ink/sticky/connector so boards export to PNG/SVG/PDF.

Phase 2: facilitation parity + presence scale (win the workshop buyer).
- Spotlight/summon + take-control (new WS frame types) on top of follow-mode.
- Private mode (hidden contributions until reveal) with server-gated reveal.
- Server-authoritative voting + cross-collaborator dot-vote sync; planning poker; enforced anonymous/private voting; gather-and-sort by vote count.
- Timer presets + end alert; protected/facilitator lock + facilitator-role handoff (one facilitator package).
- Outline/agenda navigation + hide-and-reveal sections; named views/zoom-to-frame + shareable deep-links to an object/frame/view.
- Presence scale (cursor batching, interest management, reusing the Phase 1 spatial index/LOD for interest culling); cross-instance lock authority via Redis CAS + roster catchup (with F16).
- Content moderation for anonymous/open sessions (facilitator kick/ban, guest-content removal + audit, rate limiting, optional profanity filter).
- First-run onboarding + discoverability (guided empty-board start, template/method tour, coachmarks, AI facilitation assist).

Phase 3: AI-native canvas (the wedge: build on AI Studio, BYO-key/self-host).
- AI diagram/flowchart/mind-map from prompt -> editable native nodes + connectors with auto-layout.
- AI sticky clustering + theme/action-item extraction (sort a copy) + AI summarize + AI board-to-doc/board-to-deck.
- Canvas AI agent (typed/sanitized actions, three-channel context, streaming, memory, BYO-key/self-host), riding the spatial-index/LOD off-screen cluster context from Phase 1.
- Idea expansion; photo-of-stickies + hand-drawn digitization; AI image generation as first-class board nodes; multi-model compare.

Out of scope (deliberately dropped): the former Phase 4 (smart diagramming + interop round-trip: diagram-as-code import/export, advanced/obstacle-aware auto-layout, swimlanes + BPMN/UML packs, cross-tool .excalidraw/draw.io/VSDX/Miro/FigJam import) and the former Phase 5 (WebGL/WebGPU render path + 10k-object scale, ecosystem/embeds/public board API/MCP, breakout boards + in-board A/V, custom roles + audit log/admin console, template marketplace). Phase 4 is a niche engineering-migration wedge; Phase 5 is mostly scale-and-enterprise polish (the GPU path only matters past ~10k objects, which most boards never reach). These are not part of the committed plan; the board is considered shipped for its core collaborate-and-facilitate use case after Phases 1 to 3. One exception worth revisiting if accessibility becomes a hard requirement (org/enterprise use): the cheap accessibility basics (keyboard navigation + screen-reader labels for board nodes), which are otherwise dropped along with the rest of the former Phase 5.

## 15. Acceptance criteria

These sample representative, testable criteria across the phases; a requirement not pinned to a numbered AC here is verified by the section 16 test plan.

- AC-1: A board pans and zooms over an unbounded space with no page edge; objects placed far apart are reachable, the MiniMap reflects the full extent, and the surface auto-grows.
- AC-2: Cmd/Ctrl+F finds across sticky/shape/text/connector content, highlights matches, and jumps the viewport to a selected match.
- AC-3: Pen, marker/highlighter, and eraser are on the board toolbar; an ink stroke persists as an `ink` node, round-trips through save/reload, and is preserved by an older client (UnknownNode) opening the file.
- AC-4: A connector can be drawn from any shape edge, terminate in empty space, spawn a connected shape from the handle, carry a label, and bend through waypoints; it re-routes around obstacles as nodes move.
- AC-5: A facilitator triggers spotlight and all participants' viewports snap to the facilitator's; take-control sustains the drive until released; both are rejected for non-facilitator roles server-side.
- AC-6: In private mode, a participant's new stickies are invisible to others until reveal, and the reveal cannot be bypassed by a client (server-gated).
- AC-7: A vote is server-authoritative: double-voting is rejected, per-user budget is enforced, anonymity hides identities in the tally, and votes appear for all collaborators in real time.
- AC-8: A prompt produces an editable native diagram (nodes + connectors) with auto-layout that re-flows on edit; nothing is rasterized; the whole generation is one undo step.
- AC-9: AI clusters stickies into labeled sections from a copy (originals intact) and summarizes the board into decisions/next-steps as an editable deck.
- AC-10: The canvas agent creates/edits/aligns shapes via typed actions routed as undoable scene-ops that fan out to peers; bad ids and out-of-range coordinates are sanitized; with a BYO key on a self-hosted instance, no board data leaves the instance.
- AC-11: Mermaid pasted in becomes editable native nodes; editing them and exporting yields valid Mermaid that re-imports to an equivalent board (round-trip).
- AC-12: A 10,000-object board stays at 60fps for pan/zoom/select with hundreds of cursors present; hit-testing remains responsive (spatial index + LOD).
- AC-13: The board is fully operable by keyboard in linear, spatial, and hierarchical modes; a screen reader announces every node type including AI-generated ones; the in-canvas checker flags a low-contrast sticky at authoring time.
- AC-14: No whiteboard feature (facilitation, AI, export, templates) is gated behind a paid tier or watermarked; the full board exports to the open format and runs self-hosted.
- AC-15: On a touch/pen device, pinch zooms and two-finger drag pans; a pen draws ink while a finger pans, palm contact is rejected, and pen pressure varies stroke width (FR-31/FR-5).
- AC-16: A wireframe/sketch is sent to a configured vision model and the returned HTML renders on the board in a sandboxed, SSRF-guarded `EmbedNode`; the user annotates and re-submits to iterate (FR-25).
- AC-17: A facilitator-applied protected lock cannot be moved or unlocked by a non-facilitator (rejected server-side), survives client tampering, and facilitation rights can be handed to another user mid-session (FR-16).
- AC-18: A facilitator splits participants into breakout sub-boards with assignment and reconvenes them; a card can open its own nested sub-board (FR-18).
- AC-19: An estimation round (planning poker) reveals on close, and a gather-and-sort step groups ideas by vote count, both time-boxable against the timer (FR-20).
- AC-20: An AI-generated image lands as a first-class, selectable image node, and a photo of physical stickies digitizes into editable sticky nodes (FR-25).
- AC-21: An `.excalidraw` file (and at least one of draw.io/VSDX/Miro/FigJam) imports to editable native `@hc/schema` nodes, and a board emits a structured session-as-data export of ideas/votes/comments/connectors (FR-26).
- AC-22: A deep-link to a specific object/frame/view opens the board scrolled and zoomed to that target at the link's permission level, and no-ops gracefully if the target was deleted (FR-34).

## 16. Test plan

- Unit (pure cores): `@hc/whiteboard` new layout families (size-aware spacing, collision resolution, deterministic output), obstacle-aware routing, Mermaid/PlantUML/DOT parse-and-serialize round-trip (golden fixtures), session helpers (estimation, gather-and-sort, vote budget/anonymity); `@hc/schema` migration steps for each new node type (older file opens, additive bump, UnknownNode preservation).
- Backend (Go): server-authoritative vote store (budget, double-vote, anonymity, per-workspace isolation), spotlight/private-mode/take-control role gating, RFC 7807 problem+json on every error path, structured-log assertions, import jobs through the job registry, boundary validation 422 on malformed AI/import output.
- Integration: realtime frame fan-out for spotlight/vote/private-mode/laser; cross-instance behavior with Redis; CRDT convergence with the new node types under concurrent edits.
- Frontend / E2E (compose stack, real browsers): infinite-canvas pan/zoom/park, ink tools, free-draw connectors, on-board search, facilitation flows (spotlight, private mode, voting), AI diagram/cluster/summarize/agent flows, keyboard navigation and screen-reader semantics.
- Load / perf: 10,000-object board at 60fps for pan/zoom/select; hundreds of simulated cursors; large concurrent-edit soak proving surgical delta apply holds frame rate.
- AI eval / golden-set: a harness scoring text-to-diagram correctness, clustering quality, summarize faithfulness, and agent action validity (no invalid ids, coordinates in range, every action undoable) across multiple models, for reproducibility.
- Manual: facilitator runbook (run a full workshop end to end), self-host smoke test with a BYO key proving no board data egress, accessibility audit against WCAG 2.2 AA.

## 17. Differentiators

- Everything free and unwatermarked: the full facilitation suite (private mode, summon/take-control, voting, planning poker, timers, breakouts) and the full AI canvas suite ship ungated, where Mural/Miro lock the strongest facilitation and AI behind paid plans (differentiator 1).
- Open file format + self-host + data ownership: every AI/diagram/import/template action lands as editable native scene-graph nodes (no rasterized dead-ends), fully exportable and runnable on-prem; closed Miro/FigJam formats cannot match this (differentiator 6).
- AI-native canvas agents on the BYO-key/self-host AI layer: match Miro Sidekicks / tldraw agent with typed/sanitized actions, three-channel context, streaming, and memory, but with board data that never leaves the self-hosted instance (differentiator 4).
- True offline-first CRDT collaboration already shipped: offline editing is still an unmet Miro community request; HyCanvas has the conflict-free core and adds board-specific facilitation + scale on top (differentiator 3).
- Performance leadership: spatial indexing + LOD now, the WebGL/WebGPU path next, targeting 60fps at 10k+ objects, beating Canvas2D-bound incumbents on huge boards (differentiator 2).
- Accessibility as a category lead: three-mode keyboard navigation, full screen-reader semantics for every node type including AI-generated ones, an in-canvas WCAG 2.2 AA checker at authoring time, and a published board ACR, an axis where every whiteboard competitor is weak (differentiator 7).
- Diagram-as-code round-trip: not just import to editable native nodes but lossless export back to text for git/docs-as-code, with auto-layout that re-flows on edit, an open lead since mainstream tools only do import well.

## 18. Open questions and risks

- Infinite canvas vs the page-bounded document model: RESOLVED for Phase 1. All document types share one virtualized viewport (the spatial index + culling + LOD in `@hc/engine`, and content-extent navigation in `store/editor.ts` `contentBounds()`/`fitToScreen` + `MiniMap`), so the machinery is not board-special-cased. The page rect stays part of the content extent (`contentBounds` = node-union union page-rect), so page-bounded surfaces still render and fit their page exactly as before, while the board gains the unbounded feel via a continuous dot-grid surface and content parked beyond the page edge. Pan stays unclamped. Export-to-pages and frames-as-slides are unchanged (frames still map to pages); a future board-as-single-unbounded-page coordinate model is not required by this approach and is not pursued.
- Server-side CRDT enforcement: per-node lock/permission and server-authoritative voting want the relay to decode the opaque `Y.Doc`, but there is no pure-Go yrs path (a cgo Rust dependency would break the single-binary build). Risk: decode cost/maintenance vs keeping enforcement client-side plus a parallel authoritative store for the few integrity-critical cases (votes, protected locks). The codebase already ships a JS snapshot-and-correct decoder (`packages/realtime/src/enforce.ts`, reused by `reconcile.ts`); decoding server-side would require a JS runtime holding the authoritative room doc, which the single Go binary has no place to run, which is exactly why protected locks and votes fall back to the Postgres mirror for integrity-critical state while convergence stays client-side.
- Ink node design: a draw-optimized point-stream (with pressure) is heavier in the CRDT and on the wire than bezier anchors. Risk: large ink boards bloat the doc, amplified because the reconciler (`reconcile.ts` `reconcilePlainArray`) delete-and-reinserts the whole array on any edit and `fromDoc` rebuilds the entire `DesignFile` per delta, so point sampling alone is not enough. Mitigation: commit an ink stroke once on stroke-end as a single array insert and carry the live in-progress stroke as ephemeral presence (like the laser), so a stroke is one write rather than N rewrites; combine with point sampling/decimation + smoothing. Needs a spike.
- Canvas AI agent action model: how is context assembled (viewport screenshot vs structured shape data vs off-screen cluster summaries) given the engine has no GPU/LOD pipeline yet? Mitigation: the spatial index/LOD work in Phase 1 produces the cluster summaries the agent needs, so the agent depends on it landing first.
- DOM-canvas / live-React-component custom shapes: tldraw's DOM rendering lets it embed live iframes/components as first-class shapes; a pure Canvas2D engine cannot without an overlay layer. Risk: live interactive widgets and rich embeds are blocked on this architectural decision. Tracked as a spike, not committed; an overlay-layer prototype is the likely first step.
- Diagram-as-code round-trip fidelity: which formats get full bidirectional sync (Mermaid first), and how is the source-of-truth conflict handled when both the text and the laid-out nodes are edited? Mitigation: the diagram-as-code node holds the source as the source of truth with a generated view, regenerated on source edit.
- Facilitation state authority: which of timer/vote/private-mode/spotlight need a server-authoritative mirror, and how do we avoid double-sourcing state? Mitigation: keep ephemeral/non-integrity state in CRDT meta; mirror only votes, private-mode reveal gating, and spotlight authority in Postgres.
- WebGL/WebGPU timing: RESOLVED by scope. The GPU path is out of scope (former Phase 5, dropped); Canvas2D + the Phase-1 spatial index/LOD is the committed rendering approach for Phases 1 to 3. If a board ever needs 10k+ objects at 60fps, revisit a GPU path then.
- Performance targets: the committed ceiling is what Canvas2D + the spatial index/LOD delivers; the 10k-object/hundreds-of-cursors target (former Phase 5) is out of scope. Presence stays bounded by the Phase-2 interest culling rather than a GPU/scale rebuild.
- Embed/iframe and SSRF posture: how do self-hosters safely render arbitrary third-party iframes and generated wireframe-to-code HTML without exposing the instance? Mitigation: sandbox + SSRF guard on the embed/render path, consistent with the existing media SSRF guards.
- End-to-end-encrypted rooms: the relay is already a blind relay for sync; a key-in-URL-fragment E2E model (Excalidraw) is the privacy bar for the open/self-host positioning but conflicts with server-authoritative voting/locks and CRDT journaling. Open question: scope E2E to a separate ephemeral room mode, deferred to post-F16 research.
