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
CREATE TYPE "UserStatus" AS ENUM ('pending', 'active', 'disabled');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('pending', 'accepted', 'revoked', 'expired');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('user_created', 'user_updated', 'user_deactivated', 'user_role_changed', 'org_created', 'org_suspended', 'invitation_sent', 'invitation_accepted', 'invitation_revoked', 'api_key_created', 'api_key_revoked', 'password_changed', 'password_reset_requested', 'email_verified', 'login_succeeded', 'login_failed', 'logout', 'product_created', 'product_updated', 'product_deleted', 'service_created', 'service_updated', 'service_deleted', 'category_created', 'category_updated', 'category_deleted', 'business_info_updated', 'faq_created', 'faq_updated', 'faq_deleted', 'policy_created', 'policy_updated', 'policy_deleted', 'asset_uploaded', 'asset_deleted', 'import_started', 'import_completed', 'import_failed', 'api_key_used_first_time', 'webhook_endpoint_created', 'webhook_endpoint_deleted', 'webhook_delivered', 'webhook_failed', 'connector_created', 'connector_updated', 'connector_deleted', 'connector_sync_started', 'connector_sync_succeeded', 'connector_sync_failed', 'revision_restored', 'notification_marked_read', 'org_pilot_onboarded');

-- CreateEnum
CREATE TYPE "RevisionEntityType" AS ENUM ('product', 'service', 'business_info', 'faq', 'policy');

-- CreateEnum
CREATE TYPE "RevisionAction" AS ENUM ('created', 'updated', 'deleted', 'restored');

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('import_succeeded', 'import_partial', 'import_failed', 'sync_succeeded', 'sync_failed', 'webhook_disabled', 'api_key_first_use', 'generic');

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
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('pending', 'in_flight', 'delivered', 'failed', 'giving_up');

-- CreateEnum
CREATE TYPE "WebhookEventKind" AS ENUM ('product_created', 'product_updated', 'product_deleted', 'service_created', 'service_updated', 'service_deleted', 'business_info_updated', 'faq_changed', 'policy_changed', 'catalog_changed');

-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('image', 'document', 'csv_upload', 'other');

-- CreateEnum
CREATE TYPE "DayOfWeek" AS ENUM ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday');

-- CreateEnum
CREATE TYPE "PriceUnit" AS ENUM ('flat', 'per_hour', 'per_day', 'per_session', 'per_unit');

-- CreateEnum
CREATE TYPE "FaqVisibility" AS ENUM ('public', 'private');

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" CITEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "OrgStatus" NOT NULL DEFAULT 'active',
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
    "endpoint_url" TEXT NOT NULL,
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
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_revisions" ADD CONSTRAINT "catalog_revisions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
