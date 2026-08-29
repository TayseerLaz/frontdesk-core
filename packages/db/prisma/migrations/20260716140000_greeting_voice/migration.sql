-- Optional greeting voice note (mirrors greeting_image_storage_key). Additive.
ALTER TABLE "bot_configs" ADD COLUMN "greeting_voice_storage_key" TEXT;
