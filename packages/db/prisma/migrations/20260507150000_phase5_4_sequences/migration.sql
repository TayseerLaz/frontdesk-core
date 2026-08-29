-- Phase 5.4 — Drip / sequence campaigns.

DO $$ BEGIN
  CREATE TYPE "SequenceEnrollmentStatus" AS ENUM ('active', 'paused', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "sequences" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "channel_id" UUID NOT NULL,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sequences_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sequences_organization_id_fkey" FOREIGN KEY ("organization_id")
        REFERENCES "organizations"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "sequences_organization_id_name_key"
    ON "sequences" ("organization_id", "name");
CREATE INDEX IF NOT EXISTS "sequences_organization_id_idx"
    ON "sequences" ("organization_id");

CREATE TABLE IF NOT EXISTS "sequence_steps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "sequence_id" UUID NOT NULL,
    "step_order" INTEGER NOT NULL,
    "template_id" UUID NOT NULL,
    "delay_hours" INTEGER NOT NULL DEFAULT 0,
    "variables" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sequence_steps_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sequence_steps_organization_id_fkey" FOREIGN KEY ("organization_id")
        REFERENCES "organizations"("id") ON DELETE CASCADE,
    CONSTRAINT "sequence_steps_sequence_id_fkey" FOREIGN KEY ("sequence_id")
        REFERENCES "sequences"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "sequence_steps_sequence_id_step_order_key"
    ON "sequence_steps" ("sequence_id", "step_order");
CREATE INDEX IF NOT EXISTS "sequence_steps_sequence_id_idx"
    ON "sequence_steps" ("sequence_id");

CREATE TABLE IF NOT EXISTS "sequence_enrollments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "sequence_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "status" "SequenceEnrollmentStatus" NOT NULL DEFAULT 'active',
    "next_step_index" INTEGER NOT NULL DEFAULT 0,
    "next_step_due_at" TIMESTAMP(3),
    "enrolled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),

    CONSTRAINT "sequence_enrollments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sequence_enrollments_organization_id_fkey" FOREIGN KEY ("organization_id")
        REFERENCES "organizations"("id") ON DELETE CASCADE,
    CONSTRAINT "sequence_enrollments_sequence_id_fkey" FOREIGN KEY ("sequence_id")
        REFERENCES "sequences"("id") ON DELETE CASCADE,
    CONSTRAINT "sequence_enrollments_contact_id_fkey" FOREIGN KEY ("contact_id")
        REFERENCES "contacts"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "sequence_enrollments_sequence_id_contact_id_key"
    ON "sequence_enrollments" ("sequence_id", "contact_id");
CREATE INDEX IF NOT EXISTS "sequence_enrollments_organization_id_status_next_step_due_at_idx"
    ON "sequence_enrollments" ("organization_id", "status", "next_step_due_at");

SELECT _app_userly_tenant_rls('sequences');
SELECT _app_userly_tenant_rls('sequence_steps');
SELECT _app_userly_tenant_rls('sequence_enrollments');
