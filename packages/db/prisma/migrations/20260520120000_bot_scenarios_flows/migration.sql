-- Bot test scenarios + conversation-flow candidates.
--
-- 1. `bot_test_scenarios` replaces the hardcoded SCENARIOS array in
--    bot.routes.ts. Each org owns its own set, generated from its current
--    KB + catalog by an LLM and editable / deletable.
-- 2. `bot_conversation_flow_options` holds 3-5 LLM-recommended flow
--    candidates per org. Exactly one is `is_selected` and its `flow` JSON
--    is mirrored onto `bot_configs.conversation_flow` so the runtime keeps
--    a single source of truth.

CREATE TABLE IF NOT EXISTS bot_test_scenarios (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  prompt          TEXT NOT NULL,
  expectation     TEXT NOT NULL,
  -- 'ai_generated' | 'manual'
  source          TEXT NOT NULL DEFAULT 'ai_generated',
  sort_order      INT  NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS bot_test_scenarios_org_key_uniq
  ON bot_test_scenarios (organization_id, key);
CREATE INDEX IF NOT EXISTS bot_test_scenarios_org_sort_idx
  ON bot_test_scenarios (organization_id, sort_order);

ALTER TABLE bot_test_scenarios ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON bot_test_scenarios;
CREATE POLICY tenant_isolation ON bot_test_scenarios
  USING (rls_bypassed() OR organization_id = current_org_id())
  WITH CHECK (rls_bypassed() OR organization_id = current_org_id());

CREATE TABLE IF NOT EXISTS bot_conversation_flow_options (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  description      TEXT NOT NULL,
  flow             JSONB NOT NULL,
  is_recommended   BOOLEAN NOT NULL DEFAULT FALSE,
  recommend_reason TEXT,
  is_selected      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bot_conversation_flow_options_org_selected_idx
  ON bot_conversation_flow_options (organization_id, is_selected);

ALTER TABLE bot_conversation_flow_options ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON bot_conversation_flow_options;
CREATE POLICY tenant_isolation ON bot_conversation_flow_options
  USING (rls_bypassed() OR organization_id = current_org_id())
  WITH CHECK (rls_bypassed() OR organization_id = current_org_id());
