-- Tenant-isolation drift fix. The RLS drift test surfaced five org-scoped
-- tables that were not fully isolated:
--   * contact_memory            — RLS NOT ENABLED  (active cross-tenant leak:
--                                 ultra-plan per-contact persona/facts were
--                                 readable across tenants by the app role)
--   * bot_conversation_flow_options, bot_test_scenarios,
--     provenance_flag_decisions — RLS enabled but NOT FORCED
--   * provenance_suppressions   — enabled but NOT FORCED (keeps its custom
--                                 global-NULL policy)
-- rls.sql is the source of truth but isn't cleanly idempotent and can halt
-- mid-file, so this versioned migration applies the fix deterministically.
-- current_org_id() + rls_bypassed() already exist in every environment
-- (every other tenant policy uses them).

-- contact_memory: full standard tenant isolation (was completely open).
ALTER TABLE contact_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_memory FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON contact_memory;
CREATE POLICY tenant_isolation ON contact_memory
  USING (rls_bypassed() OR organization_id = current_org_id())
  WITH CHECK (rls_bypassed() OR organization_id = current_org_id());

-- bot_conversation_flow_options: enable + FORCE + standard policy.
ALTER TABLE bot_conversation_flow_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_conversation_flow_options FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON bot_conversation_flow_options;
CREATE POLICY tenant_isolation ON bot_conversation_flow_options
  USING (rls_bypassed() OR organization_id = current_org_id())
  WITH CHECK (rls_bypassed() OR organization_id = current_org_id());

-- bot_test_scenarios: enable + FORCE + standard policy.
ALTER TABLE bot_test_scenarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_test_scenarios FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON bot_test_scenarios;
CREATE POLICY tenant_isolation ON bot_test_scenarios
  USING (rls_bypassed() OR organization_id = current_org_id())
  WITH CHECK (rls_bypassed() OR organization_id = current_org_id());

-- provenance_flag_decisions: enable + FORCE + standard policy.
ALTER TABLE provenance_flag_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE provenance_flag_decisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON provenance_flag_decisions;
CREATE POLICY tenant_isolation ON provenance_flag_decisions
  USING (rls_bypassed() OR organization_id = current_org_id())
  WITH CHECK (rls_bypassed() OR organization_id = current_org_id());

-- provenance_suppressions: keep its custom policy (NULL org_id = global,
-- readable by every tenant); just ensure RLS is forced.
ALTER TABLE provenance_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE provenance_suppressions FORCE ROW LEVEL SECURITY;
