export const RevisionEntityType = {
  product: 'product',
  service: 'service',
  business_info: 'business_info',
  faq: 'faq',
  policy: 'policy',
} as const;
export type RevisionEntityType = (typeof RevisionEntityType)[keyof typeof RevisionEntityType];

export const RevisionAction = {
  created: 'created',
  updated: 'updated',
  deleted: 'deleted',
  restored: 'restored',
} as const;
export type RevisionAction = (typeof RevisionAction)[keyof typeof RevisionAction];

export const NotificationKind = {
  import_succeeded: 'import_succeeded',
  import_partial: 'import_partial',
  import_failed: 'import_failed',
  sync_succeeded: 'sync_succeeded',
  sync_failed: 'sync_failed',
  webhook_disabled: 'webhook_disabled',
  api_key_first_use: 'api_key_first_use',
  generic: 'generic',
  // Phase 5.9 — billing dunning auto-suspend. Mirrors the Prisma enum
  // value so the API DTO can serialise notifications emitted by the
  // hourly dunning tick.
  org_suspended_for_billing: 'org_suspended_for_billing',
  // Cart flow — bot or operator creates a cart → bell ping for admins.
  cart_received: 'cart_received',
  // Booking flow — a voice/chat booking lands → bell ping (voice has no thread).
  booking_received: 'booking_received',
  // Payments (F-04) — a gateway webhook confirmed an order was paid.
  order_paid: 'order_paid',
  // Quota usage crossed a threshold (75/80/85/90/95/100% of a plan cap).
  quota_warning: 'quota_warning',
  // Shopify — a scrape finished with items to review, or an import completed.
  shopify_review_ready: 'shopify_review_ready',
  shopify_import_done: 'shopify_import_done',
  // Inbox teamwork — a conversation was assigned to you / taken over from you.
  thread_assigned: 'thread_assigned',
} as const;
export type NotificationKind = (typeof NotificationKind)[keyof typeof NotificationKind];

export const NotificationSeverity = {
  info: 'info',
  success: 'success',
  warning: 'warning',
  error: 'error',
} as const;
export type NotificationSeverity = (typeof NotificationSeverity)[keyof typeof NotificationSeverity];
