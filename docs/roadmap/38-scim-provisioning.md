# F38 FR-13: SCIM 2.0 Provisioning

| Field | Value |
| --- | --- |
| Feature ID | F38, FR-13 |
| Role | Sub-spec of [`38-accessibility-i18n-security-compliance-selfhost-nfr.md`](38-accessibility-i18n-security-compliance-selfhost-nfr.md) |
| Status | **Shipped** (November 2026). Verified by unit, database and Authentik request-replay tests; a live sync from a running identity provider is the operator acceptance step in section 12 |
| Date | 2026-11-03 |
| Schema version | None. No design-file change; SQL migrations are additive only |

## 1. Why this reverses the August 2026 decision

F38 dropped SCIM in August 2026 and recorded the cost honestly: "The known gap this leaves is automated deprovisioning on offboarding, which stays a manual admin step." That gap is a security gap, not an inconvenience. In practice it is wider than the spec describes:

- Disabling a person in the identity provider stops new SSO logins only. Their existing HyCanvas sessions keep refreshing, their API keys keep working, and an editor tab they left open stays connected to the realtime room.
- Removing a member from a workspace (`RemoveMember`) deletes the membership row but revokes none of their API keys or sessions.
- Nothing in HyCanvas can mark an account as disabled at all: `users` has no state column, and the `SUSPENDED` membership status exists in the database enum but no code ever sets it.

SCIM is how identity providers (Authentik, Entra ID, Okta, Keycloak, JumpCloud) push that offboarding automatically. This spec adds it without adopting any of the enterprise machinery F38 rejected: no SAML, no paid tier, no hosted-tenant features. It is opt-in, off by default, and costs nothing for an instance that does not configure it.

The deprovisioning primitive it needs (section 5) is useful on its own, and closes the revocation gaps above for every instance, SCIM or not.

## 2. Scope

In scope:

- A SCIM 2.0 service provider (RFC 7643, RFC 7644) at `/scim/v2`: `ServiceProviderConfig`, `ResourceTypes`, `Schemas`, `Users`, `Groups`.
- Account lifecycle driven by the identity provider: create, update, deactivate, reactivate, delete.
- Workspace membership and role driven by identity-provider groups, through an explicit operator-written map.
- A per-workspace choice between additive and authoritative membership control.
- A deactivation primitive that actually cuts access: sessions, API keys, live sockets, every login path.

Out of scope:

- Bulk operations (`/Bulk`), sorting, `/Me`, ETags and versioned PUT. None of the target identity providers require them; `ServiceProviderConfig` says so.
- An admin UI for SCIM configuration. HyCanvas has no instance-level admin; configuration is environment variables, like `JWT_SECRET` and `OIDC_*`.
- Hard deletion of a person's data. `DELETE` deactivates (section 5.4). The zero-data-loss rule stands.
- Enterprise User extension attributes (department, manager). Accepted and ignored.

## 3. Configuration

SCIM is mounted only when `SCIM_TOKEN` is set. Unset, `/scim/v2` does not exist (404), so nothing is exposed by default.

| Variable | Required | Meaning |
| --- | --- | --- |
| `SCIM_TOKEN` | yes, to enable | The bearer token the identity provider presents. At least 32 characters; shorter refuses to start. Compared in constant time. |
| `SCIM_GROUP_MAP` | no | Comma-separated `<group display name>=<workspace slug>:<role>` entries, for example `hycanvas-admins=vera:admin,staff=vera:member`. Role is `owner`, `admin`, `member` or `viewer`. |
| `SCIM_WORKSPACE_MODES` | no | Comma-separated `<workspace slug>:<additive or authoritative>`. A mapped workspace not listed is `additive`. |

Rules:

- FR-1: The map is parsed at boot. A malformed entry, an unknown role, an unknown mode, or a mode for a workspace the map never mentions is a boot error naming the entry. A slug that does not exist yet is not an error (the workspace may be created later); it is logged at boot and on every reconcile that skips it.
- FR-2: Groups are matched by SCIM `displayName`, exactly and case-sensitively. Group names are what an operator sees in the identity provider; the provider's opaque group ids are not.
- FR-3: A person in several mapped groups for one workspace gets the highest of the mapped roles (owner > admin > member > viewer).
- FR-4: Unmapped groups are stored and served (the identity provider expects to read back what it wrote) and grant nothing.

## 4. Membership control

Each mapped workspace is in one of two modes. Both build the same desired state: for every active SCIM-managed person, the highest role their mapped groups grant in that workspace.

