-- `ALTER TYPE ... ADD VALUE` gets its own migration, always.
--
-- Postgres will not let a value added inside a transaction be USED in that same
-- transaction, and Prisma wraps each migration file in one. Adding these alongside the
-- ledger table would work on a fresh database and then fail the first time anything wrote
-- one of the values — the worst possible place to discover it.
--
-- Note these are permanent: a Postgres enum value cannot be dropped. Five is the budget
-- for this feature; do not spend more without a reason.

-- Two new session states. 'review' means contacts are staged and waiting for the tenant;
-- 'importing' means an apply is in flight. Both MUST also be added to
-- contactSyncStatusSchema in packages/shared — the route serializer .parse()s every reply,
-- so a status the Zod enum does not know about 500s the very poll the review page depends on.
ALTER TYPE "ContactSyncStatus" ADD VALUE IF NOT EXISTS 'review';
ALTER TYPE "ContactSyncStatus" ADD VALUE IF NOT EXISTS 'importing';

-- Audit trail for the review + undo lifecycle.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'contact_sync_staged';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'contact_sync_applied';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'contact_sync_reverted';
