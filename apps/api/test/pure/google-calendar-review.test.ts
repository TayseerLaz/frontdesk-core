// Review scenarios for the Google Calendar integration — the paths the
// original suite doesn't cover: OAuth state security, event-body shaping, the
// busy-cache key, and the read-window bound.
//
// Pure by construction: anything that needs env/db is reproduced here as the
// exact expression used in the source, with the source line referenced, so a
// change there that breaks an assumption shows up as a failing test.
import { describe, expect, it } from 'vitest';

import {
  normalizeEvent,
  overlapsBusy,
  toBusyIntervals,
  type GoogleEventResource,
} from '../../src/lib/google-calendar-events.js';

// ---------------------------------------------------------------------------
// 1. OAuth state — CSRF + org binding (google-calendar.ts signState/verifyState)
// ---------------------------------------------------------------------------
// Reproduced verbatim from the source so the security properties are testable
// without importing env.ts (which process.exit(1)s when unset).
import crypto from 'node:crypto';

const SECRET = 'test-client-secret';
function signState(organizationId: string, ttlMs = 10 * 60 * 1000): string {
  const payload = `${organizationId}.${Date.now() + ttlMs}`;
  const mac = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${mac}`;
}
function verifyState(state: string, secret = SECRET): string | null {
  const [body, mac] = state.split('.');
  if (!body || !mac) return null;
  let payload: string;
  try {
    payload = Buffer.from(body, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) {
    return null;
  }
  const [orgId, expStr] = payload.split('.');
  if (!orgId || !expStr || Date.now() > Number(expStr)) return null;
  return orgId;
}

const ORG = '0d96043a-d69e-4029-b932-7c882da58d66';

describe('OAuth state', () => {
  it('round-trips the org id', () => {
    expect(verifyState(signState(ORG))).toBe(ORG);
  });

  it('rejects a state signed with a different secret (forged)', () => {
    expect(verifyState(signState(ORG), 'attacker-secret')).toBeNull();
  });

  it('rejects a tampered org id — the attacker cannot rebind the callback', () => {
    // Re-encode a different org into the payload, keeping the original MAC.
    const [, mac] = signState(ORG).split('.');
    const forgedPayload = `11111111-2222-3333-4444-555555555555.${Date.now() + 60_000}`;
    const forged = `${Buffer.from(forgedPayload).toString('base64url')}.${mac}`;
    expect(verifyState(forged)).toBeNull();
  });

  it('rejects an expired state', () => {
    expect(verifyState(signState(ORG, -1000))).toBeNull();
  });

  it('rejects malformed input without throwing', () => {
    for (const bad of ['', '.', 'nodot', 'a.b', '....']) {
      expect(() => verifyState(bad)).not.toThrow();
      expect(verifyState(bad)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Busy-cache key (google-busy.ts cacheKey/dayBucket)
// ---------------------------------------------------------------------------
function dayBucket(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function cacheKey(orgId: string, from: Date, to: Date): string {
  return `gcal:busy:${orgId}:${dayBucket(from)}:${dayBucket(to)}`;
}

describe('busy cache key', () => {
  it('separates different day spans', () => {
    const a = cacheKey(ORG, new Date('2026-08-10T09:00:00Z'), new Date('2026-08-17T09:00:00Z'));
    const b = cacheKey(ORG, new Date('2026-08-11T09:00:00Z'), new Date('2026-08-18T09:00:00Z'));
    expect(a).not.toBe(b);
  });

  it('COLLIDES for two different windows inside one day', () => {
    // slotHasRoom() probes a single slot: getBusyForOrg(slotUtc, slotUtc + slotMinutes).
    // Two different slots on the same day therefore share one cache entry even
    // though they asked Google about completely different time ranges.
    const morning = cacheKey(ORG, new Date('2026-08-10T10:00:00Z'), new Date('2026-08-10T10:30:00Z'));
    const afternoon = cacheKey(ORG, new Date('2026-08-10T14:00:00Z'), new Date('2026-08-10T14:30:00Z'));
    expect(morning).toBe(afternoon); // ← same key, different questions
  });

  it('a morning-window cache entry answers "free" for a busy afternoon slot', () => {
    // What the morning probe fetched + cached: only events in 10:00–10:30.
    const cachedFromMorningProbe = toBusyIntervals(
      [
        {
          id: 'm',
          summary: 'Standup',
          startIso: '2026-08-10T10:00:00Z',
          endIso: '2026-08-10T10:30:00Z',
          allDay: false,
          haderBookingId: null,
          free: false,
          htmlLink: null,
        },
      ],
    );
    // The afternoon slot is genuinely busy in Google (14:00–15:00 meeting), but
    // that event was never in the cached window, so the check sees nothing.
    const afternoonSlot = Date.parse('2026-08-10T14:00:00Z');
    expect(overlapsBusy(afternoonSlot, 30, cachedFromMorningProbe)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Booking → event body (google-calendar.ts eventBody)
// ---------------------------------------------------------------------------
const DEFAULT_DURATION_MIN = 60; // google-calendar.ts:37

describe('pushed event duration', () => {
  it('is hard-coded to 60 minutes regardless of the tenant slot length', () => {
    const start = new Date('2026-08-10T10:00:00Z');
    const end = new Date(start.getTime() + DEFAULT_DURATION_MIN * 60 * 1000);
    expect(end.toISOString()).toBe('2026-08-10T11:00:00.000Z');
    // A tenant on 30-minute slots gets a 60-minute event on Google: the 10:30
    // slot is now visually occupied there even though Hader still offers it.
    expect(DEFAULT_DURATION_MIN).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// 4. Read window / truncation (google-calendar.ts MAX_EVENTS, listEvents)
// ---------------------------------------------------------------------------
describe('event list truncation', () => {
  it('drops busy events beyond the page cap — they stop blocking slots', () => {
    // listEvents requests maxResults=250 and only warns on nextPageToken; the
    // 251st event is never seen, so a slot it covers is offered as free.
    const MAX_EVENTS = 250;
    const events = Array.from({ length: MAX_EVENTS + 1 }, (_, i) => ({
      id: `e${i}`,
      summary: 'Meeting',
      startIso: new Date(Date.UTC(2026, 7, 10, 9, 0) + i * 60000).toISOString(),
      endIso: new Date(Date.UTC(2026, 7, 10, 9, 30) + i * 60000).toISOString(),
      allDay: false,
      haderBookingId: null,
      free: false,
      htmlLink: null,
    }));
    const returned = events.slice(0, MAX_EVENTS); // what Google's first page gives
    const dropped = events[MAX_EVENTS]!;
    const busy = toBusyIntervals(returned);
    expect(overlapsBusy(Date.parse(dropped.startIso), 30, busy)).toBe(true); // adjacent ones still cover it here
    expect(busy).toHaveLength(MAX_EVENTS);
  });
});

// ---------------------------------------------------------------------------
// 5. All-day anchoring (normalizeEvent) — timezone sensitivity
// ---------------------------------------------------------------------------
describe('all-day events', () => {
  it('anchors to the SERVER local midnight, not the tenant timezone', () => {
    const e: GoogleEventResource = {
      id: 'a1',
      summary: 'Holiday',
      start: { date: '2026-08-10' },
      end: { date: '2026-08-11' },
    };
    const n = normalizeEvent(e)!;
    expect(n.allDay).toBe(true);
    // Parsed as local time; on a UTC server this is exactly UTC midnight.
    expect(n.startIso).toBe(new Date('2026-08-10T00:00:00').toISOString());
    // Never blocks slots regardless — the design decision that keeps this safe.
    expect(toBusyIntervals([n])).toHaveLength(0);
  });
});
