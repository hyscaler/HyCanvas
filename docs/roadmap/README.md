# Roadmap

The core product is built: a single-player editor, content systems (uploads, stock, templates), accounts and workspaces, document types (presentations, video, whiteboard, docs, sheets), export, brand kits, and a bring-your-own-key AI layer all ship today on the Go + Next.js stack described in `README.md`.

The specs that used to live here for already-shipped features have been removed; the shipped code is the reference for those. What stays below is the work that is genuinely unbuilt or early, kept as a forward-looking spec for each.

For the product-wide north star (the goals and differentiators we hold ourselves to), see [requirements.md](requirements.md).

## Remaining work

| Area | Spec | State |
| --- | --- | --- |
| Realtime collaboration (CRDT, presence, offline sync, branch/restore) | [16-realtime-collaboration.md](16-realtime-collaboration.md) | Early: relay + locks exist; full Yjs/offline/presence/branch UI unbuilt. |
| AI media (captions, TTS, music, avatar, lip-sync, image-to-video) | [23-ai-media.md](23-ai-media.md) | Not started: blocked on the video media pipeline and audio/video model endpoints. |
| Accessibility, i18n, security, compliance, self-host, NFR | [38-accessibility-i18n-security-compliance-selfhost-nfr.md](38-accessibility-i18n-security-compliance-selfhost-nfr.md) | Partial: the design accessibility checker ships; i18n, SSO/SCIM, observability, self-host, and compliance remain. |

Each spec follows the original 15-section template (context, requirements, data model, API, acceptance criteria, tests). Read the spec before picking up its area, and keep it in sync if scope changes.

## Editor parity backlog

[editor-parity-backlog.md](editor-parity-backlog.md) is a living, code-audited gap analysis of the editor against Canva, with items checked off as they ship. It is the place to pick up incremental editor work (curved text, element search, more animation presets, gradient sliders, page preset sizes, and so on).
