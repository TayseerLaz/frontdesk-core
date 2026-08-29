-- Owner directive 2026-08-29: the 2026-08-26 roadmap features must NOT be
-- live for tenants yet. Each becomes an opt-in feature key (defaultDisabled
-- in ORG_FEATURES) and every existing org is backfilled to disabled — an
-- ALIGNED admin re-enables per tenant, per feature, when ready. Required by
-- apps/api/test/feature-backfill-invariant.test.ts (the 2026-07-20 fail-open
-- incident): every defaultDisabled key ships an array_append backfill.
UPDATE "organizations"
SET "disabled_features" = array_append("disabled_features", 'inbox_teamwork')
WHERE NOT ('inbox_teamwork' = ANY("disabled_features"));

UPDATE "organizations"
SET "disabled_features" = array_append("disabled_features", 'contact_sap')
WHERE NOT ('contact_sap' = ANY("disabled_features"));

UPDATE "organizations"
SET "disabled_features" = array_append("disabled_features", 'website_connector')
WHERE NOT ('website_connector' = ANY("disabled_features"));

UPDATE "organizations"
SET "disabled_features" = array_append("disabled_features", 'quick_buttons')
WHERE NOT ('quick_buttons' = ANY("disabled_features"));

UPDATE "organizations"
SET "disabled_features" = array_append("disabled_features", 'analytics_v2')
WHERE NOT ('analytics_v2' = ANY("disabled_features"));

UPDATE "organizations"
SET "disabled_features" = array_append("disabled_features", 'page_permissions')
WHERE NOT ('page_permissions' = ANY("disabled_features"));
