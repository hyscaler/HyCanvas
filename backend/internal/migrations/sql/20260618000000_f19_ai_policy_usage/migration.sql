-- F19 AI governance: per-workspace org policy (provider allow/block + monthly
-- token cap) and accumulated usage metering, enforced before each AI call.

-- CreateTable
CREATE TABLE "AiPolicy" (
    "workspaceId" UUID NOT NULL,
    "allowedProviders" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "blockedProviders" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "monthlyTokenCap" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiPolicy_pkey" PRIMARY KEY ("workspaceId")
);

-- CreateTable
CREATE TABLE "AiUsage" (
    "workspaceId" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("workspaceId", "period")
);

-- AddForeignKey
ALTER TABLE "AiPolicy" ADD CONSTRAINT "AiPolicy_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiUsage" ADD CONSTRAINT "AiUsage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
