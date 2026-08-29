-- AuditAction + WebhookEventKind enum values for the new Booking module.
-- ALTER TYPE ... ADD VALUE is idempotent via IF NOT EXISTS and can't run
-- inside a transaction block. Prisma migrate deploy executes each statement
-- separately so this is safe.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'booking_created';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'booking_updated';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'booking_deleted';
ALTER TYPE "WebhookEventKind" ADD VALUE IF NOT EXISTS 'booking_created';
ALTER TYPE "WebhookEventKind" ADD VALUE IF NOT EXISTS 'booking_status_changed';

-- Bookings — captured when a customer asks the AI bot to schedule
-- something (meeting / consultation / appointment). The operator
-- configures the fields to collect on /business-info, the bot
-- prompts the customer in WhatsApp, and once every field is filled
-- we persist a Booking row.

-- Operator-defined booking form lives on business_info as JSON so
-- it's edited alongside hours / about / addresses. Schema:
--   {
--     "title": "Book a consultation",
--     "intentKeywords": ["book", "appointment", "consultation"],
--     "fields": [
--       { "key": "name",  "label": "Full name", "type": "text",  "required": true },
--       { "key": "email", "label": "Email",     "type": "email", "required": true },
--       { "key": "date",  "label": "Preferred date", "type": "date", "required": true },
--       { "key": "notes", "label": "Anything else?", "type": "text", "required": false }
--     ]
--   }
ALTER TABLE business_info
  ADD COLUMN IF NOT EXISTS booking_form JSONB;

-- bookings — one row per completed intake.
CREATE TABLE IF NOT EXISTS bookings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Thread the booking came from (nullable: bookings can also be
  -- manually created from the dashboard later).
  thread_id       UUID REFERENCES whatsapp_threads(id) ON DELETE SET NULL,
  -- The customer's WhatsApp number (E.164 with +). Searchable.
  customer_phone  TEXT NOT NULL,
  -- Snapshot of the customer's WhatsApp profile name + operator
  -- rename at the moment of booking, so renames later don't lose
  -- the historical label.
  customer_name   TEXT,
  -- The exact form fields the operator had configured when the
  -- booking landed, frozen so the row makes sense even if the form
  -- changes later: [{ key, label, type, required, value }].
  fields          JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Workflow: new → confirmed → completed → cancelled.
  status          TEXT NOT NULL DEFAULT 'new',
  notes           TEXT,
  created_at      TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP(3) NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS bookings_org_status_created_idx
  ON bookings (organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS bookings_org_phone_idx
  ON bookings (organization_id, customer_phone);

-- RLS — same shape as every tenant-scoped table.
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON bookings;
CREATE POLICY tenant_isolation ON bookings
  USING (rls_bypassed() OR organization_id = current_org_id())
  WITH CHECK (rls_bypassed() OR organization_id = current_org_id());
