// Phase 4 enums — mirror schema.prisma. Keep in sync.

export const ContactSource = {
  manual: 'manual',
  csv: 'csv',
  inbox_auto: 'inbox_auto',
  import: 'import',
  /** Pushed from a tenant's own phone address book via the QR sync flow. */
  phone_sync: 'phone_sync',
} as const;
export type ContactSource = (typeof ContactSource)[keyof typeof ContactSource];
export const CONTACT_SOURCES = Object.values(ContactSource) as ContactSource[];

export const BroadcastStatus = {
  draft: 'draft',
  scheduled: 'scheduled',
  sending: 'sending',
  paused: 'paused',
  completed: 'completed',
  cancelled: 'cancelled',
  failed: 'failed',
} as const;
export type BroadcastStatus = (typeof BroadcastStatus)[keyof typeof BroadcastStatus];
export const BROADCAST_STATUSES = Object.values(BroadcastStatus) as BroadcastStatus[];

export const BROADCAST_STATUS_LABELS: Record<BroadcastStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  sending: 'Sending',
  paused: 'Paused',
  completed: 'Completed',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

export const BroadcastAudienceKind = {
  csv: 'csv',
  // Legacy — kept on the union so existing broadcast rows still parse, but
  // the wizard no longer surfaces it. Tag-based audiences replaced segments.
  segment: 'segment',
  manual: 'manual',
  // Tag-based audience: client-side selects 1..N tags and a mode
  // ('any' = OR, 'all' = AND). Materialized at send time by intersecting
  // Contact.tags against the chosen tags.
  tags: 'tags',
} as const;
export type BroadcastAudienceKind =
  (typeof BroadcastAudienceKind)[keyof typeof BroadcastAudienceKind];
export const BROADCAST_AUDIENCE_KINDS = Object.values(
  BroadcastAudienceKind,
) as BroadcastAudienceKind[];

export const BroadcastVariant = {
  A: 'A',
  B: 'B',
} as const;
export type BroadcastVariant = (typeof BroadcastVariant)[keyof typeof BroadcastVariant];

export const RecipientStatus = {
  pending: 'pending',
  queued: 'queued',
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
  skipped: 'skipped',
} as const;
export type RecipientStatus = (typeof RecipientStatus)[keyof typeof RecipientStatus];
export const RECIPIENT_STATUSES = Object.values(RecipientStatus) as RecipientStatus[];

export const RECIPIENT_STATUS_LABELS: Record<RecipientStatus, string> = {
  pending: 'Pending',
  queued: 'Queued',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
  failed: 'Failed',
  skipped: 'Skipped',
};

export const BroadcastEventKind = {
  created: 'created',
  scheduled: 'scheduled',
  started: 'started',
  paused: 'paused',
  resumed: 'resumed',
  cancelled: 'cancelled',
  completed: 'completed',
  failed: 'failed',
  recipient_failed_burst: 'recipient_failed_burst',
} as const;
export type BroadcastEventKind = (typeof BroadcastEventKind)[keyof typeof BroadcastEventKind];
