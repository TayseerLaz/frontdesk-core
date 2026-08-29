import { z } from 'zod';

import { CONTACT_KINDS, DAYS_OF_WEEK, FaqVisibility, POLICY_KINDS } from '../enums/catalog.js';
import { uuidSchema } from './common.js';

const currency3 = z.string().length(3).regex(/^[A-Z]{3}$/);
const country2 = z.string().length(2).regex(/^[A-Z]{2}$/);
const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');

export const operatingHoursDaySchema = z.array(
  z
    .object({ open: timeOfDay, close: timeOfDay })
    // Allow OVERNIGHT ranges (close <= open means "closes after midnight"):
    // a dessert shop open 18:00–00:00 or a bar open 20:00–02:00 is normal and
    // must be saveable. A close of "00:00" reads as midnight / end of day. The
    // only invalid case is a zero-length range (open === close). Nothing
    // downstream computes on open < close — formatOperatingHours just renders
    // the range as text for the bot.
    .refine((v) => v.open !== v.close, 'open and close cannot be identical'),
);

export const operatingHoursSchema = z.object(
  Object.fromEntries(DAYS_OF_WEEK.map((d) => [d, operatingHoursDaySchema])) as Record<
    (typeof DAYS_OF_WEEK)[number],
    typeof operatingHoursDaySchema
  >,
);

export const hoursExceptionSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  closed: z.boolean(),
  open: timeOfDay.optional(),
  close: timeOfDay.optional(),
  note: z.string().max(200).optional(),
});

// Booking form — operator-defined intake the AI bot asks customers to fill
// in when they want to book a meeting / consultation / appointment.
export const BOOKING_FIELD_TYPES = ['text', 'email', 'phone', 'date', 'time', 'number', 'long_text'] as const;
export type BookingFieldType = (typeof BOOKING_FIELD_TYPES)[number];

export const bookingFormFieldSchema = z.object({
  key: z.string().trim().min(1).max(60).regex(/^[a-z][a-z0-9_]*$/i, 'lowercase letters + digits + _'),
  label: z.string().trim().min(1).max(120),
  type: z.enum(BOOKING_FIELD_TYPES).default('text'),
  required: z.boolean().default(true),
});

// Weekly recurring availability for bookings. When enabled, the bot offers
// only OPEN slots (generated from these windows, minus any at/over capacity)
// and resolves the chosen slot to an exact appointment time.
export const bookingAvailabilityWindowSchema = z.object({
  // 0 = Sunday … 6 = Saturday
  day: z.number().int().min(0).max(6),
  start: z.string().regex(/^\d{2}:\d{2}$/, 'HH:MM'),
  end: z.string().regex(/^\d{2}:\d{2}$/, 'HH:MM'),
});

export const bookingAvailabilitySchema = z
  .object({
    enabled: z.boolean().default(false),
    // IANA timezone the windows are expressed in (e.g. "Asia/Beirut").
    timezone: z.string().trim().min(1).max(64).default('UTC'),
    // Length of each bookable slot, in minutes.
    slotMinutes: z.number().int().min(5).max(480).default(30),
    // How many bookings fit in one slot before it's hidden as full.
    capacityPerSlot: z.number().int().min(1).max(1000).default(1),
    // Minimum notice before a slot can be booked (minutes).
    leadMinutes: z.number().int().min(0).max(43200).default(0),
    // How many days ahead to offer slots.
    horizonDays: z.number().int().min(1).max(120).default(14),
    windows: z.array(bookingAvailabilityWindowSchema).max(100).default([]),
  })
  .strict();
export type BookingAvailabilityDto = z.infer<typeof bookingAvailabilitySchema>;

export const bookingFormSchema = z
  .object({
    enabled: z.boolean().default(false),
    title: z.string().trim().min(1).max(200).default('Book a consultation'),
    intentKeywords: z.array(z.string().trim().min(1).max(60)).max(40).default([]),
    fields: z.array(bookingFormFieldSchema).max(40).default([]),
    // Optional weekly availability. Null/absent = old behaviour (bot collects a
    // free-text date with no slot/capacity enforcement).
    availability: bookingAvailabilitySchema.nullable().default(null),
  })
  .strict();
