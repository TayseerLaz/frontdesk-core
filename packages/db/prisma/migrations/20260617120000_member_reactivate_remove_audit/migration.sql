-- Add audit actions for member reactivation + removal.
-- PG 12+ allows ALTER TYPE ... ADD VALUE inside a transaction; the new value
-- is only USED at runtime in a later transaction, so this is safe.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'user_reactivated';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'user_removed';
