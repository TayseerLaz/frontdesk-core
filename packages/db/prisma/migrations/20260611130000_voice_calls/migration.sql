-- Voice media gateway (Aseer-time voicebot) — call lifecycle + transcripts.
-- One voice_calls row per phone call (idempotent upsert on org+call_uuid);
-- voice_call_turns holds the finalized caller/assistant transcript turns.
-- Both tables are tenant-scoped; RLS is applied via rls.sql on deploy and
-- inline below so the tables are never live without a policy.

CREATE TYPE "VoiceCallOutcome" AS ENUM ('in_progress', 'completed', 'handoff', 'dropped');

CREATE TABLE "voice_calls" (
  "id"              UUID               NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID               NOT NULL,
  "call_uuid"       TEXT               NOT NULL,
  "caller_id"       TEXT,
  "dialed_exten"    TEXT,
  "outcome"         "VoiceCallOutcome" NOT NULL DEFAULT 'in_progress',
  "handoff_reason"  TEXT,
  "started_at"      TIMESTAMP(3)       NOT NULL,
  "ended_at"        TIMESTAMP(3),
  "created_at"      TIMESTAMP(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3)       NOT NULL,
  CONSTRAINT "voice_calls_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "voice_calls_organization_id_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "voice_calls_organization_id_call_uuid_key"
  ON "voice_calls" ("organization_id", "call_uuid");
CREATE INDEX "voice_calls_organization_id_started_at_idx"
  ON "voice_calls" ("organization_id", "started_at" DESC);

CREATE TABLE "voice_call_turns" (
  "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID         NOT NULL,
  "voice_call_id"   UUID         NOT NULL,
  "seq"             INTEGER      NOT NULL,
  "role"            TEXT         NOT NULL,
  "text"            TEXT         NOT NULL,
  "at"              TIMESTAMP(3) NOT NULL,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "voice_call_turns_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "voice_call_turns_organization_id_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "voice_call_turns_voice_call_id_fkey" FOREIGN KEY ("voice_call_id")
    REFERENCES "voice_calls" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- (voice_call_id, seq) unique = idempotent appends under client retry.
CREATE UNIQUE INDEX "voice_call_turns_voice_call_id_seq_key"
  ON "voice_call_turns" ("voice_call_id", "seq");
CREATE INDEX "voice_call_turns_voice_call_id_at_idx"
  ON "voice_call_turns" ("voice_call_id", "at");
CREATE INDEX "voice_call_turns_organization_id_idx"
  ON "voice_call_turns" ("organization_id");

-- Inline RLS so the tables are protected even before the next rls.sql apply.
-- (rls.sql re-applies the same policy idempotently on every deploy.)
ALTER TABLE "voice_calls" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "voice_calls" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "voice_calls";
CREATE POLICY tenant_isolation ON "voice_calls"
  USING (rls_bypassed() OR organization_id = current_org_id())
  WITH CHECK (rls_bypassed() OR organization_id = current_org_id());

ALTER TABLE "voice_call_turns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "voice_call_turns" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "voice_call_turns";
CREATE POLICY tenant_isolation ON "voice_call_turns"
  USING (rls_bypassed() OR organization_id = current_org_id())
  WITH CHECK (rls_bypassed() OR organization_id = current_org_id());
