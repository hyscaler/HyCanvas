-- F28 T16: per-workspace web-search provider config for AI generation
-- grounding. Additive only: a new table, no changes to existing ones. The API
-- key is encrypted at rest with the same machinery as ai_configs (AES-256-GCM
-- cipher/iv/tag columns); base_url carries a self-hosted metasearch endpoint.
CREATE TABLE "ai_search_configs" (
    "workspace_id" UUID PRIMARY KEY REFERENCES "workspaces"(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    "base_url" TEXT,
    "key_cipher" TEXT,
    "key_iv" TEXT,
    "key_tag" TEXT,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
