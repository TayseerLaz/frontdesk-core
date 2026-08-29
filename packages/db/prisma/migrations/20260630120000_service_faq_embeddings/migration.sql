-- Embeddings for services + FAQs (mirror products) so the bot can do top-K
-- semantic selection on them too, regardless of how they were added.
ALTER TABLE "services" ADD COLUMN IF NOT EXISTS "embedding" DOUBLE PRECISION[] NOT NULL DEFAULT '{}';
ALTER TABLE "services" ADD COLUMN IF NOT EXISTS "embedding_hash" TEXT;
ALTER TABLE "faqs" ADD COLUMN IF NOT EXISTS "embedding" DOUBLE PRECISION[] NOT NULL DEFAULT '{}';
ALTER TABLE "faqs" ADD COLUMN IF NOT EXISTS "embedding_hash" TEXT;
