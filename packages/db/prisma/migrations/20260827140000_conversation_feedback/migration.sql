-- F2 (roadmap 2026-08-26) — post-conversation customer feedback (CSAT).
-- Additive columns + one new tenant-scoped table (RLS applied in this same
-- migration, per house invariant #1).

-- Stamp set when the rating ask was sent; the next inbound is checked for a
-- 1-5 reply BEFORE the bot runs, then the stamp clears either way.
ALTER TABLE "whatsapp_threads" ADD COLUMN "awaiting_feedback_at" TIMESTAMP(3);

-- Tenant toggle ({enabled}) edited in the bot builder.
ALTER TABLE "bot_configs" ADD COLUMN "feedback" JSONB;

CREATE TABLE "conversation_feedback" (
  "id"                  UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"     UUID NOT NULL,
  "thread_id"           UUID NOT NULL,
  "contact_id"          UUID,
  "channel"             TEXT NOT NULL DEFAULT 'whatsapp',
  -- 'ai' | 'human' | 'mixed' — computed AT ASK TIME from the thread's
  -- outbound messages (sentBy=bot vs operator). The owner's "split it to
  -- customer and ai".
  "handler_mix"         TEXT NOT NULL,
  "ai_message_count"    INTEGER NOT NULL DEFAULT 0,
  "human_message_count" INTEGER NOT NULL DEFAULT 0,
  "rating"              INTEGER,
  "comment"             TEXT,
  "asked_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "responded_at"        TIMESTAMP(3),
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "conversation_feedback_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "conversation_feedback_organization_id_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "conversation_feedback_thread_id_fkey" FOREIGN KEY ("thread_id")
    REFERENCES "whatsapp_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "conversation_feedback_contact_id_fkey" FOREIGN KEY ("contact_id")
    REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- One rating per conversation, ever.
CREATE UNIQUE INDEX "conversation_feedback_thread_id_key" ON "conversation_feedback"("thread_id");
-- Reporting scans (F9) + the per-contact 30-day re-ask throttle.
CREATE INDEX "conversation_feedback_organization_id_asked_at_idx"
  ON "conversation_feedback"("organization_id", "asked_at");
CREATE INDEX "conversation_feedback_organization_id_contact_id_asked_at_idx"
  ON "conversation_feedback"("organization_id", "contact_id", "asked_at");

SELECT _app_userly_tenant_rls('conversation_feedback');
