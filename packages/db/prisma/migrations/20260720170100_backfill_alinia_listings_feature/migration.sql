-- The MISSING backfill for the opt-in `alinia_listings` feature.
--
-- alinia_listings is default-disabled (ORG_FEATURE_DEFAULT_DISABLED): new orgs
-- get it appended to disabled_features at creation, and — exactly like the
-- `shopify` opt-in feature (see 20260625130000_shopify_integration) — existing
-- orgs must be backfilled here. That backfill was never written, which is what
-- let the fleet-wide "Properties" mislabel happen on 2026-07-20.
--
-- Genuine Alinia tenants (source_system = 'alinia', set by the migration that
-- runs immediately before this one) are EXCLUDED so they keep the feature ON.
-- Idempotent: skips any org that already has the key, so re-running (or running
-- after the manual prod hotfix) is a no-op.

UPDATE "organizations" o
SET "disabled_features" = array_append("disabled_features", 'alinia_listings')
WHERE NOT ('alinia_listings' = ANY("disabled_features"))
  AND o."source_system" <> 'alinia';
