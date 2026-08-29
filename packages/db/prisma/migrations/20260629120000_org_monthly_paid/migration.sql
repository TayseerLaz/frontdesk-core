-- Manual per-tenant monthly payment (USD) for the Billing & overview view.
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "monthly_paid_usd" DOUBLE PRECISION;
