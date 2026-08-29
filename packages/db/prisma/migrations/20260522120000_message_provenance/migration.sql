-- Phase 8 — AI message provenance / audit trail.
--
-- Two new tenant-scoped tables:
--   system_prompt_snapshots  — content-addressed system prompts (SHA-256
--                              keyed) so we dedupe identical prompts across
--                              thousands of messages.
--   message_provenances      — one row per outbound bot reply with the
--                              inputs we fed the LLM, the candidate KB set,
--                              and (filled later by Phase 1.2 scanner)
--                              citations + hallucinations.
--
-- Both are RLS-isolated by organization_id. message_provenances is 1:1 with
-- whatsapp_messages via a unique FK.

CREATE TABLE IF NOT EXISTS system_prompt_snapshots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sha256          CHAR(64) NOT NULL,
  body            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS system_prompt_snapshots_org_sha_uq
  ON system_prompt_snapshots (organization_id, sha256);

CREATE INDEX IF NOT EXISTS system_prompt_snapshots_org_created_idx
  ON system_prompt_snapshots (organization_id, created_at DESC);

ALTER TABLE system_prompt_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON system_prompt_snapshots;
CREATE POLICY tenant_isolation ON system_prompt_snapshots
  USING (rls_bypassed() OR organization_id = current_org_id())
  WITH CHECK (rls_bypassed() OR organization_id = current_org_id());

CREATE TABLE IF NOT EXISTS message_provenances (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  message_id                UUID NOT NULL UNIQUE REFERENCES whatsapp_messages(id) ON DELETE CASCADE,
  system_prompt_snapshot_id UUID NOT NULL REFERENCES system_prompt_snapshots(id) ON DELETE RESTRICT,

  user_prompt               TEXT NOT NULL,
  history_json              JSONB NOT NULL DEFAULT '[]',

  candidate_product_ids     UUID[] NOT NULL DEFAULT '{}',
  candidate_service_ids     UUID[] NOT NULL DEFAULT '{}',
  candidate_faq_ids         UUID[] NOT NULL DEFAULT '{}',
  candidate_policy_kinds    TEXT[] NOT NULL DEFAULT '{}',
  business_info_fields      TEXT[] NOT NULL DEFAULT '{}',

  -- Filled by Phase 1.2 scanner; nullable so Phase 1.1 can ship today.
  citations      JSONB,
  hallucinations JSONB,

  model             TEXT NOT NULL,
  temperature       REAL NOT NULL,
  prompt_tokens     INT  NOT NULL,
  completion_tokens INT  NOT NULL,
  latency_ms        INT  NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS message_provenances_org_created_idx
  ON message_provenances (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS message_provenances_snapshot_idx
  ON message_provenances (system_prompt_snapshot_id);

ALTER TABLE message_provenances ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON message_provenances;
CREATE POLICY tenant_isolation ON message_provenances
  USING (rls_bypassed() OR organization_id = current_org_id())
  WITH CHECK (rls_bypassed() OR organization_id = current_org_id());
