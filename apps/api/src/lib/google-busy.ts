// Cached "when is this tenant busy in Google Calendar" lookup.
//
// This sits on the bot's reply path — computeOpenSlots runs on every inbound
// message that could lead to a booking — so it obeys three rules:
//
//  1. FAIL OPEN. A Google outage, a revoked token, a slow response: none of
//     them may stop a customer booking. Every failure returns "no busy time",
//     i.e. exactly the behaviour from before this feature existed.
//  2. CACHED. One Google call per org per minute at most, no matter how many
//     messages arrive. Failures are cached too (briefly) so a revoked token
//     doesn't turn every inbound message into a doomed round-trip.
//  3. BOUNDED. listEvents carries its own abort timeout.
import { dayWindow } from './google-calendar-events.js';
import { getConnection, listEvents, toBusyIntervals, type BusyInterval } from './google-calendar.js';
import { getRedis } from './redis.js';

const TTL_SECONDS = 60;
/** Shorter, so a transient Google blip recovers fast; long enough to shield us. */
const FAILURE_TTL_SECONDS = 120;

/**
 * Busy intervals for an org covering [from, to), or [] when the org has no
 * calendar connected, has busy-blocking switched off, or Google can't be
 * reached.
 *
 * The window is widened to whole UTC days so that it matches the cache key
 * exactly (see dayWindow). Callers ask about anything from one 30-minute slot
 * to a fortnight; without that normalisation, a narrow lookup could be cached
 * under a key a wider lookup then read, and vice versa.
 */
export async function getBusyForOrg(
  orgId: string,
  from: Date,
  to: Date,
): Promise<BusyInterval[]> {
  const win = dayWindow(from, to);
  const key = `gcal:busy:${orgId}:${win.key}`;
  let redis: ReturnType<typeof getRedis> | null = null;
  try {
    redis = getRedis();
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached) as BusyInterval[];
  } catch {
    // Redis down → fall through and ask Google directly. Uncached, but correct.
  }

  let intervals: BusyInterval[] = [];
  let ok = false;
  try {
    const conn = await getConnection(orgId);
    if (conn && conn.blockOnBusy) {
      intervals = toBusyIntervals(await listEvents(conn, win.from, win.to));
    }
    // Not connected / blocking off is a legitimate empty answer, not a failure.
    ok = true;
  } catch (err) {
    console.warn('[gcal-busy] lookup failed, treating as free', orgId, err);
  }

  try {
    await redis?.set(key, JSON.stringify(intervals), 'EX', ok ? TTL_SECONDS : FAILURE_TTL_SECONDS);
  } catch {
    /* cache write is best-effort */
  }
  return intervals;
}

/** Drop the cached answer — used after a connect/disconnect/toggle. */
export async function invalidateBusyCache(orgId: string): Promise<void> {
  try {
    const redis = getRedis();
    // Day-bucketed keys: scan the org's small keyspace rather than guessing.
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `gcal:busy:${orgId}:*`, 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  } catch {
    /* best-effort; entries expire in a minute anyway */
  }
}
