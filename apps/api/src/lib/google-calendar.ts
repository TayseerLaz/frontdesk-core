// Google Calendar — per-tenant, two-way: bookings are pushed to the tenant's
// calendar, and that calendar is read back so its events show up in Hader's
// booking calendar and can block booking slots.
//
// Design notes:
//  • OAuth tokens are AES-GCM-encrypted at rest (encryptSecret). The refresh
//    token is long-lived; the access token is refreshed on demand + cached.
//  • Raw fetch against Google's REST endpoints — no googleapis dependency.
//  • The integration is DORMANT until GOOGLE_CLIENT_ID/SECRET are set (like the
//    other integrations), so this ships safely without credentials.
//  • READING NEEDS NO SCOPE CHANGE. `calendar.events` is read+write on events
//    (it is an accepted scope for events.list), so tenants who connected under
//    the one-way version keep working without a re-consent. Deliberately NOT
//    using freebusy.query — it needs a wider scope and returns no titles, and
//    we want titles for the calendar overlay.
import crypto from 'node:crypto';

import { decryptSecret, encryptSecret } from '@platform/db';

import { withRlsBypass } from './db.js';
import { env } from './env.js';
import { normalizeEvent, type GoogleEventResource, type RemoteEvent } from './google-calendar-events.js';

// Re-exported so callers have one import site for the integration.
export {
  overlapsBusy,
  toBusyIntervals,
  type BusyInterval,
  type RemoteEvent,
} from './google-calendar-events.js';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v2/userinfo';
// Write access to events + the account email (for display). Not calendar-wide.
const SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'openid', 'email'];
const DEFAULT_DURATION_MIN = 60;
/** Reads sit on the bot's reply path; bound them hard and fail open. */
const READ_TIMEOUT_MS = 4000;
/** One page is plenty for a 6-week window; truncation is logged, not silent. */
const MAX_EVENTS = 250;

export function googleCalendarConfigured(): boolean {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

export function redirectUri(): string {
  return `${env.API_PUBLIC_URL}/api/v1/google-calendar/callback`;
}

// ---------- OAuth "state" (CSRF + org binding) -----------------------------
// The connect endpoint (JWT-authed) mints a short-lived, HMAC-signed state that
// carries the orgId; the public callback verifies it. The MAC key is a
// domain-separated HKDF derivative rather than the raw Google client secret, so
// no single secret serves two cryptographic purposes. SECRET_ENCRYPTION_KEY — a
// genuinely distinct secret — is folded in as salt when present.
let cachedStateKey: Buffer | null = null;
function stateKey(): Buffer {
  if (!cachedStateKey) {
    const ikm = env.GOOGLE_CLIENT_SECRET ?? 'unconfigured';
    const salt = env.SECRET_ENCRYPTION_KEY ?? '';
    cachedStateKey = Buffer.from(
      crypto.hkdfSync('sha256', ikm, salt, 'aligned:google-oauth-state:v1', 32),
    );
  }
  return cachedStateKey;
}
export function signState(organizationId: string): string {
  const payload = `${organizationId}.${Date.now() + 10 * 60 * 1000}`;
  const mac = crypto.createHmac('sha256', stateKey()).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${mac}`;
}
export function verifyState(state: string): string | null {
  const [body, mac] = state.split('.');
  if (!body || !mac) return null;
  let payload: string;
  try {
    payload = Buffer.from(body, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const expected = crypto.createHmac('sha256', stateKey()).update(payload).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) {
    return null;
  }
  const [orgId, expStr] = payload.split('.');
  if (!orgId || !expStr || Date.now() > Number(expStr)) return null;
  return orgId;
}

export function buildAuthUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID ?? '',
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline', // returns a refresh token
    prompt: 'consent', // force refresh-token issuance on re-connect
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_ENDPOINT}?${p.toString()}`;
}

interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
}

export async function exchangeCode(code: string): Promise<{ tokens: TokenSet; email: string | null }> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID ?? '',
      client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`google token exchange failed: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  let email: string | null = null;
  try {
    const u = await fetch(USERINFO_ENDPOINT, { headers: { Authorization: `Bearer ${j.access_token}` } });
    if (u.ok) email = ((await u.json()) as { email?: string }).email ?? null;
  } catch {
    /* email is best-effort */
  }
  return {
    tokens: { accessToken: j.access_token, refreshToken: j.refresh_token ?? null, expiresIn: j.expires_in },
    email,
  };
}

async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.GOOGLE_CLIENT_ID ?? '',
      client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
      grant_type: 'refresh_token',
    }),
    // Reads happen on the bot's reply path — never hang on Google.
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`google token refresh failed: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  return { accessToken: j.access_token, expiresIn: j.expires_in };
}

