-- Wallet balance-depletion alert thresholds (docs/wallet-billing-plan.md).
ALTER TABLE "tenant_wallets" ADD COLUMN "alert_thresholds" INTEGER[] NOT NULL DEFAULT ARRAY[80, 100];
ALTER TABLE "tenant_wallets" ADD COLUMN "alert_baseline_micros" BIGINT NOT NULL DEFAULT 0;
-- Existing funded wallets: treat the current balance as the full-tank baseline.
UPDATE "tenant_wallets" SET "alert_baseline_micros" = "available_micros" WHERE "available_micros" > 0;
