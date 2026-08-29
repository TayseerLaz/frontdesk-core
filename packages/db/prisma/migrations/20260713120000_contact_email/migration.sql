-- First-class email column on contacts (was only ever stored in attributes.email
-- by importers). Additive nullable column on an existing RLS table — no policy
-- change needed. Backfill from attributes.email where it looks like an address.
ALTER TABLE "contacts" ADD COLUMN "email" TEXT;

UPDATE "contacts"
   SET "email" = attributes->>'email'
 WHERE "email" IS NULL
   AND attributes ? 'email'
   AND (attributes->>'email') ~ '@';
