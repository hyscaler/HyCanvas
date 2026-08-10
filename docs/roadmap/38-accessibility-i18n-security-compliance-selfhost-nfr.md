# F38: Accessibility, i18n, Security, Compliance, Self-Host, and Non-Functional Requirements

| Field | Value |
| --- | --- |
| Feature ID | F38 |
| Phase | 9 Cross-cutting |
| Sequence | 38 |
| Status | Not started. **Prioritized ahead of the creation-depth set (F40 to F45)** as of August 2026; see "Priority" below |

## Priority

This spec is the next programme of work, ahead of F40 to F45, on adoption evidence rather than preference. A demand review found that internationalisation and accessibility show more evidence of BLOCKING adoption than creative-depth capabilities do, and that both are axes a desktop-native incumbent cannot easily follow us onto.

The short version. Measured demand for creative depth from a template-first audience is weak (a pen tool scores single-digit votes on the closest vote-counted analogue board, against four figures for "let me export something a professional can open"), while language support is stated by real teams as the single reason they cannot adopt a tool, to the point that a paid industry exists to pre-fix right-to-left text for products that lack shaping. Accessibility behaves differently again: it is a procurement gate, not a popularity contest. Public buyers are required to demand conformance evidence and to prefer a conforming product where one exists, several universities restrict competing tools specifically over the accessibility of their EXPORTS rather than any missing feature, and the leading products' published conformance records are either years out of date or absent. Vote counts understate this badly, because one blocked institution is one lost contract.

Two consequences for how this document is read. First, the export-accessibility half (reading order, tagging, and preservation through format transformation) outranks the in-editor half, because that is where competitors actually fail and where procurement actually looks. Second, the RTL and Indic work in the i18n section share a root cause in text shaping, so they are one investment and should be scheduled together rather than as separate locales.

