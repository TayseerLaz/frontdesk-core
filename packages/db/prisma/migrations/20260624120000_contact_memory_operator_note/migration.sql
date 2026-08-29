-- Operator-curated "User info" on contact memory. AI summarizer never writes
-- these; when operator_note is set it supersedes `persona` in the bot prompt.
ALTER TABLE "contact_memory" ADD COLUMN IF NOT EXISTS "operator_note" TEXT;
ALTER TABLE "contact_memory" ADD COLUMN IF NOT EXISTS "operator_note_at" TIMESTAMP(3);
