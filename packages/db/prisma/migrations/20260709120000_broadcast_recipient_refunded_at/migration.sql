-- Refund tracking for metered WhatsApp sends. The wallet charges at send (after
-- Meta accepts the message), but Meta only bills on DELIVERY — a message that
-- fails to deliver costs $0 on Meta's side, so the tenant must be credited back.
-- refunded_at makes the refund idempotent (claimed atomically alongside a
-- billed_at IS NOT NULL / refunded_at IS NULL guard) against duplicate 'failed'
-- webhooks. Additive, nullable — existing rows unaffected.
ALTER TABLE "broadcast_recipients" ADD COLUMN "refunded_at" TIMESTAMPTZ;
