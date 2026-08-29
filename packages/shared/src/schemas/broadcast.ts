// Phase 4 — Broadcasts. Zod schemas shared between api + web.
// Mirrors the Prisma models in packages/db/prisma/schema.prisma.
import { z } from 'zod';

import {
  BROADCAST_AUDIENCE_KINDS,
  BROADCAST_STATUSES,
  type BroadcastAudienceKind,
  type BroadcastStatus,
  CONTACT_SOURCES,
  type ContactSource,
  RECIPIENT_STATUSES,
  type RecipientStatus,
} from '../enums/phase4.js';
import { uuidSchema } from './common.js';

// ---------- E.164 phone normalization --------------------------------------
// Accept user input as +14155551234 OR 14155551234 OR digits-with-spaces; we
// strip non-digits and re-add the leading +. Length: 8–15 digits per E.164.
export const phoneE164Schema = z
  .string()
  .trim()
  .min(1)
  .transform((s) => {
    const digits = s.replace(/[^\d]/g, '');
    return digits.length > 0 ? `+${digits}` : '';
  })
  .refine((s) => /^\+\d{8,15}$/.test(s), 'Use a valid E.164 phone number, e.g. +14155551234.');

// ---------- Contact --------------------------------------------------------
export const contactDtoSchema = z.object({
  id: uuidSchema,
  phoneE164: z.string(),
  // Operator-entered email address (optional). Not format-validated on READ so
  // a legacy/imported non-conforming value can't 500 the whole list.
  email: z.string().nullable(),
  displayName: z.string().nullable(),
  // Read-only mirror of the WhatsApp profile name Meta provides on
  // inbound messages (contacts[].profile.name). Kept distinct from
  // displayName so an operator-set nickname survives Meta updates.
  whatsappName: z.string().nullable(),
  locale: z.string().nullable(),
  optedInAt: z.string().datetime().nullable(),
  optedOutAt: z.string().datetime().nullable(),
  // Operator block: bot won't auto-reply + excluded from broadcasts.
  blockedAt: z.string().datetime().nullable(),
  timezone: z.string().nullable(),
  // Origin channel: 'whatsapp' (real number) | 'instagram' | 'messenger'.
  channel: z.string().default('whatsapp'),
  // Free-form per-contact data. Values may be scalars OR arrays/objects (e.g.
  // an importer storing `shopifyTags: [...]`), so this is intentionally
  // permissive — a too-strict union here 500s the whole list on serialize.
  attributes: z.record(z.string(), z.unknown()),
  source: z.enum(CONTACT_SOURCES as [ContactSource, ...ContactSource[]]),
  // Who first brought this contact in from a phone sync ("Rita's iPhone"), as typed on the
  // confirm screen. NULL = not introduced by a sync, or synced before this was recorded —
  // render "not recorded", never a guess. Origin only: a contact can be present in several
  // people's phones, and that shows up as tags rather than here.
  syncedFromLabel: z.string().nullable().default(null),
  // F8 — external ERP reference ("SAP #" in the UI). Unique per org.
  externalRef: z.string().nullable().default(null),
  tags: z.array(z.string()),
  lastInboundAt: z.string().datetime().nullable(),
  lastOutboundAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ContactDto = z.infer<typeof contactDtoSchema>;

export const createContactBodySchema = z.object({
  phoneE164: phoneE164Schema,
  // Optional email. Empty string is allowed (treated as "clear"); any non-empty
  // value must look like an address. The API normalizes '' → null.
  email: z
    .string()
    .trim()
    .max(200)
    .refine((v) => v === '' || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), 'Enter a valid email address.')
    .optional()
    .nullable(),
  displayName: z.string().trim().max(120).optional().nullable(),
  // F8 — SAP / ERP customer number. Empty string clears (API maps '' -> null).
  externalRef: z.string().trim().max(60).optional().nullable(),
  locale: z.string().trim().max(20).optional().nullable(),
  timezone: z.string().trim().max(60).optional().nullable(),
  optedIn: z.boolean().optional(),
  optedOut: z.boolean().optional(),
  // Operator block toggle (true = block, false = unblock).
  blocked: z.boolean().optional(),
  attributes: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional(),
  tags: z.array(z.string().trim().min(1).max(40)).optional(),
});
export type CreateContactBody = z.infer<typeof createContactBodySchema>;

export const updateContactBodySchema = createContactBodySchema.partial();
export type UpdateContactBody = z.infer<typeof updateContactBodySchema>;

// Bulk action over a set of contact ids (the contacts list's select-with-
// actions bar). One action per call; `tag` is required for the tag actions.
// Deliberately NO opt-out actions here: opt-out is the customer's own STOP
// signal — an operator must never bulk-clear (or bulk-fake) it.
export const CONTACT_BULK_ACTIONS = ['block', 'unblock', 'add_tag', 'remove_tag', 'delete'] as const;
export type ContactBulkAction = (typeof CONTACT_BULK_ACTIONS)[number];
export const bulkContactsBodySchema = z
  .object({
    ids: z.array(uuidSchema).min(1).max(500),
    action: z.enum(CONTACT_BULK_ACTIONS),
    tag: z.string().trim().min(1).max(40).optional(),
  })
  .refine((b) => (b.action === 'add_tag' || b.action === 'remove_tag' ? !!b.tag : true), {
    message: 'tag is required for tag actions.',
    path: ['tag'],
  });
export type BulkContactsBody = z.infer<typeof bulkContactsBodySchema>;

export const listContactsQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  tag: z.string().trim().max(40).optional(),
  channel: z.enum(['whatsapp', 'instagram', 'messenger']).optional(),
  // How the contact got here (manual / csv / import / inbox_auto / phone_sync).
  // Same vocabulary the `source` segment clause below filters on.
  source: z.enum(CONTACT_SOURCES as [ContactSource, ...ContactSource[]]).optional(),
  cursor: z.string().optional(),
  // 1-based page for offset pagination (the contacts UI uses numbered pages +
  // a total count). When omitted, cursor pagination is used (broadcast wizard).
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListContactsQuery = z.infer<typeof listContactsQuerySchema>;

// ---------- Segment --------------------------------------------------------
// Filter AST: a small whitelist. Evaluator turns this into a Prisma where.
const segmentClauseSchema = z.discriminatedUnion('field', [
  z.object({
    field: z.literal('tag'),
    op: z.enum(['in', 'not_in']),
    value: z.array(z.string().trim().min(1).max(40)).min(1).max(50),
  }),
  z.object({
    field: z.literal('attribute'),
    key: z.string().trim().min(1).max(60),
    op: z.enum(['eq', 'neq', 'contains']),
    value: z.string().trim().max(200),
  }),
  z.object({
    field: z.literal('locale'),
    op: z.enum(['eq', 'neq']),
    value: z.string().trim().min(1).max(20),
  }),
  z.object({
    field: z.literal('last_inbound_at'),
    op: z.enum(['within_days', 'not_within_days']),
    value: z.coerce.number().int().min(1).max(3650),
  }),
  z.object({
    field: z.literal('source'),
    op: z.enum(['eq', 'neq']),
    value: z.enum(CONTACT_SOURCES as [ContactSource, ...ContactSource[]]),
  }),
]);
export type SegmentClause = z.infer<typeof segmentClauseSchema>;

export const segmentFilterSchema = z.object({
  mode: z.enum(['all', 'any']).default('all'),
  clauses: z.array(segmentClauseSchema).max(20),
});
export type SegmentFilter = z.infer<typeof segmentFilterSchema>;

export const segmentDtoSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  description: z.string().nullable(),
  filter: segmentFilterSchema,
  contactCount: z.number().int().nonnegative().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SegmentDto = z.infer<typeof segmentDtoSchema>;

export const createSegmentBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional().nullable(),
  filter: segmentFilterSchema,
});
export type CreateSegmentBody = z.infer<typeof createSegmentBodySchema>;

