-- F28 completion C36: named share links + per-link view attribution.
-- Both additive and nullable: existing links and view sessions are untouched.
ALTER TABLE "share_links" ADD COLUMN "label" TEXT;
ALTER TABLE "design_views" ADD COLUMN "link_id" UUID;
