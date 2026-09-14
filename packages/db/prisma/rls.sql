-- ============================================================================
-- Row-Level Security policies for the platform
-- Applied automatically after every `prisma migrate` via `pnpm rls:apply`.
--
-- Strategy:
--   - The Fastify tenant-context plugin runs each authenticated request inside
--     a transaction with `SET LOCAL app.current_org_id = '<uuid>'`.
--   - For background workers acting on behalf of a tenant, the worker sets the
--     same setting before performing tenant-scoped queries.
--   - For super-admins (cross-tenant ops), a separate flag
--     `SET LOCAL app.bypass_rls = 'on'` skips tenant filtering. This flag is
--     ONLY ever set by code paths gated by `requireSuperAdmin` middleware.
--
-- Helper:
--   current_org_id()      → returns the uuid set on the connection, or NULL
--   rls_bypassed()        → true when the current txn has bypass on
--
-- Every tenant-scoped table:
--   1. ALTER TABLE … ENABLE ROW LEVEL SECURITY;
--   2. ALTER TABLE … FORCE ROW LEVEL SECURITY;     -- so even table owner is filtered
--   3. CREATE POLICY tenant_isolation USING / WITH CHECK using current_org_id().
--
-- This file is idempotent: every CREATE uses IF NOT EXISTS where supported,
-- and policies are dropped + recreated each apply.
-- ============================================================================

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
-- (Superusers bypass RLS by default; we explicitly avoid that.)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
END$$;

-- Grant table privileges to app_user (Prisma migrations run as superuser /
-- migration role; runtime queries should use a session role with SET ROLE).
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;

-- ---------- macro: enable + force RLS + tenant policy -----------------------
-- Usage: SELECT _apply_tenant_rls('memberships');
CREATE OR REPLACE FUNCTION _apply_tenant_rls(_table regclass) RETURNS void
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

-- ---------- apply to tenant-scoped tables (Day 1 set) -----------------------
SELECT _apply_tenant_rls('memberships');
SELECT _apply_tenant_rls('invitations');
SELECT _apply_tenant_rls('api_keys');

-- ---------- catalog tables (Day 2) ------------------------------------------
SELECT _apply_tenant_rls('assets');
SELECT _apply_tenant_rls('categories');
SELECT _apply_tenant_rls('products');
SELECT _apply_tenant_rls('product_variants');
SELECT _apply_tenant_rls('product_images');
SELECT _apply_tenant_rls('services');
SELECT _apply_tenant_rls('service_pricing_tiers');
SELECT _apply_tenant_rls('availability_windows');
SELECT _apply_tenant_rls('business_info');
SELECT _apply_tenant_rls('locations');
SELECT _apply_tenant_rls('contact_channels');
SELECT _apply_tenant_rls('faqs');
SELECT _apply_tenant_rls('policies');

-- ---------- imports / connectors / webhooks (Day 3) -------------------------
SELECT _apply_tenant_rls('import_jobs');
SELECT _apply_tenant_rls('import_job_rows');
SELECT _apply_tenant_rls('api_connectors');
SELECT _apply_tenant_rls('sync_runs');
SELECT _apply_tenant_rls('webhook_endpoints');
SELECT _apply_tenant_rls('webhook_deliveries');

-- ---------- Shopify integration ---------------------------------------------
SELECT _apply_tenant_rls('shopify_connections');
SELECT _apply_tenant_rls('shopify_scrape_runs');
SELECT _apply_tenant_rls('shopify_staged_items');

-- ---------- versioning + notifications (Day 4) ------------------------------
SELECT _apply_tenant_rls('catalog_revisions');
SELECT _apply_tenant_rls('notifications');

