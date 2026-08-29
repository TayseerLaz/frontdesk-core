// Pure-logic gate for the Google Calendar → Hader direction. Runs with NO
// database and NO environment (vitest.pure.config.ts), so it's runnable on a
// developer machine before pushing.
//
// What's asserted here is the part that can silently do damage: deciding a
// tenant is "busy" wrongly either hides bookable slots from paying customers
// (too eager) or double-books the owner (too lax). Both fail quietly — the
// calendar still renders, the bot still replies — so the rules are pinned.
import { describe, expect, it } from 'vitest';

import {
  dayWindow,
  normalizeEvent,
  overlapsBusy,
  toBusyIntervals,
  type BusyInterval,
  type GoogleEventResource,
  type RemoteEvent,
} from '../../src/lib/google-calendar-events.js';

const EVENT = (over: Partial<RemoteEvent> = {}): RemoteEvent => ({
  id: 'e1',
  summary: 'Dentist',
  startIso: '2026-08-10T09:00:00.000Z',
  endIso: '2026-08-10T10:00:00.000Z',
  allDay: false,
  haderBookingId: null,
  free: false,
  htmlLink: null,
  ...over,
});

const at = (iso: string) => Date.parse(iso);

describe('normalizeEvent', () => {
  it('reads a timed event', () => {
    const e = normalizeEvent({
      id: 'abc',
      summary: '  Haircut  ',
      start: { dateTime: '2026-08-10T09:00:00Z' },
      end: { dateTime: '2026-08-10T09:45:00Z' },
      htmlLink: 'https://calendar.google.com/x',
    })!;
    expect(e.summary).toBe('Haircut');
    expect(e.allDay).toBe(false);
    expect(e.endIso).toBe('2026-08-10T09:45:00.000Z');
    expect(e.free).toBe(false);
    expect(e.htmlLink).toBe('https://calendar.google.com/x');
  });

  it('flags all-day events, which carry `date` not `dateTime`', () => {
    const e = normalizeEvent({
      id: 'abc',
      summary: 'Public holiday',
      start: { date: '2026-08-10' },
      end: { date: '2026-08-11' },
    })!;
    expect(e.allDay).toBe(true);
  });

  it('drops cancelled events and events with no id or start', () => {
    expect(normalizeEvent({ id: 'a', status: 'cancelled', start: { dateTime: '2026-08-10T09:00:00Z' } })).toBeNull();
    expect(normalizeEvent({ start: { dateTime: '2026-08-10T09:00:00Z' } })).toBeNull();
    expect(normalizeEvent({ id: 'a' })).toBeNull();
  });

  it('titles a title-less event rather than rendering a blank chip', () => {
    const e = normalizeEvent({ id: 'a', start: { dateTime: '2026-08-10T09:00:00Z' } })!;
    expect(e.summary).toBe('Busy');
  });

  it('falls back to a 60-minute end when Google returns none', () => {
    const e = normalizeEvent({ id: 'a', start: { dateTime: '2026-08-10T09:00:00Z' } })!;
    expect(e.endIso).toBe('2026-08-10T10:00:00.000Z');
  });

  it('treats transparent and self-declined events as free', () => {
    const transparent = normalizeEvent({
      id: 'a',
      transparency: 'transparent',
      start: { dateTime: '2026-08-10T09:00:00Z' },
    })!;
    const declined = normalizeEvent({
      id: 'b',
      start: { dateTime: '2026-08-10T09:00:00Z' },
      attendees: [{ self: true, responseStatus: 'declined' }],
    })!;
    // Someone ELSE declining is irrelevant — the owner is still going.
    const otherDeclined = normalizeEvent({
      id: 'c',
      start: { dateTime: '2026-08-10T09:00:00Z' },
      attendees: [{ self: false, responseStatus: 'declined' }],
    })!;
    expect(transparent.free).toBe(true);
    expect(declined.free).toBe(true);
    expect(otherDeclined.free).toBe(false);
  });

  it('surfaces the Hader booking id so our own events can be excluded', () => {
    const e = normalizeEvent({
      id: 'a',
      start: { dateTime: '2026-08-10T09:00:00Z' },
      extendedProperties: { private: { haderBookingId: 'b-123' } },
    } as GoogleEventResource)!;
    expect(e.haderBookingId).toBe('b-123');
  });
});

