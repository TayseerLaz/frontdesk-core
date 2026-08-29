-- Cache WhatsApp template media-headers into Wasabi (Meta header URLs are
-- CSP-blocked + expire). Populated lazily; both nullable.
ALTER TABLE "whatsapp_templates" ADD COLUMN IF NOT EXISTS "header_media_storage_key" TEXT;
ALTER TABLE "whatsapp_templates" ADD COLUMN IF NOT EXISTS "header_media_type" TEXT;
