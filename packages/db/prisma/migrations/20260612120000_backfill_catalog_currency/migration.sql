-- Backfill catalog currency from the org-level source of truth.
--
-- Currency is per-org for v1 (BusinessInfo.currency). Products, services and
-- service pricing tiers each carry a denormalized `currency` column that
-- defaults to 'USD'. Rows created by seed/import, or before the org's
-- business-info currency was set, kept that 'USD' default — so a KWD/EUR/etc.
-- catalog rendered prices with a '$' (e.g. "$820,000.00"). Going forward the
-- business-info update handler propagates currency changes; this one-time
-- backfill corrects existing rows.
--
-- Only touch rows that actually differ, and only for orgs that have a
-- business_info row (otherwise there's no authoritative currency to copy).

UPDATE products p
SET currency = b.currency
FROM business_info b
WHERE b.organization_id = p.organization_id
  AND p.currency IS DISTINCT FROM b.currency;

UPDATE services s
SET currency = b.currency
FROM business_info b
WHERE b.organization_id = s.organization_id
  AND s.currency IS DISTINCT FROM b.currency;

UPDATE service_pricing_tiers t
SET currency = b.currency
FROM business_info b
WHERE b.organization_id = t.organization_id
  AND t.currency IS DISTINCT FROM b.currency;
