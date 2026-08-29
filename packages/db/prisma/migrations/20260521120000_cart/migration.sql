-- Cart / Shop feature — sibling of Booking.
--
-- 1. Adds `business_info.shop_form` JSONB column so each org can define its
--    own shop form (intent keywords, customer-facing fields, fees, copy).
-- 2. Creates `carts` table — one row per customer order (status:
--    new | confirmed | completed | cancelled). RLS-isolated.
-- 3. Creates `cart_items` table — N rows per cart. Snapshots product
--    name/sku/variant so deleted catalog rows don't corrupt history.
-- 4. Adds three webhook event kinds for outbound integrations.

ALTER TABLE business_info
  ADD COLUMN IF NOT EXISTS shop_form JSONB;

CREATE TABLE IF NOT EXISTS carts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  thread_id       UUID REFERENCES whatsapp_threads(id) ON DELETE SET NULL,
  customer_phone  TEXT NOT NULL,
  customer_name   TEXT,
  fields          JSONB NOT NULL DEFAULT '[]',
  subtotal_minor  INT  NOT NULL DEFAULT 0,
  delivery_minor  INT  NOT NULL DEFAULT 0,
  total_minor     INT  NOT NULL DEFAULT 0,
  currency        CHAR(3) NOT NULL DEFAULT 'USD',
  status          TEXT NOT NULL DEFAULT 'new',
  notes           TEXT,
  items_count     INT  NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS carts_org_status_created_idx
  ON carts (organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS carts_org_phone_idx
  ON carts (organization_id, customer_phone);

ALTER TABLE carts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON carts;
CREATE POLICY tenant_isolation ON carts
  USING (rls_bypassed() OR organization_id = current_org_id())
  WITH CHECK (rls_bypassed() OR organization_id = current_org_id());

CREATE TABLE IF NOT EXISTS cart_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  cart_id         UUID NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  -- Catalog-row references kept for clickthrough but never trusted at
  -- read time (the snapshot fields below are what we display).
  product_id      UUID,
  service_id      UUID,
  variant_id      UUID,
  sku             TEXT,
  name            TEXT NOT NULL,
  variant_label   TEXT,
  quantity        INT  NOT NULL DEFAULT 1,
  unit_price_minor INT NOT NULL,
  line_total_minor INT NOT NULL,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cart_items_cart_idx ON cart_items (cart_id);

ALTER TABLE cart_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON cart_items;
CREATE POLICY tenant_isolation ON cart_items
  USING (rls_bypassed() OR organization_id = current_org_id())
  WITH CHECK (rls_bypassed() OR organization_id = current_org_id());

-- New webhook event kinds for outbound integrations (kitchen displays, POS
-- bridges, Zapier-style automations). ADD VALUE is idempotent.
ALTER TYPE "WebhookEventKind" ADD VALUE IF NOT EXISTS 'cart_created';
ALTER TYPE "WebhookEventKind" ADD VALUE IF NOT EXISTS 'cart_status_changed';
ALTER TYPE "WebhookEventKind" ADD VALUE IF NOT EXISTS 'cart_item_added';

-- Audit-action enum values for the new cart routes.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'cart_created';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'cart_updated';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'cart_deleted';

-- Notification kind for in-app cart pings.
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'cart_received';
