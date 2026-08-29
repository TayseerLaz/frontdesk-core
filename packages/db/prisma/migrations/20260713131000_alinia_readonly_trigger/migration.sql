-- Alinia integration: make source_system='alinia' rows READ-ONLY at the DB
-- layer, so no application path (the 9 product routes, the two bare updateMany
-- in bulk-delete/bulk-update, the business-info currency fan-out, the bot
-- bulk-toggle, revision restore, or any actor-less worker job) can mutate a
-- mirror listing. Only the one-way ingest/sync path — which sets
-- app.alinia_sync='on' via withAliniaSync() in apps/api/src/lib/db.ts — may.
--
-- Semantics: a BEFORE UPDATE/DELETE trigger that RETURNs NULL cancels the
-- write for that row silently, so org-wide bulk operations simply leave
-- Alinia-owned rows untouched instead of erroring. (Explicit single-row edits
-- surface a friendly "edit in Alinia" error at the route layer.)
--
-- Prisma does not manage triggers/functions, so this raw SQL causes no schema
-- drift (same approach as the pg_trgm GIN index + rls.sql). Idempotent.

CREATE OR REPLACE FUNCTION _alinia_guard_mirror_row() RETURNS trigger AS $$
BEGIN
  -- The sync worker sets app.alinia_sync='on' to write/refresh mirror rows.
  IF coalesce(current_setting('app.alinia_sync', true), '') = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  -- Everyone else: skip the write on this read-only mirror row.
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_alinia_guard_products ON products;
CREATE TRIGGER trg_alinia_guard_products
  BEFORE UPDATE OR DELETE ON products
  FOR EACH ROW
  WHEN (OLD.source_system = 'alinia')
  EXECUTE FUNCTION _alinia_guard_mirror_row();

DROP TRIGGER IF EXISTS trg_alinia_guard_services ON services;
CREATE TRIGGER trg_alinia_guard_services
  BEFORE UPDATE OR DELETE ON services
  FOR EACH ROW
  WHEN (OLD.source_system = 'alinia')
  EXECUTE FUNCTION _alinia_guard_mirror_row();
