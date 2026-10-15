-- A personal, bring-your-own-key AI provider per user (#47).
--
-- Until now a provider could only be connected per workspace, by an owner or
-- admin, so a member of a workspace without one had no way to use their own
-- key, and someone in several workspaces set the same key up in each.
--
-- Precedence lives in the service, not here: a workspace's own provider always
-- wins, and a personal one serves a call only when the workspace has none and
-- its policy allows personal keys. The workspace policy (allow list, block
-- list, monthly cap) still governs every call made inside that workspace.
--
-- Additive only: three new tables and one defaulted column, no change to any
-- existing row and nothing to backfill. "ai_configs" and "ai_image_configs" are
-- untouched, so a workspace keeps behaving exactly as before, and a rollback to
-- the previous binary simply ignores the new tables.
--
-- Keys are encrypted at rest with the same AES-256-GCM machinery as the
-- workspace tables (cipher/iv/tag columns), never returned by the API, and
-- deleted with the row when the user removes the provider or the account.
CREATE TABLE IF NOT EXISTS "user_ai_configs" (
    "user_id" UUID PRIMARY KEY REFERENCES "users"(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    model TEXT,
    "image_model" TEXT,
    "base_url" TEXT,
    "key_cipher" TEXT,
    "key_iv" TEXT,
    "key_tag" TEXT,
    "secret_cipher" TEXT,
    "secret_iv" TEXT,
    "secret_tag" TEXT,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The personal twin of "ai_image_configs": an optional second provider for
-- image work, for the many text providers that cannot generate images.
CREATE TABLE IF NOT EXISTS "user_ai_image_configs" (
    "user_id" UUID PRIMARY KEY REFERENCES "users"(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    model TEXT,
    "base_url" TEXT,
    "key_cipher" TEXT,
    "key_iv" TEXT,
    "key_tag" TEXT,
    "secret_cipher" TEXT,
    "secret_iv" TEXT,
    "secret_tag" TEXT,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tokens a personal key spent, per user and month. The same calls are also
-- counted in the workspace's "ai_usages", because the workspace's monthly cap
-- limits how much AI work happens in it whoever pays for it.
CREATE TABLE IF NOT EXISTS "user_ai_usages" (
    "user_id" UUID NOT NULL REFERENCES "users"(id) ON DELETE CASCADE,
    period TEXT NOT NULL,
    tokens INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY ("user_id", period)
);

-- A workspace admin can turn personal keys off for their workspace. Defaulted
-- to allowed, which is also what a workspace with no policy row gets.
ALTER TABLE "ai_policies"
    ADD COLUMN IF NOT EXISTS "allow_personal_keys" BOOLEAN NOT NULL DEFAULT true;
