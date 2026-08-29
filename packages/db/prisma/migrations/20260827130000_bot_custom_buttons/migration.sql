-- F11 (roadmap 2026-08-26) — operator-configured quick buttons on BotConfig.
-- Additive JSONB column; existing RLS on bot_configs covers new columns.
ALTER TABLE "bot_configs" ADD COLUMN "custom_buttons" JSONB;
