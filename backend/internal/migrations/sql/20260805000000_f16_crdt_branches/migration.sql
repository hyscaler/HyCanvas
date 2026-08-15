-- F16 FR-10: true in-CRDT named branches. A branch is a named fork point inside
-- ONE design: its state is the parent lineage's update log folded up to
-- forked_from_seq, plus the branch's own branch-scoped update rows (same CRDT
-- identity space, so the fold is just "parent prefix then branch tail").
-- Additive only: existing rows keep branch_id NULL (= the main lineage), old
-- clients never send a branch and behave exactly as before.
CREATE TABLE "design_branches" (
    id UUID PRIMARY KEY,
    "design_id" UUID NOT NULL REFERENCES "designs"(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    -- The seq in the PARENT lineage this branch forked from. Frames of the
    -- parent lineage with seq <= forked_from_seq are the branch's base.
    "forked_from_seq" BIGINT NOT NULL,
    -- NULL = forked from the main lineage; else a nested branch's parent.
    "parent_branch_id" UUID REFERENCES "design_branches"(id) ON DELETE CASCADE,
    "created_by_id" UUID REFERENCES "users"(id) ON DELETE SET NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "design_branches_design_idx" ON "design_branches"("design_id");

-- Branch-scoped update rows: NULL branch_id is the main lineage (all existing
-- rows), a branch's own edits carry its id. The composite index serves the
-- lineage fold's "this branch's rows in seq order" scan.
ALTER TABLE "design_update_logs" ADD COLUMN "branch_id" UUID REFERENCES "design_branches"(id) ON DELETE CASCADE;
CREATE INDEX "design_update_logs_branch_idx" ON "design_update_logs"("design_id", "branch_id", seq);
