// Booking → Google Calendar → meeting link.
//
// Called right after a booking is captured, on every channel, once the
// enclosing transaction has COMMITTED — this makes a network call to Google
// and must never run inside a Postgres transaction.
//
// Fails soft by design: if Google is unreachable, the booking still exists and
// the customer is still served. The two-minute sync tick picks the event up
// afterwards; only the instant meeting link is lost, and the tick's backfill
// query catches the booking because it has no googleEventId yet.
import { withRlsBypass } from './db.js';
import {
  decideConfirm,
  formatWhen,
  isArabic,
  pickAttendeeEmail,
  type MeetingMode,
} from './booking-confirm-text.js';
import { confirmationText } from './booking-confirm-text.js';
import { getConnection, pushBooking, type GcalConnection, type SyncableBooking } from './google-calendar.js';

export interface ConfirmBookingArgs {
  orgId: string;
  bookingId: string;
  customerName: string | null;
  customerPhone: string;
  fields: { key?: string; label?: string; type?: string; value?: unknown }[];
  notes?: string | null;
  appointmentAt: Date | null;
  /** Slot length, so the event blocks the right amount of time. */
  slotMinutes: number;
  timezone: string;
  businessName?: string | null;
  /** Street address, used for onsite businesses. */
  address?: string | null;
  /** The customer's own words, to mirror their language. */
  customerText?: string | null;
}

export interface ConfirmBookingResult {
  /** Ready-to-send confirmation, or null when nothing should be sent. */
  message: string | null;
  meetLink: string | null;
  confirmed: boolean;
}

/**
 * Push the booking to the calendar, optionally confirm it, and return the
 * message the channel should send. Returns null when the tenant has no
 * calendar connected or has calendar pushing switched off — in which case the
 * booking behaves exactly as it did before this feature existed.
 */
export async function confirmBooking(args: ConfirmBookingArgs): Promise<ConfirmBookingResult | null> {
  let conn: Awaited<ReturnType<typeof getConnection>> = null;
  try {
    conn = await getConnection(args.orgId);
  } catch (err) {
    console.warn('[booking-confirm] connection lookup failed', args.orgId, err);
    return null;
  }

  const decision = decideConfirm({
    connected: !!conn,
    pushBookings: conn?.pushBookings ?? false,
    meetingMode: (conn?.meetingMode as MeetingMode) ?? 'onsite',
    autoConfirm: conn?.autoConfirm ?? false,
    hasAppointment: !!args.appointmentAt,
  });
  if (!decision.push || !conn) return null;

  let eventId: string | null = null;
  let meetLink: string | null = null;
  try {
    const res = await pushBooking(
      conn as GcalConnection,
      {
        id: args.bookingId,
        customerName: args.customerName,
        customerPhone: args.customerPhone,
        fields: args.fields,
        notes: args.notes ?? null,
        appointmentAt: args.appointmentAt,
        googleEventId: null,
        status: 'new',
      } as unknown as SyncableBooking,
      args.slotMinutes,
      {
        withMeet: decision.withMeet,
        attendeeEmail: pickAttendeeEmail(args.fields),
        location: decision.withMeet ? null : (args.address ?? null),
      },
    );
    eventId = res.eventId;
    meetLink = res.meetLink;
  } catch (err) {
    // Google is down / the token was revoked / Meet is blocked on this
    // account. The booking stands; the tick will place the event later.
    console.warn('[booking-confirm] push failed, leaving it to the tick', args.bookingId, err);
    return null;
  }

  try {
    await withRlsBypass((tx) =>
      tx.booking.update({
        where: { id: args.bookingId },
        data: {
          googleEventId: eventId,
          googleSyncedAt: new Date(),
          ...(decision.confirm ? { status: 'confirmed' as never } : {}),
        },
      }),
    );
  } catch (err) {
    // The event exists on the calendar but we failed to record it. The tick
    // would then create a SECOND event, so this is worth shouting about.
    console.error('[booking-confirm] event created but booking not updated', args.bookingId, err);
  }

  const arabic = isArabic(args.customerText);
  const message = args.appointmentAt
    ? confirmationText({
        when: formatWhen(args.appointmentAt, args.timezone, arabic),
        arabic,
        meetLink,
        address: decision.withMeet ? null : (args.address ?? null),
        businessName: args.businessName ?? null,
      })
    : null;

  return { message, meetLink, confirmed: decision.confirm };
}
