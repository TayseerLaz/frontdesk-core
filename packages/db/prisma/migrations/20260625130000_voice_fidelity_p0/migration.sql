-- Voice fidelity P0: order/booking channel attribution, voice line + caller
-- linkage, per-line bot switch, and the needs-pricing flag for unmatched voice
-- items. All columns are added to existing RLS-protected tables (no new tables),
-- so no new RLS policies are required. Every column is nullable or has a default
-- so existing rows and the WhatsApp hot path are unaffected.

-- Cart: origin channel + voice line attribution (was only distinguishable by a
-- notes string; voice orders set channel='voice').
ALTER TABLE "carts" ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'whatsapp';
ALTER TABLE "carts" ADD COLUMN "phone_integration_id" UUID;
-- Originating voice call UUID: order-traceability + idempotency (retried
-- submit_order with the same call returns the existing order).
ALTER TABLE "carts" ADD COLUMN "call_uuid" TEXT;
CREATE INDEX "carts_org_call_uuid_idx" ON "carts"("organization_id", "call_uuid");
ALTER TABLE "carts"
  ADD CONSTRAINT "carts_phone_integration_id_fkey"
  FOREIGN KEY ("phone_integration_id") REFERENCES "phone_integrations"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "carts_org_channel_created_idx" ON "carts"("organization_id", "channel", "created_at" DESC);

-- CartItem: unmatched voice items are stored at price 0 and flagged so an
-- operator can price them before fulfilment (vs a genuinely-free item).
ALTER TABLE "cart_items" ADD COLUMN "needs_pricing" BOOLEAN NOT NULL DEFAULT false;

-- Booking: origin channel + source call linkage (voice bookings have thread_id
-- NULL; the reminder tick skips channel='voice').
ALTER TABLE "bookings" ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'whatsapp';
ALTER TABLE "bookings" ADD COLUMN "call_uuid" TEXT;

-- VoiceCall: normalized caller phone (computed once at call start) + Contact link
-- for returning-caller recognition.
ALTER TABLE "voice_calls" ADD COLUMN "caller_phone_normalized" TEXT;
ALTER TABLE "voice_calls" ADD COLUMN "contact_id" UUID;
ALTER TABLE "voice_calls"
  ADD CONSTRAINT "voice_calls_contact_id_fkey"
  FOREIGN KEY ("contact_id") REFERENCES "contacts"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "voice_calls_org_caller_norm_idx" ON "voice_calls"("organization_id", "caller_phone_normalized", "started_at" DESC);

-- PhoneIntegration: per-line AI switch (mirrors WhatsAppChannel.bot_enabled).
ALTER TABLE "phone_integrations" ADD COLUMN "bot_enabled" BOOLEAN NOT NULL DEFAULT true;
