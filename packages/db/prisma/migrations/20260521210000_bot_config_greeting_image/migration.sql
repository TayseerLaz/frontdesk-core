-- BotConfig.greetingImageStorageKey — optional Wasabi storage key for
-- an image (banner / welcome graphic) the bot attaches alongside any
-- reply that opens with a greeting word.
ALTER TABLE "bot_configs"
  ADD COLUMN IF NOT EXISTS "greeting_image_storage_key" TEXT;
