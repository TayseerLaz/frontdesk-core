-- Transparent ALIGNED-HQ access trail: dedicated audit actions so a tenant sees
-- a clearly-labeled "ALIGNED HQ accessed/left your workspace" entry (instead of
-- the old misleading 'business_info_updated' placeholder).
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'aligned_admin_accessed';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'aligned_admin_exited';
