-- Handset replies, so the inbox stops lying and the bot stops talking over the owner.
--
-- WHY. Under Coexistence the business keeps answering customers from the WhatsApp Business
-- app on their phone. Those replies reach us as Meta's `smb_message_echoes` webhook — a
-- field this app has been SUBSCRIBED to since 2026-08-20 and has never consumed. So today
-- a thread the owner answered by hand still reads "unanswered" in Hader, and the bot's only
-- human-is-here gate (`whatsapp_threads.assigned_to_user_id`) is never set, because a
-- handset reply produces no HTTP request to Hader at all. Both writers of that column are
-- authenticated portal routes.
--
-- Consuming echoes therefore CLOSES a live defect rather than opening one: it is the only
-- way Hader can know the owner already answered.

-- The fact needs its own column rather than borrowing assigned_to_user_id. A handset reply
-- has no Hader user behind it, and writing a sentinel user id would put a lie in the data
-- that every other reader of that column would then have to know about.
--
-- Meta's timestamp, never now(): the gate asks "did the owner already answer THIS message?",
-- which is a comparison against the inbound message's own time. A customer who writes again
-- after the owner's reply must still get a bot answer.
ALTER TABLE "whatsapp_threads"
  ADD COLUMN "handset_replied_at" TIMESTAMP(3);

-- Partial index because the gate only ever asks about threads that HAVE a handset reply,
-- which will be a small minority fleet-wide (one coexistence tenant among 17 channels
-- today). A full index would be mostly NULLs.
CREATE INDEX "whatsapp_threads_handset_replied_at_idx"
  ON "whatsapp_threads"("organization_id", "handset_replied_at")
  WHERE "handset_replied_at" IS NOT NULL;

-- THE DEDUP THAT DID NOT EXIST.
--
-- `whatsapp_messages_meta_id_idx` is a plain, non-unique index, and the application-level
-- dedup in the webhook handler is a findFirst filtered on `direction: 'inbound'`. So
-- outbound rows have never been deduplicated by wamid at all. That was survivable while
-- every outbound row was one we ourselves had just created; it is not survivable for
-- echoes, which arrive from Meta and are redelivered on Meta's own schedule (for up to 7
-- days — the 2026-08-10 ghost-reply incident). Without this, a redelivered echo
-- re-inserts the message and re-increments the thread's outbound_count every time.
--
-- Partial: plenty of rows legitimately carry no meta_message_id (operator notes,
-- placeholder rows, sends that failed before Meta returned an id), and those must stay.
--
-- VERIFIED BEFORE WRITING THIS, because `prisma migrate deploy` runs for every tenant at
-- once via redeploy.sh and a failure here is a fleet-wide deploy failure: prod has 13,104
-- whatsapp_messages rows, 13,097 with a meta_message_id, and ZERO duplicate
-- (organization_id, meta_message_id) groups. So this index cannot fail the migration.
--
-- Scoped by organization_id, not global: a wamid is unique within a WhatsApp account, and
-- scoping to the org keeps the constraint aligned with the RLS boundary rather than
-- asserting something about Meta's id space across unrelated tenants.
CREATE UNIQUE INDEX "whatsapp_messages_org_meta_id_uniq"
  ON "whatsapp_messages"("organization_id", "meta_message_id")
  WHERE "meta_message_id" IS NOT NULL;

-- No RLS work. _app_userly_tenant_rls installs a per-ROW policy keyed on
-- organization_id; both tables already carry it and new columns are covered
-- automatically. Same note as migration 20260820160000.
