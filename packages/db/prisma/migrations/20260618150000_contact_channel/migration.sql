-- Origin channel for contacts (whatsapp | instagram | messenger).
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "channel" TEXT NOT NULL DEFAULT 'whatsapp';

-- Backfill: contacts whose phone_e164 isn't a real E.164 number (no leading +)
-- are Instagram/Messenger PSIDs created by the inbox auto-upsert.
UPDATE "contacts" SET "channel" = 'instagram'
 WHERE "channel" = 'whatsapp' AND "phone_e164" NOT LIKE '+%';
