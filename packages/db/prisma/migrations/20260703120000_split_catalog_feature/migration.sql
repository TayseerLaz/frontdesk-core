-- Split the single 'catalog' org-feature toggle into four independent toggles:
-- products / services / business_info / imports.
--
-- Any org that previously had 'catalog' in disabled_features now has all four
-- disabled (identical net effect — all catalog pages stay hidden). Orgs that did
-- NOT have 'catalog' disabled are left untouched, so products/services/
-- business_info/imports are all enabled for them by default.
--
-- Data-only migration (disabled_features is an existing text[] column).
UPDATE organizations o
SET disabled_features = sub.features
FROM (
  SELECT id,
    (
      SELECT array_agg(DISTINCT f)
      FROM unnest(
        array_remove(disabled_features, 'catalog')
        || ARRAY['products', 'services', 'business_info', 'imports']
      ) AS f
    ) AS features
  FROM organizations
  WHERE 'catalog' = ANY(disabled_features)
) sub
WHERE o.id = sub.id;
