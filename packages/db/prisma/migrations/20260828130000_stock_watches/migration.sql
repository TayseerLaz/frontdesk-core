-- F5 (roadmap 2026-08-26) — back-in-stock watches. RLS applied in this same
-- migration (house invariant #1).
CREATE TABLE "stock_watches" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "product_id"      UUID,
  "service_id"      UUID,
  "contact_id"      UUID NOT NULL,
  "thread_id"       UUID,
  "inquiry_text"    TEXT,
  "source"          TEXT NOT NULL DEFAULT 'bot_auto',
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "notified_at"     TIMESTAMP(3),

  CONSTRAINT "stock_watches_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stock_watches_organization_id_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "stock_watches_product_id_fkey" FOREIGN KEY ("product_id")
    REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "stock_watches_service_id_fkey" FOREIGN KEY ("service_id")
    REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "stock_watches_contact_id_fkey" FOREIGN KEY ("contact_id")
    REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "stock_watches_thread_id_fkey" FOREIGN KEY ("thread_id")
    REFERENCES "whatsapp_threads"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  -- Exactly one watched entity per row.
  CONSTRAINT "stock_watches_one_entity_chk" CHECK (
    ("product_id" IS NULL) <> ("service_id" IS NULL)
  )
);

-- One watch per (org, entity, contact) — a repeat ask re-arms the existing
-- row instead of stacking duplicates. Prisma cannot express partial uniques.
CREATE UNIQUE INDEX "stock_watches_org_product_contact_uniq"
  ON "stock_watches"("organization_id", "product_id", "contact_id")
  WHERE "product_id" IS NOT NULL;
CREATE UNIQUE INDEX "stock_watches_org_service_contact_uniq"
  ON "stock_watches"("organization_id", "service_id", "contact_id")
  WHERE "service_id" IS NOT NULL;

-- The tick's scan: pending watches per org.
CREATE INDEX "stock_watches_organization_id_notified_at_idx"
  ON "stock_watches"("organization_id", "notified_at");

SELECT _app_userly_tenant_rls('stock_watches');
