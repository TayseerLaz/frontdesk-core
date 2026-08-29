-- "Sync contacts with phone" gains a third device kind: whatsapp.
--
-- The Android and iOS flows hand the tenant a QR that opens a WEB PAGE on their phone.
-- The WhatsApp flow inverts that: the QR is scanned by WhatsApp itself (Settings ->
-- Linked Devices), so the code is a WhatsApp pairing payload produced by the ingest
-- service, relayed here, and rendered in the desktop dialog. No phone web page is
-- involved at all.
--
-- `wa_qr` holds the CURRENT pairing payload. WhatsApp rotates it roughly every 20s, so
-- the ingest service overwrites this repeatedly for the life of one pairing attempt; it
-- is transient display state, never an audit record.
--
-- `wa_phone` is the number that ended up linked, kept so the tenant can see which
-- account the contacts came from — an operator who links the wrong account (personal
-- rather than business) otherwise has no way to tell after the fact.
--
-- device_kind is already TEXT, so 'whatsapp' needs no type change. No RLS work: the
-- table's policy was installed inline when it was created and covers new columns.

ALTER TABLE "contact_sync_sessions" ADD COLUMN IF NOT EXISTS "wa_qr" TEXT;
ALTER TABLE "contact_sync_sessions" ADD COLUMN IF NOT EXISTS "wa_phone" TEXT;

-- The ingest service claims work by polling for sessions that still need a WhatsApp
-- link. Without this it would seq-scan the table on every tick.
CREATE INDEX IF NOT EXISTS "contact_sync_sessions_device_kind_status_idx"
  ON "contact_sync_sessions"("device_kind", "status");
