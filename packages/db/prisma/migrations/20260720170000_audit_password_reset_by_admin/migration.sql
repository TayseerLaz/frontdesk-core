-- Admin-initiated member password reset gets its own audit action so the trail
-- clearly distinguishes it from a self-service password change. ADD VALUE must
-- run in its own migration (cannot run inside a txn alongside other DDL).
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'password_reset_by_admin';
