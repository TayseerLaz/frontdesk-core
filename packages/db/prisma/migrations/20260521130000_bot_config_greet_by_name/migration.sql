-- BotConfig.greetByName — toggles whether the bot's first reply in a
-- thread addresses the customer by their WhatsApp profile name. Off by
-- default so existing tenants keep their current behaviour.
ALTER TABLE "bot_configs"
  ADD COLUMN IF NOT EXISTS "greet_by_name" BOOLEAN NOT NULL DEFAULT false;
