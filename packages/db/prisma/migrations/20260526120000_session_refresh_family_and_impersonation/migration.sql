-- Sprint 1 — Session hardening:
--   • M-2 refresh-token family / reuse detection: track the previously-rotated
--     refresh hash so a replay of an old token revokes the session.
--   • H-3 explicit impersonation flag: distinguishes ALIGNED-admin impersonation
--     sessions (which legitimately have no membership row) from regular sessions
--     (which must always have an active membership). Without this, removing an
--     ALIGNED admin from an org doesn't invalidate their existing session.
ALTER TABLE "sessions"
  ADD COLUMN "previous_token_hash" TEXT,
  ADD COLUMN "is_impersonation"    BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX "sessions_previous_token_hash_key"
  ON "sessions" ("previous_token_hash")
  WHERE "previous_token_hash" IS NOT NULL;

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'refresh_token_reuse_detected';
