-- Unsubscribe handling: audit action + broadcast "send anyway" override.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'contact_unsubscribed';
ALTER TABLE "broadcasts" ADD COLUMN IF NOT EXISTS "include_opted_out" BOOLEAN NOT NULL DEFAULT false;
