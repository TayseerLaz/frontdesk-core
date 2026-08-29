-- Tenant wallet & metered WhatsApp billing (docs/wallet-billing-plan.md).

CREATE TYPE "WalletLedgerKind" AS ENUM ('topup', 'adjust', 'hold', 'settle', 'release');

CREATE TABLE "tenant_wallets" (
  "id"                            UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"               UUID NOT NULL,
  "available_micros"              BIGINT NOT NULL DEFAULT 0,
  "held_micros"                   BIGINT NOT NULL DEFAULT 0,
  "price_per_message_micros"      BIGINT NOT NULL DEFAULT 80000,
  "metering_enabled"              BOOLEAN NOT NULL DEFAULT false,
  "low_balance_threshold_micros"  BIGINT NOT NULL DEFAULT 0,
  "meta_cost_micros"              BIGINT NOT NULL DEFAULT 37500,
  "lifetime_topped_up_micros"     BIGINT NOT NULL DEFAULT 0,
  "lifetime_spent_micros"         BIGINT NOT NULL DEFAULT 0,
  "lifetime_messages"             INTEGER NOT NULL DEFAULT 0,
  "created_at"                    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tenant_wallets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tenant_wallets_organization_id_key" ON "tenant_wallets"("organization_id");
ALTER TABLE "tenant_wallets" ADD CONSTRAINT "tenant_wallets_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "wallet_ledger" (
  "id"                     UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"        UUID NOT NULL,
  "kind"                   "WalletLedgerKind" NOT NULL,
  "amount_micros"          BIGINT NOT NULL,
  "available_after_micros" BIGINT NOT NULL,
  "held_after_micros"      BIGINT NOT NULL,
  "broadcast_id"           UUID,
  "recipient_id"           UUID,
  "unit_price_micros"      BIGINT,
  "meta_cost_micros"       BIGINT,
  "note"                   TEXT,
  "actor_user_id"          UUID,
  "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wallet_ledger_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "wallet_ledger_organization_id_created_at_idx" ON "wallet_ledger"("organization_id", "created_at" DESC);
CREATE INDEX "wallet_ledger_organization_id_kind_created_at_idx" ON "wallet_ledger"("organization_id", "kind", "created_at");
ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "broadcasts" ADD COLUMN "billing_unit_price_micros" BIGINT;
ALTER TABLE "broadcasts" ADD COLUMN "billing_meta_cost_micros"  BIGINT;
ALTER TABLE "broadcasts" ADD COLUMN "billing_held_micros"       BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "broadcasts" ADD COLUMN "billing_settled_micros"    BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "broadcasts" ADD COLUMN "billing_released"          BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "broadcast_recipients" ADD COLUMN "billed_at" TIMESTAMP(3);

-- Tenant-scoped RLS on the two new tables.
SELECT _app_userly_tenant_rls('tenant_wallets');
SELECT _app_userly_tenant_rls('wallet_ledger');
