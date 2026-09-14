-- CALL-E phone follow-through: its own audit action.
--
-- Placing a phone task was previously audited as `cart_updated`, which rendered
-- in the activity feed as "Cart Updated (phone_task)". Enum additions must live
-- in their own migration: Postgres cannot use a freshly added enum value inside
-- the transaction that added it.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'phone_task_created';
