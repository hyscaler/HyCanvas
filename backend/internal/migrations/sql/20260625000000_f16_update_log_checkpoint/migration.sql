-- F16 FR-11: CRDT update-log compaction. A checkpoint row holds a client-
-- produced Yjs FULL-STATE update (encodeStateAsUpdate) rather than an
-- incremental delta; on insert the server deletes every row older than it, so
-- the log stays bounded (a checkpoint + the deltas since). The history scrubber
-- folds checkpoint-then-tail, so the full-state row reconstructs the base before
-- the tail deltas apply on the same CRDT identity space.
ALTER TABLE "DesignUpdateLog" ADD COLUMN "isCheckpoint" BOOLEAN NOT NULL DEFAULT false;