export interface GcalConnection {
  organizationId: string;
  calendarId: string;
  accessToken: string | null;
  refreshToken: string;
  tokenExpiresAt: Date | null;
  blockOnBusy?: boolean;
}

/** The org's connection row, or null when it hasn't connected a calendar. */
export async function getConnection(organizationId: string): Promise<
  | (GcalConnection & {
      googleEmail: string | null;
      blockOnBusy: boolean;
      pushBookings: boolean;
      meetingMode: string;
      autoConfirm: boolean;
    })
  | null
> {
  if (!googleCalendarConfigured()) return null;
  const row = await withRlsBypass((tx) =>
    tx.googleCalendarConnection.findUnique({
      where: { organizationId },
      select: {
        organizationId: true,
        calendarId: true,
        accessToken: true,
        refreshToken: true,
        tokenExpiresAt: true,
        googleEmail: true,
        blockOnBusy: true,
        pushBookings: true,
        meetingMode: true,
        autoConfirm: true,
      },
    }),
  );
  return row ?? null;
}

// A valid access token, refreshing + persisting the new one when expired.
async function getValidAccessToken(conn: GcalConnection): Promise<string> {
  const now = Date.now();
  const cached = conn.accessToken ? decryptSecret(conn.accessToken) : null;
  if (cached && conn.tokenExpiresAt && conn.tokenExpiresAt.getTime() - now > 60_000) return cached;
  const refreshed = await refreshAccessToken(decryptSecret(conn.refreshToken));
  await withRlsBypass((tx) =>
    tx.googleCalendarConnection.update({
      where: { organizationId: conn.organizationId },
      data: {
        accessToken: encryptSecret(refreshed.accessToken),
        tokenExpiresAt: new Date(now + refreshed.expiresIn * 1000),
      },
    }),
  );
  return refreshed.accessToken;
}

// ---------- booking → event -------------------------------------------------

export interface SyncableBooking {
  id: string;
  customerName: string | null;
  customerPhone: string;
  fields: unknown;
  notes: string | null;
  appointmentAt: Date | null;
  googleEventId: string | null;
}

function bookingSubject(fields: unknown): string | null {
  const list = Array.isArray(fields) ? (fields as { key?: string; label?: string; value?: unknown }[]) : [];
  const SUBJECT = /(service|appointment|reason|type|session|class|event|tour|table|party|package|treatment)/i;
  const SKIP = /(name|phone|email|date|time|when|number|note)/i;
  for (const f of list) {
    const tag = `${f?.key ?? ''} ${f?.label ?? ''}`;
    if (SUBJECT.test(tag) && f?.value) return String(f.value).slice(0, 80);
  }
  for (const f of list) {
    const tag = `${f?.key ?? ''} ${f?.label ?? ''}`;
    if (!SKIP.test(tag) && f?.value) return String(f.value).slice(0, 80);
  }
  return null;
}

