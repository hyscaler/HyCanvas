# F38: Accessibility, i18n, Security, Compliance, Self-Host, and Non-Functional Requirements

| Field | Value |
| --- | --- |
| Feature ID | F38 |
| Phase | 9 Cross-cutting |
| Sequence | 38 |
| Status | Not started |

## 1. Context and Goal

Every feature doc before this one carries its own accessibility, performance, and security notes. This document consolidates those cross-cutting concerns into one enforceable specification and adds the enterprise and operational layer that turns HyCanvas from a working product into a production-grade, enterprise-ready, self-hostable platform. It covers four things: making the editor and its outputs accessible (WCAG 2.2 AA) and internationalized (100+ languages and RTL); securing and governing the platform for organizations (SSO/SCIM/MFA, RBAC, audit, DLP, encryption and customer-managed keys); meeting compliance and data-residency obligations (SOC 2, GDPR, CCPA, ISO 27001, HIPAA); and delivering the self-host/private-cloud option plus the non-functional targets (availability, scalability, reliability, observability, backups/DR) that all of the above depend on.

This doc depends on all others because it cuts across them: accessibility applies to every editor surface, i18n to all UI strings and exports, security and audit to every action, and the NFR targets to every service. It does not re-specify feature behavior; it specifies the standards, controls, and infrastructure that every feature must satisfy, and the shared services (accessibility checker, localization runtime, audit log, key management, deployment topology) that implement them once for the whole product. Consistent with the product principle that everything is free, every capability here, including SSO, audit, compliance posture, and self-host, is available to organizations at no license cost.

Intended outcome: the editor is fully keyboard-navigable and screen-reader-usable, designs can be checked and exported as accessible artifacts, the UI runs in 100+ languages including RTL, organizations can enforce SSO/SCIM/MFA/RBAC/DLP with a complete audit trail, the platform meets the named compliance frameworks with data-residency options, and the entire system can be self-hosted with customer-managed keys while meeting a 99.9%+ SLA with defined RPO/RTO.

## 2. Scope

In scope:
- Accessibility of the application: WCAG 2.2 AA conformance for the editor and all product UI, full keyboard navigation, screen reader support, focus management, reduced-motion and high-contrast modes.
- Accessibility of outputs: a built-in accessibility checker for designs (color contrast, alt text, reading order, tap-target size), auto alt-text generation (composing with AI), and tagged/accessible PDF export (extending the export engine).
- Internationalization and localization: UI localization in 100+ languages, RTL layout mirroring, locale-aware formatting, and correct complex-script shaping in content (composing with the text engine).
- Identity and access for organizations: SSO (SAML 2.0 and OIDC), SCIM 2.0 provisioning, MFA, and the RBAC model spanning workspaces, folders, designs, and admin functions (extending accounts and workspaces).
- Governance: audit logging of security-relevant actions across all features, DLP/content controls, and brand-governance enforcement hooks (composing with brand controls).
- Encryption and key management: encryption in transit and at rest everywhere, and customer-managed encryption keys (CMEK) for organizations and self-hosters.
- Compliance: the controls and evidence needed for SOC 2 Type II, GDPR, CCPA, ISO 27001, and HIPAA (where applicable), plus data-residency region pinning and full data portability/export.
- Self-host and private cloud: the deployment topology, configuration, and operations for running the whole platform (the whole product) on customer infrastructure via docker-compose and Helm (extending the architecture baseline).
- Non-functional requirements: availability/SLA, scalability, reliability (autosave/no data loss), observability, and backups/disaster recovery with defined RPO/RTO targets.

Out of scope:
- The per-feature behaviors themselves; this doc sets the standards each feature must meet and the shared services that implement them, not the features.
- The base architecture, packaging skeleton, and open file format (the architecture baseline); this doc extends the self-host and NFR baseline established there.
- Account and workspace mechanics (accounts and workspaces); this doc extends them with SSO/SCIM/RBAC/audit specifics.
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
- As an IT admin, I want to enforce SSO and MFA and provision/deprovision users automatically via SCIM so access stays controlled.
- As a security officer, I want a complete, tamper-evident audit log and DLP controls so I can prove and enforce governance.
- As a compliance lead, I want the platform to meet SOC 2, GDPR, CCPA, ISO 27001, and HIPAA so I can adopt it in a regulated org.
- As a data-sovereignty-bound org, I want my data pinned to a region or hosted on my own infrastructure with my own encryption keys.
- As an SRE, I want defined SLA, RPO, and RTO and the observability and backups to meet them.

