-- F40 E08: audit trail for API-key activity (HTTP surface + MCP tools).
-- Additive only: a new table, no changes to existing ones. Rows are pruned
-- past the retention window by the writer (no background job needed).
CREATE TABLE "api_audit_log" (
    id UUID NOT NULL,
    "key_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    surface TEXT NOT NULL,
    -- TEXT, not UUID: this is a log line, not a relation, and a malformed id
    -- must never make the best-effort audit INSERT itself fail.
    "design_id" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_audit_log_pkey" PRIMARY KEY (id)
);

CREATE INDEX "api_audit_log_workspace_id_at_idx" ON "api_audit_log"("workspace_id", "at");
CREATE INDEX "api_audit_log_at_idx" ON "api_audit_log"("at");
