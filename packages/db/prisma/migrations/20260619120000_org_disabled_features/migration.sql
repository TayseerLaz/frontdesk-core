-- ALIGNED-admin per-tenant access control: disabled feature keys.
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "disabled_features" TEXT[] NOT NULL DEFAULT '{}';
