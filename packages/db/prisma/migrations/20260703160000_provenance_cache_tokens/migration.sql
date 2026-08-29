-- Store the prompt-cache token split on each provenance row so AI cost can be
-- priced at the correct per-bucket rate (cache reads ~10%, cache writes ~125%
-- of the base input rate for Anthropic; OpenAI cached input ~50%). Additive,
-- default 0 → existing rows and non-caching providers price exactly as before.
ALTER TABLE "message_provenances"
  ADD COLUMN "cache_read_tokens"  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cache_write_tokens" INTEGER NOT NULL DEFAULT 0;
