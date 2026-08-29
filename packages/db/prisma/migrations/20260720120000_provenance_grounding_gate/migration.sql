-- Grounding gate: record on each bot reply's provenance whether the gate
-- flagged an ungrounded product/price assertion. Additive + nullable/defaulted
-- so existing rows and non-caching paths are unaffected.
ALTER TABLE "message_provenances"
  ADD COLUMN "blocked" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "block_reason" TEXT;
