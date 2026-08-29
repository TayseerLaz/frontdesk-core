-- Phase 5.5 — TOTP 2FA columns on users.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_secret" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_enrolled_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "recovery_codes_hashed" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
