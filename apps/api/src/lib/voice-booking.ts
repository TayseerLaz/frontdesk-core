// Voice booking capture — turns a structured booking from the phone voicebot's
// `submit_booking` tool into a real Booking (status 'new'), so it shows in
// /bookings and alerts operators. Mirrors the WhatsApp/Messenger captureBooking
// (cart-flow.ts) but is threadId-null safe: a phone call has no inbox thread, so
// we skip the WhatsApp note + thread-status writes that captureBooking hardcodes,
// and we stamp channel='voice' + callUuid for transcript linkage. Voice bookings
// get no reminder (callers aren't WhatsApp-reachable) — the reminder tick skips
// channel='voice'.
import type { BotData } from './bot-engine.js';
import type { BookingAvailability } from './booking-slots.js';
import { resolveSlotFromText, slotHasRoom } from './booking-slots.js';
import { withTenant } from './db.js';
import { createNotification } from './notifications.js';
import { emitWebhookEvent } from './webhooks.js';

export interface CreateVoiceBookingArgs {
  orgId: string;
  callUuid: string;
  /** Caller's phone (normalised), used as the booking's customerPhone. */
  callerPhone: string;
  customerName: string | null;
  /** Operator-configured bookingForm answers, keyed by field key. */
  fields: Record<string, string>;
  /** From gatherBotData — carries bookingForm (+ availability). */
  bookingForm: NonNullable<BotData['bookingForm']>;
}

export type VoiceBookingOutcome =
  | { ok: true; result: { bookingId: string; appointmentAt: string | null; slotWasFull: boolean } }
  | { ok: false; reason: 'disabled' }
  | { ok: false; reason: 'missing_required'; missing: string[] };

export async function createVoiceBooking(
  args: CreateVoiceBookingArgs,
): Promise<VoiceBookingOutcome> {
  const form = args.bookingForm;
  if (!form.enabled || form.fields.length === 0) return { ok: false, reason: 'disabled' };

  // Server-side required-field guard (parity with the voice order path).
  const missing = form.fields
    .filter((f) => f.required && !(args.fields[f.key] ?? '').trim())
    .map((f) => f.label);
  if (missing.length > 0) return { ok: false, reason: 'missing_required', missing };

  // Resolve the chosen slot → exact appointment instant when availability is on.
  // Try the explicit 'date'-type field first, then any field value that matches
  // an offered slot label. Capacity is re-checked so a rare race overshoots by
  // at most one (flagged for the operator).
  const av: BookingAvailability | null = form.availability ?? null;
  let appointmentAt: Date | null = null;
  let slotWasFull = false;
  if (av?.enabled) {
    const now = new Date();
    const dateField = form.fields.find((f) => f.type === 'date');
    const candidates = dateField ? [args.fields[dateField.key]] : Object.values(args.fields);
    for (const v of candidates) {
      const slot = resolveSlotFromText(v, av, now);
      if (slot) {
        appointmentAt = slot;
        break;
      }
    }
    if (appointmentAt) {
      // False when the slot is at capacity OR the operator is busy there in a
      // connected Google Calendar. Either way the booking is kept and flagged.
      slotWasFull = !(await slotHasRoom(
        args.orgId,
        appointmentAt,
        av.capacityPerSlot,
        av.slotMinutes,
      ));
    }
  }

  const fieldRows = form.fields.map((f) => ({
    key: f.key,
    label: f.label,
    type: f.type,
    required: f.required,
    value: (args.fields[f.key] ?? '').trim() || null,
  }));

  const created = await withTenant(args.orgId, (tx) =>
    tx.booking.create({
      data: {
        organizationId: args.orgId,
        threadId: null,
        channel: 'voice',
        callUuid: args.callUuid,
        customerPhone: args.callerPhone,
        customerName: args.customerName,
        fields: fieldRows as never,
        status: 'new',
        appointmentAt,
        ...(slotWasFull
          ? {
              notes:
                '⚠ Slot was unavailable when booked (at capacity, or busy in Google Calendar) — please review.',
            }
          : {}),
      },
      select: { id: true },
    }),
  );

  void emitWebhookEvent({
    organizationId: args.orgId,
    eventKind: 'booking_created',
    payload: { id: created.id, source: 'voice', customerPhone: args.callerPhone, fields: fieldRows },
  }).catch(() => undefined);

  // Calendar event + auto-confirm for phone bookings too. No message is
  // returned: a meeting link can't be read down a phone line, and the caller
  // has no chat thread to send it to. If the call captured an email address,
  // Google emails them the invitation — which carries the Meet link — so the
  // online case still reaches them.
  void (async () => {
    try {
      const { confirmBooking } = await import('./booking-confirm.js');
      await confirmBooking({
        orgId: args.orgId,
        bookingId: created.id,
        customerName: args.customerName ?? null,
        customerPhone: args.callerPhone,
        fields: fieldRows,
        appointmentAt,
        slotMinutes: av?.slotMinutes ?? 60,
        timezone: av?.timezone ?? 'UTC',
      });
    } catch {
      /* non-fatal: the sync tick places the event later */
    }
  })();

  void createNotification({
    organizationId: args.orgId,
    kind: 'booking_received',
    severity: slotWasFull ? 'warning' : 'info',
    title: `Voice booking · ${form.title}`,
    body:
      `${args.customerName ?? args.callerPhone}` +
      (slotWasFull ? ' · ⚠ slot was unavailable, review' : ''),
    link: '/bookings',
    entityType: 'booking',
    entityId: created.id,
  }).catch(() => undefined);

  return {
    ok: true,
    result: {
      bookingId: created.id,
      appointmentAt: appointmentAt ? appointmentAt.toISOString() : null,
      slotWasFull,
    },
  };
}
