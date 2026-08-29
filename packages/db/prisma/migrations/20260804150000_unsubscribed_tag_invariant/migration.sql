-- Keep the visible `unsubscribed` TAG in lockstep with the authoritative
-- `contacts.opted_out_at` column.
--
-- Enforcement always reads opted_out_at; the tag exists so operators can SEE
-- and FILTER unsubscribed people on /contacts. Those two drifted apart in
-- production because several paths set the column without writing the tag
-- (spoken STOP on a voice call, manual contact create, the operator's
-- unsubscribe toggle) — and a SQL backfill did the same. A trigger makes the
-- invariant hold for every writer, including future code and manual SQL.
--
-- SECURITY DEFINER so this internal bookkeeping is never blocked by RLS on
-- contact_tags; the rows it writes are always scoped to the contact's own
-- organization_id, so it cannot leak across tenants.

CREATE OR REPLACE FUNCTION _aligned_sync_unsubscribed_tag() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.opted_out_at IS NOT NULL THEN
    INSERT INTO contact_tags (organization_id, contact_id, tag)
    VALUES (NEW.organization_id, NEW.id, 'unsubscribed')
    ON CONFLICT (contact_id, tag) DO NOTHING;
  ELSE
    DELETE FROM contact_tags WHERE contact_id = NEW.id AND tag = 'unsubscribed';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_contacts_unsubscribed_tag ON contacts;
CREATE TRIGGER trg_contacts_unsubscribed_tag
AFTER INSERT OR UPDATE OF opted_out_at ON contacts
FOR EACH ROW EXECUTE FUNCTION _aligned_sync_unsubscribed_tag();

-- Reconcile whatever is already in the table.
INSERT INTO contact_tags (organization_id, contact_id, tag)
SELECT c.organization_id, c.id, 'unsubscribed'
FROM contacts c
WHERE c.opted_out_at IS NOT NULL AND c.deleted_at IS NULL
ON CONFLICT (contact_id, tag) DO NOTHING;

DELETE FROM contact_tags t
USING contacts c
WHERE t.contact_id = c.id AND t.tag = 'unsubscribed' AND c.opted_out_at IS NULL;
