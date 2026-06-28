-- F39 AI Creative Studio: persisted assistant sessions + turns (FR-9 history,
-- FR-27 provenance). Workspace- and design-isolated.

CREATE TABLE "AiSession" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspaceId" UUID NOT NULL,
    "designId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiSession_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "AiSession" ADD CONSTRAINT "AiSession_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiSession" ADD CONSTRAINT "AiSession_designId_fkey"
  FOREIGN KEY ("designId") REFERENCES "Design"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "AiSession_design_idx" ON "AiSession" ("designId", "createdAt");

CREATE TABLE "AiTurn" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sessionId" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL DEFAULT '',
    "plan" JSONB,
    "provenance" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiTurn_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "AiTurn" ADD CONSTRAINT "AiTurn_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "AiSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "AiTurn_session_idx" ON "AiTurn" ("sessionId", "createdAt");
