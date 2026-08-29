// Google Calendar OAuth + connection management (per-tenant, one-way sync).
// The actual booking → event pushing happens in the sync tick + the bookings
// DELETE route; this module just owns connect / callback / status / disconnect.
import { encryptSecret } from '@platform/db';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { withRlsBypass } from '../../lib/db.js';
import { env } from '../../lib/env.js';
import { serviceUnavailable } from '../../lib/errors.js';
import { invalidateBusyCache } from '../../lib/google-busy.js';
import {
  buildAuthUrl,
  exchangeCode,
  getConnection,
  googleCalendarConfigured,
  listEvents,
  signState,
  verifyState,
} from '../../lib/google-calendar.js';

export default async function googleCalendarRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const back = () => `${env.WEB_PUBLIC_URL}/settings/google-calendar`;

  // Is the integration available + is this org connected?
  r.get(
    '/google-calendar/status',
    {
      schema: {
        tags: ['integrations'],
        summary: 'Google Calendar connection status for the current org.',
        response: {
          200: z.object({
            data: z.object({
              configured: z.boolean(),
              connected: z.boolean(),
              email: z.string().nullable(),
              calendarId: z.string().nullable(),
              blockOnBusy: z.boolean(),
              pushBookings: z.boolean(),
              meetingMode: z.enum(['online', 'onsite']),
              autoConfirm: z.boolean(),
            }),
          }),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const conn = await withRlsBypass((tx) =>
        tx.googleCalendarConnection.findUnique({
          where: { organizationId: orgId },
          select: { googleEmail: true, calendarId: true, blockOnBusy: true, pushBookings: true, meetingMode: true, autoConfirm: true },
        }),
      );
      return {
        data: {
          configured: googleCalendarConfigured(),
          connected: !!conn,
          email: conn?.googleEmail ?? null,
          calendarId: conn?.calendarId ?? null,
          blockOnBusy: conn?.blockOnBusy ?? true,
          pushBookings: conn?.pushBookings ?? true,
          meetingMode: (conn?.meetingMode === 'online' ? 'online' : 'onsite') as 'online' | 'onsite',
          autoConfirm: conn?.autoConfirm ?? true,
        },
      };
    },
  );

  // Events on the connected calendar, for the bookings calendar overlay.
  // the platform-created events are dropped: the booking they mirror is already
  // rendered from our own data, and showing both would double every row.
  r.get(
    '/google-calendar/events',
    {
      schema: {
        tags: ['integrations'],
        summary: 'Events on the connected Google Calendar in a time window.',
        querystring: z.object({ from: z.string().datetime(), to: z.string().datetime() }),
        response: {
          200: z.object({
            data: z.object({
              connected: z.boolean(),
              /** False when Google couldn't be reached — the UI says so rather than showing an empty calendar. */
              ok: z.boolean(),
              events: z.array(
                z.object({
                  id: z.string(),
                  summary: z.string(),
                  startIso: z.string(),
                  endIso: z.string(),
                  allDay: z.boolean(),
                  free: z.boolean(),
                  htmlLink: z.string().nullable(),
                }),
              ),
            }),
          }),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const from = new Date(req.query.from);
      const to = new Date(req.query.to);
      // A month view spans ~6 weeks; cap the window so one request can't ask
      // Google for a decade.
      const MAX_WINDOW_MS = 120 * 24 * 60 * 60 * 1000;
      if (to.getTime() - from.getTime() > MAX_WINDOW_MS || to <= from) {
        return { data: { connected: true, ok: false, events: [] } };
      }
      const conn = await getConnection(req.auth!.organizationId);
      if (!conn) return { data: { connected: false, ok: true, events: [] } };
      try {
        const events = await listEvents(conn, from, to);
        return {
          data: {
            connected: true,
            ok: true,
            events: events
              .filter((e) => !e.platformBookingId)
              .map((e) => ({
                id: e.id,
                summary: e.summary,
                startIso: e.startIso,
                endIso: e.endIso,
                allDay: e.allDay,
                free: e.free,
                htmlLink: e.htmlLink,
              })),
          },
        };
      } catch (err) {
        // Never 500 the bookings page because Google is having a bad day.
        req.log.warn({ err }, '[gcal] events fetch failed');
        return { data: { connected: true, ok: false, events: [] } };
      }
    },
  );

  // Busy-blocking toggle.
  r.put(
    '/google-calendar/settings',
    {
      schema: {
        tags: ['integrations'],
        summary: 'Update Google Calendar sync settings for the current org.',
        body: z.object({
          blockOnBusy: z.boolean().optional(),
          pushBookings: z.boolean().optional(),
          meetingMode: z.enum(['online', 'onsite']).optional(),
          autoConfirm: z.boolean().optional(),
        }),
        response: { 200: z.object({ data: z.object({ ok: z.boolean() }) }) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      await withRlsBypass((tx) =>
        tx.googleCalendarConnection.updateMany({
          where: { organizationId: orgId },
          // Only the keys the caller sent — an omitted field is left alone.
          data: {
            ...(req.body.blockOnBusy !== undefined ? { blockOnBusy: req.body.blockOnBusy } : {}),
            ...(req.body.pushBookings !== undefined ? { pushBookings: req.body.pushBookings } : {}),
            ...(req.body.meetingMode !== undefined ? { meetingMode: req.body.meetingMode } : {}),
            ...(req.body.autoConfirm !== undefined ? { autoConfirm: req.body.autoConfirm } : {}),
          },
        }),
      );
      // The bot reads busy times from a 60s cache — clear it so the toggle
      // takes effect on the very next message, not a minute later.
      await invalidateBusyCache(orgId);
      return { data: { ok: true } };
    },
  );

  // Start OAuth — return the Google consent URL; the browser navigates to it.
  r.get(
    '/google-calendar/connect',
    {
      schema: {
        tags: ['integrations'],
        summary: 'Return the Google OAuth consent URL to connect a calendar.',
        response: { 200: z.object({ data: z.object({ url: z.string() }) }) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      if (!googleCalendarConfigured()) {
        throw serviceUnavailable('Google Calendar isn’t configured yet.');
      }
      return { data: { url: buildAuthUrl(signState(req.auth!.organizationId)) } };
    },
  );

  // OAuth callback — PUBLIC (Google redirects here); trust comes from the
  // HMAC-signed state, not a session. Stores the tokens, redirects to the app.
  r.get(
    '/google-calendar/callback',
    {
      schema: {
        tags: ['integrations'],
        querystring: z.object({
          code: z.string().optional(),
          state: z.string().optional(),
          error: z.string().optional(),
        }),
      },
    },
    async (req, reply) => {
      const q = req.query;
      if (q.error || !q.code || !q.state) return reply.redirect(`${back()}?error=1`);
      const orgId = verifyState(q.state);
      if (!orgId) return reply.redirect(`${back()}?error=state`);
      try {
        const { tokens, email } = await exchangeCode(q.code);
        if (!tokens.refreshToken) {
          // Google only returns a refresh token on the first offline consent.
          // prompt=consent forces it; if it's still missing, ask the user to
          // remove the platform's access at myaccount.google.com and reconnect.
          return reply.redirect(`${back()}?error=norefresh`);
        }
        const expiresAt = new Date(Date.now() + tokens.expiresIn * 1000);
        await withRlsBypass((tx) =>
          tx.googleCalendarConnection.upsert({
            where: { organizationId: orgId },
            create: {
              organizationId: orgId,
              googleEmail: email,
              refreshToken: encryptSecret(tokens.refreshToken)!,
              accessToken: encryptSecret(tokens.accessToken),
              tokenExpiresAt: expiresAt,
            },
            update: {
              googleEmail: email,
              refreshToken: encryptSecret(tokens.refreshToken)!,
              accessToken: encryptSecret(tokens.accessToken),
              tokenExpiresAt: expiresAt,
            },
          }),
        );
        await invalidateBusyCache(orgId); // drop the "not connected → free" entry
        return reply.redirect(`${back()}?connected=1`);
      } catch (err) {
        req.log.error({ err }, '[gcal] oauth callback failed');
        return reply.redirect(`${back()}?error=exchange`);
      }
    },
  );

  // Disconnect — drop the connection (events already on the calendar stay).
  r.post(
    '/google-calendar/disconnect',
    {
      schema: {
        tags: ['integrations'],
        summary: 'Disconnect the org’s Google Calendar.',
        response: { 200: z.object({ data: z.object({ ok: z.boolean() }) }) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      await withRlsBypass((tx) =>
        tx.googleCalendarConnection.deleteMany({ where: { organizationId: req.auth!.organizationId } }),
      );
      // Stop blocking slots against a calendar we no longer read.
      await invalidateBusyCache(req.auth!.organizationId);
      return { data: { ok: true } };
    },
  );
}