## 4. Functional Requirements

Accessibility (application):
- FR-1: The editor and all product UI conform to WCAG 2.2 AA; every interactive control is reachable and operable by keyboard with a visible focus indicator, a logical focus order, and no keyboard traps.
- FR-2: A documented keyboard model covers all editor actions (navigate objects, move/resize/rotate by keyboard, open panels, run commands via the command menu); shortcuts are customizable (clipboard/shortcuts layer) and discoverable.
- FR-3: Canvas objects and panels expose accessible names, roles, states, and values to assistive technology (an ARIA/accessibility tree mirrors the scene model), and meaningful changes are announced via live regions.
- FR-4: A reduced-motion mode honors the OS preference and disables nonessential animation across the UI and previews (animation content still exports as authored); a high-contrast UI theme is available.

Accessibility (outputs):
- FR-5: A built-in accessibility checker evaluates a design against rules for color contrast (text and non-text), missing/empty alt text, reading order, and minimum tap-target size, reporting per-element issues with severity and a jump-to-element fix action.
- FR-6: Alt text can be authored per element and auto-suggested by AI (composing with AI media); the checker flags images and meaningful objects lacking alt text.
- FR-7: Reading order is derivable and editable independent of z-order/visual position, and is honored by accessible exports.
- FR-8: PDF export (extending the export engine) can produce a tagged, accessible PDF (PDF/UA-aligned): structure tags, alt text, reading order, language, and document title.

