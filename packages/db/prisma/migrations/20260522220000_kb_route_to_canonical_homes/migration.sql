-- Phase 10.2 — finish the KB routing job per `kind`.
--
-- The previous migration copied EVERY KB row into FAQs. That covered
-- the common case (faq / product / service / custom — all of which are
-- Q&A in shape) but lost the fact that some KB rows belong in
-- canonical fields elsewhere:
--
--   • kind='business_info' rows describe the business itself — they
--     belong in BusinessInfo.about, not in FAQs.
--   • kind='product' / 'service' rows are Q&A ABOUT products/services,
--     not the products themselves; they stay in FAQs.
--
-- This migration:
--   1. For every org with a kind='business_info' KB row, copies the
--      LONGEST answer into BusinessInfo.about IF that field is empty.
--      We never overwrite operator-authored about text.
--   2. Tags every FAQ that was migrated from KB with its original `kind`
--      so the operator can filter / review in the UI.
--   3. Drops the now-stale business_info FAQs the previous migration
--      created (those rows live on BusinessInfo.about now).

-- 1. Promote business_info KB rows to BusinessInfo.about (when empty).
UPDATE business_info bi
SET about = TRIM(BOTH FROM kb.answer)
FROM (
  SELECT DISTINCT ON (organization_id) organization_id, answer
  FROM knowledge_base_entries
  WHERE kind = 'business_info' AND approved = true
  ORDER BY organization_id, LENGTH(answer) DESC
) kb
WHERE bi.organization_id = kb.organization_id
  AND (bi.about IS NULL OR TRIM(BOTH FROM bi.about) = '');

-- 2. Tag every FAQ that was migrated from a KB row with the KB's `kind`.
-- We match by org + lowercased question (the previous migration used the
-- same key). Tags are appended (never overwritten).
UPDATE faqs f
SET tags = ARRAY(
  SELECT DISTINCT t FROM unnest(
    f.tags || ARRAY['from_kb', 'kb_kind_' || kb.kind]
  ) t
)
FROM (
  SELECT organization_id, lower(question) AS question_key, kind
  FROM knowledge_base_entries
) kb
WHERE f.organization_id = kb.organization_id
  AND lower(f.question) = kb.question_key
  AND NOT ('from_kb' = ANY(f.tags));

-- 3. Drop business_info FAQs the previous migration created — they now
-- live on BusinessInfo.about, so keeping them as FAQs would duplicate
-- the same answer for the bot.
DELETE FROM faqs
WHERE 'kb_kind_business_info' = ANY(tags)
  AND organization_id IN (
    SELECT organization_id FROM business_info WHERE about IS NOT NULL AND TRIM(BOTH FROM about) <> ''
  );