Nothing here reduces the value of F40 to F45. It sequences them second, and it means the parts of that set worth pulling forward early are the ones serving the existing audience (F44's Phase 0 parity work, outbound layered export, basic print mechanics, motion at the sequencing tier) rather than the ones that pursue a new one.

## 1. Context and Goal

Every feature doc before this one carries its own accessibility, performance, and security notes. This document consolidates those cross-cutting concerns into one enforceable specification and adds the enterprise and operational layer that turns HyCanvas from a working product into a production-grade, enterprise-ready, self-hostable platform. It covers four things: making the editor and its outputs accessible (WCAG 2.2 AA) and internationalized (100+ languages and RTL); securing and governing the platform for organizations (OIDC SSO, MFA, RBAC, a workspace audit trail, and encryption in transit and at rest); meeting compliance and data-residency obligations (SOC 2, GDPR, CCPA, ISO 27001, HIPAA); and delivering the self-host/private-cloud option plus the non-functional targets (availability, scalability, reliability, observability, backups/DR) that all of the above depend on.

This doc depends on all others because it cuts across them: accessibility applies to every editor surface, i18n to all UI strings and exports, security and audit to every action, and the NFR targets to every service. It does not re-specify feature behavior; it specifies the standards, controls, and infrastructure that every feature must satisfy, and the shared services (accessibility checker, localization runtime, audit log, key management, deployment topology) that implement them once for the whole product. Consistent with the product principle that everything is free, every capability here, including SSO, audit, compliance posture, and self-host, is available to organizations at no license cost.

Intended outcome: the editor is fully keyboard-navigable and screen-reader-usable, designs can be checked and exported as accessible artifacts, the UI runs in 100+ languages including RTL, organizations can enforce SSO, MFA and RBAC with a workspace audit trail, the platform meets the named compliance frameworks with data-residency options, and the entire system can be self-hosted while meeting a 99.9%+ SLA with defined RPO/RTO.

## 2. Scope

In scope:
- Accessibility of the application: WCAG 2.2 AA conformance for the editor and all product UI, full keyboard navigation, screen reader support, focus management, reduced-motion and high-contrast modes.
- Accessibility of outputs: a built-in accessibility checker for designs (color contrast, alt text, reading order, tap-target size), auto alt-text generation (composing with AI), and tagged/accessible PDF export (extending the export engine).
- Internationalization and localization: UI localization in 100+ languages, RTL layout mirroring, locale-aware formatting, and correct complex-script shaping in content (composing with the text engine).
- Identity and access for organizations: SSO via OIDC, MFA, and the RBAC model spanning workspaces, folders, designs, and admin functions (extending accounts and workspaces).
- Governance: a workspace-scoped audit trail of security-relevant actions, and brand-governance enforcement hooks (composing with brand controls).
- Encryption: encryption in transit and at rest everywhere.
- Compliance: the controls and evidence needed for SOC 2 Type II, GDPR, CCPA, ISO 27001, and HIPAA (where applicable), plus data-residency region pinning and full data portability/export.
- Self-host and private cloud: the deployment topology, configuration, and operations for running the whole platform (the whole product) on customer infrastructure via docker-compose and Helm (extending the architecture baseline).
- Non-functional requirements: availability/SLA, scalability, reliability (autosave/no data loss), observability, and backups/disaster recovery with defined RPO/RTO targets.

Deliberately out of scope, decided August 2026. These were in the original enterprise-governance sweep and are being dropped rather than deferred, because they target a buyer a free, self-hostable product is not pursuing, and each carries permanent cost:

- **SAML 2.0.** OIDC ships and covers every modern identity provider (Okta, Entra, Google, Auth0, Keycloak). SAML serves legacy IdPs and is expensive in the worst way: XML signature validation is one of the most reliably vulnerable surfaces in enterprise auth, and adopting it means owning that risk permanently. An operator who must have SAML can put an OIDC-speaking gateway in front.
- **SCIM 2.0.** Its real value is automated DEPROVISIONING. Without it an admin removes a departed user by hand, which is a genuine security gap rather than a mere inconvenience, and it is recorded here as a known one. For self-hosted teams whose admin knows their users, manual removal plus the API is enough.
- **DLP and content controls.** A policy engine for restricting downloads, copy-out, and app installs is enterprise governance for a buyer we are not selling to. One idea survives it, and is NOT DLP: a per-workspace toggle that disables external sharing. That is a checkbox and belongs with the sharing feature.
- **Customer-managed encryption keys (CMEK).** CMEK exists so a HOSTED tenant can control a key the vendor holds. A self-hoster already owns the database, the object storage, and the keys, so this would be elaborate machinery granting control the operator already has. The revocation semantics ("renders data inaccessible when revoked") are also a poor fit for a product whose first rule is zero data loss.

Deferred rather than dropped:

- **WebAuthn and passkeys.** TOTP ships, so the MFA requirement is satisfied and nothing is blocked. Passkeys are becoming the default expectation and the implementation cost is modest, so this stays on the list at low priority rather than being deleted.

Out of scope:
- The per-feature behaviors themselves; this doc sets the standards each feature must meet and the shared services that implement them, not the features.
- The base architecture, packaging skeleton, and open file format (the architecture baseline); this doc extends the self-host and NFR baseline established there.
- Account and workspace mechanics (accounts and workspaces); this doc extends them with SSO, RBAC and audit-trail specifics.
- The funding model (grants/sponsorships/at-cost print); this doc covers the technical NFRs, not the funding mechanism.

Deferred:
- FedRAMP and other government-specific accreditations beyond the named frameworks.
- A formal accessibility conformance audit (VPAT) by a third party, scheduled after AA self-conformance is verified.
- Region-active/active multi-master data residency; v1 supports region pinning and multi-region read with single-region write per workspace.

## 3. User Stories

- As a screen reader user, I want to navigate and edit designs entirely by keyboard with clear announcements so I can create without a mouse.
- As a designer, I want a one-click accessibility check that tells me where my design fails contrast, alt text, reading order, or tap-target size so I can fix it before publishing.
- As a publisher, I want my PDF export to be properly tagged so it is accessible to assistive technology.
- As a user in any country, I want the whole app in my language with correct right-to-left layout.
- As an IT admin, I want to enforce SSO and MFA so access stays controlled, and to remove a departed member's access in one place (deprovisioning is manual: SCIM is out of scope, see section 2).
- As a security officer, I want a workspace audit trail of who shared, exported, deleted, or changed permissions on what, so I can answer questions after the fact.
- As a compliance lead, I want the platform to meet SOC 2, GDPR, CCPA, ISO 27001, and HIPAA so I can adopt it in a regulated org.
- As a data-sovereignty-bound org, I want my data pinned to a region or hosted on my own infrastructure with my own encryption keys.
- As an SRE, I want defined SLA, RPO, and RTO and the observability and backups to meet them.

## 4. Functional Requirements

Accessibility (application):
- FR-1: The editor and all product UI conform to WCAG 2.2 AA; every interactive control is reachable and operable by keyboard with a visible focus indicator, a logical focus order, and no keyboard traps. Shipped so far: modals trap focus and restore it on close (`ui/Modal.tsx`), and the canvas context menu is now a real menu (menuitem roles, arrow/Home/End navigation, Escape closes, focus moves to the first item on open and returns to the canvas surface on close).
- FR-2 (partially shipped): A documented keyboard model covers all editor actions (navigate objects, move/resize/rotate by keyboard, open panels, run commands via the command menu); shortcuts are customizable (clipboard/shortcuts layer) and discoverable. Shipped on the canvas: Tab/Shift+Tab cycles objects in reading order, Enter opens text editing, arrows nudge (Shift for 10px), Alt+arrows resize (`growSelection`, routed through the same per-type geometry appliers as the properties panel so text/lines/grids/frames re-lay, one undo step even for mixed selections), comma/period rotate 1 degree (Alt: 15) about each node's own origin, Cmd/Ctrl+[ ] restack, digits set opacity, and Delete removes; the shortcuts panel documents all of it. Move/resize/rotate by keyboard is complete.
- FR-3 (partially shipped): Canvas objects and panels expose accessible names, roles, states, and values to assistive technology (an ARIA/accessibility tree mirrors the scene model), and meaningful changes are announced via live regions. Shipped so far: an offscreen listbox (`editor/A11yTree.tsx`) mirrors the active page's objects in resolved reading order as a single tab stop (aria-activedescendant roving, decorative and hidden nodes omitted, Enter selects on the canvas), a polite live region announces selection changes, names resolve through `lib/nodeName.ts` (an unnamed node announces its TYPE translated, not the raw file-format token, in the tree, the announcer, and the Reading Order pane alike), and a locked node announces its locked state. Remaining: panel-level ARIA audits.
- FR-4 (partially shipped): A reduced-motion mode honors the OS preference and disables nonessential animation across the UI and previews (animation content still exports as authored); a high-contrast UI theme is available. Shipped so far: app-wide reduced-motion (CSS globally damps animation/transitions and present mode skips slide transitions under the OS preference), a token-driven dark mode for the app chrome (system/light/dark preference in Settings under Appearance, applied before first paint; design content is never restyled), and a high-contrast theme as a second appearance axis: a `contrast` block in `theme.config.mjs` generates `.hc` and `.hc.dark` token overrides (secondary text to ~7:1, borders no longer subtle, black/white page surfaces in dark, an always-extreme focus outline) plus a `forced-colors: active` rule that keeps focus visible under Windows High Contrast; the preference (system, honoring `prefers-contrast: more` / normal / high) sits next to the theme picker in Settings, applies before first paint via the same no-flash boot script, and design content stays exempt through the existing `.light` escape hatch. The in-app motion override now ships as the third appearance axis: a Motion preference (system / reduced / full) next to the theme and contrast pickers, class-driven (`motion-reduce` forces the damping, `motion-full` defeats the OS media query via `:not()`), applied before first paint by the same boot script, and `prefersReducedMotion()` in lib/theme.ts resolves it for the JS consumers (present-mode slide transitions and the deck export planner), so the override reaches everything the OS setting reached. Nothing remains in this requirement.

Accessibility (outputs):
- FR-5 (shipped, with one gap): A built-in accessibility checker evaluates a design and reports per-element issues with severity and a jump-to-element action. `checkAccessibility` in `@hc/a11y` covers contrast (against the page background, reusing `@hc/color`), missing and empty alt text, text below a readable size, tap targets under the WCAG 2.5.8 minimum, and missing slide titles on multi-page decks; `AccessibilityDialog` lists the issues and clicking one jumps to the page and selects the node. The reading-order rule now ships: the checker flags a page whose resolved reading order repeatedly jumps against the visual flow (an element announced after one it sits entirely above, or behind it on the same row, direction-aware via the document language; two-column layouts survive because a column change is a single jump). One warning per page, surfaced in the Accessibility dialog as a page-level issue that jumps to the page. Documented limits it keeps: contrast is measured against the page background rather than composited render order, and image or pattern backgrounds are skipped.
- FR-6 (shipped): Alt text is authored per element in the properties panel (`NodeBase.altText` and `decorative`, schema v12), auto-suggested by AI (`lib/altText.ts` `generateAltText`, surfaced in the assistant), and the checker flags nodes that need it and lack it (`needsAltText` in `@hc/schema`).
- FR-7 (shipped): `Page.readingOrder` (schema v12) is independent of z-order, `resolveReadingOrder` falls back to z-order so every node always appears, the Reading Order pane edits it, keyboard Tab traversal on the canvas follows it, and the tagged PDF exporter emits the structure tree in that order.
- FR-8 (shipped, with an i18n defect): Tagged PDF export ships (`render/pdftag.go` plus the catalog in `pdf.go`), surfaced in the export dialog as a PDF option. It emits `/MarkInfo << /Marked true >>`, a `/StructTreeRoot` with a parent tree, `/Figure` elements carrying `/Alt`, reading order from FR-7, and `/ViewerPreferences << /DisplayDocTitle true >>`.

  The `/Lang` defect found during this audit is FIXED: the catalog hardcoded `en-US`, so every exported PDF claimed to be American English whatever it contained and a screen reader pronounced it that way. It now reads the document language (validated as a conservative BCP 47 shape, because `/Lang` is interpolated into the PDF catalog and an arbitrary string there could escape into PDF syntax) and falls back to `en-US`. The document language is now FIRST-CLASS: schema v18 adds optional `DesignFile.language`, the migration copies a legacy `meta.language` up (never removing it, so older readers keep finding it where they look), `pdfLang` prefers the new field and falls back to the legacy location for mixed versions, and the Accessibility dialog carries a "Document language" picker (each language shown in its own name) writing it via a store action that honors the same read-only gating as other document mutations.

Internationalization:
- FR-9 (shipped, minus the translations themselves): Every user-visible string the tooling can safely reach is externalized. 2214 call sites (848 JSX text nodes, 692 spoken attributes, 674 expressions such as ternaries, toast calls and object fields) across the components, pages, lib and store trees resolve through `tr("key")` against a 2527-key catalog at `frontend/src/locales/en.json`. `scripts/i18n-extract.mjs` did the mechanical work and stays in the repo, because it is also the definition of what counts as a translatable string and the CI check runs it to enforce that.

  The runtime is `frontend/src/lib/i18n.ts`. The English base catalog is BUNDLED and synchronous, so there is no state where the app renders blanks or raw keys while a catalog loads. Every other locale is a plain JSON file fetched from `/locales/<tag>.json` at runtime, so a self-hoster or translator adds a language by dropping a file next to the binary, with no rebuild and no pull request; `frontend/public/locales/README.md` is the instructions. Missing keys fall back to the base string per key, which makes a half-translated locale a normal shippable state. A regional catalog falls back to its generic language (`pt-BR` then `pt`), and a regional ENGLISH can still have its own catalog, so British spellings are expressible.

  Strings resolve through a plain function, not a hook, because roughly a third of them are not inside a component body. The root keys its tree on the catalog version instead, so switching language remounts the app once. It is named `tr` rather than the conventional `t` because this codebase already binds `t` as a local 306 times and an import named `t` is silently shadowed.

  Module-scope data tables cannot hold a `tr()` call at all: it would be evaluated once at import, before any catalog exists, and stay English whatever the user picks. The 448-entry sticker and shape library is therefore keyed by each row's stable `id` and translated at the RENDER site through `trOr`, which falls back to the English already in the row. Search matches both the translated and the English label so a missing translation never hides a shape. A test asserts no `tr()` call is ever made at module scope, because that bug is invisible in an English build.

  Plurals go through `Intl.PluralRules` with category-suffixed keys, so Arabic gets its six forms rather than English's two. Number, percent, compact, currency and byte-size formatting is locale-aware in `frontend/src/lib/format.ts`; date and time already honoured the account's locale, timezone and clock in `datetime.ts`.

  The account `locale` field existed but only date formatting read it, so choosing a language in Settings changed how timestamps looked and nothing else. It now drives the catalog, the document `lang`/`dir`, and the stored device preference.

  Deliberately NOT translated: text sent to a model. A system prompt is an instruction, not a label, and translating it changes what the model is asked to do while looking like a localization change. The extractor refuses both by wording and by field name (`prompt:`, `system:`), because "Shorten the following text" reads exactly like a UI string.

  Translated catalogs now ship for Spanish, French, German, Brazilian Portuguese, Japanese, Simplified Chinese and Hindi (100% coverage each, enforced per language by `i18n.catalogs.test.ts` along with placeholder integrity), plus a spelling-only British English overlay. Thrown errors now carry codes: `lib/errors.ts` defines `CodedError` (an error code plus an English message) and `userMessage()` translates the code at the display boundary, so logs stay English and greppable while toasts localize; the user-facing `new Error` sites the extractor counted are converted and their codes are in every catalog. A handful of throws with lowercase or interpolated messages (status-code failures like "video download failed (503)") remain plain and pass through `userMessage()` in English, as do problem+json details the SERVER composes, which are a server-side i18n question this frontend work does not claim.

  The frozen-table backlog is CLEARED: the unfreeze script's cross-file guard was checking for any same-named identifier instead of an actual import (every "consumer" was a coincidental same-name local), so with the guard corrected all 14 tables converted, their 77 strings are externalized and translated in every catalog, and `scripts/i18n-unfreeze.mjs frontend/src` now reports zero eligible tables. Canvas tool tooltips, animation preset names, role labels, and shortcuts-help headings all translate.

  Thrown status-code errors now translate too: `CodedError` carries interpolation params (`errors.download_failed` = "Download failed ({status})."), and the remaining user-reaching throws (video render/download, tagged-PDF export, image load, uploads, media reads/decodes, AI generation) are coded. A `job.error` detail composed by the server shows as-is.

  Server-side problem+json: the RFC 7807 body's stable `code` field is now the translation contract. `userMessage`/`apiCodeMessage` translate `errors.api_<code>` at the display boundary with the server's English detail as fallback, the upload and AI problem mappers emit codes (quota split into workspace/account/import-size; the quota UI branches on the code, sniffing detail only for older binaries), and shared-link codes translate. The long tail of uncoded `Problem()` sites (~450, mostly validation prose the UI never surfaces) gains codes opportunistically; until then those details show in English, by design.

- FR-10 (text ordering shipped; two gaps found): Bidirectional ORDERING now ships on both paths: `packages/text/src/bidi.ts` orders the browser layout and `backend/internal/render/bidi.go` orders the headless export, implementing the same UAX #9 subset so the two agree. A right-to-left paragraph is ordered correctly and, when its alignment was never set, aligns right.

  Glyph coverage, the gap found while building this, is now addressed. The embedded fallback covers Latin, Greek and Cyrillic only, and an uncovered rune was skipped silently, so Hebrew, Arabic, Indic and CJK text exported as NOTHING while the canvas showed words. The renderer now falls back across the registered fonts per glyph, `FONTS_DIR` lets an operator supply fonts for the scripts their users write in (registered at startup and logged), and a character nothing can draw is reported once rather than dropped in silence. Bundling a default non-Latin font is still open: the binary is deliberately self-contained, and a CJK face alone is tens of megabytes, so this is currently an operator decision rather than a default.

  Arabic shaping on the export path now ships: `backend/internal/render/shape.go` implements the Unicode joining model (contextual isolated/initial/medial/final forms via presentation forms, mandatory lam-alef ligatures, harakat transparency including at style-run seams, ZWJ/ZWNJ control, and the Persian/Urdu Forms-A letters), applied in logical order inside `OrderVisual` before reversal so a word whose style changes mid-word still joins across run seams. The RTL reversal is cluster-aware (combining marks stay attached to their base letter, which also fixes Hebrew niqqud placement), and a presentation form no registered font covers falls back to its base letters at draw time, so shaping never renders worse than the unshaped export did for fonts that cover the base block but not Forms-B. Documented limits: rare extension letters outside the table pass through unshaped; optional ligatures are not formed; a lam-alef split across two style runs draws unligated (matching the browser, which also draws per style run); and line measurement now measures the SHAPED text through the same font fallback the draw pass uses (previously an uncovered rune measured as zero width and ligatures were measured unmerged); a style run splitting mid-word still measures its fragments without seam context, a small residual approximation. Hebrew, which does not join, was already correct once a covering font is present.

  A visual-regression sweep (PNG vs rasterized SVG vs rasterized PDF over eight probe designs: shapes/strokes, gradients incl. hard stops and elliptical radials, all six effect kinds, blend+nested opacity, rotation/flip/scale, Latin and RTL text) closed four more divergences it exposed: the PDF now strokes the OUTLINE effect on vector bodies; SVG group opacity multiplies down per child like every other path instead of CSS-isolating the group; SVG text now carries its resolved base direction and alignment (direction=rtl + direction-aware text-anchor), so third-party SVG renderers put RTL punctuation on the correct side; and PDF text that neither an embedded font nor WinAnsi can encode (Arabic, Hebrew, CJK) rasterizes through the effect-layer machinery instead of emitting per-byte mojibake, tagged as a Figure with the words as a UTF-16 /Alt (which also fixed non-ASCII alt text being garbled in the structure tree). Residual export deltas are sub-1% RMSE for vector/effect/blend content, ~4% on smooth gradient ramps (interpolation smoothness), and font-substitution differences on text when third-party rasterizers pick different faces.

- FR-10 (UI mirroring, shipped): The document was hardcoded to `<html lang="en">` with no `dir` at all, so the interface never mirrored and misreported its language to assistive technology whatever locale the user was in. `frontend/src/lib/locale.ts` now resolves the locale (stored preference, else the browser) and sets both attributes before first paint, following the same no-flash pattern as the theme. Chrome uses logical properties throughout (161 physical spacing and alignment utilities converted, plus 53 positioning ones), and icons whose meaning is directional carry `MIRROR_IN_RTL`.

  Design content is explicitly EXEMPT, via `DESIGN_SURFACE_DIR`. `dir="rtl"` reverses every flex row it reaches, so an unpinned canvas would detach selection handles, guides, rulers and comment pins from what they point at, and mirror thumbnails of the user's own artwork. This is the direction counterpart of the `light` class that keeps document surfaces out of dark mode. `locale.pins.test.ts` asserts every design surface carries the pin and that no physical utility returns to the chrome, because neither regression is visible to a left-to-right reviewer.

  One idiom is deliberately left physical: `left-1/2` with `-translate-x-1/2` centres an element, and since the translate stays physical, mirroring only the inset shifts it off-centre. Centring has no direction to mirror.

  Per-document direction now ships for document surfaces: docs carry `meta.doc.direction` ("ltr" | "rtl" | "auto", toolbar-cycled), the page container and each text block resolve it (`dir="auto"` uses native first-strong resolution), and sheet cells edit and display with `dir="auto"` while the grid itself stays unmirrored because column order is data. Panel-resize drag math is now direction-aware everywhere it should be: the editor panels and the properties panel resolve pointer deltas through the UI direction, and the video editor's panels deliberately stay physical because that surface is pinned unmirrored. Nothing remains in this requirement.
- FR-11 (shipped): Translator contribution is a JSON file dropped into `public/locales/`, documented for translators rather than for developers, with partial catalogs explicitly supported. Pseudo-localization ships as `?pseudo=1`: every untranslated string renders accented between `«` and `»` and padded ~35% longer, which exposes both failures a translated build hits and an English build never does, a hard-coded string that stays plain ASCII, and a layout that only fits English. Interpolation placeholders are left intact so the pseudo-locale exercises substitution rather than breaking it. Missing keys fall back to the base locale per key.

  CI enforcement is `i18n.catalog.test.ts`: it runs the extractor in dry mode and fails if it finds ANY hard-coded user-visible string, and separately checks that every `tr()` key exists in the catalog, that no orphaned keys remain, and that no value is blank. The ratchet was mutation-tested by reintroducing a hard-coded `title` and confirming the failure.

Identity, access, and governance:
- FR-12 (OIDC ships): Organizations can require SSO via OIDC; on enforcement, password login is disabled for managed members (extending accounts and workspaces). SAML 2.0 is out of scope (see section 2).
- FR-13 (dropped): SCIM 2.0 provisioning is out of scope (see section 2). Members are managed through the admin UI and the API. The known gap this leaves is automated deprovisioning on offboarding, which stays a manual admin step.
- FR-14 (TOTP ships; passkeys deferred): MFA can be required org-wide or per role. TOTP is implemented (`mfa_enabled` on the account, `ErrMFARequired` on the auth path); WebAuthn and passkeys are deferred at low priority, not dropped.
- FR-15: RBAC defines roles (owner, admin, member, viewer, plus custom roles) with permissions scoped to workspace, folder, and design, and to admin functions (billing-free, but key/app/policy management); every API and editor action checks the actor's effective permission.
- FR-16 (reduced; extends what already ships): A workspace-scoped audit trail records security- and governance-relevant events with actor, target, timestamp, and request id, and is readable by workspace admins and exportable as a file.

  This EXTENDS existing machinery rather than building a subsystem: `activity_events` (table), `engagement.Emitter.EmitActivity`, the paging service, and the editor's `ActivityPanel` all ship today, and comments, sharing, and approvals already emit into them. The work is widening scope from per-design to per-workspace and adding the event kinds that are missing: sign-in and SSO, permission and role changes, external sharing and publishing, exports and downloads, and admin policy changes.

  Explicitly NOT in this requirement: hash-chained tamper evidence and SIEM streaming. Both were enterprise framing for a buyer that is out of scope. The bar here is that an admin can answer "who shared this externally", "who deleted it", and "who exported the data".
- FR-17 (dropped, with one survivor): DLP and content controls are out of scope (see section 2). The one piece worth keeping is not DLP: a per-workspace setting that disables external sharing outright, enforced at the sharing layer and recorded by FR-16. It belongs with the sharing feature rather than here.
- FR-18: Brand-governance enforcement (composing with brand controls) can lock fonts/colors/templates org-wide and is enforced at edit and export time.

Encryption and key management:
- FR-19: All data is encrypted in transit (TLS 1.2+; mTLS for service-to-service) and at rest (database, object storage, backups).
- FR-20 (dropped): Customer-managed encryption keys are out of scope (see section 2). A self-hoster already controls the database, the object storage, and their keys, so the requirement grants control the operator has by construction. FR-19 (encryption in transit and at rest) stands unchanged.

Compliance and data lifecycle:
- FR-21: The platform implements the controls required for SOC 2 Type II, ISO 27001, GDPR, and CCPA, and a HIPAA-eligible configuration (BAA-supported, with PHI handling controls) for applicable deployments.
- FR-22: Data-subject rights are supported: export all of a user's/workspace's data in the open format and standard formats, and delete on request with verifiable, auditable erasure honoring legal-hold exceptions.
- FR-23: Data residency: a workspace can be pinned to a region so its design data, assets, and backups stay in that region; cross-region movement is blocked unless explicitly allowed.

Self-host and NFR:
- FR-24: The complete platform (every service across the platform, including realtime, workers, AI adapter layer, public API, and plugin runtime) deploys on customer infrastructure via docker-compose (single-node) and Helm (Kubernetes), with object storage satisfiable by MinIO and AI satisfiable by self-hosted/BYO models (the AI platform).
- FR-25: The hosted service targets 99.9%+ availability with multi-region redundancy; the architecture scales horizontally to millions of concurrent users and large workspaces.
- FR-26: Reliability: every change is autosaved with no data loss (CRDT + snapshots, the realtime and persistence layers), and version history is recoverable; defined RPO and RTO targets govern backups and disaster recovery.
- FR-27: Observability is built in across all services: structured logs, OpenTelemetry traces, Prometheus metrics, error tracking, uptime/SLA monitoring, and usage analytics, with dashboards and alerting (extending the architecture baseline).
- FR-28: Backups are automated and tested with restore drills; a documented DR plan with failover meets the RPO/RTO targets.
- FR-29 (shipped): First-run setup happens in the browser. An unconfigured server (no `DATABASE_URL`) boots into a setup mode serving an installation wizard at `/installation/step-1`, gated by a one-time access secret shown on the operator's terminal; the wizard validates Postgres, storage, and SMTP answers live with visible progress, writes the configuration, migrates the database, hands over to the normal server in-process, and creates the first account. Step 1 handles reverse-proxy deployments ("Running HyCanvas behind a proxy?"), configuring the external URL separately from the internal bind host and port (`APP_URL`, `BIND_HOST`, `PORT`). An interactive first start offers a CLI wizard alternative (same questions and validation, in the terminal). The binary also self-daemonizes (`hycanvas service start|stop|restart|status|log`) with no OS service manager required, and `hycanvas storage migrate` moves local-disk blobs to S3-compatible storage (idempotent copy, verification, `.env` flip) without database changes.
- FR-30 (shipped): Public instances can cap one user's total upload storage across all their workspaces via `USER_STORAGE_QUOTA_BYTES` (unset = unlimited), independent of the per-workspace `ASSET_QUOTA_BYTES`; exceeding it returns a distinct 413, and both meters (workspace and account) render in the editor uploads panel and at the bottom of the dashboard sidebar, turning red as they approach the limit.
- FR-31 (shipped): Distribution: every release publishes prebuilt single binaries for linux (amd64, arm64), macOS (Intel, Apple Silicon), and Windows (amd64) with checksums, plus lean runtime-only Docker images built from those binaries. Releases are cut from the `stable` branch only (CI-enforced), with channel tags: finals publish `latest`, `development`, the bare semver, and its minor alias (`0.2`); pre-releases publish `development` and their own semver tag only.

## 5. UX and Interaction Behavior

Accessibility checker:
- A checker panel lists issues grouped by type (Contrast, Alt text, Reading order, Tap targets) with counts and severity; selecting an issue highlights and scrolls to the offending element and offers a fix (open contrast adjuster, add/generate alt text, set reading order, enlarge target).
- A running score/summary updates as issues are fixed; the checker can run per page or whole document and can be required before publish/export when an admin policy mandates it.
- Empty/clean state: a clear "No accessibility issues found" confirmation.

Localization and RTL:
- A language switcher in account/UI settings applies immediately; the entire chrome mirrors for RTL locales while canvas content retains its authored direction.
- Pseudo-locale (available in non-production builds) visibly flags untranslated strings and layout truncation.

Org administration (admin console, extending accounts and workspaces):
- An SSO setup wizard (OIDC issuer, client id and secret, test a login, enable enforcement) with a connection test and clear error surfacing.
- An access page to manage roles/custom roles and see effective permissions.
- An audit log viewer with filters (actor, action, target, time, IP), export, and SIEM streaming config.
- A governance settings panel limited to what remains in scope: the external-sharing toggle (FR-17) and the brand locks (FR-18), each showing its impact before it is applied and recording the change in the audit trail.
- A security page for SSO enforcement, MFA enforcement, and data-residency region selection.
- A data page for data-subject export and deletion requests with status tracking.

Self-host/ops surfaces:
- `/healthz` and `/readyz` on every service; a deployment guide and Helm values for scaling, storage backend, key management, and AI configuration; an admin status page showing version, region, backup status, and health.

States and degradation:
- When SSO is enforced, password login is hidden for managed members with a clear "Sign in with your organization" path.
- When CMEK is revoked, affected data is rendered inaccessible with an explicit, non-data-losing-from-the-customer-perspective explanation.
- Reduced-motion and high-contrast preferences are detected from the OS and overridable in settings.

## 6. Data Model

### TypeScript interfaces (shared governance and accessibility services)

```ts
// Accessibility checker
export interface A11yIssue {
  id: string;
  designId: string;
  pageId: string;
  nodeId?: string;
  category: "contrast" | "alt-text" | "reading-order" | "tap-target";
  severity: "error" | "warning" | "info";
  message: string;
  details?: Record<string, unknown>; // e.g. measured ratio, target size px
  fix?: "open-contrast" | "add-alt" | "set-reading-order" | "resize-target";
}

export interface A11yReport {
  designId: string;
  generatedAt: string;
  score: number;            // 0..100
  issues: A11yIssue[];
}

// Localization
export interface LocaleCatalog {
  locale: string;           // BCP-47, e.g. "ar", "ja", "pt-BR"
  direction: "ltr" | "rtl";
  messages: Record<string, string>;
  fallback?: string;        // base locale key
}

// RBAC
export interface Role {
  id: string;
  workspaceId: string;
  name: string;
  builtin: boolean;         // owner|admin|member|viewer
  permissions: Permission[];
}
export type Permission =
  | "design:read" | "design:write" | "design:delete"
  | "folder:manage" | "share:external" | "export"
  | "admin:sso" | "admin:audit" | "admin:apps";

// Audit trail (FR-16). This is the EXISTING `activity_events` row widened,
// not a new table: it gains a workspace scope so events that are not about one
// design have somewhere to live, and the security fields below. No chained
// hash: tamper evidence was enterprise framing and is out of scope.
export interface AuditEvent {
  id: string;
  workspaceId: string;      // NEW: today's rows are design-scoped only
  designId?: string;        // still set for design-scoped events
  actorId: string;
  action: string;           // e.g. "design.share.external", "member.role.change"
  targetType: string;
  targetId: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

// SSO (OIDC only; SAML is out of scope, see section 2)
export interface SsoConfig {
  workspaceId: string;
  issuer: string;
  clientId: string;
  clientSecretRef: string;  // stored encrypted, never returned by the API
  enforced: boolean;
  groupRoleMap: Record<string, string>; // IdP group -> role id
}

// Data residency & lifecycle
export interface ResidencyConfig {
  workspaceId: string;
  region: string;          // e.g. "eu", "us", "ap"
  allowCrossRegion: boolean;
}
export interface DataRequest {
  id: string;
  workspaceId: string;
  subjectId: string;
  kind: "export" | "delete";
  status: "pending" | "running" | "completed" | "blocked-legal-hold";
  resultUrl?: string;
  createdAt: string;
  completedAt?: string;
}

// DLP policy
export interface DlpPolicy {
  workspaceId: string;
  blockExternalShare: boolean;
  blockExport: boolean;
  blockCopyOut: boolean;
  appInstall: "open" | "allowlist" | "blocklist";
  brandLockEnforced: boolean;
}
```

### Postgres tables

```
a11y_reports(id, design_id, score, issues jsonb, generated_at)

locale_catalogs(locale, direction, messages jsonb, fallback, updated_at)

roles(id, workspace_id, name, builtin bool, permissions jsonb)
role_assignments(user_id, workspace_id, role_id, scope jsonb)

audit_events(id, workspace_id, actor_id, action, target_type, target_id,
             ip, request_id, metadata jsonb, hash, prev_hash, created_at)
                                              -- append-only; hash-chained

sso_configs(workspace_id, protocol, metadata jsonb, enforced bool,
            group_role_map jsonb, updated_at)
scim_tokens(id, workspace_id, hashed_token, created_at, revoked_at)

key_configs(workspace_id, mode, kms_provider, kms_key_ref,
            rotation_policy_days, status, updated_at)

residency_configs(workspace_id, region, allow_cross_region, updated_at)
dlp_policies(workspace_id, block_external_share, block_export,
             block_copy_out, app_install, brand_lock_enforced, updated_at)
data_requests(id, workspace_id, subject_id, kind, status,
              result_url, created_at, completed_at)
```

Audit logs are append-only and hash-chained (each row stores the prior row's hash) for tamper-evidence; they can be streamed to an external SIEM. Encryption metadata (wrapped DEKs) lives alongside the data it protects in Postgres/S3, with the wrapping key controlled by `key_configs`. Residency is enforced at the storage and query layer so a region-pinned workspace never has data written outside its region.

## 7. API and Interfaces

REST (base `/api/v1`):
```
# Accessibility
POST   /designs/{id}/a11y-check            run checker -> A11yReport
GET    /designs/{id}/a11y-report
POST   /nodes/{id}/alt-text/suggest        AI alt-text (AI media)

# Localization
GET    /i18n/catalogs/{locale}             served to clients; cached

# RBAC
GET/POST/PATCH/DELETE /workspaces/{id}/roles
POST   /workspaces/{id}/role-assignments

# SSO (OIDC only; SAML and SCIM are out of scope, see section 2)
POST   /workspaces/{id}/sso                 configure OIDC
POST   /sso/oidc/callback                   IdP callback

# Governance
GET    /workspaces/{id}/audit               filter and export audit events
PUT    /workspaces/{id}/sharing-policy      the external-sharing toggle (FR-17)

# Residency / data lifecycle
PUT    /workspaces/{id}/residency
POST   /workspaces/{id}/data-requests        export | delete (GDPR/CCPA)
GET    /workspaces/{id}/data-requests/{rid}
```

Operational interfaces:
- `/healthz`, `/readyz`, `/metrics` (Prometheus) on every service; OpenTelemetry trace export; structured JSON logs to the platform log sink (extending the architecture baseline).
- Export of accessible/tagged PDF is a parameter on the export engine: `accessible: true` produces PDF/UA-aligned output.

Internal contracts:
- `@hc/a11y`: `check(file: DesignFile): A11yReport` (runs in browser for live checking and on a worker for export gating).
- `@hc/i18n`: locale catalog loader, `t(key, vars)`, direction resolver, and a pseudo-locale generator for CI.
- `@hc/authz`: `can(actor, permission, scope)` used by every API route and editor action.
- `@hc/audit`: `record(event)` with hash-chaining; used by all feature services.
- `@hc/crypto`: envelope encryption with pluggable KMS providers for CMEK.

## 8. Technical Approach and Architecture

- Accessibility is built as a shared `@hc/a11y` service plus an accessibility tree the editor derives from the scene model, so screen readers see a meaningful, navigable structure that mirrors the canvas. The same `check()` function runs live in the editor (incremental, debounced) and on a worker to gate exports when policy requires. Tagged-PDF generation extends the export pipeline by mapping reading order, structure, alt text, and language into PDF structure tags.
- i18n uses an externalized catalog loaded at runtime; the build runs pseudo-localization in CI to catch hard-coded strings and truncation. RTL is handled with logical CSS properties and a direction resolver so the chrome mirrors automatically; canvas content directionality and complex-script shaping are owned by the text engine and only consumed here.
- Identity extends accounts and workspaces: a pluggable SSO module (SAML and OIDC) and SCIM 2.0 endpoints provision users/groups and map to roles. RBAC is a single `@hc/authz` `can()` check enforced uniformly at the API and in the editor; per-workspace isolation already exists at the query layer and RBAC layers on top.
- Audit is a shared `@hc/audit` service invoked by every feature on security-relevant actions, writing append-only, hash-chained events that can stream to a SIEM. DLP/governance policies are evaluated at the relevant choke points (share, export, copy, app install) and produce audit entries and optional blocks; brand locks compose with brand controls.
- Encryption uses envelope encryption: per-workspace data-encryption keys wrapped by a key-encryption key. For CMEK, the KEK lives in the customer's KMS (AWS KMS, GCP KMS, Azure Key Vault, HashiCorp Vault, or an external interface); revoking it makes wrapped data unreadable. TLS terminates at the edge with mTLS internally.
- Compliance is achieved by composing these controls (access control, audit, encryption, data lifecycle, residency) and operating them under documented policies; the platform produces the evidence (logs, configs, reports) that SOC 2/ISO audits require, and a HIPAA-eligible configuration enables stricter PHI handling and BAA coverage.
- Data residency is enforced by routing a region-pinned workspace's storage (Postgres shard/cluster and S3 bucket) and backups to that region and blocking cross-region reads/writes at the data layer.
- Self-host packages the full system (extending the architecture's compose + Helm baseline) so every service across the platform runs on customer infrastructure: object storage via MinIO, AI via BYO/self-hosted models (the AI platform), and CMEK via the operator's KMS or Vault. The Helm chart parameterizes replicas, storage class, ingress/TLS, key management, and AI configuration.
- NFRs are met by the existing horizontally scalable, queue-backed architecture: stateless API/realtime/worker tiers scale out; CRDT + snapshots (the realtime and persistence layers) guarantee autosave and recoverable history; multi-region redundancy and tested backups meet the SLA and RPO/RTO; observability (logs/traces/metrics/error tracking) is wired from day one and surfaced in dashboards and alerts.

## 9. Edge Cases and Constraints

- An accessibility check on a 1000+ element design must stay responsive: live checking is incremental and debounced; full checks run on a worker.
- Auto alt-text must be clearly marked as suggested and editable; the checker must not treat an AI suggestion as authoritative without user acceptance.
- Tagged-PDF reading order must remain correct when visual z-order and reading order diverge; the export uses the explicit reading order, not z-order.
- RTL mirroring must not flip directional content that should stay fixed (logos, certain icons, code); a per-element direction-lock is honored.
- SSO enforcement must not lock out the last org owner; a documented break-glass recovery path exists.
- SCIM deprovisioning must revoke sessions and tokens promptly and reassign or preserve the deprovisioned user's content per policy, never orphaning shared designs.
- Audit log must remain append-only and tamper-evident even under high write volume; the hash chain must survive partitioning, and gaps must be detectable.
- CMEK revocation must fail closed (data inaccessible) without crashing services or leaking plaintext from caches; key rotation must not interrupt active sessions.
- Data deletion must honor legal holds and must propagate to backups within the defined window while keeping DR integrity.
- Region-pinned data must never transit another region for processing (including AI and export); region-local workers and storage are required, and a cross-region request fails closed.
- Self-host without external KMS must still encrypt at rest using a platform-managed key from the operator's secret store.

## 10. Performance and Security Considerations

- Live accessibility checking adds no perceptible editor latency (incremental, off the critical path); full checks complete within seconds on a worker for large designs.
- Localization catalogs are cached and code-split per locale so switching language and loading RTL does not regress the sub-1s load budget.
- Authorization checks (`can()`) are O(1) against a cached effective-permission set with short TTL; a permission change invalidates promptly.
- All data encrypted in transit (TLS 1.2+, mTLS internally) and at rest (DB, object storage, backups); secrets via secret manager, never in repo or client bundle.
- Audit logs are append-only, hash-chained, access-controlled, and streamable to a SIEM; they capture actor, target, IP, and request id without storing sensitive payloads.
- Least-privilege IAM for storage, queues, and KMS; the platform is pen-tested and runs a bug-bounty program; dependency and container scanning gate every release.
- DLP choke points block disallowed share/export/copy/app-install actions server-side, not only in the UI, and log every decision.
- HIPAA-eligible configuration adds stricter access logging, encryption assertions, and PHI-handling controls; BAA coverage is configuration-gated.

## 11. Acceptance Criteria

- AC-1 (evidenced, August 2026): The editor is fully operable by keyboard with visible focus and no traps, and a screen reader can navigate and edit objects via the accessibility tree; an automated axe-core scan of all primary surfaces passes WCAG 2.2 AA rules. Measured against a production binary on an isolated database, driven through headless Chrome: axe-core 4.12.0 reports ZERO violations on all FIFTEEN scanned surfaces (login, signup, dashboard, the three settings tabs, the editor plus its export and share dialogs, and the whiteboard, docs, sheet, video, and present-mode surfaces), including axe's non-WCAG best-practice rules, and the keyboard-only walkthrough passes every step of the documented model. The run found and fixed a systemic contrast failure (the neutral ramp's secondary-text steps sat at 2.58:1 and are now above 4.5:1 on every chrome background), two unnamed form controls, missing page headings and heading order, and 48 nodes outside any landmark. A companion panel-level ARIA review fixed six keyboard blockers and roughly 55 unnamed controls. Full method, results, and the raw scan output: `docs/audits/2026-08-accessibility-and-export-audit.md`. NOT yet covered, and required before a formal conformance statement: a manual screen-reader pass (VoiceOver/NVDA/JAWS), plus the installation wizard, the shared-link viewer, and email templates.
- AC-2: The accessibility checker reports contrast, alt-text, reading-order, and tap-target issues per element, supports jump-to-fix, and updates its score as issues are resolved.
- AC-3: An accessible (tagged, PDF/UA-aligned) PDF export validates in an accessibility checker with correct tags, alt text, reading order, language, and title.
- AC-4: The UI runs in at least 100 locales with a runtime switch, RTL locales fully mirror the chrome while content directionality stays correct, and a CI pseudo-locale run finds no hard-coded strings.
- AC-5: An organization can enforce OIDC SSO and MFA; enforcing SSO disables password login for managed members, and removing a member through the admin UI or API revokes their sessions immediately. (SCIM is out of scope, so deprovisioning is that manual step and must be immediate when taken.)
- AC-6: RBAC blocks an out-of-permission action at both the API and the editor, and a custom role with a restricted permission set behaves as configured.
- AC-7: Sign-in, permission and role changes, external sharing and publishing, exports, and admin policy changes all appear in the workspace audit trail with actor, target, timestamp, and request id, readable by a workspace admin and exportable as a file. An event recorded against a design also remains visible in that design's activity feed.
- AC-8: Turning off external sharing for a workspace is enforced server-side (an existing external link stops resolving and a new one cannot be created) and the change itself is recorded in the audit trail.
- AC-9: Data is encrypted in transit (TLS 1.2 or better) and at rest across the database, object storage, and backups, verified by configuration test rather than by a key-management feature (CMEK is out of scope, see section 2).
- AC-10: A region-pinned workspace keeps its data, backups, and processing in-region; a cross-region access attempt fails closed.
- AC-11: A GDPR/CCPA data export returns all of a subject's data in open and standard formats, and a deletion request verifiably erases it (honoring legal hold) including from backups within the defined window.
- AC-12: The full platform deploys via docker-compose (single-node) and Helm (Kubernetes) with MinIO and a self-hosted/BYO AI model, passing health checks and a smoke run of core flows.
- AC-13: The hosted service demonstrates the 99.9%+ SLA target in monitoring, autosaves with zero data loss in a fault-injection test, and a restore drill meets the documented RPO/RTO.
- AC-14: Observability is live: logs, traces, metrics, error tracking, and uptime monitoring are present with dashboards and alerts for every service.
- AC-15 (shipped): On a clean host with only PostgreSQL available, starting the release binary with no `.env` and completing the browser setup wizard (including the terminal access secret) ends with a configured, migrated, running instance and a signed-in first account, without hand-editing any file; a wrong access secret is rejected and rate-limited.

## 12. Test and Verification Plan

- Unit: `can()` authorization matrix; audit hash-chaining and gap detection; accessibility rule evaluators (contrast math, tap-target sizing, alt-text presence, reading-order derivation); envelope-encryption wrap/unwrap and CMEK revocation; locale catalog loading and fallback.
- Integration: SSO (SAML/OIDC) against a mock IdP; SCIM provisioning/deprovisioning lifecycle; DLP enforcement at share/export/copy/app-install choke points; residency routing of storage and workers; data export/delete propagation to backups; tagged-PDF generation through the export pipeline.
- E2E: automated axe-core/WCAG scans across all primary surfaces; keyboard-only and screen-reader walkthroughs of core editing flows; RTL and pseudo-locale UI runs; full self-host deploy via compose and Helm with MinIO and a BYO model, then a smoke suite of create/edit/render/share.
- Resilience/NFR: load tests to validate horizontal scaling toward the concurrency targets; chaos/fault-injection for autosave-no-data-loss; backup-and-restore DR drill measuring RPO/RTO; SLA/uptime monitoring validation.
- Security/compliance: third-party penetration test and bug-bounty intake; control-evidence collection mapped to SOC 2/ISO 27001; GDPR/CCPA data-rights flows; HIPAA-eligible configuration review.
- Manual: assistive-technology testing with real screen readers (NVDA, VoiceOver, TalkBack); admin-console walkthroughs for SSO/SCIM/RBAC/DLP/keys/residency/data-requests; self-host operator guide on a clean environment.

## 13. Differentiators

- Enterprise-grade governance (SSO/SCIM/MFA, custom RBAC, tamper-evident audit, DLP) and full compliance posture provided to organizations at no license cost, where these are paid-tier or enterprise-only elsewhere.
- A first-class self-host/private-cloud option for the entire platform with customer-managed encryption keys and data-residency pinning, so organizations fully own their data, plus complete data portability in an open format.
- Built-in, actionable accessibility checking of designs (contrast, alt text, reading order, tap targets) with AI alt-text and properly tagged accessible PDF export, going beyond Canva's checks, paired with a fully keyboard- and screen-reader-operable editor.
- Best-in-class internationalization: 100+ UI locales, true RTL mirroring, and correct complex-script content shaping (composing with the text engine).
- Operational rigor by default: 99.9%+ SLA, multi-region redundancy, zero-data-loss autosave, observability, and tested backups/DR with defined RPO/RTO, all without paywalling reliability behind a tier.

## 14. Open Questions and Risks

- The exact RPO/RTO numbers and multi-region write strategy (single-region write with region pinning in v1) need to be finalized against cost and the SLA commitment.
- Achieving genuine WCAG 2.2 AA on an infinite, free-form canvas (especially screen-reader semantics for spatial layout and a live keyframe timeline) is hard and may need iterative AT testing and a documented conformance scope.
- HIPAA eligibility scope (which deployments and surfaces are in scope, BAA terms) requires legal review; AI features touching PHI need explicit handling rules.
- CMEK revocation semantics across cached/in-flight data and active realtime sessions need a careful design to fail closed without data corruption.
- Region-local processing for AI and export (so region-pinned data never leaves its region) constrains where workers and models run; self-host with BYO models simplifies this but the hosted multi-region story needs a topology spike.
- Risk: as a terminal cross-cutting doc depending on all others, drift in upstream features can silently break these guarantees; the audit, authz, a11y, and i18n shared services must be wired into every feature in review, not bolted on later.
