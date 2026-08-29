-- Per-tenant, multi-provider payment configuration.
CREATE TABLE "payment_configs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'none',
  "static_link_url" TEXT,
  "bank_details" TEXT,
  "test_mode" BOOLEAN NOT NULL DEFAULT true,
  "credentials" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payment_configs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payment_configs_organization_id_key" ON "payment_configs"("organization_id");

ALTER TABLE "payment_configs"
  ADD CONSTRAINT "payment_configs_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation (RLS): enable + force + standard policy. current_org_id()
-- and rls_bypassed() exist in every environment (used by all tenant policies).
ALTER TABLE "payment_configs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_configs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "payment_configs";
CREATE POLICY tenant_isolation ON "payment_configs"
  USING (rls_bypassed() OR organization_id = current_org_id())
  WITH CHECK (rls_bypassed() OR organization_id = current_org_id());
