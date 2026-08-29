-- Operator "block contact" flag. Distinct from opted_out (customer STOP) and
-- deleted_at (soft delete). When set: no bot auto-reply + excluded from broadcasts.
ALTER TABLE "contacts" ADD COLUMN "blocked_at" TIMESTAMP(3);
