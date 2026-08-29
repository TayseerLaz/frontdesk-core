-- Protected/owner membership: cannot be role-changed, deactivated, or removed
-- by anyone (even another admin). Locks the primary ALIGNED HQ owner account.
ALTER TABLE "memberships" ADD COLUMN IF NOT EXISTS "is_protected" BOOLEAN NOT NULL DEFAULT false;
