// Pure event/busy logic for the Google Calendar integration.
//
// Deliberately imports NOTHING — no env, no db, no fetch. env.ts calls
// process.exit(1) when a variable is missing, so anything importing it can't be
// unit-tested on a developer machine (see vitest.pure.config.ts). Keeping the
// decisions that matter — what counts as busy, what collides with a slot — in
// here means they're covered by the pure hard gate. Same precedent as
// sales-scan-window.ts and contact-sync-normalize.ts.

/** Fallback length for an event Google returns without an end. */
const DEFAULT_DURATION_MIN = 60;

export interface RemoteEvent {
  id: string;
  /** Google hides titles on calendars shared as free/busy-only. */
  summary: string;
  startIso: string;
  endIso: string;
  allDay: boolean;
  /** Set when Hader created this event — i.e. it mirrors one of our bookings. */
  haderBookingId: string | null;
  /** Marked "free" in Google, or declined by this account. Never blocks a slot. */
  free: boolean;
  htmlLink: string | null;
}

/** The subset of Google's Events resource we read. */
export interface GoogleEventResource {
  id?: string;
  status?: string;
  summary?: string;
  htmlLink?: string;
  transparency?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { self?: boolean; responseStatus?: string }[];
  extendedProperties?: { private?: Record<string, string> };
}

/** Google's Events resource → our shape. Null when it isn't usable. */
export function normalizeEvent(e: GoogleEventResource): RemoteEvent | null {
  if (!e.id || e.status === 'cancelled') return null;
  // An all-day event carries `date` (YYYY-MM-DD, end exclusive) instead of
  // `dateTime`. Anchor it to local midnight so it lands on the right day.
  const allDay = !e.start?.dateTime;
  const rawStart = e.start?.dateTime ?? (e.start?.date ? `${e.start.date}T00:00:00` : null);
  const rawEnd = e.end?.dateTime ?? (e.end?.date ? `${e.end.date}T00:00:00` : null);
  if (!rawStart) return null;
  const start = new Date(rawStart);
  if (Number.isNaN(start.getTime())) return null;
  const parsedEnd = rawEnd ? new Date(rawEnd) : null;
  const end =
    parsedEnd && !Number.isNaN(parsedEnd.getTime())
      ? parsedEnd
      : new Date(start.getTime() + DEFAULT_DURATION_MIN * 60000);
  const declined = (e.attendees ?? []).some((a) => a.self && a.responseStatus === 'declined');
  return {
    id: e.id,
    summary: (e.summary ?? '').trim() || 'Busy',
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    allDay,
    haderBookingId: e.extendedProperties?.private?.haderBookingId ?? null,
    free: e.transparency === 'transparent' || declined,
    htmlLink: e.htmlLink ?? null,
  };
}

export interface BusyInterval {
  /** Epoch ms, half-open [start, end). */
  start: number;
  end: number;
}

/**
 * The subset of events that should stop a slot being offered.
 *
 * Three deliberate exclusions:
 *  • Hader's own events — a booking must not block the slot it occupies.
 *    (Without this, every booking would immediately block its own time and,
 *    at capacity > 1, the second seat could never be sold.)
 *  • Events marked "free" in Google, or ones this account declined.
 *  • All-day events. They're overwhelmingly informational (birthdays, holidays,
 *    "Ramadan"), and treating one as busy would silently wipe a whole day of
 *    bookable slots. Timed events are the honest signal of "I'm occupied".
 *    They still appear in the calendar overlay.
 */
export function toBusyIntervals(events: RemoteEvent[]): BusyInterval[] {
  const out: BusyInterval[] = [];
  for (const e of events) {
    if (e.haderBookingId || e.free || e.allDay) continue;
    const start = Date.parse(e.startIso);
    const end = Date.parse(e.endIso);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    out.push({ start, end });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Widen an arbitrary window to whole UTC days, and give it a cache key.
 *
 * The busy cache is keyed per day, so the window it stores MUST be describable
 * by that key. It wasn't: computeOpenSlots asks about a fortnight while
 * slotHasRoom asks about one 30-minute slot, and two slots on the same day
 * produced the same key for different questions — so a 10:00 lookup ("busy
 * between 10:00 and 10:30") was reused to answer "is 14:00 free?", and a real
 * afternoon meeting went unnoticed for the life of the cache entry.
 *
 * Normalising both the fetch and the key to day boundaries makes the key
 * honest, and has the happy side effect that every slot check on a given day
 * shares one Google call.
 */
export function dayWindow(from: Date, to: Date): { from: Date; to: Date; key: string } {
  const startOfUtcDay = (d: Date) =>
    new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const start = startOfUtcDay(from);
  // `to` is exclusive: a window ending exactly at midnight shouldn't pull in
  // the following day, so step back a millisecond before rounding up.
  const lastDay = startOfUtcDay(new Date(Math.max(from.getTime(), to.getTime() - 1)));
  const end = new Date(lastDay.getTime() + 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: start, to: end, key: `${iso(start)}:${iso(end)}` };
}

/** Does [startMs, startMs + durationMinutes) collide with any busy interval? */
export function overlapsBusy(
  startMs: number,
  durationMinutes: number,
  busy: BusyInterval[],
): boolean {
  const end = startMs + durationMinutes * 60000;
  // Half-open on both sides: an event ending exactly at the slot start, or
  // starting exactly at the slot end, does not collide — back-to-back
  // appointments are normal, not a clash.
  return busy.some((b) => b.start < end && b.end > startMs);
}
