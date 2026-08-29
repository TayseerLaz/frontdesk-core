import { z } from 'zod';

import { bookingFormFieldSchema } from './business-info.js';
import { uuidSchema } from './common.js';

export const BOOKING_STATUSES = ['new', 'confirmed', 'completed', 'cancelled'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

// Frozen snapshot field on a booking row: the same shape as the operator's
// BookingFormField plus the value the customer answered. value is loose by
// design so the AI can write strings/numbers/dates without us 400ing.
export const bookingAnswerSchema = bookingFormFieldSchema.extend({
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).nullable().default(null),
});
export type BookingAnswer = z.infer<typeof bookingAnswerSchema>;

export const bookingSchema = z.object({
  id: uuidSchema,
  threadId: uuidSchema.nullable(),
  customerPhone: z.string(),
  customerName: z.string().nullable(),
  fields: z.array(bookingAnswerSchema),
  status: z.enum(BOOKING_STATUSES),
  notes: z.string().nullable(),
  // Resolved appointment timestamp (UTC ISO). NULL when the row's date/
  // time fields couldn't be parsed or the operator hasn't enabled a
  // reminder yet.
  appointmentAt: z.string().datetime().nullable(),
  // Operator-picked WhatsApp template that fires 2h before appointmentAt.
  // NULL = reminder disabled. Must reference an `approved` template at
  // send time; we re-check inside the tick worker.
  reminderTemplateId: uuidSchema.nullable(),
  // Set after the reminder is delivered to Meta. Suppresses re-fires.
  reminderSentAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type BookingDto = z.infer<typeof bookingSchema>;

export const bookingListQuerySchema = z.object({
  status: z.enum(BOOKING_STATUSES).optional(),
  q: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});
export type BookingListQuery = z.infer<typeof bookingListQuerySchema>;

export const createBookingBodySchema = z.object({
  threadId: uuidSchema.nullable().optional(),
  customerPhone: z.string().trim().min(3).max(40),
  customerName: z.string().trim().max(200).nullable().optional(),
  fields: z.array(bookingAnswerSchema).max(40),
  status: z.enum(BOOKING_STATUSES).optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export const updateBookingBodySchema = z.object({
  customerName: z.string().trim().max(200).nullable().optional(),
  fields: z.array(bookingAnswerSchema).max(40).optional(),
  status: z.enum(BOOKING_STATUSES).optional(),
  notes: z.string().max(2000).nullable().optional(),
  // Reminder configuration. The bookings page computes appointmentAt
  // client-side from the parsed date/time fields and sends both keys
  // when the operator toggles a template on; passing reminderTemplateId
  // null clears the reminder.
  appointmentAt: z.string().datetime().nullable().optional(),
  reminderTemplateId: uuidSchema.nullable().optional(),
});
