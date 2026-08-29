-- Positive, authoritative org-level provenance marker so Alinia-tenant detection
-- fails CLOSED. 'native' = a normal Hader tenant; 'alinia' = provisioned by
-- Alinia (federated real-estate SSO agency) whose catalog is a read-only mirror.
--
-- Why this exists (2026-07-20 incident): the portal used to infer "Alinia tenant"
-- from the ABSENCE of the default-disabled `alinia_listings` feature flag. When
-- that flag's backfill was forgotten, every existing tenant lacked it and was
-- mislabeled as Alinia — the whole fleet's Products page reskinned to read-only
-- "Properties". Keying the reskin off a positive column makes an unknown/missing
-- value resolve to 'native' (Products), i.e. it can never fail open again.

ALTER TABLE "organizations" ADD COLUMN "source_system" TEXT NOT NULL DEFAULT 'native';

-- Backfill genuine Alinia tenants, identified two independent ways:
--   (a) a federated owner  (users.alinia_subject IS NOT NULL — set at partner
--       provisioning, stable even before the first listing sync), OR
--   (b) any mirrored product (products.source_system = 'alinia').
UPDATE "organizations" o
SET "source_system" = 'alinia'
WHERE o.id IN (
  SELECT m.organization_id
  FROM memberships m
  JOIN users u ON u.id = m.user_id
  WHERE u.alinia_subject IS NOT NULL
  UNION
  SELECT p.organization_id
  FROM products p
  WHERE p.source_system = 'alinia'
);

CREATE INDEX "organizations_source_system_idx" ON "organizations"("source_system");
