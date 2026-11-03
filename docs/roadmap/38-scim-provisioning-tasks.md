# F38 FR-13 SCIM Provisioning: Implementation Tasks

> Execution board for [`38-scim-provisioning.md`](38-scim-provisioning.md). Each task is test-first: write the listed tests, watch them fail for the stated reason, implement, watch them pass, commit. Tasks are ordered so each one builds on committed, green work.

**Goal:** an opt-in SCIM 2.0 service provider whose deactivation actually cuts access.

**Architecture:** a new `internal/scim` package serves `/scim/v2` behind a static bearer token. Each request runs in one database transaction, with an `accounts.Service` bound to that transaction for account work, and closes realtime sockets only after commit. Deactivation is a general `accounts` primitive that SCIM calls.

**Tech stack:** Go, chi, pgx, Postgres. No new dependencies.

## Global constraints

- Additive SQL only: new nullable or defaulted columns and new tables. No drops, renames, or backfills that rewrite user content.
- Off by default: with `SCIM_TOKEN` unset, `/scim/v2/*` is `404`.
- SCIM errors use `urn:ietf:params:scim:api:messages:2.0:Error`; every other surface keeps problem+json.
- Group `DELETE` never returns `409`.
- No longdash characters in code comments or docs.
- DB tests follow the `_DB` pattern: skip without `DATABASE_URL`, run inside a transaction that is rolled back.
- Run Go tests with `GOTMPDIR` set when `/tmp` is small: `GOTMPDIR=~/.cache/go-tmp go test ./internal/...`.

Spec amendment made by this plan: the membership column the spec calls `suspended_by_scim` is `suspended_by_deactivation`, because deactivation is a general primitive SCIM happens to call.

## Task 1: Schema

**Files:** create `backend/internal/migrations/sql/20261103000000_f38_scim/migration.sql`; test `backend/internal/scim/schema_db_test.go`.

**Produces:** `users.deactivated_at TIMESTAMP(3) NULL`; `workspace_members.managed_by_scim BOOLEAN NOT NULL DEFAULT false`; `workspace_members.suspended_by_deactivation BOOLEAN NOT NULL DEFAULT false`; tables `scim_users (id UUID PK, user_id UUID UNIQUE REFERENCES users ON DELETE CASCADE, external_id TEXT, user_name TEXT NOT NULL, attributes JSONB NOT NULL DEFAULT '{}', created_at, updated_at, deleted_at)` with a unique index on `external_id` and on `lower(user_name)` where `deleted_at IS NULL`; `scim_groups (id UUID PK, display_name TEXT NOT NULL UNIQUE, external_id TEXT, created_at, updated_at)`; `scim_group_members (group_id UUID REFERENCES scim_groups ON DELETE CASCADE, user_id UUID REFERENCES users ON DELETE CASCADE, PRIMARY KEY (group_id, user_id))`. All `IF NOT EXISTS`.

**Tests:** `TestSchema_DB` asserts each column and table exists in `information_schema` after migrate, and that an existing `workspace_members` row reads `managed_by_scim = false`.

## Task 2: Deactivation primitive (accounts)

**Files:** create `backend/internal/accounts/deactivate.go`, `deactivate_test.go`; modify `accounts.go` (`issueSession`, `isSessionActive`, `findUserBy*` scan), `apikeys/apikeys.go` (`Verify`).

**Produces:**
- `var ErrAccountDisabled = errors.New("account disabled")`
- `func (s *Service) DeactivateUser(ctx context.Context, userID string) error`: in one transaction sets `deactivated_at` (idempotent), revokes every session and API key of the user, and sets each `ACTIVE` membership to `SUSPENDED` with `suspended_by_deactivation = true`.
- `func (s *Service) ReactivateUser(ctx context.Context, userID string) error`: clears `deactivated_at`, restores to `ACTIVE` exactly the memberships with `suspended_by_deactivation`, clears the flag. Sessions and keys stay revoked.
- `issueSession` returns `ErrAccountDisabled` for a deactivated user, covering password, magic link, OIDC, MFA verify and signup.
- `isSessionActive` also requires the session's user to be active (covers refresh rotation, the refresh grace path and every access-token check).
- `apikeys.Verify` returns `ErrRevoked` when the key's user is deactivated.

**Tests (`_DB`):** deactivate then: `VerifyAccess` with a previously valid token fails; `Refresh` fails; `Login` (password) returns `ErrAccountDisabled`; `LoginWithOidc` for a linked subject returns `ErrAccountDisabled`; a previously valid API key fails `Verify`; memberships read `SUSPENDED`. Reactivate: memberships back to `ACTIVE`; a membership an admin deleted while deactivated stays deleted; a fresh login succeeds; old tokens stay dead.

## Task 3: Disconnect a user's live sockets (realtime)

**Files:** modify `backend/internal/realtime/hub.go`; test `realtime/disconnect_test.go`.

**Produces:** `func (h *Hub) DisconnectUser(userID string)`: sends a `{"t":"moderated","action":"deactivated"}` frame to, and cancels, every connection the user holds in any room on this instance, then publishes the control sentinel `ctrlDisconnectUser` (payload: the user id) so peer instances do the same locally without re-publishing.

**Tests:** two users connected to two rooms; `DisconnectUser(a)` cancels every connection of `a` and none of `b`; `deliverRemote` with `ctrlDisconnectUser` does the same and calls no `Publish` (spy coordinator).

## Task 4: Provisioned accounts (accounts)

**Files:** create `backend/internal/accounts/provision.go`, `provision_test.go`.

