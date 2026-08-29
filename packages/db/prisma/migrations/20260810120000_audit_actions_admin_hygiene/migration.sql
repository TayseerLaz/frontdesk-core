-- Audit-trail hygiene (security review I-4).
--
-- Give three admin actions their own audit actions instead of overloading
-- 'org_suspended' (which made audit queries for genuine suspensions return
-- false positives): subscription-plan change, feature-toggle change, and admin
-- data export. Add an action for the hard org-delete (which previously wrote no
-- audit row at all), and one for wallet alert-threshold changes.
--
-- ADD VALUE is safe here: PostgreSQL 16 permits it inside a transaction as long
-- as the new value is not referenced in the same transaction (it isn't). Each is
-- IF NOT EXISTS so a partial re-apply is a no-op.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'org_deleted';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'org_plan_changed';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'org_features_changed';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'org_data_exported';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'wallet_thresholds_updated';
