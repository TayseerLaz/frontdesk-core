-- Capture-everything safety net for Meta webhook payloads we do not yet handle.
--
-- WHY THIS EXISTS. The webhook handler in whatsapp.routes.ts walks exactly two
-- keys off `value` — `messages` and `statuses` — and never inspects
-- `change.field`. Anything else Meta sends is signature-verified, answered 200,
-- and dropped with nothing written and nothing logged. Meta does not retry a 200.
--
-- That is survivable for repeatable streams. It is NOT survivable for the
-- Coexistence `history` field, which Meta delivers ONCE, inside a 24-hour window
-- after a business onboards, and never again ("repeat synchronization requires
-- full offboarding and recompletion of the Embedded Signup flow"). All three
-- Coexistence fields — history, smb_app_state_sync, smb_message_echoes — are
-- already SUBSCRIBED on app 1727898828528257, so this loss is live, not
-- hypothetical.
--
-- This table turns an unrecoverable drop into a replayable one. It is a landing
-- pad, not a feature: rows are written raw and processed later by the real
-- handlers as they get built.
--
-- organization_id is the org the webhook was ADDRESSED to (the :orgId in the
-- callback URL), NOT necessarily the org the payload belongs to. During Embedded
-- Signup a new tenant's events arrive at the app-level callback before any
-- per-WABA override exists, so the true owner is resolved at replay time from
-- the payload itself. The column is named for what it actually is.
--
-- RLS INLINE here (house rule: redeploy.sh runs `prisma migrate deploy` with no
-- rls:apply step, so anything living only in rls.sql never reaches production).
-- rls.sql gains the same line as the registry copy.

CREATE TABLE "meta_webhook_events" (
  "id"                   UUID NOT NULL DEFAULT gen_random_uuid(),
  -- The org whose callback URL received this. See note above.
  "organization_id"      UUID NOT NULL,
  -- Meta's `entry[].changes[].field`, e.g. 'history', 'smb_message_echoes'.
  "field"                TEXT NOT NULL,
  -- `metadata.phone_number_id` when present, so a replay can resolve the real
  -- owner without re-parsing the blob. Null for fields that carry no metadata.
  "phone_number_id"      TEXT,
  -- Meta's `entry[].id` — the WABA id. For `history` this is the only owner hint
  -- available, because the phone number may not exist in our DB yet.
  "waba_id"              TEXT,
  -- The whole `changes[]` element, verbatim. Never rewritten.
  "payload"              JSONB NOT NULL,
  "received_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Stamped when a real handler has consumed this row. Null = still waiting.
  "processed_at"         TIMESTAMP(3),

  CONSTRAINT "meta_webhook_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "meta_webhook_events_organization_id_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- The replay query: "give me every unprocessed row of this field, oldest first".
CREATE INDEX "meta_webhook_events_field_unprocessed_idx"
  ON "meta_webhook_events"("field", "received_at")
  WHERE "processed_at" IS NULL;

-- Operator view: what landed for this org recently.
CREATE INDEX "meta_webhook_events_organization_id_received_at_idx"
  ON "meta_webhook_events"("organization_id", "received_at" DESC);

SELECT _app_userly_tenant_rls('meta_webhook_events');
