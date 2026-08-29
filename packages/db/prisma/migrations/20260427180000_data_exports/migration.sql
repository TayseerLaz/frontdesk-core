-- Phase 3 §5.1.4 — GDPR data portability. One row per export request.
CREATE TABLE IF NOT EXISTS "data_exports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "storage_key" TEXT,
    "file_size_bytes" INTEGER,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_exports_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "data_exports_organization_id_fkey" FOREIGN KEY ("organization_id")
        REFERENCES "organizations"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "data_exports_organization_id_created_at_idx"
    ON "data_exports" ("organization_id", "created_at" DESC);

-- Apply the standard tenant_isolation policy + grants. The RLS macro is
-- defined in rls.sql; we re-call it here so the table is policy-protected
-- the moment the migration commits (rls.sql is replayed on every deploy
-- but the order of operations during the window matters).
SELECT _app_userly_tenant_rls('data_exports');
