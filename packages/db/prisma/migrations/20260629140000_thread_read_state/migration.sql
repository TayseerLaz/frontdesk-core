-- Inbox read/answered state: when the customer last messaged + when an operator
-- last opened the thread. Powers the All / Chats / Unread / Read / Answered
-- filters and the per-row unread/answered marks.

ALTER TABLE "whatsapp_threads"
  ADD COLUMN IF NOT EXISTS "last_inbound_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "last_read_at" TIMESTAMP(3);

-- Backfill last_inbound_at from the newest inbound message per thread.
UPDATE "whatsapp_threads" t
  SET "last_inbound_at" = sub.maxat
  FROM (
    SELECT thread_id, MAX(received_at) AS maxat
    FROM "whatsapp_messages"
    WHERE direction = 'inbound'
    GROUP BY thread_id
  ) sub
  WHERE sub.thread_id = t.id;

-- Existing threads start "read" (clean slate) so nothing shows as unread on the
-- first load after deploy. New inbound messages will set last_inbound_at >
-- last_read_at, flipping them to unread.
UPDATE "whatsapp_threads" SET "last_read_at" = "last_message_at" WHERE "last_read_at" IS NULL;

-- Helps the unread/answered filters + ordering stay index-friendly.
CREATE INDEX IF NOT EXISTS "whatsapp_threads_org_inbound_read_idx"
  ON "whatsapp_threads" ("organization_id", "last_inbound_at", "last_read_at");