- FR-5 **Additive** (default). SCIM changes only memberships it created, marked by `workspace_members.managed_by_scim`. It adds a membership when desired and none exists, changes the role of a membership it manages, and removes a membership it manages that is no longer desired. A membership created any other way (an email invitation, the workspace creator) is never changed, even if the same person is also in a mapped group.
- FR-6 **Authoritative**. The identity provider is the single source of truth for the workspace. Every membership is brought to the desired state, and any member who is not desired is removed, including people invited by hand. Memberships SCIM touches become `managed_by_scim`.
- FR-7 In both modes SCIM never removes or demotes a workspace's last active owner. It skips that one change, logs it, and completes the rest of the request successfully.
- FR-8 Reconcile runs after every SCIM write that can change desired state (a user's `active`, group membership, a group rename, a group delete), for exactly the people affected, inside one transaction per request.
- FR-9 A deactivated person's memberships are handled by section 5, not by reconcile: they are suspended, not removed, so reactivation restores them unchanged.

## 5. Accounts

### 5.1 Create

- FR-10 `POST /Users` creates a passwordless account: email from the primary `emails` entry (else the first, else `userName` when it is an email address), display name from `displayName` (else `name.formatted`, else given plus family name), `email_verified = true` because the identity provider asserted it, and the personal workspace every account gets.
- FR-11 It also records the person's SSO identity: an `auth_identities` row with provider `OIDC` and `provider_subject = externalId`. Authentik's SCIM client sends `externalId = user.uid`, which is the OIDC `sub` under its default `hashed_user_id` subject mode, so the first SSO login lands on this account by subject, never by email. Operators using another subject mode set a SCIM property mapping whose `externalId` equals their OIDC `sub`.

### 5.2 Adopting an existing account

People often sign up through SSO before SCIM is configured. When `POST /Users` carries an email that already belongs to an account with no SCIM link:

- FR-12 The account is adopted (linked, not duplicated) only when one of these holds, mirroring the rules SSO linking already uses (`accounts/oidc_login.go`):
  - it already has an OIDC identity whose subject equals `externalId`, or
  - `OIDC_ALLOWED_EMAIL_DOMAINS` is set and lists the email's domain.
- FR-13 Otherwise the response is `409` with `scimType: uniqueness`. Authentik then looks the person up by `userName` and, finding no linked account, reports the conflict instead of taking the account over.

### 5.3 Update

- FR-14 `PUT /Users/{id}` replaces the person's SCIM attributes (Authentik's update path). `PATCH /Users/{id}` supports `replace` and `add` on `active`, `displayName`, `name`, `emails` and `userName`, with and without a path (Entra ID and Okta send both forms). Other attributes are accepted and ignored.
- FR-15 An email change that collides with another account is `409 uniqueness` and changes nothing.

### 5.4 Deactivate, reactivate, delete

- FR-16 `active: false` (by PUT or PATCH) deactivates the account in one transaction:
  1. sets `users.deactivated_at`;
  2. revokes every session (access ends on the next request: `VerifyAccess` already checks the session on every request);
  3. revokes every API key the person holds, in every workspace;
  4. sets each of their `ACTIVE` memberships to `SUSPENDED`, recording that deactivation did it (`suspended_by_deactivation`).
  After commit it closes every realtime socket the person holds on this instance and publishes the same to other instances.
- FR-17 A deactivated account cannot sign in by any path: password, magic link, OIDC (including an existing linked identity), and refresh-token rotation. Each returns the same "account disabled" error.
- FR-18 `active: true` clears `deactivated_at` and restores to `ACTIVE` exactly the memberships with `suspended_by_deactivation`, then reconciles (group membership may have changed meanwhile). Sessions and API keys stay revoked; the person signs in again.
- FR-19 `DELETE /Users/{id}` deactivates (FR-16) and detaches the SCIM link (`scim_users.deleted_at`); afterwards `GET` on that id is `404`. No data is deleted. A later `POST` for the same person (same `externalId`) re-links and reactivates.
- FR-20 Every query that grants access through a membership counts only `ACTIVE` memberships. Queries that merely list members may show `SUSPENDED` ones, labelled.

## 6. Groups

- FR-21 `POST /Groups`, `GET /Groups` (paged, `displayName eq` filter), `GET /Groups/{id}`, `PUT /Groups/{id}` (full member list), `PATCH /Groups/{id}` (`add`, `remove`, `replace` on `members` and `displayName`, including the `members[value eq "id"]` remove path), `DELETE /Groups/{id}`.
- FR-22 `DELETE /Groups/{id}` always succeeds (`204`) when the group exists, mapped or not, and then reconciles its former members. A `409` on group delete is not an option: Authentik's sync treats it as fatal and re-enqueues the whole sync forever.
- FR-23 A member reference to an unknown user id is ignored (logged), not a `400`, so one stale reference cannot block every later change to the group.

