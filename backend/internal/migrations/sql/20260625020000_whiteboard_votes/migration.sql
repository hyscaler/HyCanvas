-- Server-authoritative whiteboard voting (F30 FR-19/FR-20). A vote session is a
-- facilitator-opened round with a per-user dot budget; each cast is one row,
-- uniquely keyed on (session, node, user) so a re-cast toggles it off and the
-- per-user budget is enforced by counting rows. Anonymity/reveal are session
-- flags honored when reading the tally. Per-workspace isolation is enforced at
-- the query layer via the design id (the HTTP layer resolves the caller's
-- access to the design before any read/write), consistent with the comments and
-- sharing modules.

CREATE TABLE "WhiteboardVoteSession" (
    "id" UUID NOT NULL,
    "designId" UUID NOT NULL,
    "budgetPerUser" INTEGER NOT NULL DEFAULT 3,
    "anonymous" BOOLEAN NOT NULL DEFAULT false,
    "revealed" BOOLEAN NOT NULL DEFAULT false,
    "open" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    CONSTRAINT "WhiteboardVoteSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WhiteboardVoteSession_designId_idx" ON "WhiteboardVoteSession"("designId");

ALTER TABLE "WhiteboardVoteSession" ADD CONSTRAINT "WhiteboardVoteSession_designId_fkey"
    FOREIGN KEY ("designId") REFERENCES "Design"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "WhiteboardVote" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "designId" UUID NOT NULL,
    "nodeId" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "castAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WhiteboardVote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WhiteboardVote_session_node_user_key" ON "WhiteboardVote"("sessionId", "nodeId", "userId");
CREATE INDEX "WhiteboardVote_sessionId_idx" ON "WhiteboardVote"("sessionId");

ALTER TABLE "WhiteboardVote" ADD CONSTRAINT "WhiteboardVote_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "WhiteboardVoteSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WhiteboardVote" ADD CONSTRAINT "WhiteboardVote_designId_fkey"
    FOREIGN KEY ("designId") REFERENCES "Design"("id") ON DELETE CASCADE ON UPDATE CASCADE;
