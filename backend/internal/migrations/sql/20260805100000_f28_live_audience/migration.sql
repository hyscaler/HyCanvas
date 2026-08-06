-- F28 live audience (doc 28): questions with upvotes and live polls, asked by
-- share-link viewers (anonymous allowed; identified by a client-held voter
-- key) and moderated by the presenter. Additive only. Vote counts are always
-- COMPUTED from the vote tables (no denormalized counters to drift).
CREATE TABLE "audience_questions" (
    id UUID PRIMARY KEY,
    "design_id" UUID NOT NULL REFERENCES "designs"(id) ON DELETE CASCADE,
    "author_name" TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    answered BOOLEAN NOT NULL DEFAULT false,
    dismissed BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "audience_questions_design_idx" ON "audience_questions"("design_id");

CREATE TABLE "audience_question_votes" (
    "question_id" UUID NOT NULL REFERENCES "audience_questions"(id) ON DELETE CASCADE,
    "voter_key" TEXT NOT NULL,
    PRIMARY KEY ("question_id", "voter_key")
);

CREATE TABLE "audience_polls" (
    id UUID PRIMARY KEY,
    "design_id" UUID NOT NULL REFERENCES "designs"(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    -- JSON array of option label strings (2..6, enforced in the service).
    options JSONB NOT NULL,
    open BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "audience_polls_design_idx" ON "audience_polls"("design_id");

CREATE TABLE "audience_poll_votes" (
    "poll_id" UUID NOT NULL REFERENCES "audience_polls"(id) ON DELETE CASCADE,
    "voter_key" TEXT NOT NULL,
    "option_idx" INT NOT NULL,
    PRIMARY KEY ("poll_id", "voter_key")
);
