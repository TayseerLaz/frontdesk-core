-- Channel-aware inbox foundation + Facebook Messenger / Instagram channel.

-- 1. Channel columns on threads + messages (additive, default 'whatsapp' so
--    every existing row + the WhatsApp path is unchanged).
ALTER TABLE "whatsapp_threads"  ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'whatsapp';
ALTER TABLE "whatsapp_threads"  ADD COLUMN "channel_user_id" TEXT;
ALTER TABLE "whatsapp_messages" ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'whatsapp';

-- 2. Per-tenant Messenger/Instagram channel.
CREATE TABLE "messenger_channels" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "page_id" TEXT,
  "page_name" TEXT,
  "ig_account_id" TEXT,
  "page_access_token" TEXT,
  "app_secret" TEXT,
  "webhook_verify_token" TEXT NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT false,
  "last_verify_status" TEXT,
  "last_verified_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "messenger_channels_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "messenger_channels_organization_id_key" ON "messenger_channels"("organization_id");
-- Resolve inbound webhooks by the page id.
CREATE INDEX "messenger_channels_page_id_idx" ON "messenger_channels"("page_id");
ALTER TABLE "messenger_channels"
  ADD CONSTRAINT "messenger_channels_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS for the new tenant table (current_org_id()/rls_bypassed() exist everywhere).
ALTER TABLE "messenger_channels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "messenger_channels" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "messenger_channels";
CREATE POLICY tenant_isolation ON "messenger_channels"
  USING (rls_bypassed() OR organization_id = current_org_id())
  WITH CHECK (rls_bypassed() OR organization_id = current_org_id());
