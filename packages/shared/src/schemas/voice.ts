import { z } from 'zod';

import { uuidSchema } from './common.js';

// ----------------------------------------------------------------------------
// Voice media gateway (Aseer-time voicebot) — /api/v1/voice/*
//
// The voicebot authenticates with X-Api-Key. It fetches the compiled
// per-tenant persona/grounding once per call (voice:config) and posts call
// lifecycle + transcript turns as they happen (voice:calls). The bridge's
// audio path is a 20 ms pacing loop, so its client is fire-and-forget — these
// endpoints must stay cheap and idempotent (retries happen).
// ----------------------------------------------------------------------------

export const voiceCallOutcomes = ['in_progress', 'completed', 'handoff', 'dropped'] as const;
export type VoiceCallOutcome = (typeof voiceCallOutcomes)[number];

export const voiceTurnRoles = ['caller', 'assistant'] as const;
export type VoiceTurnRole = (typeof voiceTurnRoles)[number];

// One operator-configured form field (shop or booking). The voicebot uses
// these to build the `fields` object of its submit_order / submit_booking
// tools dynamically, so the realtime model returns answers under the tenant's
// EXACT field keys (no guessing, no hardcoded key drift).
export const voiceFormFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.string(),
  required: z.boolean(),
  options: z.array(z.string()).optional(),
});
export type VoiceFormField = z.infer<typeof voiceFormFieldSchema>;

// Structured shop-form config for the gateway. Null = ordering not enabled.
export const voiceOrderFormSchema = z.object({
  title: z.string(),
  currency: z.string(),
  fields: z.array(voiceFormFieldSchema),
  minOrderMinor: z.number().int().nullable(),
  deliveryFeeMinor: z.number().int().nullable(),
  freeDeliveryAboveMinor: z.number().int().nullable(),
  confirmationMessage: z.string().nullable(),
  intentKeywords: z.array(z.string()),
});

// Structured booking-form config. Null = bookings not enabled. `openSlots` are
// precomputed human labels (operator timezone) the bot may offer; empty when
// availability is off (the operator takes any requested time).
export const voiceBookingFormSchema = z.object({
  title: z.string(),
  fields: z.array(voiceFormFieldSchema),
  intentKeywords: z.array(z.string()),
  timezone: z.string().nullable(),
  openSlots: z.array(z.string()),
});

/** GET /voice/config response payload. */
export const voiceConfigSchema = z.object({
  // Full system-prompt for the realtime speech model, compiled from
  // BotConfig + BusinessInfo + catalog + FAQs. The voicebot passes this
  // verbatim as `session.instructions`.
  instructions: z.string(),
  // Exact first sentence the bot should speak when the call connects.
  // Null = the voicebot keeps its own default greeting.
  greeting: z.string().nullable(),
  // Comma-separated language codes from BotConfig.languages (e.g. "en,ar").
  languages: z.string(),
  businessName: z.string().nullable(),
  // Structured form config so the gateway can build dynamic tool params and
  // doesn't have to parse the prose prompt. Null when the feature is off.
  orderForm: voiceOrderFormSchema.nullable(),
  bookingForm: voiceBookingFormSchema.nullable(),
});

// The AudioSocket call UUID is dashed-lowercase hex (derived from SHA1 of the
// Asterisk UNIQUEID — not RFC 4122, so z.string().uuid() would reject it).
export const voiceCallUuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

export const startVoiceCallBodySchema = z.object({
  callUuid: voiceCallUuidSchema,
  // Caller ID as delivered by the PBX/gateway. Format varies per trunk, so
  // this is a free-form string, not E.164-validated.
  callerId: z.string().trim().max(64).nullish(),
  dialedExten: z.string().trim().max(32).nullish(),
  startedAt: z.string().datetime().optional(),
});
export type StartVoiceCallBody = z.infer<typeof startVoiceCallBodySchema>;

export const appendVoiceTurnsBodySchema = z.object({
  turns: z
    .array(
      z.object({
        // Client-assigned per-call monotonic sequence number. Makes the
        // append idempotent (unique on (voiceCallId, seq) + skipDuplicates —
        // a retried batch whose first attempt actually committed inserts
        // nothing) and gives the transcript a stable order tiebreak when
        // several turns share the same `at` millisecond.
        seq: z.number().int().min(0).max(1_000_000),
        role: z.enum(voiceTurnRoles),
        text: z.string().trim().min(1).max(8000),
        at: z.string().datetime().optional(),
      }),
    )
    .min(1)
    .max(50),
});
export type AppendVoiceTurnsBody = z.infer<typeof appendVoiceTurnsBodySchema>;

