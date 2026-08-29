-- Tag-based broadcast audiences.
--
-- Adds two columns on broadcasts so a campaign can target every Contact
-- whose contact_tag list intersects (OR) or covers (AND) a chosen set
-- of tag strings. Segments are kept on the row + in the enum for
-- backward compatibility with existing campaigns, but the wizard no
-- longer surfaces them.

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS audience_tags       TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS audience_tags_mode  TEXT   NOT NULL DEFAULT 'any';

-- Helpful for the fanout worker: "are there any tag-based broadcasts
-- for this org right now?" + per-tag queries.
CREATE INDEX IF NOT EXISTS broadcasts_audience_tags_idx
  ON broadcasts USING GIN (audience_tags);

-- Add the new value to the BroadcastAudienceKind enum.
ALTER TYPE "BroadcastAudienceKind" ADD VALUE IF NOT EXISTS 'tags';
