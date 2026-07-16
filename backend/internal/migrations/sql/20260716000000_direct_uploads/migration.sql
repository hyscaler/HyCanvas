-- Direct (presigned) uploads: a pending handshake row per upload so the file
-- bytes can go straight to object storage instead of through a base64 JSON
-- body. Init creates a row, the client uploads to storage (presigned POST on
-- S3/MinIO, or a token-authenticated streaming PUT on the local driver), and
-- complete validates the stored object and promotes it to an assets row. Rows
-- that never complete expire and a janitor removes them with their objects.
-- Purely additive: no existing table or row is touched.
CREATE TABLE "direct_uploads" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "filename" TEXT,
    "folder_id" TEXT,
    "declared_bytes" BIGINT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL
);

CREATE INDEX "direct_uploads_expires_at_idx" ON "direct_uploads"("expires_at");
CREATE INDEX "direct_uploads_workspace_id_idx" ON "direct_uploads"("workspace_id");
