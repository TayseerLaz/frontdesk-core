-- F1 (roadmap 2026-08-26) — per-member page access. JSONB (null = full
-- access for the role; [] = none; [...] = whitelist of page keys). Additive;
-- no backfill needed because NULL is the backward-compatible value.
ALTER TABLE "memberships" ADD COLUMN "page_access" JSONB;
ALTER TABLE "invitations" ADD COLUMN "page_access" JSONB;
