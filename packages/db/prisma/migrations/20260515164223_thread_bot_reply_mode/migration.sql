-- Phase 6 — per-thread override for the bot's reply mode.
-- NULL = inherit BotConfig.replyMode. Otherwise 'text' | 'voice' | 'match_customer'.
ALTER TABLE "whatsapp_threads" ADD COLUMN IF NOT EXISTS "bot_reply_mode" TEXT;
