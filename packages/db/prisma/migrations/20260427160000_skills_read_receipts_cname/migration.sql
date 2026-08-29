-- Skill-based routing + read receipts + custom CNAME validation state.

-- §5.1.1 Skill-based routing.
ALTER TABLE "memberships"
    ADD COLUMN IF NOT EXISTS "skills" TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE "whatsapp_threads"
    ADD COLUMN IF NOT EXISTS "required_skill" TEXT;

-- §5.1.1 Read receipts (Meta message_status webhook).
ALTER TABLE "whatsapp_messages"
    ADD COLUMN IF NOT EXISTS "meta_status" TEXT,
    ADD COLUMN IF NOT EXISTS "meta_status_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "whatsapp_messages_meta_id_idx"
    ON "whatsapp_messages" ("meta_message_id")
    WHERE "meta_message_id" IS NOT NULL;

-- §5.1.4 Custom CNAME validation state.
ALTER TABLE "branding_configs"
    ADD COLUMN IF NOT EXISTS "cname_status" TEXT,
    ADD COLUMN IF NOT EXISTS "cname_verified_at" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "cname_last_check_at" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "cname_error" TEXT;

-- Index for the Caddy on-demand-TLS ask endpoint that looks up CNAMEs.
CREATE INDEX IF NOT EXISTS "branding_configs_custom_cname_idx"
    ON "branding_configs" ("custom_cname")
    WHERE "custom_cname" IS NOT NULL;
