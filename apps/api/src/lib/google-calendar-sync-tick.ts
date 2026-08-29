// Google Calendar sync backstop.
//
// Bookings are captured from many paths (voice, WhatsApp, Messenger, manual),
// so rather than hook every one, this tick runs in the API process and pushes
// any booking that needs it to the tenant's connected calendar: create/update
// for bookings with a time, delete for cancelled ones. Idempotent — already-
// synced, unchanged bookings are skipped, so steady-state ticks are cheap.
// (Hard-deletes are handled synchronously in the bookings DELETE route, since
// the row is gone by tick time.)
import { prisma } from '@platform/db';

import { withRlsBypass } from './db.js';
import {
  deleteRemoteEvent,
  googleCalendarConfigured,
  pushBooking,
  type GcalConnection,
  type SyncableBooking,
} from './google-calendar.js';

const TICK_INTERVAL_MS = Number(process.env.GCAL_TICK_INTERVAL_MS ?? 2 * 60 * 1000); // 2 min
const PER_TICK = 200; // max bookings synced per tick
const RESYNC_TOLERANCE_MS = 5000; // edits within 5s of the last sync are the sync itself
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // only reconcile recently-touched bookings

let stopped = false;
let timer: ReturnType<typeof setTimeout> | null = null;

const isCancelled = (status: string): boolean => /cancel/i.test(status);

async function tick(): Promise<void> {
  if (!googleCalendarConfigured()) return;
  const conns = await withRlsBypass((tx) => tx.googleCalendarConnection.findMany());
  if (conns.length === 0) return;

  let budget = PER_TICK;
  const since = new Date(Date.now() - WINDOW_MS);

  const now = new Date();

  for (const conn of conns) {
    if (budget <= 0) break;

    // The tenant's slot length decides how long a booking blocks out. Without
    // it every booking would occupy an hour, so a salon on 30-minute slots
    // would see its calendar twice as full as it really is.
    const info = await withRlsBypass((tx) =>
      tx.businessInfo.findFirst({
        where: { organizationId: conn.organizationId },
        select: { bookingForm: true },
      }),
    );
    const slotMinutes =
      (info?.bookingForm as { availability?: { slotMinutes?: number } } | null)?.availability
        ?.slotMinutes ?? 60;

    const select = {
      id: true,
      customerName: true,
      customerPhone: true,
      fields: true,
      notes: true,
      appointmentAt: true,
      googleEventId: true,
      status: true,
      updatedAt: true,
      googleSyncedAt: true,
    } as const;

    // (a) Recently touched bookings — the steady-state reconcile.
    const recent = await withRlsBypass((tx) =>
      tx.booking.findMany({
        where: {
          organizationId: conn.organizationId,
          updatedAt: { gte: since },
          OR: [{ appointmentAt: { not: null } }, { googleEventId: { not: null } }],
        },
        select,
        orderBy: { updatedAt: 'desc' },
        take: 100,
      }),
    );

    // (b) Future bookings that have never reached the calendar. Its own query
    // rather than a widened filter on (a): a tenant connecting today has
    // appointments booked months ago, whose updatedAt is far outside the
    // 30-day window, and ordering by updatedAt would bury them behind current
    // churn forever. This also self-heals anything an earlier tick dropped.
    const unsynced = await withRlsBypass((tx) =>
      tx.booking.findMany({
        where: {
          organizationId: conn.organizationId,
          appointmentAt: { gte: now },
          googleEventId: null,
          status: { not: 'cancelled' },
        },
        select,
        orderBy: { appointmentAt: 'asc' },
        take: 50,
      }),
    );

    const seen = new Set(recent.map((r) => r.id));
    const rows = [...recent, ...unsynced.filter((r) => !seen.has(r.id))];

    for (const b of rows) {
      if (budget <= 0) break;
      try {
        // Cancelled (or lost its time) but still on the calendar → remove it.
        if (b.googleEventId && (isCancelled(b.status) || !b.appointmentAt)) {
          await deleteRemoteEvent(conn as GcalConnection, b.googleEventId);
          await withRlsBypass((tx) =>
            tx.booking.update({
              where: { id: b.id },
              data: { googleEventId: null, googleSyncedAt: new Date() },
            }),
          );
          budget--;
          continue;
        }
        // Active booking with a time → create or update the event, but only if
        // it's new or edited since the last sync (tolerance avoids the sync's
        // own updatedAt bump re-triggering forever).
        if (b.appointmentAt && !isCancelled(b.status)) {
          const needs =
            !b.googleEventId ||
            !b.googleSyncedAt ||
            b.updatedAt.getTime() - b.googleSyncedAt.getTime() > RESYNC_TOLERANCE_MS;
          if (!needs) continue;
          const pushed = await pushBooking(
            conn as GcalConnection,
            b as SyncableBooking,
            slotMinutes,
          );
          const eventId = pushed.eventId;
          await withRlsBypass((tx) =>
            tx.booking.update({
              where: { id: b.id },
              data: { googleEventId: eventId, googleSyncedAt: new Date() },
            }),
          );
          budget--;
        }
      } catch (err) {
        console.warn('[gcal-tick] booking sync failed', b.id, err);
      }
    }
  }
}

export function startGoogleCalendarSyncTick(): { name: string; close: () => Promise<void> } {
  const run = async () => {
    if (stopped) return;
    try {
      await tick();
    } catch (err) {
      console.error('[gcal-tick] error', err);
    }
    if (!stopped) timer = setTimeout(run, TICK_INTERVAL_MS);
  };
  timer = setTimeout(run, 100 * 1000); // first run ~100s after boot
  return {
    name: 'google-calendar-sync-tick',
    close: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
