-- Correct webhook attribution, so a payload is credited to the tenant that owns
-- the phone number rather than the tenant whose callback URL Meta happened to use.
--
-- WHY. Resolution today is org-scoped by the URL path param, with an
-- unconditional fallback to that org's primary channel. Hader's 17 channels span
-- FOUR Meta apps, and the app secret is shared across every number on an app, so
-- the HMAC no longer distinguishes tenants. The app-level Callback URL for app
-- 1727898828528257 is one org's URL (demo-b2b). A number delivering there
-- resolves to demo-b2b's primary, the signature passes, and a `messages` payload
-- becomes demo-b2b's WhatsAppMessage/WhatsAppThread rows — another business's
-- live customer conversations, in the wrong inbox, answered 200 so Meta never
-- retries. That is live today, independent of Coexistence.
--
-- Embedded Signup makes it routine rather than incidental: a self-onboarding
-- tenant's very first delivery (including the one-shot `history`) arrives before
-- any per-WABA override callback exists.
--
-- Verified before writing this: zero duplicate phone_number_id values in prod, so
-- the partial unique index below cannot fail the migration. `prisma migrate
-- deploy` runs for every tenant at once via redeploy.sh, so a failure here is a
-- fleet-wide deploy failure — that check was not optional.

-- A phone number belongs to exactly ONE channel, fleet-wide. This is the
-- constraint that makes a global owner lookup meaningful rather than a guess.
-- Partial: 7 inactive placeholder channels legitimately hold NULL and must stay.
-- Prisma cannot express a partial unique index, same as the existing
-- whatsapp_channels_one_primary_per_org — schema.prisma carries a pointer comment.
CREATE UNIQUE INDEX "whatsapp_channels_phone_number_id_uniq"
  ON "whatsapp_channels"("phone_number_id")
  WHERE "phone_number_id" IS NOT NULL;

-- NOT unique: one WABA legitimately holds several phone numbers. This exists
-- because `history` may be the only field that identifies its subject by WABA —
-- the phone number may not be in our database yet.
CREATE INDEX "whatsapp_channels_waba_id_idx"
  ON "whatsapp_channels"("waba_id");

-- The org that actually OWNS the payload, when we can work it out.
-- meta_webhook_events.organization_id stays what its doc comment says it is: the
-- org whose callback URL received the delivery. Repurposing it would break RLS
-- and silently re-scope rows already written. This is the separate, honest answer.
ALTER TABLE "meta_webhook_events"
  ADD COLUMN "resolved_organization_id" UUID;

-- The replay query: "unprocessed rows of this field, grouped by real owner".
CREATE INDEX "meta_webhook_events_resolved_idx"
  ON "meta_webhook_events"("phone_number_id", "resolved_organization_id");

-- No RLS work. _app_userly_tenant_rls installs a per-ROW policy keyed on
-- organization_id; new columns are covered automatically.
