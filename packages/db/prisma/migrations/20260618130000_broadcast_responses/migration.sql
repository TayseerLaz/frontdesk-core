-- Per-campaign reply tracking.
ALTER TABLE "broadcasts" ADD COLUMN IF NOT EXISTS "responded_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "broadcast_recipients" ADD COLUMN IF NOT EXISTS "responded_at" TIMESTAMP(3);

-- Reply attribution looks up recent sends to a phone for an org.
CREATE INDEX IF NOT EXISTS "broadcast_recipients_organization_id_phone_e164_sent_at_idx"
  ON "broadcast_recipients" ("organization_id", "phone_e164", "sent_at");
