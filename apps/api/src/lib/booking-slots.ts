// Booking availability — weekly recurring slot generation + capacity.
//
// The operator configures weekly windows (day + start/end), a slot length, a
// per-slot capacity, a lead time, and a horizon, all in their timezone. From
// that we generate concrete bookable slots, drop any that are in the past / too
// soon / already at capacity, and hand the next open ones to the bot. Capacity
// is counted against Booking.appointmentAt (status != 'cancelled'), so once a
// slot fills it silently disappears from what the bot offers.
//
// No date library — timezone math uses Intl.DateTimeFormat (same approach as
// the broadcast send-window code).
// F-02: bot booking reads run under withTenant (RLS backstop) with an explicit
// organizationId filter retained as defence-in-depth.
//
// Google Calendar: when the org has a calendar connected with busy-blocking on,
// slots that collide with a timed event on that calendar are withheld too — so
// the bot never offers a time the owner is already booked for. That lookup is
// cached and fails open (see google-busy.ts), so an outage degrades to exactly
// the pre-Google behaviour rather than blocking bookings.
import { withTenant } from './db.js';
import { getBusyForOrg } from './google-busy.js';
import { overlapsBusy } from './google-calendar-events.js';

export interface BookingAvailability {
  enabled: boolean;
  timezone: string;
  slotMinutes: number;
  capacityPerSlot: number;
  leadMinutes: number;
  horizonDays: number;
  windows: { day: number; start: string; end: string }[];
}

export interface OpenSlot {
  /** Exact UTC instant of the slot start. */
  startUtc: Date;
  /** Human label in the operator's timezone, e.g. "Thu, Jun 19, 10:00 AM". */
  label: string;
}

/** tz offset in minutes (tz − UTC) at a given instant. */
function tzOffsetMinutes(date: Date, tz: string): number {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const parts = dtf.formatToParts(date);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
    const wallAsUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') % 24,
      get('minute'),
      get('second'),
    );
    return Math.round((wallAsUtc - date.getTime()) / 60000);
  } catch {
    return 0; // unknown tz → treat as UTC
  }
}

/** Convert a wall-clock time in `tz` to the matching UTC instant. */
function zonedWallToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offset = tzOffsetMinutes(new Date(guess), tz);
  return new Date(guess - offset * 60000);
}

/** The calendar Y/M/D of an instant as seen in `tz`. */
function dateInTz(date: Date, tz: string): { year: number; month: number; day: number } {
  try {
    const dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = dtf.formatToParts(date);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
    return { year: get('year'), month: get('month'), day: get('day') };
  } catch {
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
  }
}