## 7. Protocol

- FR-24 Auth: `Authorization: Bearer <SCIM_TOKEN>`; anything else is `401` with a SCIM error body. The SCIM routes accept no session cookie and no API key.
- FR-25 Errors use the SCIM error schema (`urn:ietf:params:scim:api:messages:2.0:Error`) with `status` and, where defined, `scimType`, as the protocol requires; this is the one surface that does not use the house problem+json format.
- FR-26 Filters: `userName eq`, `externalId eq`, `emails.value eq` on Users; `displayName eq`, `externalId eq` on Groups. Any other filter is `400 invalidFilter`. Paging: `startIndex` (1-based) and `count`, default and maximum 100.
- FR-27 `ServiceProviderConfig` advertises exactly what is implemented: `patch` and `filter` supported, `bulk`, `sort`, `etag` and `changePassword` not. Authentik changes its behaviour on these flags, so they must be true.
- FR-28 Every SCIM write logs one structured line: `actor=scim`, operation, SCIM id, HyCanvas user id, and each membership change made or skipped (with the reason).

## 8. Data model

All additive, per the zero-data-loss rule:

- `users.deactivated_at` (timestamp, nullable).
- `workspace_members.managed_by_scim` (boolean, default false) and `workspace_members.suspended_by_deactivation` (boolean, default false).
- `scim_users`: `id` (the SCIM id, a UUID), `user_id` (unique), `external_id` (unique among non-deleted), `user_name`, `attributes` (the last representation, JSON), timestamps, `deleted_at`.
- `scim_groups`: `id`, `display_name` (unique), `external_id`, timestamps.
- `scim_group_members`: `group_id`, `user_id`, primary key on both.

## 9. Security notes

- The token holder can create accounts and grant any mapped role, including owner. Treat `SCIM_TOKEN` like `JWT_SECRET`.
- Adoption (5.2) never links on email alone without the same operator vouching SSO linking requires.
- Deactivation is the point of the feature; its acceptance criteria test that access is refused afterwards, not that rows were updated.

## 10. Acceptance criteria

- AC-1 With `SCIM_TOKEN` unset, every `/scim/v2` path is `404`.
- AC-2 A wrong or missing token is `401`; a session cookie or API key is not accepted.
- AC-3 The request sequence Authentik's client sends (create; `409` then `userName eq` lookup and adoption; full `PUT` with `active: false`; group create; `PATCH` member add and remove; group `DELETE`) completes with the status codes and bodies Authentik expects.
- AC-4 After deactivation, a previously valid access token, refresh token, API key and open realtime socket are each refused or closed, and each login path returns "account disabled".
- AC-5 Reactivation restores exactly the memberships deactivation suspended, and none that an admin removed meanwhile.
- AC-6 Additive mode leaves a hand-invited membership unchanged across every SCIM operation; authoritative mode removes it when it is not desired.
- AC-7 Neither mode removes or demotes a workspace's last owner, and the request still succeeds.
- AC-8 A first SSO login after SCIM provisioning lands on the provisioned account, by subject.
- AC-9 Group `DELETE` returns `204` for mapped and unmapped groups.

## 11. Verification

- Unit tests: map and mode parsing, role resolution, filter parsing, PATCH operation parsing.
- Database integration tests in the existing `_DB` pattern: lifecycle, adoption, reconcile in both modes, last-owner guard, deactivation side effects.
- A protocol test replaying Authentik's request shapes, taken from its SCIM client source (`authentik/providers/scim/clients/users.py`, `groups.py`).
- Not covered here: a live sync from a running identity provider. That is an operator acceptance step (section 12).

## 12. Operator setup (Authentik)

1. Set `SCIM_TOKEN` (and `SCIM_GROUP_MAP`, `SCIM_WORKSPACE_MODES`) on the instance and restart.
2. Create a SCIM provider with URL `https://<instance>/scim/v2` and the token, attached as a backchannel provider to an application whose policy bindings select exactly the people to provision. An application with no bindings provisions every user, including `akadmin`.
3. Run the first sync with `dry_run` enabled and read the logged requests before enabling writes.
4. Set `AUTH_OIDC_SIGNUP_ENABLED=false` if SCIM should be the only way accounts are created.
