-- Durable phone-sync provenance, written onto the contact itself.
--
-- WHY THIS EXISTS. Provenance shipped (20260805120000) carried only by a ContactTag, and a
-- tag is not durable: PATCH /contacts/:id replace-sets tags (contacts.routes.ts ~782 —
-- deleteMany by contact_id, then recreate from the request body). One routine operator tag
-- edit therefore destroys the provenance tag AND the 'phone-sync' tag that planRevert reads
-- for undo eligibility — silently, with no error and no audit row. The feature's central
-- promise (provenance outlives the 7-day session/ledger prune) was one tag edit from false.
--
-- The earlier migration's header justified tags-only by claiming a column of this shape on
-- `contacts` "would not have been free". That was wrong: 20260803161000 adds
-- `whatsapp_reachable BOOLEAN` to this very table and documents that nullable-with-no-default
-- is catalog-only on PG11+ *precisely because* contacts is the hottest tenant table. Same
-- reasoning applies here — no rewrite, no long lock, no default to backfill.
--
-- TWO COLUMNS BECAUSE THERE ARE TWO FACTS, and conflating them is the bug this design avoids
-- when the same number lives in two people's phones:
--
--   synced_from_label      ORIGIN.  Who first brought this person in. Written ONCE on create,
--                                   NEVER overwritten. Rita syncs and creates the contact;
--                                   Sami syncs later with the same number in his book.
--                                   Overwriting would claim Sami introduced them — false.
--                                   Sami's run records itself as an additional TAG instead.
--                                   Origin is single-valued and historical.
--   synced_from_session_id WHICH RUN. Deliberately NO foreign key: the reaper prunes
--                                   contact_sync_sessions after 7 days and a cascade would
--                                   erase the contact or null the trail. A dangling id still
--                                   resolves, because audit_logs keeps the
--                                   contact_sync_started/completed rows for that id forever,
--                                   carrying the acting user and the verbatim label. So
--                                   contact -> run -> person stays reachable permanently.
--
-- Presence (whose phones contain this number) stays on tags, where it belongs: it is
-- multi-valued, it is current rather than historical, and tags already filter, count and
-- bulk-select in UI that exists today.
--
-- NULL means "not introduced by a phone sync", which is the truth for every contact that
-- exists right now. NOT backfilled: a contact whose sync predates this was never recorded,
-- and inventing a value would be exactly the confident-wrong-answer failure this feature has
-- already had to correct once.
--
-- No RLS work. `contacts` already carries a per-row tenant_isolation policy, and a policy
-- covers every column of its table, including ones added later.
ALTER TABLE "contacts"
  ADD COLUMN IF NOT EXISTS "synced_from_label"      TEXT,
  ADD COLUMN IF NOT EXISTS "synced_from_session_id" UUID;

-- Answers "show me everything that came in from one run" without scanning the table. Partial,
-- because the column is NULL for essentially every row: a partial index stays tiny on a table
-- where almost nothing qualifies, instead of carrying an entry per contact fleet-wide.
CREATE INDEX IF NOT EXISTS "contacts_synced_from_session_idx"
  ON "contacts" ("organization_id", "synced_from_session_id")
  WHERE "synced_from_session_id" IS NOT NULL;