function eventBody(
  b: SyncableBooking,
  durationMinutes: number,
  opts: PushOptions = {},
): Record<string, unknown> {
  const subject = bookingSubject(b.fields);
  const who = b.customerName || b.customerPhone;
  const summary = subject ? `${subject} — ${who}` : `Booking — ${who}`;
  const start = b.appointmentAt!;
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
  const list = Array.isArray(b.fields) ? (b.fields as { label?: string; value?: unknown }[]) : [];
  const detailLines = list
    .filter((f) => f?.value != null && f.value !== '')
    .map((f) => `${f.label ?? ''}: ${String(f.value)}`.trim());
  const description = [
    `Customer: ${who}`,
    `Phone: ${b.customerPhone}`,
    ...detailLines,
    b.notes ? `Notes: ${b.notes}` : '',
    '',
    'Booked via Hader',
  ]
    .filter(Boolean)
    .join('\n');
  const body: Record<string, unknown> = {
    summary,
    description,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    // Stable tag so we can recognise Hader-created events.
    extendedProperties: { private: { haderBookingId: b.id } },
  };
  if (opts.location) body.location = opts.location;
  // Inviting the customer makes Google email them the appointment, which is
  // the second delivery route alongside the WhatsApp message.
  if (opts.attendeeEmail) body.attendees = [{ email: opts.attendeeEmail }];
  if (opts.withMeet) {
    // requestId must be stable per event or Google mints a second conference
    // on every update. The booking id is exactly that.
    body.conferenceData = {
      createRequest: {
        requestId: `hader-${b.id}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    };
  }
  return body;
}

export interface PushOptions {
  /** Attach a Google Meet link (online businesses only). */
  withMeet?: boolean;
  /** Invite the customer so Google emails them the appointment. */
  attendeeEmail?: string | null;
  /** Physical address, for onsite businesses. */
  location?: string | null;
}

export interface PushResult {
  eventId: string;
  /** The Meet URL, when one was requested and Google granted it. */
  meetLink: string | null;
}

interface GoogleEventJson {
  id: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
}

/** Pull the Meet URL out of a created/updated event, whichever shape it uses. */
function readMeetLink(j: GoogleEventJson): string | null {
  if (j.hangoutLink) return j.hangoutLink;
  const video = (j.conferenceData?.entryPoints ?? []).find((e) => e.entryPointType === 'video');
  return video?.uri ?? null;
}

function eventsBase(calendarId: string): string {
  return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
}

// Create or update the calendar event for a booking. Returns the event id.
export async function pushBooking(
  conn: GcalConnection,
  b: SyncableBooking,
  /**
   * How long the appointment blocks out. Defaults to an hour because a Booking
   * row carries no duration; the caller passes the tenant's configured slot
   * length so a salon on 30-minute slots doesn't lose an hour per booking.
   */
  durationMinutes: number = DEFAULT_DURATION_MIN,
  opts: PushOptions = {},
): Promise<PushResult> {
  const token = await getValidAccessToken(conn);
  const body = eventBody(b, durationMinutes, opts);
  const base = eventsBase(conn.calendarId);
  // conferenceDataVersion=1 is REQUIRED for Google to act on a Meet
  // createRequest; without it the field is silently ignored and you get an
  // event with no link and no error. sendUpdates=all makes Google email the
  // invitation to the attendee.
  const q = new URLSearchParams();
  if (opts.withMeet) q.set('conferenceDataVersion', '1');
  if (opts.attendeeEmail) q.set('sendUpdates', 'all');
  const qs = q.toString() ? `?${q.toString()}` : '';

  if (b.googleEventId) {
    const res = await fetch(`${base}/${encodeURIComponent(b.googleEventId)}${qs}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const j = (await res.json()) as GoogleEventJson;
      return { eventId: j.id, meetLink: readMeetLink(j) };
    }
    // Event was deleted on Google's side — fall through and re-create it.
    if (res.status !== 404 && res.status !== 410) {
      throw new Error(`gcal event patch failed: ${res.status} ${await res.text()}`);
    }
  }
  const res = await fetch(`${base}${qs}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`gcal event create failed: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as GoogleEventJson;
  return { eventId: j.id, meetLink: readMeetLink(j) };
}

// ---------- reading the calendar (overlay + busy-blocking) ------------------
// The decisions (what's busy, what collides) live in google-calendar-events.ts
// so they're unit-testable without env/db; this file owns the I/O.

/**
 * Events on the connected calendar between two instants. Recurring events are
 * expanded (`singleEvents`) so every occurrence is its own row. Throws on a
 * Google error — callers decide whether to fail open.
 */
export async function listEvents(
  conn: GcalConnection,
  timeMin: Date,
  timeMax: Date,
): Promise<RemoteEvent[]> {
  const token = await getValidAccessToken(conn);
  const p = new URLSearchParams({
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    showDeleted: 'false',
    maxResults: String(MAX_EVENTS),
  });
  const res = await fetch(`${eventsBase(conn.calendarId)}?${p.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`gcal events list failed: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { items?: GoogleEventResource[]; nextPageToken?: string };
  if (j.nextPageToken) {
    console.warn('[gcal] event list truncated at', MAX_EVENTS, 'for org', conn.organizationId);
  }
  return (j.items ?? []).map(normalizeEvent).filter((e): e is RemoteEvent => e !== null);
}

// Delete a booking's calendar event. Tolerates an already-deleted event.
export async function deleteRemoteEvent(conn: GcalConnection, eventId: string): Promise<void> {
  const token = await getValidAccessToken(conn);
  const res = await fetch(`${eventsBase(conn.calendarId)}/${encodeURIComponent(eventId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    console.warn('[gcal] delete event non-OK', res.status);
  }
}
