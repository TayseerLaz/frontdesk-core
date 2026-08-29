-- Phase 5.3 — Compliance: opt-in/out + send-window + A/B winner.

-- contacts: opt-in/out + IANA timezone
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "opted_in_at" TIMESTAMP(3);
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "opted_out_at" TIMESTAMP(3);
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "timezone" TEXT;
CREATE INDEX IF NOT EXISTS "contacts_organization_id_opted_out_at_idx"
    ON "contacts" ("organization_id", "opted_out_at");

-- broadcasts: send-window (hours + tz) + post-hoc A/B winner.
ALTER TABLE "broadcasts" ADD COLUMN IF NOT EXISTS "send_window_start_hour" INTEGER;
ALTER TABLE "broadcasts" ADD COLUMN IF NOT EXISTS "send_window_end_hour" INTEGER;
ALTER TABLE "broadcasts" ADD COLUMN IF NOT EXISTS "send_window_timezone" TEXT;
ALTER TABLE "broadcasts" ADD COLUMN IF NOT EXISTS "ab_winner_strategy" TEXT;
ALTER TABLE "broadcasts" ADD COLUMN IF NOT EXISTS "ab_winner_variant" "BroadcastVariant";
ALTER TABLE "broadcasts" ADD COLUMN IF NOT EXISTS "ab_winner_decided_at" TIMESTAMP(3);
