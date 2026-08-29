-- follow_ups is an OPT-IN feature (defaultDisabled in ORG_FEATURES): every
-- existing org must start with it disabled, exactly like shopify/sales_scan.
-- Required by apps/api/test/feature-backfill-invariant.test.ts — a
-- defaultDisabled key without an array_append backfill fails CI (the
-- 2026-07-20 fleet-wide fail-open incident).
UPDATE "organizations"
SET "disabled_features" = array_append("disabled_features", 'follow_ups')
WHERE NOT ('follow_ups' = ANY("disabled_features"));
