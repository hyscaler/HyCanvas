-- F28 live audience slide-follow: the presenter's current slide, one row per
-- design, so share-link viewers can follow the live presentation position.
-- Additive; a row disappears with its design.
CREATE TABLE "audience_live" (
    "design_id" UUID PRIMARY KEY REFERENCES "designs"(id) ON DELETE CASCADE,
    "slide_index" INT NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