**Produces:**
- `var ErrEmailTaken = errors.New("email already belongs to another account")`
- `func (s *Service) CreateProvisionedUser(ctx context.Context, email, name, oidcSubject string) (string, error)`: passwordless user, `email_verified = true`, personal workspace, and when `oidcSubject != ""` an OIDC identity for it. `ErrEmailTaken` on a duplicate email.
- `func (s *Service) AdoptForProvisioning(ctx context.Context, email, oidcSubject string) (userID string, err error)`: for an existing account with this email, returns its id when it already has an OIDC identity with `oidcSubject`, or when `OIDC_ALLOWED_EMAIL_DOMAINS` lists the email's domain (then ensures the identity exists). Returns `ErrEmailTaken` when the account exists but neither holds, and `ErrNotFound` when no account has the email.
- `func (s *Service) UpdateProvisionedUser(ctx context.Context, userID, email, name string) error`: `ErrEmailTaken` on collision.

**Tests (`_DB`):** create then OIDC login by subject lands on the same user (AC-8); adoption by matching subject; adoption by allow-listed domain; refusal without either; update collision.

## Task 5: Configuration (scim)

**Files:** create `backend/internal/scim/config.go`, `config_test.go`.

**Produces:** `type Role string` (`owner|admin|member|viewer`), `type Mode string` (`additive|authoritative`), `type Grant struct{ Workspace string; Role Role }`, `type Config struct{ Token string; Groups map[string][]Grant; Modes map[string]Mode }`, `func LoadConfig(getenv func(string) string) (*Config, error)` returning `nil, nil` when `SCIM_TOKEN` is unset, and `func (c *Config) ModeFor(slug string) Mode`.

**Tests:** valid map and modes; token shorter than 32 is an error; malformed entry, unknown role, unknown mode, and a mode for an unmapped workspace are errors naming the entry; one group mapped to two workspaces; whitespace tolerated.

## Task 6: Protocol primitives (scim)

**Files:** create `backend/internal/scim/protocol.go`, `filter.go`, `patch.go`, `discovery.go` and their `_test.go`.

**Produces:** `writeError(w, status int, scimType, detail string)`, `writeJSON`, `listResponse(resources []any, total, start int)`; `parseFilter(s string) (attr, value string, err error)` accepting only `<attr> eq "<value>"` with the allowed attributes per resource; `type patchOp struct{ Op, Path string; Value json.RawMessage }` and `parsePatch(body []byte) ([]patchOp, error)` (case-insensitive `op`); handlers for `ServiceProviderConfig`, `ResourceTypes`, `Schemas` advertising patch and filter true, bulk, sort, etag and changePassword false.

**Tests:** filter accepts `userName eq "a"`, rejects `co`, `and`, unknown attributes, unquoted values; patch parses Entra (`"Replace"`, path-less value object) and Authentik/Okta shapes; `ServiceProviderConfig` JSON flags.

## Task 7: Users endpoint (scim)

**Files:** create `backend/internal/scim/server.go`, `store.go`, `users.go`, `users_db_test.go`.

**Produces:** `type Server struct` built by `func NewServer(cfg *Config, db accounts.DBTX, jwtSecret string, disconnect func(userID string), log *slog.Logger) *Server`, `func (s *Server) Handler() http.Handler` (bearer auth, per-request transaction, disconnect after commit). `nil` config gives a handler that answers every path `404` (AC-1). Users: `POST`, `GET` (list, filter, paging), `GET /{id}`, `PUT`, `PATCH`, `DELETE`, per spec section 5.

**Tests (`_DB`, through `httptest` against `Handler()`):** auth `401` cases (AC-2); create; duplicate create is `409 uniqueness`; adoption cases; `PUT active:false` deactivates (session dead after) and calls `disconnect` once, after commit; `PATCH` Entra shape deactivates; `active:true` reactivates; `DELETE` then `GET` is `404`; re-`POST` with the same `externalId` relinks and reactivates.

## Task 8: Groups and reconcile (scim)

**Files:** create `backend/internal/scim/groups.go`, `reconcile.go`, `groups_db_test.go`.

**Produces:** Groups endpoint per spec section 6; `func reconcile(ctx context.Context, tx pgx.Tx, cfg *Config, userIDs []string, log *slog.Logger) error` implementing FR-3, FR-5 to FR-9, called by every write that can change desired state.

**Tests (`_DB`):** group create with members grants the mapped role (additive); highest role wins; `PATCH` remove takes it away; a hand-invited member is untouched in additive mode (AC-6) and removed in authoritative mode; last owner is never removed or demoted and the request still succeeds (AC-7); a deactivated member is not reconciled; `DELETE` returns `204` for mapped and unmapped groups and removes SCIM-granted memberships (AC-9); unknown member ids are ignored.

## Task 9: Wiring and the Authentik replay

**Files:** modify `backend/internal/httpapi/server.go` (`Deps.SCIM http.Handler`, always mounted at `/scim/v2`), `backend/cmd/api/main.go` (load config, fail boot on error, pass `rtHub.DisconnectUser`); create `backend/internal/scim/authentik_replay_db_test.go`.

**Tests:** the request sequence from Authentik's SCIM client source (AC-3): user `POST`; `POST` again, `409`, `GET ?filter=userName eq "..."` returns the linked resource; full `PUT` with `active: false`; group `POST` with `externalId`; `PATCH` add then remove member; group `DELETE` `204`. Plus: router returns `404` for `/scim/v2/Users` with SCIM disabled, not the frontend's HTML.

## Task 10: Operator documentation

**Files:** modify `DOCKER_SETUP.md` (environment table, a SCIM section), `docs/self-hosting.md` (sign-in section pointer), `docs/FEATURES.md` (tick SCIM), the spec's status line.

**Check:** every variable in spec section 3 appears in the environment table; no longdash characters.
