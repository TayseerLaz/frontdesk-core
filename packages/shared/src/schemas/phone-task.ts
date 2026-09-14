import { z } from 'zod';

import { uuidSchema } from './common.js';

// ----------------------------------------------------------------------------
// Phone tasks — outbound AI phone calls placed through CALL-E to close the loop
// on a record the chat bot opened. The wire contract between api + web.
//
// A task is one call attempt. The api builds the spoken `task` + the JSON
// `resultSchema` from the tenant's OWN data (cart rows, booking row, business
// info) — the web never sends free text for the two record-backed kinds, only
// for `custom`.
// ----------------------------------------------------------------------------

export const PHONE_TASK_KINDS = ['cod_order_confirm', 'booking_confirm', 'custom'] as const;
export type PhoneTaskKind = (typeof PHONE_TASK_KINDS)[number];

export const PHONE_TASK_STATUSES = [
  'queued',
  'in_progress',
  'completed',
  'failed',
  'canceled',
  'needs_review',
] as const;
export type PhoneTaskStatus = (typeof PHONE_TASK_STATUSES)[number];

/**
 * Countries CALL-E can dial (ISO-3166 alpha-2 → E.164 dial code). Mirrors the
 * "Supported regions" table in CALLE-AI/call-e-integrations as of 2026-09-14.
 * Anything else is rejected BEFORE a task row is written, with a spoken-friendly
 * error the operator sees in a toast.
 */
export const CALLE_SUPPORTED_REGIONS: Record<string, string> = {
  US: '1',
  CA: '1',
  GB: '44',
  DE: '49',
  ES: '34',
  FI: '358',
  NL: '31',
  PL: '48',
  TR: '90',
  AU: '61',
  SG: '65',
  MY: '60',
  TH: '66',
  ID: '62',
  PH: '63',
  VN: '84',
  IN: '91',
  PK: '92',
  BD: '880',
  CN: '86',
  JP: '81',
  MX: '52',
  BR: '55',
};

/** Longest-prefix match of an E.164 number to a supported region, or null. */
export function regionForE164(phone: string): string | null {
  const digits = phone.replace(/\D+/g, '');
  let best: { region: string; len: number } | null = null;
  for (const [region, code] of Object.entries(CALLE_SUPPORTED_REGIONS)) {
    if (digits.startsWith(code) && (!best || code.length > best.len)) {
      best = { region, len: code.length };
    }
  }
  // +1 is shared by US/CA; CALL-E accepts either, prefer US.
  if (best && best.len === 1) return 'US';
  return best?.region ?? null;
}

export const phoneTaskSchema = z.object({
  id: uuidSchema,
  kind: z.enum(PHONE_TASK_KINDS),
  targetType: z.enum(['cart', 'booking', 'thread']).nullable(),
  targetId: uuidSchema.nullable(),
  contactId: uuidSchema.nullable(),
  threadId: uuidSchema.nullable(),
  phoneE164: z.string(),
  dialedPhone: z.string().nullable(),
  region: z.string().nullable(),
  locale: z.string().nullable(),
  task: z.string(),
  resultSchema: z.record(z.unknown()),
  status: z.enum(PHONE_TASK_STATUSES),
  dryRun: z.boolean(),
  calleCallId: z.string().nullable(),
  structuredResult: z.record(z.unknown()).nullable(),
  summary: z.string().nullable(),
  taskCompleted: z.boolean().nullable(),
  confidence: z.number().nullable(),
  transcript: z
    .array(z.object({ speaker: z.string(), text: z.string(), offsetMs: z.number().nullable() }))
    .nullable(),
  error: z.string().nullable(),
  appliedAt: z.string().datetime().nullable(),
  appliedAction: z.string().nullable(),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});
export type PhoneTaskDto = z.infer<typeof phoneTaskSchema>;

export const createPhoneTaskBodySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cod_order_confirm'), cartId: uuidSchema }),
  z.object({ kind: z.literal('booking_confirm'), bookingId: uuidSchema }),
  z.object({
    kind: z.literal('custom'),
    // Either a thread (phone + context come from it) or a raw phone.
    threadId: uuidSchema.optional(),
    phoneE164: z.string().trim().min(8).max(20).optional(),
    goal: z.string().trim().min(10).max(2000),
  }),
]);
export type CreatePhoneTaskBody = z.infer<typeof createPhoneTaskBodySchema>;

export const phoneTaskListQuerySchema = z.object({
  status: z.enum(PHONE_TASK_STATUSES).optional(),
  targetType: z.enum(['cart', 'booking', 'thread']).optional(),
  targetId: uuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

/** Per-tenant automation settings (Organization.phoneTaskSettings). */
export const phoneTaskSettingsSchema = z.object({
  // When on, every new cash-on-delivery order gets a confirmation call after
  // `delayMinutes` (gives the customer time to finish the chat).
  codAutoConfirm: z.boolean().default(false),
  delayMinutes: z.number().int().min(0).max(1440).default(3),
  // Hard ceiling on calls per org per UTC day, auto + manual combined.
  dailyCap: z.number().int().min(1).max(1000).default(50),
});
export type PhoneTaskSettings = z.infer<typeof phoneTaskSettingsSchema>;

/** Runtime facts the web shows as a banner (dry-run / override). */
export const phoneTaskRuntimeSchema = z.object({
  dryRun: z.boolean(),
  liveOverridePhone: z.string().nullable(),
  configured: z.boolean(),
  supportedRegions: z.array(z.string()),
});
export type PhoneTaskRuntime = z.infer<typeof phoneTaskRuntimeSchema>;