export type BookingFormDto = z.infer<typeof bookingFormSchema>;
export type BookingFormField = z.infer<typeof bookingFormFieldSchema>;

// ---- Shop form -----------------------------------------------------------
// Mirrors bookingForm in shape. Drives the AI bot's cart-building flow:
// the bot detects intent via intentKeywords, asks for each `fields[]`
// entry once the cart is settled, applies the configured fees, and emits
// a [CART: {...}] marker on confirmation.
export const SHOP_FIELD_TYPES = [
  'text',
  'email',
  'phone',
  'date',
  'time',
  'datetime',
  'number',
  'long_text',
  'select',
] as const;
export type ShopFieldType = (typeof SHOP_FIELD_TYPES)[number];

export const shopFormFieldSchema = z.object({
  key: z.string().trim().min(1).max(60).regex(/^[a-z][a-z0-9_]*$/i, 'lowercase letters + digits + _'),
  label: z.string().trim().min(1).max(120),
  type: z.enum(SHOP_FIELD_TYPES).default('text'),
  required: z.boolean().default(true),
  // Optional select-only choices. Ignored for other types.
  options: z.array(z.string().trim().min(1).max(80)).max(40).optional(),
});

export const shopFormSchema = z
  .object({
    enabled: z.boolean().default(false),
    title: z.string().trim().min(1).max(200).default('Place an order'),
    intentKeywords: z
      .array(z.string().trim().min(1).max(60))
      .max(40)
      .default(['order', 'buy', 'delivery', 'menu', 'want', 'get']),
    fields: z.array(shopFormFieldSchema).max(40).default([]),
    // Money fields in minor units (e.g. fils for KWD, cents for USD).
    // null = no constraint (default for new orgs).
    minOrderMinor: z.number().int().nonnegative().nullable().default(null),
    deliveryFeeMinor: z.number().int().nonnegative().nullable().default(null),
    freeDeliveryAboveMinor: z.number().int().nonnegative().nullable().default(null),
    // Confirmation text the bot sends when the cart is placed. Supports
    // {{cart_id_short}} and {{total}} placeholders.
    confirmationMessage: z
      .string()
      .trim()
      .max(800)
      .default("Got it! Your order is in 🙏 We'll be in touch shortly."),
    // Public menu URL — the operator's online menu / catalog page.
    // When set, the bot sends this link whenever the customer asks
    // about the menu / what's available / "show me your menu". Stored
    // as a string (not URL-typed) so the operator can paste anything;
    // empty/null means "no menu link configured — skip the rule".
    menuUrl: z.string().trim().max(500).nullable().default(null),
    // Serviceable delivery areas (free-text city / district / zone names,
    // e.g. ["Salmiya", "Hawalli"]). When non-empty the bot only accepts
    // delivery to these areas; for an out-of-area address it politely
    // declines + offers pickup or a teammate and does NOT confirm the order.
    // Empty = deliver anywhere (no constraint). Fixes the "Beirut address on
    // a Kuwait shop" class where the bot blindly accepted undeliverable orders.
    deliveryAreas: z.array(z.string().trim().min(1).max(80)).max(60).default([]),
  })
  .strict();
export type ShopFormDto = z.infer<typeof shopFormSchema>;
export type ShopFormField = z.infer<typeof shopFormFieldSchema>;

export const businessInfoSchema = z.object({
  id: uuidSchema,
  legalName: z.string().nullable(),
  tagline: z.string().nullable(),
  about: z.string().nullable(),
  websiteUrl: z.string().url().nullable(),
  operatingHours: operatingHoursSchema.nullable(),
  hoursExceptions: z.array(hoursExceptionSchema).nullable(),
  timezone: z.string(),
  currency: currency3,
  metadata: z.record(z.string(), z.unknown()).nullable(),
  bookingForm: bookingFormSchema.nullable(),
  shopForm: shopFormSchema.nullable(),
  updatedAt: z.string().datetime(),
});
export type BusinessInfoDto = z.infer<typeof businessInfoSchema>;