-- Bookings — RLS is applied inline in migration 20260513170000_bookings, but was
-- missing from this file, so a full rebuild from rls.sql alone would leave
-- bookings without a policy (default-deny outage on the next rebuild). Added for
-- parity (L-14). Idempotent: the helper DROPs the policy before re-creating it.
SELECT _apply_tenant_rls('bookings');
-- Phase 1.5
SELECT _apply_tenant_rls('whatsapp_channels');
SELECT _apply_tenant_rls('whatsapp_messages');
-- Session 4 (Phase 3 inbox)
SELECT _apply_tenant_rls('whatsapp_threads');
SELECT _apply_tenant_rls('whatsapp_thread_tags');
SELECT _apply_tenant_rls('whatsapp_notes');
SELECT _apply_tenant_rls('canned_responses');
SELECT _apply_tenant_rls('whatsapp_templates');
-- Phase 2 (AI bot builder)
SELECT _apply_tenant_rls('bot_configs');
SELECT _apply_tenant_rls('crawl_jobs');
SELECT _apply_tenant_rls('crawl_pages');
SELECT _apply_tenant_rls('knowledge_base_entries');
SELECT _apply_tenant_rls('bot_test_runs');
SELECT _apply_tenant_rls('bot_simulation_turns');
-- Phase 3 §5.1.3 + §5.1.4
SELECT _apply_tenant_rls('subscriptions');
SELECT _apply_tenant_rls('usage_events');
SELECT _apply_tenant_rls('usage_monthly');
SELECT _apply_tenant_rls('branding_configs');
SELECT _apply_tenant_rls('meta_onboarding_steps');
SELECT _apply_tenant_rls('data_exports');
-- Phase 4 — Broadcasts
SELECT _apply_tenant_rls('contacts');
SELECT _apply_tenant_rls('contact_tags');
SELECT _apply_tenant_rls('segments');
SELECT _apply_tenant_rls('broadcasts');
SELECT _apply_tenant_rls('broadcast_recipients');
SELECT _apply_tenant_rls('broadcast_events');
-- Phase 5.4 — Sequences (drip)
SELECT _apply_tenant_rls('sequences');
SELECT _apply_tenant_rls('sequence_steps');
SELECT _apply_tenant_rls('sequence_enrollments');
-- Cart / Shop feature
SELECT _apply_tenant_rls('carts');
SELECT _apply_tenant_rls('cart_items');
-- AI bot builder — flow candidates + test scenarios (added 2026-06-15 after
-- the RLS drift test flagged them missing).
SELECT _apply_tenant_rls('bot_conversation_flow_options');
SELECT _apply_tenant_rls('bot_test_scenarios');
-- Ultra plan — per-contact persona memory
SELECT _apply_tenant_rls('contact_memory');
-- Phase 8 — AI message provenance / audit trail
SELECT _apply_tenant_rls('system_prompt_snapshots');
SELECT _apply_tenant_rls('message_provenances');
SELECT _apply_tenant_rls('provenance_flag_decisions');
-- provenance_suppressions has a custom policy (NULL org_id = global,
-- readable by every tenant). The migration installs it inline; we just
-- enable + force RLS here on every re-apply for safety.
ALTER TABLE provenance_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE provenance_suppressions FORCE ROW LEVEL SECURITY;
-- Voice media gateway (Aseer-time voicebot)
SELECT _apply_tenant_rls('voice_calls');
SELECT _apply_tenant_rls('voice_call_turns');
SELECT _apply_tenant_rls('phone_integrations');
-- Payments (per-tenant, multi-provider)
SELECT _apply_tenant_rls('payment_configs');
-- Messenger / Instagram channel
SELECT _apply_tenant_rls('messenger_channels');
-- plans is GLOBAL (no organization_id) — no RLS needed; access via API only.