export const endVoiceCallBodySchema = z.object({
  outcome: z.enum(['completed', 'handoff', 'dropped']),
  reason: z.string().trim().max(500).nullish(),
  endedAt: z.string().datetime().optional(),
});
export type EndVoiceCallBody = z.infer<typeof endVoiceCallBodySchema>;

// POST /voice/calls/:uuid/order — the voicebot's `submit_order` tool. The model
// never sees SKUs (the spoken prompt lists items by name), so items arrive as
// spoken names + quantities and the server matches them to the catalog. Mirrors
// the WhatsApp/Messenger order: a real Cart (status 'new') is created.
//
// `fields` is keyed by the tenant's CONFIGURED shopForm field keys (the voicebot
// builds the tool params from /voice/config orderForm.fields), so answers land
// in the right operator columns instead of a hardcoded {address,notes} blob.
export const submitVoiceOrderBodySchema = z.object({
  items: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        quantity: z.number().int().min(1).max(999).default(1),
        notes: z.string().trim().max(300).nullish(),
      }),
    )
    .min(1)
    .max(50),
  customerName: z.string().trim().max(120).nullish(),
  // Defaults to the call's caller ID when omitted.
  phone: z.string().trim().max(40).nullish(),
  // Operator-configured shopForm answers, keyed by field `key`.
  fields: z.record(z.string(), z.string().max(2000)).optional(),
  // When true, append to the caller's most recent OPEN order instead of creating
  // a new one (returning-caller continuity / "add to my order").
  continueExisting: z.boolean().optional(),
});
export type SubmitVoiceOrderBody = z.infer<typeof submitVoiceOrderBodySchema>;

export const voiceOrderResultSchema = z.object({
  orderId: uuidSchema,
  itemsCount: z.number().int(),
  totalMinor: z.number().int(),
  currency: z.string(),
  // How many spoken items resolved to a catalog product, and which didn't
  // (those still land on the order at price 0, flagged needsPricing, for the
  // operator to price).
  matched: z.number().int(),
  unmatched: z.array(z.string()),
  // True when this submission was merged into an existing open order or was a
  // duplicate retry (idempotent) rather than a brand-new order.
  merged: z.boolean().default(false),
});

// POST /voice/calls/:uuid/booking — the voicebot's `submit_booking` tool. The
// answers are keyed by the tenant's bookingForm field keys (built from
// /voice/config bookingForm.fields). A real Booking (status 'new') is created.
export const submitVoiceBookingBodySchema = z.object({
  fields: z.record(z.string(), z.string().max(2000)),
  customerName: z.string().trim().max(120).nullish(),
  phone: z.string().trim().max(40).nullish(),
});
export type SubmitVoiceBookingBody = z.infer<typeof submitVoiceBookingBodySchema>;

export const voiceBookingResultSchema = z.object({
  bookingId: uuidSchema,
  // Resolved appointment instant (ISO) when a slot was matched, else null.
  appointmentAt: z.string().datetime().nullable(),
  // True when the matched slot was already at capacity (created with a warning
  // for the operator to review).
  slotWasFull: z.boolean(),
});

// GET /voice/caller-context?phone= — per-caller history injected into the
// realtime prompt at call start so a returning caller is greeted by name and
// can resume an open order or reorder. NEVER cached (caller-specific).
export const voiceCallerContextSchema = z.object({
  known: z.boolean(),
  name: z.string().nullable(),
  // The caller opted out (STOP) or was blocked by an operator — the bot must
  // stay silent / not market to them.
  optedOut: z.boolean(),
  blocked: z.boolean(),
  // The caller's most recent unfinished order, if any (resumable).
  openOrder: z
    .object({
      itemsSummary: z.string(),
      totalMinor: z.number().int(),
      currency: z.string(),
      status: z.string(),
      createdAt: z.string().datetime(),
    })
    .nullable(),
  // A few recent completed orders so the bot can offer "the usual".
  pastOrders: z.array(
    z.object({
      itemsSummary: z.string(),
      totalMinor: z.number().int(),
      currency: z.string(),
      createdAt: z.string().datetime(),
    }),
  ),
});
export type VoiceCallerContext = z.infer<typeof voiceCallerContextSchema>;

/** Portal-facing call summary (list + detail). */
export const voiceCallSchema = z.object({
  id: uuidSchema,
  callUuid: z.string(),
  callerId: z.string().nullable(),
  dialedExten: z.string().nullable(),
  outcome: z.enum(voiceCallOutcomes),
  handoffReason: z.string().nullable(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  turnCount: z.number().int(),
});

export const voiceCallTurnSchema = z.object({
  id: uuidSchema,
  role: z.enum(voiceTurnRoles),
  text: z.string(),
  at: z.string().datetime(),
});

export const voiceCallDetailSchema = voiceCallSchema.omit({ turnCount: true }).extend({
  turns: z.array(voiceCallTurnSchema),
});
