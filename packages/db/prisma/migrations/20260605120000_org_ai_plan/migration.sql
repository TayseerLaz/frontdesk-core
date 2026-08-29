-- Per-tenant AI tier. Routes chat completions to one of three
-- provider stacks (basic / middle / max). Default basic so brand-new
-- tenants don't accidentally hit a premium provider on day 1.

CREATE TYPE "AiPlan" AS ENUM ('basic', 'middle', 'max');

ALTER TABLE "organizations"
  ADD COLUMN "ai_plan" "AiPlan" NOT NULL DEFAULT 'basic';

-- Audit-log enum entry for the new admin action. Recorded whenever an
-- ALIGNED admin flips a tenant's plan in /hq.
ALTER TYPE "AuditAction" ADD VALUE 'ai_plan_changed';
