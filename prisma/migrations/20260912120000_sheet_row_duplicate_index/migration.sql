-- Add a tiebreaker for two sheet rows that are identical on every other
-- identifying field (same person, same project/batch/month/role, but a
-- genuinely separate line item -- e.g. a "regular" row and a "rework" row).
-- Existing rows all default to 0 (there's currently at most one row per
-- other-field combination, since duplicates of that kind were previously
-- colliding into one record anyway).
ALTER TABLE "SheetRow" ADD COLUMN "duplicateIndex" INTEGER NOT NULL DEFAULT 0;

DROP INDEX "SheetRow_natural_key_unique";

CREATE UNIQUE INDEX "SheetRow_natural_key_unique"
  ON "SheetRow"("resourceEmail", "projectName", "batch", "month", "resourceName", "role", "duplicateIndex");
