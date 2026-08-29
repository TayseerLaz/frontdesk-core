-- Configurable data-export selection. Which dataset sections to include; empty
-- array = everything (back-compat with the tenant self-service export). Additive
-- column on the existing RLS-covered data_exports table.
ALTER TABLE "data_exports" ADD COLUMN "sections" TEXT[] NOT NULL DEFAULT '{}';
