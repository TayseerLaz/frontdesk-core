-- Phase 11.3 — cache Meta media_ids on product_images so the bot send
-- path can skip the per-message Wasabi-→-Meta upload (saves ~1-2 s per
-- attached image bubble). Meta media_ids live 30 days; the bot send
-- code re-uploads when the cached id is stale or the active primary
-- WhatsApp channel changed (media_ids are scoped to phone_number_id).

ALTER TABLE product_images
  ADD COLUMN IF NOT EXISTS meta_media_id              TEXT,
  ADD COLUMN IF NOT EXISTS meta_media_id_uploaded_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS meta_media_id_channel_id   UUID
    REFERENCES whatsapp_channels(id) ON DELETE SET NULL;

-- Partial index — only the rows that actually have a cached id show up
-- in the freshness scan. Most rows will have NULL on a fresh tenant.
CREATE INDEX IF NOT EXISTS product_images_meta_media_id_uploaded_at_idx
  ON product_images (meta_media_id_uploaded_at)
  WHERE meta_media_id IS NOT NULL;
