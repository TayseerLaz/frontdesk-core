-- Sprint 4 — tamper-evident audit log.
--
-- Adds a hash chain to audit_logs. Every row's `hash` covers its own
-- contents plus the `prev_hash` of the row before it (scoped per-org, or
-- a separate chain for NULL-org system events). Any retroactive edit
-- invalidates the row's own hash AND cascades — every later row's
-- prev_hash points to the old hash value of the tampered row.
--
-- The trigger uses a transactional advisory lock keyed off the org id
-- (or a constant for the global system chain) to serialise inserts
-- within each chain, so concurrent recordAudit() calls don't fork.
--
-- Verification: see apps/api/scripts/verify-audit-chain.ts (Sprint 4).

ALTER TABLE "audit_logs"
  ADD COLUMN "prev_hash" TEXT,
  ADD COLUMN "hash"      TEXT;

-- --------------------------------------------------------------------------
-- Helper function — canonical text representation of an audit row.
-- Centralised so the trigger AND the backfill use the SAME serialisation;
-- diverging would corrupt the chain.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_log_canonical(
  p_id            UUID,
  p_organization  UUID,
  p_action        "AuditAction",
  p_actor         UUID,
  p_entity_type   TEXT,
  p_entity_id     UUID,
  p_metadata      JSONB,
  p_ip            INET,
  p_user_agent    TEXT,
  p_created_at    TIMESTAMP,
  p_prev_hash     TEXT
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  -- chr(31) is the ASCII unit separator: improbable in any real audit
  -- field, so collisions via concat ambiguity are not feasible.
  SELECT concat_ws(
    chr(31),
    p_id::text,
    COALESCE(p_organization::text, ''),
    p_action::text,
    COALESCE(p_actor::text, ''),
    COALESCE(p_entity_type, ''),
    COALESCE(p_entity_id::text, ''),
    COALESCE(p_metadata::text, ''),
    COALESCE(host(p_ip), ''),
    COALESCE(p_user_agent, ''),
    extract(epoch FROM p_created_at)::text,
    COALESCE(p_prev_hash, '')
  );
$$;

CREATE OR REPLACE FUNCTION audit_log_compute_hash(p_canonical TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT encode(digest(p_canonical, 'sha256'), 'hex');
$$;

-- --------------------------------------------------------------------------
-- BEFORE INSERT trigger — fills prev_hash + hash atomically.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_log_hash_chain()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_prev_hash TEXT;
  v_lock_key  BIGINT;
BEGIN
  IF NEW.organization_id IS NOT NULL THEN
    v_lock_key := hashtextextended('audit:' || NEW.organization_id::text, 0);
  ELSE
    v_lock_key := hashtextextended('audit:__system__', 0);
  END IF;
  PERFORM pg_advisory_xact_lock(v_lock_key);

  IF NEW.organization_id IS NOT NULL THEN
    SELECT hash INTO v_prev_hash
    FROM audit_logs
    WHERE organization_id = NEW.organization_id
    ORDER BY created_at DESC, id DESC
    LIMIT 1;
  ELSE
    SELECT hash INTO v_prev_hash
    FROM audit_logs
    WHERE organization_id IS NULL
    ORDER BY created_at DESC, id DESC
    LIMIT 1;
  END IF;

  NEW.prev_hash := v_prev_hash;
  NEW.hash := audit_log_compute_hash(
    audit_log_canonical(
      NEW.id,
      NEW.organization_id,
      NEW.action,
      NEW.actor_user_id,
      NEW.entity_type,
      NEW.entity_id,
      NEW.metadata,
      NEW.ip_address,
      NEW.user_agent,
      NEW.created_at,
      NEW.prev_hash
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_log_hash_chain_tr ON audit_logs;
CREATE TRIGGER audit_log_hash_chain_tr
  BEFORE INSERT ON audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_hash_chain();

-- --------------------------------------------------------------------------
-- Backfill existing rows so the verifier passes from day one. Walk each
-- chain in (organization_id, created_at, id) order and carry the running
-- prev_hash forward.
-- --------------------------------------------------------------------------
DO $$
DECLARE
  r           RECORD;
  v_prev_hash TEXT;
  v_prev_org  UUID;
  v_prev_is_null BOOLEAN := TRUE;
BEGIN
  FOR r IN
    SELECT *
    FROM audit_logs
    ORDER BY (organization_id IS NULL), organization_id, created_at, id
  LOOP
    -- Chain boundary: new org (or NULL→non-NULL or vice versa).
    IF v_prev_is_null
       OR r.organization_id IS DISTINCT FROM v_prev_org
    THEN
      v_prev_hash := NULL;
    END IF;

    UPDATE audit_logs
    SET prev_hash = v_prev_hash,
        hash = audit_log_compute_hash(
          audit_log_canonical(
            r.id, r.organization_id, r.action, r.actor_user_id,
            r.entity_type, r.entity_id, r.metadata, r.ip_address,
            r.user_agent, r.created_at, v_prev_hash
          )
        )
    WHERE id = r.id
    RETURNING hash INTO v_prev_hash;

    v_prev_org := r.organization_id;
    v_prev_is_null := FALSE;
  END LOOP;
END $$;
