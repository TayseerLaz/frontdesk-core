-- Data-export output format + layout.
--   format: 'csv' (ZIP of spreadsheets) | 'pdf' (formal report document)
--   layout: 'combined' (one file) | 'separate' (one document per section, zipped)
-- Additive columns with back-compat defaults (csv + combined = previous behaviour).
ALTER TABLE "data_exports" ADD COLUMN "format" TEXT NOT NULL DEFAULT 'csv';
ALTER TABLE "data_exports" ADD COLUMN "layout" TEXT NOT NULL DEFAULT 'combined';
