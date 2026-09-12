-- Widen SheetRow's natural key to include resourceName + role.
--
-- The old key (resourceEmail, projectName, batch, month) collapsed every
-- distinct person's row onto one record whenever a single email in the
-- sheet represented multiple people in the same project/batch/month (a
-- shared/team inbox) -- each sync overwrote the previous person's row.
--
-- No Invoice rows reference SheetRow yet in any environment this has been
-- checked against, so this is a straight index swap, not a backfill.
-- (custom short name -- the straightforward auto-generated name for this
-- column set is 69 bytes, over Postgres' 63-byte identifier limit)
DROP INDEX "SheetRow_resourceEmail_projectName_batch_month_key";

CREATE UNIQUE INDEX "SheetRow_natural_key_unique"
  ON "SheetRow"("resourceEmail", "projectName", "batch", "month", "resourceName", "role");
