-- `ALTER TYPE ... ADD VALUE` gets its own migration, always.
--
-- Postgres will not let a value added inside a transaction be USED in that same
-- transaction, and Prisma wraps each migration file in one. Adding this alongside
-- the contact_sync_sessions table would work on a fresh DB and then fail the first
-- time anything wrote `phone_sync`, which is the worst possible place to find out.
-- Same rule the repo already follows for NotificationKind.booking_received.

ALTER TYPE "ContactSource" ADD VALUE IF NOT EXISTS 'phone_sync';

-- Audit trail for the sync itself. `contact_sync_completed` carries the tenant's
-- marketing attestation (whether they claimed consent, and the verbatim text they
-- ticked), which is the record that matters if an imported contact ever complains.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'contact_sync_started';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'contact_sync_completed';
