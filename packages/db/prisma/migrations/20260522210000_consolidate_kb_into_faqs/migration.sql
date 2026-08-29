-- Phase 10.1 — consolidate KnowledgeBaseEntry → FAQ.
--
-- Two Q&A tables ("FAQ" and "KnowledgeBaseEntry") with identical fields
-- caused the bot to pack both into the prompt, sometimes producing two
-- different answers to the same question. Going forward there is ONE
-- canonical Q&A table — `faqs` — and every approved KB row is copied
-- in here so no operator data is lost.
--
-- The KB table itself stays (the existing /bot KB UI still reads/writes
-- it; we just stop reading it in the bot prompt and surface a deprecation
-- banner). A follow-up migration in a later session can drop it once
-- operators have verified the merged rows.

INSERT INTO faqs (organization_id, question, answer, tags, visibility, sort_order, is_published, search_text, created_at, updated_at)
SELECT
  kb.organization_id,
  kb.question,
  kb.answer,
  ARRAY[]::TEXT[],
  'public'::"FaqVisibility",
  0,
  -- Only approved KB rows become published FAQs. Unapproved rows are
  -- still inserted (so the operator sees them in /business-info) but
  -- with is_published = false — the bot will skip them.
  COALESCE(kb.approved, false),
  -- Mirror FAQ.search_text shape (lowercase question + answer).
  lower(kb.question) || ' ' || lower(kb.answer),
  kb.created_at,
  kb.updated_at
FROM knowledge_base_entries kb
-- Skip rows whose question is already an FAQ (case-insensitive) for the
-- same org. Stops the operator's existing FAQ section from being
-- duplicated when the KB was generated from the same source.
WHERE NOT EXISTS (
  SELECT 1 FROM faqs f
  WHERE f.organization_id = kb.organization_id
    AND lower(f.question) = lower(kb.question)
);
