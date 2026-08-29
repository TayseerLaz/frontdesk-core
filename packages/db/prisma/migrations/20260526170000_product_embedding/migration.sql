-- Phase 2 Step 3 — top-K catalog injection.
--
-- Stores the OpenAI text-embedding-3-small vector for each product so the
-- bot pipeline can rank by cosine similarity to the customer's message and
-- inject only the most relevant ~8 products into the LLM prompt.
--
-- Why double-precision[]:
--   • The dataset is tiny (each org has tens-hundreds of products); a
--     pgvector dependency + IVF index is overkill. We fetch all
--     embeddings + compute cosine in Node — sub-millisecond at this size.
--   • Float[] in Prisma maps to double precision[] in Postgres, which is
--     8 bytes × 1536 dims = 12 KB per product. Storage is trivial.
--
-- The hash column avoids re-embedding unchanged rows: backfill jobs only
-- touch products whose name+description sha doesn't match the stored hash.

ALTER TABLE "products"
  ADD COLUMN "embedding"      double precision[] NOT NULL DEFAULT ARRAY[]::double precision[],
  ADD COLUMN "embedding_hash" TEXT;

CREATE INDEX "products_embedding_pending_idx"
  ON "products" (organization_id)
  WHERE deleted_at IS NULL AND (embedding = ARRAY[]::double precision[] OR embedding_hash IS NULL);
