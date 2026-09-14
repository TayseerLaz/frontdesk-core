-- CALL-E phone follow-through (hackathon 2026-09-14).
-- Adds the tenant-scoped phone_tasks table + a nullable JSON settings column on
-- organizations (additive nullable column on an existing RLS table: no policy work).
-- NOTE: Prisma also proposed dropping the trigram/GIN indexes it cannot express —
-- those live in rls.sql on purpose and were removed from this migration by hand.

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "phone_task_settings" JSONB;

-- CreateTable
CREATE TABLE "phone_tasks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" UUID,
    "contact_id" UUID,
    "thread_id" UUID,
    "phone_e164" TEXT NOT NULL,
    "dialed_phone" TEXT,
    "locale" TEXT,
    "region" TEXT,
    "task" TEXT NOT NULL,
    "result_schema" JSONB NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "idempotency_key" TEXT NOT NULL,
    "calle_call_id" TEXT,
    "dry_run" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "structured_result" JSONB,
    "summary" TEXT,
    "task_completed" BOOLEAN,
    "confidence" DOUBLE PRECISION,
    "transcript" JSONB,
    "error" TEXT,
    "applied_at" TIMESTAMP(3),
    "applied_action" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "phone_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "phone_tasks_idempotency_key_key" ON "phone_tasks"("idempotency_key");

-- CreateIndex
CREATE INDEX "phone_tasks_organization_id_status_created_at_idx" ON "phone_tasks"("organization_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "phone_tasks_organization_id_target_type_target_id_idx" ON "phone_tasks"("organization_id", "target_type", "target_id");

-- CreateIndex
CREATE INDEX "phone_tasks_calle_call_id_idx" ON "phone_tasks"("calle_call_id");

-- AddForeignKey
ALTER TABLE "phone_tasks" ADD CONSTRAINT "phone_tasks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant table: RLS inline (house rule — the migration protects fresh DBs the
-- instant the table exists; rls.sql is the every-deploy backstop).
SELECT _apply_tenant_rls('phone_tasks');
