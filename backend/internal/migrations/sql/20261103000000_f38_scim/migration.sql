-- SCIM 2.0 provisioning and account deactivation (F38 FR-13,
-- docs/roadmap/38-scim-provisioning.md).
--
-- Until now nothing could mark an account as disabled: removing a person at the
-- identity provider stopped new SSO logins and nothing else, so their sessions,
-- API keys and open editor sockets kept working.
--
-- Additive only: one nullable column on "users", two defaulted columns on
-- "workspace_members", and three new tables. No existing row changes meaning:
-- every account stays active (deactivated_at NULL) and every membership stays
-- hand-managed (managed_by_scim false). A rollback to the previous binary
-- ignores the new columns and tables.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deactivated_at" TIMESTAMP(3);

-- managed_by_scim: SCIM created or took over this membership, so SCIM may change
-- or remove it (additive mode leaves every other membership alone).
-- suspended_by_deactivation: deactivation moved this membership from ACTIVE to
-- SUSPENDED, so reactivation restores exactly these and nothing else.
ALTER TABLE "workspace_members" ADD COLUMN IF NOT EXISTS "managed_by_scim" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "workspace_members" ADD COLUMN IF NOT EXISTS "suspended_by_deactivation" BOOLEAN NOT NULL DEFAULT false;

-- One row per account the identity provider manages. id is the SCIM resource
-- id handed to the provider. deleted_at marks a SCIM DELETE: the account is
-- deactivated, never removed, and the link is detached so GET returns 404.
CREATE TABLE IF NOT EXISTS "scim_users" (
    id UUID PRIMARY KEY,
    "user_id" UUID NOT NULL UNIQUE REFERENCES "users"(id) ON DELETE CASCADE,
    "external_id" TEXT,
    "user_name" TEXT NOT NULL,
    attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3)
);
CREATE UNIQUE INDEX IF NOT EXISTS "scim_users_external_id_key" ON "scim_users"("external_id") WHERE "deleted_at" IS NULL AND "external_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "scim_users_user_name_key" ON "scim_users"(lower("user_name")) WHERE "deleted_at" IS NULL;

-- Groups the identity provider pushes. Stored whether or not SCIM_GROUP_MAP maps
-- them: the provider reads back what it wrote, and an unmapped group grants
-- nothing.
CREATE TABLE IF NOT EXISTS "scim_groups" (
    id UUID PRIMARY KEY,
    "display_name" TEXT NOT NULL UNIQUE,
    "external_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "scim_group_members" (
    "group_id" UUID NOT NULL REFERENCES "scim_groups"(id) ON DELETE CASCADE,
    "user_id" UUID NOT NULL REFERENCES "users"(id) ON DELETE CASCADE,
    PRIMARY KEY ("group_id", "user_id")
);
CREATE INDEX IF NOT EXISTS "scim_group_members_user_id_idx" ON "scim_group_members"("user_id");
