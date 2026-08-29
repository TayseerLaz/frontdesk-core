-- Per-tenant monthly AI-message allowance (admin-set). One AI message = one bot
-- reply (chat) or one bot turn (voice). null = unlimited; default seeds every
-- existing + new tenant at 2000 so nobody is accidentally uncapped.
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "monthly_ai_message_cap" INTEGER DEFAULT 2000;
