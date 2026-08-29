-- Phase 4 — Broadcasts
-- Persistent contacts + segments + bulk template campaigns sent through Meta.
-- Per-recipient delivery state is updated by the existing message_status
-- webhook (lookup by meta_message_id).

-- ---------- enums -----------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "ContactSource" AS ENUM ('manual', 'csv', 'inbox_auto', 'import');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "BroadcastStatus" AS ENUM (
    'draft', 'scheduled', 'sending', 'paused', 'completed', 'cancelled', 'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "BroadcastAudienceKind" AS ENUM ('csv', 'segment', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "BroadcastVariant" AS ENUM ('A', 'B');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "RecipientStatus" AS ENUM (
    'pending', 'queued', 'sent', 'delivered', 'read', 'failed', 'skipped'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "BroadcastEventKind" AS ENUM (
    'created', 'scheduled', 'started', 'paused', 'resumed',
    'cancelled', 'completed', 'failed', 'recipient_failed_burst'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- Add new WebhookEventKind values --------------------------------
ALTER TYPE "WebhookEventKind" ADD VALUE IF NOT EXISTS 'broadcast_started';
ALTER TYPE "WebhookEventKind" ADD VALUE IF NOT EXISTS 'broadcast_completed';
ALTER TYPE "WebhookEventKind" ADD VALUE IF NOT EXISTS 'broadcast_failed';
ALTER TYPE "WebhookEventKind" ADD VALUE IF NOT EXISTS 'broadcast_recipient_failed';

-- ---------- Add new AuditAction values --------------------------------------
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'contact_created';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'contact_updated';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'contact_deleted';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'segment_created';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'segment_updated';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'segment_deleted';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'broadcast_created';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'broadcast_updated';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'broadcast_sent';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'broadcast_paused';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'broadcast_resumed';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'broadcast_cancelled';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'broadcast_completed';

-- ---------- contacts --------------------------------------------------------
CREATE TABLE IF NOT EXISTS "contacts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "display_name" TEXT,
    "locale" TEXT,
    "attributes" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "source" "ContactSource" NOT NULL DEFAULT 'manual',
    "last_inbound_at" TIMESTAMP(3),
    "last_outbound_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "contacts_organization_id_fkey" FOREIGN KEY ("organization_id")
        REFERENCES "organizations"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "contacts_organization_id_phone_e164_key"
    ON "contacts" ("organization_id", "phone_e164");
CREATE INDEX IF NOT EXISTS "contacts_organization_id_created_at_idx"
    ON "contacts" ("organization_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "contacts_organization_id_deleted_at_idx"
    ON "contacts" ("organization_id", "deleted_at");

-- pg_trgm GIN for search on phone || display_name
CREATE INDEX IF NOT EXISTS "contacts_search_trgm_idx"
    ON "contacts" USING gin (
      (lower(coalesce("phone_e164", '') || ' ' || coalesce("display_name", ''))) gin_trgm_ops
    );

-- ---------- contact_tags ----------------------------------------------------
CREATE TABLE IF NOT EXISTS "contact_tags" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "tag" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_tags_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "contact_tags_organization_id_fkey" FOREIGN KEY ("organization_id")
        REFERENCES "organizations"("id") ON DELETE CASCADE,
    CONSTRAINT "contact_tags_contact_id_fkey" FOREIGN KEY ("contact_id")
        REFERENCES "contacts"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "contact_tags_contact_id_tag_key"
    ON "contact_tags" ("contact_id", "tag");
CREATE INDEX IF NOT EXISTS "contact_tags_organization_id_tag_idx"
    ON "contact_tags" ("organization_id", "tag");

-- ---------- segments --------------------------------------------------------
CREATE TABLE IF NOT EXISTS "segments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "filter" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "segments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "segments_organization_id_fkey" FOREIGN KEY ("organization_id")
        REFERENCES "organizations"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "segments_organization_id_name_key"
    ON "segments" ("organization_id", "name");
CREATE INDEX IF NOT EXISTS "segments_organization_id_idx"
    ON "segments" ("organization_id");

-- ---------- broadcasts ------------------------------------------------------
CREATE TABLE IF NOT EXISTS "broadcasts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "BroadcastStatus" NOT NULL DEFAULT 'draft',
    "channel_id" UUID NOT NULL,
    "audience_kind" "BroadcastAudienceKind" NOT NULL,
    "csv_asset_id" UUID,
    "segment_id" UUID,
    "ab_test" BOOLEAN NOT NULL DEFAULT false,
    "variant_a_template_id" UUID NOT NULL,
    "variant_b_template_id" UUID,
    "variant_a_variables" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "variant_b_variables" JSONB,
    "scheduled_for" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "total_recipients" INTEGER NOT NULL DEFAULT 0,
    "queued_count" INTEGER NOT NULL DEFAULT 0,
    "sent_count" INTEGER NOT NULL DEFAULT 0,
    "delivered_count" INTEGER NOT NULL DEFAULT 0,
    "read_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "broadcasts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "broadcasts_organization_id_fkey" FOREIGN KEY ("organization_id")
        REFERENCES "organizations"("id") ON DELETE CASCADE,
    CONSTRAINT "broadcasts_segment_id_fkey" FOREIGN KEY ("segment_id")
        REFERENCES "segments"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "broadcasts_organization_id_created_at_idx"
    ON "broadcasts" ("organization_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "broadcasts_organization_id_status_idx"
    ON "broadcasts" ("organization_id", "status");

-- ---------- broadcast_recipients --------------------------------------------
CREATE TABLE IF NOT EXISTS "broadcast_recipients" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "broadcast_id" UUID NOT NULL,
    "contact_id" UUID,
    "phone_e164" TEXT NOT NULL,
    "variant" "BroadcastVariant" NOT NULL DEFAULT 'A',
    "variables" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "status" "RecipientStatus" NOT NULL DEFAULT 'pending',
    "meta_message_id" TEXT,
    "meta_error_code" TEXT,
    "meta_error_message" TEXT,
    "queued_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "read_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broadcast_recipients_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "broadcast_recipients_organization_id_fkey" FOREIGN KEY ("organization_id")
        REFERENCES "organizations"("id") ON DELETE CASCADE,
    CONSTRAINT "broadcast_recipients_broadcast_id_fkey" FOREIGN KEY ("broadcast_id")
        REFERENCES "broadcasts"("id") ON DELETE CASCADE,
    CONSTRAINT "broadcast_recipients_contact_id_fkey" FOREIGN KEY ("contact_id")
        REFERENCES "contacts"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "broadcast_recipients_broadcast_id_status_idx"
    ON "broadcast_recipients" ("broadcast_id", "status");
CREATE INDEX IF NOT EXISTS "broadcast_recipients_organization_id_meta_message_id_idx"
    ON "broadcast_recipients" ("organization_id", "meta_message_id");
CREATE INDEX IF NOT EXISTS "broadcast_recipients_broadcast_id_created_at_idx"
    ON "broadcast_recipients" ("broadcast_id", "created_at" ASC);

-- ---------- broadcast_events ------------------------------------------------
CREATE TABLE IF NOT EXISTS "broadcast_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "broadcast_id" UUID NOT NULL,
    "kind" "BroadcastEventKind" NOT NULL,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broadcast_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "broadcast_events_organization_id_fkey" FOREIGN KEY ("organization_id")
        REFERENCES "organizations"("id") ON DELETE CASCADE,
    CONSTRAINT "broadcast_events_broadcast_id_fkey" FOREIGN KEY ("broadcast_id")
        REFERENCES "broadcasts"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "broadcast_events_broadcast_id_created_at_idx"
    ON "broadcast_events" ("broadcast_id", "created_at" ASC);

-- ---------- RLS -------------------------------------------------------------
SELECT _app_userly_tenant_rls('contacts');
SELECT _app_userly_tenant_rls('contact_tags');
SELECT _app_userly_tenant_rls('segments');
SELECT _app_userly_tenant_rls('broadcasts');
SELECT _app_userly_tenant_rls('broadcast_recipients');
SELECT _app_userly_tenant_rls('broadcast_events');
