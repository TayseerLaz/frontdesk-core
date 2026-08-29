// Day 3 enums — mirror schema.prisma. Keep in sync.

export const ImportEntityKind = {
  product: 'product',
  service: 'service',
  faq: 'faq',
  business_info: 'business_info',
} as const;
export type ImportEntityKind = (typeof ImportEntityKind)[keyof typeof ImportEntityKind];

export const IMPORT_ENTITY_KINDS = Object.values(ImportEntityKind) as ImportEntityKind[];
export const IMPORT_ENTITY_LABELS: Record<ImportEntityKind, string> = {
  product: 'Products',
  service: 'Services',
  faq: 'FAQs',
  business_info: 'Business info',
};

export const ImportJobStatus = {
  pending: 'pending',
  validating: 'validating',
  processing: 'processing',
  succeeded: 'succeeded',
  partial: 'partial',
  failed: 'failed',
  cancelled: 'cancelled',
} as const;
export type ImportJobStatus = (typeof ImportJobStatus)[keyof typeof ImportJobStatus];

export const ImportRowStatus = {
  succeeded: 'succeeded',
  failed: 'failed',
  skipped: 'skipped',
} as const;
export type ImportRowStatus = (typeof ImportRowStatus)[keyof typeof ImportRowStatus];

export const ConnectorAuthKind = {
  none: 'none',
  api_key: 'api_key',
  bearer: 'bearer',
  basic: 'basic',
  hmac: 'hmac',
} as const;
export type ConnectorAuthKind = (typeof ConnectorAuthKind)[keyof typeof ConnectorAuthKind];

export const ConnectorStatus = {
  active: 'active',
  paused: 'paused',
  failing: 'failing',
  disabled: 'disabled',
} as const;
export type ConnectorStatus = (typeof ConnectorStatus)[keyof typeof ConnectorStatus];

export const SyncRunStatus = {
  pending: 'pending',
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  partial: 'partial',
} as const;
export type SyncRunStatus = (typeof SyncRunStatus)[keyof typeof SyncRunStatus];

export const SyncTrigger = {
  scheduled: 'scheduled',
  manual: 'manual',
  webhook: 'webhook',
} as const;
export type SyncTrigger = (typeof SyncTrigger)[keyof typeof SyncTrigger];

export const WebhookDeliveryStatus = {
  pending: 'pending',
  in_flight: 'in_flight',
  delivered: 'delivered',
  failed: 'failed',
  giving_up: 'giving_up',
} as const;
export type WebhookDeliveryStatus = (typeof WebhookDeliveryStatus)[keyof typeof WebhookDeliveryStatus];

export const WebhookEventKind = {
  product_created: 'product_created',
  product_updated: 'product_updated',
  product_deleted: 'product_deleted',
  service_created: 'service_created',
  service_updated: 'service_updated',
  service_deleted: 'service_deleted',
  business_info_updated: 'business_info_updated',
  faq_changed: 'faq_changed',
  policy_changed: 'policy_changed',
  catalog_changed: 'catalog_changed',
  // Phase 4 — Broadcasts
  broadcast_started: 'broadcast_started',
  broadcast_completed: 'broadcast_completed',
  broadcast_failed: 'broadcast_failed',
  broadcast_recipient_failed: 'broadcast_recipient_failed',
  // Bookings
  booking_created: 'booking_created',
  booking_status_changed: 'booking_status_changed',
  booking_reminder_sent: 'booking_reminder_sent',
  // Carts
  cart_created: 'cart_created',
  cart_status_changed: 'cart_status_changed',
  cart_item_added: 'cart_item_added',
  // Payments (F-04) — a gateway webhook confirmed an order was paid.
  order_paid: 'order_paid',
} as const;
export type WebhookEventKind = (typeof WebhookEventKind)[keyof typeof WebhookEventKind];

export const WEBHOOK_EVENT_KINDS = Object.values(WebhookEventKind) as WebhookEventKind[];
