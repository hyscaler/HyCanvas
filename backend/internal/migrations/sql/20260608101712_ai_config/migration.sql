-- CreateTable
CREATE TABLE "AiConfig" (
    "workspaceId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "imageModel" TEXT,
    "baseUrl" TEXT,
    "keyCipher" TEXT,
    "keyIv" TEXT,
    "keyTag" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiConfig_pkey" PRIMARY KEY ("workspaceId")
);

-- AddForeignKey
ALTER TABLE "AiConfig" ADD CONSTRAINT "AiConfig_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
