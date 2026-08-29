-- Phase 5.9 — Dunning auto-suspend notification kind.
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'org_suspended_for_billing';
