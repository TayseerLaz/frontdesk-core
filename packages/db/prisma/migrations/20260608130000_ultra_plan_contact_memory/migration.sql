-- Flagship "ultra" AI tier + per-contact persona memory.

-- New enum value for the ultra plan. ALTER TYPE ... ADD VALUE is safe in
-- its own migration as long as the value is not *referenced* in the same
-- transaction — we only add it here (mirrors the existing AuditAction add).
ALTER TYPE "AiPlan" ADD VALUE IF NOT EXISTS 'ultra';

-- Per-contact persona / memory store for the ultra plan. Tenant-scoped;
-- the tenant_isolation RLS policy is applied via prisma/rls.sql on deploy
-- (idempotent, re-run every deploy). Keyed by phone so memory survives
-- re-created threads.
CREATE TABLE "contact_memory" (
  "id"               UUID         NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"  UUID         NOT NULL,
  "phone_e164"       TEXT         NOT NULL,
  "persona"          TEXT,
  "facts"            JSONB        NOT NULL DEFAULT '{}',
  "language"         TEXT,
  "turns_summarized" INTEGER      NOT NULL DEFAULT 0,
  "last_summary_at"  TIMESTAMP(3),
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "contact_memory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "contact_memory_organization_id_phone_e164_key"
  ON "contact_memory" ("organization_id", "phone_e164");

CREATE INDEX "contact_memory_organization_id_updated_at_idx"
  ON "contact_memory" ("organization_id", "updated_at" DESC);

ALTER TABLE "contact_memory"
  ADD CONSTRAINT "contact_memory_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
