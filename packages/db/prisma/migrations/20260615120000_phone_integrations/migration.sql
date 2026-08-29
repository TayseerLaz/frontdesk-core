-- Phone integrations — per-tenant phone lines (DIDs) routed to the Aseer-time
-- voicebot. Many per org. Each line auto-issues a voice-scoped API key
-- (api_key_id). phone_number is GLOBALLY unique so an inbound DID resolves to
-- exactly one tenant in shared gateway mode (GET /api/v1/voice/resolve).
-- voice_calls gains phone_integration_id for per-line call attribution.
-- Tenant-scoped; RLS applied via rls.sql on deploy and inline below so the
-- table is never live without a policy.

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'phone_integration_created';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'phone_integration_updated';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'phone_integration_deleted';

CREATE TABLE "phone_integrations" (
  "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID         NOT NULL,
  "name"            TEXT         NOT NULL,
  "phone_number"    TEXT         NOT NULL,
  "is_active"       BOOLEAN      NOT NULL DEFAULT true,
  "api_key_id"      UUID,
  "last_call_at"    TIMESTAMP(3),
  "created_by_id"   UUID,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "phone_integrations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "phone_integrations_organization_id_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "phone_integrations_api_key_id_fkey" FOREIGN KEY ("api_key_id")
    REFERENCES "api_keys" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- A DID belongs to exactly one line across all tenants (gateway routing key).
CREATE UNIQUE INDEX "phone_integrations_phone_number_key"
  ON "phone_integrations" ("phone_number");
CREATE UNIQUE INDEX "phone_integrations_api_key_id_key"
  ON "phone_integrations" ("api_key_id");
CREATE INDEX "phone_integrations_organization_id_is_active_idx"
  ON "phone_integrations" ("organization_id", "is_active");

-- Per-line call attribution. SetNull so deleting a line keeps its call history.
ALTER TABLE "voice_calls" ADD COLUMN "phone_integration_id" UUID;
ALTER TABLE "voice_calls"
  ADD CONSTRAINT "voice_calls_phone_integration_id_fkey" FOREIGN KEY ("phone_integration_id")
  REFERENCES "phone_integrations" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "voice_calls_phone_integration_id_started_at_idx"
  ON "voice_calls" ("phone_integration_id", "started_at" DESC);

-- Inline RLS so the table is protected even before the next rls.sql apply.
-- (rls.sql re-applies the same policy idempotently on every deploy.)
ALTER TABLE "phone_integrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "phone_integrations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "phone_integrations";
CREATE POLICY tenant_isolation ON "phone_integrations"
  USING (rls_bypassed() OR organization_id = current_org_id())
  WITH CHECK (rls_bypassed() OR organization_id = current_org_id());
