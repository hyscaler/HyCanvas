-- A workspace may configure a SECOND provider dedicated to image work.
--
-- Most of the catalog cannot generate images at all: Anthropic, DeepSeek,
-- Moonshot, Gemini, Mistral, Groq and OpenRouter are text-only through the
-- OpenAI-compatible path, so a workspace that wants Claude or Kimi writing its
-- decks previously had to give up generated imagery entirely. This lets the
-- text provider and the image provider be chosen independently.
--
-- Additive only: a new table, no change to "ai_configs". A workspace with no
-- row here behaves exactly as it did before, because every image call falls
-- back to the main provider when this is unset. Nothing to backfill.
--
-- The key is encrypted at rest with the same AES-256-GCM machinery as
-- "ai_configs" and "ai_search_configs" (cipher/iv/tag columns); the plaintext
-- never leaves the server and is never returned by the API.
CREATE TABLE "ai_image_configs" (
    "workspace_id" UUID PRIMARY KEY REFERENCES "workspaces"(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    model TEXT,
    "base_url" TEXT,
    "key_cipher" TEXT,
    "key_iv" TEXT,
    "key_tag" TEXT,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