export const upsertBusinessInfoBodySchema = z.object({
  legalName: z.string().trim().max(200).nullable().optional(),
  tagline: z.string().trim().max(200).nullable().optional(),
  about: z.string().max(20000).nullable().optional(),
  websiteUrl: z.string().url().nullable().optional(),
  operatingHours: operatingHoursSchema.nullable().optional(),
  hoursExceptions: z.array(hoursExceptionSchema).nullable().optional(),
  timezone: z.string().min(1).max(80).optional(),
  currency: currency3.optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  bookingForm: bookingFormSchema.nullable().optional(),
  shopForm: shopFormSchema.nullable().optional(),
});
export type UpsertBusinessInfoBody = z.infer<typeof upsertBusinessInfoBodySchema>;

// ---------- locations -------------------------------------------------------
export const locationSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  postalCode: z.string().nullable(),
  country: country2.nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  phone: z.string().nullable(),
  email: z.string().email().nullable(),
  isPrimary: z.boolean(),
  sortOrder: z.number().int(),
});
export type LocationDto = z.infer<typeof locationSchema>;

export const upsertLocationBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  addressLine1: z.string().max(200).nullable().optional(),
  addressLine2: z.string().max(200).nullable().optional(),
  city: z.string().max(120).nullable().optional(),
  region: z.string().max(120).nullable().optional(),
  postalCode: z.string().max(20).nullable().optional(),
  country: country2.nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  email: z.string().email().nullable().optional(),
  isPrimary: z.boolean().optional(),
});

// ---------- contact channels ------------------------------------------------
export const contactChannelSchema = z.object({
  id: uuidSchema,
  kind: z.enum(CONTACT_KINDS),
  label: z.string().nullable(),
  value: z.string(),
  isPrimary: z.boolean(),
  sortOrder: z.number().int(),
});

export const upsertContactChannelBodySchema = z.object({
  kind: z.enum(CONTACT_KINDS),
  label: z.string().max(80).nullable().optional(),
  value: z.string().trim().min(1).max(200),
  isPrimary: z.boolean().optional(),
});

// ---------- faqs ------------------------------------------------------------
export const faqSchema = z.object({
  id: uuidSchema,
  question: z.string(),
  answer: z.string(),
  tags: z.array(z.string()),
  visibility: z.nativeEnum(FaqVisibility),
  sortOrder: z.number().int(),
  isPublished: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type FaqDto = z.infer<typeof faqSchema>;

export const createFaqBodySchema = z.object({
  question: z.string().trim().min(2).max(500),
  answer: z.string().trim().min(2).max(20000),
  tags: z.array(z.string().max(40)).max(20).optional(),
  visibility: z.nativeEnum(FaqVisibility).optional(),
  sortOrder: z.number().int().optional(),
  isPublished: z.boolean().optional(),
});
export type CreateFaqBody = z.infer<typeof createFaqBodySchema>;
export const updateFaqBodySchema = createFaqBodySchema.partial();

export const reorderFaqsBodySchema = z.object({
  order: z.array(z.object({ id: uuidSchema, sortOrder: z.number().int() })).min(1),
});

// ---------- policies --------------------------------------------------------
export const policySchema = z.object({
  id: uuidSchema,
  kind: z.enum(POLICY_KINDS),
  title: z.string(),
  content: z.string(),
  isPublished: z.boolean(),
  sortOrder: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PolicyDto = z.infer<typeof policySchema>;

export const upsertPolicyBodySchema = z.object({
  kind: z.enum(POLICY_KINDS),
  title: z.string().trim().min(1).max(200),
  content: z.string().min(1).max(50000),
  isPublished: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});
export type UpsertPolicyBody = z.infer<typeof upsertPolicyBodySchema>;
