-- Phase 6 — TTS voice replies for the WhatsApp bot.
-- replyMode = 'text' | 'voice' | 'match_customer'
-- ttsVoiceName = Google Cloud TTS voice name (nullable; falls back to env default)
ALTER TABLE "bot_configs" ADD COLUMN IF NOT EXISTS "reply_mode" TEXT NOT NULL DEFAULT 'text';
ALTER TABLE "bot_configs" ADD COLUMN IF NOT EXISTS "tts_voice_name" TEXT;