export const updateSegmentBodySchema = createSegmentBodySchema.partial();

// ---------- Broadcast variable mapping --------------------------------------
// Per template parameter index (Meta uses 1-based: {{1}}, {{2}}, ...).
// Source decides where the value comes from per recipient.
export const variableSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('static'), value: z.string().max(500) }),
  // For CSV audiences: read column by header name.
  z.object({ kind: z.literal('csv'), column: z.string().min(1).max(120) }),
  // For segment / manual audiences: read Contact.attributes[key], with an
  // optional fallback for missing keys.
  z.object({
    kind: z.literal('attribute'),
    key: z.string().min(1).max(60),
    fallback: z.string().max(500).optional(),
  }),
  // Built-in fields.
  z.object({
    kind: z.literal('field'),
    field: z.enum(['display_name', 'phone_e164', 'locale']),
    fallback: z.string().max(500).optional(),
  }),
]);
export type VariableSource = z.infer<typeof variableSourceSchema>;

// Map of "1" | "2" | ... → source. Body components only (Meta header/footer
// param mapping can be added later).
export const variableMappingSchema = z.record(
  z.string().regex(/^\d+$/, 'Use the numeric parameter index, e.g. "1".'),
  variableSourceSchema,
);
export type VariableMapping = z.infer<typeof variableMappingSchema>;

