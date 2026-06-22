-- Add document-surface kind to designs (whiteboard/doc/sheet/video; null = plain
-- design). Surfaced on HomeItem so the dashboard can filter by type.
ALTER TABLE "Design" ADD COLUMN "docKind" TEXT;
