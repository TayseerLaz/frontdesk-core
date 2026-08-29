-- Hader mobile app — FCM push-notification device registrations (Phase 1.6 of
-- the mobile plan, Hader-ai-app/CLAUDE.md §6).
--
-- One row per (user, FCM token); organizationId is the org the user was signed
-- into at registration (the app re-registers on every login). Rows are pruned
-- when FCM reports a token unregistered (apps/api/src/lib/push.ts).
--
-- RLS INLINE here (house rule: redeploy.sh runs `prisma migrate deploy` with no
-- rls:apply step, so anything living only in rls.sql never reaches production).
-- rls.sql gains the same line as the registry copy.

CREATE TABLE "device_tokens" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "user_id"         UUID NOT NULL,
  "platform"        TEXT NOT NULL,
  "fcm_token"       TEXT NOT NULL,
  "last_seen_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "device_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "device_tokens_organization_id_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "device_tokens_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "device_tokens_user_id_fcm_token_key"
  ON "device_tokens"("user_id", "fcm_token");
CREATE INDEX "device_tokens_organization_id_idx"
  ON "device_tokens"("organization_id");

SELECT _app_userly_tenant_rls('device_tokens');
