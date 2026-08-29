-- Public marketing-site lead capture (name + WhatsApp number). GLOBAL table
-- (no organization_id) — these are ALIGNED's own inbound leads, surfaced only
-- in /hq/leads. No RLS policy is applied (the table is not tenant
-- scoped); runtime access goes through withRlsBypass(). The rls.sql blanket
-- GRANT (re-run every deploy) covers app_user privileges for this table.

CREATE TYPE "LeadStatus" AS ENUM ('new', 'contacted', 'converted', 'archived');

CREATE TABLE "leads" (
  "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
  "name"       TEXT         NOT NULL,
  "phone"      TEXT         NOT NULL,
  "source"     TEXT         NOT NULL DEFAULT 'hader_landing',
  "status"     "LeadStatus" NOT NULL DEFAULT 'new',
  "note"       TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "leads_created_at_idx" ON "leads" ("created_at" DESC);