describe('toBusyIntervals', () => {
  it("never blocks on Hader's own events — a booking must not block its own slot", () => {
    expect(toBusyIntervals([EVENT({ haderBookingId: 'b-1' })])).toEqual([]);
  });

  it('ignores free / declined events', () => {
    expect(toBusyIntervals([EVENT({ free: true })])).toEqual([]);
  });

  it("ignores all-day events so a birthday doesn't wipe a day of slots", () => {
    expect(toBusyIntervals([EVENT({ allDay: true })])).toEqual([]);
  });

  it('keeps ordinary timed events, sorted by start', () => {
    const busy = toBusyIntervals([
      EVENT({ id: 'late', startIso: '2026-08-10T15:00:00Z', endIso: '2026-08-10T16:00:00Z' }),
      EVENT({ id: 'early', startIso: '2026-08-10T09:00:00Z', endIso: '2026-08-10T10:00:00Z' }),
    ]);
    expect(busy).toHaveLength(2);
    expect(busy[0]!.start).toBe(at('2026-08-10T09:00:00Z'));
    expect(busy[1]!.start).toBe(at('2026-08-10T15:00:00Z'));
  });

  it('discards zero-length and inverted intervals', () => {
    const busy = toBusyIntervals([
      EVENT({ id: 'zero', startIso: '2026-08-10T09:00:00Z', endIso: '2026-08-10T09:00:00Z' }),
      EVENT({ id: 'inverted', startIso: '2026-08-10T11:00:00Z', endIso: '2026-08-10T10:00:00Z' }),
      EVENT({ id: 'bad', startIso: 'not-a-date', endIso: 'also-not' }),
    ]);
    expect(busy).toEqual([]);
  });
});

describe('overlapsBusy', () => {
  const busy: BusyInterval[] = [
    { start: at('2026-08-10T09:00:00Z'), end: at('2026-08-10T10:00:00Z') },
  ];

  it('blocks a slot that starts inside the event', () => {
    expect(overlapsBusy(at('2026-08-10T09:30:00Z'), 30, busy)).toBe(true);
  });

  it('blocks a slot that merely clips the end of the event', () => {
    // 08:45–09:15 overlaps the 09:00 start by 15 minutes.
    expect(overlapsBusy(at('2026-08-10T08:45:00Z'), 30, busy)).toBe(true);
  });

  it('blocks a slot that fully contains the event', () => {
    expect(overlapsBusy(at('2026-08-10T08:00:00Z'), 180, busy)).toBe(true);
  });

  it('allows back-to-back: a slot starting exactly when the event ends', () => {
    expect(overlapsBusy(at('2026-08-10T10:00:00Z'), 30, busy)).toBe(false);
  });

  it('allows a slot ending exactly when the event starts', () => {
    expect(overlapsBusy(at('2026-08-10T08:30:00Z'), 30, busy)).toBe(false);
  });

  it('allows everything when nothing is busy — the fail-open shape', () => {
    expect(overlapsBusy(at('2026-08-10T09:30:00Z'), 30, [])).toBe(false);
  });
});

describe('dayWindow', () => {
  // Regression: the busy cache is keyed per day, but callers asked about
  // windows of wildly different sizes. Two slot checks on the same day shared
  // a key while asking different questions, so the answer to "is 10:00 free?"
  // was served as the answer to "is 14:00 free?" — and an afternoon meeting
  // went unseen. The window must now be exactly what the key describes.
  it('gives two slots on the same day the SAME key and the SAME window', () => {
    const morning = dayWindow(new Date('2026-08-05T10:00:00Z'), new Date('2026-08-05T10:30:00Z'));
    const afternoon = dayWindow(new Date('2026-08-05T14:00:00Z'), new Date('2026-08-05T14:30:00Z'));
    expect(morning.key).toBe(afternoon.key);
    // Same key is only safe because the fetched window is identical too.
    expect(morning.from.toISOString()).toBe(afternoon.from.toISOString());
    expect(morning.to.toISOString()).toBe(afternoon.to.toISOString());
  });

  it('widens a slot-sized window to the whole UTC day', () => {
    const w = dayWindow(new Date('2026-08-05T10:00:00Z'), new Date('2026-08-05T10:30:00Z'));
    expect(w.from.toISOString()).toBe('2026-08-05T00:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-08-06T00:00:00.000Z');
    expect(w.key).toBe('2026-08-05:2026-08-06');
  });

  it('covers every day a multi-day window touches', () => {
    const w = dayWindow(new Date('2026-08-05T16:00:00Z'), new Date('2026-08-19T09:30:00Z'));
    expect(w.from.toISOString()).toBe('2026-08-05T00:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-08-20T00:00:00.000Z');
  });

  it('does not pull in an extra day when the window ends exactly at midnight', () => {
    const w = dayWindow(new Date('2026-08-05T09:00:00Z'), new Date('2026-08-06T00:00:00Z'));
    expect(w.to.toISOString()).toBe('2026-08-06T00:00:00.000Z');
  });

  it('keeps a distinct key for a distinct span, so the fortnight lookup is separate', () => {
    const slot = dayWindow(new Date('2026-08-05T10:00:00Z'), new Date('2026-08-05T10:30:00Z'));
    const horizon = dayWindow(new Date('2026-08-05T10:00:00Z'), new Date('2026-08-19T17:00:00Z'));
    expect(slot.key).not.toBe(horizon.key);
  });

  it('survives a zero-length window without inverting', () => {
    const w = dayWindow(new Date('2026-08-05T10:00:00Z'), new Date('2026-08-05T10:00:00Z'));
    expect(w.to.getTime()).toBeGreaterThan(w.from.getTime());
  });
});
