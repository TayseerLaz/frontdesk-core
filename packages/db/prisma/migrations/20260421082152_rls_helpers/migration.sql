-- RLS helpers + application role — DR fix.
--
-- These were previously created ONLY by rls.sql, which runs AFTER all Prisma
-- migrations. But migrations from 20260427180000_data_exports onward call
-- _app_userly_tenant_rls() / rls_bypassed() inline, so `prisma migrate
-- deploy` FAILED on a fresh database (helpers didn't exist yet). Existing
-- servers never noticed because rls.sql had already created them.
--
-- This migration is dated one second before 20260421082153_initial so it runs
-- FIRST on a fresh DB. The functions/role depend on NO tables, so running
-- before any table exists is safe. Everything is idempotent (CREATE OR REPLACE,
-- role IF NOT EXISTS, additive grants), so applying it to an existing database
-- that already has these objects is a no-op. rls.sql remains the source of
-- truth for the per-table policies and re-runs these definitions harmlessly.

-- ---------- helpers ---------------------------------------------------------
CREATE OR REPLACE FUNCTION current_org_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION rls_bypassed() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.bypass_rls', true), 'off') = 'on'
$$;

-- ---------- application role ------------------------------------------------
-- The application connects as a non-superuser role so RLS is enforced.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
END$$;

-- Grants. On a fresh DB no tables exist yet, so the ALL TABLES grants are
-- no-ops here; ALTER DEFAULT PRIVILEGES is what makes every table the
-- subsequent migrations create inherit the grants. rls.sql re-grants ON ALL
-- TABLES afterward as a backstop.
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;

-- ---------- macro: enable + force RLS + tenant policy -----------------------
CREATE OR REPLACE FUNCTION _app_userly_tenant_rls(_table regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', _table);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', _table);

  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', _table);
  EXECUTE format($p$
    CREATE POLICY tenant_isolation ON %s
      USING (rls_bypassed() OR organization_id = current_org_id())
      WITH CHECK (rls_bypassed() OR organization_id = current_org_id())
  $p$, _table);
END$$;
