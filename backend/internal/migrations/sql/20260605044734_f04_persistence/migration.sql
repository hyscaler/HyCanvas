/*
  Warnings:

  - Added the required column `checksum` to the `DesignSnapshot` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "SnapshotKind" AS ENUM ('AUTO', 'CHECKPOINT', 'NAMED', 'RESTORE', 'BRANCH');

-- DropIndex
DROP INDEX "DesignSnapshot_designId_idx";

-- AlterTable
ALTER TABLE "Design" ADD COLUMN     "purgeAfter" TIMESTAMP(3),
ADD COLUMN     "sourceDesignId" UUID,
ADD COLUMN     "sourceVersionId" UUID;

-- AlterTable
ALTER TABLE "DesignSnapshot" ADD COLUMN     "checksum" TEXT NOT NULL,
ADD COLUMN     "kind" "SnapshotKind" NOT NULL DEFAULT 'AUTO',
ADD COLUMN     "schemaVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "sizeBytes" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "DesignVersion" (
    "id" UUID NOT NULL,
    "designId" UUID NOT NULL,
    "snapshotId" UUID NOT NULL,
    "label" TEXT,
    "authorId" UUID,
    "diffSummary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesignVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DesignUpdateLog" (
    "id" BIGSERIAL NOT NULL,
    "designId" UUID NOT NULL,
    "seq" BIGINT NOT NULL,
    "update" BYTEA,
    "blobUrl" TEXT,
    "authorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesignUpdateLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DesignVersion_designId_createdAt_idx" ON "DesignVersion"("designId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "DesignUpdateLog_designId_seq_idx" ON "DesignUpdateLog"("designId", "seq");

-- CreateIndex
CREATE INDEX "Design_workspaceId_deletedAt_idx" ON "Design"("workspaceId", "deletedAt");

-- CreateIndex
CREATE INDEX "Design_sourceDesignId_idx" ON "Design"("sourceDesignId");

-- CreateIndex
CREATE INDEX "DesignSnapshot_designId_createdAt_idx" ON "DesignSnapshot"("designId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "DesignVersion" ADD CONSTRAINT "DesignVersion_designId_fkey" FOREIGN KEY ("designId") REFERENCES "Design"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignVersion" ADD CONSTRAINT "DesignVersion_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "DesignSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignVersion" ADD CONSTRAINT "DesignVersion_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignUpdateLog" ADD CONSTRAINT "DesignUpdateLog_designId_fkey" FOREIGN KEY ("designId") REFERENCES "Design"("id") ON DELETE CASCADE ON UPDATE CASCADE;
