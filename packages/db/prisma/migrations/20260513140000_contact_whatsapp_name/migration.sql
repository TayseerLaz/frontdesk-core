-- Add a separate column for the WhatsApp profile name reported by Meta
-- in inbound message payloads (contacts[].profile.name). Kept distinct
-- from `display_name`, which is the operator-editable nickname:
--   * whatsapp_name = source-of-truth from Meta, refreshed on every
--     inbound. Read-only from the UI.
--   * display_name  = operator-set rename. Free-form, only set when an
--     operator explicitly renames the contact or thread.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS whatsapp_name TEXT;

-- Denormalised copy on whatsapp_threads so the inbox list view shows
-- "Phone, WhatsApp name, rename" without a JOIN to contacts on every
-- row. Updated on every inbound message alongside customer_name.
ALTER TABLE whatsapp_threads
  ADD COLUMN IF NOT EXISTS customer_whatsapp_name TEXT;

-- Backfill the new whatsapp_threads column from contacts where the
-- phone matches. Both columns will continue diverging only when an
-- operator explicitly renames a thread (customer_name) without
-- touching the contact, which is fine — Meta's profile name is the
-- source of truth for customer_whatsapp_name.
UPDATE whatsapp_threads t
SET customer_whatsapp_name = c.whatsapp_name
FROM contacts c
WHERE t.organization_id = c.organization_id
  AND ('+' || t.customer_phone = c.phone_e164 OR t.customer_phone = c.phone_e164)
  AND c.whatsapp_name IS NOT NULL
  AND t.customer_whatsapp_name IS NULL;

