-- Store the full Meta-shaped components array on each template so the
-- builder UI can express headers (text/image/video/document), body
-- placeholder examples, footer, and buttons (quick reply / URL / phone).
-- The legacy `body_text` column stays populated for search + the existing
-- read API; the components JSON is the new source of truth at submit time.
ALTER TABLE whatsapp_templates
  ADD COLUMN IF NOT EXISTS components JSONB;
