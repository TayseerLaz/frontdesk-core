-- The per-row ledger: what did one sync run do to one phone number.
--
-- Three features read this single table, because they are three readings of one fact:
--   · staged review  — rows with status 'included'/'excluded', before anything is applied
--   · undo           — rows with a contact_id, to know exactly what this run created
--   · enrichment     — a groupBy over `effect`, instead of six counter columns
--
-- Shape cloned from shopify_staged_items (schema.prisma ~1290), with ONE deliberate
-- difference: the unique key is (session_id, phone_e164), not (organization_id, section,
-- external_id). Shopify's key is a MIRROR key — a re-scrape is meant to overwrite the same
-- row. A contact sync is a RUN. Reusing a mirror key would let run 2 overwrite run 1's
-- rows, which would silently make run 1's undo a no-op.
--
-- Everything except the three NOT NULLs is nullable, also deliberately. ShopifyStagedItem
-- has `title` and `normalized` NOT NULL, but phone-sync contacts routinely have no name at
-- all (contact-sync-normalize.ts) — a nameless address-book entry must never abort the
-- 200-row chunk it happens to sit in.
--
-- RLS is applied INLINE at the bottom, which is mandatory, not belt-and-braces:
-- infra/scripts/redeploy.sh runs `prisma migrate deploy` with NO `rls:apply` step, and
-- deploy.yml applies rls.sql with `|| true`. A tenant table whose policy lives only in
-- rls.sql ships completely unprotected — and this one holds third-party PII.

-- A new CREATE TYPE is fine in a feature migration; only ALTER TYPE ... ADD VALUE needs
-- its own file.
CREATE TYPE "ContactSyncItemStatus" AS ENUM ('included', 'excluded', 'applied', 'failed');

CREATE TABLE "contact_sync_staged_items" (
  "id"                   UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"      UUID NOT NULL,
  "session_id"           UUID NOT NULL,
  "phone_e164"           TEXT NOT NULL,

  "display_name"         TEXT,
  "email"                TEXT,
  "company"              TEXT,

  "status"               "ContactSyncItemStatus" NOT NULL DEFAULT 'included',

  -- Decision support, computed once at stage time so the review page does not re-derive
  -- it per render: does this number already exist in the org?
  "existing_contact_id"  UUID,

  -- What the apply actually did: 'created' | 'updated' | 'unchanged' | 'skipped_deleted'
  -- | 'skipped_failed'. Plain TEXT rather than an enum — this is a record of an outcome,
  -- and adding an outcome later should not need an ALTER TYPE that can never be undone.
  "effect"               TEXT,

  -- The contact this row produced. NO FOREIGN KEY, deliberately: a contact deleted later
  -- must not cascade away the audit of the run that created it. A dangling id is the
  -- honest "it's gone" signal, and planRevert treats it as already-done rather than an
  -- error. Same reasoning as created_by_user_id on contact_sync_sessions.
  "contact_id"           UUID,

  -- What this run WROTE into a previously-null field. Undo reverts a field only when the
  -- current value still equals this, so an operator's later edit survives — and because
  -- the import only ever writes NULL -> value, the prior value is provably NULL and no
  -- snapshot is needed.
  "filled_display_name"  TEXT,
  "filled_email"         TEXT,

  "error_message"        TEXT,
  "applied_at"           TIMESTAMP(3),
  "reverted_at"          TIMESTAMP(3),
  "revert_outcome"       TEXT,

  "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "contact_sync_staged_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "contact_sync_staged_items_session_phone_key"
  ON "contact_sync_staged_items"("session_id", "phone_e164");
CREATE INDEX "contact_sync_staged_items_org_session_status_idx"
  ON "contact_sync_staged_items"("organization_id", "session_id", "status");
-- Drives undo (rows this run applied) and the retention sweep.
CREATE INDEX "contact_sync_staged_items_session_applied_idx"
  ON "contact_sync_staged_items"("session_id", "applied_at");

ALTER TABLE "contact_sync_staged_items" ADD CONSTRAINT "contact_sync_staged_items_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "contact_sync_staged_items" ADD CONSTRAINT "contact_sync_staged_items_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "contact_sync_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Session-level additions.
--   review_mode  — false preserves TODAY's exact behaviour for any session minted before
--                  this deploy. Tokens live 15-30 minutes, so a tenant mid-sync across a
--                  deploy must still be able to finish.
--   reverted_at / reverted_by_user_id — who undid this run, and when.
ALTER TABLE "contact_sync_sessions"
  ADD COLUMN IF NOT EXISTS "review_mode"          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "staged_at"            TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "reverted_at"          TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "reverted_by_user_id"  UUID;

-- Reachability. NULLABLE WITH NO DEFAULT, on purpose:
--   · contacts is the hottest tenant table in the product (upserted by WhatsApp inbound,
--     Messenger/IG inbound, voice call-start, CSV import, Shopify commit, manual create).
--     A nullable column with no default is catalog-only on PG11+ — no table rewrite, no
--     long lock. NOT NULL DEFAULT false would rewrite it.
--   · NULL means "never established", which is the truth for every contact of all 18 orgs
--     and must stay distinguishable from "checked, and not on WhatsApp".
--
-- INVARIANT: this column must NEVER appear in a broadcast-audience `where`. It is NULL
-- fleet-wide, so any audience filter over it silently zeroes every tenant's reach.
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "whatsapp_reachable" BOOLEAN;

-- Tenant isolation (RLS) — same helper every tenant-scoped table uses. The helper does not
-- GRANT, so grant explicitly (20260625130000_shopify_integration does the same).
SELECT _app_userly_tenant_rls('contact_sync_staged_items');
GRANT SELECT, INSERT, UPDATE, DELETE ON "contact_sync_staged_items" TO app_user;