Internationalization:
- FR-9: All product UI strings are externalized into a localization catalog and the app ships UI localization for 100+ locales with a runtime locale switch and locale-aware number/date/currency formatting.
- FR-10: RTL locales mirror the entire UI layout (chrome, panels, icons with direction) while preserving correct content directionality on the canvas; mixed-direction content is handled per the Unicode bidi algorithm (composing with the text engine's shaping).
- FR-11: The localization pipeline supports translator contribution, pseudo-localization in CI to catch hard-coded strings and truncation, and fallback to a base locale for missing keys.

Identity, access, and governance:
- FR-12: Organizations can require SSO via SAML 2.0 and OIDC; on enforcement, password login is disabled for managed members (extending accounts and workspaces).
- FR-13: SCIM 2.0 endpoints support automated provisioning, updates, and deprovisioning of users and groups, mapping IdP groups to roles/teams.
- FR-14: MFA (TOTP and WebAuthn/passkeys) can be required org-wide or per role.
- FR-15: RBAC defines roles (owner, admin, member, viewer, plus custom roles) with permissions scoped to workspace, folder, and design, and to admin functions (billing-free, but key/app/policy management); every API and editor action checks the actor's effective permission.
- FR-16: A tamper-evident audit log records security- and governance-relevant events from all features (sign-in/SSO, permission changes, sharing/publishing, exports, key and app management, admin policy changes, data export/deletion) with actor, target, timestamp, IP, and request id; logs are append-only, exportable, and streamable to a SIEM.
- FR-17: DLP/content controls let admins restrict external sharing, downloads/exports, copy-out, and which integrations/apps (apps and integrations) may be installed, with policy violations logged and optionally blocked.
- FR-18: Brand-governance enforcement (composing with brand controls) can lock fonts/colors/templates org-wide and is enforced at edit and export time.

Encryption and key management:
- FR-19: All data is encrypted in transit (TLS 1.2+; mTLS for service-to-service) and at rest (database, object storage, backups).
- FR-20: The platform supports customer-managed encryption keys (CMEK): an organization or self-hoster supplies/controls a KMS key used to wrap data-encryption keys, with key rotation and revocation that renders data inaccessible when revoked.

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
- FR-29 (shipped): First-run setup happens in the browser. An unconfigured server (no `DATABASE_URL`) boots into a setup mode serving an installation wizard at `/installation/step-1`, gated by a one-time access secret shown on the operator's terminal; the wizard validates Postgres, storage, and SMTP answers live with visible progress, writes the configuration, migrates the database, hands over to the normal server in-process, and creates the first account. The binary also self-daemonizes (`hycanvas service start|stop|restart|status|log`) with no OS service manager required.

## 5. UX and Interaction Behavior

Accessibility checker:
- A checker panel lists issues grouped by type (Contrast, Alt text, Reading order, Tap targets) with counts and severity; selecting an issue highlights and scrolls to the offending element and offers a fix (open contrast adjuster, add/generate alt text, set reading order, enlarge target).
- A running score/summary updates as issues are fixed; the checker can run per page or whole document and can be required before publish/export when an admin policy mandates it.
- Empty/clean state: a clear "No accessibility issues found" confirmation.

Localization and RTL:
- A language switcher in account/UI settings applies immediately; the entire chrome mirrors for RTL locales while canvas content retains its authored direction.
- Pseudo-locale (available in non-production builds) visibly flags untranslated strings and layout truncation.

Org administration (admin console, extending accounts and workspaces):
- SSO/SCIM setup wizards (upload IdP metadata, set ACS/entity id, test a login, enable enforcement) with a connection-test and clear error surfacing.
- An access page to manage roles/custom roles and see effective permissions.
- An audit log viewer with filters (actor, action, target, time, IP), export, and SIEM streaming config.
- DLP/governance policy editor (sharing, export, app allowlist, brand locks) with a preview of impact and a violation log.
- A security page for MFA enforcement, CMEK configuration, key rotation, and data-residency region selection.
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
  | "admin:sso" | "admin:scim" | "admin:audit"
  | "admin:dlp" | "admin:keys" | "admin:apps";

// Audit
export interface AuditEvent {
  id: string;
  workspaceId: string;
  actorId: string;
  action: string;           // e.g. "design.share.external", "key.rotate"
  targetType: string;
  targetId: string;
  ip?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
  hash: string;             // chained hash of prev+current for tamper-evidence
  createdAt: string;
}

// SSO / SCIM
export interface SsoConfig {
  workspaceId: string;
  protocol: "saml" | "oidc";
  metadata: Record<string, unknown>; // entity id, ACS, issuer, jwks, etc.
  enforced: boolean;
  groupRoleMap: Record<string, string>; // IdP group -> role id
}

// Encryption / CMEK
export interface KeyConfig {
  workspaceId: string;
  mode: "platform-managed" | "customer-managed";
  kmsProvider?: "aws-kms" | "gcp-kms" | "azure-kv" | "vault" | "external";
  kmsKeyRef?: string;
  rotationPolicyDays?: number;
  status: "active" | "rotating" | "revoked";
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

# SSO / SCIM
POST   /workspaces/{id}/sso                 configure SAML/OIDC
POST   /sso/saml/acs   /sso/oidc/callback   IdP callbacks
/scim/v2/Users  /scim/v2/Groups             SCIM 2.0 (token-auth)

# Governance
GET    /workspaces/{id}/audit               filter/export audit events
POST   /workspaces/{id}/audit/stream        configure SIEM streaming
PUT    /workspaces/{id}/dlp                  set DLP policy

# Keys / residency / data lifecycle
PUT    /workspaces/{id}/keys                 configure CMEK
POST   /workspaces/{id}/keys/rotate
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

- AC-1: The editor is fully operable by keyboard with visible focus and no traps, and a screen reader can navigate and edit objects via the accessibility tree; an automated axe-core scan of all primary surfaces passes WCAG 2.2 AA rules.
- AC-2: The accessibility checker reports contrast, alt-text, reading-order, and tap-target issues per element, supports jump-to-fix, and updates its score as issues are resolved.
- AC-3: An accessible (tagged, PDF/UA-aligned) PDF export validates in an accessibility checker with correct tags, alt text, reading order, language, and title.
- AC-4: The UI runs in at least 100 locales with a runtime switch, RTL locales fully mirror the chrome while content directionality stays correct, and a CI pseudo-locale run finds no hard-coded strings.
- AC-5: An organization can enforce SAML and OIDC SSO and MFA, and SCIM provisioning creates, updates, and deprovisions users/groups mapped to roles, with deprovisioning revoking sessions.
- AC-6: RBAC blocks an out-of-permission action at both the API and the editor, and a custom role with a restricted permission set behaves as configured.
- AC-7: Security-relevant actions across features appear in an append-only, hash-chained audit log that exports and streams to a SIEM; tampering is detectable.
- AC-8: A DLP policy blocking external sharing/export is enforced server-side and logged.
- AC-9: CMEK can be configured against a KMS; rotating the key continues to serve data, and revoking it renders data inaccessible without service crash.
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

## 13. Better than Canva

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
