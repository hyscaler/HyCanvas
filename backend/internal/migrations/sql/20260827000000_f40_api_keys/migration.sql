-- F40 E01: workspace-scoped API keys for the public generation API. Additive
-- only: a new table, no changes to existing ones. Keys are stored hash-only
-- (sha256 hex of the full key); the raw key is shown exactly once at mint.
CREATE TABLE "api_keys" (
    id UUID NOT NULL,
    "workspace_id" UUID NOT NULL REFERENCES "workspaces"(id) ON DELETE CASCADE,
    "user_id" UUID NOT NULL REFERENCES "users"(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    prefix TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "api_keys_pkey" PRIMARY KEY (id)
);

CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");
CREATE INDEX "api_keys_workspace_id_idx" ON "api_keys"("workspace_id");
