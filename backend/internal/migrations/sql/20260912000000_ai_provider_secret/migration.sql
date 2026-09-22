-- A second encrypted credential per AI provider record.
--
-- Every provider so far authenticates with one secret: a bearer token, an
-- api-key, an x-api-key. Amazon Bedrock signs each request with AWS Signature
-- Version 4, which needs an access key ID AND a secret access key. The access
-- key ID goes in the existing key columns; this is where its partner lives.
--
-- Additive only: three nullable columns on each of the two provider tables, no
-- change to existing rows and nothing to backfill. A workspace on any other
-- provider leaves them NULL forever and behaves exactly as before, so this
-- deploys onto a live instance with no migration window.
--
-- Encrypted with the same AES-256-GCM machinery as the key it accompanies
-- (cipher/iv/tag), and never returned by the API.
ALTER TABLE "ai_configs"
    ADD COLUMN IF NOT EXISTS "secret_cipher" TEXT,
    ADD COLUMN IF NOT EXISTS "secret_iv" TEXT,
    ADD COLUMN IF NOT EXISTS "secret_tag" TEXT;

ALTER TABLE "ai_image_configs"
    ADD COLUMN IF NOT EXISTS "secret_cipher" TEXT,
    ADD COLUMN IF NOT EXISTS "secret_iv" TEXT,
    ADD COLUMN IF NOT EXISTS "secret_tag" TEXT;
