-- Deterministic scripted-flow support: a guided, button-driven state machine
-- that runs before the LLM and replies with the operator's exact text + buttons.
-- Both columns are additive + nullable on existing RLS tables (no policy change).
ALTER TABLE "bot_configs" ADD COLUMN "scripted_flow" JSONB;
ALTER TABLE "whatsapp_threads" ADD COLUMN "flow_state" JSONB;
