-- Quota threshold warnings: a new notification kind + per-month tracking of
-- which thresholds (75/80/85/90/95/100%) we've already notified, so tenants get
-- one ping per crossing rather than one per usage increment.
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'quota_warning';

ALTER TABLE "usage_monthly"
  ADD COLUMN IF NOT EXISTS "notified_thresholds" INTEGER[] NOT NULL DEFAULT '{}';
