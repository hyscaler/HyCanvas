-- CreateEnum
CREATE TYPE "TemplateVisibility" AS ENUM ('PRIVATE', 'WORKSPACE', 'PUBLIC');

-- AlterTable
ALTER TABLE "Asset" ADD COLUMN     "folderId" UUID,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "thumbnail" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "mfaSecret" TEXT;

-- CreateTable
CREATE TABLE "Favorite" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "designId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Favorite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockFavorite" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "stockId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockFavorite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockRecent" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "stockId" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockRecent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Template" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "workspaceId" UUID,
    "title" TEXT NOT NULL,
    "category" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "file" JSONB NOT NULL,
    "thumbnail" TEXT,
    "visibility" "TemplateVisibility" NOT NULL DEFAULT 'PRIVATE',
    "collectionId" UUID,
    "style" JSONB,
    "attribution" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TemplateCollection" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TemplateCollection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetFolder" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetFolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MfaRecoveryCode" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MfaRecoveryCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DesignGrant" (
    "id" UUID NOT NULL,
    "designId" UUID NOT NULL,
    "userId" UUID,
    "email" TEXT,
    "mode" TEXT NOT NULL,
    "roleId" UUID,
    "invitedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesignGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShareLink" (
    "id" UUID NOT NULL,
    "designId" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "passwordHash" TEXT,
    "expiresAt" TIMESTAMP(3),
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "requireSignin" BOOLEAN NOT NULL DEFAULT false,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShareLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomRole" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "designId" UUID,
    "name" TEXT NOT NULL,
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandKit" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "palettes" JSONB NOT NULL DEFAULT '[]',
    "fonts" JSONB NOT NULL DEFAULT '[]',
    "logos" JSONB NOT NULL DEFAULT '[]',
    "voice" JSONB,
    "collections" JSONB NOT NULL DEFAULT '[]',
    "controls" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandKit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandKitVersion" (
    "id" UUID NOT NULL,
    "brandKitId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "authorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrandKitVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comment" (
    "id" UUID NOT NULL,
    "designId" UUID NOT NULL,
    "parentId" UUID,
    "authorId" UUID,
    "authorName" TEXT NOT NULL,
    "anchor" JSONB NOT NULL,
    "body" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" UUID,
    "editedAt" TIMESTAMP(3),
    "taskAssigneeId" UUID,
    "taskStatus" TEXT,
    "taskDueAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommentReaction" (
    "id" UUID NOT NULL,
    "commentId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommentReaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommentMention" (
    "id" UUID NOT NULL,
    "commentId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommentMention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" UUID NOT NULL,
    "designId" UUID NOT NULL,
    "requesterId" UUID NOT NULL,
    "policy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approverIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalDecision" (
    "id" UUID NOT NULL,
    "approvalId" UUID NOT NULL,
    "approverId" UUID NOT NULL,
    "decision" TEXT NOT NULL,
    "note" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalEvent" (
    "id" UUID NOT NULL,
    "approvalId" UUID NOT NULL,
    "designId" UUID NOT NULL,
    "actorId" UUID,
    "type" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityEvent" (
    "id" UUID NOT NULL,
    "designId" UUID NOT NULL,
    "actorId" UUID,
    "type" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "designId" UUID,
    "payload" JSONB,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPref" (
    "userId" UUID NOT NULL,
    "emailTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pushTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPref_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DesignView" (
    "id" UUID NOT NULL,
    "designId" UUID NOT NULL,
    "viewerId" UUID,
    "anonId" TEXT,
    "sessionId" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "pageId" TEXT,
    "perPage" JSONB,

    CONSTRAINT "DesignView_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Favorite_userId_idx" ON "Favorite"("userId");

-- CreateIndex
CREATE INDEX "Favorite_designId_idx" ON "Favorite"("designId");

-- CreateIndex
CREATE UNIQUE INDEX "Favorite_userId_designId_key" ON "Favorite"("userId", "designId");

-- CreateIndex
CREATE INDEX "StockFavorite_userId_idx" ON "StockFavorite"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "StockFavorite_userId_stockId_key" ON "StockFavorite"("userId", "stockId");

-- CreateIndex
CREATE INDEX "StockRecent_userId_usedAt_idx" ON "StockRecent"("userId", "usedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "StockRecent_userId_stockId_key" ON "StockRecent"("userId", "stockId");

-- CreateIndex
CREATE INDEX "Template_visibility_idx" ON "Template"("visibility");

-- CreateIndex
CREATE INDEX "Template_workspaceId_visibility_idx" ON "Template"("workspaceId", "visibility");

-- CreateIndex
CREATE INDEX "Template_collectionId_idx" ON "Template"("collectionId");

-- CreateIndex
CREATE INDEX "TemplateCollection_workspaceId_idx" ON "TemplateCollection"("workspaceId");

-- CreateIndex
CREATE INDEX "AssetFolder_workspaceId_idx" ON "AssetFolder"("workspaceId");

-- CreateIndex
CREATE INDEX "AssetFolder_parentId_idx" ON "AssetFolder"("parentId");

-- CreateIndex
CREATE INDEX "VerificationToken_userId_idx" ON "VerificationToken"("userId");

-- CreateIndex
CREATE INDEX "VerificationToken_tokenHash_idx" ON "VerificationToken"("tokenHash");

-- CreateIndex
CREATE INDEX "MfaRecoveryCode_userId_idx" ON "MfaRecoveryCode"("userId");

-- CreateIndex
CREATE INDEX "DesignGrant_designId_idx" ON "DesignGrant"("designId");

-- CreateIndex
CREATE INDEX "DesignGrant_userId_idx" ON "DesignGrant"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "DesignGrant_designId_userId_key" ON "DesignGrant"("designId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "DesignGrant_designId_email_key" ON "DesignGrant"("designId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "ShareLink_token_key" ON "ShareLink"("token");

-- CreateIndex
CREATE INDEX "ShareLink_designId_idx" ON "ShareLink"("designId");

-- CreateIndex
CREATE INDEX "CustomRole_workspaceId_idx" ON "CustomRole"("workspaceId");

-- CreateIndex
CREATE INDEX "CustomRole_designId_idx" ON "CustomRole"("designId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomRole_workspaceId_name_key" ON "CustomRole"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "BrandKit_workspaceId_idx" ON "BrandKit"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "BrandKit_workspaceId_name_key" ON "BrandKit"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "BrandKitVersion_brandKitId_version_idx" ON "BrandKitVersion"("brandKitId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "BrandKitVersion_brandKitId_version_key" ON "BrandKitVersion"("brandKitId", "version");

-- CreateIndex
CREATE INDEX "Comment_designId_idx" ON "Comment"("designId");

-- CreateIndex
CREATE INDEX "Comment_parentId_idx" ON "Comment"("parentId");

-- CreateIndex
CREATE INDEX "Comment_taskAssigneeId_idx" ON "Comment"("taskAssigneeId");

-- CreateIndex
CREATE INDEX "CommentReaction_commentId_idx" ON "CommentReaction"("commentId");

-- CreateIndex
CREATE UNIQUE INDEX "CommentReaction_commentId_userId_emoji_key" ON "CommentReaction"("commentId", "userId", "emoji");

-- CreateIndex
CREATE INDEX "CommentMention_commentId_idx" ON "CommentMention"("commentId");

-- CreateIndex
CREATE INDEX "CommentMention_userId_idx" ON "CommentMention"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CommentMention_commentId_userId_key" ON "CommentMention"("commentId", "userId");

-- CreateIndex
CREATE INDEX "Approval_designId_idx" ON "Approval"("designId");

-- CreateIndex
CREATE INDEX "Approval_designId_status_idx" ON "Approval"("designId", "status");

-- CreateIndex
CREATE INDEX "ApprovalDecision_approvalId_idx" ON "ApprovalDecision"("approvalId");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalDecision_approvalId_approverId_key" ON "ApprovalDecision"("approvalId", "approverId");

-- CreateIndex
CREATE INDEX "ApprovalEvent_approvalId_idx" ON "ApprovalEvent"("approvalId");

-- CreateIndex
CREATE INDEX "ApprovalEvent_designId_idx" ON "ApprovalEvent"("designId");

-- CreateIndex
CREATE INDEX "ActivityEvent_designId_createdAt_idx" ON "ActivityEvent"("designId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");

-- CreateIndex
CREATE INDEX "DesignView_designId_openedAt_idx" ON "DesignView"("designId", "openedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DesignView_designId_sessionId_key" ON "DesignView"("designId", "sessionId");

-- CreateIndex
CREATE INDEX "Asset_folderId_idx" ON "Asset"("folderId");

-- AddForeignKey
ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_designId_fkey" FOREIGN KEY ("designId") REFERENCES "Design"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockFavorite" ADD CONSTRAINT "StockFavorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockRecent" ADD CONSTRAINT "StockRecent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Template" ADD CONSTRAINT "Template_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Template" ADD CONSTRAINT "Template_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "TemplateCollection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemplateCollection" ADD CONSTRAINT "TemplateCollection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "AssetFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetFolder" ADD CONSTRAINT "AssetFolder_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetFolder" ADD CONSTRAINT "AssetFolder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "AssetFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationToken" ADD CONSTRAINT "VerificationToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MfaRecoveryCode" ADD CONSTRAINT "MfaRecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignGrant" ADD CONSTRAINT "DesignGrant_designId_fkey" FOREIGN KEY ("designId") REFERENCES "Design"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareLink" ADD CONSTRAINT "ShareLink_designId_fkey" FOREIGN KEY ("designId") REFERENCES "Design"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomRole" ADD CONSTRAINT "CustomRole_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomRole" ADD CONSTRAINT "CustomRole_designId_fkey" FOREIGN KEY ("designId") REFERENCES "Design"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandKit" ADD CONSTRAINT "BrandKit_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandKitVersion" ADD CONSTRAINT "BrandKitVersion_brandKitId_fkey" FOREIGN KEY ("brandKitId") REFERENCES "BrandKit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_designId_fkey" FOREIGN KEY ("designId") REFERENCES "Design"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentReaction" ADD CONSTRAINT "CommentReaction_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentMention" ADD CONSTRAINT "CommentMention_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_designId_fkey" FOREIGN KEY ("designId") REFERENCES "Design"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalDecision" ADD CONSTRAINT "ApprovalDecision_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "Approval"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalEvent" ADD CONSTRAINT "ApprovalEvent_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "Approval"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_designId_fkey" FOREIGN KEY ("designId") REFERENCES "Design"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPref" ADD CONSTRAINT "NotificationPref_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignView" ADD CONSTRAINT "DesignView_designId_fkey" FOREIGN KEY ("designId") REFERENCES "Design"("id") ON DELETE CASCADE ON UPDATE CASCADE;
