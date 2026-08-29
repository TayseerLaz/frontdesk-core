-- Multi-number WhatsApp.
--
-- An org can now run several WhatsApp numbers. The bot is deployed per-number
-- (bot_enabled), threads belong to a specific number (whatsapp_channel_id) so
-- the inbox shows a separate conversation per number and replies go out from the
-- right number, and broadcasts can send from a set of numbers (round-robin).

-- ---------------------------------------------------------------------------
-- 1. New columns
-- ---------------------------------------------------------------------------

-- Per-number AI bot switch. Bot replies only when BotConfig.deployedAt is set
-- AND is_active AND bot_enabled.
ALTER TABLE "whatsapp_channels"
  ADD COLUMN IF NOT EXISTS "bot_enabled" BOOLEAN NOT NULL DEFAULT false;

-- The specific number a thread belongs to. NULL for messenger/IG + unresolved.
ALTER TABLE "whatsapp_threads"
  ADD COLUMN IF NOT EXISTS "whatsapp_channel_id" UUID;

-- The number a broadcast recipient is sent from (assigned round-robin at fanout).
ALTER TABLE "broadcast_recipients"
  ADD COLUMN IF NOT EXISTS "whatsapp_channel_id" UUID;

-- Full set of numbers a broadcast sends from. channel_id stays as the first/
-- back-compat single number.
ALTER TABLE "broadcasts"
  ADD COLUMN IF NOT EXISTS "channel_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];

-- ---------------------------------------------------------------------------
-- 2. Backfill (preserve current single-number behaviour)
-- ---------------------------------------------------------------------------

-- Existing WhatsApp threads belong to each org's primary number.
UPDATE "whatsapp_threads" t
SET "whatsapp_channel_id" = c.id
FROM "whatsapp_channels" c
WHERE c."organization_id" = t."organization_id"
  AND c."is_primary" = true
  AND t."channel" = 'whatsapp'
  AND t."whatsapp_channel_id" IS NULL;

-- Existing broadcast recipients were sent from the broadcast's single number.
UPDATE "broadcast_recipients" r
SET "whatsapp_channel_id" = b."channel_id"
FROM "broadcasts" b
WHERE b.id = r."broadcast_id"
  AND r."whatsapp_channel_id" IS NULL;

-- Existing broadcasts' channel set = the single number they already use.
UPDATE "broadcasts"
SET "channel_ids" = ARRAY["channel_id"]
WHERE "channel_ids" = ARRAY[]::UUID[];

-- Bot was effectively deployed on the primary number → keep that toggle on so
-- the per-number gate matches today's behaviour exactly.
UPDATE "whatsapp_channels"
SET "bot_enabled" = true
WHERE "is_primary" = true;

-- ---------------------------------------------------------------------------
-- 3. Foreign keys
-- ---------------------------------------------------------------------------

ALTER TABLE "whatsapp_threads"
  DROP CONSTRAINT IF EXISTS "whatsapp_threads_whatsapp_channel_id_fkey";
ALTER TABLE "whatsapp_threads"
  ADD CONSTRAINT "whatsapp_threads_whatsapp_channel_id_fkey"
  FOREIGN KEY ("whatsapp_channel_id") REFERENCES "whatsapp_channels"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "broadcast_recipients"
  DROP CONSTRAINT IF EXISTS "broadcast_recipients_whatsapp_channel_id_fkey";
ALTER TABLE "broadcast_recipients"
  ADD CONSTRAINT "broadcast_recipients_whatsapp_channel_id_fkey"
  FOREIGN KEY ("whatsapp_channel_id") REFERENCES "whatsapp_channels"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 4. Thread dedup — replace the single (org, phone) unique with two PARTIAL
--    unique indexes so the same customer gets one thread per WhatsApp number,
--    while messenger/IG (channel id NULL) keep one thread per (org, customer).
-- ---------------------------------------------------------------------------

-- The original (org, customer_phone) unique was created under a custom name
-- (whatsapp_threads_org_phone_uniq); drop both that and the Prisma-default name
-- to be safe across environments.
ALTER TABLE "whatsapp_threads"
  DROP CONSTRAINT IF EXISTS "whatsapp_threads_organization_id_customer_phone_key";
DROP INDEX IF EXISTS "whatsapp_threads_organization_id_customer_phone_key";
DROP INDEX IF EXISTS "whatsapp_threads_org_phone_uniq";

CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_threads_org_phone_nochannel_key"
  ON "whatsapp_threads" ("organization_id", "customer_phone")
  WHERE "whatsapp_channel_id" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_threads_org_phone_channel_key"
  ON "whatsapp_threads" ("organization_id", "customer_phone", "whatsapp_channel_id")
  WHERE "whatsapp_channel_id" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. Supporting indexes
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "whatsapp_threads_organization_id_whatsapp_channel_id_last_m_idx"
  ON "whatsapp_threads" ("organization_id", "whatsapp_channel_id", "last_message_at" DESC);

CREATE INDEX IF NOT EXISTS "broadcast_recipients_whatsapp_channel_id_idx"
  ON "broadcast_recipients" ("whatsapp_channel_id");
