ALTER TABLE "bot_configs" ADD COLUMN IF NOT EXISTS "tts_provider" TEXT NOT NULL DEFAULT 'google';
