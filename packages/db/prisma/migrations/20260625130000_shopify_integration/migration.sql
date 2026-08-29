-- Shopify integration — connection, scrape runs, and staged items (the
-- review+approve queue). Gated by the `shopify` org feature (opt-in).

-- ---------- enums -----------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "ShopifyConnectionStatus" AS ENUM ('active', 'failing', 'disabled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ShopifyStagedSection" AS ENUM ('product', 'contact', 'business_info', 'policy', 'faq', 'location');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ShopifyStagedStatus" AS ENUM ('pending', 'approved', 'rejected', 'imported');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- New notification kinds (not referenced in this migration, so adding the enum
-- value here is safe within the migration transaction).
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'shopify_review_ready';
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'shopify_import_done';

-- ---------- shopify_connections (one per org) -------------------------------
CREATE TABLE "shopify_connections" (
  "id"                    UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"       UUID NOT NULL,
  "store_domain"          TEXT NOT NULL,
  "credentials"           TEXT,
  "status"                "ShopifyConnectionStatus" NOT NULL DEFAULT 'active',
  "shop_name"             TEXT,
  "shop_currency"         TEXT,
  "last_verify_status"    TEXT,
  "auto_sync_enabled"     BOOLEAN NOT NULL DEFAULT true,
  "schedule_cron"         TEXT,
  "webhook_registered_at" TIMESTAMP(3),
  "last_scrape_at"        TIMESTAMP(3),
  "last_success_at"       TIMESTAMP(3),
  "consecutive_failures"  INTEGER NOT NULL DEFAULT 0,
  "created_by_id"         UUID,
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "shopify_connections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "shopify_connections_organization_id_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "shopify_connections_organization_id_key"
  ON "shopify_connections" ("organization_id");

-- ---------- shopify_scrape_runs ---------------------------------------------
CREATE TABLE "shopify_scrape_runs" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"  UUID NOT NULL,
  "connection_id"    UUID NOT NULL,
  "phase"            TEXT NOT NULL DEFAULT 'scrape',
  "trigger"          "SyncTrigger" NOT NULL,
  "status"           "SyncRunStatus" NOT NULL DEFAULT 'pending',
  "started_at"       TIMESTAMP(3),
  "finished_at"      TIMESTAMP(3),
  "products_found"   INTEGER NOT NULL DEFAULT 0,
  "contacts_found"   INTEGER NOT NULL DEFAULT 0,
  "other_found"      INTEGER NOT NULL DEFAULT 0,
  "records_imported" INTEGER NOT NULL DEFAULT 0,
  "records_failed"   INTEGER NOT NULL DEFAULT 0,
  "error_message"    TEXT,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "shopify_scrape_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "shopify_scrape_runs_organization_id_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "shopify_scrape_runs_connection_id_fkey" FOREIGN KEY ("connection_id")
    REFERENCES "shopify_connections" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "shopify_scrape_runs_connection_id_created_at_idx"
  ON "shopify_scrape_runs" ("connection_id", "created_at" DESC);
CREATE INDEX "shopify_scrape_runs_organization_id_status_created_at_idx"
  ON "shopify_scrape_runs" ("organization_id", "status", "created_at" DESC);

-- ---------- shopify_staged_items --------------------------------------------
CREATE TABLE "shopify_staged_items" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"  UUID NOT NULL,
  "connection_id"    UUID NOT NULL,
  "scrape_run_id"    UUID,
  "section"          "ShopifyStagedSection" NOT NULL,
  "external_id"      TEXT NOT NULL,
  "title"            TEXT NOT NULL,
  "normalized"       JSONB NOT NULL,
  "raw"              JSONB,
  "status"           "ShopifyStagedStatus" NOT NULL DEFAULT 'pending',
  "result_entity_id" TEXT,
  "error_message"    TEXT,
  "imported_at"      TIMESTAMP(3),
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "shopify_staged_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "shopify_staged_items_organization_id_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "shopify_staged_items_connection_id_fkey" FOREIGN KEY ("connection_id")
    REFERENCES "shopify_connections" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "shopify_staged_items_organization_id_section_external_id_key"
  ON "shopify_staged_items" ("organization_id", "section", "external_id");
CREATE INDEX "shopify_staged_items_organization_id_section_status_idx"
  ON "shopify_staged_items" ("organization_id", "section", "status");

-- ---------- RLS (inline; rls.sql re-applies idempotently) -------------------
ALTER TABLE "shopify_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shopify_connections" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "shopify_connections";
CREATE POLICY tenant_isolation ON "shopify_connections"
  USING (rls_bypassed() OR organization_id = current_org_id())
  WITH CHECK (rls_bypassed() OR organization_id = current_org_id());

ALTER TABLE "shopify_scrape_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shopify_scrape_runs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "shopify_scrape_runs";
CREATE POLICY tenant_isolation ON "shopify_scrape_runs"
  USING (rls_bypassed() OR organization_id = current_org_id())
  WITH CHECK (rls_bypassed() OR organization_id = current_org_id());

ALTER TABLE "shopify_staged_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shopify_staged_items" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "shopify_staged_items";
CREATE POLICY tenant_isolation ON "shopify_staged_items"
  USING (rls_bypassed() OR organization_id = current_org_id())
  WITH CHECK (rls_bypassed() OR organization_id = current_org_id());

-- Make the new tables usable by the app role immediately (rls.sql re-grants
-- ON ALL TABLES on every apply, but the migration runs first).
GRANT SELECT, INSERT, UPDATE, DELETE ON "shopify_connections" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "shopify_scrape_runs" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "shopify_staged_items" TO app_user;

-- ---------- opt-in backfill -------------------------------------------------
-- Shopify is an opt-in feature: turn it OFF for every existing org. An ALIGNED
-- admin enables it per-tenant from the features panel (e.g. The Booty Republic).
UPDATE "organizations"
  SET "disabled_features" = array_append("disabled_features", 'shopify')
  WHERE NOT ('shopify' = ANY("disabled_features"));
