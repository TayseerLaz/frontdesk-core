-- Sales Scan — capture group chats too, and keep the counterparty phone encrypted.
--
-- Two owner decisions taken 2026-07-30, after 20260730120500_sales_scan shipped:
--   1. Capture GROUPS as well as DMs, with every row taggable group-vs-dm.
--   2. Store the counterparty phone ENCRYPTED alongside the existing salted hash, so a
--      tenant CSV export can show the real sender/receiver while raw numbers stay
--      unreadable in the table and in any dump.
--
-- ADDITIVE COLUMNS ONLY on an existing tenant-scoped table. No RLS statement here on
-- purpose: `sales_messages` already carries its `tenant_isolation` policy from
-- 20260730120500_sales_scan, and columns inherit the table's policy — there is nothing a
-- new column could leave unprotected. (A new TABLE would have required inline
-- _app_userly_tenant_rls, because redeploy.sh runs `prisma migrate deploy` with no
-- rls:apply step.) rls.sql likewise needs no edit for the same reason.
--
-- No enum values are added, so this needs no separate migration for ALTER TYPE.
--
-- Backfill stance: existing rows keep is_group = false, which is CORRECT rather than a
-- guess — every row captured before this migration came from a capture seam that dropped
-- groups outright. chat_name and counterparty_phone_enc stay NULL for those rows; both
-- consumers (the CSV export and the summary pipeline) already handle NULL, and the export
-- falls back to a hash prefix so old rows remain groupable by conversation.

ALTER TABLE "sales_messages"
  ADD COLUMN "is_group"               BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "chat_name"              TEXT,
  ADD COLUMN "counterparty_phone_enc" TEXT;