// ---------- Broadcast ------------------------------------------------------
export const broadcastDtoSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  status: z.enum(BROADCAST_STATUSES as [BroadcastStatus, ...BroadcastStatus[]]),
  // The number(s) this broadcast sends from. channelId = first/back-compat;
  // channelIds = full selected set (recipients split round-robin when > 1).
  channelId: uuidSchema,
  channelIds: z.array(uuidSchema).default([]),
  audienceKind: z.enum(
    BROADCAST_AUDIENCE_KINDS as [BroadcastAudienceKind, ...BroadcastAudienceKind[]],
  ),
  csvAssetId: uuidSchema.nullable(),
  segmentId: uuidSchema.nullable(),
  // Tag-based audience (audienceKind = 'tags'). Empty for other kinds.
  audienceTags: z.array(z.string()).default([]),
  audienceTagsMode: z.enum(['any', 'all']).default('any'),
  includeOptedOut: z.boolean().default(false),
  abTest: z.boolean(),
  variantATemplateId: uuidSchema,
  variantBTemplateId: uuidSchema.nullable(),
  variantAVariables: variableMappingSchema,
  variantBVariables: variableMappingSchema.nullable(),
  scheduledFor: z.string().datetime().nullable(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  sendWindowStartHour: z.number().int().nullable(),
  sendWindowEndHour: z.number().int().nullable(),
  sendWindowTimezone: z.string().nullable(),
  // Batched/throttled send: waves of batchSize every batchIntervalMinutes.
  // 0 = no batching (send all at once).
  batchSize: z.number().int().nonnegative().default(0),
  batchIntervalMinutes: z.number().int().nonnegative().default(0),
  abWinnerStrategy: z.string().nullable(),
  abWinnerVariant: z.enum(['A', 'B']).nullable(),
  abWinnerDecidedAt: z.string().datetime().nullable(),
  totalRecipients: z.number().int().nonnegative(),
  queuedCount: z.number().int().nonnegative(),
  sentCount: z.number().int().nonnegative(),
  deliveredCount: z.number().int().nonnegative(),
  readCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  // Recipients halted before sending (e.g. wallet ran out → insufficient_balance).
  // Live-counted; drives the "Resume" action. Defaults 0 where not computed.
  skippedCount: z.number().int().nonnegative().default(0),
  respondedCount: z.number().int().nonnegative().default(0),
  createdByUserId: uuidSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type BroadcastDto = z.infer<typeof broadcastDtoSchema>;

export const createBroadcastBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  channelId: uuidSchema,
  // Optional extra numbers to send from. When provided (with channelId), the
  // fanout splits recipients round-robin across all of them. Defaults to just
  // [channelId].
  channelIds: z.array(uuidSchema).min(1).max(20).optional(),
  audienceKind: z.enum(
    BROADCAST_AUDIENCE_KINDS as [BroadcastAudienceKind, ...BroadcastAudienceKind[]],
  ),
  csvAssetId: uuidSchema.optional().nullable(),
  segmentId: uuidSchema.optional().nullable(),
  audienceTags: z.array(z.string().trim().min(1).max(40)).max(50).optional(),
  audienceTagsMode: z.enum(['any', 'all']).optional(),
  manualPhones: z.array(phoneE164Schema).max(10000).optional(),
  // Compliance override: include contacts who unsubscribed ("send anyway").
  includeOptedOut: z.boolean().default(false),
  abTest: z.boolean().default(false),
  variantATemplateId: uuidSchema,
  variantBTemplateId: uuidSchema.optional().nullable(),
  variantAVariables: variableMappingSchema.default({}),
  variantBVariables: variableMappingSchema.optional().nullable(),
  // Phase 5.3 — quiet-hours: skip sends to recipients whose local hour is
  // outside [start, end). Both 0-23 inclusive. Timezone defaults to channel
  // timezone if a recipient's contact has none.
  sendWindowStartHour: z.number().int().min(0).max(23).optional().nullable(),
  sendWindowEndHour: z.number().int().min(0).max(23).optional().nullable(),
  sendWindowTimezone: z.string().trim().max(60).optional().nullable(),
  // Batched/throttled send: release `batchSize` recipients, then wait
  // `batchIntervalMinutes` before the next wave. Both 0 = send all at once.
  batchSize: z.number().int().min(0).max(100000).optional().default(0),
  batchIntervalMinutes: z.number().int().min(0).max(1440).optional().default(0),
  abWinnerStrategy: z.enum(['read_rate', 'response_rate', 'manual']).optional().nullable(),
});
export type CreateBroadcastBody = z.infer<typeof createBroadcastBodySchema>;

