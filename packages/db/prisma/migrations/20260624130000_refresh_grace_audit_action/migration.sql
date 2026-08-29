-- H-01: observability for refresh-token grace-window re-issues.
-- Add a dedicated AuditAction value so device-bound grace re-issues are
-- queryable separately from genuine reuse-detection revocations.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'refresh_token_grace_reissue';
