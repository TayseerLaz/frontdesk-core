-- Phase 1.5: WhatsApp Cloud API integration. One channel per organisation.
-- Tenant-scoped via organization_id + RLS (see rls.sql).

CREATE TABLE "whatsapp_channels" (
    "id"                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "organization_id"         UUID NOT NULL UNIQUE,
    "waba_id"                 TEXT,
    "phone_number_id"         TEXT,
    "display_phone_number"    TEXT,
    "app_id"                  TEXT,
    "access_token"            TEXT,
    "app_secret"              TEXT,
    "webhook_verify_token"    TEXT NOT NULL,
    "greeting_message"        TEXT,
    "business_name"           TEXT,
    "business_about"          TEXT,
    "business_address"        TEXT,
    "business_email"          TEXT,
    "is_active"               BOOLEAN NOT NULL DEFAULT FALSE,
    "last_verified_at"        TIMESTAMP(3),
    "last_verify_status"      TEXT,
    "created_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"              TIMESTAMP(3) NOT NULL,
    CONSTRAINT "whatsapp_channels_org_fk"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);

CREATE TABLE "whatsapp_messages" (
    "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "organization_id"   UUID NOT NULL,
    "direction"         TEXT NOT NULL,
    "meta_message_id"   TEXT,
    "from_number"       TEXT,
    "to_number"         TEXT,
    "message_type"      TEXT,
    "body"              TEXT,
    "raw_payload"       JSONB,
    "received_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "whatsapp_messages_org_received_idx"
    ON "whatsapp_messages" ("organization_id", "received_at" DESC);

-- RLS policies for these tables are applied by `pnpm rls:apply` (see rls.sql).
-- Grants for app_user are picked up via ALTER DEFAULT PRIVILEGES so new
-- tables created by Prisma migrate inherit the same DML rights.
