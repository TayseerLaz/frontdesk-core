-- Sales Scan audit actions.
--
-- Its own migration, and timestamped BEFORE 20260730120500_sales_scan, because
-- Postgres will not let a freshly-added enum value be used in the same transaction
-- that adds it. IF NOT EXISTS keeps a re-apply idempotent.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'sales_scan_granted';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'sales_scan_revoked';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'sales_scan_data_deleted';
