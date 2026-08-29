-- Allow operators to override the LLM-as-judge score on a bot test run
-- when they disagree with it (e.g. the bot answered well but the judge
-- prompt is picky). The original LLM score stays on `score`; the
-- override lives in its own columns so the audit trail is preserved.
ALTER TABLE bot_test_runs
  ADD COLUMN IF NOT EXISTS override_score        INTEGER,
  ADD COLUMN IF NOT EXISTS override_notes        TEXT,
  ADD COLUMN IF NOT EXISTS override_by_user_id   UUID,
  ADD COLUMN IF NOT EXISTS override_at           TIMESTAMP(3);
