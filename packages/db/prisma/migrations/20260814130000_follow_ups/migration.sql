-- Follow-ups: automated re-engagement over approved WhatsApp templates
-- (no-reply chase / post-booking check-in / idle re-engagement).
-- All columns are additive + nullable/defaulted on EXISTING RLS tables — the
-- per-row tenant_isolation policies cover new columns, so no RLS work here
-- (same precedent as 20260716120000_scripted_flow).

-- Per-tenant config blob, validated by followUpsConfigSchema (@platform/shared).
ALTER TABLE "bot_configs" ADD COLUMN "follow_ups" JSONB;

-- Per-thread cadence stamps for the worker tick's compare-and-set claims.
ALTER TABLE "whatsapp_threads" ADD COLUMN "follow_up_stage" SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE "whatsapp_threads" ADD COLUMN "follow_up_last_sent_at" TIMESTAMP(3);

-- One-shot post-appointment follow-up stamp (mirrors reminder_sent_at).
ALTER TABLE "bookings" ADD COLUMN "follow_up_sent_at" TIMESTAMP(3);

-- Tick scan helper: candidate threads are always "this org's WhatsApp threads
-- by last-inbound recency" (both the no-reply and idle scans filter on it).
CREATE INDEX "whatsapp_threads_follow_up_scan_idx"
  ON "whatsapp_threads" ("organization_id", "last_inbound_at" DESC)
  WHERE "channel" = 'whatsapp';
