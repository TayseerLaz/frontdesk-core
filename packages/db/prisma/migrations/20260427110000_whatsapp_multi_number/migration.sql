-- Phase 3 §5.1.2: support multiple WhatsApp phone numbers per organization.
-- Drops the 1:1 unique on organization_id, adds is_primary + a label, and
-- a partial unique index that enforces exactly one primary per org.

ALTER TABLE "whatsapp_channels"
  DROP CONSTRAINT IF EXISTS "whatsapp_channels_organization_id_key";

ALTER TABLE "whatsapp_channels"
  ADD COLUMN IF NOT EXISTS "is_primary" BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE "whatsapp_channels"
  ADD COLUMN IF NOT EXISTS "label" TEXT;

-- Partial unique index: at most one primary row per org. Existing rows are
-- already implicitly primary (is_primary defaulted to TRUE). New secondary
-- rows must be inserted with is_primary = FALSE.
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_channels_one_primary_per_org"
  ON "whatsapp_channels" ("organization_id")
  WHERE "is_primary" = TRUE;

CREATE INDEX IF NOT EXISTS "whatsapp_channels_organization_id_idx"
  ON "whatsapp_channels" ("organization_id");
