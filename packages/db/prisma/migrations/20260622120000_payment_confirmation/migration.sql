-- F-04 — payment confirmation.
--
-- Records that an order was actually paid (was: links minted, nothing
-- confirmed). carts gains the gateway + external reference + status + paid_at,
-- and two enums gain `order_paid` so we can emit the webhook + notification.

-- New enum values. `ADD VALUE` is not used within this migration, so running it
-- in the migration transaction is safe on Postgres 12+.
ALTER TYPE "WebhookEventKind" ADD VALUE IF NOT EXISTS 'order_paid';
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'order_paid';

-- Payment columns on carts (orders). All nullable — existing rows mean
-- "no online payment expected / legacy".
ALTER TABLE "carts"
  ADD COLUMN IF NOT EXISTS "payment_provider" TEXT,
  ADD COLUMN IF NOT EXISTS "payment_ref" TEXT,
  ADD COLUMN IF NOT EXISTS "payment_status" TEXT,
  ADD COLUMN IF NOT EXISTS "paid_at" TIMESTAMP(3);

-- Fast webhook correlation: look up an order by gateway + external ref.
CREATE INDEX IF NOT EXISTS "carts_organization_id_payment_provider_payment_ref_idx"
  ON "carts" ("organization_id", "payment_provider", "payment_ref");
