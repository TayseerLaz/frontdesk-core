-- stock_watch is an OPT-IN feature (defaultDisabled in ORG_FEATURES): every
-- existing org must start with it disabled, exactly like feedback/follow_ups.
-- Required by apps/api/test/feature-backfill-invariant.test.ts.
UPDATE "organizations"
SET "disabled_features" = array_append("disabled_features", 'stock_watch')
WHERE NOT ('stock_watch' = ANY("disabled_features"));
