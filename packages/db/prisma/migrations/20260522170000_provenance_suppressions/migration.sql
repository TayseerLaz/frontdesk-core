-- Phase 8 / 1.7 — operator-driven hallucination feedback loop.
--
-- Two new tenant-scoped tables:
--
--   provenance_suppressions  — phrases the operator (or an ALIGNED admin)
--                              has confirmed are NOT real hallucinations.
--                              At scan time the scanner drops any
--                              suspect phrase that normalize-matches a
--                              row here. Org_id nullable: NULL = global
--                              (applies to every tenant); set = per-org.
--
--   provenance_flag_decisions — audit trail. Each row is a click on a
--                              hallucination flag: ✓ not a problem (fp),
--                              ⚠ confirmed wrong (tp), or 🤷 skip.
--                              Used to compute precision metrics and to
--                              power the auto-promotion heuristic
--                              ("≥3 tenants suppressed this phrase").

CREATE TABLE IF NOT EXISTS provenance_suppressions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = global (applies to all tenants). Non-NULL = per-org only.
  -- The "promote to global" button on a per-org row deletes it and
  -- re-inserts with org_id = NULL.
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  -- The phrase to suppress, lower-cased + whitespace-normalised.
  -- Suppressed if the scanner's flagged `matchedText` normalises to this.
  phrase          TEXT NOT NULL,
  -- Free-form note from the operator: "this is just our cart total label"
  note            TEXT,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Bumped every time the scanner would have flagged this phrase but
  -- the suppression caught it. Useful for the settings UI.
  matches_count   INT NOT NULL DEFAULT 0,
  last_matched_at TIMESTAMPTZ
);

-- A (organization_id, phrase) pair must be unique. NULL org_id acts as
-- the global row — postgres treats NULL as not-equal so we need a
-- partial unique index for the global half.
CREATE UNIQUE INDEX IF NOT EXISTS provenance_suppressions_org_phrase_uq
  ON provenance_suppressions (organization_id, phrase)
  WHERE organization_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS provenance_suppressions_global_phrase_uq
  ON provenance_suppressions (phrase)
  WHERE organization_id IS NULL;

CREATE INDEX IF NOT EXISTS provenance_suppressions_org_created_idx
  ON provenance_suppressions (organization_id, created_at DESC);

ALTER TABLE provenance_suppressions ENABLE ROW LEVEL SECURITY;

-- Two-policy setup:
--   • global rows (org_id IS NULL) are visible to EVERYONE (incl. all
--     tenants — they need to read these at scan time).
--   • per-org rows are tenant-isolated as usual.
DROP POLICY IF EXISTS tenant_isolation ON provenance_suppressions;
CREATE POLICY tenant_isolation ON provenance_suppressions
  FOR ALL
  USING (
    rls_bypassed()
    OR organization_id IS NULL
    OR organization_id = current_org_id()
  )
  WITH CHECK (
    rls_bypassed()
    OR organization_id = current_org_id()
  );

CREATE TABLE IF NOT EXISTS provenance_flag_decisions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- The provenance row the flag came from.
  provenance_id   UUID NOT NULL REFERENCES message_provenances(id) ON DELETE CASCADE,
  -- Index INTO the hallucinations[] JSONB array on that provenance row.
  -- Lets the UI mark "the 2nd hallucination on this message" without
  -- restructuring the JSON.
  flag_index      INT NOT NULL,
  -- The phrase as it was flagged (denormalised so the decision survives
  -- even if the provenance row is deleted later).
  flagged_text    TEXT NOT NULL,
  -- 'false_positive' | 'true_positive' | 'skip'
  decision        TEXT NOT NULL,
  decided_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  note            TEXT
);

-- One decision per (provenance_id, flag_index) — re-clicking overwrites.
CREATE UNIQUE INDEX IF NOT EXISTS provenance_flag_decisions_uq
  ON provenance_flag_decisions (provenance_id, flag_index);

CREATE INDEX IF NOT EXISTS provenance_flag_decisions_org_decided_idx
  ON provenance_flag_decisions (organization_id, decided_at DESC);

ALTER TABLE provenance_flag_decisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON provenance_flag_decisions;
CREATE POLICY tenant_isolation ON provenance_flag_decisions
  USING (rls_bypassed() OR organization_id = current_org_id())
  WITH CHECK (rls_bypassed() OR organization_id = current_org_id());

-- Seed the global suppression list with the current code-level stoplist
-- so the scanner can stop hardcoding it. Adds: order-summary labels
-- (Subtotal, Total, …), currency codes (KWD, USD, …), confirmation
-- interjections (Just, Got, Done, …). All lower-cased.
INSERT INTO provenance_suppressions (organization_id, phrase, note)
SELECT NULL, phrase, 'Seeded from initial code-level stoplist'
FROM (VALUES
  -- order summary labels
  ('subtotal'), ('total'), ('grandtotal'), ('tax'), ('vat'), ('fee'),
  ('fees'), ('delivery'), ('shipping'), ('discount'), ('discounts'),
  ('service'), ('tip'), ('charge'), ('surcharge'), ('refund'),
  ('credit'), ('balance'), ('amount'), ('price'), ('quantity'), ('qty'),
  -- currency codes
  ('usd'), ('eur'), ('gbp'), ('kwd'), ('bhd'), ('omr'), ('jod'),
  ('aed'), ('sar'), ('qar'), ('egp'), ('jpy'), ('cny'), ('inr'),
  ('try'), ('chf'), ('cad'), ('aud'),
  -- confirmation interjections
  ('just'), ('got'), ('done'), ('cool'), ('awesome'), ('lovely'),
  ('nice'), ('excellent')
) AS seed(phrase)
ON CONFLICT DO NOTHING;
