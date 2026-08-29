-- `sales_scan` is an OPT-IN feature (ORG_FEATURE_DEFAULT_DISABLED). New orgs get it
-- disabled at creation; EXISTING orgs only get it from this backfill.
--
-- Skipping this is what caused the 2026-07-20 fleet-wide "Properties" incident, and
-- apps/api/test/feature-backfill-invariant.test.ts fails the build without it.
UPDATE "organizations"
SET "disabled_features" = array_append("disabled_features", 'sales_scan')
WHERE NOT ('sales_scan' = ANY("disabled_features"));