-- ---------- pg_trgm GIN indexes for fast search (Prisma can't express) ------
CREATE INDEX IF NOT EXISTS products_search_trgm_idx
  ON products USING gin (search_text gin_trgm_ops);

CREATE INDEX IF NOT EXISTS services_search_trgm_idx
  ON services USING gin (search_text gin_trgm_ops);

CREATE INDEX IF NOT EXISTS faqs_search_trgm_idx
  ON faqs USING gin (search_text gin_trgm_ops);

-- Phase 4 — search across phone + display_name for contacts
CREATE INDEX IF NOT EXISTS contacts_search_trgm_idx
  ON contacts USING gin (
    (lower(coalesce(phone_e164, '') || ' ' || coalesce(display_name, ''))) gin_trgm_ops
  );

-- Auto-maintain search_text on products, services, faqs.
CREATE OR REPLACE FUNCTION _set_product_search_text() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_text := lower(coalesce(NEW.name, '') || ' ' || coalesce(NEW.short_description, '') || ' ' || coalesce(NEW.description, '') || ' ' || coalesce(NEW.sku, ''));
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS products_search_text_trg ON products;
CREATE TRIGGER products_search_text_trg
  BEFORE INSERT OR UPDATE OF name, short_description, description, sku ON products
  FOR EACH ROW EXECUTE FUNCTION _set_product_search_text();

CREATE OR REPLACE FUNCTION _set_service_search_text() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_text := lower(coalesce(NEW.name, '') || ' ' || coalesce(NEW.short_description, '') || ' ' || coalesce(NEW.description, ''));
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS services_search_text_trg ON services;
CREATE TRIGGER services_search_text_trg
  BEFORE INSERT OR UPDATE OF name, short_description, description ON services
  FOR EACH ROW EXECUTE FUNCTION _set_service_search_text();

CREATE OR REPLACE FUNCTION _set_faq_search_text() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_text := lower(coalesce(NEW.question, '') || ' ' || coalesce(NEW.answer, ''));
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS faqs_search_text_trg ON faqs;
CREATE TRIGGER faqs_search_text_trg
  BEFORE INSERT OR UPDATE OF question, answer ON faqs
  FOR EACH ROW EXECUTE FUNCTION _set_faq_search_text();

-- audit_logs and sessions: organization_id is nullable (system / pre-org events).
-- Policy still filters by org_id when present; NULL rows visible only when bypass on.
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON audit_logs;
CREATE POLICY tenant_isolation ON audit_logs
  USING (
    rls_bypassed()
    OR (organization_id IS NOT NULL AND organization_id = current_org_id())
  )
  WITH CHECK (
    rls_bypassed()
    OR (organization_id IS NOT NULL AND organization_id = current_org_id())
    OR organization_id IS NULL  -- allow writing org-less system events
  );

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON sessions;
-- Sessions are user-scoped, not strictly tenant-scoped (a user may switch orgs).
-- We allow the auth layer to manage them via bypass; tenant queries never touch
-- the sessions table.
CREATE POLICY sessions_bypass_only ON sessions
  USING (rls_bypassed())
  WITH CHECK (rls_bypassed());

-- ---------- non-tenant tables (organizations, users) ------------------------
-- Organizations and users are global identities. Access is gated in app code
-- (requireSuperAdmin for cross-org reads). RLS still enabled so a leaked
-- query without bypass cannot enumerate everything.

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_self_or_bypass ON organizations;
CREATE POLICY org_self_or_bypass ON organizations
  USING (rls_bypassed() OR id = current_org_id())
  WITH CHECK (rls_bypassed() OR id = current_org_id());

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_membership_or_bypass ON users;
CREATE POLICY user_membership_or_bypass ON users
  USING (
    rls_bypassed()
    OR EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.user_id = users.id
        AND m.organization_id = current_org_id()
    )
  )
  WITH CHECK (rls_bypassed());  -- writes go through bypass (auth/admin paths)

-- ---------- end -------------------------------------------------------------
SELECT _apply_tenant_rls('tenant_wallets');
SELECT _apply_tenant_rls('wallet_ledger');
SELECT _apply_tenant_rls('google_calendar_connections');

-- Sales Scan ("Teach the bot with your own data") — added 2026-07-30.
SELECT _apply_tenant_rls('sales_scan_grants');
SELECT _apply_tenant_rls('sales_messages');
SELECT _apply_tenant_rls('sales_scan_summaries');

-- "Sync contacts with phone" — QR-mediated address-book import. Added 2026-07-31.
SELECT _apply_tenant_rls('contact_sync_sessions');
-- Per-row ledger for a sync run. Holds third-party PII (names/numbers from a tenant's
-- address book) while staged, so the policy matters as much as the sessions table's.
SELECT _apply_tenant_rls('contact_sync_staged_items');

-- the platform mobile app push-device registrations — added 2026-08-03.
SELECT _apply_tenant_rls('device_tokens');

-- Landing pad for Meta webhook payloads no handler consumes yet (Coexistence
-- `history` / `smb_*` above all). Holds raw third-party message content, so the
-- policy matters as much as whatsapp_messages'. Added 2026-08-20.
SELECT _apply_tenant_rls('meta_webhook_events');

-- Post-conversation CSAT rows (F2, roadmap 2026-08-26) — per-tenant ratings
-- with contact linkage. Added 2026-08-27.
SELECT _apply_tenant_rls('conversation_feedback');

-- Back-in-stock watches (F5, roadmap 2026-08-26) — per-tenant customer
-- interest flags with contact linkage. Added 2026-08-28.
SELECT _apply_tenant_rls('stock_watches');

-- CALL-E phone follow-through tasks (2026-09-14) — per-tenant outbound call
-- records carrying customer phone numbers + transcripts.
SELECT _apply_tenant_rls('phone_tasks');
