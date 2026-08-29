-- Phase 3 §5.1.3 (billing) + §5.1.4 (white-label, Meta onboarding stepper).

CREATE TYPE "SubscriptionStatus" AS ENUM (
    'trialing', 'active', 'past_due', 'cancelled', 'free', 'paused'
);

CREATE TABLE "plans" (
    "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "code"                     TEXT NOT NULL UNIQUE,
    "name"                     TEXT NOT NULL,
    "is_active"                BOOLEAN NOT NULL DEFAULT TRUE,
    "product_cap"              INT,
    "service_cap"              INT,
    "member_cap"               INT,
    "monthly_message_cap"      INT,
    "monthly_import_cap"       INT,
    "api_key_cap"              INT,
    "webhook_cap"              INT,
    "price_monthly_minor"      INT,
    "price_yearly_minor"       INT,
    "currency"                 TEXT NOT NULL DEFAULT 'USD',
    "stripe_price_monthly_id"  TEXT,
    "stripe_price_yearly_id"   TEXT,
    "description"              TEXT,
    "highlights"               TEXT[] NOT NULL DEFAULT '{}',
    "sort_order"               INT NOT NULL DEFAULT 100,
    "updated_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "subscriptions" (
    "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "organization_id"          UUID NOT NULL UNIQUE,
    "plan_id"                  UUID NOT NULL,
    "status"                   "SubscriptionStatus" NOT NULL DEFAULT 'trialing',
    "stripe_customer_id"       TEXT,
    "stripe_subscription_id"   TEXT,
    "trial_ends_at"            TIMESTAMP(3),
    "current_period_end"       TIMESTAMP(3),
    "cancel_at_period_end"     BOOLEAN NOT NULL DEFAULT FALSE,
    "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"               TIMESTAMP(3) NOT NULL,
    CONSTRAINT "subscriptions_org_fk"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
    CONSTRAINT "subscriptions_plan_fk"
        FOREIGN KEY ("plan_id") REFERENCES "plans"("id")
);

CREATE TABLE "usage_events" (
    "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "organization_id"  UUID NOT NULL,
    "kind"             TEXT NOT NULL,
    "count"            INT NOT NULL DEFAULT 1,
    "occurred_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "usage_events_org_kind_occurred_idx"
    ON "usage_events" ("organization_id", "kind", "occurred_at" DESC);

CREATE TABLE "usage_monthly" (
    "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "organization_id"  UUID NOT NULL,
    "year_month"       TEXT NOT NULL,
    "kind"             TEXT NOT NULL,
    "count"            INT NOT NULL DEFAULT 0,
    "updated_at"       TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "usage_monthly_org_ym_kind_uniq"
    ON "usage_monthly" ("organization_id", "year_month", "kind");
CREATE INDEX "usage_monthly_org_ym_idx"
    ON "usage_monthly" ("organization_id", "year_month");

CREATE TABLE "branding_configs" (
    "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "organization_id"  UUID NOT NULL UNIQUE,
    "logo_asset_id"    UUID,
    "accent_color"     TEXT,
    "custom_cname"     TEXT,
    "footer_text"      TEXT,
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"       TIMESTAMP(3) NOT NULL,
    CONSTRAINT "branding_configs_org_fk"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);

CREATE TABLE "meta_onboarding_steps" (
    "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "organization_id"  UUID NOT NULL,
    "step_key"         TEXT NOT NULL,
    "completed_at"     TIMESTAMP(3),
    "notes"            TEXT
);
CREATE UNIQUE INDEX "meta_onboarding_steps_org_step_uniq"
    ON "meta_onboarding_steps" ("organization_id", "step_key");
CREATE INDEX "meta_onboarding_steps_org_idx"
    ON "meta_onboarding_steps" ("organization_id");

-- Seed default plans. Stripe price IDs left null — set them via the admin
-- panel or env-driven plan-seed script after creating the prices in Stripe.
INSERT INTO "plans" ("code", "name", "is_active", "product_cap", "service_cap",
    "member_cap", "monthly_message_cap", "monthly_import_cap", "api_key_cap",
    "webhook_cap", "price_monthly_minor", "currency",
    "description", "highlights", "sort_order")
VALUES
    ('free',       'Free',         TRUE, 25,   10,   2,    500,    5,   2,  2,
        0,    'USD', 'Try the platform with limited usage.',
        ARRAY['25 products','500 messages/mo','2 team members'], 10),
    ('starter',    'Starter',      TRUE, 250,  100,  5,    5000,   50,  10, 10,
        4900, 'USD', 'For small businesses just starting on WhatsApp.',
        ARRAY['250 products','5,000 messages/mo','5 team members','Email support'], 20),
    ('growth',     'Growth',       TRUE, 2500, 1000, 20,   50000,  500, 50, 50,
        14900,'USD', 'For scaling teams with real volume.',
        ARRAY['2,500 products','50,000 messages/mo','20 team members','Priority support','API connectors'], 30),
    ('enterprise', 'Enterprise',   TRUE, NULL, NULL, NULL, NULL,   NULL,NULL,NULL,
        NULL, 'USD', 'Unlimited everything. Custom contract.',
        ARRAY['Unlimited products','Unlimited messages','Unlimited team','SLA + dedicated support','SSO + audit'], 40)
ON CONFLICT ("code") DO NOTHING;

-- Backfill: every existing org gets a 14-day trial on the Free plan.
INSERT INTO "subscriptions" ("organization_id", "plan_id", "status",
    "trial_ends_at", "updated_at")
SELECT
    o.id,
    (SELECT id FROM "plans" WHERE "code" = 'free' LIMIT 1),
    'trialing'::"SubscriptionStatus",
    CURRENT_TIMESTAMP + INTERVAL '14 days',
    CURRENT_TIMESTAMP
FROM "organizations" o
ON CONFLICT ("organization_id") DO NOTHING;
