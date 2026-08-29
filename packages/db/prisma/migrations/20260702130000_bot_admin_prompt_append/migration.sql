-- ALIGNED-admin-only per-tenant prompt addendum, injected verbatim into the
-- bot's system prompt (after core rules, before catalog). Additive nullable
-- column on the existing RLS-covered bot_configs table — no new RLS needed.
ALTER TABLE "bot_configs" ADD COLUMN "admin_system_prompt_append" TEXT;
