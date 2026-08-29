-- ALIGNED-HQ-only trail of integration credentials a tenant entered (WhatsApp,
-- Messenger/Instagram, Shopify connectors, payments…). Hidden from the tenant's
-- own audit view; credential values are stored encrypted in the metadata.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'integration_credentials_set';
