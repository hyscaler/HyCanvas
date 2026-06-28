-- Request access (doc 17 sharing): a signed-in user who lands on a design they
-- cannot open can ask its owners/admins for access. A row is the pending
-- request; approving it creates a DesignGrant, denying it records the decision.
-- One pending request per (design,user); resolved rows are retained for history.
CREATE TABLE "AccessRequest" (
    "id" UUID NOT NULL,
    "designId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'view',
    "message" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resolvedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AccessRequest_designId_idx" ON "AccessRequest"("designId");
CREATE INDEX "AccessRequest_userId_idx" ON "AccessRequest"("userId");
-- At most one pending request per user per design (re-requesting updates it).
CREATE UNIQUE INDEX "AccessRequest_designId_userId_pending_key" ON "AccessRequest"("designId", "userId") WHERE "status" = 'pending';

-- Cascade with the design/user lifecycle, matching DesignGrant/ShareLink: a
-- deleted design or requester takes its requests with it; a deleted adjudicator
-- just nulls the attribution.
ALTER TABLE "AccessRequest" ADD CONSTRAINT "AccessRequest_designId_fkey" FOREIGN KEY ("designId") REFERENCES "Design"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccessRequest" ADD CONSTRAINT "AccessRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccessRequest" ADD CONSTRAINT "AccessRequest_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
