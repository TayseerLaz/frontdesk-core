-- ===========================================================================
-- Platform core — consolidated baseline.
--
-- Squashed from the pre-fork migration chain into ONE migration so a FRESH
-- database deploys with `prisma migrate deploy` alone. The old chain could
-- not: later migrations referenced RLS helper functions that were created
-- afterwards, by a separate rls.sql pass.
--
-- Order matters:
--   1. extensions     citext + pgcrypto are used by the generated DDL itself
--   2. tables/enums   generated from schema.prisma
--   3. raw SQL        functions, triggers, partial + trigram indexes and CHECK
--                     constraints — none of which Prisma can express
--   4. RLS            helpers, application role, grants, per-table policies
-- ===========================================================================

-- ---------- 1. extensions --------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "citext";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ---------- 2. tables + enums (generated from schema.prisma) ---------------

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('admin', 'editor', 'viewer');

-- CreateEnum
CREATE TYPE "OrgStatus" AS ENUM ('active', 'suspended', 'deleted');

-- CreateEnum
CREATE TYPE "AiPlan" AS ENUM ('basic', 'middle', 'max', 'ultra');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('pending', 'active', 'disabled');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('pending', 'accepted', 'revoked', 'expired');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('user_created', 'user_updated', 'user_deactivated', 'user_reactivated', 'user_removed', 'user_role_changed', 'org_created', 'org_suspended', 'org_deleted', 'org_plan_changed', 'org_features_changed', 'org_data_exported', 'invitation_sent', 'invitation_accepted', 'invitation_revoked', 'api_key_created', 'api_key_revoked', 'password_changed', 'password_reset_requested', 'password_reset_by_admin', 'email_verified', 'login_succeeded', 'login_failed', 'logout', 'refresh_token_reuse_detected', 'refresh_token_grace_reissue', 'aligned_admin_accessed', 'aligned_admin_exited', 'integration_credentials_set', 'contact_unsubscribed', 'product_created', 'product_updated', 'product_deleted', 'service_created', 'service_updated', 'service_deleted', 'category_created', 'category_updated', 'category_deleted', 'business_info_updated', 'faq_created', 'faq_updated', 'faq_deleted', 'policy_created', 'policy_updated', 'policy_deleted', 'asset_uploaded', 'asset_deleted', 'import_started', 'import_completed', 'import_failed', 'api_key_used_first_time', 'webhook_endpoint_created', 'webhook_endpoint_deleted', 'webhook_delivered', 'webhook_failed', 'connector_created', 'connector_updated', 'connector_deleted', 'connector_sync_started', 'connector_sync_succeeded', 'connector_sync_failed', 'revision_restored', 'notification_marked_read', 'org_pilot_onboarded', 'contact_created', 'contact_updated', 'contact_deleted', 'segment_created', 'segment_updated', 'segment_deleted', 'broadcast_created', 'broadcast_updated', 'broadcast_sent', 'broadcast_paused', 'broadcast_resumed', 'broadcast_cancelled', 'broadcast_completed', 'booking_created', 'booking_updated', 'booking_deleted', 'cart_created', 'cart_updated', 'cart_deleted', 'ai_plan_changed', 'bot_prompt_updated', 'phone_integration_created', 'phone_integration_updated', 'phone_integration_deleted', 'wallet_topped_up', 'wallet_adjusted', 'wallet_price_changed', 'wallet_metering_toggled', 'wallet_thresholds_updated', 'sales_scan_granted', 'sales_scan_revoked', 'sales_scan_data_deleted', 'contact_sync_started', 'contact_sync_completed', 'contact_sync_staged', 'contact_sync_applied', 'contact_sync_reverted');

-- CreateEnum
CREATE TYPE "RevisionEntityType" AS ENUM ('product', 'service', 'business_info', 'faq', 'policy');

-- CreateEnum
CREATE TYPE "RevisionAction" AS ENUM ('created', 'updated', 'deleted', 'restored');

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('import_succeeded', 'import_partial', 'import_failed', 'sync_succeeded', 'sync_failed', 'webhook_disabled', 'api_key_first_use', 'generic', 'org_suspended_for_billing', 'shopify_review_ready', 'shopify_import_done', 'cart_received', 'booking_received', 'thread_assigned', 'order_paid', 'quota_warning');

-- CreateEnum
CREATE TYPE "NotificationSeverity" AS ENUM ('info', 'success', 'warning', 'error');

