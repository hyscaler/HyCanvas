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
- **Next up.** Accessibility (full WCAG 2.2 AA), internationalization (100+ locales, RTL), and the operational layer (OIDC SSO, MFA, RBAC, a workspace audit trail, compliance, self-host, observability; SAML, SCIM, DLP and CMEK were dropped in August 2026 as enterprise scope this product is not pursuing) - [38-accessibility-i18n-security-compliance-selfhost-nfr.md](38-accessibility-i18n-security-compliance-selfhost-nfr.md). Prioritized ahead of creative-depth work: these are differentiators 7 and 6, they are where the evidence of blocked adoption actually sits (language support is named by teams as their sole reason not to adopt a tool; accessibility is a procurement gate the incumbents currently fail), and they are the axes a desktop-native competitor cannot follow us onto.
- **Withdrawn, August 2026.** A six-spec creation-depth set (procedural node graph, vector authoring, raster and painting, motion graphics, GPU rendering, creative interop and colour) was specified and then removed before any of it shipped. The demand evidence for creative depth from this audience stayed weak, and the first phase's prerequisites turned out to be defect repairs rather than groundwork; those repairs were kept and the procedural machinery was not. Canvas2D remains the shipped rendering path. The reasoning, the evidence, and the defects that remain unowned are recorded in the roadmap index under "Creation depth: specified, then withdrawn". Vector authoring depth and colour management stand on their own merits and would need fresh specs.
- Editor depth and polish, item by item - complete; see the archived record at [../shipped/editor-parity-backlog.md](../shipped/editor-parity-backlog.md).
- The public automation API and apps marketplace remain partial (PPTX now round-trips both directions).

Intentionally out of scope: native mobile and desktop apps (HyCanvas is web-only, including mobile browsers).