export const updateBroadcastBodySchema = createBroadcastBodySchema.partial();

export const sendBroadcastBodySchema = z.object({
  // ISO datetime; omit (or null) to send now.
  scheduledFor: z.string().datetime().optional().nullable(),
});
export type SendBroadcastBody = z.infer<typeof sendBroadcastBodySchema>;

// ---------- Recipient ------------------------------------------------------
export const recipientDtoSchema = z.object({
  id: uuidSchema,
  phoneE164: z.string(),
  contactId: uuidSchema.nullable(),
  variant: z.enum(['A', 'B']),
  status: z.enum(RECIPIENT_STATUSES as [RecipientStatus, ...RecipientStatus[]]),
  metaMessageId: z.string().nullable(),
  metaErrorCode: z.string().nullable(),
  metaErrorMessage: z.string().nullable(),
  queuedAt: z.string().datetime().nullable(),
  sentAt: z.string().datetime().nullable(),
  deliveredAt: z.string().datetime().nullable(),
  readAt: z.string().datetime().nullable(),
  failedAt: z.string().datetime().nullable(),
  attemptCount: z.number().int().nonnegative(),
});
export type RecipientDto = z.infer<typeof recipientDtoSchema>;

export const listRecipientsQuerySchema = z.object({
  status: z.enum(RECIPIENT_STATUSES as [RecipientStatus, ...RecipientStatus[]]).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListRecipientsQuery = z.infer<typeof listRecipientsQuerySchema>;

// ---------- Broadcast event -------------------------------------------------
export const broadcastEventDtoSchema = z.object({
  id: uuidSchema,
  kind: z.string(),
  detail: z.unknown().nullable(),
  createdAt: z.string().datetime(),
});
export type BroadcastEventDto = z.infer<typeof broadcastEventDtoSchema>;

// ---------- CSV preview/parse ----------------------------------------------
// Returned by POST /broadcasts/:id/audience/csv after server-side header parse.
export const csvAudienceMetaSchema = z.object({
  assetId: uuidSchema,
  rowCount: z.number().int().nonnegative(),
  headers: z.array(z.string()),
  // First few sample rows (≤20) for the variable-mapping wizard step.
  sample: z.array(z.record(z.string(), z.string())),
});
export type CsvAudienceMeta = z.infer<typeof csvAudienceMetaSchema>;