/** Format a slot instant as a friendly label in `tz`. */
export function formatSlotLabel(date: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

/** All candidate slots in [now+lead, now+horizon], full or not. */
function candidateSlots(av: BookingAvailability, now: Date): OpenSlot[] {
  const out: OpenSlot[] = [];
  if (av.windows.length === 0) return out;
  const earliest = new Date(now.getTime() + av.leadMinutes * 60000);
  const base = dateInTz(now, av.timezone);
  const baseUtcMidday = Date.UTC(base.year, base.month - 1, base.day, 12, 0, 0);
  for (let d = 0; d < av.horizonDays; d++) {
    const dayDate = new Date(baseUtcMidday + d * 86400000);
    const y = dayDate.getUTCFullYear();
    const m = dayDate.getUTCMonth() + 1;
    const dom = dayDate.getUTCDate();
    const weekday = dayDate.getUTCDay(); // 0=Sun..6=Sat for that calendar date
    for (const w of av.windows.filter((x) => x.day === weekday)) {
      const [sh = 0, sm = 0] = w.start.split(':').map(Number);
      const [eh = 0, em = 0] = w.end.split(':').map(Number);
      const startMin = sh * 60 + sm;
      const endMin = eh * 60 + em;
      for (let cur = startMin; cur + av.slotMinutes <= endMin; cur += av.slotMinutes) {
        const startUtc = zonedWallToUtc(y, m, dom, Math.floor(cur / 60), cur % 60, av.timezone);
        if (startUtc.getTime() < earliest.getTime()) continue;
        out.push({ startUtc, label: formatSlotLabel(startUtc, av.timezone) });
      }
    }
  }
  out.sort((a, b) => a.startUtc.getTime() - b.startUtc.getTime());
  return out;
}

/** Map of slot-start-ms → number of live (non-cancelled) bookings. */
async function bookedCounts(orgId: string, slots: Date[]): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  if (slots.length === 0) return counts;
  const min = new Date(Math.min(...slots.map((s) => s.getTime())));
  const max = new Date(Math.max(...slots.map((s) => s.getTime())));
  const rows = await withTenant(orgId, (tx) =>
    tx.booking.findMany({
      where: {
        organizationId: orgId,
        appointmentAt: { gte: min, lte: max },
        status: { not: 'cancelled' },
      },
      select: { appointmentAt: true },
    }),
  );
  for (const r of rows) {
    if (!r.appointmentAt) continue;
    const k = r.appointmentAt.getTime();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

/** The next `limit` OPEN slots (capacity not yet reached). */
export async function computeOpenSlots(
  orgId: string,
  av: BookingAvailability,
  now: Date,
  limit = 8,
): Promise<OpenSlot[]> {
  if (!av.enabled) return [];
  const candidates = candidateSlots(av, now).slice(0, Math.max(limit * 6, 40));
  if (candidates.length === 0) return [];
  const counts = await bookedCounts(
    orgId,
    candidates.map((s) => s.startUtc),
  );
  // One Google lookup for the whole candidate span (cached per org per minute).
  const first = candidates[0]!.startUtc;
  const last = candidates[candidates.length - 1]!.startUtc;
  const busy = await getBusyForOrg(
    orgId,
    first,
    new Date(last.getTime() + av.slotMinutes * 60000),
  );
  const open = candidates.filter(
    (s) =>
      (counts.get(s.startUtc.getTime()) ?? 0) < av.capacityPerSlot &&
      !overlapsBusy(s.startUtc.getTime(), av.slotMinutes, busy),
  );
  return open.slice(0, limit);
}

/**
 * Resolve a free-text date the bot captured (ideally an offered slot label)
 * back to an exact slot instant. Matches against this availability's candidate
 * slots by normalised label so we can set Booking.appointmentAt precisely.
 * Returns null when nothing matches (operator resolves the date manually).
 */
export function resolveSlotFromText(
  text: string | null | undefined,
  av: BookingAvailability,
  now: Date,
): Date | null {
  if (!text || !av.enabled) return null;
  const norm = (s: string) => s.toLowerCase().replace(/[\s,]+/g, ' ').replace(/\s+/g, ' ').trim();
  const target = norm(text);
  if (!target) return null;
  // Look across a wide candidate set (full + open) so a just-filled slot still
  // resolves to its instant for the capacity recheck at capture.
  const candidates = candidateSlots(av, new Date(now.getTime() - 60 * 60000)).slice(0, 2000);
  for (const c of candidates) {
    if (norm(c.label) === target) return c.startUtc;
  }
  // Looser: the captured text contains the label or vice-versa.
  for (const c of candidates) {
    const l = norm(c.label);
    if (target.includes(l) || l.includes(target)) return c.startUtc;
  }
  return null;
}

/**
 * Availability check for a resolved slot: true when there's still room (live
 * bookings < capacity) AND the operator isn't busy there in Google Calendar.
 * Best-effort; callers wrap the create so a rare race only overshoots by one —
 * a booking is never rejected on this, only flagged for the operator.
 *
 * `slotMinutes` is optional so pre-existing callers keep compiling; without it
 * the Google check uses a 1-minute probe (start-instant collision only).
 */
export async function slotHasRoom(
  orgId: string,
  slotUtc: Date,
  capacity: number,
  slotMinutes = 1,
): Promise<boolean> {
  const count = await withTenant(orgId, (tx) =>
    tx.booking.count({
      where: { organizationId: orgId, appointmentAt: slotUtc, status: { not: 'cancelled' } },
    }),
  );
  if (count >= capacity) return false;
  const busy = await getBusyForOrg(
    orgId,
    slotUtc,
    new Date(slotUtc.getTime() + slotMinutes * 60000),
  );
  return !overlapsBusy(slotUtc.getTime(), slotMinutes, busy);
}
