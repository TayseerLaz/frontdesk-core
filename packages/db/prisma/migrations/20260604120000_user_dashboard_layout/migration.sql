-- Per-user dashboard widget layout. JSONB so we can store the ordered
-- list of widget ids the operator has chosen + (future) per-widget
-- settings without another migration. NULL = "fall back to the
-- registry's defaults" — that keeps the column cheap on the millions
-- of users who never customise.
ALTER TABLE "users" ADD COLUMN "dashboard_layout" JSONB;