-- CreateEnum
CREATE TYPE "ImportJobStatus" AS ENUM ('pending', 'validating', 'processing', 'succeeded', 'partial', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "ImportEntityKind" AS ENUM ('product', 'service', 'faq', 'business_info');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('succeeded', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "ConnectorAuthKind" AS ENUM ('none', 'api_key', 'bearer', 'basic', 'hmac');

-- CreateEnum
CREATE TYPE "ConnectorStatus" AS ENUM ('active', 'paused', 'failing', 'disabled');

-- CreateEnum
CREATE TYPE "SyncRunStatus" AS ENUM ('pending', 'running', 'succeeded', 'failed', 'partial');

-- CreateEnum
CREATE TYPE "SyncTrigger" AS ENUM ('scheduled', 'manual', 'webhook');

-- CreateEnum
CREATE TYPE "ShopifyConnectionStatus" AS ENUM ('active', 'failing', 'disabled');

-- CreateEnum
CREATE TYPE "ShopifyStagedSection" AS ENUM ('product', 'contact', 'business_info', 'policy', 'faq', 'location');

-- CreateEnum
CREATE TYPE "ShopifyStagedStatus" AS ENUM ('pending', 'approved', 'rejected', 'imported');

-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('pending', 'in_flight', 'delivered', 'failed', 'giving_up');

-- CreateEnum
CREATE TYPE "WebhookEventKind" AS ENUM ('product_created', 'product_updated', 'product_deleted', 'service_created', 'service_updated', 'service_deleted', 'business_info_updated', 'faq_changed', 'policy_changed', 'catalog_changed', 'broadcast_started', 'broadcast_completed', 'broadcast_failed', 'broadcast_recipient_failed', 'booking_created', 'booking_status_changed', 'booking_reminder_sent', 'cart_created', 'cart_status_changed', 'cart_item_added', 'order_paid');

-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('image', 'document', 'csv_upload', 'other');

-- CreateEnum
CREATE TYPE "DayOfWeek" AS ENUM ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday');

-- CreateEnum
CREATE TYPE "PriceUnit" AS ENUM ('flat', 'per_hour', 'per_day', 'per_session', 'per_unit');

-- CreateEnum
CREATE TYPE "FaqVisibility" AS ENUM ('public', 'private');

-- CreateEnum
CREATE TYPE "WhatsAppThreadStatus" AS ENUM ('open', 'pending', 'resolved', 'escalated');

-- CreateEnum
CREATE TYPE "CrawlJobStatus" AS ENUM ('pending', 'running', 'succeeded', 'partial', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('trialing', 'active', 'past_due', 'cancelled', 'free', 'paused');

-- CreateEnum
CREATE TYPE "ContactSource" AS ENUM ('manual', 'csv', 'inbox_auto', 'import', 'phone_sync');

-- CreateEnum
CREATE TYPE "BroadcastStatus" AS ENUM ('draft', 'scheduled', 'sending', 'paused', 'completed', 'cancelled', 'failed');

-- CreateEnum
CREATE TYPE "BroadcastAudienceKind" AS ENUM ('csv', 'segment', 'manual', 'tags');

-- CreateEnum
CREATE TYPE "BroadcastVariant" AS ENUM ('A', 'B');

-- CreateEnum
CREATE TYPE "RecipientStatus" AS ENUM ('pending', 'queued', 'sent', 'delivered', 'read', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "BroadcastEventKind" AS ENUM ('created', 'scheduled', 'started', 'paused', 'resumed', 'cancelled', 'completed', 'failed', 'recipient_failed_burst');

-- CreateEnum
CREATE TYPE "WalletLedgerKind" AS ENUM ('topup', 'adjust', 'hold', 'settle', 'release');

-- CreateEnum
CREATE TYPE "SequenceEnrollmentStatus" AS ENUM ('active', 'paused', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "VoiceCallOutcome" AS ENUM ('in_progress', 'completed', 'handoff', 'dropped');

-- CreateEnum
CREATE TYPE "SalesScanStatus" AS ENUM ('pending', 'linking', 'active', 'completed', 'revoked', 'expired', 'failed');

-- CreateEnum
CREATE TYPE "SalesMessageDirection" AS ENUM ('in', 'out');

-- CreateEnum
CREATE TYPE "ContactSyncStatus" AS ENUM ('pending', 'opened', 'review', 'importing', 'completed', 'expired', 'failed');

-- CreateEnum
CREATE TYPE "ContactSyncItemStatus" AS ENUM ('included', 'excluded', 'applied', 'failed');

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" CITEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "OrgStatus" NOT NULL DEFAULT 'active',
    "ai_plan" "AiPlan" NOT NULL DEFAULT 'basic',
    "monthly_ai_message_cap" INTEGER DEFAULT 2000,
    "disabled_features" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "monthly_paid_usd" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" CITEXT NOT NULL,
    "email_verified_at" TIMESTAMP(3),
    "password_hash" TEXT NOT NULL,
    "first_name" TEXT,
    "last_name" TEXT,
    "avatar_url" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'pending',
    "is_super_admin" BOOLEAN NOT NULL DEFAULT false,
    "email_verification_token_hash" TEXT,
    "email_verification_expires_at" TIMESTAMP(3),
    "password_reset_token_hash" TEXT,
    "password_reset_expires_at" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "totp_enabled" BOOLEAN NOT NULL DEFAULT false,
    "totp_secret" TEXT,
    "totp_enrolled_at" TIMESTAMP(3),
    "recovery_codes_hashed" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dashboard_layout" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "OrgRole" NOT NULL DEFAULT 'viewer',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_protected" BOOLEAN NOT NULL DEFAULT false,
    "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "page_access" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "organization_id" UUID,
    "refresh_token_hash" TEXT NOT NULL,
    "previous_token_hash" TEXT,
    "previous_token_rotated_at" TIMESTAMP(3),
    "is_impersonation" BOOLEAN NOT NULL DEFAULT false,
    "user_agent" TEXT,
    "ip_address" INET,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "role" "OrgRole" NOT NULL DEFAULT 'viewer',
    "page_access" JSONB,
    "token_hash" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'pending',
    "invited_by_id" UUID NOT NULL,
    "accepted_by_id" UUID,
    "accepted_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "last_used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID,
    "actor_user_id" UUID,
    "action" "AuditAction" NOT NULL,
    "entity_type" TEXT,
    "entity_id" UUID,
    "metadata" JSONB,
    "ip_address" INET,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "prev_hash" TEXT,
    "hash" TEXT,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "kind" "AssetKind" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "checksum_sha256" TEXT,
    "uploaded_by_id" UUID,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "parent_id" UUID,
    "name" TEXT NOT NULL,
    "slug" CITEXT NOT NULL,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "category_id" UUID,
    "sku" CITEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" CITEXT NOT NULL,
    "description" TEXT,
    "short_description" TEXT,
    "price_minor" INTEGER,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "compare_at_minor" INTEGER,
    "is_available" BOOLEAN NOT NULL DEFAULT true,
    "stock_quantity" INTEGER,
    "track_inventory" BOOLEAN NOT NULL DEFAULT false,
    "attributes" JSONB,
    "search_text" TEXT,
    "embedding" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[],
    "embedding_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "sku" CITEXT NOT NULL,
    "name" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "price_minor" INTEGER,
    "stock_quantity" INTEGER,
    "is_available" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_images" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "alt_text" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "meta_media_id" TEXT,
    "meta_media_id_uploaded_at" TIMESTAMP(3),
    "meta_media_id_channel_id" UUID,

    CONSTRAINT "product_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "services" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "category_id" UUID,
    "slug" CITEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "short_description" TEXT,
    "duration_minutes" INTEGER,
    "base_price_minor" INTEGER,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "price_unit" "PriceUnit" NOT NULL DEFAULT 'flat',
    "is_available" BOOLEAN NOT NULL DEFAULT true,
    "booking_rules" JSONB,
    "search_text" TEXT,
    "embedding" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[],
    "embedding_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_pricing_tiers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price_minor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "price_unit" "PriceUnit" NOT NULL DEFAULT 'flat',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_pricing_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "availability_windows" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "day_of_week" "DayOfWeek" NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,
    "effective_from" TIMESTAMP(3),
    "effective_until" TIMESTAMP(3),

    CONSTRAINT "availability_windows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_info" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "legal_name" TEXT,
    "tagline" TEXT,
    "about" TEXT,
    "website_url" TEXT,
    "operating_hours" JSONB,
    "hours_exceptions" JSONB,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "metadata" JSONB,
    "booking_form" JSONB,
    "shop_form" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_info_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address_line1" TEXT,
    "address_line2" TEXT,
    "city" TEXT,
    "region" TEXT,
    "postal_code" TEXT,
    "country" CHAR(2),
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "phone" TEXT,
    "email" CITEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_channels" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT,
    "value" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "faqs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "visibility" "FaqVisibility" NOT NULL DEFAULT 'public',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_published" BOOLEAN NOT NULL DEFAULT true,
    "search_text" TEXT,
    "embedding" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[],
    "embedding_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "faqs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "is_published" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "entity_kind" "ImportEntityKind" NOT NULL,
    "status" "ImportJobStatus" NOT NULL DEFAULT 'pending',
    "source_asset_id" UUID,
    "source_filename" TEXT,
    "column_mapping" JSONB,
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "processed_rows" INTEGER NOT NULL DEFAULT 0,
    "succeeded_rows" INTEGER NOT NULL DEFAULT 0,
    "failed_rows" INTEGER NOT NULL DEFAULT 0,
    "skipped_rows" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "error_message" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_job_rows" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "import_job_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "status" "ImportRowStatus" NOT NULL,
    "result_entity_id" UUID,
    "raw_data" JSONB,
    "errors" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_job_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_connectors" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "entity_kind" "ImportEntityKind" NOT NULL,
    "endpoint_url" TEXT,
    "auth_kind" "ConnectorAuthKind" NOT NULL DEFAULT 'none',
    "auth_config" JSONB,
    "schedule_cron" TEXT,
    "column_mapping" JSONB,
    "webhook_secret" TEXT,
    "status" "ConnectorStatus" NOT NULL DEFAULT 'active',
    "last_run_at" TIMESTAMP(3),
    "last_success_at" TIMESTAMP(3),
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_connectors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "trigger" "SyncTrigger" NOT NULL,
    "status" "SyncRunStatus" NOT NULL DEFAULT 'pending',
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "records_fetched" INTEGER NOT NULL DEFAULT 0,
    "records_upserted" INTEGER NOT NULL DEFAULT 0,
    "records_failed" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopify_connections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "store_domain" TEXT NOT NULL,
    "credentials" TEXT,
    "status" "ShopifyConnectionStatus" NOT NULL DEFAULT 'active',
    "shop_name" TEXT,
    "shop_currency" TEXT,
    "last_verify_status" TEXT,
    "auto_sync_enabled" BOOLEAN NOT NULL DEFAULT true,
    "schedule_cron" TEXT,
    "webhook_registered_at" TIMESTAMP(3),
    "last_scrape_at" TIMESTAMP(3),
    "last_success_at" TIMESTAMP(3),
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shopify_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopify_scrape_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'scrape',
    "trigger" "SyncTrigger" NOT NULL,
    "status" "SyncRunStatus" NOT NULL DEFAULT 'pending',
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "products_found" INTEGER NOT NULL DEFAULT 0,
    "contacts_found" INTEGER NOT NULL DEFAULT 0,
    "other_found" INTEGER NOT NULL DEFAULT 0,
    "records_imported" INTEGER NOT NULL DEFAULT 0,
    "records_failed" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shopify_scrape_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopify_staged_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "scrape_run_id" UUID,
    "section" "ShopifyStagedSection" NOT NULL,
    "external_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "normalized" JSONB NOT NULL,
    "raw" JSONB,
    "status" "ShopifyStagedStatus" NOT NULL DEFAULT 'pending',
    "result_entity_id" TEXT,
    "error_message" TEXT,
    "imported_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shopify_staged_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "event_kinds" "WebhookEventKind"[] DEFAULT ARRAY[]::"WebhookEventKind"[],
    "signing_secret" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "last_delivery_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "event_kind" "WebhookEventKind" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "response_status" INTEGER,
    "response_body" TEXT,
    "response_headers" JSONB,
    "scheduled_for" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempted_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_revisions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "entity_type" "RevisionEntityType" NOT NULL,
    "entity_id" UUID NOT NULL,
    "action" "RevisionAction" NOT NULL,
    "snapshot" JSONB NOT NULL,
    "summary" TEXT,
    "actor_user_id" UUID,
    "version_number" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "target_user_id" UUID,
    "kind" "NotificationKind" NOT NULL,
    "severity" "NotificationSeverity" NOT NULL DEFAULT 'info',
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "entity_type" TEXT,
    "entity_id" UUID,
    "metadata" JSONB,
    "read_at" TIMESTAMP(3),
    "read_by_user_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_channels" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT true,
    "label" TEXT,
    "waba_id" TEXT,
    "phone_number_id" TEXT,
    "display_phone_number" TEXT,
    "app_id" TEXT,
    "access_token" TEXT,
    "app_secret" TEXT,
    "webhook_verify_token" TEXT NOT NULL,
    "greeting_message" TEXT,
    "business_name" TEXT,
    "business_about" TEXT,
    "business_address" TEXT,
    "business_email" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "bot_enabled" BOOLEAN NOT NULL DEFAULT false,
    "last_verified_at" TIMESTAMP(3),
    "last_verify_status" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messenger_channels" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "page_id" TEXT,
    "page_name" TEXT,
    "ig_account_id" TEXT,
    "page_access_token" TEXT,
    "app_secret" TEXT,
    "webhook_verify_token" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "last_verify_status" TEXT,
    "last_verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "messenger_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "thread_id" UUID,
    "direction" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'whatsapp',
    "meta_message_id" TEXT,
    "from_number" TEXT,
    "to_number" TEXT,
    "message_type" TEXT,
    "body" TEXT,
    "meta_status" TEXT,
    "meta_status_at" TIMESTAMP(3),
    "media_asset_id" UUID,
    "duration_seconds" INTEGER,
    "raw_payload" JSONB,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meta_webhook_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "field" TEXT NOT NULL,
    "phone_number_id" TEXT,
    "waba_id" TEXT,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "resolved_organization_id" UUID,

    CONSTRAINT "meta_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_threads" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'whatsapp',
    "channel_user_id" TEXT,
    "whatsapp_channel_id" UUID,
    "customer_phone" TEXT NOT NULL,
    "customer_name" TEXT,
    "customer_whatsapp_name" TEXT,
    "status" "WhatsAppThreadStatus" NOT NULL DEFAULT 'open',
    "flow_state" JSONB,
    "assigned_to_user_id" UUID,
    "required_skill" TEXT,
    "bot_reply_mode" TEXT,
    "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_message_preview" TEXT,
    "inbound_count" INTEGER NOT NULL DEFAULT 0,
    "outbound_count" INTEGER NOT NULL DEFAULT 0,
    "last_inbound_at" TIMESTAMP(3),
    "awaiting_feedback_at" TIMESTAMP(3),
    "last_read_at" TIMESTAMP(3),
    "follow_up_stage" SMALLINT NOT NULL DEFAULT 0,
    "follow_up_last_sent_at" TIMESTAMP(3),
    "handset_replied_at" TIMESTAMP(3),
    "search_text" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_feedback" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "contact_id" UUID,
    "channel" TEXT NOT NULL DEFAULT 'whatsapp',
    "handler_mix" TEXT NOT NULL,
    "ai_message_count" INTEGER NOT NULL DEFAULT 0,
    "human_message_count" INTEGER NOT NULL DEFAULT 0,
    "rating" INTEGER,
    "comment" TEXT,
    "asked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_watches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "product_id" UUID,
    "service_id" UUID,
    "contact_id" UUID NOT NULL,
    "thread_id" UUID,
    "inquiry_text" TEXT,
    "source" TEXT NOT NULL DEFAULT 'bot_auto',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notified_at" TIMESTAMP(3),

    CONSTRAINT "stock_watches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "thread_id" UUID,
    "channel" TEXT NOT NULL DEFAULT 'whatsapp',
    "call_uuid" TEXT,
    "customer_phone" TEXT NOT NULL,
    "customer_name" TEXT,
    "fields" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'new',
    "notes" TEXT,
    "appointment_at" TIMESTAMP(3),
    "reminder_template_id" UUID,
    "reminder_sent_at" TIMESTAMP(3),
    "follow_up_sent_at" TIMESTAMP(3),
    "google_event_id" TEXT,
    "google_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "google_calendar_connections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "google_email" TEXT,
    "calendar_id" TEXT NOT NULL DEFAULT 'primary',
    "access_token" TEXT,
    "refresh_token" TEXT NOT NULL,
    "token_expires_at" TIMESTAMP(3),
    "push_bookings" BOOLEAN NOT NULL DEFAULT true,
    "meeting_mode" TEXT NOT NULL DEFAULT 'onsite',
    "auto_confirm" BOOLEAN NOT NULL DEFAULT true,
    "block_on_busy" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "google_calendar_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "thread_id" UUID,
    "channel" TEXT NOT NULL DEFAULT 'whatsapp',
    "phone_integration_id" UUID,
    "call_uuid" TEXT,
    "customer_phone" TEXT NOT NULL,
    "customer_name" TEXT,
    "fields" JSONB NOT NULL DEFAULT '[]',
    "subtotal_minor" BIGINT NOT NULL DEFAULT 0,
    "delivery_minor" BIGINT NOT NULL DEFAULT 0,
    "total_minor" BIGINT NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL DEFAULT 'new',
    "notes" TEXT,
    "items_count" INTEGER NOT NULL DEFAULT 0,
    "payment_provider" TEXT,
    "payment_ref" TEXT,
    "payment_status" TEXT,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "carts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "cart_id" UUID NOT NULL,
    "product_id" UUID,
    "service_id" UUID,
    "variant_id" UUID,
    "sku" TEXT,
    "name" TEXT NOT NULL,
    "variant_label" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_price_minor" BIGINT NOT NULL,
    "line_total_minor" BIGINT NOT NULL,
    "needs_pricing" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cart_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_thread_tags" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "tag" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_thread_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_notes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "author_user_id" UUID,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canned_responses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "shortcut" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "canned_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en_US',
    "category" TEXT NOT NULL,
    "body_text" TEXT NOT NULL,
    "components" JSONB,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "rejection_reason" TEXT,
    "meta_template_id" TEXT,
    "header_media_storage_key" TEXT,
    "header_media_type" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_configs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "personality" TEXT,
    "custom_personality" TEXT,
    "admin_system_prompt_append" TEXT,
    "detected_tone" TEXT,
    "greeting" TEXT,
    "greet_by_name" BOOLEAN NOT NULL DEFAULT false,
    "quick_replies_enabled" BOOLEAN NOT NULL DEFAULT true,
    "custom_buttons" JSONB,
    "feedback" JSONB,
    "languages" TEXT NOT NULL DEFAULT 'en',
    "escalation_rules" JSONB,
    "conversation_flow" JSONB,
    "response_templates" JSONB,
    "scripted_flow" JSONB,
    "follow_ups" JSONB,
    "deployed_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "reply_mode" TEXT NOT NULL DEFAULT 'text',
    "tts_provider" TEXT NOT NULL DEFAULT 'google',
    "tts_voice_name" TEXT,
    "greeting_image_storage_key" TEXT,
    "greeting_voice_storage_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crawl_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "root_url" TEXT NOT NULL,
    "status" "CrawlJobStatus" NOT NULL DEFAULT 'pending',
    "max_pages" INTEGER NOT NULL DEFAULT 30,
    "max_depth" INTEGER NOT NULL DEFAULT 2,
    "pages_crawled" INTEGER NOT NULL DEFAULT 0,
    "pages_failed" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crawl_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crawl_pages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "crawl_job_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "body_text" TEXT,
    "fetch_status" INTEGER,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crawl_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_base_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "source_url" TEXT,
    "source_type" TEXT NOT NULL DEFAULT 'ai',
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "search_text" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_base_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_test_scenarios" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "expectation" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'ai_generated',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_test_scenarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_conversation_flow_options" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "flow" JSONB NOT NULL,
    "is_recommended" BOOLEAN NOT NULL DEFAULT false,
    "recommend_reason" TEXT,
    "is_selected" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_conversation_flow_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_test_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "scenario_key" TEXT NOT NULL,
    "scenario_prompt" TEXT NOT NULL,
    "bot_response" TEXT NOT NULL,
    "score" INTEGER,
    "judge_notes" TEXT,
    "override_score" INTEGER,
    "override_notes" TEXT,
    "override_by_user_id" UUID,
    "override_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_test_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_simulation_turns" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "session_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_simulation_turns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "product_cap" INTEGER,
    "service_cap" INTEGER,
    "member_cap" INTEGER,
    "monthly_message_cap" INTEGER,
    "monthly_import_cap" INTEGER,
    "monthly_broadcast_cap" INTEGER,
    "api_key_cap" INTEGER,
    "webhook_cap" INTEGER,
    "price_monthly_minor" INTEGER,
    "price_yearly_minor" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "stripe_price_monthly_id" TEXT,
    "stripe_price_yearly_id" TEXT,
    "description" TEXT,
    "highlights" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sort_order" INTEGER NOT NULL DEFAULT 100,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'trialing',
    "stripe_customer_id" TEXT,
    "stripe_subscription_id" TEXT,
    "trial_ends_at" TIMESTAMP(3),
    "current_period_end" TIMESTAMP(3),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_monthly" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "year_month" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "notified_thresholds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_monthly_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branding_configs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "logo_asset_id" UUID,
    "accent_color" TEXT,
    "custom_cname" TEXT,
    "cname_status" TEXT,
    "cname_verified_at" TIMESTAMP(3),
    "cname_last_check_at" TIMESTAMP(3),
    "cname_error" TEXT,
    "footer_text" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branding_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_exports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "sections" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "format" TEXT NOT NULL DEFAULT 'csv',
    "layout" TEXT NOT NULL DEFAULT 'combined',
    "storage_key" TEXT,
    "file_size_bytes" INTEGER,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_exports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meta_onboarding_steps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "step_key" TEXT NOT NULL,
    "completed_at" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "meta_onboarding_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "email" TEXT,
    "display_name" TEXT,
    "whatsapp_name" TEXT,
    "locale" TEXT,
    "opted_in_at" TIMESTAMP(3),
    "opted_out_at" TIMESTAMP(3),
    "blocked_at" TIMESTAMP(3),
    "timezone" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'whatsapp',
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "source" "ContactSource" NOT NULL DEFAULT 'manual',
    "synced_from_label" TEXT,
    "external_ref" TEXT,
    "synced_from_session_id" UUID,
    "whatsapp_reachable" BOOLEAN,
    "last_inbound_at" TIMESTAMP(3),
    "last_outbound_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_tags" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "tag" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_memory" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "persona" TEXT,
    "facts" JSONB NOT NULL DEFAULT '{}',
    "language" TEXT,
    "operator_note" TEXT,
    "operator_note_at" TIMESTAMP(3),
    "turns_summarized" INTEGER NOT NULL DEFAULT 0,
    "last_summary_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_memory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "segments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "filter" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broadcasts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "BroadcastStatus" NOT NULL DEFAULT 'draft',
    "channel_id" UUID NOT NULL,
    "channel_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "audience_kind" "BroadcastAudienceKind" NOT NULL,
    "csv_asset_id" UUID,
    "segment_id" UUID,
    "audience_tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "audience_tags_mode" TEXT NOT NULL DEFAULT 'any',
    "include_opted_out" BOOLEAN NOT NULL DEFAULT false,
    "ab_test" BOOLEAN NOT NULL DEFAULT false,
    "variant_a_template_id" UUID NOT NULL,
    "variant_b_template_id" UUID,
    "variant_a_variables" JSONB NOT NULL DEFAULT '{}',
    "variant_b_variables" JSONB,
    "scheduled_for" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "batch_size" INTEGER NOT NULL DEFAULT 0,
    "batch_interval_minutes" INTEGER NOT NULL DEFAULT 0,
    "send_window_start_hour" INTEGER,
    "send_window_end_hour" INTEGER,
    "send_window_timezone" TEXT,
    "ab_winner_strategy" TEXT,
    "ab_winner_variant" "BroadcastVariant",
    "ab_winner_decided_at" TIMESTAMP(3),
    "total_recipients" INTEGER NOT NULL DEFAULT 0,
    "queued_count" INTEGER NOT NULL DEFAULT 0,
    "sent_count" INTEGER NOT NULL DEFAULT 0,
    "delivered_count" INTEGER NOT NULL DEFAULT 0,
    "read_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "responded_count" INTEGER NOT NULL DEFAULT 0,
    "billing_unit_price_micros" BIGINT,
    "billing_meta_cost_micros" BIGINT,
    "billing_held_micros" BIGINT NOT NULL DEFAULT 0,
    "billing_settled_micros" BIGINT NOT NULL DEFAULT 0,
    "billing_released" BOOLEAN NOT NULL DEFAULT false,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "broadcasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broadcast_recipients" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "broadcast_id" UUID NOT NULL,
    "contact_id" UUID,
    "whatsapp_channel_id" UUID,
    "phone_e164" TEXT NOT NULL,
    "variant" "BroadcastVariant" NOT NULL DEFAULT 'A',
    "variables" JSONB NOT NULL DEFAULT '{}',
    "status" "RecipientStatus" NOT NULL DEFAULT 'pending',
    "meta_message_id" TEXT,
    "meta_error_code" TEXT,
    "meta_error_message" TEXT,
    "queued_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "read_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "responded_at" TIMESTAMP(3),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "billed_at" TIMESTAMP(3),
    "refunded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broadcast_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_wallets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "available_micros" BIGINT NOT NULL DEFAULT 0,
    "held_micros" BIGINT NOT NULL DEFAULT 0,
    "price_per_message_micros" BIGINT NOT NULL DEFAULT 80000,
    "metering_enabled" BOOLEAN NOT NULL DEFAULT false,
    "low_balance_threshold_micros" BIGINT NOT NULL DEFAULT 0,
    "alert_thresholds" INTEGER[] DEFAULT ARRAY[80, 100]::INTEGER[],
    "alert_baseline_micros" BIGINT NOT NULL DEFAULT 0,
    "meta_cost_micros" BIGINT NOT NULL DEFAULT 37500,
    "lifetime_topped_up_micros" BIGINT NOT NULL DEFAULT 0,
    "lifetime_spent_micros" BIGINT NOT NULL DEFAULT 0,
    "lifetime_messages" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_ledger" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "kind" "WalletLedgerKind" NOT NULL,
    "amount_micros" BIGINT NOT NULL,
    "available_after_micros" BIGINT NOT NULL,
    "held_after_micros" BIGINT NOT NULL,
    "broadcast_id" UUID,
    "recipient_id" UUID,
    "unit_price_micros" BIGINT,
    "meta_cost_micros" BIGINT,
    "note" TEXT,
    "actor_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broadcast_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "broadcast_id" UUID NOT NULL,
    "kind" "BroadcastEventKind" NOT NULL,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broadcast_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sequences" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "channel_id" UUID NOT NULL,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sequence_steps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "sequence_id" UUID NOT NULL,
    "step_order" INTEGER NOT NULL,
    "template_id" UUID NOT NULL,
    "delay_hours" INTEGER NOT NULL DEFAULT 0,
    "variables" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sequence_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sequence_enrollments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "sequence_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "status" "SequenceEnrollmentStatus" NOT NULL DEFAULT 'active',
    "next_step_index" INTEGER NOT NULL DEFAULT 0,
    "next_step_due_at" TIMESTAMP(3),
    "enrolled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),

    CONSTRAINT "sequence_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_prompt_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_prompt_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_provenances" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "system_prompt_snapshot_id" UUID NOT NULL,
    "user_prompt" TEXT NOT NULL,
    "history_json" JSONB NOT NULL,
    "candidate_product_ids" UUID[],
    "candidate_service_ids" UUID[],
    "candidate_faq_ids" UUID[],
    "candidate_policy_kinds" TEXT[],
    "business_info_fields" TEXT[],
    "citations" JSONB,
    "hallucinations" JSONB,
    "pipeline_timings" JSONB,
    "model" TEXT NOT NULL,
    "temperature" DOUBLE PRECISION NOT NULL,
    "prompt_tokens" INTEGER NOT NULL,
    "cache_read_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_write_tokens" INTEGER NOT NULL DEFAULT 0,
    "completion_tokens" INTEGER NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "block_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_provenances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provenance_suppressions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID,
    "phrase" TEXT NOT NULL,
    "note" TEXT,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "matches_count" INTEGER NOT NULL DEFAULT 0,
    "last_matched_at" TIMESTAMP(3),

    CONSTRAINT "provenance_suppressions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provenance_flag_decisions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "provenance_id" UUID NOT NULL,
    "flag_index" INTEGER NOT NULL,
    "flagged_text" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "decided_by_user_id" UUID,
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "provenance_flag_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_calls" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "call_uuid" TEXT NOT NULL,
    "caller_id" TEXT,
    "caller_phone_normalized" TEXT,
    "contact_id" UUID,
    "dialed_exten" TEXT,
    "outcome" "VoiceCallOutcome" NOT NULL DEFAULT 'in_progress',
    "handoff_reason" TEXT,
    "phone_integration_id" UUID,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voice_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_configs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'none',
    "static_link_url" TEXT,
    "bank_details" TEXT,
    "test_mode" BOOLEAN NOT NULL DEFAULT true,
    "credentials" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "phone_integrations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone_number" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "bot_enabled" BOOLEAN NOT NULL DEFAULT true,
    "api_key_id" UUID,
    "last_call_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "phone_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_call_turns" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "voice_call_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voice_call_turns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "trigger" TEXT NOT NULL DEFAULT 'cli',
    "mode" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "passed" BOOLEAN NOT NULL,
    "tenant_count" INTEGER NOT NULL,
    "passed_count" INTEGER NOT NULL,
    "summaries" JSONB NOT NULL,
    "git_sha" TEXT,
    "note" TEXT,
    "duration_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eval_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_scan_grants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "status" "SalesScanStatus" NOT NULL DEFAULT 'pending',
    "phone_e164" TEXT,
    "window_days" INTEGER NOT NULL DEFAULT 7,
    "consent_version" TEXT NOT NULL,
    "consent_text" TEXT NOT NULL,
    "consent_text_sha256" TEXT NOT NULL,
    "granted_by_user_id" UUID,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grant_expires_at" TIMESTAMP(3) NOT NULL,
    "linked_at" TIMESTAMP(3),
    "capture_ends_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "end_reason" TEXT,
    "auth_purged_at" TIMESTAMP(3),
    "ingest_session_id" TEXT,
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_scan_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "grant_id" UUID NOT NULL,
    "wa_msg_id" TEXT NOT NULL,
    "counterparty_hash" TEXT NOT NULL,
    "counterparty_phone_enc" TEXT,
    "direction" "SalesMessageDirection" NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'text',
    "body" TEXT,
    "is_group" BOOLEAN NOT NULL DEFAULT false,
    "chat_name" TEXT,
    "sent_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_scan_summaries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "grant_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "model" TEXT,
    "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_read_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_write_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_micros" BIGINT NOT NULL DEFAULT 0,
    "messages_analyzed" INTEGER NOT NULL DEFAULT 0,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_scan_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_sync_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "status" "ContactSyncStatus" NOT NULL DEFAULT 'pending',
    "token_sha256" TEXT NOT NULL,
    "device_kind" TEXT NOT NULL,
    "wa_qr" TEXT,
    "wa_phone" TEXT,
    "synced_by_label" TEXT,
    "default_dial_code" TEXT,
    "marketing_attested_at" TIMESTAMP(3),
    "marketing_attest_text" TEXT,
    "created_by_user_id" UUID,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "opened_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "failure_reason" TEXT,
    "imported_at" TIMESTAMP(3),
    "review_mode" BOOLEAN NOT NULL DEFAULT false,
    "staged_at" TIMESTAMP(3),
    "reverted_at" TIMESTAMP(3),
    "reverted_by_user_id" UUID,
    "contacts_received" INTEGER NOT NULL DEFAULT 0,
    "contacts_created" INTEGER NOT NULL DEFAULT 0,
    "contacts_updated" INTEGER NOT NULL DEFAULT 0,
    "contacts_skipped" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_sync_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "fcm_token" TEXT NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_sync_staged_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "display_name" TEXT,
    "email" TEXT,
    "company" TEXT,
    "status" "ContactSyncItemStatus" NOT NULL DEFAULT 'included',
    "existing_contact_id" TEXT,
    "effect" TEXT,
    "contact_id" UUID,
    "filled_display_name" TEXT,
    "filled_email" TEXT,
    "error_message" TEXT,
    "applied_at" TIMESTAMP(3),
    "reverted_at" TIMESTAMP(3),
    "revert_outcome" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_sync_staged_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "organizations_status_idx" ON "organizations"("status");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "memberships_user_id_idx" ON "memberships"("user_id");

-- CreateIndex
CREATE INDEX "memberships_organization_id_role_idx" ON "memberships"("organization_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_organization_id_user_id_key" ON "memberships"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refresh_token_hash_key" ON "sessions"("refresh_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_previous_token_hash_key" ON "sessions"("previous_token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE INDEX "invitations_status_expires_at_idx" ON "invitations"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_organization_id_email_key" ON "invitations"("organization_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_prefix_key" ON "api_keys"("prefix");

-- CreateIndex
CREATE INDEX "api_keys_organization_id_idx" ON "api_keys"("organization_id");

-- CreateIndex
CREATE INDEX "api_keys_revoked_at_idx" ON "api_keys"("revoked_at");

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_created_at_idx" ON "audit_logs"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_created_at_idx" ON "audit_logs"("actor_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "assets_storage_key_key" ON "assets"("storage_key");

-- CreateIndex
CREATE INDEX "assets_organization_id_kind_created_at_idx" ON "assets"("organization_id", "kind", "created_at" DESC);

-- CreateIndex
CREATE INDEX "categories_organization_id_parent_id_sort_order_idx" ON "categories"("organization_id", "parent_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "categories_organization_id_slug_key" ON "categories"("organization_id", "slug");

-- CreateIndex
CREATE INDEX "products_organization_id_is_available_created_at_idx" ON "products"("organization_id", "is_available", "created_at" DESC);

-- CreateIndex
CREATE INDEX "products_organization_id_category_id_idx" ON "products"("organization_id", "category_id");

-- CreateIndex
CREATE INDEX "products_organization_id_deleted_at_idx" ON "products"("organization_id", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "products_organization_id_sku_key" ON "products"("organization_id", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "products_organization_id_slug_key" ON "products"("organization_id", "slug");

-- CreateIndex
CREATE INDEX "product_variants_product_id_sort_order_idx" ON "product_variants"("product_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_organization_id_sku_key" ON "product_variants"("organization_id", "sku");

-- CreateIndex
CREATE INDEX "product_images_product_id_sort_order_idx" ON "product_images"("product_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "product_images_product_id_asset_id_key" ON "product_images"("product_id", "asset_id");

-- CreateIndex
CREATE INDEX "services_organization_id_is_available_created_at_idx" ON "services"("organization_id", "is_available", "created_at" DESC);

-- CreateIndex
CREATE INDEX "services_organization_id_category_id_idx" ON "services"("organization_id", "category_id");

-- CreateIndex
CREATE INDEX "services_organization_id_deleted_at_idx" ON "services"("organization_id", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "services_organization_id_slug_key" ON "services"("organization_id", "slug");

-- CreateIndex
CREATE INDEX "service_pricing_tiers_service_id_sort_order_idx" ON "service_pricing_tiers"("service_id", "sort_order");

-- CreateIndex
CREATE INDEX "availability_windows_service_id_day_of_week_idx" ON "availability_windows"("service_id", "day_of_week");

-- CreateIndex
CREATE UNIQUE INDEX "business_info_organization_id_key" ON "business_info"("organization_id");

-- CreateIndex
CREATE INDEX "locations_organization_id_sort_order_idx" ON "locations"("organization_id", "sort_order");

-- CreateIndex
CREATE INDEX "contact_channels_organization_id_sort_order_idx" ON "contact_channels"("organization_id", "sort_order");

-- CreateIndex
CREATE INDEX "faqs_organization_id_is_published_sort_order_idx" ON "faqs"("organization_id", "is_published", "sort_order");

-- CreateIndex
CREATE INDEX "policies_organization_id_sort_order_idx" ON "policies"("organization_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "policies_organization_id_kind_key" ON "policies"("organization_id", "kind");

-- CreateIndex
CREATE INDEX "import_jobs_organization_id_created_at_idx" ON "import_jobs"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "import_jobs_status_created_at_idx" ON "import_jobs"("status", "created_at");

-- CreateIndex
CREATE INDEX "import_job_rows_import_job_id_status_idx" ON "import_job_rows"("import_job_id", "status");

-- CreateIndex
CREATE INDEX "import_job_rows_import_job_id_row_number_idx" ON "import_job_rows"("import_job_id", "row_number");

-- CreateIndex
CREATE INDEX "api_connectors_organization_id_status_idx" ON "api_connectors"("organization_id", "status");

-- CreateIndex
CREATE INDEX "sync_runs_connector_id_created_at_idx" ON "sync_runs"("connector_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "sync_runs_organization_id_status_created_at_idx" ON "sync_runs"("organization_id", "status", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "shopify_connections_organization_id_key" ON "shopify_connections"("organization_id");

-- CreateIndex
CREATE INDEX "shopify_scrape_runs_connection_id_created_at_idx" ON "shopify_scrape_runs"("connection_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "shopify_scrape_runs_organization_id_status_created_at_idx" ON "shopify_scrape_runs"("organization_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "shopify_staged_items_organization_id_section_status_idx" ON "shopify_staged_items"("organization_id", "section", "status");

-- CreateIndex
CREATE UNIQUE INDEX "shopify_staged_items_organization_id_section_external_id_key" ON "shopify_staged_items"("organization_id", "section", "external_id");

-- CreateIndex
CREATE INDEX "webhook_endpoints_organization_id_is_active_idx" ON "webhook_endpoints"("organization_id", "is_active");

-- CreateIndex
CREATE INDEX "webhook_deliveries_endpoint_id_created_at_idx" ON "webhook_deliveries"("endpoint_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_scheduled_for_idx" ON "webhook_deliveries"("status", "scheduled_for");

-- CreateIndex
CREATE INDEX "catalog_revisions_organization_id_entity_type_entity_id_cre_idx" ON "catalog_revisions"("organization_id", "entity_type", "entity_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "catalog_revisions_organization_id_created_at_idx" ON "catalog_revisions"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "catalog_revisions_entity_type_entity_id_version_number_key" ON "catalog_revisions"("entity_type", "entity_id", "version_number");

-- CreateIndex
CREATE INDEX "notifications_organization_id_created_at_idx" ON "notifications"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notifications_organization_id_target_user_id_created_at_idx" ON "notifications"("organization_id", "target_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "whatsapp_channels_organization_id_idx" ON "whatsapp_channels"("organization_id");

-- CreateIndex
CREATE INDEX "whatsapp_channels_waba_id_idx" ON "whatsapp_channels"("waba_id");

-- CreateIndex
CREATE UNIQUE INDEX "messenger_channels_organization_id_key" ON "messenger_channels"("organization_id");

-- CreateIndex
CREATE INDEX "whatsapp_messages_organization_id_received_at_idx" ON "whatsapp_messages"("organization_id", "received_at" DESC);

-- CreateIndex
CREATE INDEX "whatsapp_messages_thread_id_received_at_idx" ON "whatsapp_messages"("thread_id", "received_at" ASC);

-- CreateIndex
CREATE INDEX "meta_webhook_events_field_received_at_idx" ON "meta_webhook_events"("field", "received_at");

-- CreateIndex
CREATE INDEX "meta_webhook_events_organization_id_received_at_idx" ON "meta_webhook_events"("organization_id", "received_at" DESC);

-- CreateIndex
CREATE INDEX "meta_webhook_events_phone_number_id_resolved_organization_i_idx" ON "meta_webhook_events"("phone_number_id", "resolved_organization_id");

-- CreateIndex
CREATE INDEX "whatsapp_threads_organization_id_whatsapp_channel_id_last_m_idx" ON "whatsapp_threads"("organization_id", "whatsapp_channel_id", "last_message_at" DESC);

-- CreateIndex
CREATE INDEX "whatsapp_threads_organization_id_last_message_at_idx" ON "whatsapp_threads"("organization_id", "last_message_at" DESC);

-- CreateIndex
CREATE INDEX "whatsapp_threads_organization_id_status_last_message_at_idx" ON "whatsapp_threads"("organization_id", "status", "last_message_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "conversation_feedback_thread_id_key" ON "conversation_feedback"("thread_id");

-- CreateIndex
CREATE INDEX "conversation_feedback_organization_id_asked_at_idx" ON "conversation_feedback"("organization_id", "asked_at");

-- CreateIndex
CREATE INDEX "conversation_feedback_organization_id_contact_id_asked_at_idx" ON "conversation_feedback"("organization_id", "contact_id", "asked_at");

-- CreateIndex
CREATE INDEX "stock_watches_organization_id_notified_at_idx" ON "stock_watches"("organization_id", "notified_at");

-- CreateIndex
CREATE INDEX "bookings_organization_id_status_created_at_idx" ON "bookings"("organization_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "bookings_organization_id_customer_phone_idx" ON "bookings"("organization_id", "customer_phone");

-- CreateIndex
CREATE INDEX "bookings_reminder_due_idx" ON "bookings"("status", "reminder_sent_at", "appointment_at");

-- CreateIndex
CREATE UNIQUE INDEX "google_calendar_connections_organization_id_key" ON "google_calendar_connections"("organization_id");

-- CreateIndex
CREATE INDEX "carts_organization_id_status_created_at_idx" ON "carts"("organization_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "carts_organization_id_customer_phone_idx" ON "carts"("organization_id", "customer_phone");

-- CreateIndex
CREATE INDEX "carts_org_channel_created_idx" ON "carts"("organization_id", "channel", "created_at" DESC);

-- CreateIndex
CREATE INDEX "carts_org_call_uuid_idx" ON "carts"("organization_id", "call_uuid");

-- CreateIndex
CREATE INDEX "carts_organization_id_payment_provider_payment_ref_idx" ON "carts"("organization_id", "payment_provider", "payment_ref");

-- CreateIndex
CREATE INDEX "cart_items_cart_id_idx" ON "cart_items"("cart_id");

-- CreateIndex
CREATE INDEX "whatsapp_thread_tags_organization_id_tag_idx" ON "whatsapp_thread_tags"("organization_id", "tag");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_thread_tags_thread_id_tag_key" ON "whatsapp_thread_tags"("thread_id", "tag");

-- CreateIndex
CREATE INDEX "whatsapp_notes_thread_id_created_at_idx" ON "whatsapp_notes"("thread_id", "created_at" ASC);

-- CreateIndex
CREATE INDEX "canned_responses_organization_id_idx" ON "canned_responses"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "canned_responses_organization_id_shortcut_key" ON "canned_responses"("organization_id", "shortcut");

-- CreateIndex
CREATE INDEX "whatsapp_templates_organization_id_idx" ON "whatsapp_templates"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_templates_organization_id_name_language_key" ON "whatsapp_templates"("organization_id", "name", "language");

-- CreateIndex
CREATE UNIQUE INDEX "bot_configs_organization_id_key" ON "bot_configs"("organization_id");

-- CreateIndex
CREATE INDEX "crawl_jobs_organization_id_created_at_idx" ON "crawl_jobs"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "crawl_pages_crawl_job_id_idx" ON "crawl_pages"("crawl_job_id");

-- CreateIndex
CREATE INDEX "knowledge_base_entries_organization_id_kind_idx" ON "knowledge_base_entries"("organization_id", "kind");

-- CreateIndex
CREATE INDEX "knowledge_base_entries_organization_id_approved_idx" ON "knowledge_base_entries"("organization_id", "approved");

-- CreateIndex
CREATE INDEX "bot_test_scenarios_organization_id_sort_order_idx" ON "bot_test_scenarios"("organization_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "bot_test_scenarios_organization_id_key_key" ON "bot_test_scenarios"("organization_id", "key");

-- CreateIndex
CREATE INDEX "bot_conversation_flow_options_organization_id_is_selected_idx" ON "bot_conversation_flow_options"("organization_id", "is_selected");

-- CreateIndex
CREATE INDEX "bot_test_runs_organization_id_scenario_key_created_at_idx" ON "bot_test_runs"("organization_id", "scenario_key", "created_at" DESC);

-- CreateIndex
CREATE INDEX "bot_simulation_turns_organization_id_session_id_created_at_idx" ON "bot_simulation_turns"("organization_id", "session_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "plans_code_key" ON "plans"("code");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_organization_id_key" ON "subscriptions"("organization_id");

-- CreateIndex
CREATE INDEX "usage_events_organization_id_kind_occurred_at_idx" ON "usage_events"("organization_id", "kind", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "usage_monthly_organization_id_year_month_idx" ON "usage_monthly"("organization_id", "year_month");

-- CreateIndex
CREATE UNIQUE INDEX "usage_monthly_organization_id_year_month_kind_key" ON "usage_monthly"("organization_id", "year_month", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "branding_configs_organization_id_key" ON "branding_configs"("organization_id");

-- CreateIndex
CREATE INDEX "data_exports_organization_id_created_at_idx" ON "data_exports"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "meta_onboarding_steps_organization_id_idx" ON "meta_onboarding_steps"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "meta_onboarding_steps_organization_id_step_key_key" ON "meta_onboarding_steps"("organization_id", "step_key");

-- CreateIndex
CREATE INDEX "contacts_organization_id_created_at_idx" ON "contacts"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "contacts_organization_id_deleted_at_idx" ON "contacts"("organization_id", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_organization_id_phone_e164_key" ON "contacts"("organization_id", "phone_e164");

-- CreateIndex
CREATE INDEX "contact_tags_organization_id_tag_idx" ON "contact_tags"("organization_id", "tag");

-- CreateIndex
CREATE UNIQUE INDEX "contact_tags_contact_id_tag_key" ON "contact_tags"("contact_id", "tag");

-- CreateIndex
CREATE INDEX "contact_memory_organization_id_updated_at_idx" ON "contact_memory"("organization_id", "updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "contact_memory_organization_id_phone_e164_key" ON "contact_memory"("organization_id", "phone_e164");

-- CreateIndex
CREATE INDEX "segments_organization_id_idx" ON "segments"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "segments_organization_id_name_key" ON "segments"("organization_id", "name");

-- CreateIndex
CREATE INDEX "broadcasts_organization_id_created_at_idx" ON "broadcasts"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "broadcasts_organization_id_status_idx" ON "broadcasts"("organization_id", "status");

-- CreateIndex
CREATE INDEX "broadcast_recipients_broadcast_id_status_idx" ON "broadcast_recipients"("broadcast_id", "status");

-- CreateIndex
CREATE INDEX "broadcast_recipients_organization_id_meta_message_id_idx" ON "broadcast_recipients"("organization_id", "meta_message_id");

-- CreateIndex
CREATE INDEX "broadcast_recipients_broadcast_id_created_at_idx" ON "broadcast_recipients"("broadcast_id", "created_at" ASC);

-- CreateIndex
CREATE INDEX "broadcast_recipients_organization_id_phone_e164_sent_at_idx" ON "broadcast_recipients"("organization_id", "phone_e164", "sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_wallets_organization_id_key" ON "tenant_wallets"("organization_id");

-- CreateIndex
CREATE INDEX "wallet_ledger_organization_id_created_at_idx" ON "wallet_ledger"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "wallet_ledger_organization_id_kind_created_at_idx" ON "wallet_ledger"("organization_id", "kind", "created_at");

-- CreateIndex
CREATE INDEX "broadcast_events_broadcast_id_created_at_idx" ON "broadcast_events"("broadcast_id", "created_at" ASC);

-- CreateIndex
CREATE INDEX "sequences_organization_id_idx" ON "sequences"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "sequences_organization_id_name_key" ON "sequences"("organization_id", "name");

-- CreateIndex
CREATE INDEX "sequence_steps_sequence_id_idx" ON "sequence_steps"("sequence_id");

-- CreateIndex
CREATE UNIQUE INDEX "sequence_steps_sequence_id_step_order_key" ON "sequence_steps"("sequence_id", "step_order");

-- CreateIndex
CREATE INDEX "sequence_enrollments_organization_id_status_next_step_due_a_idx" ON "sequence_enrollments"("organization_id", "status", "next_step_due_at");

-- CreateIndex
CREATE UNIQUE INDEX "sequence_enrollments_sequence_id_contact_id_key" ON "sequence_enrollments"("sequence_id", "contact_id");

-- CreateIndex
CREATE INDEX "system_prompt_snapshots_organization_id_created_at_idx" ON "system_prompt_snapshots"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "system_prompt_snapshots_organization_id_sha256_key" ON "system_prompt_snapshots"("organization_id", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "message_provenances_message_id_key" ON "message_provenances"("message_id");

-- CreateIndex
CREATE INDEX "message_provenances_organization_id_created_at_idx" ON "message_provenances"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "message_provenances_system_prompt_snapshot_id_idx" ON "message_provenances"("system_prompt_snapshot_id");

-- CreateIndex
CREATE INDEX "provenance_suppressions_organization_id_created_at_idx" ON "provenance_suppressions"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "provenance_flag_decisions_organization_id_decided_at_idx" ON "provenance_flag_decisions"("organization_id", "decided_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "provenance_flag_decisions_provenance_id_flag_index_key" ON "provenance_flag_decisions"("provenance_id", "flag_index");

-- CreateIndex
CREATE INDEX "voice_calls_organization_id_started_at_idx" ON "voice_calls"("organization_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "voice_calls_phone_integration_id_started_at_idx" ON "voice_calls"("phone_integration_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "voice_calls_org_caller_norm_idx" ON "voice_calls"("organization_id", "caller_phone_normalized", "started_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "voice_calls_organization_id_call_uuid_key" ON "voice_calls"("organization_id", "call_uuid");

-- CreateIndex
CREATE UNIQUE INDEX "payment_configs_organization_id_key" ON "payment_configs"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "phone_integrations_api_key_id_key" ON "phone_integrations"("api_key_id");

-- CreateIndex
CREATE INDEX "phone_integrations_organization_id_is_active_idx" ON "phone_integrations"("organization_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "phone_integrations_phone_number_key" ON "phone_integrations"("phone_number");

-- CreateIndex
CREATE INDEX "voice_call_turns_voice_call_id_at_idx" ON "voice_call_turns"("voice_call_id", "at");

-- CreateIndex
CREATE INDEX "voice_call_turns_organization_id_idx" ON "voice_call_turns"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "voice_call_turns_voice_call_id_seq_key" ON "voice_call_turns"("voice_call_id", "seq");

-- CreateIndex
CREATE INDEX "eval_runs_created_at_idx" ON "eval_runs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "sales_scan_grants_organization_id_status_idx" ON "sales_scan_grants"("organization_id", "status");

-- CreateIndex
CREATE INDEX "sales_scan_grants_organization_id_created_at_idx" ON "sales_scan_grants"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "sales_scan_grants_status_grant_expires_at_idx" ON "sales_scan_grants"("status", "grant_expires_at");

-- CreateIndex
CREATE INDEX "sales_scan_grants_ended_at_auth_purged_at_idx" ON "sales_scan_grants"("ended_at", "auth_purged_at");

-- CreateIndex
CREATE INDEX "sales_messages_organization_id_grant_id_sent_at_idx" ON "sales_messages"("organization_id", "grant_id", "sent_at");

-- CreateIndex
CREATE INDEX "sales_messages_organization_id_counterparty_hash_idx" ON "sales_messages"("organization_id", "counterparty_hash");

-- CreateIndex
CREATE INDEX "sales_messages_organization_id_created_at_idx" ON "sales_messages"("organization_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "sales_messages_grant_id_wa_msg_id_key" ON "sales_messages"("grant_id", "wa_msg_id");

-- CreateIndex
CREATE INDEX "sales_scan_summaries_organization_id_generated_at_idx" ON "sales_scan_summaries"("organization_id", "generated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "sales_scan_summaries_grant_id_key" ON "sales_scan_summaries"("grant_id");

-- CreateIndex
CREATE INDEX "contact_sync_sessions_organization_id_created_at_idx" ON "contact_sync_sessions"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "contact_sync_sessions_status_expires_at_idx" ON "contact_sync_sessions"("status", "expires_at");

-- CreateIndex
CREATE INDEX "contact_sync_sessions_device_kind_status_idx" ON "contact_sync_sessions"("device_kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "contact_sync_sessions_token_sha256_key" ON "contact_sync_sessions"("token_sha256");

-- CreateIndex
CREATE INDEX "device_tokens_organization_id_idx" ON "device_tokens"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "device_tokens_user_id_fcm_token_key" ON "device_tokens"("user_id", "fcm_token");

-- CreateIndex
CREATE INDEX "contact_sync_staged_items_organization_id_session_id_status_idx" ON "contact_sync_staged_items"("organization_id", "session_id", "status");

-- CreateIndex
CREATE INDEX "contact_sync_staged_items_session_id_applied_at_idx" ON "contact_sync_staged_items"("session_id", "applied_at");

-- CreateIndex
CREATE UNIQUE INDEX "contact_sync_staged_items_session_id_phone_e164_key" ON "contact_sync_staged_items"("session_id", "phone_e164");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_id_fkey" FOREIGN KEY ("accepted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_pricing_tiers" ADD CONSTRAINT "service_pricing_tiers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_pricing_tiers" ADD CONSTRAINT "service_pricing_tiers_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_windows" ADD CONSTRAINT "availability_windows_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_windows" ADD CONSTRAINT "availability_windows_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_info" ADD CONSTRAINT "business_info_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_channels" ADD CONSTRAINT "contact_channels_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "faqs" ADD CONSTRAINT "faqs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policies" ADD CONSTRAINT "policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_job_rows" ADD CONSTRAINT "import_job_rows_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_job_rows" ADD CONSTRAINT "import_job_rows_import_job_id_fkey" FOREIGN KEY ("import_job_id") REFERENCES "import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_connectors" ADD CONSTRAINT "api_connectors_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "api_connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shopify_connections" ADD CONSTRAINT "shopify_connections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shopify_scrape_runs" ADD CONSTRAINT "shopify_scrape_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shopify_scrape_runs" ADD CONSTRAINT "shopify_scrape_runs_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "shopify_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shopify_staged_items" ADD CONSTRAINT "shopify_staged_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shopify_staged_items" ADD CONSTRAINT "shopify_staged_items_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "shopify_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_revisions" ADD CONSTRAINT "catalog_revisions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_channels" ADD CONSTRAINT "whatsapp_channels_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messenger_channels" ADD CONSTRAINT "messenger_channels_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "whatsapp_threads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meta_webhook_events" ADD CONSTRAINT "meta_webhook_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_threads" ADD CONSTRAINT "whatsapp_threads_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_threads" ADD CONSTRAINT "whatsapp_threads_whatsapp_channel_id_fkey" FOREIGN KEY ("whatsapp_channel_id") REFERENCES "whatsapp_channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_threads" ADD CONSTRAINT "whatsapp_threads_assigned_to_user_id_fkey" FOREIGN KEY ("assigned_to_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_feedback" ADD CONSTRAINT "conversation_feedback_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_feedback" ADD CONSTRAINT "conversation_feedback_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "whatsapp_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_feedback" ADD CONSTRAINT "conversation_feedback_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_watches" ADD CONSTRAINT "stock_watches_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_watches" ADD CONSTRAINT "stock_watches_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_watches" ADD CONSTRAINT "stock_watches_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_watches" ADD CONSTRAINT "stock_watches_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_watches" ADD CONSTRAINT "stock_watches_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "whatsapp_threads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "whatsapp_threads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_reminder_template_id_fkey" FOREIGN KEY ("reminder_template_id") REFERENCES "whatsapp_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_calendar_connections" ADD CONSTRAINT "google_calendar_connections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "whatsapp_threads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_phone_integration_id_fkey" FOREIGN KEY ("phone_integration_id") REFERENCES "phone_integrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_id_fkey" FOREIGN KEY ("cart_id") REFERENCES "carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_thread_tags" ADD CONSTRAINT "whatsapp_thread_tags_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "whatsapp_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_notes" ADD CONSTRAINT "whatsapp_notes_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "whatsapp_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_configs" ADD CONSTRAINT "bot_configs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawl_pages" ADD CONSTRAINT "crawl_pages_crawl_job_id_fkey" FOREIGN KEY ("crawl_job_id") REFERENCES "crawl_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branding_configs" ADD CONSTRAINT "branding_configs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_exports" ADD CONSTRAINT "data_exports_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_memory" ADD CONSTRAINT "contact_memory_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "segments" ADD CONSTRAINT "segments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "segments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_broadcast_id_fkey" FOREIGN KEY ("broadcast_id") REFERENCES "broadcasts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_whatsapp_channel_id_fkey" FOREIGN KEY ("whatsapp_channel_id") REFERENCES "whatsapp_channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_wallets" ADD CONSTRAINT "tenant_wallets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_events" ADD CONSTRAINT "broadcast_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_events" ADD CONSTRAINT "broadcast_events_broadcast_id_fkey" FOREIGN KEY ("broadcast_id") REFERENCES "broadcasts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequences" ADD CONSTRAINT "sequences_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_steps" ADD CONSTRAINT "sequence_steps_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_steps" ADD CONSTRAINT "sequence_steps_sequence_id_fkey" FOREIGN KEY ("sequence_id") REFERENCES "sequences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_sequence_id_fkey" FOREIGN KEY ("sequence_id") REFERENCES "sequences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_prompt_snapshots" ADD CONSTRAINT "system_prompt_snapshots_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_provenances" ADD CONSTRAINT "message_provenances_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_provenances" ADD CONSTRAINT "message_provenances_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "whatsapp_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_provenances" ADD CONSTRAINT "message_provenances_system_prompt_snapshot_id_fkey" FOREIGN KEY ("system_prompt_snapshot_id") REFERENCES "system_prompt_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provenance_suppressions" ADD CONSTRAINT "provenance_suppressions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provenance_suppressions" ADD CONSTRAINT "provenance_suppressions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provenance_flag_decisions" ADD CONSTRAINT "provenance_flag_decisions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provenance_flag_decisions" ADD CONSTRAINT "provenance_flag_decisions_provenance_id_fkey" FOREIGN KEY ("provenance_id") REFERENCES "message_provenances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provenance_flag_decisions" ADD CONSTRAINT "provenance_flag_decisions_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_calls" ADD CONSTRAINT "voice_calls_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_calls" ADD CONSTRAINT "voice_calls_phone_integration_id_fkey" FOREIGN KEY ("phone_integration_id") REFERENCES "phone_integrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_calls" ADD CONSTRAINT "voice_calls_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_configs" ADD CONSTRAINT "payment_configs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phone_integrations" ADD CONSTRAINT "phone_integrations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phone_integrations" ADD CONSTRAINT "phone_integrations_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_call_turns" ADD CONSTRAINT "voice_call_turns_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_call_turns" ADD CONSTRAINT "voice_call_turns_voice_call_id_fkey" FOREIGN KEY ("voice_call_id") REFERENCES "voice_calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_scan_grants" ADD CONSTRAINT "sales_scan_grants_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_messages" ADD CONSTRAINT "sales_messages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_messages" ADD CONSTRAINT "sales_messages_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "sales_scan_grants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_scan_summaries" ADD CONSTRAINT "sales_scan_summaries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_scan_summaries" ADD CONSTRAINT "sales_scan_summaries_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "sales_scan_grants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_sync_sessions" ADD CONSTRAINT "contact_sync_sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_sync_staged_items" ADD CONSTRAINT "contact_sync_staged_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_sync_staged_items" ADD CONSTRAINT "contact_sync_staged_items_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "contact_sync_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ---------- 3. raw SQL Prisma cannot express -------------------------------

-- from 20260421082153_initial
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- from 20260427110000_whatsapp_multi_number
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_channels_one_primary_per_org"
  ON "whatsapp_channels" ("organization_id")
  WHERE "is_primary" = TRUE;

-- from 20260427120000_inbox_threads_tags_notes_canned_templates
CREATE INDEX "whatsapp_threads_search_trgm_idx"
    ON "whatsapp_threads" USING gin ("search_text" gin_trgm_ops);

-- from 20260427140000_phase2_bot_builder

-- from 20260427160000_skills_read_receipts_cname
CREATE INDEX IF NOT EXISTS "whatsapp_messages_meta_id_idx"
    ON "whatsapp_messages" ("meta_message_id")
    WHERE "meta_message_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "branding_configs_custom_cname_idx"
    ON "branding_configs" ("custom_cname")
    WHERE "custom_cname" IS NOT NULL;

-- from 20260507105400_phase4_broadcasts
CREATE INDEX IF NOT EXISTS "contacts_search_trgm_idx"
    ON "contacts" USING gin (
      (lower(coalesce("phone_e164", '') || ' ' || coalesce("display_name", ''))) gin_trgm_ops
    );

-- from 20260520150000_broadcast_tag_audience
CREATE INDEX IF NOT EXISTS broadcasts_audience_tags_idx
  ON broadcasts USING GIN (audience_tags);

-- from 20260522170000_provenance_suppressions
CREATE UNIQUE INDEX IF NOT EXISTS provenance_suppressions_org_phrase_uq
  ON provenance_suppressions (organization_id, phrase)
  WHERE organization_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS provenance_suppressions_global_phrase_uq
  ON provenance_suppressions (phrase)
  WHERE organization_id IS NULL;

-- from 20260524120000_product_image_meta_media_cache
CREATE INDEX IF NOT EXISTS product_images_meta_media_id_uploaded_at_idx
  ON product_images (meta_media_id_uploaded_at)
  WHERE meta_media_id IS NOT NULL;

-- from 20260526120000_session_refresh_family_and_impersonation

-- from 20260526150000_audit_log_hash_chain
CREATE OR REPLACE FUNCTION audit_log_canonical(
  p_id            UUID,
  p_organization  UUID,
  p_action        "AuditAction",
  p_actor         UUID,
  p_entity_type   TEXT,
  p_entity_id     UUID,
  p_metadata      JSONB,
  p_ip            INET,
  p_user_agent    TEXT,
  p_created_at    TIMESTAMP,
  p_prev_hash     TEXT
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  -- chr(31) is the ASCII unit separator: improbable in any real audit
  -- field, so collisions via concat ambiguity are not feasible.
  SELECT concat_ws(
    chr(31),
    p_id::text,
    COALESCE(p_organization::text, ''),
    p_action::text,
    COALESCE(p_actor::text, ''),
    COALESCE(p_entity_type, ''),
    COALESCE(p_entity_id::text, ''),
    COALESCE(p_metadata::text, ''),
    COALESCE(host(p_ip), ''),
    COALESCE(p_user_agent, ''),
    extract(epoch FROM p_created_at)::text,
    COALESCE(p_prev_hash, '')
  );
$$;
CREATE OR REPLACE FUNCTION audit_log_compute_hash(p_canonical TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT encode(digest(p_canonical, 'sha256'), 'hex');
$$;
CREATE OR REPLACE FUNCTION audit_log_hash_chain()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_prev_hash TEXT;
  v_lock_key  BIGINT;
BEGIN
  IF NEW.organization_id IS NOT NULL THEN
    v_lock_key := hashtextextended('audit:' || NEW.organization_id::text, 0);
  ELSE
    v_lock_key := hashtextextended('audit:__system__', 0);
  END IF;
  PERFORM pg_advisory_xact_lock(v_lock_key);
  IF NEW.organization_id IS NOT NULL THEN
    SELECT hash INTO v_prev_hash
    FROM audit_logs
    WHERE organization_id = NEW.organization_id
    ORDER BY created_at DESC, id DESC
    LIMIT 1;
  ELSE
    SELECT hash INTO v_prev_hash
    FROM audit_logs
    WHERE organization_id IS NULL
    ORDER BY created_at DESC, id DESC
    LIMIT 1;
  END IF;
  NEW.prev_hash := v_prev_hash;
  NEW.hash := audit_log_compute_hash(
    audit_log_canonical(
      NEW.id,
      NEW.organization_id,
      NEW.action,
      NEW.actor_user_id,
      NEW.entity_type,
      NEW.entity_id,
      NEW.metadata,
      NEW.ip_address,
      NEW.user_agent,
      NEW.created_at,
      NEW.prev_hash
    )
  );
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS audit_log_hash_chain_tr ON audit_logs;
CREATE TRIGGER audit_log_hash_chain_tr
  BEFORE INSERT ON audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_hash_chain();

-- from 20260526170000_product_embedding
CREATE INDEX "products_embedding_pending_idx"
  ON "products" (organization_id)
  WHERE deleted_at IS NULL AND (embedding = ARRAY[]::double precision[] OR embedding_hash IS NULL);

-- from 20260623120000_multi_number_whatsapp
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_threads_org_phone_nochannel_key"
  ON "whatsapp_threads" ("organization_id", "customer_phone")
  WHERE "whatsapp_channel_id" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_threads_org_phone_channel_key"
  ON "whatsapp_threads" ("organization_id", "customer_phone", "whatsapp_channel_id")
  WHERE "whatsapp_channel_id" IS NOT NULL;

-- from 20260804150000_unsubscribed_tag_invariant
CREATE OR REPLACE FUNCTION _sync_unsubscribed_tag() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.opted_out_at IS NOT NULL THEN
    INSERT INTO contact_tags (organization_id, contact_id, tag)
    VALUES (NEW.organization_id, NEW.id, 'unsubscribed')
    ON CONFLICT (contact_id, tag) DO NOTHING;
  ELSE
    DELETE FROM contact_tags WHERE contact_id = NEW.id AND tag = 'unsubscribed';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_contacts_unsubscribed_tag ON contacts;
CREATE TRIGGER trg_contacts_unsubscribed_tag
AFTER INSERT OR UPDATE OF opted_out_at ON contacts
FOR EACH ROW EXECUTE FUNCTION _sync_unsubscribed_tag();

-- from 20260805140000_contact_synced_from
CREATE INDEX IF NOT EXISTS "contacts_synced_from_session_idx"
  ON "contacts" ("organization_id", "synced_from_session_id")
  WHERE "synced_from_session_id" IS NOT NULL;

-- from 20260805150000_google_calendar_meetings
ALTER TABLE "google_calendar_connections"
    ADD CONSTRAINT "google_calendar_connections_meeting_mode_check"
    CHECK ("meeting_mode" IN ('online', 'onsite'));

-- from 20260814130000_follow_ups
CREATE INDEX "whatsapp_threads_follow_up_scan_idx"
  ON "whatsapp_threads" ("organization_id", "last_inbound_at" DESC)
  WHERE "channel" = 'whatsapp';

-- from 20260820120000_meta_webhook_events
CREATE INDEX "meta_webhook_events_field_unprocessed_idx"
  ON "meta_webhook_events"("field", "received_at")
  WHERE "processed_at" IS NULL;

-- from 20260820160000_coexistence_attribution
CREATE UNIQUE INDEX "whatsapp_channels_phone_number_id_uniq"
  ON "whatsapp_channels"("phone_number_id")
  WHERE "phone_number_id" IS NOT NULL;

-- from 20260824120000_coexistence_handset_echoes
CREATE INDEX "whatsapp_threads_handset_replied_at_idx"
  ON "whatsapp_threads"("organization_id", "handset_replied_at")
  WHERE "handset_replied_at" IS NOT NULL;
CREATE UNIQUE INDEX "whatsapp_messages_org_meta_id_uniq"
  ON "whatsapp_messages"("organization_id", "meta_message_id")
  WHERE "meta_message_id" IS NOT NULL;

-- from 20260828120000_contact_external_ref
CREATE UNIQUE INDEX "contacts_org_external_ref_uniq"
  ON "contacts"("organization_id", "external_ref")
  WHERE "external_ref" IS NOT NULL;

-- from 20260828130000_stock_watches
CREATE UNIQUE INDEX "stock_watches_org_product_contact_uniq"
  ON "stock_watches"("organization_id", "product_id", "contact_id")
  WHERE "product_id" IS NOT NULL;
CREATE UNIQUE INDEX "stock_watches_org_service_contact_uniq"
  ON "stock_watches"("organization_id", "service_id", "contact_id")
  WHERE "service_id" IS NOT NULL;

-- from 20260828130000_stock_watches (inline CHECK — Prisma emits no CHECK constraints)
ALTER TABLE "stock_watches"
  ADD CONSTRAINT "stock_watches_one_entity_chk"
  CHECK (("product_id" IS NULL) <> ("service_id" IS NULL));


-- ---------- 4. row-level security ------------------------------------------
-- ============================================================================
-- Row-Level Security policies for ALIGNED Business Platform
-- Applied automatically after every `prisma migrate` via `pnpm rls:apply`.
--
-- Strategy:
--   - The Fastify tenant-context plugin runs each authenticated request inside
--     a transaction with `SET LOCAL app.current_org_id = '<uuid>'`.
--   - For background workers acting on behalf of a tenant, the worker sets the
--     same setting before performing tenant-scoped queries.
--   - For ALIGNED super-admins (cross-tenant ops), a separate flag
--     `SET LOCAL app.bypass_rls = 'on'` skips tenant filtering. This flag is
--     ONLY ever set by code paths gated by `requireSuperAdmin` middleware.
--
-- Helper:
--   current_org_id()      → returns the uuid set on the connection, or NULL
--   rls_bypassed()        → true when the current txn has bypass on
--
-- Every tenant-scoped table:
--   1. ALTER TABLE … ENABLE ROW LEVEL SECURITY;
--   2. ALTER TABLE … FORCE ROW LEVEL SECURITY;     -- so even table owner is filtered
--   3. CREATE POLICY tenant_isolation USING / WITH CHECK using current_org_id().
--
-- This file is idempotent: every CREATE uses IF NOT EXISTS where supported,
-- and policies are dropped + recreated each apply.
-- ============================================================================

-- ---------- helpers ---------------------------------------------------------
CREATE OR REPLACE FUNCTION current_org_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION rls_bypassed() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.bypass_rls', true), 'off') = 'on'
$$;

-- ---------- application role ------------------------------------------------
-- The application connects as a non-superuser role so RLS is enforced.
-- (Superusers bypass RLS by default; we explicitly avoid that.)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
END$$;

-- Grant table privileges to app_user (Prisma migrations run as superuser /
-- migration role; runtime queries should use a session role with SET ROLE).
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;

-- ---------- macro: enable + force RLS + tenant policy -----------------------
-- Usage: SELECT _apply_tenant_rls('memberships');
CREATE OR REPLACE FUNCTION _apply_tenant_rls(_table regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', _table);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', _table);

  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', _table);
  EXECUTE format($p$
    CREATE POLICY tenant_isolation ON %s
      USING (rls_bypassed() OR organization_id = current_org_id())
      WITH CHECK (rls_bypassed() OR organization_id = current_org_id())
  $p$, _table);
END$$;

-- ---------- apply to tenant-scoped tables (Day 1 set) -----------------------
SELECT _apply_tenant_rls('memberships');
SELECT _apply_tenant_rls('invitations');
SELECT _apply_tenant_rls('api_keys');

-- ---------- catalog tables (Day 2) ------------------------------------------
SELECT _apply_tenant_rls('assets');
SELECT _apply_tenant_rls('categories');
SELECT _apply_tenant_rls('products');
SELECT _apply_tenant_rls('product_variants');
SELECT _apply_tenant_rls('product_images');
SELECT _apply_tenant_rls('services');
SELECT _apply_tenant_rls('service_pricing_tiers');
SELECT _apply_tenant_rls('availability_windows');
SELECT _apply_tenant_rls('business_info');
SELECT _apply_tenant_rls('locations');
SELECT _apply_tenant_rls('contact_channels');
SELECT _apply_tenant_rls('faqs');
SELECT _apply_tenant_rls('policies');

-- ---------- imports / connectors / webhooks (Day 3) -------------------------
SELECT _apply_tenant_rls('import_jobs');
SELECT _apply_tenant_rls('import_job_rows');
SELECT _apply_tenant_rls('api_connectors');
SELECT _apply_tenant_rls('sync_runs');
SELECT _apply_tenant_rls('webhook_endpoints');
SELECT _apply_tenant_rls('webhook_deliveries');

-- ---------- Shopify integration ---------------------------------------------
SELECT _apply_tenant_rls('shopify_connections');
SELECT _apply_tenant_rls('shopify_scrape_runs');
SELECT _apply_tenant_rls('shopify_staged_items');

-- ---------- versioning + notifications (Day 4) ------------------------------
SELECT _apply_tenant_rls('catalog_revisions');
SELECT _apply_tenant_rls('notifications');

-- Bookings — RLS is applied inline in migration 20260513170000_bookings, but was
-- missing from this file, so a full rebuild from rls.sql alone would leave
-- bookings without a policy (default-deny outage on the next rebuild). Added for
-- parity (L-14). Idempotent: the helper DROPs the policy before re-creating it.
SELECT _apply_tenant_rls('bookings');
-- Phase 1.5
SELECT _apply_tenant_rls('whatsapp_channels');
SELECT _apply_tenant_rls('whatsapp_messages');
-- Session 4 (Phase 3 inbox)
SELECT _apply_tenant_rls('whatsapp_threads');
SELECT _apply_tenant_rls('whatsapp_thread_tags');
SELECT _apply_tenant_rls('whatsapp_notes');
SELECT _apply_tenant_rls('canned_responses');
SELECT _apply_tenant_rls('whatsapp_templates');
-- Phase 2 (AI bot builder)
SELECT _apply_tenant_rls('bot_configs');
SELECT _apply_tenant_rls('crawl_jobs');
SELECT _apply_tenant_rls('crawl_pages');
SELECT _apply_tenant_rls('knowledge_base_entries');
SELECT _apply_tenant_rls('bot_test_runs');
SELECT _apply_tenant_rls('bot_simulation_turns');
-- Phase 3 §5.1.3 + §5.1.4
SELECT _apply_tenant_rls('subscriptions');
SELECT _apply_tenant_rls('usage_events');
SELECT _apply_tenant_rls('usage_monthly');
SELECT _apply_tenant_rls('branding_configs');
SELECT _apply_tenant_rls('meta_onboarding_steps');
SELECT _apply_tenant_rls('data_exports');
-- Phase 4 — Broadcasts
SELECT _apply_tenant_rls('contacts');
SELECT _apply_tenant_rls('contact_tags');
SELECT _apply_tenant_rls('segments');
SELECT _apply_tenant_rls('broadcasts');
SELECT _apply_tenant_rls('broadcast_recipients');
SELECT _apply_tenant_rls('broadcast_events');
-- Phase 5.4 — Sequences (drip)
SELECT _apply_tenant_rls('sequences');
SELECT _apply_tenant_rls('sequence_steps');
SELECT _apply_tenant_rls('sequence_enrollments');
-- Cart / Shop feature
SELECT _apply_tenant_rls('carts');
SELECT _apply_tenant_rls('cart_items');
-- AI bot builder — flow candidates + test scenarios (added 2026-06-15 after
-- the RLS drift test flagged them missing).
SELECT _apply_tenant_rls('bot_conversation_flow_options');
SELECT _apply_tenant_rls('bot_test_scenarios');
-- Ultra plan — per-contact persona memory
SELECT _apply_tenant_rls('contact_memory');
-- Phase 8 — AI message provenance / audit trail
SELECT _apply_tenant_rls('system_prompt_snapshots');
SELECT _apply_tenant_rls('message_provenances');
SELECT _apply_tenant_rls('provenance_flag_decisions');
-- provenance_suppressions has a custom policy (NULL org_id = global,
-- readable by every tenant). The migration installs it inline; we just
-- enable + force RLS here on every re-apply for safety.
ALTER TABLE provenance_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE provenance_suppressions FORCE ROW LEVEL SECURITY;
-- Voice media gateway (Aseer-time voicebot)
SELECT _apply_tenant_rls('voice_calls');
SELECT _apply_tenant_rls('voice_call_turns');
SELECT _apply_tenant_rls('phone_integrations');
-- Payments (per-tenant, multi-provider)
SELECT _apply_tenant_rls('payment_configs');
-- Messenger / Instagram channel
SELECT _apply_tenant_rls('messenger_channels');
-- plans is GLOBAL (no organization_id) — no RLS needed; access via API only.

-- ---------- pg_trgm GIN indexes for fast search (Prisma can't express) ------
CREATE INDEX IF NOT EXISTS products_search_trgm_idx
  ON products USING gin (search_text gin_trgm_ops);

CREATE INDEX IF NOT EXISTS services_search_trgm_idx
  ON services USING gin (search_text gin_trgm_ops);

CREATE INDEX IF NOT EXISTS faqs_search_trgm_idx
  ON faqs USING gin (search_text gin_trgm_ops);

-- Phase 4 — search across phone + display_name for contacts
CREATE INDEX IF NOT EXISTS contacts_search_trgm_idx
  ON contacts USING gin (
    (lower(coalesce(phone_e164, '') || ' ' || coalesce(display_name, ''))) gin_trgm_ops
  );

-- Auto-maintain search_text on products, services, faqs.
CREATE OR REPLACE FUNCTION _set_product_search_text() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_text := lower(coalesce(NEW.name, '') || ' ' || coalesce(NEW.short_description, '') || ' ' || coalesce(NEW.description, '') || ' ' || coalesce(NEW.sku, ''));
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS products_search_text_trg ON products;
CREATE TRIGGER products_search_text_trg
  BEFORE INSERT OR UPDATE OF name, short_description, description, sku ON products
  FOR EACH ROW EXECUTE FUNCTION _set_product_search_text();

CREATE OR REPLACE FUNCTION _set_service_search_text() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_text := lower(coalesce(NEW.name, '') || ' ' || coalesce(NEW.short_description, '') || ' ' || coalesce(NEW.description, ''));
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS services_search_text_trg ON services;
CREATE TRIGGER services_search_text_trg
  BEFORE INSERT OR UPDATE OF name, short_description, description ON services
  FOR EACH ROW EXECUTE FUNCTION _set_service_search_text();

CREATE OR REPLACE FUNCTION _set_faq_search_text() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_text := lower(coalesce(NEW.question, '') || ' ' || coalesce(NEW.answer, ''));
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS faqs_search_text_trg ON faqs;
CREATE TRIGGER faqs_search_text_trg
  BEFORE INSERT OR UPDATE OF question, answer ON faqs
  FOR EACH ROW EXECUTE FUNCTION _set_faq_search_text();

-- audit_logs and sessions: organization_id is nullable (system / pre-org events).
-- Policy still filters by org_id when present; NULL rows visible only when bypass on.
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON audit_logs;
CREATE POLICY tenant_isolation ON audit_logs
  USING (
    rls_bypassed()
    OR (organization_id IS NOT NULL AND organization_id = current_org_id())
  )
  WITH CHECK (
    rls_bypassed()
    OR (organization_id IS NOT NULL AND organization_id = current_org_id())
    OR organization_id IS NULL  -- allow writing org-less system events
  );

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON sessions;
-- Sessions are user-scoped, not strictly tenant-scoped (a user may switch orgs).
-- We allow the auth layer to manage them via bypass; tenant queries never touch
-- the sessions table.
CREATE POLICY sessions_bypass_only ON sessions
  USING (rls_bypassed())
  WITH CHECK (rls_bypassed());

-- ---------- non-tenant tables (organizations, users) ------------------------
-- Organizations and users are global identities. Access is gated in app code
-- (requireSuperAdmin for cross-org reads). RLS still enabled so a leaked
-- query without bypass cannot enumerate everything.

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_self_or_bypass ON organizations;
CREATE POLICY org_self_or_bypass ON organizations
  USING (rls_bypassed() OR id = current_org_id())
  WITH CHECK (rls_bypassed() OR id = current_org_id());

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_membership_or_bypass ON users;
CREATE POLICY user_membership_or_bypass ON users
  USING (
    rls_bypassed()
    OR EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.user_id = users.id
        AND m.organization_id = current_org_id()
    )
  )
  WITH CHECK (rls_bypassed());  -- writes go through bypass (auth/admin paths)

-- ---------- end -------------------------------------------------------------
SELECT _apply_tenant_rls('tenant_wallets');
SELECT _apply_tenant_rls('wallet_ledger');
SELECT _apply_tenant_rls('google_calendar_connections');

-- Sales Scan ("Teach the bot with your own data") — added 2026-07-30.
SELECT _apply_tenant_rls('sales_scan_grants');
SELECT _apply_tenant_rls('sales_messages');
SELECT _apply_tenant_rls('sales_scan_summaries');

-- "Sync contacts with phone" — QR-mediated address-book import. Added 2026-07-31.
SELECT _apply_tenant_rls('contact_sync_sessions');
-- Per-row ledger for a sync run. Holds third-party PII (names/numbers from a tenant's
-- address book) while staged, so the policy matters as much as the sessions table's.
SELECT _apply_tenant_rls('contact_sync_staged_items');

-- Hader mobile app push-device registrations — added 2026-08-03.
SELECT _apply_tenant_rls('device_tokens');

-- Landing pad for Meta webhook payloads no handler consumes yet (Coexistence
-- `history` / `smb_*` above all). Holds raw third-party message content, so the
-- policy matters as much as whatsapp_messages'. Added 2026-08-20.
SELECT _apply_tenant_rls('meta_webhook_events');

-- Post-conversation CSAT rows (F2, roadmap 2026-08-26) — per-tenant ratings
-- with contact linkage. Added 2026-08-27.
SELECT _apply_tenant_rls('conversation_feedback');

-- Back-in-stock watches (F5, roadmap 2026-08-26) — per-tenant customer
-- interest flags with contact linkage. Added 2026-08-28.
SELECT _apply_tenant_rls('stock_watches');
