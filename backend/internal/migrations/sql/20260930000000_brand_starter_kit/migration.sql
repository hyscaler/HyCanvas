-- The starter brand kit's visit marker.
--
-- HyCanvas seeds its own brand kit into a workspace that has no kit: when the
-- workspace is created, and once for the workspaces that predate the kit. The
-- seeding records its visit here so it never runs twice for a workspace, which
-- is what lets an owner delete or replace the starter kit for good.
--
-- Additive only: one nullable column, no change to existing rows and nothing
-- to backfill (NULL means "not visited yet", which is exactly the state every
-- existing workspace is in). Deploys onto a live instance with no window.
ALTER TABLE "workspaces"
    ADD COLUMN IF NOT EXISTS "brand_seeded_at" TIMESTAMP(3);
