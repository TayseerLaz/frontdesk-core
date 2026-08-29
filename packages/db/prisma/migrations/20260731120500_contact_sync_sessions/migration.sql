-- "Sync contacts with phone" — a short-lived, QR-mediated handoff that lets a tenant
-- push their phone's address book into Hader from the device that holds it.
--
-- Why a table at all, rather than a signed stateless token: the phone that scans the
-- QR is NOT logged in, so the token IS the credential. Persisting it lets us (a) store
-- only its SHA-256 so a DB read can't replay a live session, (b) expire and single-use
-- it server-side, and (c) give the desktop something to poll. A stateless JWT would be
-- replayable for its full lifetime with no revocation.
--
-- RLS is applied INLINE at the bottom, which is mandatory, not belt-and-braces:
-- infra/scripts/redeploy.sh runs `prisma migrate deploy` with NO `rls:apply` step,
-- and deploy.yml applies rls.sql with `|| true`. A tenant table whose policy lives
-- only in rls.sql can therefore ship completely unprotected. rls.sql is updated too
-- so a policy-repair pass doesn't miss this table.

CREATE TYPE "ContactSyncStatus" AS ENUM ('pending', 'opened', 'completed', 'expired', 'failed');

CREATE TABLE "contact_sync_sessions" (
  "id"                    UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"       UUID NOT NULL,
  "status"                "ContactSyncStatus" NOT NULL DEFAULT 'pending',
  -- SHA-256 of the bearer token. The plaintext is returned exactly once, at
  -- creation, and is never stored — mirrors the ApiKey convention.
  "token_sha256"          TEXT NOT NULL,
  -- 'android' | 'ios'. Chosen by the tenant before the QR renders so the phone page
  -- can show one flow instead of asking the user to self-identify their own OS.
  "device_kind"           TEXT NOT NULL,
  -- Dial code applied to LOCAL-format numbers ("03 123 456" -> "+96103123456").
  -- Address books overwhelmingly store local format, so without this an import
  -- produces well-formed nonsense that silently fails to match any real contact.
  "default_dial_code"     TEXT,
  -- The tenant's marketing attestation. NULL = not attested = imported contacts stay
  -- opted-out, which is the safe default: a personal address book is not a consented
  -- marketing list. When set, the verbatim attested text is kept as evidence.
  "marketing_attested_at" TIMESTAMP(3),
  "marketing_attest_text" TEXT,
  "created_by_user_id"    UUID,
  "expires_at"            TIMESTAMP(3) NOT NULL,
  "opened_at"             TIMESTAMP(3),
  "completed_at"          TIMESTAMP(3),
  "failure_reason"        TEXT,
  "contacts_received"     INTEGER NOT NULL DEFAULT 0,
  "contacts_created"      INTEGER NOT NULL DEFAULT 0,
  "contacts_updated"      INTEGER NOT NULL DEFAULT 0,
  "contacts_skipped"      INTEGER NOT NULL DEFAULT 0,
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "contact_sync_sessions_pkey" PRIMARY KEY ("id")
);

-- Lookup path for the unauthenticated phone: hash the presented token, find the row.
CREATE UNIQUE INDEX "contact_sync_sessions_token_sha256_key"
  ON "contact_sync_sessions"("token_sha256");
CREATE INDEX "contact_sync_sessions_organization_id_created_at_idx"
  ON "contact_sync_sessions"("organization_id", "created_at" DESC);
-- Drives the expiry sweep.
CREATE INDEX "contact_sync_sessions_status_expires_at_idx"
  ON "contact_sync_sessions"("status", "expires_at");

-- Only the org FK, deliberately. `created_by_user_id` stays a bare UUID with no
-- constraint, matching SalesScanGrant.granted_by_user_id — declaring an FK here that
-- schema.prisma does not model as a relation would show up as drift on the next
-- `prisma migrate dev`.
ALTER TABLE "contact_sync_sessions" ADD CONSTRAINT "contact_sync_sessions_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation (RLS) — same helper every tenant-scoped table uses.
SELECT _app_userly_tenant_rls('contact_sync_sessions');
