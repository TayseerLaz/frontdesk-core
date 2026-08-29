-- Sales Scan — "Teach the bot with your own data".
--
-- Three tenant-scoped tables + two NEW enum types. New CREATE TYPEs are safe in a
-- feature migration (only ALTER TYPE ... ADD VALUE needs its own migration).
--
-- RLS is applied INLINE at the bottom, which is mandatory, not belt-and-braces:
-- infra/scripts/redeploy.sh runs `prisma migrate deploy` with NO `rls:apply` step,
-- and deploy.yml applies rls.sql with `|| true`. A tenant table whose policy lives
-- only in rls.sql can therefore ship completely unprotected. rls.sql is updated too
-- so a policy-repair pass doesn't miss these tables.

CREATE TYPE "SalesScanStatus" AS ENUM ('pending', 'linking', 'active', 'completed', 'revoked', 'expired', 'failed');
CREATE TYPE "SalesMessageDirection" AS ENUM ('in', 'out');

CREATE TABLE "sales_scan_grants" (
  "id"                    UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"       UUID NOT NULL,
  "status"                "SalesScanStatus" NOT NULL DEFAULT 'pending',
  "phone_e164"            TEXT,
  "window_days"           INTEGER NOT NULL DEFAULT 7,
  "consent_version"       TEXT NOT NULL,
  "consent_text"          TEXT NOT NULL,
  "consent_text_sha256"   TEXT NOT NULL,
  "granted_by_user_id"    UUID,
  "granted_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "grant_expires_at"      TIMESTAMP(3) NOT NULL,
  "linked_at"             TIMESTAMP(3),
  "capture_ends_at"       TIMESTAMP(3),
  "ended_at"              TIMESTAMP(3),
  "end_reason"            TEXT,
  "auth_purged_at"        TIMESTAMP(3),
  "ingest_session_id"     TEXT,
  "message_count"         INTEGER NOT NULL DEFAULT 0,
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sales_scan_grants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sales_messages" (
  "id"                UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"   UUID NOT NULL,
  "grant_id"          UUID NOT NULL,
  "wa_msg_id"         TEXT NOT NULL,
  "counterparty_hash" TEXT NOT NULL,
  "direction"         "SalesMessageDirection" NOT NULL,
  "kind"              TEXT NOT NULL DEFAULT 'text',
  "body"              TEXT,
  "sent_at"           TIMESTAMP(3) NOT NULL,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sales_messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sales_scan_summaries" (
  "id"                UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"   UUID NOT NULL,
  "grant_id"          UUID NOT NULL,
  "payload"           JSONB NOT NULL,
  "status"            TEXT NOT NULL DEFAULT 'ready',
  "model"             TEXT,
  "prompt_tokens"     INTEGER NOT NULL DEFAULT 0,
  "completion_tokens" INTEGER NOT NULL DEFAULT 0,
  "cache_read_tokens" INTEGER NOT NULL DEFAULT 0,
  "cache_write_tokens" INTEGER NOT NULL DEFAULT 0,
  "cost_micros"       BIGINT NOT NULL DEFAULT 0,
  "messages_analyzed" INTEGER NOT NULL DEFAULT 0,
  "generated_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sales_scan_summaries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sales_scan_grants_organization_id_status_idx" ON "sales_scan_grants"("organization_id", "status");
CREATE INDEX "sales_scan_grants_organization_id_created_at_idx" ON "sales_scan_grants"("organization_id", "created_at" DESC);
CREATE INDEX "sales_scan_grants_status_grant_expires_at_idx" ON "sales_scan_grants"("status", "grant_expires_at");
CREATE INDEX "sales_scan_grants_ended_at_auth_purged_at_idx" ON "sales_scan_grants"("ended_at", "auth_purged_at");

CREATE UNIQUE INDEX "sales_messages_grant_id_wa_msg_id_key" ON "sales_messages"("grant_id", "wa_msg_id");
CREATE INDEX "sales_messages_organization_id_grant_id_sent_at_idx" ON "sales_messages"("organization_id", "grant_id", "sent_at");
CREATE INDEX "sales_messages_organization_id_counterparty_hash_idx" ON "sales_messages"("organization_id", "counterparty_hash");
CREATE INDEX "sales_messages_organization_id_created_at_idx" ON "sales_messages"("organization_id", "created_at");

CREATE UNIQUE INDEX "sales_scan_summaries_grant_id_key" ON "sales_scan_summaries"("grant_id");
CREATE INDEX "sales_scan_summaries_organization_id_generated_at_idx" ON "sales_scan_summaries"("organization_id", "generated_at" DESC);

ALTER TABLE "sales_scan_grants" ADD CONSTRAINT "sales_scan_grants_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales_messages" ADD CONSTRAINT "sales_messages_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales_messages" ADD CONSTRAINT "sales_messages_grant_id_fkey"
  FOREIGN KEY ("grant_id") REFERENCES "sales_scan_grants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales_scan_summaries" ADD CONSTRAINT "sales_scan_summaries_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales_scan_summaries" ADD CONSTRAINT "sales_scan_summaries_grant_id_fkey"
  FOREIGN KEY ("grant_id") REFERENCES "sales_scan_grants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation (RLS) — same helper every tenant-scoped table uses.
SELECT _app_userly_tenant_rls('sales_scan_grants');
SELECT _app_userly_tenant_rls('sales_messages');
SELECT _app_userly_tenant_rls('sales_scan_summaries');
