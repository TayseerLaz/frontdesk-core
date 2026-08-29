-- Audit action for ALIGNED-admin edits to a tenant's bot system-prompt addendum.
-- ADD VALUE must run in its own migration (cannot be used in the same tx that
-- also references the new value).
ALTER TYPE "AuditAction" ADD VALUE 'bot_prompt_updated';
