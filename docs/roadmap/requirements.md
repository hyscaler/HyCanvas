# Product requirements (north star)

HyCanvas is a free, self-hostable, AI-native design platform. It aims to offer the full breadth users expect of a professional design suite and to lead on performance, AI, collaboration, openness, and accessibility, with everything free: no tiers, paywalls, or watermarks. Web-only.

This is the forward-looking goal sheet, not a spec of what already exists: the shipped code is the reference for built features. It captures the differentiators we hold ourselves to and the gaps that remain. The full original specification is preserved in git history if a detailed feature-by-feature account is ever needed.

## Differentiators

1. Completely free: every feature, asset, AI tool, and export, with no tiers, paywalls, or watermarks.
2. Faster GPU-accelerated engine that never lags on large designs or video.
3. True offline-first, CRDT-based collaboration with unlimited concurrent editors.
4. Multi-model AI with fully editable output, reproducible results, and bring-your-own model, key, or self-hosted endpoint with per-feature routing.
5. A real vector editor and print-grade CMYK/ICC color built in.
6. Open file format, full data export, public automation API, and self-host option.
7. Built-in accessibility checking and best-in-class internationalization.
8. Creator marketplace and developer ecosystem with everything free to end users.

## What is built

A broad feature set already ships: the multi-page editor (text, shapes, images, frames, masks, vector paths), templates and stock, uploads and media, color and brand kits, export (PNG/JPG/SVG/PDF and animated formats), presentations, the video editor, whiteboard, docs, sheets, charts and bulk-create, comments and sharing and approvals, publishing, print, and a bring-your-own-key AI layer (writing, generative image, design assist). Treat the running app as the source of truth for these.

## Gaps that remain

These are the capabilities not yet complete. Each links to where the work is tracked.

- Offline-first, CRDT-based real-time collaboration (presence, live cursors, branch/restore) - [16-realtime-collaboration.md](16-realtime-collaboration.md).
- AI media: captions, text-to-speech, music, avatar/lip-sync, image-to-video - [23-ai-media.md](23-ai-media.md).
- **Next up.** Accessibility (full WCAG 2.2 AA), internationalization (100+ locales, RTL), and the enterprise/operational layer (SSO/SCIM, audit, compliance, CMEK, self-host, observability) - [38-accessibility-i18n-security-compliance-selfhost-nfr.md](38-accessibility-i18n-security-compliance-selfhost-nfr.md). Prioritized ahead of the creation-depth set below: these are differentiators 7 and 6, they are where the evidence of blocked adoption actually sits (language support is named by teams as their sole reason not to adopt a tool; accessibility is a procurement gate the incumbents currently fail), and they are the axes a desktop-native competitor cannot follow us onto.
- GPU-accelerated (WebGL/WebGPU) rendering path and worker offload for large designs - [44-gpu-rendering.md](44-gpu-rendering.md); Canvas2D is the shipped path and stays the always-available baseline.
- The creation-depth set that turns the platform from a layout tool into a full 2D content-creation suite (differentiators 2 and 5), sequenced AFTER the item above: non-destructive procedural editing where layers and a node graph are two views of one document - [40-procedural-node-graph.md](40-procedural-node-graph.md); true vector authoring (pen/bezier, live booleans, parametric path effects, meshes, image trace) - [41-vector-authoring.md](41-vector-authoring.md); raster imaging and digital painting on the same canvas - [42-raster-and-painting.md](42-raster-and-painting.md); procedural and real-time motion graphics for design documents - [43-motion-graphics.md](43-motion-graphics.md); professional file interop with colour management and asset libraries - [45-creative-interop-and-color.md](45-creative-interop-and-color.md).
- Editor depth and polish, item by item - complete; see the archived record at [../shipped/editor-parity-backlog.md](../shipped/editor-parity-backlog.md).
- The public automation API and apps marketplace remain partial (PPTX now round-trips both directions).

Intentionally out of scope: native mobile and desktop apps (HyCanvas is web-only, including mobile browsers).
