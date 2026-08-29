-- Alinia integration: mark products / images / services that are READ-ONLY
-- mirrors of Alinia real-estate listings.
--   source_system = 'native' (default) for Hader-authored rows,
--                   'alinia' for one-way synced mirror rows.
-- RE content for mirror products lives in products.attributes (JSONB); the
-- Int32 price_minor stays NULL for mirror rows.

ALTER TABLE "products" ADD COLUMN "source_system" TEXT NOT NULL DEFAULT 'native';
ALTER TABLE "products" ADD COLUMN "alinia_property_id" TEXT;

ALTER TABLE "product_images" ADD COLUMN "source_system" TEXT NOT NULL DEFAULT 'native';

ALTER TABLE "services" ADD COLUMN "source_system" TEXT NOT NULL DEFAULT 'native';

-- Idempotent upsert key for the mirror. NULLs are distinct in Postgres, so
-- native products (NULL alinia_property_id) never collide.
CREATE UNIQUE INDEX "products_organization_id_alinia_property_id_key" ON "products"("organization_id", "alinia_property_id");
CREATE INDEX "products_organization_id_source_system_idx" ON "products"("organization_id", "source_system");
