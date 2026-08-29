-- Google Calendar one-way sync (Hader → Calendar).
-- Adds per-booking event tracking + a per-tenant OAuth connection table.

-- Booking event tracking (additive, nullable).
ALTER TABLE "bookings" ADD COLUMN "google_event_id" TEXT;
ALTER TABLE "bookings" ADD COLUMN "google_synced_at" TIMESTAMP(3);

-- Per-tenant connection. OAuth tokens are AES-GCM-encrypted at rest by the app.
CREATE TABLE "google_calendar_connections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "google_email" TEXT,
    "calendar_id" TEXT NOT NULL DEFAULT 'primary',
    "access_token" TEXT,
    "refresh_token" TEXT NOT NULL,
    "token_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "google_calendar_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "google_calendar_connections_organization_id_key"
    ON "google_calendar_connections" ("organization_id");

ALTER TABLE "google_calendar_connections"
    ADD CONSTRAINT "google_calendar_connections_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation (RLS) — same helper every tenant-scoped table uses.
SELECT _app_userly_tenant_rls('google_calendar_connections');
