-- Sales Scan: group capture + encrypted counterparty phone (owner decisions 2026-07-30).
--
-- All three columns are ADDITIVE and nullable/defaulted on an existing RLS table, so no
-- policy change is needed (sales_messages already carries tenant_isolation from
-- 20260730120500_sales_scan) and existing rows stay valid.
--
-- This migration was missing when cbe6ff2 deployed: schema.prisma carried the fields and
-- the CSV export referenced them, but the columns were never created — so the export would
-- have 500'd on the first request. Forward-fix rather than editing the applied migration.
ALTER TABLE "sales_messages" ADD COLUMN IF NOT EXISTS "counterparty_phone_enc" TEXT;
ALTER TABLE "sales_messages" ADD COLUMN IF NOT EXISTS "is_group" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "sales_messages" ADD COLUMN IF NOT EXISTS "chat_name" TEXT;
