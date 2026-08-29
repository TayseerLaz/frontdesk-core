-- Operator toggle for tappable quick-reply buttons (WhatsApp + Instagram/Messenger).
ALTER TABLE "bot_configs" ADD COLUMN IF NOT EXISTS "quick_replies_enabled" BOOLEAN NOT NULL DEFAULT true;
